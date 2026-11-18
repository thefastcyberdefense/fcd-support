import { expect, test } from 'vitest';
import type pg from 'pg';

import { PostgresModelGateway } from '../src/persistence/postgres-model-gateway.js';
import { PostgresModelPolicy } from '../src/persistence/postgres-model-policy.js';
import { PostgresOutboundEchoCorrelation } from '../src/persistence/postgres-outbound-echo-correlation.js';
import { PostgresOutboundIntentStore } from '../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundStatus } from '../src/persistence/postgres-outbound-status.js';
import { PostgresOutboundTemplate } from '../src/persistence/postgres-outbound-template.js';
import { PostgresOutboundWorkStore } from '../src/persistence/postgres-outbound-work-store.js';
import { syntheticPrivacyKeyring } from './integration/policy-fixtures.js';

function leastPrivilegePool() {
  const executedSql: string[] = [];
  const client = {
    query: (sql: string) => {
      executedSql.push(sql);
      if (/\badmin_accounts\b/iu.test(sql)) {
        return Promise.reject(
          Object.assign(new Error('permission denied for table admin_accounts'), {
            code: '42501',
          }),
        );
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  };
  const pool = {
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
  return { pool, executedSql };
}

test('worker-side policy, gateway, and template resolvers never query admin_accounts', async () => {
  const { pool, executedSql } = leastPrivilegePool();
  const at = new Date('2030-03-01T00:00:00.000Z');

  const outboundPolicy = await new PostgresOutboundPolicy(pool).resolveEffectivePolicy(at, {
    global1Minute: 10,
    globalUtcDay: 100,
    leaseMs: 30_000,
    maximumDefiniteRetries: 1,
    messengerAccount1Minute: 10,
    perContact15Minute: 2,
    perContact24Hour: 5,
    providerTimeoutMs: 1_000,
    retryBaseMs: 100,
    retryMaximumMs: 1_000,
    whatsappAccount1Minute: 10,
    workerBatchSize: 5,
  });
  expect(outboundPolicy.status).toBe('disabled');

  const modelPolicy = await new PostgresModelPolicy(pool).resolveEffectivePolicy(
    at,
    {
      architectureProviderConnections: 1,
      concurrentCalls: 2,
      contextItems: 6,
      cooldownMs: 0,
      globalUtcDayCalls: 50,
      inputCodePoints: 4000,
      outputTokens: 512,
      perContact15MinuteCalls: 5,
      perContact24HourCalls: 20,
      providerAttempts: 1,
      queueCapacity: 4,
      responseBytes: 65536,
      totalTimeoutMs: 15000,
    },
    {
      verified: true,
      operationalLimits: {
        concurrentCalls: 2,
        cooldownMs: 0,
        globalUtcDayCalls: 50,
        outputTokens: 512,
        perContact15MinuteCalls: 5,
        perContact24HourCalls: 20,
        providerAttempts: 1,
        queueCapacity: 4,
        totalTimeoutMs: 15000,
      },
    },
  );
  expect(modelPolicy.status).toBe('disabled');

  const gateway = await new PostgresModelGateway(pool).resolveRuntimeGateway();
  expect(gateway.gatewayKind).toBe('manifest_default');

  const template = await new PostgresOutboundTemplate(pool).resolveEffectiveTemplate({
    category: 'marketing_education',
    channel: 'whatsapp',
    channelAccountId: 'SYNTHETIC_WA_PHONE_01',
    evaluatedAt: at,
    locale: 'en_US',
    templateRef: 'TEMPLATE_SYNTHETIC_01',
  });
  expect(template.status).toBe('disabled');

  expect(executedSql.some((sql) => /\badmin_accounts\b/iu.test(sql))).toBe(false);
});

const outboundUpdateTables = new Set([
  'conversations',
  'human_pause_events',
  'outbound_attempts',
  'outbound_echo_correlation_holds',
  'outbound_escalation_outcomes',
  'outbound_intents',
  'outbound_rate_windows',
  'outbound_status_events',
  'policy_audit_outcomes',
  'webhook_event_applications',
]);

const replyUpdateTables = new Set([
  'channel_identities',
  'consent_events',
  'contacts',
  'conversation_retention_states',
  'conversations',
  'human_pause_events',
  'knowledge_gap_observations',
  'model_budget_windows',
  'model_call_leases',
  'model_usage_windows',
  'outbound_attempts',
  'outbound_echo_correlation_holds',
  'outbound_escalation_outcomes',
  'outbound_intents',
  'outbound_status_events',
  'policy_audit_outcomes',
  'privacy_access_runs',
  'privacy_correction_runs',
  'privacy_marketing_opt_out_runs',
  'privacy_marketing_reopt_in_runs',
  'privacy_notification_intents',
  'privacy_request_events',
  'privacy_request_locations',
  'privacy_requests',
  'privacy_suppressions',
  'retention_events',
  'runtime_processing_work',
  'support_escalation_outcomes',
  'support_reply_draft_knowledge',
  'support_reply_drafts',
  'webhook_event_applications',
  'webhook_event_attachments',
  'webhook_events',
  'webhook_receipts',
]);

function assertValidWorkerSql(sql: string, allowedUpdateTables: ReadonlySet<string>): void {
  if (/\bpg_advisory_xact_lock\s*\(\s*\d+\s*,\s*\$\d+::bigint/iu.test(sql)) {
    throw Object.assign(new Error('invalid pg_advisory_xact_lock(integer, bigint) call'), {
      code: '42883',
    });
  }
  const normalized = sql.replace(/\s+/gu, ' ').trim();
  const lockMatch =
    /\bfor\s+(?:update|share)(?:\s+of\s+([a-z0-9_,\s]+?))?(?:\s+(?:skip\s+locked|nowait))?$/iu.exec(
      normalized,
    );
  if (lockMatch === null) return;

  const aliases = new Map<string, string>();
  const relationRegex = /\b(?:from|join)\s+([a-z0-9_]+)(?:\s+(?:as\s+)?([a-z0-9_]+))?/giu;
  for (const match of normalized.matchAll(relationRegex)) {
    const table = match[1];
    const alias = match[2];
    if (table !== undefined) {
      aliases.set(table, table);
      if (
        alias !== undefined &&
        !/^(where|join|left|inner|order|limit|for|on|group|having|set)$/iu.test(alias)
      ) {
        aliases.set(alias, table);
      }
    }
  }
  const targets =
    lockMatch[1] !== undefined
      ? lockMatch[1]
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .map((item) => aliases.get(item) ?? item)
      : [...new Set(aliases.values())];
  for (const table of targets) {
    if (!allowedUpdateTables.has(table)) {
      throw Object.assign(new Error(`permission denied for table ${table}`), { code: '42501' });
    }
  }
}

function sqlCheckingPool(
  allowedUpdateTables: ReadonlySet<string>,
  responder: (sql: string, params?: readonly unknown[]) => { readonly rows: readonly unknown[] },
) {
  const executedSql: string[] = [];
  const client = {
    query: (sql: string, params?: readonly unknown[]) => {
      executedSql.push(sql);
      assertValidWorkerSql(sql, allowedUpdateTables);
      if (/^(begin|commit|rollback)$/iu.test(sql.trim()))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const result = responder(sql, params);
      return Promise.resolve({ rowCount: result.rows.length, ...result });
    },
    release: () => undefined,
  };
  const pool = {
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
  return { pool, executedSql };
}

test('outbound and reply queries never lock SELECT-only tables or use invalid advisory lock casts', async () => {
  const evaluatedAt = new Date('2030-03-01T10:00:00.000Z');
  const future = new Date('2030-03-01T12:00:00.000Z');
  const bounds = {
    global1Minute: 10,
    globalUtcDay: 100,
    leaseMs: 30_000,
    maximumDefiniteRetries: 1,
    messengerAccount1Minute: 10,
    perContact15Minute: 2,
    perContact24Hour: 5,
    providerTimeoutMs: 1_000,
    retryBaseMs: 100,
    retryMaximumMs: 1_000,
    whatsappAccount1Minute: 10,
    workerBatchSize: 5,
  };
  const activePolicyRow = {
    id: '10',
    per_contact_15_minute: 2,
    per_contact_24_hour: 5,
    whatsapp_account_1_minute: 10,
    messenger_account_1_minute: 10,
    global_1_minute: 10,
    global_utc_day: 100,
    worker_batch_size: 5,
    lease_ms: 30_000,
    provider_timeout_ms: 1_000,
    maximum_definite_retries: 1,
    retry_base_ms: 100,
    retry_maximum_ms: 1_000,
  };
  const intentRow = {
    id: '20',
    intent_ref: 'INTENT_TEST_1',
    conversation_id: '30',
    channel_identity_id: '40',
    reply_draft_id: '50',
    template_version_id: null,
    channel: 'messenger',
    channel_account_id: 'PAGE_TEST_1',
    purpose: 'customer_support',
    message_kind: 'support_text',
    state: 'pending',
    attempt_count: 0,
    next_attempt_at: evaluatedAt,
    lease_ref: null,
    lease_expires_at: null,
    retention_deadline: future,
  };
  const leasedIntentRow = {
    ...intentRow,
    state: 'leased',
    lease_ref: 'LEASE_TEST_1',
    lease_expires_at: future,
  };

  let activeLeaseRef = 'LEASE_TEST_1';
  const outboundMock = sqlCheckingPool(outboundUpdateTables, (sql, params) => {
    if (sql.includes('update outbound_intents') && sql.includes('lease_ref =')) {
      const candidate = params?.[1];
      if (typeof candidate === 'string') activeLeaseRef = candidate;
      return { rows: [] };
    }
    if (sql.includes('from runtime_recovery_holds')) return { rows: [{ held: false }] };
    if (sql.includes('from outbound_policy_versions as policy')) return { rows: [activePolicyRow] };
    if (sql.includes('from outbound_policy_versions where id = $1'))
      return { rows: [activePolicyRow] };
    if (sql.includes("where state = 'pending' and next_attempt_at <= $1"))
      return { rows: [intentRow] };
    if (sql.includes('from outbound_intents where intent_ref = $1'))
      return {
        rows: [
          {
            ...leasedIntentRow,
            lease_ref: activeLeaseRef,
          },
        ],
      };
    if (sql.includes('from conversations as conversation')) {
      return {
        rows: [
          {
            conversation_id: '30',
            ai_paused_until: null,
            identity_id: '40',
            contact_id: '60',
            channel: 'messenger',
            channel_account_id: 'PAGE_TEST_1',
            external_contact_id: 'CONTACT_TEST_1',
          },
        ],
      };
    }
    if (sql.includes('from conversation_retention_states where conversation_id = $1')) {
      return {
        rows: [
          {
            lifecycle_class: 'active_customer',
            relationship_status: 'active',
            expires_at: future,
            next_active_review_at: null,
          },
        ],
      };
    }
    if (sql.includes('from support_reply_drafts as draft')) {
      return {
        rows: [
          {
            source_state: 'ready',
            erased_at: null,
            answer_text: 'Synthetic reviewed answer.',
            channel: null,
            channel_account_id: null,
            category: null,
            locale: null,
            variable_count: null,
          },
        ],
      };
    }
    if (sql.includes('from webhook_event_applications as application'))
      return { rows: [{ occurred_at: new Date('2030-03-01T09:50:00.000Z') }] };
    if (sql.includes('from privacy_suppressions')) return { rows: [{ suppressed: false }] };
    if (sql.includes('from privacy_requests')) return { rows: [{ open: false }] };
    if (sql.includes('coalesce(max(attempt_number), 0)')) return { rows: [{ value: 1 }] };
    if (
      sql.includes('from outbound_attempts') &&
      !sql.includes('join outbound_intents') &&
      sql.includes('attempt_number')
    )
      return { rows: [] };
    if (sql.includes('from outbound_attempts as attempt')) {
      return {
        rows: [
          {
            id: '80',
            intent_id: '20',
            attempt_number: 1,
            attempt_ref: 'ATTEMPT_TEST_1',
            policy_version_id: '10',
            state: 'authorized',
            provider_message_id: null,
            outcome_code: null,
            retry_after: null,
            dispatch_started_at: null,
            finished_at: null,
            intent_ref: 'INTENT_TEST_1',
            conversation_id: '30',
            channel_identity_id: '40',
            reply_draft_id: '50',
            template_version_id: null,
            channel: 'messenger',
            channel_account_id: 'PAGE_TEST_1',
            purpose: 'customer_support',
            message_kind: 'support_text',
            attempt_count: 1,
            next_attempt_at: evaluatedAt,
            lease_ref: activeLeaseRef,
            lease_expires_at: future,
            retention_deadline: future,
            intent_state: 'leased',
          },
        ],
      };
    }
    if (sql.includes('select count(*)::int as count')) return { rows: [{ count: 0 }] };
    if (sql.includes('returning reservation_count')) return { rows: [{ reservation_count: 1 }] };
    if (sql.includes('select answer_text from support_reply_drafts'))
      return { rows: [{ answer_text: 'Synthetic reviewed answer.' }] };
    if (sql.includes('update outbound_intents set attempt_count'))
      return { rows: [{ attempt_count: 1 }] };
    if (sql.includes('from outbound_echo_correlation_holds') && sql.includes('expires_at <=')) {
      return { rows: [{ id: '90', conversation_id: '30' }] };
    }
    if (sql.includes('from webhook_events as event') && sql.includes('business_message_echo')) {
      return { rows: [{ id: '100' }] };
    }
    if (sql.includes('from webhook_events where id = $1')) {
      return {
        rows: [
          {
            id: '100',
            admission_outcome: 'pending',
            channel: 'messenger',
            channel_account_id: 'PAGE_TEST_1',
            contact_id: 'CONTACT_TEST_1',
            event_kind: 'business_message_echo',
            occurred_at: evaluatedAt,
          },
        ],
      };
    }
    if (sql.includes('from channel_identities as identity')) {
      return {
        rows: [
          {
            conversation_id: '30',
            event_occurred_after_authorized_resume: true,
          },
        ],
      };
    }
    return { rows: [] };
  });

  const workStore = new PostgresOutboundWorkStore(
    outboundMock.pool,
    syntheticPrivacyKeyring,
    bounds,
  );
  const claimed = await workStore.claimBatch({ claimedAt: evaluatedAt, workerRef: 'WORKER_1' });
  expect(claimed).toHaveLength(1);
  const authorized = await workStore.authorizeAttempt({
    evaluatedAt,
    intentRef: 'INTENT_TEST_1',
    leaseRef: claimed[0]?.leaseRef ?? 'LEASE_TEST_1',
  });
  expect(authorized).toMatchObject({ status: 'authorized' });
  if (authorized.status !== 'authorized') throw new Error('unexpected authorization failure');
  const dispatch = await workStore.markDispatchStarted({
    attemptRef: authorized.attemptRef,
    leaseRef: claimed[0]?.leaseRef ?? 'LEASE_TEST_1',
    startedAt: evaluatedAt,
  });
  expect(dispatch.status).toBe('started');
  await new PostgresOutboundEchoCorrelation(outboundMock.pool).resolveExpiredHolds({
    evaluatedAt,
    limit: 5,
  });

  const replyMock = sqlCheckingPool(replyUpdateTables, (sql) => {
    if (sql.includes('from outbound_intents where request_key = $1')) return { rows: [] };
    if (sql.includes('from support_reply_drafts as draft')) {
      return {
        rows: [
          {
            draft_id: '50',
            draft_ref: 'DRAFT_TEST_1',
            state: 'ready',
            erased_at: null,
            retention_deadline: future,
            conversation_id: '30',
            ai_paused_until: null,
            identity_id: '40',
            contact_id: '60',
            channel: 'messenger',
            channel_account_id: 'PAGE_TEST_1',
            external_contact_id: 'CONTACT_TEST_1',
          },
        ],
      };
    }
    if (sql.includes('from conversation_retention_states')) {
      return {
        rows: [
          {
            lifecycle_class: 'active_customer',
            relationship_status: 'active',
            expires_at: future,
            next_active_review_at: null,
          },
        ],
      };
    }
    if (sql.includes('from outbound_policy_versions as policy')) return { rows: [activePolicyRow] };
    if (sql.includes('from webhook_event_applications as application'))
      return { rows: [{ occurred_at: new Date('2030-03-01T09:50:00.000Z') }] };
    if (sql.includes('from privacy_suppressions')) return { rows: [{ suppressed: false }] };
    if (sql.includes('from privacy_requests')) return { rows: [{ open: false }] };
    if (sql.includes('from webhook_events') && sql.includes('where id = $1')) {
      return {
        rows: [
          {
            id: '101',
            admission_outcome: 'pending',
            channel: 'messenger',
            channel_account_id: 'PAGE_TEST_1',
            contact_id: 'CONTACT_TEST_1',
            event_kind: sql.includes('external_message_id')
              ? 'message_status'
              : 'business_message_echo',
            external_message_id: 'META_MSG_1',
            message_status: 'delivered',
            occurred_at: evaluatedAt,
          },
        ],
      };
    }
    if (sql.includes('from outbound_attempts as attempt') && sql.includes('provider_message_id')) {
      return {
        rows: [
          {
            intent_id: '20',
            intent_state: 'provider_accepted',
            delivery_status: null,
            delivery_status_at: null,
            intent_created_at: evaluatedAt,
            intent_updated_at: evaluatedAt,
            hold_id: '90',
            conversation_id: '30',
          },
        ],
      };
    }
    if (sql.includes('insert into outbound_intents')) {
      return { rows: [{ id: '20', intent_ref: 'INTENT_TEST_1' }] };
    }
    return { rows: [] };
  });

  const intentResult = await new PostgresOutboundIntentStore(
    replyMock.pool,
    syntheticPrivacyKeyring,
    bounds,
  ).createSupportIntent({
    draftRef: 'DRAFT_TEST_1',
    evaluatedAt,
    requestKey: 'REQUEST_INTENT_TEST_1',
  });
  expect(intentResult.status).toBe('created');
  await new PostgresOutboundStatus(replyMock.pool).applyEvent('101');
  await new PostgresOutboundEchoCorrelation(replyMock.pool).processBusinessEcho('102');
});
