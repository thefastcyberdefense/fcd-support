import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import { buildAdminApp } from '../../src/admin/admin-app.js';
import { PostgresAdminDashboard } from '../../src/persistence/postgres-admin-dashboard.js';
import { PostgresAdminIdentity } from '../../src/persistence/postgres-admin-identity.js';
import { PostgresAdminOperations } from '../../src/persistence/postgres-admin-operations.js';
import { PostgresLearningService } from '../../src/persistence/postgres-learning-service.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { insertSyntheticAppliedCustomerEvent } from './policy-fixtures.js';
import {
  createIsolatedTestDatabase,
  requireIsolatedTestDatabaseUrl,
  type IsolatedTestDatabase,
} from './test-database.js';

let database: IsolatedTestDatabase;
let root: string;
const rolePrefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const passwords: Record<string, string> = {};
const passwordFiles: Record<string, string> = {};
const pools = new Map<string, pg.Pool>();
const cleanups: (() => Promise<void>)[] = [];

const at = new Date('2026-11-03T06:00:00.000Z');
const now = () => new Date(at);

const seedAdmin = new AdminSecretBytes(Buffer.alloc(20, 0x61));
const seedReviewer = new AdminSecretBytes(Buffer.alloc(20, 0x62));
const seedEditor = new AdminSecretBytes(Buffer.alloc(20, 0x64));
const seedRevoked = new AdminSecretBytes(Buffer.alloc(20, 0x63));

const totpPolicy = {
  algorithm: 'sha1',
  digits: 6,
  periodSeconds: 30,
  verificationWindow: 0,
} as const;

const learningPolicy = {
  minimumGroupCount: 3,
  digestIntervalMilliseconds: 259_200_000,
  maximumQuestionsPerDigest: 5,
  questionCooldownMilliseconds: 604_800_000,
  maximumDigestAppearances: 2,
  maximumObservationsPerRun: 1000,
} as const;

function connectionFor(role: string): string {
  const url = new URL(database.connectionString);
  url.username = `${rolePrefix}_${role}`;
  url.password = passwords[role] ?? '';
  return url.toString();
}

function poolFor(role: string): pg.Pool {
  const prior = pools.get(role);
  if (prior !== undefined) return prior;
  const pool = new pg.Pool({
    connectionString: connectionFor(role),
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 3000,
  });
  pools.set(role, pool);
  return pool;
}

let identity: PostgresAdminIdentity;
let dashboard: PostgresAdminDashboard;
let operations: PostgresAdminOperations;
let app: ReturnType<typeof buildAdminApp>;
let adminCookies: string;
let reviewerCookies: string;
let editorCookies: string;
let revokedCookies: string;
let revokedSessionToken: string;

beforeAll(async () => {
  database = await createIsolatedTestDatabase('admin_dashboard_grants');
  cleanups.push(() => database.dispose());

  root = await mkdtemp(join(tmpdir(), 'fcd-admin-grants-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);

  for (const role of [...runtimeDatabaseRoles, 'migrator']) {
    const path = join(root, role);
    const password = `synthetic_${rolePrefix}_${role}_password_only`;
    passwords[role] = password;
    passwordFiles[role] = path;
    await writeFile(path, password, { mode: 0o600 });
  }

  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });

  const adminPool = poolFor('admin');

  identity = new PostgresAdminIdentity(adminPool, {
    mfaProtector: new AesGcmAdminSecretProtector(
      'synthetic_test_v1',
      new AdminSecretBytes(Buffer.alloc(32, 0x65)),
    ),
    now,
    passwordPolicy: {
      algorithm: 'scrypt_v1',
      blockSize: 8,
      cost: 16384,
      keyLength: 32,
      parallelization: 1,
      saltLength: 16,
    },
    preauthenticationTtlMilliseconds: 300000,
    sessionHmacKey: new AdminSecretBytes(Buffer.alloc(32, 0x66)),
    sessionTtlMilliseconds: 3600000,
    totpPolicy,
  });

  dashboard = new PostgresAdminDashboard(adminPool, identity, { now, learningPolicy });
  operations = new PostgresAdminOperations(adminPool, identity, { now });

  app = buildAdminApp({
    dashboard,
    identity,
    operations,
    now,
    origin: 'http://127.0.0.1:3000',
    secureCookie: false,
  });

  // 1. Create administrator account via initial_bootstrap
  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_lead',
      loginName: 'synthetic.admin',
      password: new AdminSecretText('Synthetic-admin-passphrase-2026'),
      mfaSeed: seedAdmin,
      createdAt: now(),
      requestKey: 'REQUEST_TEST_admin_bootstrap',
    },
    { kind: 'initial_bootstrap' },
  );

  const adminLoginResp = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
    },
    payload: 'loginName=synthetic.admin&password=Synthetic-admin-passphrase-2026',
  });
  expect(adminLoginResp.statusCode).toBe(303);
  const adminPreauthCookies = (adminLoginResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
  const adminPreauthCsrf = adminPreauthCookies
    .split('; ')
    .find((p) => p.startsWith('fcd_admin_csrf='))
    ?.split('=')[1];

  const adminMfaResp = await app.inject({
    method: 'POST',
    url: '/mfa',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
      cookie: adminPreauthCookies,
    },
    payload: new URLSearchParams({
      code: generateTotpCode(seedAdmin, at, totpPolicy),
      csrfToken: adminPreauthCsrf ?? '',
    }).toString(),
  });
  expect(adminMfaResp.statusCode).toBe(303);
  adminCookies = (adminMfaResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');

  // 2. Create support reviewer account
  const adminAuthority = {
    kind: 'administrator' as const,
    actorAccountRef: 'ADMIN_TEST_lead',
  };

  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_reviewer',
      loginName: 'synthetic.reviewer',
      password: new AdminSecretText('Synthetic-reviewer-passphrase-2026'),
      mfaSeed: seedReviewer,
      createdAt: now(),
      requestKey: 'REQUEST_TEST_reviewer_create',
    },
    adminAuthority,
  );
  await identity.assignRole(
    {
      targetAccountRef: 'ADMIN_TEST_reviewer',
      role: 'support_reviewer',
      requestKey: 'REQUEST_TEST_reviewer_role',
      effectiveAt: now(),
    },
    adminAuthority,
  );

  const revLoginResp = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
    },
    payload: 'loginName=synthetic.reviewer&password=Synthetic-reviewer-passphrase-2026',
  });
  expect(revLoginResp.statusCode).toBe(303);
  const revPreauthCookies = (revLoginResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
  const revPreauthCsrf = revPreauthCookies
    .split('; ')
    .find((p) => p.startsWith('fcd_admin_csrf='))
    ?.split('=')[1];

  const revMfaResp = await app.inject({
    method: 'POST',
    url: '/mfa',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
      cookie: revPreauthCookies,
    },
    payload: new URLSearchParams({
      code: generateTotpCode(seedReviewer, at, totpPolicy),
      csrfToken: revPreauthCsrf ?? '',
    }).toString(),
  });
  expect(revMfaResp.statusCode).toBe(303);
  reviewerCookies = (revMfaResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');

  // 3. Create knowledge editor account
  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_editor',
      loginName: 'synthetic.editor',
      password: new AdminSecretText('Synthetic-editor-passphrase-2026'),
      mfaSeed: seedEditor,
      createdAt: now(),
      requestKey: 'REQUEST_TEST_editor_create',
    },
    adminAuthority,
  );
  await identity.assignRole(
    {
      targetAccountRef: 'ADMIN_TEST_editor',
      role: 'knowledge_editor',
      requestKey: 'REQUEST_TEST_editor_role',
      effectiveAt: now(),
    },
    adminAuthority,
  );

  const editLoginResp = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
    },
    payload: 'loginName=synthetic.editor&password=Synthetic-editor-passphrase-2026',
  });
  expect(editLoginResp.statusCode).toBe(303);
  const editPreauthCookies = (editLoginResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
  const editPreauthCsrf = editPreauthCookies
    .split('; ')
    .find((p) => p.startsWith('fcd_admin_csrf='))
    ?.split('=')[1];

  const editMfaResp = await app.inject({
    method: 'POST',
    url: '/mfa',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
      cookie: editPreauthCookies,
    },
    payload: new URLSearchParams({
      code: generateTotpCode(seedEditor, at, totpPolicy),
      csrfToken: editPreauthCsrf ?? '',
    }).toString(),
  });
  expect(editMfaResp.statusCode).toBe(303);
  editorCookies = (editMfaResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');

  // 4. Create account for revoked session testing
  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_revoked',
      loginName: 'synthetic.revoked',
      password: new AdminSecretText('Synthetic-revoked-passphrase-2026'),
      mfaSeed: seedRevoked,
      createdAt: now(),
      requestKey: 'REQUEST_TEST_revoked_create',
    },
    adminAuthority,
  );

  const revokeLoginResp = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
    },
    payload: 'loginName=synthetic.revoked&password=Synthetic-revoked-passphrase-2026',
  });
  expect(revokeLoginResp.statusCode).toBe(303);
  const revokePreauthCookies = (revokeLoginResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
  const revokePreauthCsrf = revokePreauthCookies
    .split('; ')
    .find((p) => p.startsWith('fcd_admin_csrf='))
    ?.split('=')[1];

  const revokeMfaResp = await app.inject({
    method: 'POST',
    url: '/mfa',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
      cookie: revokePreauthCookies,
    },
    payload: new URLSearchParams({
      code: generateTotpCode(seedRevoked, at, totpPolicy),
      csrfToken: revokePreauthCsrf ?? '',
    }).toString(),
  });
  expect(revokeMfaResp.statusCode).toBe(303);
  revokedCookies = (revokeMfaResp.headers['set-cookie'] as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
  revokedSessionToken =
    revokedCookies
      .split('; ')
      .find((p) => p.startsWith('fcd_admin_session='))
      ?.split('=')[1] ?? '';

  // Revoke this session
  await identity.revokeSession({
    sessionToken: new AdminSecretText(revokedSessionToken),
  });
});

afterAll(async () => {
  for (const pool of pools.values()) await pool.end();
  for (const cleanup of cleanups.reverse()) await cleanup();
  const admin = new pg.Pool({
    connectionString: requireIsolatedTestDatabaseUrl(process.env),
    max: 1,
  });
  try {
    for (const role of [...runtimeDatabaseRoles, 'migrator']) {
      const name = `${rolePrefix}_${role}`;
      if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name))
        throw new Error('synthetic_role_scope_invalid');
      await admin.query(`drop owned by "${name}"`).catch(() => undefined);
      await admin.query(`drop role if exists "${name}"`);
    }
  } finally {
    await admin.end();
  }
});

describe('admin dashboard permissions under restricted runtime role', () => {
  test('empty states return empty arrays and HTTP 200 without leaking errors', async () => {
    expect(await dashboard.listQuestions()).toEqual([]);
    expect(await dashboard.listInsights()).toEqual([]);
    expect(await dashboard.listEscalationCounts()).toEqual([]);

    const qResp = await app.inject({
      method: 'GET',
      url: '/questions',
      headers: { cookie: adminCookies },
    });
    expect(qResp.statusCode).toBe(200);
    expect(qResp.body).toContain('Owner questions');
    expect(qResp.body).not.toContain('Internal Server Error');

    const iResp = await app.inject({
      method: 'GET',
      url: '/insights',
      headers: { cookie: adminCookies },
    });
    expect(iResp.statusCode).toBe(200);
    expect(iResp.body).toContain('Customer insights');
    expect(iResp.body).not.toContain('Internal Server Error');

    const eResp = await app.inject({
      method: 'GET',
      url: '/escalations',
      headers: { cookie: reviewerCookies },
    });
    expect(eResp.statusCode).toBe(200);
    expect(eResp.body).toContain('Escalations');
    expect(eResp.body).not.toContain('Internal Server Error');
  });

  test('populated eligible states return accurate aggregates without customer content leakage', async () => {
    const observationAt = new Date(at.getTime() - 2000);
    const learning = new PostgresLearningService(database.pool, {
      now,
      policy: learningPolicy,
    });

    const sources = [];
    for (const key of ['alpha', 'beta', 'gamma']) {
      const source = await insertSyntheticAppliedCustomerEvent(database.pool, {
        fixtureKey: `dashboard_grants_${key}`,
        identity: {
          channel: 'messenger',
          channelAccountId: 'PAGE_TEST_dashboard_grants',
          externalContactId: `PSID_TEST_grants_${key}`,
        },
        occurredAt: observationAt,
      });
      sources.push(source);
      await learning.recordGapObservation({
        observationRef: `OBSERVATION_TEST_grants_${key}`,
        requestKey: `REQUEST_TEST_grants_gap_${key}`,
        webhookEventId: source.eventId,
        observedAt: observationAt,
        retentionDeadline: new Date(at.getTime() + 86_400_000),
        language: 'en',
        gapKind: 'faq_miss',
      });
    }

    const createdAt = new Date(at.getTime() - 1000);
    const run = await database.pool.query<{ id: string }>(
      `insert into customer_insight_runs
        (run_ref, window_started_at, window_ended_at, minimum_group_count, state,
         source_observation_count, request_key, created_at)
       values ('RUN_TEST_grants_populated', $1, $2, 3, 'completed', 3,
               'REQUEST_TEST_grants_run', $3)
       returning id`,
      [new Date(at.getTime() - 5000), at, createdAt],
    );

    const insight = await database.pool.query<{ id: string }>(
      `insert into customer_insight_entries
        (insight_ref, run_id, topic_code, category_code, language, occurrence_count,
         retention_deadline, created_at)
       values ('INSIGHT_TEST_grants_entry', $1, 'knowledge_coverage', 'faq_miss', 'en', 3, $2, $3)
       returning id`,
      [run.rows[0]?.id, new Date(at.getTime() + 86_400_000), createdAt],
    );

    const question = await database.pool.query<{ id: string }>(
      `insert into owner_questions
        (question_ref, question_en, question_bn, priority, state,
         next_eligible_digest_at, request_key, created_at, updated_at)
       values ('QUESTION_TEST_grants_entry', 'Which reviewed business answer applies?',
               'কোন পর্যালোচিত ব্যবসায়িক উত্তর প্রযোজ্য?', 'normal', 'open', $1,
               'REQUEST_TEST_grants_q', $1, $1)
       returning id`,
      [createdAt],
    );

    await database.pool.query(
      `insert into owner_question_insights (question_id, insight_id) values ($1, $2)`,
      [question.rows[0]?.id, insight.rows[0]?.id],
    );

    // Insert escalation outcomes
    await database.pool.query(
      `insert into support_escalation_outcomes
        (escalation_ref, conversation_id, source_webhook_event_id, reason_code, state, request_key, created_at, updated_at, resolved_at)
       values
        ('ESC_TEST_grants_1', $1, $2, 'faq_ambiguous', 'open', 'REQ_ESC_1', $3, $3, null),
        ('ESC_TEST_grants_2', $1, $2, 'faq_ambiguous', 'open', 'REQ_ESC_2', $3, $3, null),
        ('ESC_TEST_grants_3', $1, $2, 'sensitive_data_blocked', 'resolved', 'REQ_ESC_3', $3, $3, $3)`,
      [sources[0]?.conversationId, sources[0]?.eventId, createdAt],
    );

    // Check list outputs under restricted admin pool
    const questions = await dashboard.listQuestions();
    expect(questions).toEqual([
      expect.objectContaining({
        questionRef: 'QUESTION_TEST_grants_entry',
        questionText: 'Which reviewed business answer applies?',
        priority: 'normal',
        state: 'open',
      }),
    ]);

    const insights = await dashboard.listInsights();
    expect(insights).toEqual([
      expect.objectContaining({
        topicCode: 'knowledge_coverage',
        categoryCode: 'faq_miss',
        occurrenceCount: 3,
      }),
    ]);

    const escalations = await dashboard.listEscalationCounts();
    expect(escalations).toEqual([
      { reasonCode: 'faq_ambiguous', state: 'open', count: 2 },
      { reasonCode: 'sensitive_data_blocked', state: 'resolved', count: 1 },
    ]);

    // Check authenticated HTTP responses
    const qResp = await app.inject({
      method: 'GET',
      url: '/questions',
      headers: { cookie: adminCookies },
    });
    expect(qResp.statusCode).toBe(200);
    expect(qResp.body).toContain('Which reviewed business answer applies?');
    // Ensure no sensitive contact/event leakage
    expect(qResp.body).not.toContain('PSID_TEST_grants_');
    expect(qResp.body).not.toContain('PAGE_TEST_dashboard_grants');

    const iResp = await app.inject({
      method: 'GET',
      url: '/insights',
      headers: { cookie: adminCookies },
    });
    expect(iResp.statusCode).toBe(200);
    expect(iResp.body).toContain('knowledge_coverage');
    expect(iResp.body).toContain('faq_miss');
    expect(iResp.body).not.toContain('PSID_TEST_grants_');

    const eResp = await app.inject({
      method: 'GET',
      url: '/escalations',
      headers: { cookie: reviewerCookies },
    });
    expect(eResp.statusCode).toBe(200);
    expect(eResp.body).toContain('faq_ambiguous');
    expect(eResp.body).toContain('sensitive_data_blocked');
    expect(eResp.body).not.toContain('PSID_TEST_grants_');
  });

  test('privacy hold and deletion suppress ineligible data rather than returning stale aggregates', async () => {
    // 1. Privacy hold: insert a privacy request for person alpha
    const hold = await database.pool.query<{ contact_id: string }>(
      `insert into privacy_requests
        (request_ref, request_type, state, contact_id, received_at, open_request_key, updated_at)
       select 'PRIVACY_TEST_hold_grants', 'access', 'received', identity.contact_id, $1,
              'OPEN_TEST_hold_grants', $1
       from channel_identities as identity
       where identity.external_contact_id = 'PSID_TEST_grants_alpha'
       returning contact_id`,
      [at],
    );
    expect(hold.rows).toHaveLength(1);

    // Eligible persons is now 2 < minimumGroupCount (3). Insights and open questions must be suppressed.
    expect(await dashboard.listInsights()).toEqual([]);
    expect((await dashboard.listQuestions()).filter((q) => q.state === 'open')).toEqual([]);

    const iHoldResp = await app.inject({
      method: 'GET',
      url: '/insights',
      headers: { cookie: adminCookies },
    });
    expect(iHoldResp.statusCode).toBe(200);
    expect(iHoldResp.body).not.toContain('knowledge_coverage');

    // Remove the hold
    await database.pool.query(
      `delete from privacy_requests where request_ref = 'PRIVACY_TEST_hold_grants'`,
    );

    // Re-verified: eligible again
    expect(await dashboard.listInsights()).toHaveLength(1);
    expect((await dashboard.listQuestions()).filter((q) => q.state === 'open')).toHaveLength(1);

    // 2. Soft deletion: mark person beta deleted
    await database.pool.query(
      `update channel_identities
       set external_contact_id = 'deleted:' || external_contact_id
       where external_contact_id = 'PSID_TEST_grants_beta'`,
    );

    // Eligible persons is now 2 < 3. Suppressed!
    expect(await dashboard.listInsights()).toEqual([]);
    expect((await dashboard.listQuestions()).filter((q) => q.state === 'open')).toEqual([]);

    // Restore person beta
    await database.pool.query(
      `update channel_identities
       set external_contact_id = 'PSID_TEST_grants_beta'
       where external_contact_id = 'deleted:PSID_TEST_grants_beta'`,
    );
    expect(await dashboard.listInsights()).toHaveLength(1);
  });

  test('negative privilege controls: admin role cannot read forbidden columns, mutate source tables, or run DDL', async () => {
    const adminPool = poolFor('admin');

    // 1. Column read denials
    await expect(
      adminPool.query('select message_text from webhook_events limit 1'),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(adminPool.query('select * from webhook_receipts limit 1')).rejects.toMatchObject({
      code: '42501',
    });

    await expect(
      adminPool.query('select id, escalation_ref from support_escalation_outcomes limit 1'),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      adminPool.query('select request_ref from privacy_requests limit 1'),
    ).rejects.toMatchObject({ code: '42501' });

    // 2. Mutation denials
    await expect(
      adminPool.query(
        'insert into conversations (channel_identity_id, created_at, last_activity_at, updated_at) values (1, now(), now(), now())',
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      adminPool.query('update conversations set updated_at = now()'),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(adminPool.query('delete from conversations')).rejects.toMatchObject({
      code: '42501',
    });

    await expect(
      adminPool.query(
        "insert into channel_identities (channel, channel_account_id, external_contact_id, contact_id, first_seen_at, last_seen_at) values ('whatsapp', 'a', 'b', 1, now(), now())",
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      adminPool.query(
        "insert into webhook_events (receipt_id, idempotency_key, channel, event_kind, occurred_at, created_at) values (1, 'k', 'whatsapp', 'customer_message', now(), now())",
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      adminPool.query(
        "insert into privacy_requests (request_ref, request_type, state, contact_id, received_at, open_request_key, updated_at) values ('r', 'access', 'received', 1, now(), 'k', now())",
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      adminPool.query(
        "insert into support_escalation_outcomes (escalation_ref, reason_code, state, request_key, created_at, updated_at) values ('e', 'timeout', 'open', 'k', now(), now())",
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(adminPool.query('delete from support_escalation_outcomes')).rejects.toMatchObject({
      code: '42501',
    });

    // 3. DDL denials
    await expect(adminPool.query('create table test_admin_ddl (id int)')).rejects.toMatchObject({
      code: '42501',
    });

    await expect(adminPool.query('drop table conversations')).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('authenticated GET smoke matrix across sidebar modules', async () => {
    // 1. Administrator role: authorized across all modules
    const adminRoutes = [
      { path: '/knowledge', expectedStatus: 200 },
      { path: '/questions', expectedStatus: 200 },
      { path: '/insights', expectedStatus: 200 },
      { path: '/policy', expectedStatus: 200 },
      { path: '/audit', expectedStatus: 200 },
      { path: '/operations', expectedStatus: 200 },
      { path: '/escalations', expectedStatus: 200 },
    ];

    for (const route of adminRoutes) {
      const resp = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: adminCookies },
      });
      expect(resp.statusCode, `Admin accessing ${route.path}`).toBe(route.expectedStatus);
    }

    // 2. Support reviewer role: authorized for support modules, denied on administrative modules
    const reviewerRoutes = [
      { path: '/knowledge', expectedStatus: 200 },
      { path: '/questions', expectedStatus: 200 },
      { path: '/insights', expectedStatus: 200 },
      { path: '/escalations', expectedStatus: 200 },
      { path: '/policy', expectedStatus: 403 }, // lacks administrator
      { path: '/audit', expectedStatus: 403 }, // lacks administrator
      { path: '/operations', expectedStatus: 403 }, // lacks administrator
    ];

    for (const route of reviewerRoutes) {
      const resp = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: reviewerCookies },
      });
      expect(resp.statusCode, `Reviewer accessing ${route.path}`).toBe(route.expectedStatus);
    }

    // 3. Knowledge editor role: authorized for knowledge/reading modules, denied on escalations/policy/audit/operations
    const editorRoutes = [
      { path: '/knowledge', expectedStatus: 200 },
      { path: '/questions', expectedStatus: 200 },
      { path: '/insights', expectedStatus: 200 },
      { path: '/escalations', expectedStatus: 403 }, // lacks support_reviewer
      { path: '/policy', expectedStatus: 403 }, // lacks administrator
      { path: '/audit', expectedStatus: 403 }, // lacks administrator
      { path: '/operations', expectedStatus: 403 }, // lacks administrator
    ];

    for (const route of editorRoutes) {
      const resp = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: editorCookies },
      });
      expect(resp.statusCode, `Editor accessing ${route.path}`).toBe(route.expectedStatus);
    }

    // 4. Unauthenticated requests redirect to /login (303)
    const allPaths = [
      '/knowledge',
      '/questions',
      '/insights',
      '/policy',
      '/escalations',
      '/audit',
      '/operations',
    ];
    for (const path of allPaths) {
      const resp = await app.inject({
        method: 'GET',
        url: path,
      });
      expect(resp.statusCode, `Unauthenticated ${path}`).toBe(303);
      expect(resp.headers.location).toBe('/login');
    }

    // 5. Revoked session redirects to /login (303)
    for (const path of allPaths) {
      const resp = await app.inject({
        method: 'GET',
        url: path,
        headers: { cookie: revokedCookies },
      });
      expect(resp.statusCode, `Revoked session ${path}`).toBe(303);
      expect(resp.headers.location).toBe('/login');
    }
  });
});
