import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type {
  EffectiveModelPolicy,
  ModelPolicyValues,
} from '../../src/model/model-policy-types.js';
import type {
  ModelDeploymentCeilings,
  ModelOperationalLimits,
} from '../../src/model/model-types.js';
import { PostgresModelAllowance } from '../../src/persistence/postgres-model-allowance.js';
import { PostgresModelPolicy } from '../../src/persistence/postgres-model-policy.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import { insertSyntheticAppliedCustomerEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let policyService: PostgresModelPolicy;
let allowance: PostgresModelAllowance;

const baseAt = new Date('2026-09-13T06:00:00.000Z');
const administrator = {
  reviewerRef: 'ADMIN_TEST_allowance',
  roles: ['administrator'],
} as const;
const balanced: ModelPolicyValues = Object.freeze({
  approvedProviderAttempts: 3,
  architectureProviderCeiling: 5,
  concurrentCalls: 4,
  cooldownMs: 0,
  faqAmbiguityMargin: 0.05,
  faqMinimumSimilarity: 0.7,
  globalUtcDayCalls: 300,
  maximumFaqCandidates: 10,
  outputTokens: 600,
  perContact15MinuteCalls: 3,
  perContact24HourCalls: 20,
  queueCapacity: 25,
  totalTimeoutMs: 20_000,
});

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('model_allowance');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(
    `truncate table contacts, webhook_receipts, model_policy_versions, admin_accounts
     restart identity cascade`,
  );
  policyService = new PostgresModelPolicy(pool);
  allowance = new PostgresModelAllowance(pool);
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.allowance', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x71), Buffer.alloc(32, 0x72), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2, 'REQUEST_TEST_allowance_role')`,
    [account.rows[0]?.id, baseAt],
  );
});

afterAll(async () => {
  await dispose?.();
});

async function activePolicy(
  overrides: Partial<ModelPolicyValues> = {},
  policyRef = 'POLICY_TEST_allowance',
  offsetSeconds = 0,
): Promise<Extract<EffectiveModelPolicy, { readonly status: 'enabled' }>> {
  const values = { ...balanced, ...overrides };
  const createdAt = new Date(baseAt.getTime() + offsetSeconds * 1000 + 1000);
  await policyService.createPolicy(
    {
      createdAt,
      createdByAccountRef: administrator.reviewerRef,
      policyRef,
      requestKey: `REQUEST_TEST_create_${policyRef}`,
      values,
    },
    administrator,
  );
  for (const [index, action] of ['submit', 'approve', 'activate'].entries()) {
    await policyService.transitionPolicy(
      {
        action,
        effectiveAt: new Date(createdAt.getTime() + (index + 1) * 1000),
        policyRef,
        reasonCode: `${action}_reviewed`,
        requestKey: `REQUEST_TEST_${action}_${policyRef}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
  const operational: ModelOperationalLimits = {
    concurrentCalls: values.concurrentCalls,
    cooldownMs: values.cooldownMs,
    globalUtcDayCalls: values.globalUtcDayCalls,
    outputTokens: values.outputTokens,
    perContact15MinuteCalls: values.perContact15MinuteCalls,
    perContact24HourCalls: values.perContact24HourCalls,
    providerAttempts: values.approvedProviderAttempts,
    queueCapacity: values.queueCapacity,
    totalTimeoutMs: values.totalTimeoutMs,
  };
  const deployment: ModelDeploymentCeilings = {
    ...operational,
    architectureProviderConnections: values.architectureProviderCeiling,
    contextItems: 20,
    inputCodePoints: 4000,
    responseBytes: 8192,
  };
  const resolved = await policyService.resolveEffectivePolicy(
    new Date(createdAt.getTime() + 4000),
    deployment,
    { operationalLimits: operational, verified: true },
  );
  if (resolved.status !== 'enabled') throw new Error('Synthetic active policy did not resolve');
  return resolved;
}

async function source(
  key: string,
  occurredAt = new Date(baseAt.getTime() + 5000),
  contactKey = key,
) {
  return insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `allowance_${key}`,
    identity: {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_allowance',
      externalContactId: `PSID_TEST_allowance_${contactKey}`,
    },
    occurredAt,
  });
}

function input(
  fixture: Awaited<ReturnType<typeof source>>,
  logicalCallKey: string,
  effectivePolicy: Extract<EffectiveModelPolicy, { readonly status: 'enabled' }>,
  evaluatedAt = new Date(baseAt.getTime() + 6000),
) {
  return {
    conversationId: fixture.conversationId,
    effectivePolicy,
    evaluatedAt,
    logicalCallKey,
    webhookEventId: fixture.eventId,
  };
}

describe('PostgreSQL model allowance and leases', () => {
  test('maintenance expiry respects its supplied batch bound', async () => {
    const policy = await activePolicy();
    for (const key of ['bounded_one', 'bounded_two']) {
      await allowance.acquireModelAllowance(input(await source(key), `CALL_TEST_${key}`, policy));
    }
    const expiredAt = new Date(baseAt.getTime() + 60000);
    expect(await allowance.expireLeases(expiredAt, 1)).toEqual({ expiredCount: 1 });
    expect(await allowance.expireLeases(expiredAt, 1)).toEqual({ expiredCount: 1 });
  });
  test('enforces 3/15-minute and 20/24-hour contact limits without double-counting replay', async () => {
    const policy = await activePolicy();
    const first = await source('contact_shared');
    const firstInput = input(first, 'CALL_TEST_contact_1', policy);
    await expect(allowance.acquireModelAllowance(firstInput)).resolves.toMatchObject({
      leaseState: 'active',
      status: 'acquired',
    });
    await expect(allowance.acquireModelAllowance(firstInput)).resolves.toMatchObject({
      leaseState: 'active',
      status: 'duplicate',
    });
    await allowance.completeLease({
      completedAt: new Date(baseAt.getTime() + 7000),
      logicalCallKey: 'CALL_TEST_contact_1',
      outcomeCode: 'completed',
    });

    for (const index of [2, 3]) {
      const next = await source(
        `contact_shared_${String(index)}`,
        new Date(baseAt.getTime() + 5000 + index),
        'contact_shared',
      );
      const acquired = await allowance.acquireModelAllowance(
        input(next, `CALL_TEST_contact_${String(index)}`, policy),
      );
      expect(acquired.status).toBe('acquired');
      await allowance.completeLease({
        completedAt: new Date(baseAt.getTime() + 7000 + index),
        logicalCallKey: `CALL_TEST_contact_${String(index)}`,
        outcomeCode: 'completed',
      });
    }
    const fourth = await source(
      'contact_shared_4',
      new Date(baseAt.getTime() + 5010),
      'contact_shared',
    );
    await expect(
      allowance.acquireModelAllowance(input(fourth, 'CALL_TEST_contact_4', policy)),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'rate_limited' });

    await pool.query(
      `update model_usage_windows set call_count = 20
       where window_kind = 'contact_24_hour'`,
    );
    const later = await source(
      'contact_shared_24h',
      new Date(baseAt.getTime() + 16 * 60_000),
      'contact_shared',
    );
    await expect(
      allowance.acquireModelAllowance(
        input(later, 'CALL_TEST_contact_24h', policy, new Date(baseAt.getTime() + 16 * 60_000)),
      ),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'rate_limited' });
  });

  test('enforces the 300-call UTC day boundary', async () => {
    const policy = await activePolicy({
      perContact15MinuteCalls: 100,
      perContact24HourCalls: 300,
    });
    const first = await source('global_first');
    await allowance.acquireModelAllowance(input(first, 'CALL_TEST_global_first', policy));
    await allowance.completeLease({
      completedAt: new Date(baseAt.getTime() + 7000),
      logicalCallKey: 'CALL_TEST_global_first',
      outcomeCode: 'completed',
    });
    await pool.query(
      `update model_usage_windows set call_count = 300 where window_kind = 'global_utc_day'`,
    );
    const next = await source('global_next');
    await expect(
      allowance.acquireModelAllowance(input(next, 'CALL_TEST_global_next', policy)),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'global_limit' });
  });

  test('keeps the contact 24-hour limit rolling across a UTC-day boundary', async () => {
    const policy = await activePolicy({
      perContact15MinuteCalls: 2,
      perContact24HourCalls: 3,
    });
    const times = [
      new Date('2026-09-13T23:20:00.000Z'),
      new Date('2026-09-13T23:40:00.000Z'),
      new Date('2026-09-13T23:59:00.000Z'),
    ];
    for (const [index, evaluatedAt] of times.entries()) {
      const fixture = await source(`rolling_${String(index)}`, evaluatedAt, 'rolling_shared');
      const logicalCallKey = `CALL_TEST_rolling_${String(index)}`;
      await expect(
        allowance.acquireModelAllowance(input(fixture, logicalCallKey, policy, evaluatedAt)),
      ).resolves.toMatchObject({ status: 'acquired' });
      await allowance.completeLease({
        completedAt: new Date(evaluatedAt.getTime() + 1),
        logicalCallKey,
        outcomeCode: 'completed',
      });
    }
    const afterMidnight = new Date('2026-09-14T00:01:00.000Z');
    const fourth = await source('rolling_4', afterMidnight, 'rolling_shared');
    await expect(
      allowance.acquireModelAllowance(input(fourth, 'CALL_TEST_rolling_4', policy, afterMidnight)),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'rate_limited' });
  });

  test('serializes a concurrent contact burst without exceeding the reviewed limit', async () => {
    const policy = await activePolicy();
    const evaluatedAt = new Date(baseAt.getTime() + 6000);
    const fixtures = await Promise.all(
      Array.from({ length: 6 }, async (_unused, index) =>
        source(`burst_${String(index)}`, evaluatedAt, 'burst_shared'),
      ),
    );
    const results = await Promise.all(
      fixtures.map(async (fixture, index) =>
        allowance.acquireModelAllowance(
          input(fixture, `CALL_TEST_burst_${String(index)}`, policy, evaluatedAt),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'acquired')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'denied')).toEqual([
      { status: 'denied', reasonCode: 'rate_limited' },
      { status: 'denied', reasonCode: 'rate_limited' },
      { status: 'denied', reasonCode: 'rate_limited' },
    ]);
  });

  test('allows four active and twenty-five queued calls, then fails closed', async () => {
    const policy = await activePolicy({
      perContact15MinuteCalls: 100,
      perContact24HourCalls: 300,
    });
    for (let index = 0; index < 29; index += 1) {
      const fixture = await source(`capacity_${String(index)}`);
      const result = await allowance.acquireModelAllowance(
        input(fixture, `CALL_TEST_capacity_${String(index)}`, policy),
      );
      expect(result).toMatchObject({
        leaseState: index < 4 ? 'active' : 'queued',
        status: 'acquired',
      });
    }
    const overflow = await source('capacity_overflow');
    await expect(
      allowance.acquireModelAllowance(input(overflow, 'CALL_TEST_capacity_overflow', policy)),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'queue_full' });

    const expiredAt = new Date(baseAt.getTime() + 27_000);
    await expect(allowance.expireLeases(expiredAt)).resolves.toEqual({ expiredCount: 29 });
    const afterExpiry = await source('capacity_after_expiry', expiredAt);
    await expect(
      allowance.acquireModelAllowance(
        input(afterExpiry, 'CALL_TEST_capacity_after_expiry', policy, expiredAt),
      ),
    ).resolves.toMatchObject({ leaseState: 'active', status: 'acquired' });
  }, 20_000);

  test('enforces cooldown and promotes a queued lease only when capacity is free', async () => {
    const cooldownPolicy = await activePolicy({
      concurrentCalls: 1,
      cooldownMs: 1000,
      queueCapacity: 2,
    });
    const first = await source('cooldown_shared');
    await allowance.acquireModelAllowance(input(first, 'CALL_TEST_cooldown_1', cooldownPolicy));
    await allowance.completeLease({
      completedAt: new Date(baseAt.getTime() + 6500),
      logicalCallKey: 'CALL_TEST_cooldown_1',
      outcomeCode: 'completed',
    });
    const early = await source(
      'cooldown_shared_early',
      new Date(baseAt.getTime() + 6600),
      'cooldown_shared',
    );
    await expect(
      allowance.acquireModelAllowance(
        input(early, 'CALL_TEST_cooldown_early', cooldownPolicy, new Date(baseAt.getTime() + 6600)),
      ),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'cooldown' });

    const holder = await source('holder', new Date(baseAt.getTime() + 8000));
    await allowance.acquireModelAllowance(
      input(holder, 'CALL_TEST_holder', cooldownPolicy, new Date(baseAt.getTime() + 8000)),
    );
    const queued = await source('queued', new Date(baseAt.getTime() + 8001));
    await expect(
      allowance.acquireModelAllowance(
        input(queued, 'CALL_TEST_queued', cooldownPolicy, new Date(baseAt.getTime() + 8001)),
      ),
    ).resolves.toMatchObject({ leaseState: 'queued', status: 'acquired' });
    await expect(
      allowance.activateLease({
        activatedAt: new Date(baseAt.getTime() + 9000),
        effectivePolicy: cooldownPolicy,
        logicalCallKey: 'CALL_TEST_queued',
      }),
    ).resolves.toEqual({ status: 'queued' });
    await allowance.completeLease({
      completedAt: new Date(baseAt.getTime() + 9500),
      logicalCallKey: 'CALL_TEST_holder',
      outcomeCode: 'completed',
    });
    await expect(
      allowance.activateLease({
        activatedAt: new Date(baseAt.getTime() + 10_000),
        effectivePolicy: cooldownPolicy,
        logicalCallKey: 'CALL_TEST_queued',
      }),
    ).resolves.toEqual({ status: 'activated' });
  });

  test('rejects fabricated policy provenance, source conflicts, and stale policy after replacement', async () => {
    const policy = await activePolicy();
    const fixture = await source('conflict');
    const command = input(fixture, 'CALL_TEST_conflict', policy);
    await allowance.acquireModelAllowance(command);
    await expect(
      allowance.acquireModelAllowance({ ...command, logicalCallKey: 'CALL_TEST_conflicting_key' }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
    await expect(
      allowance.acquireModelAllowance({
        ...command,
        effectivePolicy: { ...policy },
      }),
    ).rejects.toThrow('provenance');

    await policyService.transitionPolicy(
      {
        action: 'retire',
        effectiveAt: new Date(baseAt.getTime() + 30_000),
        policyRef: policy.policyRef,
        reasonCode: 'retire_reviewed',
        requestKey: 'REQUEST_TEST_retire_old_allowance',
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
    const nextPolicy = await activePolicy({}, 'POLICY_TEST_replacement', 25);
    const stale = await source('stale_policy', new Date(baseAt.getTime() + 31_000));
    await expect(
      allowance.acquireModelAllowance(
        input(stale, 'CALL_TEST_stale_policy', policy, new Date(baseAt.getTime() + 31_000)),
      ),
    ).resolves.toEqual({ status: 'denied', reasonCode: 'policy_disabled' });
    expect(nextPolicy.policyRef).toBe('POLICY_TEST_replacement');
  });
});
