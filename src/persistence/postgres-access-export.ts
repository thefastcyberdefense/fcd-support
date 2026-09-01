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
  AccessPrivacyChecklistRecord,
  AccessPrivacyRequestRecord,
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
  readonly decision_code: 'known_name' | 'same_channel_context';
  readonly id: string;
  readonly request_ref: string;
  readonly state: 'completed' | 'in_progress';
}

interface ExistingAccessRunRow {
  readonly material_matches: boolean;
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
    return result.rows;
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

const productionAccessCollectors = Object.freeze([
  channelIdentityCollector,
  conversationCollector,
  conversationLifecycleCollector,
  webhookEventCollector,
  consentHistoryCollector,
  privacyRequestCollector,
  privacyChecklistCollector,
]);

export const ACCESS_EXPORT_COLLECTOR_NAMES: readonly AccessExportCategory[] = Object.freeze(
  productionAccessCollectors.map(({ name }) => name),
);

function recordCount(records: AccessExportRecords): number {
  return ACCESS_EXPORT_CATEGORIES.reduce((total, category) => total + records[category].length, 0);
}

export class PostgresAccessExport {
  public constructor(private readonly pool: pg.Pool) {}

  public async collect(input: unknown, principal: unknown): Promise<AccessDataExportResult> {
    const command = parseCollectAccessDataInput(input);
    requireSupportReviewer(principal);

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
                  request.decision_code
           from privacy_requests as request
           join contacts as contact on contact.id = request.contact_id
           where request.request_ref = $1
             and request.request_type = 'access'
             and request.state in ('in_progress', 'completed')
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

        const existing = await client.query<ExistingAccessRunRow>(
          `select request_id = $2::bigint
                    and collected_at = $3::timestamptz
                    and collector_count = $4
                    as material_matches
           from privacy_access_runs
           where request_key = $1`,
          [command.requestKey, request.id, command.collectedAt, productionAccessCollectors.length],
        );
        const replay = existing.rows[0];
        if (replay !== undefined && !replay.material_matches) {
          throw new PolicyIdempotencyConflictError('Access collection key material conflicts');
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
        };
        const totalRecords = recordCount(records);

        if (replay === undefined) {
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
        }

        return {
          export: {
            manifest: {
              collectedAt: command.collectedAt,
              recordCount: totalRecords,
              requestRef: request.request_ref,
              schemaVersion: 'fcd-support.access.v1',
              sourceCategories: ACCESS_EXPORT_CATEGORIES,
            },
            records,
          },
          status: replay === undefined ? 'collected' : 'duplicate',
        };
      },
      { isolationLevel: 'repeatable_read' },
    );
  }
}
