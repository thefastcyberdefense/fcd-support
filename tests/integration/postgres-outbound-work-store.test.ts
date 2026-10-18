import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type {
  OutboundDeploymentBounds,
  OutboundPolicyValues,
} from '../../src/outbound/outbound-types.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { PostgresOutboundIntentStore } from '../../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundWorkStore } from '../../src/persistence/postgres-outbound-work-store.js';
import { PostgresRestoreFence } from '../../src/persistence/postgres-restore-fence.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const baseAt = new Date('2026-09-15T08:00:00.000Z');
const workAt = new Date('2026-09-15T11:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_work',
  roles: ['administrator'],
};
const generous = Object.freeze({
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

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_outbound_work_store');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(`
    truncate table
      contacts, webhook_receipts, privacy_suppressions, privacy_requests,
      runtime_restore_quarantine,runtime_recovery_reviews,runtime_recovery_holds,
      outbound_echo_correlation_holds, outbound_status_events,
      outbound_escalation_outcomes, outbound_attempts, outbound_intents,
      outbound_rate_windows, outbound_template_review_events,
      outbound_template_versions, outbound_policy_review_events,
      outbound_policy_versions, admin_accounts
    restart identity cascade
  `);
  await seedAdministrator();
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
     values ($1, 'synthetic.outbound.work', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x77), Buffer.alloc(32, 0x78), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_work_admin_role')`,
    [account.rows[0]?.id, baseAt],
  );
}

async function seedPolicy(values: OutboundPolicyValues = generous): Promise<void> {
  const policies = new PostgresOutboundPolicy(pool);
  await policies.createVersion(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_outbound_work',
      requestKey: 'REQUEST_TEST_outbound_work_policy_create',
      values,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await policies[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        policyRef: 'POLICY_TEST_outbound_work',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_outbound_work_policy_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
}

function identity(
  key: string,
  channel: 'messenger' | 'whatsapp' = 'whatsapp',
  accountSuffix = 'primary',
) {
  return {
    channel,
    channelAccountId:
      channel === 'whatsapp'
        ? `PHONE_TEST_outbound_work_${accountSuffix}`
        : `PAGE_TEST_outbound_work_${accountSuffix}`,
    externalContactId: `CONTACT_TEST_outbound_work_${key}`,
  };
}

async function seedIntent(
  key: string,
  options: {
    readonly channel?: 'messenger' | 'whatsapp';
    readonly accountSuffix?: string;
    readonly externalContactId?: string;
    readonly evaluatedAt?: Date;
  } = {},
) {
  const evaluatedAt = options.evaluatedAt ?? workAt;
  const selectedIdentity = identity(key, options.channel, options.accountSuffix);
  const customerIdentity =
    options.externalContactId === undefined
      ? selectedIdentity
      : { ...selectedIdentity, externalContactId: options.externalContactId };
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `outbound_work_${key}`,
    identity: customerIdentity,
    messageText: 'Synthetic customer source excluded from outbound work state.',
    occurredAt: new Date(evaluatedAt.getTime() - 60 * 60 * 1000),
  });
  await pool.query(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, state, retention_deadline, request_key, created_at)
     values ($1,$2,$3,'safe_failure','en',$4,'ready',$5,$6,$7)`,
    [
      `DRAFT_TEST_outbound_work_${key}`,
      source.eventId,
      source.conversationId,
      'Synthetic reviewed work reply excluded from intent and attempt state.',
      new Date(evaluatedAt.getTime() + 7 * 86_400_000),
      `REQUEST_TEST_outbound_work_draft_${key}`,
      new Date(evaluatedAt.getTime() - 30 * 60 * 1000),
    ],
  );
  const intents = new PostgresOutboundIntentStore(pool, syntheticPrivacyKeyring, generous);
  const created = await intents.createSupportIntent({
    draftRef: `DRAFT_TEST_outbound_work_${key}`,
    evaluatedAt,
    requestKey: `REQUEST_TEST_outbound_work_intent_${key}`,
  });
  if (created.status !== 'created') throw new Error('Synthetic outbound intent was not created');
  const authority = await pool.query<{
    readonly contact_id: string;
    readonly identity_id: string;
  }>(
    `select intent.channel_identity_id as identity_id, identity.contact_id
     from outbound_intents as intent
     join channel_identities as identity on identity.id = intent.channel_identity_id
     where intent.intent_ref = $1`,
    [created.intentRef],
  );
  return {
    ...created,
    contactId: authority.rows[0]?.contact_id ?? '',
    conversationId: source.conversationId,
    identity: customerIdentity,
    identityId: authority.rows[0]?.identity_id ?? '',
  };
}

function workStore(deployment: OutboundDeploymentBounds = generous) {
  return new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, deployment);
}

async function claimOne(
  store: PostgresOutboundWorkStore,
  claimedAt = workAt,
  workerRef = 'WORKER_TEST_primary',
) {
  const claimed = await store.claimBatch({ claimedAt, workerRef });
  const first = claimed[0];
  if (first === undefined) throw new Error('Synthetic outbound intent was not claimed');
  return first;
}

async function authorizeAndStart(
  store: PostgresOutboundWorkStore,
  claimed: { readonly intentRef: string; readonly leaseRef: string },
  evaluatedAt = workAt,
) {
  const authorized = await store.authorizeAttempt({
    evaluatedAt,
    intentRef: claimed.intentRef,
    leaseRef: claimed.leaseRef,
  });
  if (authorized.status !== 'authorized') throw new Error('Synthetic attempt was not authorized');
  await store.markDispatchStarted({
    attemptRef: authorized.attemptRef,
    leaseRef: claimed.leaseRef,
    startedAt: new Date(evaluatedAt.getTime() + 1),
  });
  return authorized;
}

describe('PostgreSQL outbound work store', () => {
  test.each(['pending', 'authorized', 'dispatch_started'] as const)(
    'restored %s work cannot resume dispatch',
    async (state) => {
      await seedPolicy();
      await seedIntent(`restore_${state}`);
      const store = workStore();
      if (state !== 'pending') {
        const claim = await claimOne(store);
        if (state === 'dispatch_started') await authorizeAndStart(store, claim);
        else
          expect(
            (
              await store.authorizeAttempt({
                intentRef: claim.intentRef,
                leaseRef: claim.leaseRef,
                evaluatedAt: workAt,
              })
            ).status,
          ).toBe('authorized');
      }
      await new PostgresRestoreFence(pool).quarantine({
        restoreRef: `RESTORE_TEST_${state}`,
        evaluatedAt: new Date(workAt.getTime() + 10),
      });
      expect((await pool.query('select state,terminal_reason from outbound_intents')).rows).toEqual(
        [
          {
            state: state === 'dispatch_started' ? 'delivery_unknown' : 'canceled',
            terminal_reason:
              state === 'dispatch_started' ? 'delivery_unknown' : 'restore_quarantined',
          },
        ],
      );
      expect(
        await store.claimBatch({
          claimedAt: new Date(workAt.getTime() + 11),
          workerRef: 'WORKER_TEST_restored',
        }),
      ).toEqual([]);
      const attempts = (await pool.query('select state from outbound_attempts')).rows;
      expect(attempts).toEqual(
        state === 'pending'
          ? []
          : [
              {
                state:
                  state === 'dispatch_started' ? 'delivery_unknown' : 'abandoned_before_dispatch',
              },
            ],
      );
    },
  );
  test('dispatch start refuses a window that closed after attempt authorization', async () => {
    await seedPolicy();
    await seedIntent('late_dispatch');
    const store = workStore();
    const authorizedAt = new Date(workAt.getTime() + 23 * 60 * 60 * 1000 - 1);
    const claim = await claimOne(store, authorizedAt);
    const authorization = await store.authorizeAttempt({
      intentRef: claim.intentRef,
      leaseRef: claim.leaseRef,
      evaluatedAt: authorizedAt,
    });
    if (authorization.status !== 'authorized')
      throw new Error('Synthetic near-window attempt missing');
    await expect(
      store.markDispatchStarted({
        attemptRef: authorization.attemptRef,
        leaseRef: claim.leaseRef,
        startedAt: new Date(authorizedAt.getTime() + 2),
      }),
    ).rejects.toThrow();
  });
  test('claims a bounded batch with SKIP LOCKED and does not duplicate leases', async () => {
    await seedPolicy({ ...generous, workerBatchSize: 2 });
    const first = await seedIntent('claim_one');
    const second = await seedIntent('claim_two');
    const third = await seedIntent('claim_three');
    const blocker = await pool.connect();
    await blocker.query('begin');
    await blocker.query('select id from outbound_intents where intent_ref = $1 for update', [
      first.intentRef,
    ]);

    try {
      const claimed = await workStore({ ...generous, workerBatchSize: 2 }).claimBatch({
        claimedAt: workAt,
        workerRef: 'WORKER_TEST_skip_locked',
      });
      expect(claimed).toHaveLength(2);
      expect(claimed.map(({ intentRef }) => intentRef).sort()).toEqual(
        [second.intentRef, third.intentRef].sort(),
      );
      await blocker.query('commit');
      const remaining = await workStore({ ...generous, workerBatchSize: 2 }).claimBatch({
        claimedAt: workAt,
        workerRef: 'WORKER_TEST_remaining',
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.intentRef).toBe(first.intentRef);
      await expect(
        workStore({ ...generous, workerBatchSize: 2 }).claimBatch({
          claimedAt: workAt,
          workerRef: 'WORKER_TEST_duplicate_claim',
        }),
      ).resolves.toEqual([]);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
  });

  test('authorizes, starts, accepts, and exactly replays one attempt', async () => {
    await seedPolicy();
    await seedIntent('accepted');
    const store = workStore();
    const claimed = await claimOne(store);
    const authorized = await store.authorizeAttempt({
      evaluatedAt: workAt,
      intentRef: claimed.intentRef,
      leaseRef: claimed.leaseRef,
    });
    expect(authorized).toMatchObject({ attemptNumber: 1, status: 'authorized' });
    if (authorized.status !== 'authorized') throw new Error('Attempt was not authorized');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: claimed.intentRef,
        leaseRef: claimed.leaseRef,
      }),
    ).resolves.toMatchObject({ attemptRef: authorized.attemptRef, status: 'duplicate' });
    const startedAt = new Date(workAt.getTime() + 1);
    await expect(
      store.markDispatchStarted({
        attemptRef: authorized.attemptRef,
        leaseRef: claimed.leaseRef,
        startedAt,
      }),
    ).resolves.toEqual({ status: 'started' });
    await expect(
      store.markDispatchStarted({
        attemptRef: authorized.attemptRef,
        leaseRef: claimed.leaseRef,
        startedAt,
      }),
    ).resolves.toEqual({ status: 'duplicate' });
    await expect(
      store.markDispatchStarted({
        attemptRef: authorized.attemptRef,
        leaseRef: 'LEASE_TEST_wrong_owner',
        startedAt,
      }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
    await expect(
      store.authorizeAttempt({
        evaluatedAt: startedAt,
        intentRef: claimed.intentRef,
        leaseRef: claimed.leaseRef,
      }),
    ).resolves.toMatchObject({ attemptRef: authorized.attemptRef, status: 'duplicate' });
    const result = {
      attemptRef: authorized.attemptRef,
      completedAt: new Date(workAt.getTime() + 2),
      leaseRef: claimed.leaseRef,
      result: {
        providerMessageId: 'META_MESSAGE_TEST_outbound_accepted',
        status: 'accepted' as const,
      },
    };
    await expect(store.recordProviderResult(result)).resolves.toEqual({
      intentState: 'provider_accepted',
      status: 'recorded',
    });
    await expect(store.recordProviderResult(result)).resolves.toEqual({
      intentState: 'provider_accepted',
      status: 'duplicate',
    });
    await expect(
      store.recordProviderResult({
        ...result,
        result: { ...result.result, providerMessageId: 'META_MESSAGE_TEST_conflict' },
      }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
  });

  test('enforces lease ownership and invalid state transitions', async () => {
    await seedPolicy();
    await seedIntent('lease_owner');
    const store = workStore();
    const claimed = await claimOne(store);
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: claimed.intentRef,
        leaseRef: 'LEASE_TEST_wrong_owner',
      }),
    ).resolves.toEqual({ reason: 'lease_invalid', status: 'denied' });
    await expect(
      store.markDispatchStarted({
        attemptRef: 'ATTEMPT_TEST_missing',
        leaseRef: claimed.leaseRef,
        startedAt: workAt,
      }),
    ).rejects.toThrow('not found');
  });

  test('rechecks send-time eligibility after claim before reserving capacity', async () => {
    await seedPolicy();
    const fixture = await seedIntent('late_pause');
    const store = workStore();
    const claimed = await claimOne(store);
    await pool.query(
      `update conversations set ai_paused_until = $2, updated_at = $3
       where id = $1`,
      [fixture.conversationId, new Date(workAt.getTime() + 60_000), workAt],
    );

    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: claimed.intentRef,
        leaseRef: claimed.leaseRef,
      }),
    ).resolves.toEqual({ reason: 'pause_active', status: 'denied' });
    await expect(
      pool.query(
        `select
           (select count(*)::int from outbound_attempts) as attempts,
           (select count(*)::int from outbound_rate_windows) as windows`,
      ),
    ).resolves.toMatchObject({ rows: [{ attempts: 0, windows: 0 }] });
  });

  test('schedules bounded definite retry then terminally exhausts it once', async () => {
    await seedPolicy({ ...generous, maximumDefiniteRetries: 1 });
    await seedIntent('retry');
    const store = workStore({ ...generous, maximumDefiniteRetries: 1 });
    const firstClaim = await claimOne(store);
    const first = await authorizeAndStart(store, firstClaim);
    const firstCompletedAt = new Date(workAt.getTime() + 2);
    const providerRetryAfter = new Date(firstCompletedAt.getTime() + 500);
    const firstResult = {
      attemptRef: first.attemptRef,
      completedAt: firstCompletedAt,
      leaseRef: firstClaim.leaseRef,
      result: {
        reasonCode: 'provider_rejected' as const,
        retryAfter: providerRetryAfter,
        status: 'definitely_rejected' as const,
      },
    };
    await expect(store.recordProviderResult(firstResult)).resolves.toEqual({
      intentState: 'pending',
      nextAttemptAt: new Date(firstCompletedAt.getTime() + 1000),
      status: 'recorded',
    });
    await expect(store.recordProviderResult(firstResult)).resolves.toEqual({
      intentState: 'pending',
      nextAttemptAt: new Date(firstCompletedAt.getTime() + 1000),
      status: 'duplicate',
    });

    const retryAt = new Date(firstCompletedAt.getTime() + 1000);
    const secondClaim = await claimOne(store, retryAt, 'WORKER_TEST_retry_two');
    const second = await authorizeAndStart(store, secondClaim, retryAt);
    const secondResult = {
      attemptRef: second.attemptRef,
      completedAt: new Date(retryAt.getTime() + 2),
      leaseRef: secondClaim.leaseRef,
      result: {
        reasonCode: 'provider_rejected' as const,
        retryAfter: undefined,
        status: 'definitely_rejected' as const,
      },
    };
    await expect(store.recordProviderResult(secondResult)).resolves.toEqual({
      intentState: 'terminal_failed',
      status: 'recorded',
    });
    await expect(store.recordProviderResult(secondResult)).resolves.toEqual({
      intentState: 'terminal_failed',
      status: 'duplicate',
    });
    await expect(
      pool.query(
        `select count(*)::int as count from outbound_escalation_outcomes
         where reason_code = 'retry_exhausted'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  test('expires pre-dispatch work safely and post-dispatch work as unknown', async () => {
    await seedPolicy();
    await seedIntent('expire_unstarted');
    const store = workStore();
    const unstarted = await claimOne(store);
    await expect(
      store.expireLeases({ expiredAt: unstarted.leaseExpiresAt, limit: 10 }),
    ).resolves.toEqual({ deliveryUnknown: 0, returnedToPending: 1 });

    const reclaimed = await claimOne(store, unstarted.leaseExpiresAt, 'WORKER_TEST_reclaimed');
    const authorized = await store.authorizeAttempt({
      evaluatedAt: unstarted.leaseExpiresAt,
      intentRef: reclaimed.intentRef,
      leaseRef: reclaimed.leaseRef,
    });
    if (authorized.status !== 'authorized') throw new Error('Reclaimed attempt was not authorized');
    await expect(
      store.expireLeases({ expiredAt: reclaimed.leaseExpiresAt, limit: 10 }),
    ).resolves.toEqual({ deliveryUnknown: 0, returnedToPending: 1 });

    const nextClaim = await claimOne(store, reclaimed.leaseExpiresAt, 'WORKER_TEST_dispatched');
    await authorizeAndStart(store, nextClaim, reclaimed.leaseExpiresAt);
    await expect(
      store.expireLeases({ expiredAt: nextClaim.leaseExpiresAt, limit: 10 }),
    ).resolves.toEqual({ deliveryUnknown: 1, returnedToPending: 0 });
    await expect(
      pool.query(
        `select intent.state, intent.terminal_reason,
                (select count(*)::int from outbound_escalation_outcomes
                 where intent_id = intent.id and reason_code = 'delivery_unknown') as escalations
         from outbound_intents as intent where intent.intent_ref = $1`,
        [nextClaim.intentRef],
      ),
    ).resolves.toMatchObject({
      rows: [{ escalations: 1, state: 'delivery_unknown', terminal_reason: 'delivery_unknown' }],
    });
  });

  test('returns an explicit aborted-before-dispatch result to pending', async () => {
    await seedPolicy();
    await seedIntent('aborted');
    const store = workStore();
    const claimed = await claimOne(store);
    const authorized = await store.authorizeAttempt({
      evaluatedAt: workAt,
      intentRef: claimed.intentRef,
      leaseRef: claimed.leaseRef,
    });
    if (authorized.status !== 'authorized') throw new Error('Attempt was not authorized');
    await expect(
      store.recordProviderResult({
        attemptRef: authorized.attemptRef,
        completedAt: new Date(workAt.getTime() + 1),
        leaseRef: claimed.leaseRef,
        result: { status: 'aborted_before_dispatch' },
      }),
    ).resolves.toEqual({
      intentState: 'pending',
      nextAttemptAt: new Date(workAt.getTime() + 1),
      status: 'recorded',
    });
  });

  test('serializes customized per-contact 15-minute limits and creates no denied attempt', async () => {
    await seedPolicy();
    const sharedContact = 'CONTACT_TEST_outbound_work_shared_rate';
    await seedIntent('contact_rate_one', { externalContactId: sharedContact });
    await seedIntent('contact_rate_two', { externalContactId: sharedContact });
    const deployment = {
      ...generous,
      perContact15Minute: 1,
      perContact24Hour: 1000,
    };
    const store = workStore(deployment);
    const claimed = await store.claimBatch({
      claimedAt: workAt,
      workerRef: 'WORKER_TEST_contact_rate',
    });
    expect(claimed).toHaveLength(2);
    const decisions = await Promise.all([
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: claimed[0]?.intentRef ?? '',
        leaseRef: claimed[0]?.leaseRef ?? '',
      }),
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: claimed[1]?.intentRef ?? '',
        leaseRef: claimed[1]?.leaseRef ?? '',
      }),
    ]);
    expect(decisions.filter(({ status }) => status === 'authorized')).toHaveLength(1);
    expect(decisions.filter(({ status }) => status === 'denied')).toEqual([
      { reason: 'limit_exhausted', status: 'denied' },
    ]);
    await expect(
      pool.query('select count(*)::int as count from outbound_attempts'),
    ).resolves.toMatchObject({
      rows: [{ count: 1 }],
    });
  });

  test('enforces the independent rolling per-contact 24-hour limit', async () => {
    await seedPolicy();
    const sharedContact = 'CONTACT_TEST_outbound_work_shared_daily_rate';
    await seedIntent('contact_day_one', { externalContactId: sharedContact });
    await seedIntent('contact_day_two', { externalContactId: sharedContact });
    const store = workStore({
      ...generous,
      perContact15Minute: 1,
      perContact24Hour: 1,
      workerBatchSize: 1,
    });
    const first = await claimOne(store, workAt, 'WORKER_TEST_contact_day_one');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: first.intentRef,
        leaseRef: first.leaseRef,
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
    const afterShortWindow = new Date(workAt.getTime() + 15 * 60_000);
    const second = await claimOne(store, afterShortWindow, 'WORKER_TEST_contact_day_two');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: afterShortWindow,
        intentRef: second.intentRef,
        leaseRef: second.leaseRef,
      }),
    ).resolves.toEqual({ reason: 'limit_exhausted', status: 'denied' });
  });

  test('shares per-contact limits across linked WhatsApp and Messenger identities', async () => {
    await seedPolicy();
    const whatsapp = await seedIntent('linked_contact_whatsapp');
    const messenger = await seedIntent('linked_contact_messenger', { channel: 'messenger' });
    await pool.query(`update channel_identities set contact_id = $1 where id = $2`, [
      whatsapp.contactId,
      messenger.identityId,
    ]);
    const store = workStore({
      ...generous,
      perContact15Minute: 1,
      perContact24Hour: 1,
    });
    const claimed = await store.claimBatch({
      claimedAt: workAt,
      workerRef: 'WORKER_TEST_linked_contact',
    });
    const decisions = await Promise.all(
      claimed.map((claim) =>
        store.authorizeAttempt({
          evaluatedAt: workAt,
          intentRef: claim.intentRef,
          leaseRef: claim.leaseRef,
        }),
      ),
    );
    expect(decisions.filter(({ status }) => status === 'authorized')).toHaveLength(1);
    expect(decisions.filter(({ status }) => status === 'denied')).toEqual([
      { reason: 'limit_exhausted', status: 'denied' },
    ]);
  });

  test('separates WhatsApp and Messenger account-minute scopes', async () => {
    await seedPolicy();
    await seedIntent('account_wa_one');
    await seedIntent('account_wa_two');
    await seedIntent('account_messenger_one', { channel: 'messenger' });
    await seedIntent('account_messenger_two', { channel: 'messenger' });
    const store = workStore({
      ...generous,
      messengerAccount1Minute: 1,
      whatsappAccount1Minute: 1,
    });
    const claimed = await store.claimBatch({
      claimedAt: workAt,
      workerRef: 'WORKER_TEST_accounts',
    });
    const whatsapp = claimed.filter(({ channel }) => channel === 'whatsapp');
    const messenger = claimed.filter(({ channel }) => channel === 'messenger');
    expect(whatsapp).toHaveLength(2);
    expect(messenger).toHaveLength(2);
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: whatsapp[0]?.intentRef ?? '',
        leaseRef: whatsapp[0]?.leaseRef ?? '',
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: whatsapp[1]?.intentRef ?? '',
        leaseRef: whatsapp[1]?.leaseRef ?? '',
      }),
    ).resolves.toEqual({ reason: 'limit_exhausted', status: 'denied' });
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: messenger[0]?.intentRef ?? '',
        leaseRef: messenger[0]?.leaseRef ?? '',
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: messenger[1]?.intentRef ?? '',
        leaseRef: messenger[1]?.leaseRef ?? '',
      }),
    ).resolves.toEqual({ reason: 'limit_exhausted', status: 'denied' });
  });

  test('enforces global minute capacity and opens it at the exact boundary', async () => {
    await seedPolicy();
    await seedIntent('global_boundary_one');
    await seedIntent('global_boundary_two');
    await seedIntent('global_boundary_three');
    const store = workStore({ ...generous, global1Minute: 1, workerBatchSize: 1 });
    const first = await claimOne(store);
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: first.intentRef,
        leaseRef: first.leaseRef,
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
    const beforeBoundary = new Date(workAt.getTime() + 59_999);
    const second = await claimOne(store, beforeBoundary, 'WORKER_TEST_before_boundary');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: beforeBoundary,
        intentRef: second.intentRef,
        leaseRef: second.leaseRef,
      }),
    ).resolves.toEqual({ reason: 'limit_exhausted', status: 'denied' });
    const boundary = new Date(workAt.getTime() + 60_000);
    const third = await claimOne(store, boundary, 'WORKER_TEST_boundary');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: boundary,
        intentRef: third.intentRef,
        leaseRef: third.leaseRef,
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
  });

  test('enforces the global UTC-day limit and resets at midnight', async () => {
    await seedPolicy();
    await seedIntent('global_day_one');
    await seedIntent('global_day_two');
    const nextDay = new Date('2026-09-16T00:00:00.000Z');
    await seedIntent('global_day_three', { evaluatedAt: nextDay });
    const store = workStore({
      ...generous,
      global1Minute: 1,
      globalUtcDay: 1,
      workerBatchSize: 1,
    });
    const first = await claimOne(store);
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: first.intentRef,
        leaseRef: first.leaseRef,
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
    const withinDay = new Date(workAt.getTime() + 60_000);
    const second = await claimOne(store, withinDay, 'WORKER_TEST_day_two');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: withinDay,
        intentRef: second.intentRef,
        leaseRef: second.leaseRef,
      }),
    ).resolves.toEqual({ reason: 'limit_exhausted', status: 'denied' });
    const third = await claimOne(store, nextDay, 'WORKER_TEST_next_day');
    await expect(
      store.authorizeAttempt({
        evaluatedAt: nextDay,
        intentRef: third.intentRef,
        leaseRef: third.leaseRef,
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
  });

  test('rolls a timed-out rate lock back and permits a clean retry', async () => {
    await seedPolicy();
    const fixture = await seedIntent('rate_lock');
    const store = workStore();
    const claimed = await claimOne(store);
    const blocker = await pool.connect();
    await blocker.query('begin');
    const scope = `contact_15_minute:${fixture.contactId}`;
    await blocker.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 7100516::bigint))`,
      [scope],
    );
    try {
      await expect(
        store.authorizeAttempt({
          evaluatedAt: workAt,
          intentRef: claimed.intentRef,
          leaseRef: claimed.leaseRef,
        }),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `select (select count(*)::int from outbound_attempts) as attempts,
                  (select count(*)::int from outbound_rate_windows) as windows`,
        ),
      ).resolves.toMatchObject({ rows: [{ attempts: 0, windows: 0 }] });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    await expect(
      store.authorizeAttempt({
        evaluatedAt: workAt,
        intentRef: claimed.intentRef,
        leaseRef: claimed.leaseRef,
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
  });
});
