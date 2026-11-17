import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import { buildAdminApp } from '../../src/admin/admin-app.js';
import { PostgresAdminDashboard } from '../../src/persistence/postgres-admin-dashboard.js';
import {
  AdminIdentityConflictError,
  PostgresAdminIdentity,
} from '../../src/persistence/postgres-admin-identity.js';
import { PostgresAdminOperations } from '../../src/persistence/postgres-admin-operations.js';
import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { PostgresLearningService } from '../../src/persistence/postgres-learning-service.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
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

const baseAt = new Date('2026-11-03T06:00:00.000Z');
let currentTime = new Date(baseAt);
const now = () => new Date(currentTime);

const seedAdmin = new AdminSecretBytes(Buffer.alloc(20, 0x71));
const totpPolicy = {
  algorithm: 'sha1',
  digits: 6,
  periodSeconds: 30,
  verificationWindow: 1,
} as const;
const learningPolicy = {
  minimumGroupCount: 2,
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
    statement_timeout: 5000,
  });
  pools.set(role, pool);
  return pool;
}

function decodeBase32(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of encoded.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function extractCookies(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

function extractCsrf(cookieHeader: string): string {
  return (
    cookieHeader
      .split('; ')
      .find((entry) => entry.startsWith('fcd_admin_csrf='))
      ?.split('=')[1] ?? ''
  );
}

function hiddenValue(body: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(body);
  if (match?.[1] === undefined) throw new Error(`Missing form field ${name}`);
  return match[1];
}

function formHiddenValue(body: string, action: string, name: string, extra?: string): string {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`<form[^>]+action="${escapedAction}"[^>]*>([\\s\\S]*?)</form>`, 'gu');
  for (const match of body.matchAll(pattern)) {
    const form = match[1];
    if (form !== undefined && (extra === undefined || form.includes(extra))) {
      return hiddenValue(form, name);
    }
  }
  throw new Error(`Missing form action ${action}`);
}

let identity: PostgresAdminIdentity;
let dashboard: PostgresAdminDashboard;
let operations: PostgresAdminOperations;
let app: ReturnType<typeof buildAdminApp>;
let appInitialized = false;
let adminCookies = '';
let adminCsrf = '';

async function loginAccount(loginName: string, password: string, seed: AdminSecretBytes) {
  const step1 = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
    },
    payload: new URLSearchParams({ loginName, password }).toString(),
  });
  expect(step1.statusCode).toBe(303);
  const preauthCookies = extractCookies(step1.headers);
  const preauthCsrf = extractCsrf(preauthCookies);
  const step2 = await app.inject({
    method: 'POST',
    url: '/mfa',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:3000',
      cookie: preauthCookies,
    },
    payload: new URLSearchParams({
      code: generateTotpCode(seed, now(), totpPolicy),
      csrfToken: preauthCsrf,
    }).toString(),
  });
  expect(step2.statusCode).toBe(303);
  const cookies = extractCookies(step2.headers);
  return { cookies, csrf: extractCsrf(cookies) };
}

beforeAll(async () => {
  database = await createIsolatedTestDatabase('admin_controls_e2e');
  cleanups.push(() => database.dispose());

  root = await mkdtemp(join(tmpdir(), 'fcd-admin-ctrls-'));
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
  dashboard = new PostgresAdminDashboard(adminPool, identity, {
    now,
    learningPolicy,
    privacyKeyring: syntheticPrivacyKeyring,
  });
  operations = new PostgresAdminOperations(adminPool, identity, { now });
  app = buildAdminApp({
    dashboard,
    identity,
    operations,
    now,
    origin: 'http://127.0.0.1:3000',
    secureCookie: false,
  });
  appInitialized = true;

  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_ctrl_lead',
      loginName: 'synthetic.ctrl.lead',
      password: new AdminSecretText('Synthetic-ctrl-lead-passphrase-2026'),
      mfaSeed: seedAdmin,
      createdAt: now(),
      requestKey: 'REQUEST_TEST_ctrl_lead_bootstrap',
    },
    { kind: 'initial_bootstrap' },
  );
  const auth = await loginAccount(
    'synthetic.ctrl.lead',
    'Synthetic-ctrl-lead-passphrase-2026',
    seedAdmin,
  );
  adminCookies = auth.cookies;
  adminCsrf = auth.csrf;
});

afterAll(async () => {
  if (appInitialized) await app.close();
  for (const pool of pools.values()) await pool.end();
  for (const cleanup of cleanups.reverse()) await cleanup();
  const rootPool = new pg.Pool({
    connectionString: requireIsolatedTestDatabaseUrl(process.env),
    max: 1,
  });
  try {
    for (const role of [...runtimeDatabaseRoles, 'migrator']) {
      const name = `${rolePrefix}_${role}`;
      if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name)) {
        throw new Error('synthetic_role_scope_invalid');
      }
      await rootPool.query(`drop owned by "${name}"`).catch(() => undefined);
      await rootPool.query(`drop role if exists "${name}"`);
    }
  } finally {
    await rootPool.end();
  }
});

describe('Track 2B live nonsuperuser admin workflows', () => {
  beforeEach(() => {
    currentTime = new Date(baseAt);
  });

  test('manages individual MFA staff provisioning, role assignment, session revocation, and safe disablement', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: adminCookies },
    });
    expect(page1.statusCode).toBe(200);
    const createToken = formHiddenValue(page1.body, '/accounts', 'actionToken');

    const created = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        cookie: adminCookies,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:3000',
      },
      payload: new URLSearchParams({
        csrfToken: adminCsrf,
        actionToken: createToken,
        accountRef: 'ADMIN_TEST_ctrl_staff',
        loginName: 'synthetic.ctrl.staff',
        password: 'Synthetic-ctrl-staff-passphrase-2026',
        roleKnowledgeEditor: '1',
        roleSupportReviewer: '1',
      }).toString(),
    });
    expect(created.statusCode).toBe(200);
    const secretMatch = /Secret:\s*<span class="confirm-ref">([A-Z2-7]+)<\/span>/u.exec(
      created.body,
    );
    expect(secretMatch?.[1]).toBeDefined();
    const staffSeed = new AdminSecretBytes(decodeBase32(secretMatch?.[1] ?? ''));

    // Provisioned staff user logs in with MFA
    const staffAuth = await loginAccount(
      'synthetic.ctrl.staff',
      'Synthetic-ctrl-staff-passphrase-2026',
      staffSeed,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/accounts',
          headers: { cookie: staffAuth.cookies },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/pause', headers: { cookie: staffAuth.cookies } }))
        .statusCode,
    ).toBe(200);

    // Administrator revokes sessions then disables staff account
    const page2 = await app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: adminCookies },
    });
    expect(page2.body).not.toContain(secretMatch?.[1] ?? '');

    const revokeRoleToken = formHiddenValue(
      page2.body,
      '/accounts/ADMIN_TEST_ctrl_staff/roles/revoke',
      'actionToken',
      'value="knowledge_editor"',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/accounts/ADMIN_TEST_ctrl_staff/roles/revoke',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: revokeRoleToken,
            role: 'knowledge_editor',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    const revokeSessionsToken = formHiddenValue(
      page2.body,
      '/accounts/ADMIN_TEST_ctrl_staff/revoke-sessions',
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/accounts/ADMIN_TEST_ctrl_staff/revoke-sessions',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: revokeSessionsToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/pause',
          headers: { cookie: staffAuth.cookies },
        })
      ).statusCode,
    ).toBe(303);

    const disableToken = formHiddenValue(
      page2.body,
      '/accounts/ADMIN_TEST_ctrl_staff/disable',
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/accounts/ADMIN_TEST_ctrl_staff/disable',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: disableToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    // Final active admin cannot be disabled even directly
    await expect(
      identity.disableAccount(
        { targetAccountRef: 'ADMIN_TEST_ctrl_lead', requestKey: 'REQ_disable_self' },
        { kind: 'administrator', actorAccountRef: 'ADMIN_TEST_ctrl_lead' },
      ),
    ).rejects.toThrow(AdminIdentityConflictError);
  });

  test('executes manual 24h pause/resume, privacy workflows, consent/outbound controls, website draft import, and learning actions through restricted role', async () => {
    const seedAt = new Date('2026-11-03T05:00:00.000Z');
    const delCustomer = {
      channel: 'whatsapp' as const,
      channelAccountId: 'PHONE_CTRL_1',
      externalContactId: '15550009101',
    };
    const rightsCustomer = {
      channel: 'whatsapp' as const,
      channelAccountId: 'PHONE_CTRL_1',
      externalContactId: '15550009102',
    };

    const delEvent = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: 'ctrl_deletion_src',
      identity: delCustomer,
      messageText: 'DELETE MY DATA',
      occurredAt: seedAt,
    });
    await new PostgresDeletionPolicy(database.pool, syntheticPrivacyKeyring).openRequest({
      identity: delCustomer,
      requestKey: 'REQ_CTRL_OPEN_DEL',
      requestedAt: seedAt,
      sourceWebhookEventId: delEvent.eventId,
    });

    const accEvent = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: 'ctrl_access_src',
      identity: rightsCustomer,
      messageText: 'REQUEST MY DATA',
      occurredAt: new Date(seedAt.getTime() + 1000),
    });
    await new PostgresPrivacyRightsPolicy(
      database.pool,
      syntheticPrivacyKeyring,
    ).processAppliedEvent({
      requestKey: 'REQ_CTRL_OPEN_ACC',
      sourceWebhookEventId: accEvent.eventId,
    });

    const corEvent = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: 'ctrl_cor_src',
      identity: {
        channel: 'messenger',
        channelAccountId: 'PAGE_CTRL_1',
        externalContactId: 'PSID_CTRL_9103',
      },
      messageText: 'CORRECT MY DATA',
      occurredAt: new Date(seedAt.getTime() + 2000),
    });
    await new PostgresPrivacyRightsPolicy(
      database.pool,
      syntheticPrivacyKeyring,
    ).processAppliedEvent({
      requestKey: 'REQ_CTRL_OPEN_COR',
      sourceWebhookEventId: corEvent.eventId,
    });

    // 1. Pause & resume on live conversation
    const pausePage = await app.inject({
      method: 'GET',
      url: '/pause',
      headers: { cookie: adminCookies },
    });
    expect(pausePage.statusCode).toBe(200);
    const pauseAction = formHiddenValue(
      pausePage.body,
      `/pause/${accEvent.conversationId}/pause`,
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/pause/${accEvent.conversationId}/pause`,
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: pauseAction,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    const pausedRow = await database.pool.query<{ readonly ai_paused_until: Date | null }>(
      `select ai_paused_until from conversations where id = $1`,
      [accEvent.conversationId],
    );
    expect(pausedRow.rows[0]?.ai_paused_until?.toISOString()).toBe('2026-11-04T06:00:00.000Z');

    const resumeAction = formHiddenValue(
      pausePage.body,
      `/pause/${accEvent.conversationId}/resume`,
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/pause/${accEvent.conversationId}/resume`,
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: resumeAction,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    // 2. Privacy deletion, access export, correction & location attestation
    const privacyRequests = await dashboard.listPrivacyRequests();
    const delReq = privacyRequests.find((r) => r.requestType === 'deletion');
    const accReq = privacyRequests.find((r) => r.requestType === 'access');
    const corReq = privacyRequests.find((r) => r.requestType === 'correction');
    if (delReq === undefined || accReq === undefined || corReq === undefined) {
      throw new Error('Expected privacy requests were not created');
    }

    const privPage1 = await app.inject({
      method: 'GET',
      url: '/privacy',
      headers: { cookie: adminCookies },
    });
    expect(privPage1.statusCode).toBe(200);
    const delReviewToken = formHiddenValue(
      privPage1.body,
      `/privacy/${delReq.requestRef}/deletion/review`,
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/privacy/${delReq.requestRef}/deletion/review`,
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: delReviewToken,
            decision: 'approve',
            reasonCode: 'customer_confirmed',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    currentTime = new Date(baseAt.getTime() + 1000);
    const privPage2 = await app.inject({
      method: 'GET',
      url: '/privacy',
      headers: { cookie: adminCookies },
    });
    const delExecToken = formHiddenValue(
      privPage2.body,
      `/privacy/${delReq.requestRef}/deletion/execute`,
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/privacy/${delReq.requestRef}/deletion/execute`,
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: delExecToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    const suppressions = await database.pool.query<{ readonly count: number }>(
      `select count(*)::int as count from privacy_suppressions`,
    );
    expect(suppressions.rows[0]?.count).toBeGreaterThanOrEqual(1);

    // Approve access & correction requests
    for (const reqItem of [accReq, corReq]) {
      const reviewToken = formHiddenValue(
        privPage1.body,
        `/privacy/${reqItem.requestRef}/review`,
        'actionToken',
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/privacy/${reqItem.requestRef}/review`,
            headers: {
              cookie: adminCookies,
              'content-type': 'application/x-www-form-urlencoded',
              origin: 'http://127.0.0.1:3000',
            },
            payload: new URLSearchParams({
              csrfToken: adminCsrf,
              actionToken: reviewToken,
              decision: 'approve',
              reasonCode: 'identity_verified',
            }).toString(),
          })
        ).statusCode,
      ).toBe(303);
    }

    currentTime = new Date(baseAt.getTime() + 2000);
    const privPage3 = await app.inject({
      method: 'GET',
      url: '/privacy',
      headers: { cookie: adminCookies },
    });
    const collectToken = formHiddenValue(
      privPage3.body,
      `/privacy/${accReq.requestRef}/access/collect`,
      'actionToken',
    );
    const accessResp = await app.inject({
      method: 'POST',
      url: `/privacy/${accReq.requestRef}/access/collect`,
      headers: {
        cookie: adminCookies,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:3000',
      },
      payload: new URLSearchParams({
        csrfToken: adminCsrf,
        actionToken: collectToken,
      }).toString(),
    });
    expect(accessResp.statusCode).toBe(200);
    expect(accessResp.body).toContain('Redacted Access Export');

    const correctToken = formHiddenValue(
      privPage3.body,
      `/privacy/${corReq.requestRef}/correction/execute`,
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/privacy/${corReq.requestRef}/correction/execute`,
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: correctToken,
            fieldKey: 'preferred_language',
            newValue: 'bn',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    const correctedContact = await database.pool.query<{
      readonly preferred_language: string | null;
    }>(
      `select ct.preferred_language
       from contacts as ct
       join channel_identities as ci on ci.contact_id = ct.id
       join conversations as cv on cv.channel_identity_id = ci.id
       where cv.id = $1`,
      [corEvent.conversationId],
    );
    expect(correctedContact.rows[0]?.preferred_language).toBe('bn');

    // 3. Consent record, marketing re-opt-in, outbound policy, and template draft
    const accIdentityRow = await database.pool.query<{ readonly channel_identity_id: string }>(
      `select channel_identity_id::text from conversations where id = $1`,
      [accEvent.conversationId],
    );
    const accChannelIdentityId = accIdentityRow.rows[0]?.channel_identity_id;
    if (accChannelIdentityId === undefined) throw new Error('Missing channel_identity_id');
    const consentPage = await app.inject({
      method: 'GET',
      url: '/consent',
      headers: { cookie: adminCookies },
    });
    expect(consentPage.statusCode).toBe(200);
    const consentToken = formHiddenValue(
      consentPage.body,
      '/consent/record',
      'actionToken',
      `value="${accChannelIdentityId}"`,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/consent/record',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: consentToken,
            channelIdentityId: accChannelIdentityId,
            category: 'product_offers',
            action: 'revoke',
            wording: 'Customer withdrew promo consent',
            wordingVersion: '2026-11',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    const outboundPolToken = formHiddenValue(
      consentPage.body,
      '/consent/outbound-policy',
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/consent/outbound-policy',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: outboundPolToken,
            perContact15Minute: '4',
            perContact24Hour: '15',
            global1Minute: '50',
            globalUtcDay: '800',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    const outboundTplToken = formHiddenValue(
      consentPage.body,
      '/consent/outbound-template',
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/consent/outbound-template',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: outboundTplToken,
            channelAccountId: 'PHONE_CTRL_1',
            providerTemplateId: 'META_TPL_CTRL_1',
            templateName: 'ctrl_status_notice',
            locale: 'en_US',
            category: 'customer_support',
            templateText: 'Synthetic reviewed status update.',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    // 4. Official website import -> drafts only (never auto-published)
    const importPage = await app.inject({
      method: 'GET',
      url: '/knowledge/import',
      headers: { cookie: adminCookies },
    });
    expect(importPage.statusCode).toBe(200);
    const importToken = formHiddenValue(importPage.body, '/knowledge/import', 'actionToken');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/knowledge/import',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: importToken,
            url: 'https://example.org/support',
            label: 'Official Support',
            pastedHtmlOrText: '<title>Support</title><h1>Official Hours</h1><p>Open 9-5.</p>',
            itemKey: 'faq.ctrl.hours',
            kind: 'faq',
            questionEn: 'What are official hours?',
            answerEn: 'Open 9-5.',
            questionBn: 'অফিসিয়াল সময়সূচি কী?',
            answerBn: 'সকাল ৯টা থেকে বিকাল ৫টা।',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    const draftRow = await database.pool.query<{ readonly state: string }>(
      `select v.state from knowledge_versions as v
       join knowledge_items as i on i.id = v.item_id
       where i.item_key = 'faq.ctrl.hours'`,
    );
    expect(draftRow.rows).toEqual([{ state: 'draft' }]);
    const pubCount = await database.pool.query<{ readonly count: number }>(
      `select count(*)::int as count from knowledge_publication_events`,
    );
    expect(pubCount.rows[0]?.count).toBe(0);

    // 5. Insights aggregation + digest + Open question dismiss
    const learn1 = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: 'ctrl_learn_1',
      identity: {
        channel: 'whatsapp',
        channelAccountId: 'PHONE_CTRL_1',
        externalContactId: '15550009201',
      },
      messageText: 'When are office hours?',
      occurredAt: seedAt,
    });
    const learn2 = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: 'ctrl_learn_2',
      identity: {
        channel: 'whatsapp',
        channelAccountId: 'PHONE_CTRL_1',
        externalContactId: '15550009202',
      },
      messageText: 'Office timings please?',
      occurredAt: seedAt,
    });
    const learning = new PostgresLearningService(database.pool, {
      now,
      policy: learningPolicy,
    });
    for (const [idx, src] of [learn1, learn2].entries()) {
      await learning.recordGapObservation({
        observationRef: `OBS_TEST_ctrl_${String(idx)}`,
        requestKey: `REQ_OBS_ctrl_${String(idx)}`,
        webhookEventId: src.eventId,
        observedAt: seedAt,
        retentionDeadline: new Date(seedAt.getTime() + 86_400_000),
        language: 'en',
        gapKind: 'faq_miss',
      });
    }
    const insightsPage = await app.inject({
      method: 'GET',
      url: '/insights',
      headers: { cookie: adminCookies },
    });
    const aggToken = formHiddenValue(insightsPage.body, '/insights/aggregate', 'actionToken');
    const digestToken = formHiddenValue(insightsPage.body, '/insights/digest', 'actionToken');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/insights/aggregate',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({ csrfToken: adminCsrf, actionToken: aggToken }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/insights/digest',
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: digestToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    const openQuestions = await database.pool.query<{ readonly question_ref: string }>(
      `select question_ref from owner_questions where state = 'open' order by id desc limit 1`,
    );
    const questionRef = openQuestions.rows[0]?.question_ref;
    if (questionRef === undefined) throw new Error('Expected open owner question from digest');

    const qPage = await app.inject({
      method: 'GET',
      url: '/questions',
      headers: { cookie: adminCookies },
    });
    const dismissToken = formHiddenValue(
      qPage.body,
      `/questions/${questionRef}/dismiss`,
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/questions/${questionRef}/dismiss`,
          headers: {
            cookie: adminCookies,
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'http://127.0.0.1:3000',
          },
          payload: new URLSearchParams({
            csrfToken: adminCsrf,
            actionToken: dismissToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await database.pool.query<{ readonly state: string }>(
          `select state from owner_questions where question_ref = $1`,
          [questionRef],
        )
      ).rows[0]?.state,
    ).toBe('dismissed');

    const auditActions = await database.pool.query<{ readonly action: string }>(
      `select action from admin_audit_events order by id`,
    );
    const actions = auditActions.rows.map((r) => r.action);
    expect(actions).toContain('human_pause_applied');
    expect(actions).toContain('human_pause_resumed');
    expect(actions).toContain('privacy_deletion_executed');
    expect(actions).toContain('privacy_access_collected');
    expect(actions).toContain('privacy_correction_executed');
    expect(actions).toContain('consent_recorded');
    expect(actions).toContain('outbound_policy_changed');
    expect(actions).toContain('outbound_template_changed');
    expect(actions).toContain('knowledge_source_imported');
    expect(actions).toContain('knowledge_proposal_created');
    expect(actions).toContain('owner_question_dismissed');
    expect(actions).toContain('customer_insights_aggregated');
  });
});
