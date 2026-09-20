import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { PostgresMarketingOptOutPolicy } from '../../src/persistence/postgres-marketing-opt-out-policy.js';
import { PostgresRetentionJob } from '../../src/persistence/postgres-retention-job.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_privacy',
  roles: ['administrator'],
};
const reviewer = {
  reviewerRef: 'REVIEWER_TEST_outbound_privacy',
  roles: ['support_reviewer'],
} as const;
const identity = {
  channel: 'whatsapp' as const,
  channelAccountId: 'PHONE_TEST_outbound_privacy',
  externalContactId: 'CONTACT_TEST_outbound_privacy',
};
const baseAt = new Date('2026-09-20T00:00:00.000Z');

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_outbound_privacy_interactions');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(`
    truncate table contacts, webhook_receipts, privacy_suppressions,
      privacy_requests, outbound_attempts, outbound_intents,
      outbound_policy_review_events, outbound_policy_versions, admin_accounts
    restart identity cascade
  `);
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.outbound.privacy', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x31), Buffer.alloc(32, 0x32), baseAt],
  );
  await pool.query(
    `insert into outbound_policy_versions
       (policy_ref, version_number, request_key, per_contact_15_minute,
        per_contact_24_hour, whatsapp_account_1_minute,
        messenger_account_1_minute, global_1_minute, global_utc_day,
        worker_batch_size, lease_ms, provider_timeout_ms,
        maximum_definite_retries, retry_base_ms, retry_maximum_ms, state,
        created_by_account_id, approved_by_account_id, created_at,
        submitted_at, decided_at, activated_at)
     values ('POLICY_TEST_outbound_privacy', 1,
             'REQUEST_TEST_outbound_privacy_policy', 100, 1000, 100, 100,
             100, 10000, 20, 30000, 8000, 2, 1000, 8000, 'active',
             $1, $1, $2, $2, $2, $2)`,
    [account.rows[0]?.id, baseAt],
  );
});

afterAll(async () => {
  await dispose?.();
});

async function approvedDeletionWithPendingIntent() {
  const requestedAt = new Date(baseAt.getTime() + 60_000);
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'outbound-privacy-deletion-request',
    identity,
    messageText: 'DELETE MY DATA',
    occurredAt: requestedAt,
  });
  const policy = new PostgresDeletionPolicy(pool, syntheticPrivacyKeyring);
  const opened = await policy.openRequest({
    identity,
    requestedAt,
    requestKey: 'REQUEST_TEST_outbound_privacy_deletion_open',
    sourceWebhookEventId: source.eventId,
  });
  const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'outbound-privacy-deletion-confirmation',
    identity,
    messageText: 'Synthetic explicit deletion confirmation',
    occurredAt: new Date(requestedAt.getTime() + 60_000),
  });
  await policy.reviewRequest(
    {
      confirmationWebhookEventId: confirmation.eventId,
      decidedAt: new Date(requestedAt.getTime() + 120_000),
      decision: 'approve',
      reasonCode: 'customer_confirmed',
      requestKey: 'REQUEST_TEST_outbound_privacy_deletion_review',
      requestRef: opened.requestRef,
      verificationMethod: 'explicit_confirmation',
    },
    reviewer,
  );
  const authority = await pool.query<{
    readonly conversation_id: string;
    readonly identity_id: string;
  }>(
    `select conversation.id as conversation_id, identity.id as identity_id
     from conversations as conversation
     join channel_identities as identity on identity.id = conversation.channel_identity_id
     where conversation.id = $1`,
    [confirmation.conversationId],
  );
  const row = authority.rows[0];
  if (row === undefined) throw new Error('Synthetic outbound deletion authority missing');
  const draft = await pool.query<{ readonly id: string }>(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, state, retention_deadline, request_key, created_at)
     values ('DRAFT_TEST_outbound_privacy_pending', $1, $2, 'safe_failure',
             'en', 'Synthetic pending outbound reply.', 'ready', $3,
             'REQUEST_TEST_outbound_privacy_draft', $4)
     returning id`,
    [
      confirmation.eventId,
      row.conversation_id,
      new Date(baseAt.getTime() + 86_400_000),
      new Date(baseAt.getTime() + 180_000),
    ],
  );
  await pool.query(
    `insert into outbound_intents
       (intent_ref, request_key, reply_draft_id, conversation_id,
        channel_identity_id, policy_version_id, channel, channel_account_id,
        purpose, message_kind, state, next_attempt_at, retention_deadline,
        created_at, updated_at)
     values ('INTENT_TEST_outbound_privacy_pending',
             'REQUEST_TEST_outbound_privacy_intent', $1, $2, $3,
             (select id from outbound_policy_versions where state = 'active'),
             'whatsapp', $4, 'customer_support', 'support_text', 'pending',
             $5, $6, $5, $5)`,
    [
      draft.rows[0]?.id,
      row.conversation_id,
      row.identity_id,
      identity.channelAccountId,
      new Date(baseAt.getTime() + 180_000),
      new Date(baseAt.getTime() + 86_400_000),
    ],
  );
  for (const [key, attemptState] of [
    ['leased', null],
    ['authorized', 'authorized'],
    ['dispatch_started', 'dispatch_started'],
  ] as const) {
    const seededSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: `outbound-privacy-${key}-source`,
      identity,
      messageText: `Synthetic ${key} outbound source.`,
      occurredAt: new Date(baseAt.getTime() + 181_000 + key.length),
    });
    const seededDraft = await pool.query<{ readonly id: string }>(
      `insert into support_reply_drafts
         (draft_ref, source_webhook_event_id, conversation_id, decision_type,
          language, answer_text, state, retention_deadline, request_key, created_at)
       values ($1, $2, $3, 'safe_failure', 'en', $4, 'ready', $5, $6, $7)
       returning id`,
      [
        `DRAFT_TEST_outbound_privacy_${key}`,
        seededSource.eventId,
        seededSource.conversationId,
        `Synthetic ${key} outbound reply.`,
        new Date(baseAt.getTime() + 86_400_000),
        `REQUEST_TEST_outbound_privacy_draft_${key}`,
        new Date(baseAt.getTime() + 180_000),
      ],
    );
    const seededIntent = await pool.query<{ readonly id: string }>(
      `insert into outbound_intents
         (intent_ref, request_key, reply_draft_id, conversation_id,
          channel_identity_id, policy_version_id, channel, channel_account_id,
          purpose, message_kind, state, attempt_count, next_attempt_at,
          lease_ref, lease_expires_at, retention_deadline, created_at, updated_at)
       values ($1, $2, $3, $4, $5,
               (select id from outbound_policy_versions where state = 'active'),
               'whatsapp', $6, 'customer_support', 'support_text', 'leased',
               $7, null, $8, $9, $10, $11, $11)
       returning id`,
      [
        `INTENT_TEST_outbound_privacy_${key}`,
        `REQUEST_TEST_outbound_privacy_intent_${key}`,
        seededDraft.rows[0]?.id,
        row.conversation_id,
        row.identity_id,
        identity.channelAccountId,
        attemptState === null ? 0 : 1,
        `LEASE_TEST_outbound_privacy_${key}`,
        new Date(baseAt.getTime() + 3_600_000),
        new Date(baseAt.getTime() + 86_400_000),
        new Date(baseAt.getTime() + 180_000),
      ],
    );
    if (attemptState !== null) {
      await pool.query(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            authorized_at, dispatch_started_at, created_at)
         values ($1, 1, $2,
                 (select id from outbound_policy_versions where state = 'active'),
                 $3, 'whatsapp', $4, $5, $6, $7, $6)`,
        [
          seededIntent.rows[0]?.id,
          `ATTEMPT_TEST_outbound_privacy_${key}`,
          `RESERVATION_TEST_outbound_privacy_${key}`,
          identity.channelAccountId,
          attemptState,
          new Date(baseAt.getTime() + 190_000),
          attemptState === 'dispatch_started' ? new Date(baseAt.getTime() + 200_000) : null,
        ],
      );
    }
  }
  const acceptedSource = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'outbound-privacy-accepted-source',
    identity,
    messageText: 'Synthetic accepted outbound source.',
    occurredAt: new Date(baseAt.getTime() + 182_000),
  });
  const acceptedDraft = await pool.query<{ readonly id: string }>(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, state, retention_deadline, request_key, created_at)
     values ('DRAFT_TEST_outbound_privacy_delivered', $1, $2, 'safe_failure',
             'en', 'Synthetic delivered outbound reply.', 'ready', $3,
             'REQUEST_TEST_outbound_privacy_draft_delivered', $4)
     returning id`,
    [
      acceptedSource.eventId,
      acceptedSource.conversationId,
      new Date(baseAt.getTime() + 86_400_000),
      new Date(baseAt.getTime() + 183_000),
    ],
  );
  const acceptedIntent = await pool.query<{ readonly id: string }>(
    `insert into outbound_intents
       (intent_ref, request_key, reply_draft_id, conversation_id,
        channel_identity_id, policy_version_id, channel, channel_account_id,
        purpose, message_kind, state, attempt_count, retention_deadline,
        created_at, updated_at, finished_at)
     values ('INTENT_TEST_outbound_privacy_delivered',
             'REQUEST_TEST_outbound_privacy_intent_delivered', $1, $2, $3,
             (select id from outbound_policy_versions where state = 'active'),
             'whatsapp', $4, 'customer_support', 'support_text', 'delivered', 1,
             $5, $6, $7, $7)
     returning id`,
    [
      acceptedDraft.rows[0]?.id,
      acceptedSource.conversationId,
      row.identity_id,
      identity.channelAccountId,
      new Date(baseAt.getTime() + 86_400_000),
      new Date(baseAt.getTime() + 183_000),
      new Date(baseAt.getTime() + 210_000),
    ],
  );
  const acceptedAttempt = await pool.query<{ readonly id: string }>(
    `insert into outbound_attempts
       (intent_id, attempt_number, attempt_ref, policy_version_id,
        rate_reservation_ref, channel, channel_account_id, state,
        provider_message_id, outcome_code, authorized_at,
        dispatch_started_at, provider_accepted_at, finished_at, created_at)
     values ($1, 1, 'ATTEMPT_TEST_outbound_privacy_delivered',
             (select id from outbound_policy_versions where state = 'active'),
             'RESERVATION_TEST_outbound_privacy_delivered', 'whatsapp', $2,
             'provider_accepted', $3, 'provider_accepted', $4, $5, $6, $6, $4)
     returning id`,
    [
      acceptedIntent.rows[0]?.id,
      identity.channelAccountId,
      'META_MESSAGE_TEST_outbound_privacy_delivered',
      new Date(baseAt.getTime() + 190_000),
      new Date(baseAt.getTime() + 200_000),
      new Date(baseAt.getTime() + 205_000),
    ],
  );
  const statusEventId = await insertSyntheticPendingEvent(pool, {
    channel: 'whatsapp',
    channelAccountId: identity.channelAccountId,
    contactId: identity.externalContactId,
    eventKind: 'message_status',
    externalMessageId: 'META_MESSAGE_TEST_outbound_privacy_delivered',
    fixtureKey: 'outbound-privacy-delivered-status',
    messageStatus: 'delivered',
    occurredAt: new Date(baseAt.getTime() + 210_000),
  });
  await pool.query(
    `insert into outbound_status_events
       (webhook_event_id, intent_id, attempt_id, status, provider_occurred_at,
        created_at)
     values ($1, $2, $3, 'delivered', $4, $4)`,
    [
      statusEventId,
      acceptedIntent.rows[0]?.id,
      acceptedAttempt.rows[0]?.id,
      new Date(baseAt.getTime() + 210_000),
    ],
  );
  return { policy, requestRef: opened.requestRef };
}

describe('outbound privacy lifecycle interactions', () => {
  test('deletion reconciles pending outbound before completing its checklist location', async () => {
    const fixture = await approvedDeletionWithPendingIntent();
    const executedAt = new Date(baseAt.getTime() + 240_000);

    await fixture.policy.executeApprovedRequest({
      executedAt,
      requestKey: 'REQUEST_TEST_outbound_privacy_deletion_execute',
      requestRef: fixture.requestRef,
    });

    await expect(
      pool.query(
        `select intent.intent_ref, intent.state, intent.terminal_reason,
                draft.state as draft_state, draft.answer_text,
                location.state as location_state, location.checked_at
         from outbound_intents as intent
         join support_reply_drafts as draft on draft.id = intent.reply_draft_id
         join privacy_requests as request on request.request_ref = $1
         join privacy_request_locations as location
           on location.request_id = request.id
          and location.location_code = 'pending_outbound'
         order by intent.intent_ref`,
        [fixture.requestRef],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          answer_text: null,
          checked_at: executedAt,
          draft_state: 'erased',
          intent_ref: 'INTENT_TEST_outbound_privacy_authorized',
          location_state: 'completed',
          state: 'canceled',
          terminal_reason: 'identity_deleted',
        },
        {
          answer_text: null,
          checked_at: executedAt,
          draft_state: 'erased',
          intent_ref: 'INTENT_TEST_outbound_privacy_delivered',
          location_state: 'completed',
          state: 'delivered',
          terminal_reason: null,
        },
        {
          answer_text: null,
          checked_at: executedAt,
          draft_state: 'erased',
          intent_ref: 'INTENT_TEST_outbound_privacy_dispatch_started',
          location_state: 'completed',
          state: 'delivery_unknown',
          terminal_reason: 'delivery_unknown',
        },
        {
          answer_text: null,
          checked_at: executedAt,
          draft_state: 'erased',
          intent_ref: 'INTENT_TEST_outbound_privacy_leased',
          location_state: 'completed',
          state: 'canceled',
          terminal_reason: 'identity_deleted',
        },
        {
          answer_text: null,
          checked_at: executedAt,
          draft_state: 'erased',
          intent_ref: 'INTENT_TEST_outbound_privacy_pending',
          location_state: 'completed',
          state: 'canceled',
          terminal_reason: 'identity_deleted',
        },
      ],
    });
    await expect(
      pool.query(
        `select reason_code, state
         from outbound_escalation_outcomes
         order by id`,
      ),
    ).resolves.toMatchObject({
      rows: [{ reason_code: 'delivery_unknown', state: 'open' }],
    });
    await expect(
      pool.query(
        `select attempt.attempt_ref, attempt.state, attempt.outcome_code,
                attempt.finished_at
         from outbound_attempts as attempt
         order by attempt.attempt_ref`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          attempt_ref: 'ATTEMPT_TEST_outbound_privacy_authorized',
          finished_at: executedAt,
          outcome_code: 'aborted_before_dispatch',
          state: 'abandoned_before_dispatch',
        },
        {
          attempt_ref: 'ATTEMPT_TEST_outbound_privacy_delivered',
          finished_at: new Date(baseAt.getTime() + 205_000),
          outcome_code: 'provider_accepted',
          state: 'provider_accepted',
        },
        {
          attempt_ref: 'ATTEMPT_TEST_outbound_privacy_dispatch_started',
          finished_at: executedAt,
          outcome_code: 'crash_after_dispatch',
          state: 'delivery_unknown',
        },
      ],
    });
    await expect(
      pool.query(
        `select status, provider_occurred_at
         from outbound_status_events
         order by id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          provider_occurred_at: new Date(baseAt.getTime() + 210_000),
          status: 'delivered',
        },
      ],
    });
  });

  test('marketing opt-out atomically cancels template work and re-opt-in does not resurrect it', async () => {
    const effectiveAt = new Date(baseAt.getTime() + 60_000);
    const source = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'outbound-privacy-marketing-opt-out',
      identity,
      messageText: 'STOP MARKETING',
      occurredAt: effectiveAt,
    });
    const authority = await pool.query<{
      readonly identity_id: string;
    }>(`select channel_identity_id as identity_id from conversations where id = $1`, [
      source.conversationId,
    ]);
    const identityId = authority.rows[0]?.identity_id;
    if (identityId === undefined) throw new Error('Synthetic marketing identity missing');
    await pool.query(
      `insert into consent_events
         (channel_identity_id, category, action, wording, wording_version,
          source, source_at, idempotency_key)
       values ($1, 'newsletter', 'grant', 'Synthetic explicit consent', 'TEST_v1',
               'reviewer_recorded', $2, 'CONSENT_TEST_outbound_privacy_marketing')`,
      [identityId, baseAt],
    );
    const template = await pool.query<{ readonly id: string }>(
      `insert into outbound_template_versions
         (template_ref, version_number, request_key, channel, channel_account_id,
          provider_template_id, template_name, locale, category, variable_count,
          content_sha256, state, created_by_account_id, approved_by_account_id,
          created_at, submitted_at, decided_at, activated_at)
       values ('TEMPLATE_TEST_outbound_privacy', 1,
               'REQUEST_TEST_outbound_privacy_template', 'whatsapp', $1,
               'META_TEMPLATE_TEST_outbound_privacy', 'synthetic_privacy_news',
               'en_US', 'marketing_news', 0, $2, 'active',
               (select id from admin_accounts where account_ref = $3),
               (select id from admin_accounts where account_ref = $3),
               $4, $4, $4, $4)
       returning id`,
      [identity.channelAccountId, 'e'.repeat(64), administrator.reviewerRef, baseAt],
    );
    await pool.query(
      `insert into outbound_intents
         (intent_ref, request_key, template_version_id, conversation_id,
          channel_identity_id, policy_version_id, channel, channel_account_id,
          purpose, message_kind, state, next_attempt_at, retention_deadline,
          created_at, updated_at)
       values ('INTENT_TEST_outbound_privacy_marketing',
               'REQUEST_TEST_outbound_privacy_marketing_intent', $1, $2, $3,
               (select id from outbound_policy_versions where state = 'active'),
               'whatsapp', $4, 'marketing_news', 'fixed_template', 'pending',
               $5, $6, $5, $5)`,
      [
        template.rows[0]?.id,
        source.conversationId,
        identityId,
        identity.channelAccountId,
        effectiveAt,
        new Date(baseAt.getTime() + 86_400_000),
      ],
    );
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);

    await expect(
      policy.apply({
        effectiveAt,
        requestKey: 'REQUEST_TEST_outbound_privacy_marketing_opt_out',
        sourceWebhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ pendingIntentsCancelled: 1, status: 'applied' });
    await expect(
      policy.recordExplicitReoptIn(
        {
          categories: ['newsletter'],
          effectiveAt: new Date(baseAt.getTime() + 120_000),
          identity,
          requestKey: 'REQUEST_TEST_outbound_privacy_marketing_reopt_in',
          scope: 'source_identity',
          verificationMethod: 'same_channel_context',
        },
        reviewer,
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    await expect(
      pool.query(
        `select state, terminal_reason, next_attempt_at, lease_ref
         from outbound_intents
         where intent_ref = 'INTENT_TEST_outbound_privacy_marketing'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          lease_ref: null,
          next_attempt_at: null,
          state: 'canceled',
          terminal_reason: 'suppressed',
        },
      ],
    });
  });

  test('retention expiry cancels and erases outbound content without moving lifecycle anchors', async () => {
    const anchorAt = new Date(baseAt.getTime() + 60_000);
    const expiresAt = new Date(baseAt.getTime() + 120_000);
    const source = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'outbound-privacy-retention',
      identity,
      messageText: 'Synthetic expiring customer content.',
      occurredAt: anchorAt,
    });
    await pool.query(
      `update conversation_retention_states
       set anchor_at = $2, expires_at = $3, updated_at = $2
       where conversation_id = $1`,
      [source.conversationId, anchorAt, expiresAt],
    );
    const authority = await pool.query<{ readonly identity_id: string }>(
      `select channel_identity_id as identity_id from conversations where id = $1`,
      [source.conversationId],
    );
    const draft = await pool.query<{ readonly id: string }>(
      `insert into support_reply_drafts
         (draft_ref, source_webhook_event_id, conversation_id, decision_type,
          language, answer_text, state, retention_deadline, request_key, created_at)
       values ('DRAFT_TEST_outbound_privacy_retention', $1, $2, 'safe_failure',
               'en', 'Synthetic expiring outbound reply.', 'ready', $3,
               'REQUEST_TEST_outbound_privacy_retention_draft', $4)
       returning id`,
      [source.eventId, source.conversationId, expiresAt, anchorAt],
    );
    await pool.query(
      `insert into outbound_intents
         (intent_ref, request_key, reply_draft_id, conversation_id,
          channel_identity_id, policy_version_id, channel, channel_account_id,
          purpose, message_kind, state, next_attempt_at, retention_deadline,
          created_at, updated_at)
       values ('INTENT_TEST_outbound_privacy_retention',
               'REQUEST_TEST_outbound_privacy_retention_intent', $1, $2, $3,
               (select id from outbound_policy_versions where state = 'active'),
               'whatsapp', $4, 'customer_support', 'support_text', 'pending',
               $5, $6, $5, $5)`,
      [
        draft.rows[0]?.id,
        source.conversationId,
        authority.rows[0]?.identity_id,
        identity.channelAccountId,
        anchorAt,
        expiresAt,
      ],
    );

    await new PostgresRetentionJob(pool).runExpiredContentBatch({
      evaluatedAt: expiresAt,
      limit: 10,
      requestKey: 'REQUEST_TEST_outbound_privacy_retention_run',
    });

    await expect(
      pool.query(
        `select intent.state, intent.terminal_reason, draft.state as draft_state,
                draft.answer_text, retention.anchor_at, retention.expires_at,
                retention.content_purged_through_at
         from outbound_intents as intent
         join support_reply_drafts as draft on draft.id = intent.reply_draft_id
         join conversation_retention_states as retention
           on retention.conversation_id = intent.conversation_id
         where intent.intent_ref = 'INTENT_TEST_outbound_privacy_retention'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          anchor_at: anchorAt,
          answer_text: null,
          content_purged_through_at: anchorAt,
          draft_state: 'erased',
          expires_at: expiresAt,
          state: 'canceled',
          terminal_reason: 'retention_expired',
        },
      ],
    });
  });
});
