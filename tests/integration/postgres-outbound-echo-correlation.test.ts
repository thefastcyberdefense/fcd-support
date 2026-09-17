import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { OutboundDeploymentBounds } from '../../src/outbound/outbound-types.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresOutboundEchoCorrelation } from '../../src/persistence/postgres-outbound-echo-correlation.js';
import { PostgresOutboundIntentStore } from '../../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundWorkStore } from '../../src/persistence/postgres-outbound-work-store.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const baseAt = new Date('2026-09-17T12:00:00.000Z');
const workAt = new Date('2026-09-17T15:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_echo',
  roles: ['administrator'],
};
const bounds = Object.freeze({
  global1Minute: 100,
  globalUtcDay: 10_000,
  leaseMs: 30_000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 100,
  perContact15Minute: 100,
  perContact24Hour: 1000,
  providerTimeoutMs: 8000,
  retryBaseMs: 1000,
  retryMaximumMs: 8000,
  whatsappAccount1Minute: 100,
  workerBatchSize: 20,
}) satisfies OutboundDeploymentBounds;

interface IntentFixture {
  readonly conversationId: string;
  readonly draftRef: string;
  readonly identity: {
    readonly channel: 'messenger';
    readonly channelAccountId: string;
    readonly externalContactId: string;
  };
  readonly intentRef: string;
}

interface StartedFixture extends IntentFixture {
  readonly attemptRef: string;
  readonly leaseRef: string;
}

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_outbound_echo_correlation');
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
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.outbound.echo', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x7d), Buffer.alloc(32, 0x7e), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_echo_admin_role')`,
    [account.rows[0]?.id, baseAt],
  );
  const policies = new PostgresOutboundPolicy(pool);
  await policies.createVersion(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_outbound_echo',
      requestKey: 'REQUEST_TEST_outbound_echo_policy_create',
      values: bounds,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await policies[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        policyRef: 'POLICY_TEST_outbound_echo',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_outbound_echo_policy_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
});

afterAll(async () => {
  await dispose?.();
});

async function createIntent(key: string, occurredAt = new Date(workAt.getTime() - 3_600_000)) {
  const identity = {
    channel: 'messenger' as const,
    channelAccountId: 'PAGE_TEST_outbound_echo',
    externalContactId: 'PSID_TEST_outbound_echo',
  };
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `outbound_echo_source_${key}`,
    identity,
    messageText: 'Synthetic customer source excluded from echo evidence.',
    occurredAt,
  });
  const draftRef = `DRAFT_TEST_outbound_echo_${key}`;
  await pool.query(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, state, retention_deadline, request_key, created_at)
     values ($1,$2,$3,'safe_failure','en',$4,'ready',$5,$6,$7)`,
    [
      draftRef,
      source.eventId,
      source.conversationId,
      `Synthetic reviewed echo reply ${key}.`,
      new Date(workAt.getTime() + 7 * 86_400_000),
      `REQUEST_TEST_outbound_echo_draft_${key}`,
      new Date(workAt.getTime() - 30 * 60 * 1000),
    ],
  );
  const created = await new PostgresOutboundIntentStore(
    pool,
    syntheticPrivacyKeyring,
    bounds,
  ).createSupportIntent({
    draftRef,
    evaluatedAt: workAt,
    requestKey: `REQUEST_TEST_outbound_echo_intent_${key}`,
  });
  if (created.status !== 'created') throw new Error('Synthetic echo intent was not created');
  return {
    conversationId: source.conversationId,
    draftRef,
    identity,
    intentRef: created.intentRef,
  } satisfies IntentFixture;
}

async function startIntent(fixture: IntentFixture): Promise<StartedFixture> {
  const store = new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds);
  const claim = (
    await store.claimBatch({
      claimedAt: workAt,
      workerRef: `WORKER_TEST_${fixture.draftRef}`,
    })
  ).find(({ intentRef }) => intentRef === fixture.intentRef);
  if (claim === undefined) throw new Error('Synthetic echo intent was not claimed');
  const authorized = await store.authorizeAttempt({
    evaluatedAt: workAt,
    intentRef: claim.intentRef,
    leaseRef: claim.leaseRef,
  });
  if (authorized.status !== 'authorized')
    throw new Error('Synthetic echo attempt was not authorized');
  await store.markDispatchStarted({
    attemptRef: authorized.attemptRef,
    leaseRef: claim.leaseRef,
    startedAt: new Date(workAt.getTime() + 1),
  });
  return { ...fixture, attemptRef: authorized.attemptRef, leaseRef: claim.leaseRef };
}

async function acceptAttempt(fixture: StartedFixture, providerMessageId: string): Promise<void> {
  await new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds).recordProviderResult({
    attemptRef: fixture.attemptRef,
    completedAt: new Date(workAt.getTime() + 2),
    leaseRef: fixture.leaseRef,
    result: { providerMessageId, status: 'accepted' },
  });
}

async function insertEcho(
  fixture: IntentFixture,
  key: string,
  externalMessageId: string,
  occurredAt = new Date(workAt.getTime() + 3),
): Promise<string> {
  return insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: fixture.identity.channelAccountId,
    contactId: fixture.identity.externalContactId,
    eventKind: 'business_message_echo',
    externalMessageId,
    fixtureKey: `outbound_echo_${key}`,
    messageText: `Synthetic echo ${key}.`,
    occurredAt,
  });
}

describe('PostgreSQL Messenger outbound echo correlation', () => {
  test('correlates an exact echo after provider acceptance without pausing or activity movement', async () => {
    const started = await startIntent(await createIntent('accepted_exact'));
    const providerMessageId = 'META_MESSAGE_TEST_echo_accepted_exact';
    await acceptAttempt(started, providerMessageId);
    const before = await pool.query(
      `select ai_paused_until, last_activity_at, updated_at, row_version
       from conversations where id = $1`,
      [started.conversationId],
    );
    const eventId = await insertEcho(started, 'accepted_exact', providerMessageId);

    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(eventId),
    ).resolves.toEqual({
      conversationId: started.conversationId,
      eventId,
      outcome: 'service_echo_correlated',
      status: 'applied',
    });
    await expect(
      pool.query(
        `select ai_paused_until, last_activity_at, updated_at, row_version
         from conversations where id = $1`,
        [started.conversationId],
      ),
    ).resolves.toMatchObject({ rows: before.rows });
    await expect(
      pool.query(`select count(*)::int as count from human_pause_events`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  test('holds an echo before the response and correlates it when the provider ID arrives', async () => {
    const started = await startIntent(await createIntent('before_response'));
    const providerMessageId = 'META_MESSAGE_TEST_echo_before_response';
    const eventId = await insertEcho(started, 'before_response', providerMessageId);
    const processor = new PostgresConversationEventProcessor(pool);

    await expect(processor.processEvent(eventId)).resolves.toEqual({
      eventId,
      status: 'correlation_pending',
    });
    await expect(
      pool.query(
        `select state, created_at, expires_at, source_webhook_event_id
         from outbound_echo_correlation_holds`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          created_at: new Date(workAt.getTime() + 1),
          expires_at: new Date(workAt.getTime() + 1 + bounds.providerTimeoutMs),
          source_webhook_event_id: null,
          state: 'open',
        },
      ],
    });
    await expect(
      pool.query(
        `select count(*)::int as count from webhook_event_applications where webhook_event_id = $1`,
        [eventId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await acceptAttempt(started, providerMessageId);

    await expect(processor.processEvent(eventId)).resolves.toEqual({
      conversationId: started.conversationId,
      eventId,
      outcome: 'service_echo_correlated',
      status: 'already_applied',
    });
    await expect(
      pool.query(
        `select state, resolution_code, source_webhook_event_id
         from outbound_echo_correlation_holds`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          resolution_code: 'self_echo',
          source_webhook_event_id: eventId,
          state: 'correlated',
        },
      ],
    });
    await expect(
      pool.query(`select outcome from webhook_event_applications where webhook_event_id = $1`, [
        eventId,
      ]),
    ).resolves.toMatchObject({ rows: [{ outcome: 'service_echo_correlated' }] });
    await expect(
      pool.query(`select count(*)::int as count from human_pause_events`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  test('resolves concurrent provider acceptance and echo processing without a false pause', async () => {
    const started = await startIntent(await createIntent('acceptance_race'));
    const providerMessageId = 'META_MESSAGE_TEST_echo_acceptance_race';
    const eventId = await insertEcho(started, 'acceptance_race', providerMessageId);
    const processor = new PostgresConversationEventProcessor(pool);

    const [processed] = await Promise.all([
      processor.processEvent(eventId),
      acceptAttempt(started, providerMessageId),
    ]);

    expect(
      processed.status === 'correlation_pending' ||
        (processed.status === 'applied' && processed.outcome === 'service_echo_correlated') ||
        (processed.status === 'already_applied' && processed.outcome === 'service_echo_correlated'),
    ).toBe(true);
    await expect(
      pool.query(
        `select application.outcome, hold.state, hold.resolution_code
         from webhook_event_applications as application
         join outbound_echo_correlation_holds as hold
           on hold.source_webhook_event_id = application.webhook_event_id
         where application.webhook_event_id = $1`,
        [eventId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          outcome: 'service_echo_correlated',
          resolution_code: 'self_echo',
          state: 'correlated',
        },
      ],
    });
    await expect(
      pool.query(`select count(*)::int as count from human_pause_events`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  test('turns a pre-response provider-ID mismatch into the authoritative human pause', async () => {
    const started = await startIntent(await createIntent('mismatch'));
    const eventId = await insertEcho(started, 'mismatch', 'META_MESSAGE_TEST_echo_expected');
    const correlation = new PostgresOutboundEchoCorrelation(pool);
    await expect(correlation.processBusinessEcho(eventId)).resolves.toEqual({
      status: 'correlation_pending',
    });

    await acceptAttempt(started, 'META_MESSAGE_TEST_echo_different');

    await expect(correlation.processBusinessEcho(eventId)).resolves.toEqual({
      status: 'duplicate',
    });
    await expect(
      pool.query(
        `select application.outcome, pause.effective_at, pause.resulting_pause_until
         from webhook_event_applications as application
         join human_pause_events as pause
           on pause.source_webhook_event_id = application.webhook_event_id
         where application.webhook_event_id = $1`,
        [eventId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          effective_at: new Date(workAt.getTime() + 3),
          outcome: 'business_echo_paused',
          resulting_pause_until: new Date(workAt.getTime() + 3 + 86_400_000),
        },
      ],
    });
  });

  test('applies an echo with no known attempt as authoritative human activity', async () => {
    const fixture = await createIntent('attempt_unknown');
    const eventId = await insertEcho(
      fixture,
      'attempt_unknown',
      'META_MESSAGE_TEST_echo_attempt_unknown',
    );

    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(eventId),
    ).resolves.toEqual({
      conversationId: fixture.conversationId,
      eventId,
      outcome: 'business_echo_paused',
      status: 'applied',
    });
    await expect(
      pool.query(`select effective_at from human_pause_events where source_webhook_event_id = $1`, [
        eventId,
      ]),
    ).resolves.toMatchObject({ rows: [{ effective_at: new Date(workAt.getTime() + 3) }] });
  });

  test('never correlates by text when the provider ID is unknown', async () => {
    const started = await startIntent(await createIntent('text_only'));
    await acceptAttempt(started, 'META_MESSAGE_TEST_echo_real_id');
    const eventId = await insertEcho(started, 'text_only', 'META_MESSAGE_TEST_echo_wrong_id');
    await pool.query(`update webhook_events set message_text = $2 where id = $1`, [
      eventId,
      'Synthetic reviewed echo reply text_only.',
    ]);

    await expect(
      new PostgresOutboundEchoCorrelation(pool).processBusinessEcho(eventId),
    ).resolves.toEqual({ status: 'human_pause_applied' });
    await expect(
      pool.query(`select outcome from webhook_event_applications where webhook_event_id = $1`, [
        eventId,
      ]),
    ).resolves.toMatchObject({ rows: [{ outcome: 'business_echo_paused' }] });
  });

  test('expires a pending hold and applies the echo pause from provider time', async () => {
    const started = await startIntent(await createIntent('hold_expiry'));
    const eventId = await insertEcho(started, 'hold_expiry', 'META_MESSAGE_TEST_echo_expiry');
    const correlation = new PostgresOutboundEchoCorrelation(pool);
    await correlation.processBusinessEcho(eventId);

    await expect(
      correlation.resolveExpiredHolds({
        evaluatedAt: new Date(workAt.getTime() + 1 + bounds.providerTimeoutMs),
        limit: 10,
      }),
    ).resolves.toEqual({ paused: 1, selfEchoes: 0 });
    await expect(
      pool.query(`select state, resolution_code from outbound_echo_correlation_holds`),
    ).resolves.toMatchObject({
      rows: [{ resolution_code: 'hold_expired', state: 'expired' }],
    });
    await expect(
      pool.query(`select outcome from webhook_event_applications where webhook_event_id = $1`, [
        eventId,
      ]),
    ).resolves.toMatchObject({ rows: [{ outcome: 'business_echo_paused' }] });
  });

  test('applies a pending echo as human after the dispatch attempt expires', async () => {
    const started = await startIntent(await createIntent('attempt_expiry'));
    const eventId = await insertEcho(
      started,
      'attempt_expiry',
      'META_MESSAGE_TEST_echo_attempt_expiry',
    );
    const correlation = new PostgresOutboundEchoCorrelation(pool);
    await correlation.processBusinessEcho(eventId);
    await new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds).expireLeases({
      expiredAt: new Date(workAt.getTime() + bounds.leaseMs),
      limit: 10,
    });

    await expect(correlation.processBusinessEcho(eventId)).resolves.toEqual({
      status: 'human_pause_applied',
    });
  });

  test('serializes concurrent dispatch starts so only one hold can open', async () => {
    const first = await createIntent('concurrent_first');
    const second = await createIntent('concurrent_second', new Date(workAt.getTime() - 3_500_000));
    const store = new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds);
    const claims = await store.claimBatch({
      claimedAt: workAt,
      workerRef: 'WORKER_TEST_echo_concurrent',
    });
    const firstClaim = claims.find(({ intentRef }) => intentRef === first.intentRef);
    const secondClaim = claims.find(({ intentRef }) => intentRef === second.intentRef);
    if (firstClaim === undefined || secondClaim === undefined) {
      throw new Error('Both synthetic concurrent intents must be claimed');
    }
    const [firstAuthorized, secondAuthorized] = await Promise.all([
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: firstClaim.intentRef,
        leaseRef: firstClaim.leaseRef,
      }),
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: secondClaim.intentRef,
        leaseRef: secondClaim.leaseRef,
      }),
    ]);
    if (firstAuthorized.status !== 'authorized' || secondAuthorized.status !== 'authorized') {
      throw new Error('Both synthetic concurrent attempts must be authorized before dispatch');
    }

    const results = await Promise.allSettled([
      store.markDispatchStarted({
        attemptRef: firstAuthorized.attemptRef,
        leaseRef: firstClaim.leaseRef,
        startedAt: new Date(workAt.getTime() + 1),
      }),
      store.markDispatchStarted({
        attemptRef: secondAuthorized.attemptRef,
        leaseRef: secondClaim.leaseRef,
        startedAt: new Date(workAt.getTime() + 1),
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toMatchObject([
      { reason: { name: 'PolicyIdempotencyConflictError' } },
    ]);
    await expect(
      pool.query(
        `select count(*)::int as count
         from outbound_echo_correlation_holds where state = 'open'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  test('refuses dispatch when an actual staff echo wins the start race', async () => {
    const fixture = await createIntent('staff_echo_wins');
    const store = new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds);
    const claim = (
      await store.claimBatch({
        claimedAt: workAt,
        workerRef: 'WORKER_TEST_echo_staff_wins',
      })
    ).find(({ intentRef }) => intentRef === fixture.intentRef);
    if (claim === undefined) throw new Error('Synthetic staff-race intent was not claimed');
    const authorized = await store.authorizeAttempt({
      evaluatedAt: workAt,
      intentRef: claim.intentRef,
      leaseRef: claim.leaseRef,
    });
    if (authorized.status !== 'authorized') {
      throw new Error('Synthetic staff-race attempt was not authorized');
    }
    const eventId = await insertEcho(
      fixture,
      'staff_echo_wins',
      'META_MESSAGE_TEST_echo_staff_wins',
    );
    await new PostgresConversationEventProcessor(pool).processEvent(eventId);

    await expect(
      store.markDispatchStarted({
        attemptRef: authorized.attemptRef,
        leaseRef: claim.leaseRef,
        startedAt: new Date(workAt.getTime() + 4),
      }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    await expect(
      pool.query(
        `select attempt.state,
                (select count(*)::int from outbound_echo_correlation_holds) as hold_count
         from outbound_attempts as attempt where attempt.attempt_ref = $1`,
        [authorized.attemptRef],
      ),
    ).resolves.toMatchObject({ rows: [{ hold_count: 0, state: 'authorized' }] });
  });

  test('allows only one in-flight attempt and blocks later enqueue and send while its hold is open', async () => {
    const first = await createIntent('guard_first');
    const second = await createIntent('guard_second', new Date(workAt.getTime() - 3_500_000));
    await startIntent(first);
    const secondLease = await pool.query<{ readonly lease_ref: string }>(
      `select lease_ref from outbound_intents where intent_ref = $1`,
      [second.intentRef],
    );
    const leaseRef = secondLease.rows[0]?.lease_ref;
    if (leaseRef === undefined) throw new Error('Second synthetic intent was not leased');
    await expect(
      new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds).authorizeAttempt({
        evaluatedAt: new Date(workAt.getTime() + 2),
        intentRef: second.intentRef,
        leaseRef,
      }),
    ).resolves.toEqual({ reason: 'echo_correlation_hold', status: 'denied' });

    const source = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'outbound_echo_guard_enqueue_source',
      identity: first.identity,
      messageText: 'Synthetic later source blocked by correlation hold.',
      occurredAt: new Date(workAt.getTime() + 3),
    });
    const draftRef = 'DRAFT_TEST_outbound_echo_guard_enqueue';
    await pool.query(
      `insert into support_reply_drafts
         (draft_ref, source_webhook_event_id, conversation_id, decision_type,
          language, answer_text, state, retention_deadline, request_key, created_at)
       values ($1,$2,$3,'safe_failure','en',$4,'ready',$5,$6,$7)`,
      [
        draftRef,
        source.eventId,
        source.conversationId,
        'Synthetic later reply blocked by correlation hold.',
        new Date(workAt.getTime() + 7 * 86_400_000),
        'REQUEST_TEST_outbound_echo_guard_enqueue_draft',
        new Date(workAt.getTime() + 4),
      ],
    );
    await expect(
      new PostgresOutboundIntentStore(pool, syntheticPrivacyKeyring, bounds).createSupportIntent({
        draftRef,
        evaluatedAt: new Date(workAt.getTime() + 5),
        requestKey: 'REQUEST_TEST_outbound_echo_guard_enqueue_intent',
      }),
    ).resolves.toEqual({ reason: 'echo_correlation_hold', status: 'denied' });
    await expect(
      pool.query(
        `select count(*)::int as count from outbound_echo_correlation_holds where state = 'open'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
