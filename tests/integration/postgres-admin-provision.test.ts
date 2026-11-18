import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildAdminApp } from '../../src/admin/admin-app.js';
import { AdminSecretBytes } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import { decodeBase32MfaSeed, provisionAdminAccounts } from '../../src/admin/admin-provision.js';
import { PostgresAdminDashboard } from '../../src/persistence/postgres-admin-dashboard.js';
import { PostgresAdminIdentity } from '../../src/persistence/postgres-admin-identity.js';
import { PostgresAdminOperations } from '../../src/persistence/postgres-admin-operations.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let database: IsolatedTestDatabase | undefined;
let nowMs = Date.parse('2026-11-18T10:00:00.000Z');
const now = () => new Date(nowMs);
const syntheticPassword = 'Synthetic-multi-role-passphrase-2026';
const syntheticSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const totpPolicy = {
  algorithm: 'sha1',
  digits: 6,
  periodSeconds: 30,
  verificationWindow: 1,
} as const;

beforeAll(async () => {
  database = await createIsolatedTestDatabase('admin_provision');
});

afterAll(async () => {
  await database?.dispose();
});

test('non-interactive provisioning creates separate role accounts and enforces real route RBAC boundaries', async () => {
  if (database === undefined) throw new Error('test_db_not_initialized');
  const mfaProtector = new AesGcmAdminSecretProtector(
    'v1',
    new AdminSecretBytes(Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')),
  );
  const sessionHmacKey = new AdminSecretBytes(
    Buffer.from('fedcba9876543210fedcba9876543210', 'utf8'),
  );
  const identity = new PostgresAdminIdentity(database.pool, {
    mfaProtector,
    now,
    passwordPolicy: {
      algorithm: 'scrypt_v1',
      blockSize: 8,
      cost: 16384,
      keyLength: 32,
      parallelization: 1,
      saltLength: 16,
    },
    preauthenticationTtlMilliseconds: 300_000,
    sessionHmacKey,
    sessionTtlMilliseconds: 3_600_000,
    totpPolicy,
  });

  const initial = await provisionAdminAccounts({
    identity,
    now,
    input: {
      loginName: 'owner.v1',
      password: syntheticPassword,
      mfaSeed: syntheticSeed,
      role: 'administrator',
      requestKey: 'REQ_INIT_OWNER',
    },
  });
  expect(initial.accounts).toHaveLength(1);
  const ownerRef = initial.accounts[0]?.accountRef ?? '';

  const additional = await provisionAdminAccounts({
    identity,
    now,
    input: {
      actorAccountRef: ownerRef,
      accounts: [
        {
          loginName: 'editor.v1',
          password: syntheticPassword,
          mfaSeed: syntheticSeed,
          role: 'knowledge_editor',
          requestKey: 'REQ_ADD_EDITOR',
        },
        {
          loginName: 'reviewer.v1',
          password: syntheticPassword,
          mfaSeed: syntheticSeed,
          role: 'knowledge_reviewer',
          requestKey: 'REQ_ADD_KREV',
        },
        {
          loginName: 'support.v1',
          password: syntheticPassword,
          mfaSeed: syntheticSeed,
          role: 'support_reviewer',
          requestKey: 'REQ_ADD_SREV',
        },
      ],
    },
  });
  expect(additional.accounts.map((a) => a.role)).toEqual([
    'knowledge_editor',
    'knowledge_reviewer',
    'support_reviewer',
  ]);

  const listed = await identity.listAccounts(20);
  expect(listed).toHaveLength(4);

  const seedBytes = decodeBase32MfaSeed(syntheticSeed);
  const dashboard = new PostgresAdminDashboard(database.pool, identity, {
    now,
    listLimit: 100,
    learningPolicy: {
      minimumGroupCount: 3,
      digestIntervalMilliseconds: 259_200_000,
      maximumQuestionsPerDigest: 5,
      questionCooldownMilliseconds: 604_800_000,
      maximumDigestAppearances: 2,
      maximumObservationsPerRun: 1000,
    },
  });
  const operations = new PostgresAdminOperations(database.pool, identity, {
    now,
  });
  const app = buildAdminApp({
    dashboard,
    identity,
    now,
    operations,
    origin: 'http://127.0.0.1:13004',
    secureCookie: false,
  });
  await app.ready();

  try {
    const loginCookieFor = async (loginName: string): Promise<string> => {
      nowMs += 31_000;
      const loginRes = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          origin: 'http://127.0.0.1:13004',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `loginName=${encodeURIComponent(loginName)}&password=${encodeURIComponent(syntheticPassword)}`,
      });
      expect(loginRes.statusCode).toBe(303);
      const setCookies = loginRes.headers['set-cookie'];
      const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies ?? ''];
      const cookieHeader = cookieList.map((c) => c.split(';', 1)[0]).join('; ');
      const csrfToken = cookieList
        .map((c) => c.split(';', 1)[0] ?? '')
        .find((c) => c.startsWith('fcd_admin_csrf='))
        ?.slice('fcd_admin_csrf='.length);
      const totp = generateTotpCode(seedBytes, now(), totpPolicy);
      const mfaRes = await app.inject({
        method: 'POST',
        url: '/mfa',
        headers: {
          origin: 'http://127.0.0.1:13004',
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `csrfToken=${encodeURIComponent(csrfToken ?? '')}&code=${encodeURIComponent(totp)}`,
      });
      expect(mfaRes.statusCode).toBe(303);
      const authCookies = mfaRes.headers['set-cookie'];
      const authList = Array.isArray(authCookies) ? authCookies : [authCookies ?? ''];
      return authList.map((c) => c.split(';', 1)[0]).join('; ');
    };

    const editorCookie = await loginCookieFor('editor.v1');
    const supportCookie = await loginCookieFor('support.v1');
    const reviewerCookie = await loginCookieFor('reviewer.v1');

    // RBAC separation checks that failed under a single administrator (Gap G-5)
    expect(
      (await app.inject({ method: 'GET', url: '/policy', headers: { cookie: editorCookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/audit', headers: { cookie: reviewerCookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/escalations', headers: { cookie: editorCookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/escalations', headers: { cookie: supportCookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/knowledge', headers: { cookie: reviewerCookie } }))
        .statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
