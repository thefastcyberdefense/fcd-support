import { createHash } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import { gapSummaries } from '../learning/learning-types.js';
import { parseManifestOutput } from '../model/manifest-output.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import type {
  ExistingReplyDecision,
  ModelReplyClaim,
  ModelReplyDecisionResult,
  ModelReplyStore,
  PersistModelDecisionInput,
  PersistReplyDecisionInput,
  PersistReplyDecisionResult,
  ReplyDecisionClaim,
  ReplyDecisionInput,
  ReplyDecisionStore,
  ReplyPolicyBlockReason,
} from '../replies/reply-types.js';
import { MODEL_ESCALATION_REASON_CODES } from './postgres-support-escalation.js';
import { safeResponse, safeResponseReasons } from '../safety/safe-responses.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));
const internalId = z
  .string()
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const requestKey = z.string().trim().min(1).max(128);
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const claimSchema = z.strictObject({
  evaluatedAt: validDate,
  language: z.enum(['en', 'bn']),
  requestKey,
  webhookEventId: internalId,
});
const persistSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    answerText: z.string().trim().min(1).max(4000),
    escalationReasonCode: z.enum(['sensitive_data_blocked', 'unsafe_redaction']),
    evaluatedAt: validDate,
    kind: z.literal('safe_failure'),
    language: z.enum(['en', 'bn']),
    requestKey,
    webhookEventId: internalId,
  }),
  z.strictObject({
    answerText: z.string().trim().min(1).max(4000),
    evaluatedAt: validDate,
    itemReference: reference,
    kind: z.literal('faq'),
    language: z.enum(['en', 'bn']),
    requestKey,
    versionReference: reference,
    webhookEventId: internalId,
  }),
  z.strictObject({
    evaluatedAt: validDate,
    gapKind: z.enum(['faq_ambiguous', 'faq_miss']),
    kind: z.literal('model_required'),
    language: z.enum(['en', 'bn']),
    requestKey,
    webhookEventId: internalId,
  }),
]);
const modelPersistSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    answerText: z.string().trim().min(1).max(4000),
    evaluatedAt: validDate,
    kind: z.literal('model'),
    knowledgeReferences: z.array(reference).min(1).max(100),
    language: z.enum(['en', 'bn']),
    requestKey,
    webhookEventId: internalId,
  }),
  z.strictObject({
    answerText: z.string().trim().min(1).max(4000),
    escalationReasonCode: z.enum(MODEL_ESCALATION_REASON_CODES),
    evaluatedAt: validDate,
    kind: z.literal('safe_failure'),
    language: z.enum(['en', 'bn']),
    requestKey,
    responseReason: z.enum(safeResponseReasons),
    webhookEventId: internalId,
  }),
]);
const publishedKnowledgeInputSchema = z.strictObject({
  evaluatedAt: validDate,
  language: z.enum(['en', 'bn']),
  maximumItems: z.number().int().min(1).max(100),
});

interface GuardRow {
  readonly ai_paused_until: Date | null;
  readonly content_purged_through_at: Date | null;
  readonly expires_at: Date | null;
  readonly privacy_request_open: boolean;
}

interface ReplySourceEvent {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly contactId: string;
  readonly conversationId: string;
  readonly externalContactId: string;
  readonly identityId: string;
  readonly messageText: string | null;
  readonly occurredAt: Date;
}

interface ReplySourceEventRow {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channel_account_id: string;
  readonly contact_id: string;
  readonly conversation_id: string;
  readonly external_contact_id: string;
  readonly identity_id: string;
  readonly message_text: string | null;
  readonly occurred_at: Date;
}

interface RetentionDeadlineRow {
  readonly expires_at: Date | null;
  readonly lifecycle_class: 'active_client' | 'casual_chat' | 'unconverted_lead';
  readonly next_active_review_at: Date | null;
  readonly relationship_status: 'closed' | 'open' | null;
}

interface ExistingDraftRow {
  readonly answer_text: string | null;
  readonly created_at: Date;
  readonly decision_type: 'faq' | 'model' | 'safe_failure';
  readonly draft_ref: string;
  readonly escalation_count: number;
  readonly escalation_reason: string | null;
  readonly item_reference: string | null;
  readonly language: 'bn' | 'en';
  readonly request_key: string;
  readonly state: 'erased' | 'ready';
  readonly version_reference: string | null;
}

interface ExistingGapRow {
  readonly created_at: Date;
  readonly erased_at: Date | null;
  readonly gap_kind: string;
  readonly language: 'bn' | 'en';
  readonly observation_ref: string;
  readonly request_key: string;
  readonly sanitized_summary: string | null;
}

interface ExistingState {
  readonly draft: ExistingDraftRow | undefined;
  readonly gap: ExistingGapRow | undefined;
}

interface EffectiveFaqRow {
  readonly answer_bn: string;
  readonly answer_en: string;
  readonly id: string;
}

interface PublishedKnowledgeRow {
  readonly answer_bn: string;
  readonly answer_en: string;
  readonly approved_url: string | null;
  readonly id: string;
  readonly version_ref: string;
}

export class ReplyDecisionConflictError extends Error {
  public override readonly name = 'ReplyDecisionConflictError';
}

function parseClaim(input: unknown): ReplyDecisionInput {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Reply decision input is invalid');
  return parsed.data;
}

function parsePersist(input: unknown): PersistReplyDecisionInput {
  const parsed = persistSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Reply persistence input is invalid');
  const command = parsed.data as PersistReplyDecisionInput;
  if (
    command.kind === 'safe_failure' &&
    command.answerText !== safeResponse(command.language, 'sensitive_data_blocked')
  ) {
    throw new TypeError('Safe reply text is not the reviewed deterministic response');
  }
  return command;
}

function parseModelPersist(input: unknown): PersistModelDecisionInput {
  const parsed = modelPersistSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Model reply persistence input is invalid');
  const command = parsed.data as PersistModelDecisionInput;
  if (command.kind === 'model') {
    if (new Set(command.knowledgeReferences).size !== command.knowledgeReferences.length) {
      throw new TypeError('Model reply knowledge references are invalid');
    }
  } else if (command.answerText !== safeResponse(command.language, command.responseReason)) {
    throw new TypeError('Model safe reply text is not the reviewed deterministic response');
  }
  return command;
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function derivedReference(prefix: string, webhookEventId: string): string {
  return `${prefix}_${createHash('sha256')
    .update(JSON.stringify(['fcd-support', 'reply-decision', webhookEventId]))
    .digest('hex')
    .slice(0, 48)}`;
}

async function lockReplySourceEvent(
  client: pg.PoolClient,
  webhookEventId: string,
): Promise<ReplySourceEvent | undefined> {
  const selected = await client.query<ReplySourceEventRow>(
    `select source_event.occurred_at,
            source_event.message_text,
            conversation.id as conversation_id,
            identity.id as identity_id,
            identity.contact_id,
            identity.channel,
            identity.channel_account_id,
            identity.external_contact_id
     from webhook_events as source_event
     join webhook_event_applications as application
       on application.webhook_event_id = source_event.id
     join conversations as conversation
       on conversation.id = application.conversation_id
     join channel_identities as identity
       on identity.id = conversation.channel_identity_id
     join contacts as contact
       on contact.id = identity.contact_id
     where source_event.id = $1
       and source_event.event_kind = 'customer_message'
       and source_event.admission_outcome = 'pending'
       and source_event.occurred_at is not null
       and application.outcome = 'customer_message_applied'
     for update of source_event, application, conversation, identity, contact`,
    [webhookEventId],
  );
  const row = selected.rows[0];
  if (row === undefined) return undefined;
  return {
    channel: row.channel,
    channelAccountId: row.channel_account_id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    externalContactId: row.external_contact_id,
    identityId: row.identity_id,
    messageText: row.message_text,
    occurredAt: row.occurred_at,
  };
}

function artifactRetentionDeadline(
  state: RetentionDeadlineRow | undefined,
  evaluatedAt: Date,
): Date | undefined {
  if (state?.expires_at !== null && state?.expires_at !== undefined) return state.expires_at;
  if (
    state?.lifecycle_class !== 'active_client' ||
    state.relationship_status !== 'open' ||
    state.next_active_review_at === null
  ) {
    return undefined;
  }
  return new Date(Math.max(state.next_active_review_at.getTime(), evaluatedAt.getTime()));
}

async function loadExistingState(
  client: pg.PoolClient,
  webhookEventId: string,
): Promise<ExistingState> {
  const drafts = await client.query<ExistingDraftRow>(
    `select draft.draft_ref, draft.decision_type, draft.language,
            draft.answer_text, draft.state, draft.request_key, draft.created_at,
            version.version_ref as version_reference,
            item.item_key as item_reference,
            count(escalation.id)::int as escalation_count,
            min(escalation.reason_code) as escalation_reason
     from support_reply_drafts as draft
     left join knowledge_versions as version on version.id = draft.knowledge_version_id
     left join knowledge_items as item on item.id = version.item_id
     left join support_escalation_outcomes as escalation on escalation.reply_draft_id = draft.id
     where draft.source_webhook_event_id = $1
     group by draft.id, version.version_ref, item.item_key`,
    [webhookEventId],
  );
  const gaps = await client.query<ExistingGapRow>(
    `select observation_ref, language, gap_kind, sanitized_summary,
            request_key, created_at, erased_at
     from knowledge_gap_observations
     where source_webhook_event_id = $1`,
    [webhookEventId],
  );
  if (
    drafts.rows.length > 1 ||
    gaps.rows.length > 1 ||
    (drafts.rows[0]?.decision_type === 'faq' && gaps.rows[0] !== undefined)
  ) {
    throw new ReplyDecisionConflictError('Reply event has conflicting persisted outcomes');
  }
  return { draft: drafts.rows[0], gap: gaps.rows[0] };
}

function existingClaim(
  command: ReplyDecisionInput,
  existing: ExistingState,
):
  | ExistingReplyDecision
  | { readonly reasonCode: 'content_purged'; readonly status: 'policy_blocked' }
  | undefined {
  const draft = existing.draft;
  if (draft !== undefined) {
    if (draft.state === 'erased') return { status: 'policy_blocked', reasonCode: 'content_purged' };
    if (draft.request_key !== command.requestKey || draft.language !== command.language) {
      throw new ReplyDecisionConflictError('Reply decision replay conflicts');
    }
    return {
      status: 'duplicate',
      decisionType: draft.decision_type,
      draftRef: draft.draft_ref,
      nextAction: 'none',
    };
  }
  const gap = existing.gap;
  if (gap !== undefined) {
    if (gap.erased_at !== null) return { status: 'policy_blocked', reasonCode: 'content_purged' };
    if (gap.request_key !== command.requestKey || gap.language !== command.language) {
      throw new ReplyDecisionConflictError('Reply decision replay conflicts');
    }
    return {
      status: 'duplicate',
      decisionType: 'model_required',
      nextAction: 'model_required',
      observationRef: gap.observation_ref,
    };
  }
  return undefined;
}

function existingPersisted(
  command: PersistReplyDecisionInput,
  existing: ExistingState,
): PersistReplyDecisionResult | undefined {
  const claimed = existingClaim(command, existing);
  if (claimed === undefined || claimed.status === 'policy_blocked') return claimed;
  if (command.kind === 'model_required') {
    const gap = existing.gap;
    if (gap === undefined) {
      throw new ReplyDecisionConflictError('Reply decision replay conflicts');
    }
    if (
      gap.gap_kind !== command.gapKind ||
      gap.sanitized_summary !== gapSummaries[command.gapKind] ||
      !sameDate(gap.created_at, command.evaluatedAt)
    ) {
      throw new ReplyDecisionConflictError('Reply decision replay conflicts');
    }
    return claimed;
  }
  const draft = existing.draft;
  if (draft === undefined) {
    throw new ReplyDecisionConflictError('Reply decision replay conflicts');
  }
  if (
    draft.decision_type !== command.kind ||
    draft.answer_text !== command.answerText ||
    !sameDate(draft.created_at, command.evaluatedAt)
  ) {
    throw new ReplyDecisionConflictError('Reply decision replay conflicts');
  }
  if (command.kind === 'faq') {
    if (
      draft.version_reference !== command.versionReference ||
      draft.item_reference !== command.itemReference ||
      draft.escalation_count !== 0
    ) {
      throw new ReplyDecisionConflictError('Reply decision replay conflicts');
    }
  } else if (
    draft.escalation_count !== 1 ||
    draft.escalation_reason !== command.escalationReasonCode
  ) {
    throw new ReplyDecisionConflictError('Reply decision replay conflicts');
  }
  return claimed;
}

export class PostgresReplyDraftStore implements ReplyDecisionStore, ModelReplyStore {
  private readonly keyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: TransactionSource,
    keyring: PrivacyHmacKeyring,
  ) {
    this.keyring = requirePrivacyHmacKeyring(keyring);
  }

  public async claimDecision(input: unknown): Promise<ReplyDecisionClaim> {
    const command = parseClaim(input);
    return withBoundedTransaction(this.pool, async (client) => {
      const source = await lockReplySourceEvent(client, command.webhookEventId);
      if (source === undefined || command.evaluatedAt < source.occurredAt) {
        return { status: 'not_processable' };
      }
      const existing = existingClaim(
        command,
        await loadExistingState(client, command.webhookEventId),
      );
      if (existing !== undefined) return existing;
      const blocked = await this.guardReason(client, source, command.evaluatedAt);
      if (blocked !== undefined) return { status: 'policy_blocked', reasonCode: blocked };
      if (source.messageText === null) {
        return { status: 'policy_blocked', reasonCode: 'content_purged' };
      }
      return {
        status: 'claimed',
        source: {
          conversationId: source.conversationId,
          messageText: source.messageText,
          occurredAt: source.occurredAt,
          webhookEventId: command.webhookEventId,
        },
      };
    });
  }

  public async claimModelDecision(input: unknown): Promise<ModelReplyClaim> {
    const command = parseClaim(input);
    return withBoundedTransaction(this.pool, async (client) => {
      const source = await lockReplySourceEvent(client, command.webhookEventId);
      if (source === undefined || command.evaluatedAt < source.occurredAt) {
        return { status: 'not_processable' };
      }
      const existing = await loadExistingState(client, command.webhookEventId);
      const draft = existing.draft;
      if (draft !== undefined) {
        if (draft.state === 'erased') {
          return { status: 'policy_blocked', reasonCode: 'content_purged' };
        }
        if (draft.request_key !== command.requestKey || draft.language !== command.language) {
          throw new ReplyDecisionConflictError('Model reply replay conflicts');
        }
        return {
          status: 'duplicate',
          decisionType: draft.decision_type,
          draftRef: draft.draft_ref,
          nextAction: 'none',
        };
      }
      const gap = existing.gap;
      if (gap === undefined) return { status: 'not_processable' };
      if (
        gap.erased_at !== null ||
        gap.request_key !== command.requestKey ||
        gap.language !== command.language ||
        (gap.gap_kind !== 'faq_miss' && gap.gap_kind !== 'faq_ambiguous') ||
        command.evaluatedAt < gap.created_at
      ) {
        throw new ReplyDecisionConflictError('Model reply gap conflicts');
      }
      const blocked = await this.guardReason(client, source, command.evaluatedAt);
      if (blocked !== undefined) return { status: 'policy_blocked', reasonCode: blocked };
      if (source.messageText === null) {
        return { status: 'policy_blocked', reasonCode: 'content_purged' };
      }
      return {
        status: 'claimed',
        source: {
          conversationId: source.conversationId,
          messageText: source.messageText,
          occurredAt: source.occurredAt,
          webhookEventId: command.webhookEventId,
        },
      };
    });
  }

  public async loadPublishedKnowledge(input: unknown) {
    const parsed = publishedKnowledgeInputSchema.safeParse(input);
    if (!parsed.success) throw new TypeError('Published model knowledge input is invalid');
    const command = parsed.data;
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<PublishedKnowledgeRow>(
        `select version.id, version.version_ref, version.answer_en, version.answer_bn,
                source.approved_url
         from knowledge_items as item
         join lateral (
           select event.action, event.version_id
           from knowledge_publication_events as event
           where event.item_id = item.id and event.effective_at <= $1
           order by event.effective_at desc, event.id desc limit 1
         ) as publication on publication.action in ('publish', 'rollback')
         join knowledge_versions as version on version.id = publication.version_id
         join knowledge_sources as source on source.id = version.source_id and source.active
         where item.kind in ('faq', 'business_fact')
           and version.state = 'approved'
           and version.decided_at is not null and version.decided_at <= $1
           and version.answer_en is not null and version.answer_bn is not null
         order by item.item_key, version.version_number, version.id
         limit $2`,
        [command.evaluatedAt, command.maximumItems],
      );
      return selected.rows.map((row) => ({
        approvedUrls: row.approved_url === null ? [] : [row.approved_url],
        fact: command.language === 'en' ? row.answer_en : row.answer_bn,
        reference: row.version_ref,
      }));
    });
  }

  public async persistModelDecision(input: unknown): Promise<ModelReplyDecisionResult> {
    const command = parseModelPersist(input);
    return withBoundedTransaction(this.pool, async (client) => {
      const source = await lockReplySourceEvent(client, command.webhookEventId);
      if (source === undefined || command.evaluatedAt < source.occurredAt) {
        throw new ReplyDecisionConflictError('Model reply source event is not processable');
      }
      const existing = await loadExistingState(client, command.webhookEventId);
      const prior = existing.draft;
      if (prior !== undefined) {
        if (prior.state === 'erased') {
          return { status: 'policy_blocked', reasonCode: 'content_purged' };
        }
        if (
          prior.request_key !== command.requestKey ||
          prior.language !== command.language ||
          prior.decision_type !== command.kind ||
          prior.answer_text !== command.answerText ||
          !sameDate(prior.created_at, command.evaluatedAt)
        ) {
          throw new ReplyDecisionConflictError('Model reply replay conflicts');
        }
        if (
          command.kind === 'safe_failure' &&
          (prior.escalation_count !== 1 || prior.escalation_reason !== command.escalationReasonCode)
        ) {
          throw new ReplyDecisionConflictError('Model safe reply replay conflicts');
        }
        if (command.kind === 'model') {
          const links = await client.query<{ readonly version_ref: string }>(
            `select version.version_ref
             from support_reply_draft_knowledge as link
             join knowledge_versions as version on version.id = link.knowledge_version_id
             join support_reply_drafts as draft on draft.id = link.draft_id
             where draft.source_webhook_event_id = $1
               and link.reference_kind = 'model_fact'
             order by version.version_ref`,
            [command.webhookEventId],
          );
          if (
            JSON.stringify(links.rows.map(({ version_ref }) => version_ref)) !==
            JSON.stringify([...command.knowledgeReferences].sort())
          ) {
            throw new ReplyDecisionConflictError('Model knowledge replay conflicts');
          }
        }
        return {
          status: 'duplicate',
          decisionType: prior.decision_type,
          draftRef: prior.draft_ref,
          nextAction: 'none',
        };
      }
      const gap = existing.gap;
      if (
        gap?.erased_at !== null ||
        gap.request_key !== command.requestKey ||
        gap.language !== command.language ||
        (gap.gap_kind !== 'faq_miss' && gap.gap_kind !== 'faq_ambiguous') ||
        command.evaluatedAt < gap.created_at
      ) {
        throw new ReplyDecisionConflictError('Model reply requires the authoritative FAQ gap');
      }
      const blocked = await this.guardReason(client, source, command.evaluatedAt);
      if (blocked !== undefined) return { status: 'policy_blocked', reasonCode: blocked };
      if (source.messageText === null) {
        return { status: 'policy_blocked', reasonCode: 'content_purged' };
      }
      if (command.kind === 'model') {
        const lease = await client.query<{ readonly id: string }>(
          `select id
           from model_call_leases
           where source_webhook_event_id = $1
             and conversation_id = $2
             and state = 'active'
             and created_at <= $3
             and lease_expires_at > $3
           for update`,
          [command.webhookEventId, source.conversationId, command.evaluatedAt],
        );
        if (lease.rows.length !== 1) return { status: 'not_processable' };
      }

      const retention = await client.query<RetentionDeadlineRow>(
        `select lifecycle_class, expires_at, relationship_status, next_active_review_at
         from conversation_retention_states where conversation_id = $1`,
        [source.conversationId],
      );
      const retentionDeadline = artifactRetentionDeadline(retention.rows[0], command.evaluatedAt);
      if (retentionDeadline === undefined) {
        throw new ReplyDecisionConflictError('Model reply retention deadline is unavailable');
      }

      let knowledgeRows: readonly PublishedKnowledgeRow[] = [];
      if (command.kind === 'model') {
        const selected = await client.query<PublishedKnowledgeRow>(
          `select version.id, version.version_ref, version.answer_en, version.answer_bn,
                  source.approved_url
           from knowledge_items as item
           join lateral (
             select event.action, event.version_id
             from knowledge_publication_events as event
             where event.item_id = item.id and event.effective_at <= $2
             order by event.effective_at desc, event.id desc limit 1
           ) as publication on publication.action in ('publish', 'rollback')
           join knowledge_versions as version on version.id = publication.version_id
           join knowledge_sources as source on source.id = version.source_id and source.active
           where version.version_ref = any($1::text[])
             and version.state = 'approved'
             and version.decided_at is not null and version.decided_at <= $2
             and item.kind in ('faq', 'business_fact')
           order by version.version_ref`,
          [[...command.knowledgeReferences], command.evaluatedAt],
        );
        if (
          JSON.stringify(selected.rows.map(({ version_ref }) => version_ref)) !==
          JSON.stringify([...command.knowledgeReferences].sort())
        ) {
          return { status: 'knowledge_changed' };
        }
        knowledgeRows = selected.rows;
        const validated = parseManifestOutput(
          JSON.stringify({
            answer: command.answerText,
            decision: 'answer',
            knowledgeReferences: command.knowledgeReferences,
            language: command.language,
            needsHumanReview: false,
            reasonCode: 'published_knowledge_answer',
          }),
          {
            knowledge: knowledgeRows.map((row) => ({
              approvedUrls: row.approved_url === null ? [] : [row.approved_url],
              fact: command.language === 'en' ? row.answer_en : row.answer_bn,
              reference: row.version_ref,
            })),
            maximumResponseBytes: 1_048_576,
            requiredLanguage: command.language,
          },
        );
        if (validated.status === 'rejected') {
          return { status: 'knowledge_changed' };
        }
      }

      const draftRef = derivedReference('DRAFT', command.webhookEventId);
      const inserted = await client.query<{ readonly id: string }>(
        `insert into support_reply_drafts
          (draft_ref, source_webhook_event_id, conversation_id, decision_type,
           language, answer_text, knowledge_version_id, state,
           retention_deadline, request_key, created_at)
         values ($1,$2,$3,$4,$5,$6,null,'ready',$7,$8,$9)
         returning id`,
        [
          draftRef,
          command.webhookEventId,
          source.conversationId,
          command.kind,
          command.language,
          command.answerText,
          retentionDeadline,
          command.requestKey,
          command.evaluatedAt,
        ],
      );
      const draftId = inserted.rows[0]?.id;
      if (draftId === undefined) throw new Error('Model reply insert returned no identifier');
      for (const row of knowledgeRows) {
        await client.query(
          `insert into support_reply_draft_knowledge
            (draft_id, knowledge_version_id, reference_kind)
           values ($1,$2,'model_fact')`,
          [draftId, row.id],
        );
      }
      if (command.kind === 'safe_failure') {
        await client.query(
          `insert into support_escalation_outcomes
            (escalation_ref, conversation_id, source_webhook_event_id,
             reply_draft_id, reason_code, state, request_key,
             created_at, updated_at)
           values ($1,$2,$3,$4,$5,'open',$6,$7,$7)`,
          [
            derivedReference('ESCALATION_MODEL', command.webhookEventId),
            source.conversationId,
            command.webhookEventId,
            draftId,
            command.escalationReasonCode,
            derivedReference('REQUEST_ESCALATION_MODEL', command.webhookEventId),
            command.evaluatedAt,
          ],
        );
      }
      return {
        status: 'created',
        decisionType: command.kind,
        draftRef,
        nextAction: 'none',
      };
    });
  }

  public async persistDecision(input: unknown): Promise<PersistReplyDecisionResult> {
    const command = parsePersist(input);
    return withBoundedTransaction(this.pool, async (client) => {
      const source = await lockReplySourceEvent(client, command.webhookEventId);
      if (source === undefined || command.evaluatedAt < source.occurredAt) {
        throw new ReplyDecisionConflictError('Reply source event is not processable');
      }
      const existing = existingPersisted(
        command,
        await loadExistingState(client, command.webhookEventId),
      );
      if (existing !== undefined) return existing;
      const blocked = await this.guardReason(client, source, command.evaluatedAt);
      if (blocked !== undefined) return { status: 'policy_blocked', reasonCode: blocked };
      if (source.messageText === null) {
        return { status: 'policy_blocked', reasonCode: 'content_purged' };
      }

      const retention = await client.query<RetentionDeadlineRow>(
        `select lifecycle_class, expires_at, relationship_status, next_active_review_at
         from conversation_retention_states where conversation_id = $1`,
        [source.conversationId],
      );
      const retentionDeadline = artifactRetentionDeadline(retention.rows[0], command.evaluatedAt);
      if (retentionDeadline === undefined) {
        throw new ReplyDecisionConflictError('Reply retention deadline is unavailable');
      }

      if (command.kind === 'model_required') {
        const observationRef = derivedReference('GAP', command.webhookEventId);
        await client.query(
          `insert into knowledge_gap_observations
            (observation_ref, source_webhook_event_id, conversation_id, language,
             gap_kind, sanitized_summary, retention_deadline, request_key, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            observationRef,
            command.webhookEventId,
            source.conversationId,
            command.language,
            command.gapKind,
            gapSummaries[command.gapKind],
            retentionDeadline,
            command.requestKey,
            command.evaluatedAt,
          ],
        );
        return {
          status: 'created',
          decisionType: 'model_required',
          nextAction: 'model_required',
          observationRef,
        };
      }

      let knowledgeVersionId: string | null = null;
      if (command.kind === 'faq') {
        const selected = await client.query<EffectiveFaqRow>(
          `select version.id, version.answer_en, version.answer_bn
           from knowledge_items as item
           join lateral (
             select event.action, event.version_id
             from knowledge_publication_events as event
             where event.item_id = item.id and event.effective_at <= $3
             order by event.effective_at desc, event.id desc limit 1
           ) as publication on publication.action in ('publish', 'rollback')
           join knowledge_versions as version on version.id = publication.version_id
           where item.item_key = $1 and version.version_ref = $2
             and item.kind = 'faq' and version.state = 'approved'
             and version.decided_at is not null and version.decided_at <= $3
             and version.question_en is not null and version.answer_en is not null
             and version.question_bn is not null and version.answer_bn is not null`,
          [command.itemReference, command.versionReference, command.evaluatedAt],
        );
        const version = selected.rows[0];
        const answer = command.language === 'en' ? version?.answer_en : version?.answer_bn;
        if (version === undefined || answer !== command.answerText) {
          throw new ReplyDecisionConflictError('FAQ decision is not effective reviewed content');
        }
        knowledgeVersionId = version.id;
      }

      const draftRef = derivedReference('DRAFT', command.webhookEventId);
      const inserted = await client.query<{ readonly id: string }>(
        `insert into support_reply_drafts
          (draft_ref, source_webhook_event_id, conversation_id, decision_type,
           language, answer_text, knowledge_version_id, state,
           retention_deadline, request_key, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10)
         returning id`,
        [
          draftRef,
          command.webhookEventId,
          source.conversationId,
          command.kind,
          command.language,
          command.answerText,
          knowledgeVersionId,
          retentionDeadline,
          command.requestKey,
          command.evaluatedAt,
        ],
      );
      const draftId = inserted.rows[0]?.id;
      if (draftId === undefined) throw new Error('Reply draft insert returned no identifier');
      if (command.kind === 'faq') {
        await client.query(
          `insert into support_reply_draft_knowledge
            (draft_id, knowledge_version_id, reference_kind)
           values ($1,$2,'faq_answer')`,
          [draftId, knowledgeVersionId],
        );
      } else {
        await client.query(
          `insert into support_escalation_outcomes
            (escalation_ref, conversation_id, source_webhook_event_id,
             reply_draft_id, reason_code, state, request_key,
             created_at, updated_at)
           values ($1,$2,$3,$4,$5,'open',$6,$7,$7)`,
          [
            derivedReference('ESCALATION', command.webhookEventId),
            source.conversationId,
            command.webhookEventId,
            draftId,
            command.escalationReasonCode,
            derivedReference('REQUEST_ESCALATION', command.webhookEventId),
            command.evaluatedAt,
          ],
        );
      }
      return {
        status: 'created',
        decisionType: command.kind,
        draftRef,
        nextAction: 'none',
      };
    });
  }

  private async guardReason(
    client: pg.PoolClient,
    source: ReplySourceEvent,
    evaluatedAt: Date,
  ): Promise<ReplyPolicyBlockReason | undefined> {
    const selected = await client.query<GuardRow>(
      `select conversation.ai_paused_until,
              retention.expires_at,
              retention.content_purged_through_at,
              exists (
                select 1 from privacy_requests as request
                where request.contact_id = identity.contact_id
                  and request.state in (
                    'received','awaiting_confirmation','human_review',
                    'in_progress','partially_completed'
                  )
              ) as privacy_request_open
       from conversations as conversation
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       join conversation_retention_states as retention on retention.conversation_id = conversation.id
       where conversation.id = $1
       for update of conversation, identity, retention`,
      [source.conversationId],
    );
    const state = selected.rows[0];
    if (state === undefined) return 'content_purged';
    if (state.ai_paused_until !== null && state.ai_paused_until > evaluatedAt)
      return 'pause_active';
    if (state.privacy_request_open) return 'privacy_request_open';
    if (
      source.channelAccountId.startsWith('deleted:') ||
      source.externalContactId.startsWith('deleted:')
    ) {
      return 'identity_deleted';
    }

    const versions: string[] = [];
    const hmacs: string[] = [];
    for (const [version, key] of this.keyring.keys) {
      versions.push(version);
      hmacs.push(
        createIdentityHmac(
          {
            channel: source.channel,
            channelAccountId: source.channelAccountId,
            externalContactId: source.externalContactId,
          },
          { key, version },
        ),
      );
    }
    const suppression = await client.query<{ readonly deleted: boolean }>(
      `select exists (
         select 1 from privacy_suppressions
         where channel = $1 and category = 'deletion_tombstone'
           and effective_at <= $2 and (expires_at is null or expires_at > $2)
           and (key_version, identity_hmac) in (
             select * from unnest($3::text[], $4::text[])
           )
       ) as deleted`,
      [source.channel, evaluatedAt, versions, hmacs],
    );
    if (suppression.rows[0]?.deleted === true) return 'identity_deleted';
    if (state.expires_at !== null && state.expires_at <= evaluatedAt) return 'retention_expired';
    if (
      state.content_purged_through_at !== null &&
      state.content_purged_through_at >= source.occurredAt
    ) {
      return 'content_purged';
    }
    return undefined;
  }
}
