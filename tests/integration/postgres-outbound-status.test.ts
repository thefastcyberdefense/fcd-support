import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type {
  OutboundDeploymentBounds,
  OutboundPolicyValues,
} from '../../src/outbound/outbound-types.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresOutboundIntentStore } from '../../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundStatus } from '../../src/persistence/postgres-outbound-status.js';
import { PostgresOutboundWorkStore } from '../../src/persistence/postgres-outbound-work-store.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const baseAt = new Date('2026-09-17T08:00:00.000Z');
const workAt = new Date('2026-09-17T11:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_status',
  roles: ['administrator'],
};
const generous = Object.freeze({
  global1Minute: 100_000,
  globalUtcDay: 1_000_000,
  leaseMs: 30_000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 100_000,
  perContact15Minute: 1000,
  perContact24Hour: 10_000,
  providerTimeoutMs: 8000,
  retryBaseMs: 1000,
  retryMaximumMs: 8000,
  whatsappAccount1Minute: 100_000,
  workerBatchSize: 100,
}) satisfies OutboundDeploymentBounds;

type ProviderStatus = 'delivered' | 'failed' | 'read' | 'sent';

interface AcceptedFixture {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly intentRef: string;
  readonly providerMessageId: string;
}

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_outbound_status');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(`
    truncate table
      contacts, webhook_receipts, privacy_suppressions, privacy_requests,
      outbound_echo_correlation_holds, outbound_status_events,
      outbound_escalation_outcomes, outbound_attempts, outbound_intents,
      outbound_rate_windows, outbound_template_review_events,
      outbound_template_versions, outbound_policy_review_events,
      outbound_policy_versions, admin_accounts
    restart identity cascade
  `);
  await seedAdministrator();
  await seedPolicy();
});

afterAll(async () => {
  await dispose?.();
});

async function seedAdministrator(): Promise<void> {
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.outbound.status', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x7b), Buffer.alloc(32, 0x7c), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_status_admin_role')`,
    [account.rows[0]?.id, baseAt],
  );
}

async function seedPolicy(values: OutboundPolicyValues = generous): Promise<void> {
  const policies = new PostgresOutboundPolicy(pool);
  await policies.createVersion(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_outbound_status',
      requestKey: 'REQUEST_TEST_outbound_status_policy_create',
      values,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await policies[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        policyRef: 'POLICY_TEST_outbound_status',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_outbound_status_policy_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
}

async function seedAccepted(
  key: string,
  channel: 'messenger' | 'whatsapp' = 'whatsapp',
  accountSuffix = 'primary',
): Promise<AcceptedFixture> {
  const channelAccountId =
    channel === 'whatsapp'
      ? `PHONE_TEST_outbound_status_${accountSuffix}`
      : `PAGE_TEST_outbound_status_${accountSuffix}`;
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `outbound_status_source_${key}`,
    identity: {
      channel,
      channelAccountId,
      externalContactId: `CONTACT_TEST_outbound_status_${key}`,
    },
    messageText: 'Synthetic customer source excluded from status evidence.',
    occurredAt: new Date(workAt.getTime() - 60 * 60 * 1000),
  });
  const draftRef = `DRAFT_TEST_outbound_status_${key}`;
  await pool.query(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, state, retention_deadline, request_key, created_at)
     values ($1,$2,$3,'safe_failure','en',$4,'ready',$5,$6,$7)`,
    [
      draftRef,
      source.eventId,
      source.conversationId,
      'Synthetic reviewed status reply excluded from provider evidence.',
      new Date(workAt.getTime() + 7 * 86_400_000),
      `REQUEST_TEST_outbound_status_draft_${key}`,
      new Date(workAt.getTime() - 30 * 60 * 1000),
    ],
  );
  const created = await new PostgresOutboundIntentStore(
    pool,
    syntheticPrivacyKeyring,
    generous,
  ).createSupportIntent({
    draftRef,
    evaluatedAt: workAt,
    requestKey: `REQUEST_TEST_outbound_status_intent_${key}`,
  });
  if (created.status !== 'created') throw new Error('Synthetic status intent was not created');

  const store = new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, generous);
  const claimed = (
    await store.claimBatch({
      claimedAt: workAt,
      workerRef: `WORKER_TEST_outbound_status_${key}`,
    })
  )[0];
  if (claimed === undefined) throw new Error('Synthetic status intent was not claimed');
  const authorized = await store.authorizeAttempt({
    evaluatedAt: workAt,
    intentRef: claimed.intentRef,
    leaseRef: claimed.leaseRef,
  });
  if (authorized.status !== 'authorized')
    throw new Error('Synthetic status attempt was not authorized');
  await store.markDispatchStarted({
    attemptRef: authorized.attemptRef,
    leaseRef: claimed.leaseRef,
    startedAt: new Date(workAt.getTime() + 1),
  });
  const providerMessageId = `META_MESSAGE_TEST_outbound_status_${key}`;
  await store.recordProviderResult({
    attemptRef: authorized.attemptRef,
    completedAt: new Date(workAt.getTime() + 2),
    leaseRef: claimed.leaseRef,
    result: { providerMessageId, status: 'accepted' },
  });
  return {
    channel,
    channelAccountId,
    conversationId: source.conversationId,
    intentRef: created.intentRef,
    providerMessageId,
  };
}

async function insertStatus(
  fixture: AcceptedFixture,
  key: string,
  status: ProviderStatus,
  options: {
    readonly channel?: 'messenger' | 'whatsapp';
    readonly channelAccountId?: string;
    readonly occurredAt?: Date;
    readonly providerMessageId?: string;
  } = {},
): Promise<string> {
  return insertSyntheticPendingEvent(pool, {
    channel: options.channel ?? fixture.channel,
    channelAccountId: options.channelAccountId ?? fixture.channelAccountId,
    contactId: `CONTACT_TEST_status_event_${key}`,
    eventKind: 'message_status',
    externalMessageId: options.providerMessageId ?? fixture.providerMessageId,
    fixtureKey: `outbound_status_${key}`,
    messageStatus: status,
    occurredAt: options.occurredAt ?? new Date(workAt.getTime() + 10_000),
  });
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

function expectedFinal(
  sequence: readonly ProviderStatus[],
): 'delivered' | 'failed' | 'read' | 'sent' {
  if (sequence.includes('read')) return 'read';
  if (sequence.includes('delivered')) return 'delivered';
  if (sequence.includes('failed')) return 'failed';
  return 'sent';
}

describe('PostgreSQL outbound status correlation', () => {
  test('applies sent, delivered, read, and failed monotonically in every ordering', async () => {
    const repository = new PostgresOutboundStatus(pool);
    const sequences = permutations<ProviderStatus>(['sent', 'delivered', 'read', 'failed']);

    for (const [sequenceIndex, sequence] of sequences.entries()) {
      const fixture = await seedAccepted(`ordering_${String(sequenceIndex)}`);
      for (const [statusIndex, status] of sequence.entries()) {
        const eventId = await insertStatus(
          fixture,
          `ordering_${String(sequenceIndex)}_${String(statusIndex)}`,
          status,
          { occurredAt: new Date(workAt.getTime() + 10_000 + statusIndex) },
        );
        await expect(repository.applyEvent(eventId)).resolves.toMatchObject({ status: 'applied' });
      }
      const state = await pool.query<{ readonly state: string }>(
        `select state from outbound_intents where intent_ref = $1`,
        [fixture.intentRef],
      );
      expect(state.rows[0]?.state).toBe(
        expectedFinal(sequence) === 'failed' ? 'terminal_failed' : expectedFinal(sequence),
      );
    }
  });

  test('deduplicates exact replay and records logical replay without downgrading', async () => {
    const fixture = await seedAccepted('replay');
    const repository = new PostgresOutboundStatus(pool);
    const occurredAt = new Date(workAt.getTime() + 10_000);
    const firstId = await insertStatus(fixture, 'replay_exact', 'delivered', { occurredAt });
    await expect(repository.applyEvent(firstId)).resolves.toEqual({
      deliveryState: 'delivered',
      status: 'applied',
    });
    await expect(repository.applyEvent(firstId)).resolves.toEqual({ status: 'duplicate' });

    const logicalId = await insertStatus(fixture, 'replay_logical', 'delivered', { occurredAt });
    await expect(repository.applyEvent(logicalId)).resolves.toEqual({
      deliveryState: 'delivered',
      status: 'applied',
    });
    const sentId = await insertStatus(fixture, 'replay_lower_rank', 'sent');
    await expect(repository.applyEvent(sentId)).resolves.toEqual({
      deliveryState: 'delivered',
      status: 'applied',
    });
    await expect(
      pool.query(`select count(*)::int as count from outbound_status_events`),
    ).resolves.toMatchObject({ rows: [{ count: 3 }] });
  });

  test('leaves unknown, cross-account, and cross-channel provider IDs uncorrelated', async () => {
    const fixture = await seedAccepted('collision');
    const repository = new PostgresOutboundStatus(pool);
    const cases = [
      {
        key: 'unknown',
        options: { providerMessageId: 'META_MESSAGE_TEST_unknown' },
      },
      {
        key: 'cross_account',
        options: { channelAccountId: 'PHONE_TEST_outbound_status_other' },
      },
      {
        key: 'cross_channel',
        options: { channel: 'messenger' as const },
      },
    ];
    for (const item of cases) {
      const eventId = await insertStatus(fixture, item.key, 'delivered', item.options);
      await expect(repository.applyEvent(eventId)).resolves.toEqual({ status: 'uncorrelated' });
    }
    await expect(
      pool.query(`select count(*)::int as count from outbound_status_events`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    const applications = await pool.query<{ readonly count: number; readonly outcome: string }>(
      `select outcome, count(*)::int as count
       from webhook_event_applications group by outcome order by outcome`,
    );
    expect(applications.rows).toContainEqual({
      count: 3,
      outcome: 'message_status_uncorrelated',
    });
  });

  test('applies a correlated status through the conversation processor without conversation activity', async () => {
    const fixture = await seedAccepted('processor', 'messenger');
    const before = await pool.query(
      `select last_activity_at, updated_at, row_version
       from conversations where id = $1`,
      [fixture.conversationId],
    );
    const eventId = await insertStatus(fixture, 'processor', 'delivered');

    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(eventId),
    ).resolves.toEqual({
      eventId,
      outcome: 'message_status_applied',
      status: 'applied',
    });
    await expect(
      pool.query(
        `select last_activity_at, updated_at, row_version
         from conversations where id = $1`,
        [fixture.conversationId],
      ),
    ).resolves.toMatchObject({ rows: before.rows });
  });

  test('does not move retention anchors or create retention evidence', async () => {
    const fixture = await seedAccepted('retention');
    const before = await pool.query(
      `select state.*, (select count(*)::int from retention_events
                        where conversation_id = $1) as event_count
       from conversation_retention_states as state
       where state.conversation_id = $1`,
      [fixture.conversationId],
    );
    const eventId = await insertStatus(fixture, 'retention', 'read');
    await new PostgresOutboundStatus(pool).applyEvent(eventId);
    const after = await pool.query(
      `select state.*, (select count(*)::int from retention_events
                        where conversation_id = $1) as event_count
       from conversation_retention_states as state
       where state.conversation_id = $1`,
      [fixture.conversationId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  test('returns not_processable for absent or non-status events', async () => {
    const repository = new PostgresOutboundStatus(pool);
    await expect(repository.applyEvent('999999999')).resolves.toEqual({
      status: 'not_processable',
    });
    const eventId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_outbound_status_non_status',
      contactId: 'CONTACT_TEST_outbound_status_non_status',
      eventKind: 'customer_message',
      externalMessageId: 'META_MESSAGE_TEST_outbound_status_non_status',
      fixtureKey: 'outbound_status_non_status',
      messageText: 'Synthetic non-status event.',
      occurredAt: workAt,
    });
    await expect(repository.applyEvent(eventId)).resolves.toEqual({
      status: 'not_processable',
    });
  });
});
