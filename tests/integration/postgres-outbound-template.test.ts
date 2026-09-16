import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { PostgresOutboundTemplate } from '../../src/persistence/postgres-outbound-template.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let templates: PostgresOutboundTemplate;

const at = new Date('2026-09-15T04:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_template',
  roles: ['administrator'],
};

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('outbound_template');
  disposeDatabase = database.dispose;
  pool = database.pool;
  templates = new PostgresOutboundTemplate(pool);
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
     values ($1, 'synthetic.outbound.template', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x73), Buffer.alloc(32, 0x74), at],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_template_admin_role')`,
    [account.rows[0]?.id, at],
  );
}

function createInput(
  requestKey = 'REQUEST_TEST_outbound_template_create',
  contentSha256 = 'a'.repeat(64),
) {
  return {
    category: 'customer_support' as const,
    channel: 'whatsapp' as const,
    channelAccountId: 'PHONE_TEST_outbound_template',
    contentSha256,
    createdAt: new Date(at.getTime() + 1000),
    locale: 'en_US' as const,
    providerTemplateId: 'META_TEMPLATE_TEST_outbound_support',
    requestKey,
    templateName: 'synthetic_outbound_support',
    templateRef: 'TEMPLATE_TEST_outbound_support',
  };
}

function command(versionNumber: number, seconds: number, suffix: string) {
  return {
    effectiveAt: new Date(at.getTime() + seconds * 1000),
    reasonCode: 'reviewed_outbound_template',
    requestKey: `REQUEST_TEST_outbound_template_${suffix}`,
    reviewerAccountRef: administrator.reviewerRef,
    templateRef: 'TEMPLATE_TEST_outbound_support',
    versionNumber,
  };
}

describe('PostgreSQL outbound fixed templates', () => {
  test('creates immutable versions with exact replay and conflict detection', async () => {
    await seedAdministrator();
    const input = createInput();
    await expect(templates.createVersion(input, administrator)).resolves.toEqual({
      status: 'applied',
      templateRef: input.templateRef,
      versionNumber: 1,
    });
    await expect(templates.createVersion(input, administrator)).resolves.toEqual({
      status: 'duplicate',
      templateRef: input.templateRef,
      versionNumber: 1,
    });
    await expect(
      templates.createVersion({ ...input, contentSha256: 'b'.repeat(64) }, administrator),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
  });

  test('requires matching administrator authority', async () => {
    await seedAdministrator();
    await expect(
      templates.createVersion(createInput(), {
        reviewerRef: administrator.reviewerRef,
        roles: ['knowledge_reviewer'],
      }),
    ).rejects.toThrow('administrator');
    await expect(
      templates.createVersion(createInput(), {
        reviewerRef: 'ADMIN_TEST_wrong_template_actor',
        roles: ['administrator'],
      }),
    ).rejects.toThrow('identity');
  });

  test('reviews, activates, resolves exact scope, and retires one version', async () => {
    await seedAdministrator();
    await templates.createVersion(createInput(), administrator);
    await templates.submitVersion(command(1, 2, 'submit'), administrator);
    await templates.approveVersion(command(1, 3, 'approve'), administrator);
    await templates.activateVersion(command(1, 10, 'activate'), administrator);

    await expect(
      templates.resolveEffectiveTemplate({
        category: 'customer_support',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST_outbound_template',
        evaluatedAt: new Date(at.getTime() + 9000),
        locale: 'en_US',
        templateRef: 'TEMPLATE_TEST_outbound_support',
      }),
    ).resolves.toEqual({ reasonCode: 'no_active_template', status: 'disabled' });
    await expect(
      templates.resolveEffectiveTemplate({
        category: 'customer_support',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST_outbound_template',
        evaluatedAt: new Date(at.getTime() + 11_000),
        locale: 'en_US',
        templateRef: 'TEMPLATE_TEST_outbound_support',
      }),
    ).resolves.toMatchObject({
      category: 'customer_support',
      locale: 'en_US',
      providerTemplateId: 'META_TEMPLATE_TEST_outbound_support',
      status: 'enabled',
      templateName: 'synthetic_outbound_support',
      variableCount: 0,
      versionNumber: 1,
    });
    await expect(
      templates.resolveEffectiveTemplate({
        category: 'customer_support',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST_other_account',
        evaluatedAt: new Date(at.getTime() + 11_000),
        locale: 'en_US',
        templateRef: 'TEMPLATE_TEST_outbound_support',
      }),
    ).resolves.toEqual({ reasonCode: 'no_active_template', status: 'disabled' });

    await templates.retireVersion(command(1, 20, 'retire'), administrator);
    await expect(
      templates.resolveEffectiveTemplate({
        category: 'customer_support',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST_outbound_template',
        evaluatedAt: new Date(at.getTime() + 21_000),
        locale: 'en_US',
        templateRef: 'TEMPLATE_TEST_outbound_support',
      }),
    ).resolves.toEqual({ reasonCode: 'no_active_template', status: 'disabled' });
  });

  test('supports a reviewed replacement version and exact transition replay', async () => {
    await seedAdministrator();
    await templates.createVersion(createInput(), administrator);
    const second = createInput('REQUEST_TEST_outbound_template_create_v2', 'b'.repeat(64));
    await expect(templates.createVersion(second, administrator)).resolves.toMatchObject({
      versionNumber: 2,
    });
    const submit = command(2, 2, 'submit_v2');
    await expect(templates.submitVersion(submit, administrator)).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(templates.submitVersion(submit, administrator)).resolves.toMatchObject({
      status: 'duplicate',
    });
    await expect(
      templates.submitVersion({ ...submit, reasonCode: 'changed' }, administrator),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
  });

  test('serializes concurrent activation so at most one template version is active', async () => {
    await seedAdministrator();
    await templates.createVersion(createInput(), administrator);
    await templates.createVersion(
      createInput('REQUEST_TEST_outbound_template_concurrent_v2', 'c'.repeat(64)),
      administrator,
    );
    await templates.submitVersion(command(1, 2, 'concurrent_submit_v1'), administrator);
    await templates.approveVersion(command(1, 3, 'concurrent_approve_v1'), administrator);
    await templates.submitVersion(command(2, 4, 'concurrent_submit_v2'), administrator);
    await templates.approveVersion(command(2, 5, 'concurrent_approve_v2'), administrator);

    const outcomes = await Promise.allSettled([
      templates.activateVersion(command(1, 10, 'concurrent_activate_v1'), administrator),
      templates.activateVersion(command(2, 10, 'concurrent_activate_v2'), administrator),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(
      pool.query(
        `select count(*)::int as count
         from outbound_template_versions where state = 'active'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
