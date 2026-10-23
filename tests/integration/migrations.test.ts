import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  createIsolatedTestDatabase,
  rollbackThroughMigration,
  type IsolatedTestDatabase,
} from './test-database.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
} from './policy-fixtures.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let runMigrations: IsolatedTestDatabase['runMigrations'];
let schema: string;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('migrations');
  disposeDatabase = database.dispose;
  pool = database.pool;
  runMigrations = database.runMigrations;
  schema = database.schema;
});

afterAll(async () => {
  await disposeDatabase?.();
});

async function migrateDownThrough(targetVersion: number): Promise<void> {
  await rollbackThroughMigration({ pool, runMigrations }, targetVersion);
}

async function createSyntheticConversation(fixtureKey: string): Promise<string> {
  const contact = await pool.query<{ readonly id: string }>(
    `insert into contacts default values returning id`,
  );
  const identity = await pool.query<{ readonly id: string }>(
    `insert into channel_identities
       (contact_id, channel, channel_account_id, external_contact_id,
        first_seen_at, last_seen_at)
     values ($1, 'messenger', $2, $3,
             '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z')
     returning id`,
    [contact.rows[0]?.id, `PAGE_TEST_retention_${fixtureKey}`, `PSID_TEST_retention_${fixtureKey}`],
  );
  const conversation = await pool.query<{ readonly id: string }>(
    `insert into conversations (channel_identity_id, created_at, last_activity_at)
     values ($1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z')
     returning id`,
    [identity.rows[0]?.id],
  );
  const conversationId = conversation.rows[0]?.id;
  if (conversationId === undefined) {
    throw new Error('Synthetic retention conversation insert returned no identifier');
  }
  return conversationId;
}

async function captureRolledBackMutation(
  statement: string,
  values: readonly unknown[] = [],
): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    return await client.query(statement, [...values]).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

describe('Phase 2 database migrations', () => {
  test('create the Phase 2, Phase 3A, and retention policy tables', async () => {
    const result = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'channel_identities',
           'consent_events',
           'contacts',
           'conversation_retention_states',
           'conversations',
           'human_pause_events',
           'policy_audit_outcomes',
           'retention_events',
           'retention_job_runs',
           'webhook_event_applications',
           'webhook_events',
           'webhook_receipts'
         )
       order by table_name`,
      [schema],
    );

    expect(result.rows).toEqual([
      { table_name: 'channel_identities' },
      { table_name: 'consent_events' },
      { table_name: 'contacts' },
      { table_name: 'conversation_retention_states' },
      { table_name: 'conversations' },
      { table_name: 'human_pause_events' },
      { table_name: 'policy_audit_outcomes' },
      { table_name: 'retention_events' },
      { table_name: 'retention_job_runs' },
      { table_name: 'webhook_event_applications' },
      { table_name: 'webhook_events' },
      { table_name: 'webhook_receipts' },
    ]);
  });

  test('create the reviewed knowledge catalog as migration nine', async () => {
    const tables = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'knowledge_aliases',
           'knowledge_items',
           'knowledge_publication_events',
           'knowledge_review_events',
           'knowledge_source_snapshots',
           'knowledge_sources',
           'knowledge_tags',
           'knowledge_versions'
         )
       order by table_name`,
      [schema],
    );
    const migrations = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from pgmigrations`,
    );
    const trigramExtension = await pool.query<{ readonly installed: boolean }>(
      `select exists (
         select 1 from pg_extension where extname = 'pg_trgm'
       ) as installed`,
    );
    const aliasIndexes = await pool.query<{ readonly indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = $1
         and tablename = 'knowledge_aliases'
       order by indexname`,
      [schema],
    );

    expect(tables.rows).toEqual([
      { table_name: 'knowledge_aliases' },
      { table_name: 'knowledge_items' },
      { table_name: 'knowledge_publication_events' },
      { table_name: 'knowledge_review_events' },
      { table_name: 'knowledge_source_snapshots' },
      { table_name: 'knowledge_sources' },
      { table_name: 'knowledge_tags' },
      { table_name: 'knowledge_versions' },
    ]);
    expect(migrations.rows[0]?.count).toBe(16);
    expect(trigramExtension.rows).toEqual([{ installed: true }]);
    expect(aliasIndexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'knowledge_aliases_normalized_exact_idx',
        'knowledge_aliases_normalized_trgm_idx',
      ]),
    );
  });

  test('create the private admin, proposal-learning, draft, and escalation schema as migration ten', async () => {
    const tables = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'admin_accounts',
           'admin_audit_events',
           'admin_mfa_credentials',
           'admin_role_assignments',
           'admin_sessions',
           'customer_insight_entries',
           'customer_insight_runs',
           'knowledge_gap_candidates',
           'knowledge_gap_observations',
           'owner_question_answers',
           'owner_question_digest_entries',
           'owner_question_digests',
           'owner_question_insights',
           'owner_questions',
           'support_escalation_outcomes',
           'support_reply_draft_knowledge',
           'support_reply_drafts'
         )
       order by table_name`,
      [schema],
    );
    const migrations = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from pgmigrations`,
    );

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'admin_accounts',
      'admin_audit_events',
      'admin_mfa_credentials',
      'admin_role_assignments',
      'admin_sessions',
      'customer_insight_entries',
      'customer_insight_runs',
      'knowledge_gap_candidates',
      'knowledge_gap_observations',
      'owner_question_answers',
      'owner_question_digest_entries',
      'owner_question_digests',
      'owner_question_insights',
      'owner_questions',
      'support_escalation_outcomes',
      'support_reply_draft_knowledge',
      'support_reply_drafts',
    ]);
    expect(migrations.rows[0]?.count).toBe(16);
  });

  test('create customizable model policy, usage, and lease schema as migration eleven', async () => {
    const tables = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'model_call_leases', 'model_policy_review_events',
           'model_policy_versions', 'model_usage_windows'
         )
       order by table_name`,
      [schema],
    );
    const policyColumns = await pool.query<{
      readonly column_default: string | null;
      readonly column_name: string;
    }>(
      `select column_name, column_default
       from information_schema.columns
       where table_schema = $1
         and table_name = 'model_policy_versions'
         and column_name in (
           'per_contact_15_minute_calls', 'per_contact_24_hour_calls',
           'global_utc_day_calls', 'concurrent_calls', 'queue_capacity',
           'total_timeout_ms', 'output_tokens', 'cooldown_ms',
           'faq_minimum_similarity', 'faq_ambiguity_margin',
           'maximum_faq_candidates', 'approved_provider_attempts',
           'architecture_provider_ceiling'
         )
       order by column_name`,
      [schema],
    );
    const prohibitedColumns = await pool.query<{ readonly column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name in (
           'model_call_leases', 'model_policy_review_events',
           'model_policy_versions', 'model_usage_windows'
         )
         and column_name in (
           'prompt', 'request_body', 'response', 'response_body',
           'provider', 'provider_name', 'api_key', 'access_token'
         )`,
      [schema],
    );
    const migrations = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from pgmigrations`,
    );

    expect(tables.rows).toEqual([
      { table_name: 'model_call_leases' },
      { table_name: 'model_policy_review_events' },
      { table_name: 'model_policy_versions' },
      { table_name: 'model_usage_windows' },
    ]);
    expect(policyColumns.rows).toHaveLength(13);
    expect(policyColumns.rows.every(({ column_default }) => column_default === null)).toBe(true);
    expect(prohibitedColumns.rows).toEqual([]);
    expect(migrations.rows[0]?.count).toBe(16);
  });

  test('create the closed outbound messaging schema as migration twelve', async () => {
    const tables = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'outbound_attempts', 'outbound_echo_correlation_holds',
           'outbound_escalation_outcomes', 'outbound_intents',
           'outbound_policy_review_events', 'outbound_policy_versions',
           'outbound_rate_windows', 'outbound_status_events',
           'outbound_template_review_events', 'outbound_template_versions'
         )
       order by table_name`,
      [schema],
    );
    const policyColumns = await pool.query<{
      readonly column_default: string | null;
      readonly column_name: string;
    }>(
      `select column_name, column_default
       from information_schema.columns
       where table_schema = $1
         and table_name = 'outbound_policy_versions'
         and column_name in (
           'per_contact_15_minute', 'per_contact_24_hour',
           'whatsapp_account_1_minute', 'messenger_account_1_minute',
           'global_1_minute', 'global_utc_day', 'worker_batch_size',
           'lease_ms', 'provider_timeout_ms', 'maximum_definite_retries',
           'retry_base_ms', 'retry_maximum_ms'
         )
       order by column_name`,
      [schema],
    );
    const prohibitedColumns = await pool.query<{ readonly column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name in (
           'outbound_attempts', 'outbound_echo_correlation_holds',
           'outbound_escalation_outcomes', 'outbound_intents',
           'outbound_policy_review_events', 'outbound_policy_versions',
           'outbound_rate_windows', 'outbound_status_events',
           'outbound_template_review_events', 'outbound_template_versions'
         )
         and column_name in (
           'payload', 'request_body', 'response_body', 'token',
           'authorization', 'external_contact_id', 'message_text'
         )`,
      [schema],
    );
    const migrations = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from pgmigrations`,
    );

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'outbound_attempts',
      'outbound_echo_correlation_holds',
      'outbound_escalation_outcomes',
      'outbound_intents',
      'outbound_policy_review_events',
      'outbound_policy_versions',
      'outbound_rate_windows',
      'outbound_status_events',
      'outbound_template_review_events',
      'outbound_template_versions',
    ]);
    expect(policyColumns.rows).toHaveLength(12);
    expect(policyColumns.rows.every(({ column_default }) => column_default === null)).toBe(true);
    expect(prohibitedColumns.rows).toEqual([]);
    expect(migrations.rows[0]?.count).toBe(16);
  });

  test('enforce outbound source, state, correlation, and append-only evidence constraints', async () => {
    const account = await pool.query<{ readonly id: string }>(
      `insert into admin_accounts
         (account_ref, login_name, password_algorithm, password_cost,
          password_block_size, password_parallelization, password_key_length,
          password_salt, password_hash, state, created_at, updated_at,
          password_changed_at)
       values ('ADMIN_TEST_outbound_schema', 'synthetic.outbound.schema',
               'scrypt_v1', 16384, 8, 1, 32, $1, $2, 'active',
               '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z',
               '2026-09-15T00:00:00Z')
       returning id`,
      [Buffer.alloc(16, 0x61), Buffer.alloc(32, 0x62)],
    );
    const accountId = account.rows[0]?.id;
    try {
      const invalidPolicyState = await captureRolledBackMutation(
        `insert into outbound_policy_versions
           (policy_ref, version_number, request_key,
            per_contact_15_minute, per_contact_24_hour,
            whatsapp_account_1_minute, messenger_account_1_minute,
            global_1_minute, global_utc_day, worker_batch_size, lease_ms,
            provider_timeout_ms, maximum_definite_retries,
            retry_base_ms, retry_maximum_ms, state,
            created_by_account_id, created_at)
         values ('POLICY_TEST_outbound_invalid', 99,
                 'REQUEST_TEST_outbound_policy_invalid',
                 4, 40, 100, 100, 150, 1000, 20, 30000,
                 10000, 3, 1000, 60000, 'enabled', $1,
                 '2026-09-15T00:01:00Z')`,
        [accountId],
      );
      expect(invalidPolicyState).toEqual(expect.objectContaining({ code: '23514' }));

      const policy = await pool.query<{ readonly id: string }>(
        `insert into outbound_policy_versions
           (policy_ref, version_number, request_key,
            per_contact_15_minute, per_contact_24_hour,
            whatsapp_account_1_minute, messenger_account_1_minute,
            global_1_minute, global_utc_day, worker_batch_size, lease_ms,
            provider_timeout_ms, maximum_definite_retries,
            retry_base_ms, retry_maximum_ms, state,
            created_by_account_id, created_at)
         values ('POLICY_TEST_outbound_schema', 1,
                 'REQUEST_TEST_outbound_policy_schema',
                 4, 40, 100, 100, 150, 1000, 20, 30000,
                 10000, 3, 1000, 60000, 'draft', $1,
                 '2026-09-15T00:01:00Z')
         returning id`,
        [accountId],
      );
      const policyId = policy.rows[0]?.id;
      const policyReview = await pool.query<{ readonly id: string }>(
        `insert into outbound_policy_review_events
           (policy_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1, 'submit', $2, 'ready_for_review',
                 'REQUEST_TEST_outbound_policy_submit',
                 '2026-09-15T00:02:00Z')
         returning id`,
        [policyId, accountId],
      );
      const policyHistoryMutation = await captureRolledBackMutation(
        `update outbound_policy_review_events
         set reason_code = 'changed'
         where id = $1`,
        [policyReview.rows[0]?.id],
      );
      expect(policyHistoryMutation).toEqual(expect.objectContaining({ code: '23514' }));

      const template = await pool.query<{ readonly id: string }>(
        `insert into outbound_template_versions
           (template_ref, version_number, request_key, channel,
            channel_account_id, provider_template_id, template_name, locale,
            category, variable_count, content_sha256, state,
            created_by_account_id, created_at)
         values ('TEMPLATE_TEST_outbound_schema', 1,
                 'REQUEST_TEST_outbound_template_schema', 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'META_TEMPLATE_TEST_1',
                 'synthetic_support_template', 'en_US', 'customer_support',
                 0, $1, 'draft', $2, '2026-09-15T00:01:00Z')
         returning id`,
        ['1'.repeat(64), accountId],
      );
      const templateId = template.rows[0]?.id;
      const source = await insertSyntheticAppliedCustomerEvent(pool, {
        fixtureKey: 'outbound-schema-source',
        identity: {
          channel: 'whatsapp',
          channelAccountId: 'PHONE_TEST_outbound_schema',
          externalContactId: 'WA_TEST_outbound_schema',
        },
        messageText: 'Synthetic outbound schema customer question.',
        occurredAt: new Date('2026-09-15T00:03:00.000Z'),
      });
      const identity = await pool.query<{ readonly channel_identity_id: string }>(
        `select channel_identity_id
         from conversations
         where id = $1`,
        [source.conversationId],
      );
      const identityId = identity.rows[0]?.channel_identity_id;
      const draft = await pool.query<{ readonly id: string }>(
        `insert into support_reply_drafts
           (draft_ref, source_webhook_event_id, conversation_id, decision_type,
            language, answer_text, state, retention_deadline, request_key, created_at)
         values ('DRAFT_TEST_outbound_schema', $1, $2, 'safe_failure',
                 'en', 'Synthetic safe outbound response.', 'ready',
                 '2026-09-20T00:00:00Z', 'REQUEST_TEST_outbound_draft_schema',
                 '2026-09-15T00:04:00Z')
         returning id`,
        [source.eventId, source.conversationId],
      );
      const draftId = draft.rows[0]?.id;

      const crossSourceIntent = await captureRolledBackMutation(
        `insert into outbound_intents
           (intent_ref, request_key, reply_draft_id, template_version_id,
            conversation_id, channel_identity_id, policy_version_id,
            channel, channel_account_id, purpose, message_kind, state,
            next_attempt_at, retention_deadline, created_at, updated_at)
         values ('INTENT_TEST_cross_source', 'REQUEST_TEST_cross_source',
                 $1, $2, $3, $4, $5, 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'customer_support',
                 'support_text', 'pending', '2026-09-15T00:05:00Z',
                 '2026-09-20T00:00:00Z', '2026-09-15T00:05:00Z',
                 '2026-09-15T00:05:00Z')`,
        [draftId, templateId, source.conversationId, identityId, policyId],
      );
      expect(crossSourceIntent).toEqual(expect.objectContaining({ code: '23514' }));
      const mismatchedIdentityIntent = await captureRolledBackMutation(
        `insert into outbound_intents
           (intent_ref, request_key, reply_draft_id, conversation_id,
            channel_identity_id, policy_version_id, channel,
            channel_account_id, purpose, message_kind, state,
            next_attempt_at, retention_deadline, created_at, updated_at)
         values ('INTENT_TEST_wrong_account', 'REQUEST_TEST_wrong_account',
                 $1, $2, $3, $4, 'whatsapp', 'PHONE_TEST_wrong_account',
                 'customer_support', 'support_text', 'pending',
                 '2026-09-15T00:05:00Z', '2026-09-20T00:00:00Z',
                 '2026-09-15T00:05:00Z', '2026-09-15T00:05:00Z')`,
        [draftId, source.conversationId, identityId, policyId],
      );
      expect(mismatchedIdentityIntent).toEqual(expect.objectContaining({ code: '23514' }));

      const intent = await pool.query<{ readonly id: string }>(
        `insert into outbound_intents
           (intent_ref, request_key, reply_draft_id, conversation_id,
            channel_identity_id, policy_version_id, channel,
            channel_account_id, purpose, message_kind, state,
            next_attempt_at, retention_deadline, created_at, updated_at)
         values ('INTENT_TEST_outbound_schema', 'REQUEST_TEST_outbound_intent_schema',
                 $1, $2, $3, $4, 'whatsapp', 'PHONE_TEST_outbound_schema',
                 'customer_support', 'support_text', 'pending',
                 '2026-09-15T00:05:00Z', '2026-09-20T00:00:00Z',
                 '2026-09-15T00:05:00Z', '2026-09-15T00:05:00Z')
         returning id`,
        [draftId, source.conversationId, identityId, policyId],
      );
      const intentId = intent.rows[0]?.id;
      const duplicateDraftIntent = await captureRolledBackMutation(
        `insert into outbound_intents
           (intent_ref, request_key, reply_draft_id, conversation_id,
            channel_identity_id, policy_version_id, channel,
            channel_account_id, purpose, message_kind, state,
            next_attempt_at, retention_deadline, created_at, updated_at)
         values ('INTENT_TEST_duplicate_draft', 'REQUEST_TEST_duplicate_draft',
                 $1, $2, $3, $4, 'whatsapp', 'PHONE_TEST_outbound_schema',
                 'customer_support', 'support_text', 'pending',
                 '2026-09-15T00:05:00Z', '2026-09-20T00:00:00Z',
                 '2026-09-15T00:05:00Z', '2026-09-15T00:05:00Z')`,
        [draftId, source.conversationId, identityId, policyId],
      );
      expect(duplicateDraftIntent).toEqual(expect.objectContaining({ code: '23505' }));

      const dispatchWithoutStart = await captureRolledBackMutation(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            authorized_at)
         values ($1, 1, 'ATTEMPT_TEST_missing_start', $2,
                 'RATE_TEST_missing_start', 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'dispatch_started',
                 '2026-09-15T00:06:00Z')`,
        [intentId, policyId],
      );
      const acceptedWithoutProviderId = await captureRolledBackMutation(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            outcome_code, authorized_at, dispatch_started_at,
            provider_accepted_at, finished_at)
         values ($1, 1, 'ATTEMPT_TEST_missing_provider', $2,
                 'RATE_TEST_missing_provider', 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'provider_accepted',
                 'provider_accepted', '2026-09-15T00:06:00Z',
                 '2026-09-15T00:06:01Z', '2026-09-15T00:06:02Z',
                 '2026-09-15T00:06:02Z')`,
        [intentId, policyId],
      );
      const terminalWithoutFinish = await captureRolledBackMutation(
        `insert into outbound_intents
           (intent_ref, request_key, template_version_id, conversation_id,
            channel_identity_id, policy_version_id, channel,
            channel_account_id, purpose, message_kind, state,
            retention_deadline, terminal_reason, created_at, updated_at)
         values ('INTENT_TEST_missing_finish', 'REQUEST_TEST_missing_finish',
                 $1, $2, $3, $4, 'whatsapp', 'PHONE_TEST_outbound_schema',
                 'customer_support', 'fixed_template', 'terminal_failed',
                 '2026-09-20T00:00:00Z', 'provider_rejected',
                 '2026-09-15T00:05:00Z', '2026-09-15T00:05:00Z')`,
        [templateId, source.conversationId, identityId, policyId],
      );
      expect([dispatchWithoutStart, acceptedWithoutProviderId, terminalWithoutFinish]).toEqual([
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
      ]);

      const attempt = await pool.query<{ readonly id: string }>(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            provider_message_id, outcome_code, authorized_at,
            dispatch_started_at, provider_accepted_at, finished_at)
         values ($1, 1, 'ATTEMPT_TEST_outbound_schema', $2,
                 'RATE_TEST_outbound_schema', 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'provider_accepted',
                 'wamid.TEST.outbound.schema', 'provider_accepted',
                 '2026-09-15T00:06:00Z', '2026-09-15T00:06:01Z',
                 '2026-09-15T00:06:02Z', '2026-09-15T00:06:02Z')
         returning id`,
        [intentId, policyId],
      );
      const attemptId = attempt.rows[0]?.id;
      const acceptedAttemptMutation = await captureRolledBackMutation(
        `update outbound_attempts
         set provider_message_id = 'wamid.TEST.outbound.changed'
         where id = $1`,
        [attemptId],
      );
      expect(acceptedAttemptMutation).toEqual(expect.objectContaining({ code: '23514' }));
      const duplicateProviderMessage = await captureRolledBackMutation(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            provider_message_id, outcome_code, authorized_at,
            dispatch_started_at, provider_accepted_at, finished_at)
         values ($1, 2, 'ATTEMPT_TEST_duplicate_provider', $2,
                 'RATE_TEST_duplicate_provider', 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'provider_accepted',
                 'wamid.TEST.outbound.schema', 'provider_accepted',
                 '2026-09-15T00:07:00Z', '2026-09-15T00:07:01Z',
                 '2026-09-15T00:07:02Z', '2026-09-15T00:07:02Z')`,
        [intentId, policyId],
      );
      expect(duplicateProviderMessage).toEqual(expect.objectContaining({ code: '23505' }));

      const statusEventId = await insertSyntheticPendingEvent(pool, {
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST_outbound_schema',
        eventKind: 'message_status',
        externalMessageId: 'wamid.TEST.outbound.schema',
        fixtureKey: 'outbound-schema-status',
        messageStatus: 'delivered',
        occurredAt: new Date('2026-09-15T00:08:00.000Z'),
      });
      const status = await pool.query<{ readonly id: string }>(
        `insert into outbound_status_events
           (webhook_event_id, intent_id, attempt_id, status, provider_occurred_at)
         values ($1, $2, $3, 'delivered', '2026-09-15T00:08:00Z')
         returning id`,
        [statusEventId, intentId, attemptId],
      );
      const statusMutation = await captureRolledBackMutation(
        `update outbound_status_events set status = 'read' where id = $1`,
        [status.rows[0]?.id],
      );
      expect(statusMutation).toEqual(expect.objectContaining({ code: '23514' }));

      const invalidHold = await captureRolledBackMutation(
        `insert into outbound_echo_correlation_holds
           (hold_ref, conversation_id, attempt_id, state, created_at, expires_at)
         values ('HOLD_TEST_accepted_attempt', $1, $2, 'open',
                 '2026-09-15T00:06:01Z', '2026-09-15T00:11:01Z')`,
        [source.conversationId, attemptId],
      );
      expect(invalidHold).toEqual(expect.objectContaining({ code: '23514' }));
      const dispatchAttempt = await pool.query<{ readonly id: string }>(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            authorized_at, dispatch_started_at)
         values ($1, 2, 'ATTEMPT_TEST_outbound_dispatch', $2,
                 'RATE_TEST_outbound_dispatch', 'whatsapp',
                 'PHONE_TEST_outbound_schema', 'dispatch_started',
                 '2026-09-15T00:09:00Z', '2026-09-15T00:09:01Z')
         returning id`,
        [intentId, policyId],
      );
      const hold = await pool.query<{ readonly id: string }>(
        `insert into outbound_echo_correlation_holds
           (hold_ref, conversation_id, attempt_id, state, created_at, expires_at)
         values ('HOLD_TEST_outbound_schema', $1, $2, 'open',
                 '2026-09-15T00:09:01Z', '2026-09-15T00:14:01Z')
         returning id`,
        [source.conversationId, dispatchAttempt.rows[0]?.id],
      );
      const holdDelete = await captureRolledBackMutation(
        `delete from outbound_echo_correlation_holds where id = $1`,
        [hold.rows[0]?.id],
      );
      expect(holdDelete).toEqual(expect.objectContaining({ code: '23514' }));
    } finally {
      await pool.query(`
        truncate table admin_accounts, webhook_receipts, contacts
        restart identity cascade
      `);
    }
  });

  test('refuse populated outbound downgrade, then cleanly down and reapply migration twelve', async () => {
    const account = await pool.query<{ readonly id: string }>(
      `insert into admin_accounts
         (account_ref, login_name, password_algorithm, password_cost,
          password_block_size, password_parallelization, password_key_length,
          password_salt, password_hash, state, created_at, updated_at,
          password_changed_at)
       values ('ADMIN_TEST_outbound_down', 'synthetic.outbound.down',
               'scrypt_v1', 16384, 8, 1, 32, $1, $2, 'active',
               '2026-09-15T01:00:00Z', '2026-09-15T01:00:00Z',
               '2026-09-15T01:00:00Z')
       returning id`,
      [Buffer.alloc(16, 0x63), Buffer.alloc(32, 0x64)],
    );
    await pool.query(
      `insert into outbound_policy_versions
         (policy_ref, version_number, request_key,
          per_contact_15_minute, per_contact_24_hour,
          whatsapp_account_1_minute, messenger_account_1_minute,
          global_1_minute, global_utc_day, worker_batch_size, lease_ms,
          provider_timeout_ms, maximum_definite_retries,
          retry_base_ms, retry_maximum_ms, state,
          created_by_account_id, created_at)
       values ('POLICY_TEST_outbound_down', 1, 'REQUEST_TEST_outbound_policy_down',
               4, 40, 100, 100, 150, 1000, 20, 30000,
               10000, 3, 1000, 60000, 'draft', $1,
               '2026-09-15T01:01:00Z')`,
      [account.rows[0]?.id],
    );

    let rollbackError: unknown;
    try {
      await migrateDownThrough(12);
    } catch (error: unknown) {
      rollbackError = error;
    }
    expect(rollbackError).toBeInstanceOf(Error);
    if (!(rollbackError instanceof Error)) {
      throw new Error('Expected populated outbound rollback to fail');
    }
    expect(rollbackError.message).toContain('P5-001 rollback blocked');
    expect((rollbackError as Error & { code?: string }).code).toBe('55000');
    await expect(
      pool.query(`select count(*)::int as count from pgmigrations`),
    ).resolves.toMatchObject({ rows: [{ count: 16 }] });

    await pool.query(`truncate table outbound_policy_versions restart identity cascade`);
    await migrateDownThrough(12);
    await expect(
      pool.query(`select to_regclass('outbound_policy_versions') as table_name`),
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });
    await runMigrations('up');
    await pool.query(`truncate table admin_accounts restart identity cascade`);
  });

  test('enforce model policy bounds, reviewed transitions, and append-only history', async () => {
    const account = await pool.query<{ readonly id: string }>(
      `insert into admin_accounts
         (account_ref, login_name, password_algorithm, password_cost,
          password_block_size, password_parallelization, password_key_length,
          password_salt, password_hash, state, created_at, updated_at,
          password_changed_at)
       values ('ADMIN_TEST_model_schema', 'synthetic.model.schema', 'scrypt_v1', 16384,
               8, 1, 32, $1, $2, 'active',
               '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z',
               '2026-09-13T00:00:00Z')
       returning id`,
      [Buffer.alloc(16, 0x51), Buffer.alloc(32, 0x52)],
    );
    const accountId = account.rows[0]?.id;
    try {
      const invalidPolicy = await captureRolledBackMutation(
        `insert into model_policy_versions
           (policy_ref, version_number, request_key, state,
            per_contact_15_minute_calls, per_contact_24_hour_calls,
            global_utc_day_calls, concurrent_calls, queue_capacity,
            total_timeout_ms, output_tokens, cooldown_ms,
            faq_minimum_similarity, faq_ambiguity_margin,
            maximum_faq_candidates, approved_provider_attempts,
            architecture_provider_ceiling, created_by_account_id, created_at)
         values ('POLICY_TEST_invalid', 1, 'REQUEST_TEST_policy_invalid', 'draft',
                 3, 20, 300, 4, 25, 20000, 600, 1000,
                 0.70, 0.05, 10, 4, 3, $1, '2026-09-13T00:01:00Z')`,
        [accountId],
      );
      expect(invalidPolicy).toEqual(expect.objectContaining({ code: '23514' }));

      const policy = await pool.query<{ readonly id: string }>(
        `insert into model_policy_versions
           (policy_ref, version_number, request_key, state,
            per_contact_15_minute_calls, per_contact_24_hour_calls,
            global_utc_day_calls, concurrent_calls, queue_capacity,
            total_timeout_ms, output_tokens, cooldown_ms,
            faq_minimum_similarity, faq_ambiguity_margin,
            maximum_faq_candidates, approved_provider_attempts,
            architecture_provider_ceiling, created_by_account_id, created_at)
         values ('POLICY_TEST_schema', 1, 'REQUEST_TEST_policy_schema', 'draft',
                 3, 20, 300, 4, 25, 20000, 600, 1000,
                 0.70, 0.05, 10, 3, 5, $1, '2026-09-13T00:01:00Z')
         returning id`,
        [accountId],
      );
      const policyId = policy.rows[0]?.id;
      const directMutation = await captureRolledBackMutation(
        `update model_policy_versions set total_timeout_ms = 25000 where id = $1`,
        [policyId],
      );
      expect(directMutation).toEqual(expect.objectContaining({ code: '23514' }));

      const submit = await pool.query<{ readonly id: string }>(
        `insert into model_policy_review_events
           (policy_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1, 'submit', $2, 'ready_for_review',
                 'REQUEST_TEST_policy_submit', '2026-09-13T00:02:00Z')
         returning id`,
        [policyId, accountId],
      );
      await pool.query(
        `insert into model_policy_review_events
           (policy_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1, 'approve', $2, 'limits_reviewed',
                 'REQUEST_TEST_policy_approve', '2026-09-13T00:03:00Z')`,
        [policyId, accountId],
      );
      await pool.query(
        `insert into model_policy_review_events
           (policy_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1, 'activate', $2, 'approved_activation',
                 'REQUEST_TEST_policy_activate', '2026-09-13T00:04:00Z')`,
        [policyId, accountId],
      );
      await expect(
        pool.query(
          `select state, approved_by_account_id, approved_at, activated_at
           from model_policy_versions where id = $1`,
          [policyId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            activated_at: new Date('2026-09-13T00:04:00Z'),
            approved_at: new Date('2026-09-13T00:03:00Z'),
            approved_by_account_id: accountId,
            state: 'active',
          },
        ],
      });

      const eventMutation = await captureRolledBackMutation(
        `update model_policy_review_events set reason_code = 'changed' where id = $1`,
        [submit.rows[0]?.id],
      );
      const invalidWindow = await captureRolledBackMutation(
        `insert into model_usage_windows
           (policy_version_id, window_kind, contact_scope_key,
            window_started_at, window_ended_at, call_count, expires_at)
         values ($1, 'contact_15_minute', null,
                 '2026-09-13T00:00:00Z', '2026-09-13T00:15:00Z', 1,
                 '2026-09-14T00:15:00Z')`,
        [policyId],
      );
      expect([eventMutation, invalidWindow]).toEqual([
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
      ]);
    } finally {
      await pool.query(`
        truncate table
          model_call_leases, model_usage_windows,
          model_policy_review_events, model_policy_versions,
          admin_accounts
        restart identity cascade
      `);
    }
  });

  test('refuse populated model-policy downgrade, then cleanly down and reapply migration eleven', async () => {
    const account = await pool.query<{ readonly id: string }>(
      `insert into admin_accounts
         (account_ref, login_name, password_algorithm, password_cost,
          password_block_size, password_parallelization, password_key_length,
          password_salt, password_hash, state, created_at, updated_at,
          password_changed_at)
       values ('ADMIN_TEST_model_down', 'synthetic.model.down', 'scrypt_v1', 16384,
               8, 1, 32, $1, $2, 'active',
               '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z',
               '2026-09-13T00:00:00Z')
       returning id`,
      [Buffer.alloc(16, 0x53), Buffer.alloc(32, 0x54)],
    );
    await pool.query(
      `insert into model_policy_versions
         (policy_ref, version_number, request_key, state,
          per_contact_15_minute_calls, per_contact_24_hour_calls,
          global_utc_day_calls, concurrent_calls, queue_capacity,
          total_timeout_ms, output_tokens, cooldown_ms,
          faq_minimum_similarity, faq_ambiguity_margin,
          maximum_faq_candidates, approved_provider_attempts,
          architecture_provider_ceiling, created_by_account_id, created_at)
       values ('POLICY_TEST_down', 1, 'REQUEST_TEST_policy_down', 'draft',
               3, 20, 300, 4, 25, 20000, 600, 1000,
               0.70, 0.05, 10, 3, 5, $1, '2026-09-13T00:01:00Z')`,
      [account.rows[0]?.id],
    );

    let rollbackError: unknown;
    try {
      await migrateDownThrough(11);
    } catch (error: unknown) {
      rollbackError = error;
    }
    expect(rollbackError).toBeInstanceOf(Error);
    if (!(rollbackError instanceof Error)) {
      throw new Error('Expected populated model policy rollback to fail');
    }
    expect(rollbackError.message).toContain('P4-005 rollback blocked');
    expect((rollbackError as Error & { code?: string }).code).toBe('55000');
    await expect(
      pool.query(`select count(*)::int as count from pgmigrations`),
    ).resolves.toMatchObject({ rows: [{ count: 16 }] });

    await pool.query(`truncate table model_policy_versions restart identity cascade`);
    await migrateDownThrough(11);
    await expect(
      pool.query(`select to_regclass('model_policy_versions') as table_name`),
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });
    await runMigrations('up');
    await pool.query(`truncate table admin_accounts restart identity cascade`);
  });

  test('exclude plaintext admin credentials and enforce closed append-only evidence', async () => {
    const prohibitedColumns = await pool.query<{ readonly column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name in (
           'admin_accounts', 'admin_mfa_credentials', 'admin_sessions'
         )
         and column_name in (
           'password', 'password_plaintext', 'session_token',
           'mfa_seed', 'totp_secret', 'recovery_code'
         )
       order by column_name`,
      [schema],
    );
    const unrestrictedColumns = await pool.query<{ readonly column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name in (
           'admin_accounts', 'admin_audit_events', 'knowledge_gap_observations',
           'customer_insight_entries', 'owner_questions',
           'support_reply_drafts', 'support_escalation_outcomes'
         )
         and data_type in ('json', 'jsonb')`,
      [schema],
    );
    expect(prohibitedColumns.rows).toEqual([]);
    expect(unrestrictedColumns.rows).toEqual([]);

    try {
      const account = await pool.query<{ readonly id: string }>(
        `insert into admin_accounts
           (account_ref, login_name, password_algorithm, password_cost,
            password_block_size, password_parallelization, password_key_length,
            password_salt, password_hash, state, created_at, updated_at,
            password_changed_at)
         values ('ADMIN_TEST_schema', 'synthetic.schema', 'scrypt_v1', 16384,
                 8, 1, 32, $1, $2, 'active',
                 '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z',
                 '2026-09-01T12:00:00Z')
         returning id`,
        [Buffer.alloc(16, 0x31), Buffer.alloc(32, 0x32)],
      );
      const accountId = account.rows[0]?.id;
      const role = await pool.query<{ readonly id: string }>(
        `insert into admin_role_assignments
           (account_id, role, action, actor_account_id, effective_at, request_key)
         values ($1, 'knowledge_editor', 'assign', $1,
                 '2026-09-01T12:01:00Z', 'REQUEST_TEST_schema_role')
         returning id`,
        [accountId],
      );
      const audit = await pool.query<{ readonly id: string }>(
        `insert into admin_audit_events
           (actor_account_id, action, result, object_type, object_ref,
            reason_code, request_key, effective_at)
         values ($1, 'role_assigned', 'applied', 'account',
                 'ADMIN_TEST_schema', 'authorized_assignment',
                 'REQUEST_TEST_schema_audit', '2026-09-01T12:01:00Z')
         returning id`,
        [accountId],
      );

      const invalidRole = await captureRolledBackMutation(
        `insert into admin_role_assignments
           (account_id, role, action, actor_account_id, effective_at, request_key)
         values ($1, 'unbounded_role', 'assign', $1,
                 '2026-09-01T12:02:00Z', 'REQUEST_TEST_schema_invalid_role')`,
        [accountId],
      );
      const roleMutation = await captureRolledBackMutation(
        `update admin_role_assignments set role = 'administrator' where id = $1`,
        [role.rows[0]?.id],
      );
      const auditMutation = await captureRolledBackMutation(
        `delete from admin_audit_events where id = $1`,
        [audit.rows[0]?.id],
      );
      const oversizedDigest = await captureRolledBackMutation(
        `insert into owner_question_digests
           (digest_ref, state, period_started_at, period_ended_at,
            question_count, request_key, created_at)
         values ('DIGEST_TEST_oversized', 'ready',
                 '2026-09-01T00:00:00Z', '2026-09-04T00:00:00Z',
                 6, 'REQUEST_TEST_digest_oversized', '2026-09-04T00:00:00Z')`,
      );

      expect([invalidRole, roleMutation, auditMutation, oversizedDigest]).toEqual([
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
      ]);
    } finally {
      await pool.query(`truncate table admin_accounts restart identity cascade`);
    }
  });

  test('refuse admin and learning downgrade while Phase 4 evidence exists', async () => {
    await pool.query(
      `insert into admin_accounts
         (account_ref, login_name, password_algorithm, password_cost,
          password_block_size, password_parallelization, password_key_length,
          password_salt, password_hash, state, created_at, updated_at,
          password_changed_at)
       values ('ADMIN_TEST_downgrade', 'synthetic.downgrade', 'scrypt_v1', 16384,
               8, 1, 32, $1, $2, 'active',
               '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z',
               '2026-09-01T12:00:00Z')`,
      [Buffer.alloc(16, 0x41), Buffer.alloc(32, 0x42)],
    );

    let rollbackError: unknown;
    try {
      await migrateDownThrough(10);
    } catch (error: unknown) {
      rollbackError = error;
    }
    expect(rollbackError).toBeInstanceOf(Error);
    if (!(rollbackError instanceof Error)) {
      throw new Error('Expected populated Phase 4 admin rollback to fail');
    }
    expect(rollbackError.message).toContain('P4-002 rollback blocked');
    expect((rollbackError as Error & { code?: string }).code).toBe('55000');
    await expect(
      pool.query(`select count(*)::int as count from pgmigrations`),
    ).resolves.toMatchObject({ rows: [{ count: 16 }] });

    await pool.query(`truncate table admin_accounts restart identity cascade`);
    await migrateDownThrough(10);
    await expect(
      pool.query(`select to_regclass('admin_accounts') as table_name`),
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });
    await runMigrations('up');
  });

  test('enforce bilingual knowledge shape and append-only reviewed history', async () => {
    try {
      const source = await pool.query<{ readonly id: string }>(
        `insert into knowledge_sources
           (source_ref, source_type, label, created_by_reference, created_at, updated_at)
         values ('SOURCE_TEST_catalog', 'manual_business', 'Synthetic catalog source',
                 'ADMIN_TEST_author', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')
         returning id`,
      );
      const item = await pool.query<{ readonly id: string }>(
        `insert into knowledge_items (item_key, kind, created_at, updated_at)
         values ('faq.synthetic.catalog', 'faq',
                 '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')
         returning id`,
      );
      const invalidBilingualVersion = await captureRolledBackMutation(
        `insert into knowledge_versions
           (version_ref, item_id, version_number, request_key, state,
            question_en, answer_en, question_bn, answer_bn,
            source_id, source_sha256, content_sha256, author_reference, created_at)
         values ('VERSION_TEST_incomplete', $1, 1, 'REQUEST_TEST_incomplete', 'draft',
                 'Synthetic English question?', 'Synthetic English answer.',
                 null, null, $2, $3, $4, 'ADMIN_TEST_author',
                 '2026-09-01T10:01:00Z')`,
        [item.rows[0]?.id, source.rows[0]?.id, 'a'.repeat(64), 'b'.repeat(64)],
      );
      expect(invalidBilingualVersion).toEqual(expect.objectContaining({ code: '23514' }));

      const version = await pool.query<{ readonly id: string }>(
        `insert into knowledge_versions
           (version_ref, item_id, version_number, request_key, state,
            question_en, answer_en, question_bn, answer_bn,
            source_id, source_sha256, content_sha256, author_reference, created_at)
         values ('VERSION_TEST_complete', $1, 1, 'REQUEST_TEST_complete', 'draft',
                 'Synthetic English question?', 'Synthetic English answer.',
                 'সিনথেটিক বাংলা প্রশ্ন?', 'সিনথেটিক বাংলা উত্তর।',
                 $2, $3, $4, 'ADMIN_TEST_author', '2026-09-01T10:01:00Z')
         returning id`,
        [item.rows[0]?.id, source.rows[0]?.id, 'c'.repeat(64), 'd'.repeat(64)],
      );
      await pool.query(
        `insert into knowledge_aliases
           (version_id, language, alias_kind, phrase, normalized_phrase)
         values ($1, 'en', 'alias', 'Synthetic alias', 'synthetic alias')`,
        [version.rows[0]?.id],
      );

      const directStateMutation = await captureRolledBackMutation(
        `update knowledge_versions
         set state = 'submitted', submitted_at = '2026-09-01T10:02:00Z'
         where id = $1`,
        [version.rows[0]?.id],
      );
      expect(directStateMutation).toEqual(expect.objectContaining({ code: '23514' }));

      const submit = await pool.query<{ readonly id: string }>(
        `insert into knowledge_review_events
           (version_id, action, reviewer_reference, reason_code, request_key, effective_at)
         values ($1, 'submit', 'ADMIN_TEST_author', 'ready_for_review',
                 'REQUEST_TEST_submit', '2026-09-01T10:02:00Z')
         returning id`,
        [version.rows[0]?.id],
      );
      await pool.query(
        `insert into knowledge_review_events
           (version_id, action, reviewer_reference, reason_code, request_key, effective_at)
         values ($1, 'approve', 'ADMIN_TEST_reviewer', 'business_fact_verified',
                 'REQUEST_TEST_approve', '2026-09-01T10:03:00Z')`,
        [version.rows[0]?.id],
      );
      await pool.query(
        `insert into knowledge_publication_events
           (item_id, version_id, action, reviewer_reference, reason_code,
            effective_at, request_key)
         values ($1, $2, 'publish', 'ADMIN_TEST_reviewer', 'initial_publication',
                 '2026-09-01T10:04:00Z', 'REQUEST_TEST_publish')`,
        [item.rows[0]?.id, version.rows[0]?.id],
      );

      const contentMutation = await captureRolledBackMutation(
        `update knowledge_versions set answer_en = 'Synthetic changed answer.' where id = $1`,
        [version.rows[0]?.id],
      );
      const aliasMutation = await captureRolledBackMutation(
        `update knowledge_aliases set phrase = 'Synthetic changed alias' where version_id = $1`,
        [version.rows[0]?.id],
      );
      const reviewMutation = await captureRolledBackMutation(
        `update knowledge_review_events set reason_code = 'changed' where id = $1`,
        [submit.rows[0]?.id],
      );
      const publicationDelete = await captureRolledBackMutation(
        `delete from knowledge_publication_events where request_key = 'REQUEST_TEST_publish'`,
      );

      expect([contentMutation, aliasMutation, reviewMutation, publicationDelete]).toEqual([
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
        expect.objectContaining({ code: '23514' }),
      ]);
      await expect(
        pool.query(`select state from knowledge_versions where id = $1`, [version.rows[0]?.id]),
      ).resolves.toMatchObject({ rows: [{ state: 'approved' }] });
    } finally {
      await pool.query(`
        truncate table
          knowledge_publication_events, knowledge_review_events,
          knowledge_aliases, knowledge_tags, knowledge_versions,
          knowledge_items, knowledge_source_snapshots, knowledge_sources
        restart identity cascade
      `);
    }
  });

  test('refuse knowledge-catalog downgrade while reviewed authority exists', async () => {
    await pool.query(
      `insert into knowledge_sources
         (source_ref, source_type, label, created_by_reference, created_at, updated_at)
       values ('SOURCE_TEST_downgrade', 'policy', 'Synthetic downgrade source',
               'ADMIN_TEST_author', '2026-09-01T11:00:00Z', '2026-09-01T11:00:00Z')`,
    );

    let rollbackError: unknown;
    try {
      await migrateDownThrough(9);
    } catch (error: unknown) {
      rollbackError = error;
    }
    expect(rollbackError).toBeInstanceOf(Error);
    if (!(rollbackError instanceof Error)) {
      throw new Error('Expected populated P4-002 rollback to fail');
    }
    expect(rollbackError.message).toContain('P4-002 rollback blocked');
    expect((rollbackError as Error & { code?: string }).code).toBe('55000');
    await expect(
      pool.query(`select count(*)::int as count from pgmigrations`),
    ).resolves.toMatchObject({ rows: [{ count: 16 }] });

    await pool.query(`truncate table knowledge_sources restart identity cascade`);
    await migrateDownThrough(9);
    await expect(
      pool.query(`select to_regclass('knowledge_sources') as table_name`),
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });
    await runMigrations('up');
  });

  test('create the bounded deletion safety tables as migration four', async () => {
    const tables = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'privacy_deletion_runs',
           'privacy_notification_intents',
           'privacy_request_events',
           'privacy_request_locations',
           'privacy_requests',
           'privacy_suppressions',
           'restore_deletion_gates'
         )
       order by table_name`,
      [schema],
    );
    const migrations = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from pgmigrations`,
    );

    expect(tables.rows).toEqual([
      { table_name: 'privacy_deletion_runs' },
      { table_name: 'privacy_notification_intents' },
      { table_name: 'privacy_request_events' },
      { table_name: 'privacy_request_locations' },
      { table_name: 'privacy_requests' },
      { table_name: 'privacy_suppressions' },
      { table_name: 'restore_deletion_gates' },
    ]);
    expect(migrations.rows[0]?.count).toBe(16);
  });

  test('create the bounded privacy rights workflow tables as migration five', async () => {
    const tables = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'privacy_access_runs',
           'privacy_correction_runs',
           'privacy_marketing_opt_out_runs'
         )
       order by table_name`,
      [schema],
    );
    const columns = await pool.query<{
      readonly column_name: string;
      readonly data_type: string;
      readonly table_name: string;
    }>(
      `select table_name, column_name, data_type
       from information_schema.columns
       where table_schema = $1
         and table_name in (
           'privacy_access_runs',
           'privacy_correction_runs',
           'privacy_marketing_opt_out_runs'
         )
       order by table_name, ordinal_position`,
      [schema],
    );

    expect(tables.rows).toEqual([
      { table_name: 'privacy_access_runs' },
      { table_name: 'privacy_correction_runs' },
      { table_name: 'privacy_marketing_opt_out_runs' },
    ]);
    expect(columns.rows.some(({ data_type }) => /json|bytea/i.test(data_type))).toBe(false);
    expect(columns.rows.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining([
        'customer_data',
        'export',
        'handler_error',
        'identity_hmac',
        'message_text',
        'path',
        'requested_value',
      ]),
    );
  });

  test('enforce append-only privacy workflow evidence and one notification parent', async () => {
    const request = await pool.query<{ readonly id: string }>(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, open_request_key)
       values ('PRIVACY_TEST_workflow_constraints', 'access', 'in_progress',
               '2026-08-31T04:00:00Z', 'privacy-test-workflow-constraints')
       returning id`,
    );
    const requestId = request.rows[0]?.id;
    const accessRun = await pool.query<{ readonly id: string }>(
      `insert into privacy_access_runs
         (request_id, request_key, collected_at, collector_count, record_count, status)
       values ($1, 'privacy-test-access-run', '2026-08-31T04:01:00Z', 5, 12, 'collected')
       returning id`,
      [requestId],
    );
    const correctionRun = await pool.query<{ readonly id: string }>(
      `insert into privacy_correction_runs
         (request_id, request_key, executed_at, field_key, result_code)
       values ($1, 'privacy-test-correction-run', '2026-08-31T04:02:00Z',
               'synthetic_profile_name', 'manual_required')
       returning id`,
      [requestId],
    );
    const optOutRun = await pool.query<{ readonly id: string }>(
      `insert into privacy_marketing_opt_out_runs
         (request_key, effective_at, linked_identities_count,
          category_revocations_count, suppressions_created_count,
          pending_intents_cancelled_count, status)
       values ('privacy-test-opt-out-run', '2026-08-31T04:03:00Z',
               2, 4, 2, 0, 'applied')
       returning id`,
    );

    const immutableErrors = await Promise.all([
      captureRolledBackMutation(`update privacy_access_runs set record_count = 13 where id = $1`, [
        accessRun.rows[0]?.id,
      ]),
      captureRolledBackMutation(`delete from privacy_correction_runs where id = $1`, [
        correctionRun.rows[0]?.id,
      ]),
      captureRolledBackMutation(
        `update privacy_marketing_opt_out_runs
         set linked_identities_count = 3
         where id = $1`,
        [optOutRun.rows[0]?.id],
      ),
    ]);
    expect(immutableErrors).toEqual([
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
    ]);

    const invalidParents = await Promise.all([
      captureRolledBackMutation(
        `insert into privacy_notification_intents
           (request_id, marketing_opt_out_run_id, notification_type,
            state, idempotency_key)
         values ($1, $2, 'operator_marketing_opt_out', 'pending',
                 'privacy-test-notification-both-parents')`,
        [requestId, optOutRun.rows[0]?.id],
      ),
      captureRolledBackMutation(
        `insert into privacy_notification_intents
           (notification_type, state, idempotency_key)
         values ('operator_privacy_request', 'pending',
                 'privacy-test-notification-no-parent')`,
      ),
      captureRolledBackMutation(
        `insert into privacy_notification_intents
           (request_id, notification_type, state, idempotency_key)
         values ($1, 'operator_marketing_opt_out', 'pending',
                 'privacy-test-notification-wrong-parent')`,
        [requestId],
      ),
    ]);
    expect(invalidParents).toEqual([
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
    ]);

    const client = await pool.connect();
    try {
      await client.query('begin');
      await expect(
        client.query(
          `insert into privacy_notification_intents
             (marketing_opt_out_run_id, notification_type, state, idempotency_key)
           values ($1, 'operator_marketing_opt_out', 'pending',
                   'privacy-test-notification-valid-opt-out')`,
          [optOutRun.rows[0]?.id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  test('add closed checklist location evidence and privacy hold audit reason in migration six', async () => {
    const columns = await pool.query<{ readonly column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name = 'privacy_request_events'
         and column_name = 'location_code'`,
      [schema],
    );
    expect(columns.rows).toEqual([{ column_name: 'location_code' }]);

    await expect(
      captureRolledBackMutation(
        `insert into policy_audit_outcomes
           (decision_type, outcome, reason_code, evaluated_at)
         values ('reply_eligibility', 'denied', 'privacy_request_open',
                 '2026-08-31T04:04:00Z')`,
      ),
    ).resolves.toBeUndefined();
    const invalidLocation = await captureRolledBackMutation(
      `insert into privacy_request_events
         (request_id, action, outcome, reason_code, previous_state,
          resulting_state, actor_type, effective_at, request_key, location_code)
       select id, 'location_checked', 'applied', 'location_complete',
              'in_progress', 'in_progress', 'support_reviewer',
              '2026-08-31T04:05:00Z', 'privacy-test-invalid-location',
              'operator-laptop-path'
       from privacy_requests
       where request_ref = 'PRIVACY_TEST_workflow_constraints'`,
    );
    expect(invalidLocation).toMatchObject({ code: '23514' });
  });

  test('add bounded marketing re-opt-in evidence and suppression precedence in migration seven', async () => {
    const table = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name = 'privacy_marketing_reopt_in_runs'`,
      [schema],
    );
    const indexes = await pool.query<{ readonly indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = $1
         and indexname = 'privacy_marketing_opt_out_runs_source_unique'`,
      [schema],
    );
    expect(table.rows).toEqual([{ table_name: 'privacy_marketing_reopt_in_runs' }]);
    expect(indexes.rows).toEqual([{ indexname: 'privacy_marketing_opt_out_runs_source_unique' }]);

    const run = await pool.query<{ readonly id: string }>(
      `insert into privacy_marketing_reopt_in_runs
         (request_key, category_codes, effective_at, scope,
          linked_identities_count, category_grants_count,
          suppressions_cleared_count, reviewer_reference,
          verification_method, status)
       values ('privacy-test-marketing-reopt-in', array['security_updates'],
               '2026-08-31T04:06:00Z', 'source_identity',
               1, 1, 2, 'REVIEWER_TEST_migration',
               'same_channel_context', 'applied')
       returning id`,
    );
    const immutable = await captureRolledBackMutation(
      `update privacy_marketing_reopt_in_runs
       set category_grants_count = 2
       where id = $1`,
      [run.rows[0]?.id],
    );
    expect(immutable).toMatchObject({ code: '23514' });
    const unknownCategory = await captureRolledBackMutation(
      `insert into privacy_marketing_reopt_in_runs
         (request_key, category_codes, effective_at, scope,
          linked_identities_count, category_grants_count,
          suppressions_cleared_count, reviewer_reference,
          verification_method, status)
       values ('privacy-test-marketing-reopt-in-unknown',
               array['unknown_campaign'],
               '2026-08-31T04:06:00Z', 'source_identity',
               1, 1, 1, 'REVIEWER_TEST_migration',
               'same_channel_context', 'applied')`,
    );
    expect(unknownCategory).toMatchObject({ code: '23514' });
    await expect(
      captureRolledBackMutation(
        `insert into policy_audit_outcomes
           (decision_type, outcome, reason_code, evaluated_at)
         values ('marketing_eligibility', 'denied', 'global_marketing_opt_out',
                 '2026-08-31T04:07:00Z')`,
      ),
    ).resolves.toBeUndefined();
  });

  test('permits only privacy-safe suppressed webhook event shapes', async () => {
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 2)
       returning id`,
      ['2'.repeat(64)],
    );
    await expect(
      pool.query(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, occurred_at,
            reason_code, admission_outcome)
         values ($1, $2, 'whatsapp', 'customer_message',
                 '2026-08-31T00:00:00Z', 'deletion_tombstone', 'suppressed')`,
        [receipt.rows[0]?.id, `privacy:TEST_v1:${'3'.repeat(64)}`],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const unsafeSuppressed = await captureRolledBackMutation(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, contact_id,
          occurred_at, reason_code, admission_outcome)
       values ($1, $2, 'whatsapp', 'customer_message', 'CONTACT_TEST_raw',
               '2026-08-31T00:00:00Z', 'deletion_tombstone', 'suppressed')`,
      [receipt.rows[0]?.id, `privacy:TEST_v1:${'4'.repeat(64)}`],
    );
    expect(unsafeSuppressed).toMatchObject({ code: '23514' });
  });

  test('enforce closed deletion request, suppression, and application values', async () => {
    const request = await pool.query<{ readonly id: string }>(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, open_request_key)
       values ('PRIVACY_TEST_bounded', 'deletion', 'received',
               '2026-08-31T00:00:00Z', 'privacy-test-bounded-open')
       returning id`,
    );
    const requestId = request.rows[0]?.id;
    expect(requestId).toBeDefined();

    const invalidType = await captureRolledBackMutation(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, open_request_key)
       values ('PRIVACY_TEST_invalid_type', 'export', 'received',
               '2026-08-31T00:00:00Z', 'privacy-test-invalid-type')`,
    );
    const invalidState = await captureRolledBackMutation(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, open_request_key)
       values ('PRIVACY_TEST_invalid_state', 'deletion', 'auto_approved',
               '2026-08-31T00:00:00Z', 'privacy-test-invalid-state')`,
    );
    const duplicateOpenKey = await captureRolledBackMutation(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, open_request_key)
       values ('PRIVACY_TEST_duplicate_key', 'deletion', 'received',
               '2026-08-31T00:00:00Z', 'privacy-test-bounded-open')`,
    );
    const malformedHmac = await captureRolledBackMutation(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ('raw-customer-identifier', 'messenger', 'deletion_tombstone',
               'customer_deletion', '2026-08-31T00:00:00Z', 'v1')`,
    );
    const rawCategory = await captureRolledBackMutation(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1, 'messenger', 'do_not_contact', 'customer_deletion',
               '2026-08-31T00:00:00Z', 'v1')`,
      ['a'.repeat(64)],
    );

    expect([invalidType, invalidState, malformedHmac, rawCategory]).toEqual([
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
    ]);
    expect(duplicateOpenKey).toMatchObject({ code: '23505' });

    const conversationId = await createSyntheticConversation('privacy-suppression-application');
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 2)
       returning id`,
      ['9'.repeat(64)],
    );
    const firstEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:privacy:suppressed-null', 'messenger',
               'customer_message', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );
    const secondEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:privacy:suppressed-conversation', 'messenger',
               'customer_message', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );
    const nullConversation = await captureRolledBackMutation(
      `insert into webhook_event_applications (webhook_event_id, outcome)
       values ($1, 'identity_suppressed')`,
      [firstEvent.rows[0]?.id],
    );
    const nonnullConversation = await captureRolledBackMutation(
      `insert into webhook_event_applications
         (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'identity_suppressed')`,
      [secondEvent.rows[0]?.id, conversationId],
    );

    expect(nullConversation).toBeUndefined();
    expect(nonnullConversation).toMatchObject({ code: '23514' });
  });

  test('reject evidence mutation, unsafe completion, and nonzero restore passage', async () => {
    const request = await pool.query<{ readonly id: string }>(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, open_request_key)
       values ('PRIVACY_TEST_safety', 'deletion', 'in_progress',
               '2026-08-31T00:00:00Z', 'privacy-test-safety-open')
       returning id`,
    );
    const requestId = request.rows[0]?.id;
    expect(requestId).toBeDefined();
    await pool.query(
      `insert into privacy_request_locations
         (request_id, location_code, required, state)
       values ($1, 'primary_postgres', true, 'pending')`,
      [requestId],
    );
    const event = await pool.query<{ readonly id: string }>(
      `insert into privacy_request_events
         (request_id, action, outcome, reason_code, previous_state,
          resulting_state, actor_type, reviewer_reference, effective_at,
          request_key)
       values ($1, 'reviewer_decision', 'applied', 'customer_confirmed',
               'human_review', 'in_progress', 'support_reviewer',
               'synthetic-reviewer', '2026-08-31T00:05:00Z',
               'privacy-test-safety-review')
       returning id`,
      [requestId],
    );
    const deletionRun = await pool.query<{ readonly id: string }>(
      `insert into privacy_deletion_runs
         (request_id, request_key, executed_at, conversations_processed,
          identities_pseudonymized, messages_cleared, tombstones_created,
          status, completed_at)
       values ($1, 'privacy-test-safety-run', '2026-08-31T00:10:00Z',
               1, 1, 1, 1, 'applied', '2026-08-31T00:11:00Z')
       returning id`,
      [requestId],
    );
    const gate = await pool.query<{ readonly id: string }>(
      `insert into restore_deletion_gates
         (gate_ref, request_key, action, status, evaluated_at, git_revision,
          required_key_versions, identities_processed, remaining_matches,
          completed_at)
       values ('RESTORE_TEST_append_only', 'restore-test-append-only',
               'reapply_batch', 'applied', '2026-08-31T00:15:00Z', $1,
               array['v1'], 1, 1, '2026-08-31T00:16:00Z')
       returning id`,
      ['a'.repeat(40)],
    );

    const completionError = await captureRolledBackMutation(
      `update privacy_requests
       set state = 'completed', completed_at = '2026-08-31T00:20:00Z'
       where id = $1`,
      [requestId],
    );
    expect(completionError).toMatchObject({ code: '23514' });

    const eventUpdate = await captureRolledBackMutation(
      `update privacy_request_events set outcome = 'rejected' where id = $1`,
      [event.rows[0]?.id],
    );
    const eventDelete = await captureRolledBackMutation(
      `delete from privacy_request_events where id = $1`,
      [event.rows[0]?.id],
    );
    const runUpdate = await captureRolledBackMutation(
      `update privacy_deletion_runs set messages_cleared = 0 where id = $1`,
      [deletionRun.rows[0]?.id],
    );
    const runDelete = await captureRolledBackMutation(
      `delete from privacy_deletion_runs where id = $1`,
      [deletionRun.rows[0]?.id],
    );
    const gateUpdate = await captureRolledBackMutation(
      `update restore_deletion_gates set remaining_matches = 0 where id = $1`,
      [gate.rows[0]?.id],
    );
    const gateDelete = await captureRolledBackMutation(
      `delete from restore_deletion_gates where id = $1`,
      [gate.rows[0]?.id],
    );
    for (const mutation of [
      eventUpdate,
      eventDelete,
      runUpdate,
      runDelete,
      gateUpdate,
      gateDelete,
    ]) {
      expect(mutation).toMatchObject({ code: '23514' });
    }

    const unsafePassedGate = await captureRolledBackMutation(
      `insert into restore_deletion_gates
         (gate_ref, request_key, action, status, evaluated_at, git_revision,
          required_key_versions, identities_processed, remaining_matches,
          completed_at)
       values ('RESTORE_TEST_nonzero', 'restore-test-nonzero', 'finalize',
               'passed', '2026-08-31T00:25:00Z', $1, array['v1'], 1, 1,
               '2026-08-31T00:26:00Z')`,
      ['b'.repeat(40)],
    );
    expect(unsafePassedGate).toMatchObject({ code: '23514' });

    await pool.query(
      `insert into restore_deletion_gates
         (gate_ref, request_key, action, status, evaluated_at, git_revision,
          required_key_versions, identities_processed, remaining_matches,
          completed_at)
       values ('RESTORE_TEST_unique_pass', 'restore-test-unique-pass-1',
               'finalize', 'passed', '2026-08-31T00:30:00Z', $1,
               array['v1'], 1, 0, '2026-08-31T00:31:00Z')`,
      ['c'.repeat(40)],
    );
    const duplicatePassedGate = await captureRolledBackMutation(
      `insert into restore_deletion_gates
         (gate_ref, request_key, action, status, evaluated_at, git_revision,
          required_key_versions, identities_processed, remaining_matches,
          completed_at)
       values ('RESTORE_TEST_unique_pass', 'restore-test-unique-pass-2',
               'finalize', 'passed', '2026-08-31T00:32:00Z', $1,
               array['v1'], 1, 0, '2026-08-31T00:33:00Z')`,
      ['d'.repeat(40)],
    );
    expect(duplicatePassedGate).toMatchObject({ code: '23505' });

    await pool.query(
      `update privacy_request_locations
       set state = 'completed', outcome_code = 'local_erasure_complete',
           checked_at = '2026-08-31T00:35:00Z'
       where request_id = $1 and location_code = 'primary_postgres'`,
      [requestId],
    );
    await expect(
      pool.query(
        `update privacy_requests
         set state = 'completed', completed_at = '2026-08-31T00:36:00Z'
         where id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const completedLocationRegression = await captureRolledBackMutation(
      `update privacy_request_locations
       set state = 'failed', outcome_code = 'location_failed'
       where request_id = $1 and location_code = 'primary_postgres'`,
      [requestId],
    );
    expect(completedLocationRegression).toMatchObject({ code: '23514' });
  });

  test('enforce retention state combinations and append-only bounded evidence', async () => {
    const [
      validId,
      invalidClassId,
      casualMissingId,
      activeDeadlineId,
      closedMissingId,
      badDeadlineId,
    ] = await Promise.all(
      [
        'valid',
        'invalid-class',
        'casual-missing',
        'active-deadline',
        'closed-missing',
        'bad-deadline',
      ].map(async (fixtureKey) => createSyntheticConversation(fixtureKey)),
    );

    await pool.query(
      `insert into conversation_retention_states
         (conversation_id, lifecycle_class, anchor_at, expires_at)
       values ($1, 'casual_chat', '2026-08-27T00:00:00Z', '2026-10-26T00:00:00Z')`,
      [validId],
    );

    await expect(
      pool.query(
        `insert into conversation_retention_states
           (conversation_id, lifecycle_class, anchor_at, expires_at)
         values ($1, 'unknown', '2026-08-27T00:00:00Z', '2026-10-26T00:00:00Z')`,
        [invalidClassId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into conversation_retention_states (conversation_id, lifecycle_class)
         values ($1, 'casual_chat')`,
        [casualMissingId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into conversation_retention_states
           (conversation_id, lifecycle_class, anchor_at, expires_at,
            relationship_status, relationship_started_at,
            last_active_review_at, next_active_review_at)
         values ($1, 'active_client', '2026-08-27T00:00:00Z',
                 '2028-08-27T00:00:00Z', 'open', '2026-08-01T00:00:00Z',
                 '2026-08-27T00:00:00Z', '2027-08-27T00:00:00Z')`,
        [activeDeadlineId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into conversation_retention_states
           (conversation_id, lifecycle_class, relationship_status,
            relationship_started_at, relationship_ended_at,
            last_active_review_at)
         values ($1, 'active_client', 'closed', '2026-01-01T00:00:00Z',
                 '2026-08-20T00:00:00Z', '2026-08-01T00:00:00Z')`,
        [closedMissingId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into conversation_retention_states
           (conversation_id, lifecycle_class, anchor_at, expires_at)
         values ($1, 'unconverted_lead', '2026-08-27T00:00:00Z',
                 '2026-08-27T00:00:00Z')`,
        [badDeadlineId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const history = await pool.query<{ readonly id: string }>(
      `insert into retention_events
         (conversation_id, decision_type, outcome, reason_code, actor_type,
          source_type, resulting_class, effective_at, resulting_anchor_at,
          resulting_expires_at, reviewer_reference, request_key)
       values ($1, 'classification_change', 'applied',
               'active_relationship_started', 'policy_owner',
               'reviewer_command', 'active_client', '2026-08-27T00:00:00Z',
               null, null, 'synthetic-policy-owner', 'synthetic-retention-history')
       returning id`,
      [validId],
    );
    const historyId = history.rows[0]?.id;
    expect(historyId).toBeDefined();

    await expect(
      pool.query(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, resulting_class, effective_at, request_key)
         values ($1, 'classification_change', 'applied', 'invalid_reason',
                 'policy_owner', 'reviewer_command', 'active_client',
                 '2026-08-27T00:00:00Z', 'synthetic-invalid-retention-history')`,
        [validId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, resulting_class, effective_at, reviewer_reference,
            request_key)
         values ($1, 'classification_change', 'applied',
                 'active_relationship_started', 'policy_owner',
                 'reviewer_command', 'active_client', '2026-08-27T00:00:00Z',
                 'synthetic-policy-owner', 'synthetic-retention-history')`,
        [validId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const job = await pool.query<{ readonly id: string }>(
      `insert into retention_job_runs
         (request_key, evaluated_at, requested_limit, status,
          conversations_processed, messages_purged)
       values ('synthetic-retention-job', '2026-10-26T00:00:00Z', 10,
               'applied', 1, 2)
       returning id`,
    );
    const jobId = job.rows[0]?.id;
    expect(jobId).toBeDefined();
    await expect(
      pool.query(
        `insert into retention_job_runs
           (request_key, evaluated_at, requested_limit, status,
            conversations_processed, messages_purged)
         values ('synthetic-invalid-retention-job', '2026-10-26T00:00:00Z',
                 0, 'invalid', -1, -1)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const [historyUpdate, historyDelete, jobUpdate, jobDelete] = await Promise.allSettled([
      pool.query(`update retention_events set outcome = 'ignored' where id = $1`, [historyId]),
      pool.query(`delete from retention_events where id = $1`, [historyId]),
      pool.query(`update retention_job_runs set messages_purged = 0 where id = $1`, [jobId]),
      pool.query(`delete from retention_job_runs where id = $1`, [jobId]),
    ]);
    for (const mutation of [historyUpdate, historyDelete, jobUpdate, jobDelete]) {
      expect(mutation.status).toBe('rejected');
      if (mutation.status === 'rejected') {
        expect(mutation.reason).toMatchObject({ code: '23514' });
      }
    }
  });

  test('enforce receipt digest uniqueness and format', async () => {
    const validDigest = 'a'.repeat(64);
    await pool.query(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 0)`,
      [validDigest],
    );

    await expect(
      pool.query(
        `insert into webhook_receipts (payload_sha256, event_count)
         values ($1, 0)`,
        [validDigest],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      pool.query(
        `insert into webhook_receipts (payload_sha256, event_count)
         values ($1, 0)`,
        ['not-a-sha256-digest'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('enforce event idempotency and bounded outcome values', async () => {
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['b'.repeat(64)],
    );
    const receiptId = receipt.rows[0]?.id;
    expect(receiptId).toBeDefined();

    const insertEvent = (idempotencyKey: string, outcome: string) =>
      pool.query(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
         values ($1, $2, 'unknown', 'unsupported', $3)`,
        [receiptId, idempotencyKey, outcome],
      );

    await insertEvent('meta:unsupported:bbbb:0', 'unsupported');

    await expect(insertEvent('meta:unsupported:bbbb:0', 'unsupported')).rejects.toMatchObject({
      code: '23505',
    });
    await expect(insertEvent('meta:unsupported:bbbb:1', 'not_allowed')).rejects.toMatchObject({
      code: '23514',
    });
  });

  test('enforce Phase 3A identity, application, and closed-value constraints', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const contactId = contact.rows[0]?.id;
    expect(contactId).toBeDefined();

    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-account', 'synthetic-contact', now(), now())
       returning id`,
      [contactId],
    );
    const identityId = identity.rows[0]?.id;
    expect(identityId).toBeDefined();

    await expect(
      pool.query(
        `insert into channel_identities
           (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
         values ($1, 'messenger', 'synthetic-account', 'synthetic-contact', now(), now())`,
        [contactId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `insert into channel_identities
           (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
         values ($1, 'invalid-channel', 'synthetic-account-2', 'synthetic-contact-2', now(), now())`,
        [contactId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identityId],
    );
    const conversationId = conversation.rows[0]?.id;
    expect(conversationId).toBeDefined();

    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['c'.repeat(64)],
    );
    const receiptId = receipt.rows[0]?.id;
    const event = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:policy:application', 'messenger', 'customer_message', 'pending')
       returning id`,
      [receiptId],
    );
    const eventId = event.rows[0]?.id;
    expect(eventId).toBeDefined();
    const invalidOutcomeEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:policy:invalid-outcome', 'messenger', 'message_status', 'pending')
       returning id`,
      [receiptId],
    );
    const invalidOutcomeEventId = invalidOutcomeEvent.rows[0]?.id;
    expect(invalidOutcomeEventId).toBeDefined();

    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'customer_message_applied')`,
      [eventId, conversationId],
    );
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'customer_message_applied')`,
        [eventId, conversationId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, outcome)
         values ($1, 'invalid_outcome')`,
        [invalidOutcomeEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, outcome)
         values (999992, 'message_status_ignored')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, actor_kind, effective_at, resulting_pause_until)
         values ($1, 'pause', 'reviewer', now(), now() + interval '24 hours')`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into policy_audit_outcomes (decision_type, outcome, reason_code, evaluated_at)
         values ('event_application', 'applied', 'invalid_reason', now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
         values ($1, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'invalid_source', now(), 'synthetic-consent-source')`,
        [identityId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const blankConsentCases: readonly {
      readonly category: string;
      readonly idempotencyKey: string;
      readonly wording: string;
      readonly wordingVersion: string;
    }[] = [
      {
        category: '',
        idempotencyKey: 'synthetic-consent-blank-category',
        wording: 'Synthetic approved consent wording',
        wordingVersion: 'v1',
      },
      {
        category: 'marketing',
        idempotencyKey: 'synthetic-consent-blank-wording',
        wording: ' ',
        wordingVersion: 'v1',
      },
      {
        category: 'marketing',
        idempotencyKey: 'synthetic-consent-blank-version',
        wording: 'Synthetic approved consent wording',
        wordingVersion: ' ',
      },
    ];
    for (const { category, idempotencyKey, wording, wordingVersion } of blankConsentCases) {
      await expect(
        pool.query(
          `insert into consent_events
             (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
           values ($1, $2, 'grant', $3, $4, 'reviewer_recorded', now(), $5)`,
          [identityId, category, wording, wordingVersion, idempotencyKey],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      pool.query(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
         values (999993, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'reviewer_recorded', now(), 'synthetic-consent-missing-identity')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('reject non-pending webhook events from every Phase 3A event reference', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-boundary-account', 'synthetic-boundary-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 4)
       returning id`,
      ['d'.repeat(64)],
    );

    const insertStaleEvent = async (idempotencyKey: string, eventKind: string) => {
      const event = await pool.query<{ readonly id: string }>(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
         values ($1, $2, 'messenger', $3, '2026-01-02T00:00:00Z', 'stale')
         returning id`,
        [receipt.rows[0]?.id, idempotencyKey, eventKind],
      );
      return event.rows[0]?.id;
    };

    const applicationEventId = await insertStaleEvent(
      'synthetic:boundary:application',
      'customer_message',
    );
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'customer_message_applied')`,
        [applicationEventId, conversation.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const pauseEventId = await insertStaleEvent(
      'synthetic:boundary:pause',
      'business_message_echo',
    );
    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
         values ($1, $2, 'pause', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'business_echo')`,
        [conversation.rows[0]?.id, pauseEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const consentEventId = await insertStaleEvent('synthetic:boundary:consent', 'customer_message');
    await expect(
      pool.query(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key, source_webhook_event_id)
         values ($1, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'customer_message', '2026-01-02T00:00:00Z', 'synthetic-boundary-consent', $2)`,
        [identity.rows[0]?.id, consentEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const auditEventId = await insertStaleEvent('synthetic:boundary:audit', 'message_status');
    await expect(
      pool.query(
        `insert into policy_audit_outcomes
           (decision_type, outcome, reason_code, related_webhook_event_id, evaluated_at)
         values ('event_application', 'ignored', 'message_status_ignored', $1, now())`,
        [auditEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('allow a resume deadline when a later authoritative echo remains', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-resume-account', 'synthetic-resume-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['e'.repeat(64)],
    );
    const echoEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
       values ($1, 'synthetic:resume:echo', 'messenger', 'business_message_echo', '2026-01-02T00:00:00Z', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );
    const echoEventId = echoEvent.rows[0]?.id;
    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'business_echo_paused')`,
      [echoEventId, conversation.rows[0]?.id],
    );
    await pool.query(
      `insert into human_pause_events
         (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
       values ($1, $2, 'pause', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'business_echo')`,
      [conversation.rows[0]?.id, echoEventId],
    );

    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until, actor_kind, reviewer_reference, reviewer_request_key)
         values ($1, 'resume', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-authoritative')`,
        [conversation.rows[0]?.id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  test('reject a business-echo pause without an authoritative application', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-unapplied-account', 'synthetic-unapplied-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['f'.repeat(64)],
    );
    const echoEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
       values ($1, 'synthetic:unapplied:echo', 'messenger', 'business_message_echo', '2026-01-02T00:00:00Z', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );

    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
         values ($1, $2, 'pause', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'business_echo')`,
        [conversation.rows[0]?.id, echoEvent.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('prevent an authoritative echo application from being invalidated', async () => {
    const authoritativeApplication = await pool.query<{ readonly webhook_event_id: string }>(
      `select webhook_event_id
       from webhook_event_applications
       where outcome = 'business_echo_paused'
       order by webhook_event_id desc
       limit 1`,
    );
    const webhookEventId = authoritativeApplication.rows[0]?.webhook_event_id;
    expect(webhookEventId).toBeDefined();

    await expect(
      pool.query(
        `update webhook_event_applications
         set outcome = 'business_echo_ignored_before_resume'
         where webhook_event_id = $1`,
        [webhookEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('serializes pending admission against a concurrent stale transition in both lock orders', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-race-account', 'synthetic-race-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 2)
       returning id`,
      ['1'.repeat(64)],
    );
    const insertPendingEvent = async (idempotencyKey: string) => {
      const event = await pool.query<{ readonly id: string }>(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
         values ($1, $2, 'messenger', 'customer_message', 'pending')
         returning id`,
        [receipt.rows[0]?.id, idempotencyKey],
      );
      return event.rows[0]?.id;
    };
    const insertApplication = (client: pg.PoolClient, eventId: string | undefined) =>
      client.query(
        `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'customer_message_applied')`,
        [eventId, conversation.rows[0]?.id],
      );
    const settleApplication = (client: pg.PoolClient, eventId: string | undefined) =>
      insertApplication(client, eventId).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ reason, status: 'rejected' as const }),
      );

    const referenceFirstEventId = await insertPendingEvent('synthetic:race:reference-first');
    const firstLocker = await pool.connect();
    const firstContender = await pool.connect();
    try {
      await firstLocker.query('begin');
      await firstLocker.query(`select id from webhook_events where id = $1 for update`, [
        referenceFirstEventId,
      ]);
      const referenceAttempt = settleApplication(firstContender, referenceFirstEventId);
      await expect(
        firstLocker.query(`update webhook_events set admission_outcome = 'stale' where id = $1`, [
          referenceFirstEventId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await firstLocker.query('commit');
      await expect(referenceAttempt).resolves.toMatchObject({
        reason: { code: '23514' },
        status: 'rejected',
      });
    } finally {
      await firstLocker.query('rollback').catch(() => undefined);
      firstLocker.release();
      firstContender.release();
    }

    const staleFirstEventId = await insertPendingEvent('synthetic:race:stale-first');
    const secondLocker = await pool.connect();
    const secondContender = await pool.connect();
    try {
      await secondLocker.query('begin');
      await secondLocker.query(
        `update webhook_events set admission_outcome = 'stale' where id = $1`,
        [staleFirstEventId],
      );
      const referenceAttempt = settleApplication(secondContender, staleFirstEventId);
      await secondLocker.query('commit');
      await expect(referenceAttempt).resolves.toMatchObject({
        reason: { code: '23514' },
        status: 'rejected',
      });
    } finally {
      await secondLocker.query('rollback').catch(() => undefined);
      secondLocker.release();
      secondContender.release();
    }

    const referenceHoldsLockEventId = await insertPendingEvent(
      'synthetic:race:reference-holds-lock',
    );
    const referenceLocker = await pool.connect();
    const staleContender = await pool.connect();
    try {
      await referenceLocker.query('begin');
      await insertApplication(referenceLocker, referenceHoldsLockEventId);
      const referenceBackend = await referenceLocker.query<{ readonly pid: number }>(
        `select pg_backend_pid() as pid`,
      );
      const staleBackend = await staleContender.query<{ readonly pid: number }>(
        `select pg_backend_pid() as pid`,
      );
      const referencePid = referenceBackend.rows[0]?.pid;
      const stalePid = staleBackend.rows[0]?.pid;
      expect(referencePid).toBeDefined();
      expect(stalePid).toBeDefined();

      const staleOutcome = staleContender
        .query(`update webhook_events set admission_outcome = 'stale' where id = $1`, [
          referenceHoldsLockEventId,
        ])
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let blockedByReference = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocking = await pool.query<{ readonly blocking_pid: number }>(
          `select unnest(pg_blocking_pids($1)) as blocking_pid`,
          [stalePid],
        );
        blockedByReference = blocking.rows.some((row) => row.blocking_pid === referencePid);
        if (blockedByReference) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(blockedByReference).toBe(true);
      await referenceLocker.query('commit');
      await expect(staleOutcome).resolves.toMatchObject({ code: '23514' });
    } finally {
      await referenceLocker.query('rollback').catch(() => undefined);
      referenceLocker.release();
      staleContender.release();
    }
  });

  test('reject a non-null resume deadline after a later pause or resume supersedes it', async () => {
    const state = await pool.query<{
      readonly conversation_id: string;
      readonly receipt_id: string;
    }>(
      `select conversations.id as conversation_id, webhook_events.receipt_id
       from conversations
       join channel_identities on channel_identities.id = conversations.channel_identity_id
       join webhook_events on webhook_events.idempotency_key = 'synthetic:resume:echo'
       where channel_identities.channel_account_id = 'synthetic-resume-account'`,
    );
    const conversationId = state.rows[0]?.conversation_id;
    const receiptId = state.rows[0]?.receipt_id;
    expect(conversationId).toBeDefined();
    expect(receiptId).toBeDefined();
    const laterEcho = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
       values ($1, 'synthetic:resume:later-echo', 'messenger', 'business_message_echo', '2026-01-04T00:00:00Z', 'pending')
       returning id`,
      [receiptId],
    );
    const laterEchoId = laterEcho.rows[0]?.id;
    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'business_echo_paused')`,
      [laterEchoId, conversationId],
    );
    await pool.query(
      `insert into human_pause_events
         (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
       values ($1, $2, 'pause', '2026-01-04T00:00:00Z', '2026-01-05T00:00:00Z', 'business_echo')`,
      [conversationId, laterEchoId],
    );
    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until, actor_kind, reviewer_reference, reviewer_request_key)
         values ($1, 'resume', '2025-12-31T00:00:00Z', '2026-01-03T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-superseded-pause')`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      `insert into human_pause_events
         (conversation_id, action, effective_at, actor_kind, reviewer_reference, reviewer_request_key)
       values ($1, 'resume', '2026-01-06T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-later')`,
      [conversationId],
    );
    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until, actor_kind, reviewer_reference, reviewer_request_key)
         values ($1, 'resume', '2025-12-30T00:00:00Z', '2026-01-03T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-superseded-resume')`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('reject direct consent history updates and deletes without mutating the row', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-append-consent-account', 'synthetic-append-consent-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const consent = await pool.query<{ readonly id: string }>(
      `insert into consent_events
         (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
       values ($1, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'reviewer_recorded', '2026-01-02T00:00:00Z', 'synthetic-append-consent')
       returning id`,
      [identity.rows[0]?.id],
    );
    const consentId = consent.rows[0]?.id;
    expect(consentId).toBeDefined();

    const updateError = await pool
      .query(`update consent_events set action = 'revoke' where id = $1`, [consentId])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const deleteError = await pool
      .query(`delete from consent_events where id = $1`, [consentId])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect([updateError, deleteError]).toEqual([
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
    ]);
    const unchanged = await pool.query<{
      readonly action: string;
      readonly id: string;
      readonly idempotency_key: string;
    }>(
      `select id, action, idempotency_key
       from consent_events
       where id = $1`,
      [consentId],
    );
    expect(unchanged.rows).toEqual([
      {
        action: 'grant',
        id: consentId,
        idempotency_key: 'synthetic-append-consent',
      },
    ]);
  });

  test('reject direct human-pause history updates and deletes without mutating the row', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-append-pause-account', 'synthetic-append-pause-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const pause = await pool.query<{ readonly id: string }>(
      `insert into human_pause_events
         (conversation_id, action, effective_at, actor_kind, reviewer_reference, reviewer_request_key)
       values ($1, 'resume', '2026-01-02T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-append-pause')
       returning id`,
      [conversation.rows[0]?.id],
    );
    const pauseId = pause.rows[0]?.id;
    expect(pauseId).toBeDefined();

    const updateError = await pool
      .query(`update human_pause_events set reviewer_reference = $1 where id = $2`, [
        'synthetic-reviewer-changed',
        pauseId,
      ])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const deleteError = await pool
      .query(`delete from human_pause_events where id = $1`, [pauseId])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect([updateError, deleteError]).toEqual([
      expect.objectContaining({ code: '23514' }),
      expect.objectContaining({ code: '23514' }),
    ]);
    const unchanged = await pool.query<{
      readonly id: string;
      readonly reviewer_reference: string;
      readonly reviewer_request_key: string;
    }>(
      `select id, reviewer_reference, reviewer_request_key
       from human_pause_events
       where id = $1`,
      [pauseId],
    );
    expect(unchanged.rows).toEqual([
      {
        id: pauseId,
        reviewer_reference: 'synthetic-reviewer',
        reviewer_request_key: 'synthetic-append-pause',
      },
    ]);
  });

  test('guards populated privacy evidence, then rolls back and reapplies all installed migrations', async () => {
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['8'.repeat(64)],
    );
    const suppressedEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:migration:identity-suppressed-down',
               'messenger', 'customer_message', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );
    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, outcome)
       values ($1, 'identity_suppressed')`,
      [suppressedEvent.rows[0]?.id],
    );

    const livePrivacyRequest = await pool.query<{ readonly id: string }>(
      `insert into privacy_requests
         (request_ref, request_type, state, received_at, decision_at,
          reviewer_reference, decision_code, reason_code, open_request_key)
       values ('PRIVACY_TEST_populated_down', 'access', 'in_progress',
               '2026-08-31T10:00:00Z', '2026-08-31T10:01:00Z',
               'REVIEWER_TEST_populated_down', 'same_channel_context',
               'identity_verified', 'privacy-test-populated-down')
       returning id`,
    );
    await pool.query(
      `insert into privacy_request_events
         (request_id, action, outcome, reason_code, previous_state,
          resulting_state, actor_type, reviewer_reference,
          effective_at, request_key)
       values ($1, 'reviewer_decision', 'applied', 'identity_verified',
               'human_review', 'in_progress', 'support_reviewer',
               'REVIEWER_TEST_populated_down', '2026-08-31T10:01:00Z',
               'privacy-test-populated-down-review')`,
      [livePrivacyRequest.rows[0]?.id],
    );
    const liveOptOutRun = await pool.query<{ readonly id: string }>(
      `insert into privacy_marketing_opt_out_runs
         (request_key, effective_at, linked_identities_count,
          category_revocations_count, suppressions_created_count,
          pending_intents_cancelled_count, status)
       values ('privacy-test-populated-down-opt-out', '2026-08-31T10:02:00Z',
               1, 0, 4, 0, 'applied')
       returning id`,
    );
    await pool.query(
      `insert into privacy_notification_intents
         (marketing_opt_out_run_id, notification_type, state, idempotency_key)
       values ($1, 'operator_marketing_opt_out', 'pending',
               'privacy-test-populated-down-notification')`,
      [liveOptOutRun.rows[0]?.id],
    );
    await pool.query(
      `insert into policy_audit_outcomes
         (decision_type, outcome, reason_code, evaluated_at)
       values
         ('reply_eligibility', 'denied', 'privacy_request_open',
          '2026-08-31T10:03:00Z'),
         ('marketing_eligibility', 'denied', 'global_marketing_opt_out',
          '2026-08-31T10:03:01Z')`,
    );

    let rollbackError: unknown;
    try {
      await migrateDownThrough(8);
    } catch (error: unknown) {
      rollbackError = error;
    }
    expect(rollbackError).toBeInstanceOf(Error);
    if (!(rollbackError instanceof Error)) {
      throw new Error('Expected populated P3-007 rollback to fail');
    }
    expect(rollbackError.message).toContain('P3-007 rollback blocked');
    expect((rollbackError as Error & { code?: string }).code).toBe('55000');
    await expect(
      pool.query(`select count(*)::int as count from pgmigrations`),
    ).resolves.toMatchObject({ rows: [{ count: 16 }] });

    await pool.query(`
      truncate table
        privacy_marketing_reopt_in_runs, privacy_access_runs,
        privacy_correction_runs, privacy_marketing_opt_out_runs,
        privacy_notification_intents, privacy_request_events,
        privacy_request_locations, privacy_deletion_runs,
        restore_deletion_gates, privacy_requests, privacy_suppressions
      restart identity cascade
    `);
    await pool.query(
      `delete from policy_audit_outcomes
       where reason_code in ('global_marketing_opt_out', 'privacy_request_open')`,
    );

    await migrateDownThrough(5);

    const retainedSuppressionEvidence = await pool.query<{
      readonly outcome: string;
    }>(
      `select outcome
       from webhook_event_applications
       where webhook_event_id = $1`,
      [suppressedEvent.rows[0]?.id],
    );
    const afterPrivacyRollback = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name like 'privacy_%'
       order by table_name`,
      [schema],
    );
    expect(retainedSuppressionEvidence.rows).toEqual([{ outcome: 'identity_suppressed' }]);
    expect(afterPrivacyRollback.rows).toEqual([
      { table_name: 'privacy_deletion_runs' },
      { table_name: 'privacy_notification_intents' },
      { table_name: 'privacy_request_events' },
      { table_name: 'privacy_request_locations' },
      { table_name: 'privacy_requests' },
      { table_name: 'privacy_suppressions' },
    ]);

    await runMigrations('up');
    await migrateDownThrough(1);

    const afterRollback = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'channel_identities',
           'consent_events',
           'contacts',
           'conversation_retention_states',
           'conversations',
           'human_pause_events',
           'policy_audit_outcomes',
           'privacy_access_runs',
           'privacy_correction_runs',
           'privacy_deletion_runs',
           'privacy_marketing_opt_out_runs',
           'privacy_marketing_reopt_in_runs',
           'privacy_notification_intents',
           'privacy_request_events',
           'privacy_request_locations',
           'privacy_requests',
           'privacy_suppressions',
           'retention_events',
           'retention_job_runs',
           'restore_deletion_gates',
           'webhook_event_applications',
           'webhook_events',
           'webhook_receipts'
         )`,
      [schema],
    );
    expect(afterRollback.rows).toEqual([]);

    await runMigrations('up');

    const afterReapply = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'channel_identities',
           'consent_events',
           'contacts',
           'conversation_retention_states',
           'conversations',
           'human_pause_events',
           'policy_audit_outcomes',
           'privacy_access_runs',
           'privacy_correction_runs',
           'privacy_deletion_runs',
           'privacy_marketing_opt_out_runs',
           'privacy_marketing_reopt_in_runs',
           'privacy_notification_intents',
           'privacy_request_events',
           'privacy_request_locations',
           'privacy_requests',
           'privacy_suppressions',
           'retention_events',
           'retention_job_runs',
           'restore_deletion_gates',
           'webhook_event_applications',
           'webhook_events',
           'webhook_receipts'
         )
       order by table_name`,
      [schema],
    );
    expect(afterReapply.rows).toEqual([
      { table_name: 'channel_identities' },
      { table_name: 'consent_events' },
      { table_name: 'contacts' },
      { table_name: 'conversation_retention_states' },
      { table_name: 'conversations' },
      { table_name: 'human_pause_events' },
      { table_name: 'policy_audit_outcomes' },
      { table_name: 'privacy_access_runs' },
      { table_name: 'privacy_correction_runs' },
      { table_name: 'privacy_deletion_runs' },
      { table_name: 'privacy_marketing_opt_out_runs' },
      { table_name: 'privacy_marketing_reopt_in_runs' },
      { table_name: 'privacy_notification_intents' },
      { table_name: 'privacy_request_events' },
      { table_name: 'privacy_request_locations' },
      { table_name: 'privacy_requests' },
      { table_name: 'privacy_suppressions' },
      { table_name: 'restore_deletion_gates' },
      { table_name: 'retention_events' },
      { table_name: 'retention_job_runs' },
      { table_name: 'webhook_event_applications' },
      { table_name: 'webhook_events' },
      { table_name: 'webhook_receipts' },
    ]);
  });
});
