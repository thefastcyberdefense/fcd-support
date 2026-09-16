import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import {
  consentCategoryForOutboundPurpose,
  evaluateOutboundEligibility,
  type FixedTemplateEligibilitySource,
  type OutboundEligibility,
  type OutboundEligibilityReason,
  type SupportTextEligibilitySource,
} from '../outbound/outbound-eligibility.js';
import { resolveOutboundBounds } from '../outbound/outbound-policy-input.js';
import {
  OUTBOUND_PURPOSES,
  type OutboundDeploymentBounds,
  type OutboundPolicyValues,
  type OutboundPurpose,
} from '../outbound/outbound-types.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import { PolicyIdempotencyConflictError } from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

const opaqueReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const decimalReference = z.string().regex(/^[1-9][0-9]*$/u);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));
const supportInputSchema = z.strictObject({
  draftRef: opaqueReference,
  evaluatedAt: validDate,
  requestKey: opaqueReference,
});
const templateInputSchema = z.strictObject({
  conversationId: decimalReference,
  evaluatedAt: validDate,
  purpose: z.enum(OUTBOUND_PURPOSES),
  requestKey: opaqueReference,
  templateRef: opaqueReference,
});

export type OutboundIntentResult =
  | { readonly intentRef: string; readonly status: 'created' | 'duplicate' }
  | {
      readonly reason: Exclude<OutboundEligibilityReason, 'allowed'>;
      readonly status: 'denied';
    };

interface AuthorityRow {
  readonly ai_paused_until: Date | null;
  readonly channel: 'messenger' | 'whatsapp';
  readonly channel_account_id: string;
  readonly contact_id: string;
  readonly conversation_id: string;
  readonly external_contact_id: string;
  readonly identity_id: string;
}

interface DraftRow extends AuthorityRow {
  readonly draft_id: string;
  readonly draft_ref: string;
  readonly erased_at: Date | null;
  readonly retention_deadline: Date;
  readonly state: 'erased' | 'ready';
}

interface TemplateRow {
  readonly category: OutboundPurpose;
  readonly channel: 'whatsapp';
  readonly channel_account_id: string;
  readonly id: string;
  readonly locale: 'bn_BD' | 'en_US';
  readonly template_ref: string;
  readonly variable_count: number;
}

interface RetentionRow {
  readonly expires_at: Date | null;
  readonly lifecycle_class: 'active_client' | 'casual_chat' | 'unconverted_lead';
  readonly next_active_review_at: Date | null;
  readonly relationship_status: 'closed' | 'open' | null;
}

interface PolicyRow {
  readonly global_1_minute: number;
  readonly global_utc_day: number;
  readonly id: string;
  readonly lease_ms: number;
  readonly maximum_definite_retries: number;
  readonly messenger_account_1_minute: number;
  readonly per_contact_15_minute: number;
  readonly per_contact_24_hour: number;
  readonly provider_timeout_ms: number;
  readonly retry_base_ms: number;
  readonly retry_maximum_ms: number;
  readonly whatsapp_account_1_minute: number;
  readonly worker_batch_size: number;
}

interface ExistingIntentRow {
  readonly conversation_id: string;
  readonly created_at: Date;
  readonly draft_ref: string | null;
  readonly intent_ref: string;
  readonly message_kind: 'fixed_template' | 'support_text';
  readonly purpose: OutboundPurpose;
  readonly template_ref: string | null;
}

interface PrivacyProjection {
  readonly global_suppressed: boolean;
  readonly identity_deleted: boolean;
  readonly scoped_suppressed: boolean;
}

interface CurrentProjection {
  readonly activeClientReviewAt: Date | null;
  readonly echoHoldUntil: Date | null;
  readonly lastCustomerMessageAt: Date | null;
  readonly latestConsentAction: 'grant' | 'revoke' | null;
  readonly policyVersionId: string | null;
  readonly privacyHoldOpen: boolean;
  readonly retentionDeadline: Date;
  readonly suppressions: PrivacyProjection;
}

const escalationReasons = new Set<Exclude<OutboundEligibilityReason, 'allowed'>>([
  'active_review_overdue',
  'consent_missing',
  'content_erased',
  'identity_deleted',
  'pause_active',
  'policy_unavailable',
  'privacy_hold',
  'retention_expired',
  'suppressed',
  'template_invalid',
  'template_required',
  'window_closed',
]);

function policyValues(row: PolicyRow): OutboundPolicyValues {
  return {
    global1Minute: row.global_1_minute,
    globalUtcDay: row.global_utc_day,
    leaseMs: row.lease_ms,
    maximumDefiniteRetries: row.maximum_definite_retries,
    messengerAccount1Minute: row.messenger_account_1_minute,
    perContact15Minute: row.per_contact_15_minute,
    perContact24Hour: row.per_contact_24_hour,
    providerTimeoutMs: row.provider_timeout_ms,
    retryBaseMs: row.retry_base_ms,
    retryMaximumMs: row.retry_maximum_ms,
    whatsappAccount1Minute: row.whatsapp_account_1_minute,
    workerBatchSize: row.worker_batch_size,
  };
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function minimumDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

export class PostgresOutboundIntentStore {
  private readonly deploymentBounds: OutboundDeploymentBounds;
  private readonly privacyKeyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    privacyKeyring: PrivacyHmacKeyring,
    deploymentBounds: OutboundDeploymentBounds,
  ) {
    this.privacyKeyring = requirePrivacyHmacKeyring(privacyKeyring);
    this.deploymentBounds = resolveOutboundBounds(deploymentBounds, deploymentBounds);
  }

  public async createSupportIntent(inputValue: unknown): Promise<OutboundIntentResult> {
    const input = supportInputSchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      await this.lockRequest(client, input.requestKey);
      const replay = await this.findIntentByRequestKey(client, input.requestKey);
      if (replay !== undefined) {
        if (
          replay.message_kind !== 'support_text' ||
          replay.draft_ref !== input.draftRef ||
          !sameDate(replay.created_at, input.evaluatedAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { intentRef: replay.intent_ref, status: 'duplicate' };
      }

      const draft = await this.lockDraftAuthority(client, input.draftRef);
      if (draft === undefined) return { reason: 'source_not_ready', status: 'denied' };
      await this.lockIdentityScope(client, draft.identity_id);
      const sourceConflict = await client.query<{ readonly intent_ref: string }>(
        `select intent.intent_ref
           from outbound_intents as intent
           where intent.reply_draft_id = $1`,
        [draft.draft_id],
      );
      if (sourceConflict.rows[0] !== undefined) throw new PolicyIdempotencyConflictError();

      const projection = await this.loadCurrentProjection(client, draft, input.evaluatedAt, null);
      const source: SupportTextEligibilitySource = {
        contentErased: draft.state === 'erased' || draft.erased_at !== null,
        kind: 'support_text',
        ready: true,
      };
      const eligibility = evaluateOutboundEligibility({
        activeClientReviewAt: projection.activeClientReviewAt,
        channel: draft.channel,
        channelAccountId: draft.channel_account_id,
        echoHoldUntil: projection.echoHoldUntil,
        evaluatedAt: input.evaluatedAt,
        globalSuppressed: projection.suppressions.global_suppressed,
        identityDeleted: projection.suppressions.identity_deleted,
        latestConsentAction: null,
        lastCustomerMessageAt: projection.lastCustomerMessageAt,
        pauseUntil: draft.ai_paused_until,
        policyAvailable: projection.policyVersionId !== null,
        privacyHoldOpen: projection.privacyHoldOpen,
        purpose: 'customer_support',
        requestedLocale: 'en_US',
        retentionDeadline: minimumDate(draft.retention_deadline, projection.retentionDeadline),
        scopedSuppressed: false,
        source,
      });
      if (!eligibility.eligible) {
        await this.recordEscalation(
          client,
          draft.conversation_id,
          input.requestKey,
          input.evaluatedAt,
          eligibility,
        );
        return { reason: eligibility.reason, status: 'denied' };
      }
      const policyVersionId = projection.policyVersionId;
      if (policyVersionId === null) throw new Error('Effective outbound policy was not resolved');
      return this.insertIntent(client, {
        channel: draft.channel,
        channelAccountId: draft.channel_account_id,
        channelIdentityId: draft.identity_id,
        conversationId: draft.conversation_id,
        createdAt: input.evaluatedAt,
        messageKind: 'support_text',
        policyVersionId,
        purpose: 'customer_support',
        replyDraftId: draft.draft_id,
        requestKey: input.requestKey,
        retentionDeadline: minimumDate(draft.retention_deadline, projection.retentionDeadline),
        templateVersionId: null,
      });
    });
  }

  public async createFixedTemplateIntent(inputValue: unknown): Promise<OutboundIntentResult> {
    const input = templateInputSchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      await this.lockRequest(client, input.requestKey);
      const replay = await this.findIntentByRequestKey(client, input.requestKey);
      if (replay !== undefined) {
        if (
          replay.message_kind !== 'fixed_template' ||
          replay.template_ref !== input.templateRef ||
          replay.conversation_id !== input.conversationId ||
          replay.purpose !== input.purpose ||
          !sameDate(replay.created_at, input.evaluatedAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { intentRef: replay.intent_ref, status: 'duplicate' };
      }

      const authority = await this.lockConversationAuthority(client, input.conversationId);
      if (authority === undefined) return { reason: 'source_not_ready', status: 'denied' };
      await this.lockIdentityScope(client, authority.identity_id);
      const template = await this.lockEffectiveTemplate(
        client,
        input.templateRef,
        authority.channel_account_id,
        input.purpose,
        input.evaluatedAt,
      );
      const consentCategory = consentCategoryForOutboundPurpose(input.purpose);
      const projection = await this.loadCurrentProjection(
        client,
        authority,
        input.evaluatedAt,
        consentCategory,
      );
      const source: FixedTemplateEligibilitySource =
        template === undefined
          ? {
              active: false,
              channel: 'whatsapp',
              channelAccountId: authority.channel_account_id,
              contentErased: false,
              kind: 'fixed_template',
              locale: 'en_US',
              purpose: input.purpose,
              ready: true,
              variableCount: 0,
            }
          : {
              active: true,
              channel: template.channel,
              channelAccountId: template.channel_account_id,
              contentErased: false,
              kind: 'fixed_template',
              locale: template.locale,
              purpose: template.category,
              ready: true,
              variableCount: template.variable_count,
            };
      const eligibility = evaluateOutboundEligibility({
        activeClientReviewAt: projection.activeClientReviewAt,
        channel: authority.channel,
        channelAccountId: authority.channel_account_id,
        echoHoldUntil: projection.echoHoldUntil,
        evaluatedAt: input.evaluatedAt,
        globalSuppressed: projection.suppressions.global_suppressed,
        identityDeleted: projection.suppressions.identity_deleted,
        latestConsentAction: projection.latestConsentAction,
        lastCustomerMessageAt: projection.lastCustomerMessageAt,
        pauseUntil: authority.ai_paused_until,
        policyAvailable: projection.policyVersionId !== null,
        privacyHoldOpen: projection.privacyHoldOpen,
        purpose: input.purpose,
        requestedLocale: source.locale,
        retentionDeadline: projection.retentionDeadline,
        scopedSuppressed: projection.suppressions.scoped_suppressed,
        source,
      });
      if (template === undefined) {
        const denial = { eligible: false, reason: 'template_invalid' } as const;
        await this.recordEscalation(
          client,
          authority.conversation_id,
          input.requestKey,
          input.evaluatedAt,
          denial,
        );
        return { reason: denial.reason, status: 'denied' };
      }
      if (!eligibility.eligible) {
        await this.recordEscalation(
          client,
          authority.conversation_id,
          input.requestKey,
          input.evaluatedAt,
          eligibility,
        );
        return { reason: eligibility.reason, status: 'denied' };
      }
      const policyVersionId = projection.policyVersionId;
      if (policyVersionId === null) throw new Error('Effective outbound policy was not resolved');
      return this.insertIntent(client, {
        channel: authority.channel,
        channelAccountId: authority.channel_account_id,
        channelIdentityId: authority.identity_id,
        conversationId: authority.conversation_id,
        createdAt: input.evaluatedAt,
        messageKind: 'fixed_template',
        policyVersionId,
        purpose: input.purpose,
        replyDraftId: null,
        requestKey: input.requestKey,
        retentionDeadline: projection.retentionDeadline,
        templateVersionId: template.id,
      });
    });
  }

  private async lockRequest(client: pg.PoolClient, requestKey: string): Promise<void> {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 7100514::bigint))`,
      [requestKey],
    );
  }

  private async lockIdentityScope(client: pg.PoolClient, identityId: string): Promise<void> {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 7100515::bigint))`,
      [identityId],
    );
  }

  private async findIntentByRequestKey(
    client: pg.PoolClient,
    requestKey: string,
  ): Promise<ExistingIntentRow | undefined> {
    const selected = await client.query<ExistingIntentRow>(
      `select intent.intent_ref, intent.conversation_id, intent.message_kind, intent.purpose,
              intent.created_at, draft.draft_ref, template.template_ref
       from outbound_intents as intent
       left join support_reply_drafts as draft on draft.id = intent.reply_draft_id
       left join outbound_template_versions as template
         on template.id = intent.template_version_id
       where intent.request_key = $1`,
      [requestKey],
    );
    return selected.rows[0];
  }

  private async lockDraftAuthority(
    client: pg.PoolClient,
    draftRef: string,
  ): Promise<DraftRow | undefined> {
    const selected = await client.query<DraftRow>(
      `select draft.id as draft_id, draft.draft_ref, draft.state,
              draft.erased_at, draft.retention_deadline,
              conversation.id as conversation_id, conversation.ai_paused_until,
              identity.id as identity_id, identity.contact_id,
              identity.channel, identity.channel_account_id,
              identity.external_contact_id
       from support_reply_drafts as draft
       join conversations as conversation on conversation.id = draft.conversation_id
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where draft.draft_ref = $1
       for update of draft, conversation, identity`,
      [draftRef],
    );
    return selected.rows[0];
  }

  private async lockConversationAuthority(
    client: pg.PoolClient,
    conversationId: string,
  ): Promise<AuthorityRow | undefined> {
    const selected = await client.query<AuthorityRow>(
      `select conversation.id as conversation_id, conversation.ai_paused_until,
              identity.id as identity_id, identity.contact_id,
              identity.channel, identity.channel_account_id,
              identity.external_contact_id
       from conversations as conversation
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where conversation.id = $1
       for update of conversation, identity`,
      [conversationId],
    );
    return selected.rows[0];
  }

  private async lockEffectiveTemplate(
    client: pg.PoolClient,
    templateRef: string,
    channelAccountId: string,
    purpose: OutboundPurpose,
    evaluatedAt: Date,
  ): Promise<TemplateRow | undefined> {
    const selected = await client.query<TemplateRow>(
      `select template.id, template.template_ref, template.channel,
              template.channel_account_id, template.locale, template.category,
              template.variable_count
       from outbound_template_versions as template
       join lateral (
         select event.action
         from outbound_template_review_events as event
         where event.template_version_id = template.id
           and event.effective_at <= $1
         order by event.effective_at desc, event.id desc
         limit 1
       ) as effective on effective.action = 'activate'
       where template.template_ref = $2
         and template.channel = 'whatsapp'
         and template.channel_account_id = $3
         and template.category = $4
       order by template.version_number desc
       for update of template`,
      [evaluatedAt, templateRef, channelAccountId, purpose],
    );
    if (selected.rows.length > 1) throw new Error('Multiple outbound templates are effective');
    return selected.rows[0];
  }

  private async loadCurrentProjection(
    client: pg.PoolClient,
    authority: AuthorityRow,
    evaluatedAt: Date,
    consentCategory: string | null,
  ): Promise<CurrentProjection> {
    const retention = await client.query<RetentionRow>(
      `select lifecycle_class, relationship_status, expires_at, next_active_review_at
       from conversation_retention_states
       where conversation_id = $1
       for update`,
      [authority.conversation_id],
    );
    const retentionRow = retention.rows[0];
    const activeClientReviewAt =
      retentionRow?.lifecycle_class === 'active_client' &&
      retentionRow.relationship_status === 'open'
        ? retentionRow.next_active_review_at
        : null;
    const retentionDeadline =
      retentionRow?.lifecycle_class === 'active_client' &&
      retentionRow.relationship_status === 'open'
        ? (retentionRow.next_active_review_at ?? evaluatedAt)
        : (retentionRow?.expires_at ?? evaluatedAt);

    const policy = await client.query<PolicyRow>(
      `select policy.id, policy.per_contact_15_minute, policy.per_contact_24_hour,
              policy.whatsapp_account_1_minute, policy.messenger_account_1_minute,
              policy.global_1_minute, policy.global_utc_day,
              policy.worker_batch_size, policy.lease_ms, policy.provider_timeout_ms,
              policy.maximum_definite_retries, policy.retry_base_ms,
              policy.retry_maximum_ms
       from outbound_policy_versions as policy
       join lateral (
         select event.action
         from outbound_policy_review_events as event
         where event.policy_version_id = policy.id
           and event.effective_at <= $1
         order by event.effective_at desc, event.id desc
         limit 1
       ) as effective on effective.action = 'activate'
       order by policy.version_number desc
       for update of policy`,
      [evaluatedAt],
    );
    if (policy.rows.length > 1) throw new Error('Multiple outbound policies are effective');
    const activePolicy = policy.rows[0];
    if (activePolicy !== undefined) {
      resolveOutboundBounds(policyValues(activePolicy), this.deploymentBounds);
    }

    const latestCustomer = await client.query<{ readonly occurred_at: Date }>(
      `select event.occurred_at
       from webhook_event_applications as application
       join webhook_events as event on event.id = application.webhook_event_id
       where application.conversation_id = $1
         and application.outcome = 'customer_message_applied'
         and event.event_kind = 'customer_message'
         and event.admission_outcome = 'pending'
         and event.occurred_at <= $2
       order by event.occurred_at desc, event.id desc
       limit 1
       for share of application, event`,
      [authority.conversation_id, evaluatedAt],
    );
    const hold = await client.query<{ readonly expires_at: Date }>(
      `select expires_at
       from outbound_echo_correlation_holds
       where conversation_id = $1 and state = 'open' and expires_at > $2
       order by expires_at desc, id desc
       limit 1
       for update`,
      [authority.conversation_id, evaluatedAt],
    );
    const privacy = await client.query<{ readonly open: boolean }>(
      `select exists (
         select 1 from privacy_requests
         where contact_id = $1
           and request_type in ('access', 'correction', 'deletion')
           and state in ('received', 'awaiting_confirmation', 'human_review', 'in_progress')
       ) as open`,
      [authority.contact_id],
    );
    await client.query(
      `select id from privacy_requests
       where contact_id = $1
         and state in ('received', 'awaiting_confirmation', 'human_review', 'in_progress')
       order by id for update`,
      [authority.contact_id],
    );

    const suppressions = await this.loadSuppressions(
      client,
      authority,
      evaluatedAt,
      consentCategory,
    );
    const latestConsent =
      consentCategory === null
        ? null
        : await client.query<{ readonly action: 'grant' | 'revoke' }>(
            `select action
           from consent_events
           where channel_identity_id = $1 and category = $2 and source_at <= $3
           order by source_at desc, id desc
           limit 1
           for share`,
            [authority.identity_id, consentCategory, evaluatedAt],
          );

    return {
      activeClientReviewAt,
      echoHoldUntil: hold.rows[0]?.expires_at ?? null,
      lastCustomerMessageAt: latestCustomer.rows[0]?.occurred_at ?? null,
      latestConsentAction: latestConsent === null ? null : (latestConsent.rows[0]?.action ?? null),
      policyVersionId: activePolicy?.id ?? null,
      privacyHoldOpen: privacy.rows[0]?.open ?? false,
      retentionDeadline,
      suppressions,
    };
  }

  private async loadSuppressions(
    client: pg.PoolClient,
    authority: AuthorityRow,
    evaluatedAt: Date,
    consentCategory: string | null,
  ): Promise<PrivacyProjection> {
    const keyVersions: string[] = [];
    const identityHmacs: string[] = [];
    for (const [version, key] of this.privacyKeyring.keys) {
      keyVersions.push(version);
      identityHmacs.push(
        createIdentityHmac(
          {
            channel: authority.channel,
            channelAccountId: authority.channel_account_id,
            externalContactId: authority.external_contact_id,
          },
          { key, version },
        ),
      );
    }
    const selected = await client.query<PrivacyProjection>(
      `select
         bool_or(category = 'deletion_tombstone') as identity_deleted,
         bool_or(category = 'marketing_opt_out') as global_suppressed,
         bool_or(category = 'marketing_opt_out:' || $5) as scoped_suppressed
       from privacy_suppressions
       where channel = $1
         and effective_at <= $2
         and (expires_at is null or expires_at > $2)
         and (key_version, identity_hmac) in (
           select * from unnest($3::text[], $4::text[])
         )`,
      [authority.channel, evaluatedAt, keyVersions, identityHmacs, consentCategory ?? ''],
    );
    const row = selected.rows[0];
    return {
      global_suppressed: row?.global_suppressed ?? false,
      identity_deleted: row?.identity_deleted ?? false,
      scoped_suppressed: row?.scoped_suppressed ?? false,
    };
  }

  private async insertIntent(
    client: pg.PoolClient,
    input: {
      readonly channel: 'messenger' | 'whatsapp';
      readonly channelAccountId: string;
      readonly channelIdentityId: string;
      readonly conversationId: string;
      readonly createdAt: Date;
      readonly messageKind: 'fixed_template' | 'support_text';
      readonly policyVersionId: string;
      readonly purpose: OutboundPurpose;
      readonly replyDraftId: string | null;
      readonly requestKey: string;
      readonly retentionDeadline: Date;
      readonly templateVersionId: string | null;
    },
  ): Promise<OutboundIntentResult> {
    const intentRef = `OUTBOUND_${randomUUID()}`;
    await client.query(
      `insert into outbound_intents
         (intent_ref, request_key, reply_draft_id, template_version_id,
          conversation_id, channel_identity_id, policy_version_id, channel,
          channel_account_id, purpose, message_kind, state, attempt_count,
          next_attempt_at, retention_deadline, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',0,$12,$13,$12,$12)`,
      [
        intentRef,
        input.requestKey,
        input.replyDraftId,
        input.templateVersionId,
        input.conversationId,
        input.channelIdentityId,
        input.policyVersionId,
        input.channel,
        input.channelAccountId,
        input.purpose,
        input.messageKind,
        input.createdAt,
        input.retentionDeadline,
      ],
    );
    return { intentRef, status: 'created' };
  }

  private async recordEscalation(
    client: pg.PoolClient,
    conversationId: string,
    requestKey: string,
    createdAt: Date,
    eligibility: Exclude<OutboundEligibility, { readonly eligible: true }>,
  ): Promise<void> {
    if (!escalationReasons.has(eligibility.reason)) return;
    const digest = createHash('sha256').update(requestKey).digest('hex');
    const escalationRequestKey = `OUTBOUND_ESCALATION_${digest}`;
    const escalationRef = `ESCALATION_${digest}`;
    const inserted = await client.query(
      `insert into outbound_escalation_outcomes
         (escalation_ref, conversation_id, reason_code, state, request_key,
          created_at, updated_at)
       values ($1,$2,$3,'open',$4,$5,$5)
       on conflict (request_key) do nothing
       returning id`,
      [escalationRef, conversationId, eligibility.reason, escalationRequestKey, createdAt],
    );
    if ((inserted.rowCount ?? 0) > 0) return;
    const existing = await client.query<{
      readonly conversation_id: string;
      readonly reason_code: string;
    }>(
      `select conversation_id, reason_code
       from outbound_escalation_outcomes where request_key = $1`,
      [escalationRequestKey],
    );
    const row = existing.rows[0];
    if (row?.conversation_id !== conversationId || row.reason_code !== eligibility.reason) {
      throw new PolicyIdempotencyConflictError();
    }
  }
}
