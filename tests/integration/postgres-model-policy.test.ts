import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import type {
  ModelDeploymentCeilings,
  ModelOperationalLimits,
} from '../../src/model/model-types.js';
import { PostgresModelPolicy } from '../../src/persistence/postgres-model-policy.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let policies: PostgresModelPolicy;

const at = new Date('2026-09-13T02:00:00Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_model_policy',
  roles: ['administrator'],
};
const values = Object.freeze({
  approvedProviderAttempts: 3,
  architectureProviderCeiling: 5,
  concurrentCalls: 4,
  cooldownMs: 1000,
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
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('model_policy');
  disposeDatabase = database.dispose;
  pool = database.pool;
  policies = new PostgresModelPolicy(pool);
});

afterEach(async () => {
  await pool.query(`
    truncate table
      model_call_leases, model_usage_windows,
      model_policy_review_events, model_policy_versions,
      admin_accounts
    restart identity cascade
  `);
});

afterAll(async () => {
  await disposeDatabase?.();
});

async function seedAdministrator(): Promise<void> {
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.model.policy', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x61), Buffer.alloc(32, 0x62), at],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2, 'REQUEST_TEST_model_admin_role')`,
    [account.rows[0]?.id, at],
  );
}

function createInput(policyRef = 'POLICY_TEST_primary', requestKey = 'REQUEST_TEST_policy_create') {
  return {
    createdAt: new Date(at.getTime() + 1000),
    createdByAccountRef: administrator.reviewerRef,
    policyRef,
    requestKey,
    values,
  };
}

async function transition(
  policyRef: string,
  action: 'activate' | 'approve' | 'retire' | 'submit',
  seconds: number,
  suffix = policyRef,
) {
  return policies.transitionPolicy(
    {
      action,
      effectiveAt: new Date(at.getTime() + seconds * 1000),
      policyRef,
      reasonCode: `${action}_reviewed`,
      requestKey: `REQUEST_TEST_${action}_${suffix}`,
      reviewerAccountRef: administrator.reviewerRef,
    },
    administrator,
  );
}

async function approve(policyRef: string, offset = 0): Promise<void> {
  await transition(policyRef, 'submit', 2 + offset, `${policyRef}_${String(offset)}`);
  await transition(policyRef, 'approve', 3 + offset, `${policyRef}_${String(offset)}`);
}

const deployment: ModelDeploymentCeilings = Object.freeze({
  architectureProviderConnections: 4,
  concurrentCalls: 3,
  contextItems: 20,
  cooldownMs: 2000,
  globalUtcDayCalls: 250,
  inputCodePoints: 4000,
  outputTokens: 500,
  perContact15MinuteCalls: 2,
  perContact24HourCalls: 18,
  providerAttempts: 2,
  queueCapacity: 20,
  responseBytes: 8192,
  totalTimeoutMs: 15_000,
});
const manifestLimits: ModelOperationalLimits = Object.freeze({
  concurrentCalls: 2,
  cooldownMs: 3000,
  globalUtcDayCalls: 240,
  outputTokens: 450,
  perContact15MinuteCalls: 2,
  perContact24HourCalls: 17,
  providerAttempts: 1,
  queueCapacity: 15,
  totalTimeoutMs: 12_000,
});

describe('PostgreSQL model policy', () => {
  test('creates an immutable policy with exact replay and conflict detection', async () => {
    await seedAdministrator();
    const input = createInput();

    await expect(policies.createPolicy(input, administrator)).resolves.toEqual({
      policyRef: input.policyRef,
      status: 'applied',
    });
    await expect(policies.createPolicy(input, administrator)).resolves.toEqual({
      policyRef: input.policyRef,
      status: 'duplicate',
    });
    await expect(
      policies.createPolicy({ ...input, values: { ...values, outputTokens: 601 } }, administrator),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);

    const row = await pool.query<{ readonly column_default: string | null }>(
      `select column_default from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'model_policy_versions'
         and column_name = 'output_tokens'`,
    );
    expect(row.rows).toEqual([{ column_default: null }]);
  });

  test('requires an authoritative administrator identity and matching actor', async () => {
    await seedAdministrator();
    await expect(
      policies.createPolicy(createInput(), {
        reviewerRef: administrator.reviewerRef,
        roles: ['knowledge_editor'],
      }),
    ).rejects.toThrow('administrator');
    await expect(
      policies.createPolicy(createInput(), {
        reviewerRef: 'ADMIN_TEST_wrong_actor',
        roles: ['administrator'],
      }),
    ).rejects.toThrow('identity');
  });

  test('resolves only the effective active policy and takes every stricter source', async () => {
    await seedAdministrator();
    await policies.createPolicy(createInput(), administrator);
    await approve('POLICY_TEST_primary');
    await transition('POLICY_TEST_primary', 'activate', 10);

    await expect(
      policies.resolveEffectivePolicy(new Date(at.getTime() + 9000), deployment, {
        operationalLimits: manifestLimits,
        verified: true,
      }),
    ).resolves.toEqual({ status: 'disabled', reasonCode: 'no_active_policy' });
    await expect(
      policies.resolveEffectivePolicy(new Date(at.getTime() + 11_000), deployment, undefined),
    ).resolves.toEqual({ status: 'disabled', reasonCode: 'manifest_limits_unverified' });

    const active = await policies.resolveEffectivePolicy(
      new Date(at.getTime() + 11_000),
      deployment,
      { operationalLimits: manifestLimits, verified: true },
    );
    if (active.status !== 'enabled') throw new Error('Synthetic policy was not active');
    expect(active.policyVersionId).toMatch(/^\d+$/u);
    expect(active).toEqual({
      faq: { ambiguityMargin: 0.05, maximumCandidates: 10, minimumSimilarity: 0.7 },
      limits: {
        concurrentCalls: 2,
        cooldownMs: 3000,
        globalUtcDayCalls: 240,
        outputTokens: 450,
        perContact15MinuteCalls: 2,
        perContact24HourCalls: 17,
        providerAttempts: 1,
        queueCapacity: 15,
        totalTimeoutMs: 12_000,
      },
      policyRef: 'POLICY_TEST_primary',
      policyVersionId: active.policyVersionId,
      status: 'enabled',
    });

    await transition('POLICY_TEST_primary', 'retire', 20);
    await expect(
      policies.resolveEffectivePolicy(new Date(at.getTime() + 21_000), deployment, {
        operationalLimits: manifestLimits,
        verified: true,
      }),
    ).resolves.toEqual({ status: 'disabled', reasonCode: 'no_active_policy' });
  });

  test('replays exact transitions and rejects conflicting reuse', async () => {
    await seedAdministrator();
    await policies.createPolicy(createInput(), administrator);
    const command = {
      action: 'submit' as const,
      effectiveAt: new Date(at.getTime() + 2000),
      policyRef: 'POLICY_TEST_primary',
      reasonCode: 'submit_reviewed',
      requestKey: 'REQUEST_TEST_transition_replay',
      reviewerAccountRef: administrator.reviewerRef,
    };
    await expect(policies.transitionPolicy(command, administrator)).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(policies.transitionPolicy(command, administrator)).resolves.toMatchObject({
      status: 'duplicate',
    });
    await expect(
      policies.transitionPolicy({ ...command, reasonCode: 'changed' }, administrator),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
  });

  test('serializes concurrent activation so at most one policy becomes active', async () => {
    await seedAdministrator();
    await policies.createPolicy(
      createInput('POLICY_TEST_one', 'REQUEST_TEST_create_one'),
      administrator,
    );
    await policies.createPolicy(
      createInput('POLICY_TEST_two', 'REQUEST_TEST_create_two'),
      administrator,
    );
    await approve('POLICY_TEST_one', 0);
    await approve('POLICY_TEST_two', 10);

    const outcomes = await Promise.allSettled([
      transition('POLICY_TEST_one', 'activate', 30, 'one'),
      transition('POLICY_TEST_two', 'activate', 30, 'two'),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(
      pool.query(`select count(*)::int as count from model_policy_versions where state = 'active'`),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
