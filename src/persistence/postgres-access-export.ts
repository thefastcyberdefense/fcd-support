import type pg from 'pg';

import { parseCollectAccessDataInput } from '../policy/privacy-rights-command.js';
import type {
  AccessChannelIdentityRecord,
  AccessConsentRecord,
  AccessConversationLifecycleRecord,
  AccessConversationRecord,
  AccessDataExportResult,
  AccessExportCategory,
  AccessExportRecords,
  AccessKnowledgeGapObservationRecord,
  AccessPrivacyChecklistRecord,
  AccessPrivacyRequestRecord,
  AccessSupportEscalationOutcomeRecord,
  AccessSupportReplyDraftRecord,
  AccessWebhookEventRecord,
} from '../policy/policy-types.js';
import { ACCESS_EXPORT_CATEGORIES } from '../policy/policy-types.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export interface AccessCollector<TName extends AccessExportCategory, TRecord> {
  readonly name: TName;
  collect(client: pg.PoolClient, contactId: string): Promise<readonly TRecord[]>;
}

interface LockedAccessRequestRow {
  readonly contact_id: string;
  readonly decision_at: Date;
  readonly decision_code: 'known_name' | 'same_channel_context';
  readonly id: string;
  readonly request_ref: string;
  readonly state: 'in_progress';
}

interface ExistingAccessRunRow {
  readonly material_matches: boolean;
}

const ACCESS_REVIEW_VALIDITY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const REDACTED_SENSITIVE_MESSAGE = '[REDACTED SENSITIVE MESSAGE]';
const sensitiveMessagePattern =
  /(?:\b(?:authorization|bearer|credential|cvv|cvc|otp|passcode|password|payment|secret|token)\b|\bapi[\s._-]*key\b|\baccess[\s._-]*token\b|-----BEGIN[^\n]*PRIVATE KEY-----|(?:\d[ -]?){13,19})/iu;

function redactAccessMessageText(value: string | null): string | null {
  if (value === null) return null;
  return sensitiveMessagePattern.test(value.normalize('NFKC')) ? REDACTED_SENSITIVE_MESSAGE : value;
}

const channelIdentityCollector = Object.freeze({
  name: 'channel_identities',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessChannelIdentityRecord>(
      `select channel,
              channel_account_id as "channelAccountId",
              external_contact_id as "externalContactId",
              first_seen_at as "firstSeenAt",
              last_seen_at as "lastSeenAt"
       from channel_identities
       where contact_id = $1
       order by id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'channel_identities', AccessChannelIdentityRecord>);

const conversationCollector = Object.freeze({
  name: 'conversations',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessConversationRecord>(
      `select identity.channel,
              identity.channel_account_id as "channelAccountId",
              identity.external_contact_id as "externalContactId",
              conversation.created_at as "createdAt",
              conversation.last_activity_at as "lastActivityAt"
       from conversations as conversation
       join channel_identities as identity
         on identity.id = conversation.channel_identity_id
       where identity.contact_id = $1
       order by conversation.id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'conversations', AccessConversationRecord>);

const conversationLifecycleCollector = Object.freeze({
  name: 'conversation_lifecycle',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessConversationLifecycleRecord>(
      `select identity.channel,
              identity.channel_account_id as "channelAccountId",
              identity.external_contact_id as "externalContactId",
              state.lifecycle_class as "lifecycleClass",
              state.anchor_at as "anchorAt",
              state.expires_at as "expiresAt",
              state.relationship_status as "relationshipStatus",
              state.relationship_started_at as "relationshipStartedAt",
              state.relationship_ended_at as "relationshipEndedAt",
              state.final_paid_service_completed_at as "finalPaidServiceCompletedAt",
              state.last_active_review_at as "lastActiveReviewAt",
              state.next_active_review_at as "nextActiveReviewAt",
              state.content_purged_through_at as "contentPurgedThroughAt"
       from conversation_retention_states as state
       join conversations as conversation
         on conversation.id = state.conversation_id
       join channel_identities as identity
         on identity.id = conversation.channel_identity_id
       where identity.contact_id = $1
       order by conversation.id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'conversation_lifecycle', AccessConversationLifecycleRecord>);

const webhookEventCollector = Object.freeze({
  name: 'webhook_events',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessWebhookEventRecord>(
      `select event.channel,
              event.event_kind as "eventKind",
              event.external_message_id as "externalMessageId",
              event.occurred_at as "occurredAt",
              event.message_text as "messageText",
              event.message_status as "messageStatus",
              event.created_at as "createdAt"
       from webhook_events as event
       join channel_identities as identity
         on identity.channel = event.channel
        and identity.channel_account_id = event.channel_account_id
        and identity.external_contact_id = event.contact_id
       where identity.contact_id = $1
         and event.event_kind in (
           'business_message_echo',
           'customer_message',
           'message_status'
         )
       order by event.id`,
      [contactId],
    );
    return result.rows.map((row) => ({
      ...row,
      messageText: redactAccessMessageText(row.messageText),
    }));
  },
} satisfies AccessCollector<'webhook_events', AccessWebhookEventRecord>);

const consentHistoryCollector = Object.freeze({
  name: 'consent_history',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessConsentRecord>(
      `select identity.channel,
              identity.channel_account_id as "channelAccountId",
              identity.external_contact_id as "externalContactId",
              consent.category,
              consent.action,
              consent.wording,
              consent.wording_version as "wordingVersion",
              consent.source,
              consent.source_at as "sourceAt",
              consent.created_at as "createdAt"
       from consent_events as consent
       join channel_identities as identity
         on identity.id = consent.channel_identity_id
       where identity.contact_id = $1
       order by consent.id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'consent_history', AccessConsentRecord>);

const privacyRequestCollector = Object.freeze({
  name: 'privacy_requests',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessPrivacyRequestRecord>(
      `select request_ref as "requestRef",
              request_type as "requestType",
              state,
              received_at as "receivedAt",
              target_at as "targetAt",
              decision_at as "decisionAt",
              completed_at as "completedAt"
       from privacy_requests
       where contact_id = $1
       order by id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'privacy_requests', AccessPrivacyRequestRecord>);

const privacyChecklistCollector = Object.freeze({
  name: 'privacy_checklist',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessPrivacyChecklistRecord>(
      `select request.request_ref as "requestRef",
              location.location_code as "locationCode",
              location.required,
              location.state,
              location.outcome_code as "outcomeCode",
              location.checked_at as "checkedAt"
       from privacy_request_locations as location
       join privacy_requests as request on request.id = location.request_id
       where request.contact_id = $1
       order by request.id, location.location_code`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'privacy_checklist', AccessPrivacyChecklistRecord>);

const supportReplyDraftCollector = Object.freeze({
  name: 'support_reply_drafts',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessSupportReplyDraftRecord>(
      `select draft.draft_ref as "draftRef",
              draft.decision_type as "decisionType",
              draft.language,
              draft.answer_text as "answerText",
              version.version_ref as "knowledgeVersionRef",
              draft.state,
              draft.created_at as "createdAt",
              draft.erased_at as "erasedAt"
       from support_reply_drafts as draft
       join conversations as conversation on conversation.id = draft.conversation_id
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       left join knowledge_versions as version on version.id = draft.knowledge_version_id
       where identity.contact_id = $1
       order by draft.id`,
      [contactId],
    );
    return result.rows.map((row) => ({
      ...row,
      answerText: redactAccessMessageText(row.answerText),
    }));
  },
} satisfies AccessCollector<'support_reply_drafts', AccessSupportReplyDraftRecord>);

const knowledgeGapObservationCollector = Object.freeze({
  name: 'knowledge_gap_observations',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessKnowledgeGapObservationRecord>(
      `select observation.observation_ref as "observationRef",
              observation.language,
              observation.gap_kind as "gapKind",
              observation.sanitized_summary as "sanitizedSummary",
              observation.created_at as "createdAt",
              observation.erased_at as "erasedAt"
       from knowledge_gap_observations as observation
       join conversations as conversation on conversation.id = observation.conversation_id
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where identity.contact_id = $1
       order by observation.id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'knowledge_gap_observations', AccessKnowledgeGapObservationRecord>);

const supportEscalationOutcomeCollector = Object.freeze({
  name: 'support_escalation_outcomes',
  async collect(client: pg.PoolClient, contactId: string) {
    const result = await client.query<AccessSupportEscalationOutcomeRecord>(
      `select escalation.escalation_ref as "escalationRef",
              draft.draft_ref as "replyDraftRef",
              escalation.reason_code as "reasonCode",
              escalation.state,
              escalation.created_at as "createdAt",
              escalation.updated_at as "updatedAt",
              escalation.acknowledged_at as "acknowledgedAt",
              escalation.resolved_at as "resolvedAt"
       from support_escalation_outcomes as escalation
       left join support_reply_drafts as draft on draft.id = escalation.reply_draft_id
       join conversations as conversation
         on conversation.id = coalesce(escalation.conversation_id, draft.conversation_id)
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where identity.contact_id = $1
       order by escalation.id`,
      [contactId],
    );
    return result.rows;
  },
} satisfies AccessCollector<'support_escalation_outcomes', AccessSupportEscalationOutcomeRecord>);

// Outbound intents, leases, attempts, provider identifiers, and status evidence are
// deliberately outside this fixed subject-access allowlist.
const productionAccessCollectors = Object.freeze([
  channelIdentityCollector,
  conversationCollector,
  conversationLifecycleCollector,
  webhookEventCollector,
  consentHistoryCollector,
  privacyRequestCollector,
  privacyChecklistCollector,
  supportReplyDraftCollector,
  knowledgeGapObservationCollector,
  supportEscalationOutcomeCollector,
]);

export const ACCESS_EXPORT_COLLECTOR_NAMES: readonly AccessExportCategory[] = Object.freeze(
  productionAccessCollectors.map(({ name }) => name),
);

function recordCount(records: AccessExportRecords): number {
  return ACCESS_EXPORT_CATEGORIES.reduce((total, category) => total + records[category].length, 0);
}

export class PostgresAccessExport {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async collect(input: unknown, principal: unknown): Promise<AccessDataExportResult> {
    const command = parseCollectAccessDataInput(input);
    requireSupportReviewer(principal);
    const evaluatedAt = this.now();
    if (!(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.getTime())) {
      throw new TypeError('Access export clock returned an invalid Date');
    }

    return withBoundedTransaction(
      this.pool,
      async (client) => {
        await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
          command.requestKey,
        ]);
        const selected = await client.query<LockedAccessRequestRow>(
          `select request.id,
                  request.request_ref,
                  request.contact_id,
                  request.state,
                  request.decision_at,
                  request.decision_code
           from privacy_requests as request
           join contacts as contact on contact.id = request.contact_id
           where request.request_ref = $1
             and request.request_type = 'access'
             and request.state = 'in_progress'
             and request.decision_at is not null
             and request.decision_code in ('same_channel_context', 'known_name')
             and not exists (
               select 1
               from channel_identities as deleted_identity
               where deleted_identity.contact_id = request.contact_id
                 and (
                   deleted_identity.channel_account_id like 'deleted:%'
                   or deleted_identity.external_contact_id like 'deleted:%'
                 )
             )
           for update of request, contact`,
          [command.requestRef],
        );
        const request = selected.rows[0];
        if (request === undefined) {
          throw new PolicyIdempotencyConflictError('Approved access request is not available');
        }
        if (
          evaluatedAt.getTime() < request.decision_at.getTime() ||
          evaluatedAt.getTime() >
            request.decision_at.getTime() + ACCESS_REVIEW_VALIDITY_MILLISECONDS
        ) {
          throw new PolicyIdempotencyConflictError('Access review authorization has expired');
        }

        const existing = await client.query<ExistingAccessRunRow>(
          `select request_key = $1
                    and request_id = $2::bigint
                    and collected_at = $3::timestamptz
                    and collector_count = $4
                    as material_matches
           from privacy_access_runs
           where request_key = $1
              or request_id = $2
           order by (request_key = $1) desc
           limit 1`,
          [command.requestKey, request.id, command.collectedAt, productionAccessCollectors.length],
        );
        const replay = existing.rows[0];
        if (replay !== undefined) {
          if (!replay.material_matches) {
            throw new PolicyIdempotencyConflictError(
              'Access request was already collected or key material conflicts',
            );
          }
          return { status: 'duplicate' };
        }

        const records: AccessExportRecords = {
          channel_identities: await channelIdentityCollector.collect(client, request.contact_id),
          conversations: await conversationCollector.collect(client, request.contact_id),
          conversation_lifecycle: await conversationLifecycleCollector.collect(
            client,
            request.contact_id,
          ),
          webhook_events: await webhookEventCollector.collect(client, request.contact_id),
          consent_history: await consentHistoryCollector.collect(client, request.contact_id),
          privacy_requests: await privacyRequestCollector.collect(client, request.contact_id),
          privacy_checklist: await privacyChecklistCollector.collect(client, request.contact_id),
          support_reply_drafts: await supportReplyDraftCollector.collect(
            client,
            request.contact_id,
          ),
          knowledge_gap_observations: await knowledgeGapObservationCollector.collect(
            client,
            request.contact_id,
          ),
          support_escalation_outcomes: await supportEscalationOutcomeCollector.collect(
            client,
            request.contact_id,
          ),
        };
        const totalRecords = recordCount(records);

        const inserted = await client.query(
          `insert into privacy_access_runs
             (request_id, request_key, collected_at,
              collector_count, record_count, status)
           values ($1, $2, $3, $4, $5, 'collected')
           returning id`,
          [
            request.id,
            command.requestKey,
            command.collectedAt,
            productionAccessCollectors.length,
            totalRecords,
          ],
        );
        if (inserted.rows[0] === undefined) {
          throw new PolicyRecordNotFoundError('Access collection evidence was not created');
        }

        return {
          export: {
            manifest: {
              collectedAt: command.collectedAt,
              recordCount: totalRecords,
              requestRef: request.request_ref,
              schemaVersion: 'fcd-support.access.v2',
              sourceCategories: ACCESS_EXPORT_CATEGORIES,
            },
            records,
          },
          status: 'collected',
        };
      },
      { isolationLevel: 'repeatable_read' },
    );
  }
}
