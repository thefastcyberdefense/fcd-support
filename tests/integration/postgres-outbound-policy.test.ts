import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import type { OutboundDeploymentBounds } from '../../src/outbound/outbound-types.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let policies: PostgresOutboundPolicy;

const at = new Date('2026-09-15T03:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_policy',
  roles: ['administrator'],
};
const values = Object.freeze({
  global1Minute: 150,
  globalUtcDay: 1000,
  leaseMs: 30_000,
  maximumDefiniteRetries: 3,
  messengerAccount1Minute: 100,
  perContact15Minute: 4,
  perContact24Hour: 40,
  providerTimeoutMs: 10_000,
  retryBaseMs: 1000,
  retryMaximumMs: 60_000,
  whatsappAccount1Minute: 100,
  workerBatchSize: 20,
});
const deployment = Object.freeze({
  global1Minute: 120,
  globalUtcDay: 900,
  leaseMs: 25_000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 80,
  perContact15Minute: 3,
  perContact24Hour: 30,
  providerTimeoutMs: 8000,
  retryBaseMs: 5000,
  retryMaximumMs: 30_000,
  whatsappAccount1Minute: 90,
  workerBatchSize: 10,
}) satisfies OutboundDeploymentBounds;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('outbound_policy');
  disposeDatabase = database.dispose;
  pool = database.pool;
  policies = new PostgresOutboundPolicy(pool);
});

afterEach(async () => {
  await pool.query(`
    truncate table
      outbound_echo_correlation_holds, outbound_status_events,
      outbound_escalation_outcomes, outbound_attempts, outbound_intents,
      outbound_rate_windows, outbound_template_review_events,
      outbound_template_versions, outbound_policy_review_events,
      outbound_policy_versions, admin_accounts
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
     values ($1, 'synthetic.outbound.policy', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x71), Buffer.alloc(32, 0x72), at],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_policy_admin_role')`,
    [account.rows[0]?.id, at],
  );
}

function createInput(
  policyRef = 'POLICY_TEST_outbound_primary',
  requestKey = 'REQUEST_TEST_outbound_policy_create',
) {
  return {
    createdAt: new Date(at.getTime() + 1000),
    createdByAccountRef: administrator.reviewerRef,
    policyRef,
    requestKey,
    values,
  };
}

function command(policyRef: string, seconds: number, suffix: string) {
  return {
    effectiveAt: new Date(at.getTime() + seconds * 1000),
    policyRef,
    reasonCode: 'reviewed_outbound_policy',
    requestKey: `REQUEST_TEST_outbound_policy_${suffix}`,
    reviewerAccountRef: administrator.reviewerRef,
  };
}

async function approve(policyRef: string, offset = 0): Promise<void> {
  await policies.submitVersion(
    command(policyRef, 2 + offset, `${policyRef}_submit`),
    administrator,
  );
  await policies.approveVersion(
    command(policyRef, 3 + offset, `${policyRef}_approve`),
    administrator,
  );
}

describe('PostgreSQL outbound policy', () => {
  test('creates immutable versions with exact replay and conflict detection', async () => {
    await seedAdministrator();
    const input = createInput();

    await expect(policies.createVersion(input, administrator)).resolves.toEqual({
      policyRef: input.policyRef,
      status: 'applied',
    });
    await expect(policies.createVersion(input, administrator)).resolves.toEqual({
      policyRef: input.policyRef,
      status: 'duplicate',
    });
    await expect(
      policies.createVersion(
        { ...input, values: { ...values, globalUtcDay: 1001 } },
        administrator,
      ),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
  });

  test('requires the matching authoritative administrator identity', async () => {
    await seedAdministrator();
    await expect(
      policies.createVersion(createInput(), {
        reviewerRef: administrator.reviewerRef,
        roles: ['support_reviewer'],
      }),
    ).rejects.toThrow('administrator');
    await expect(
      policies.createVersion(createInput(), {
        reviewerRef: 'ADMIN_TEST_wrong_outbound_actor',
        roles: ['administrator'],
      }),
    ).rejects.toThrow('identity');
  });

  test('separates submit, approve, activate, and retire with exact replay', async () => {
    await seedAdministrator();
    await policies.createVersion(createInput(), administrator);
    const submit = command('POLICY_TEST_outbound_primary', 2, 'submit_replay');

    await expect(policies.submitVersion(submit, administrator)).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(policies.submitVersion(submit, administrator)).resolves.toMatchObject({
      status: 'duplicate',
    });
    await expect(
      policies.submitVersion({ ...submit, reasonCode: 'changed' }, administrator),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
    await policies.approveVersion(
      command('POLICY_TEST_outbound_primary', 3, 'approve'),
      administrator,
    );
    await policies.activateVersion(
      command('POLICY_TEST_outbound_primary', 4, 'activate'),
      administrator,
    );
    await policies.retireVersion(
      command('POLICY_TEST_outbound_primary', 5, 'retire'),
      administrator,
    );
    await expect(
      pool.query(`select action from outbound_policy_review_events order by effective_at, id`),
    ).resolves.toMatchObject({
      rows: [
        { action: 'submit' },
        { action: 'approve' },
        { action: 'activate' },
        { action: 'retire' },
      ],
    });
  });

  test('resolves event-time policy and intersects every customizable bound', async () => {
    await seedAdministrator();
    await policies.createVersion(createInput(), administrator);
    await approve('POLICY_TEST_outbound_primary');
    await policies.activateVersion(
      command('POLICY_TEST_outbound_primary', 10, 'activate_effective'),
      administrator,
    );

    await expect(
      policies.resolveEffectivePolicy(new Date(at.getTime() + 9000), deployment),
    ).resolves.toEqual({ reasonCode: 'no_active_policy', status: 'disabled' });
    await expect(
      policies.resolveEffectivePolicy(new Date(at.getTime() + 11_000), deployment),
    ).resolves.toMatchObject({
      policyRef: 'POLICY_TEST_outbound_primary',
      status: 'enabled',
      values: {
        global1Minute: 120,
        globalUtcDay: 900,
        leaseMs: 25_000,
        maximumDefiniteRetries: 2,
        messengerAccount1Minute: 80,
        perContact15Minute: 3,
        perContact24Hour: 30,
        providerTimeoutMs: 8000,
        retryBaseMs: 5000,
        retryMaximumMs: 60_000,
        whatsappAccount1Minute: 90,
        workerBatchSize: 10,
      },
    });
  });

  test('serializes concurrent activation so at most one policy is active', async () => {
    await seedAdministrator();
    await policies.createVersion(
      createInput('POLICY_TEST_outbound_one', 'REQUEST_TEST_outbound_create_one'),
      administrator,
    );
    await policies.createVersion(
      createInput('POLICY_TEST_outbound_two', 'REQUEST_TEST_outbound_create_two'),
      administrator,
    );
    await approve('POLICY_TEST_outbound_one', 0);
    await approve('POLICY_TEST_outbound_two', 10);

    const outcomes = await Promise.allSettled([
      policies.activateVersion(
        command('POLICY_TEST_outbound_one', 30, 'activate_one'),
        administrator,
      ),
      policies.activateVersion(
        command('POLICY_TEST_outbound_two', 30, 'activate_two'),
        administrator,
      ),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(
      pool.query(
        `select count(*)::int as count
         from outbound_policy_versions where state = 'active'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  test('rolls an invalid review transition back without partial evidence', async () => {
    await seedAdministrator();
    await policies.createVersion(createInput(), administrator);

    await expect(
      policies.approveVersion(
        command('POLICY_TEST_outbound_primary', 2, 'approve_without_submit'),
        administrator,
      ),
    ).rejects.toThrow('Invalid outbound policy review transition');
    await expect(
      pool.query(
        `select policy.state, count(event.id)::int as event_count
         from outbound_policy_versions as policy
         left join outbound_policy_review_events as event
           on event.policy_version_id = policy.id
         where policy.policy_ref = 'POLICY_TEST_outbound_primary'
         group by policy.state`,
      ),
    ).resolves.toMatchObject({ rows: [{ event_count: 0, state: 'draft' }] });
  });
});
