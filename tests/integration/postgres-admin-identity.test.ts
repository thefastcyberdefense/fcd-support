import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import {
  AdminIdentityConflictError,
  AdminIdentityNotAuthorizedError,
  PostgresAdminIdentity,
} from '../../src/persistence/postgres-admin-identity.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

const passwordPolicy = {
  algorithm: 'scrypt_v1',
  blockSize: 8,
  cost: 16_384,
  keyLength: 32,
  parallelization: 1,
  saltLength: 16,
} as const;
const totpPolicy = {
  algorithm: 'sha1',
  digits: 6,
  periodSeconds: 30,
  verificationWindow: 0,
} as const;
const rootAccountRef = 'ADMIN_TEST_identity_root';
const rootLogin = 'synthetic.root';
const rootPassword = 'Synthetic-root-passphrase-2026';
const rootMfaSeed = new AdminSecretBytes(Buffer.alloc(20, 0x31));

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let identity: PostgresAdminIdentity;
let trustedNow = new Date('2026-09-02T06:00:00.000Z');

function accountInput(
  suffix: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    accountRef: `ADMIN_TEST_identity_${suffix}`,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    loginName: `synthetic.${suffix}`,
    mfaSeed: new AdminSecretBytes(Buffer.alloc(20, suffix.charCodeAt(0))),
    password: new AdminSecretText(`Synthetic-${suffix}-passphrase-2026`),
    requestKey: `REQUEST_TEST_identity_create_${suffix}`,
    ...overrides,
  };
}

const rootActor = {
  actorAccountRef: rootAccountRef,
  kind: 'administrator',
} as const;

beforeAll(async () => {
  const database: IsolatedTestDatabase =
    await createIsolatedTestDatabase('postgres_admin_identity');
  disposeDatabase = database.dispose;
  pool = database.pool;
  identity = new PostgresAdminIdentity(pool, {
    mfaProtector: new AesGcmAdminSecretProtector(
      'test-key-v1',
      new AdminSecretBytes(Buffer.alloc(32, 0x41)),
    ),
    now: () => trustedNow,
    passwordPolicy,
    preauthenticationTtlMilliseconds: 5 * 60 * 1000,
    sessionHmacKey: new AdminSecretBytes(Buffer.alloc(32, 0x42)),
    sessionTtlMilliseconds: 60 * 60 * 1000,
    totpPolicy,
  });

  await identity.createAccount(
    {
      accountRef: rootAccountRef,
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      loginName: rootLogin,
      mfaSeed: rootMfaSeed,
      password: new AdminSecretText(rootPassword),
      requestKey: 'REQUEST_TEST_identity_bootstrap_root',
    },
    { kind: 'initial_bootstrap' },
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

async function authenticateRoot(at: Date) {
  trustedNow = at;
  const passwordResult = await identity.beginPasswordAuthentication({
    loginName: rootLogin,
    password: new AdminSecretText(rootPassword),
  });
  if (passwordResult.status !== 'mfa_required') throw new Error('Synthetic root login failed');
  return identity.completeMfaAuthentication({
    code: generateTotpCode(rootMfaSeed, at, totpPolicy),
    preauthenticationToken: passwordResult.sessionToken,
  });
}

describe('Postgres admin identity', () => {
  test('creates individual accounts, normalizes login names, and rejects collisions', async () => {
    await expect(
      identity.createAccount(
        accountInput('editor', { loginName: '  Synthetic.Editor  ' }),
        rootActor,
      ),
    ).resolves.toEqual({
      accountRef: 'ADMIN_TEST_identity_editor',
      status: 'applied',
    });

    await expect(
      identity.createAccount(
        accountInput('editor_collision', { loginName: 'synthetic.editor' }),
        rootActor,
      ),
    ).rejects.toBeInstanceOf(AdminIdentityConflictError);

    await expect(
      identity.createAccount(accountInput('second_bootstrap'), { kind: 'initial_bootstrap' }),
    ).rejects.toBeInstanceOf(AdminIdentityNotAuthorizedError);
    await expect(
      identity.createAccount(
        {
          accountRef: rootAccountRef,
          createdAt: new Date('2026-09-02T00:00:00.000Z'),
          loginName: rootLogin,
          mfaSeed: rootMfaSeed,
          password: new AdminSecretText(rootPassword),
          requestKey: 'REQUEST_TEST_identity_bootstrap_root',
        },
        { kind: 'initial_bootstrap' },
      ),
    ).rejects.toBeInstanceOf(AdminIdentityNotAuthorizedError);

    const stored = await pool.query<{ readonly login_name: string }>(
      `select login_name from admin_accounts where account_ref = $1`,
      ['ADMIN_TEST_identity_editor'],
    );
    expect(stored.rows[0]?.login_name).toBe('synthetic.editor');
  });

  test('uses one generic denial for unknown, wrong, and malformed credentials', async () => {
    const at = new Date('2026-09-02T03:00:00.000Z');
    trustedNow = at;
    const unknown = await identity.beginPasswordAuthentication({
      loginName: 'synthetic.unknown',
      password: new AdminSecretText('Synthetic-unknown-passphrase-2026'),
    });
    const wrong = await identity.beginPasswordAuthentication({
      loginName: rootLogin,
      password: new AdminSecretText('Synthetic-wrong-passphrase-2026'),
    });
    const malformed = await identity.beginPasswordAuthentication({
      loginName: 'not valid',
      password: new AdminSecretText('short'),
    });

    expect(unknown).toEqual({ status: 'denied' });
    expect(wrong).toEqual(unknown);
    expect(malformed).toEqual(unknown);
  });

  test('rotates preauthentication into an active session and resolves database roles', async () => {
    const at = new Date('2026-09-02T03:01:00.000Z');
    trustedNow = at;
    const passwordResult = await identity.beginPasswordAuthentication({
      loginName: rootLogin,
      password: new AdminSecretText(rootPassword),
    });
    expect(passwordResult.status).toBe('mfa_required');
    if (passwordResult.status !== 'mfa_required') return;

    const authenticated = await identity.completeMfaAuthentication({
      code: generateTotpCode(rootMfaSeed, at, totpPolicy),
      preauthenticationToken: passwordResult.sessionToken,
    });
    expect(authenticated.status).toBe('authenticated');
    if (authenticated.status !== 'authenticated') return;

    await expect(
      identity.resolveSession({ sessionToken: passwordResult.sessionToken }),
    ).resolves.toBeUndefined();
    await expect(
      identity.resolveSession({ sessionToken: authenticated.sessionToken }),
    ).resolves.toEqual({
      accountRef: rootAccountRef,
      expiresAt: new Date('2026-09-02T04:01:00.000Z'),
      roles: ['administrator'],
    });

    const stored = await pool.query<{ readonly session_hash: Buffer }>(
      `select session_hash from admin_sessions where state = 'active' order by id desc limit 1`,
    );
    expect(stored.rows[0]?.session_hash.toString('utf8')).not.toContain(
      authenticated.sessionToken.reveal(),
    );
  });

  test('records append-only role assignment state from a database-verified administrator', async () => {
    trustedNow = new Date('2026-09-02T06:00:00.000Z');
    await expect(
      identity.assignRole(
        {
          effectiveAt: new Date('2026-09-02T03:02:00.000Z'),
          requestKey: 'REQUEST_TEST_identity_assign_editor',
          role: 'knowledge_editor',
          targetAccountRef: 'ADMIN_TEST_identity_editor',
        },
        rootActor,
      ),
    ).resolves.toEqual({ role: 'knowledge_editor', status: 'applied' });
    await expect(
      identity.assignRole(
        {
          effectiveAt: new Date('2026-09-02T03:02:00.000Z'),
          requestKey: 'REQUEST_TEST_identity_assign_editor',
          role: 'knowledge_editor',
          targetAccountRef: 'ADMIN_TEST_identity_editor',
        },
        rootActor,
      ),
    ).resolves.toEqual({ role: 'knowledge_editor', status: 'duplicate' });
    await expect(
      identity.assignRole(
        {
          effectiveAt: new Date('2026-09-02T03:02:00.000Z'),
          requestKey: 'REQUEST_TEST_identity_assign_editor',
          role: 'knowledge_editor',
          targetAccountRef: 'ADMIN_TEST_identity_editor',
        },
        {
          actorAccountRef: 'ADMIN_TEST_identity_editor',
          kind: 'administrator',
        },
      ),
    ).rejects.toBeInstanceOf(AdminIdentityNotAuthorizedError);
    await identity.assignRole(
      {
        effectiveAt: new Date('2026-09-02T03:02:10.000Z'),
        requestKey: 'REQUEST_TEST_identity_assign_editor_administrator',
        role: 'administrator',
        targetAccountRef: 'ADMIN_TEST_identity_editor',
      },
      rootActor,
    );
    await identity.revokeRole(
      {
        effectiveAt: new Date('2026-09-02T03:02:20.000Z'),
        requestKey: 'REQUEST_TEST_identity_revoke_editor_administrator',
        role: 'administrator',
        targetAccountRef: 'ADMIN_TEST_identity_editor',
      },
      rootActor,
    );
    await expect(
      identity.assignRole(
        {
          effectiveAt: new Date('2026-09-02T03:02:15.000Z'),
          requestKey: 'REQUEST_TEST_identity_backdated_editor_action',
          role: 'support_reviewer',
          targetAccountRef: 'ADMIN_TEST_identity_editor',
        },
        {
          actorAccountRef: 'ADMIN_TEST_identity_editor',
          kind: 'administrator',
        },
      ),
    ).rejects.toBeInstanceOf(AdminIdentityNotAuthorizedError);
    await expect(
      identity.revokeRole(
        {
          effectiveAt: new Date('2026-09-02T03:03:00.000Z'),
          requestKey: 'REQUEST_TEST_identity_revoke_editor',
          role: 'knowledge_editor',
          targetAccountRef: 'ADMIN_TEST_identity_editor',
        },
        rootActor,
      ),
    ).resolves.toEqual({ role: 'knowledge_editor', status: 'applied' });

    const history = await pool.query<{ readonly action: string }>(
      `select action from admin_role_assignments
       where account_id = (select id from admin_accounts where account_ref = $1)
       order by id`,
      ['ADMIN_TEST_identity_editor'],
    );
    expect(history.rows.map((row) => row.action)).toEqual(['assign', 'assign', 'revoke', 'revoke']);
  });

  test('accepts an MFA counter once even across concurrent preauthentication sessions', async () => {
    const input = accountInput('concurrent');
    await identity.createAccount(input, rootActor);
    const password = input.password;
    const seed = input.mfaSeed;
    if (!(password instanceof AdminSecretText) || !(seed instanceof AdminSecretBytes)) {
      throw new Error('Synthetic identity fixture is invalid');
    }
    const at = new Date('2026-09-02T03:04:00.000Z');
    trustedNow = at;
    const attempts = await Promise.all([
      identity.beginPasswordAuthentication({
        loginName: 'synthetic.concurrent',
        password,
      }),
      identity.beginPasswordAuthentication({
        loginName: 'synthetic.concurrent',
        password,
      }),
    ]);
    const challenges = attempts.filter((result) => result.status === 'mfa_required');
    expect(challenges).toHaveLength(2);
    const code = generateTotpCode(seed, at, totpPolicy);
    const results = await Promise.all(
      challenges.map((challenge) =>
        identity.completeMfaAuthentication({
          code,
          preauthenticationToken: challenge.sessionToken,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'authenticated')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'denied')).toHaveLength(1);
  });

  test('expires, revokes, and bulk-revokes active sessions', async () => {
    const first = await authenticateRoot(new Date('2026-09-02T03:05:00.000Z'));
    expect(first.status).toBe('authenticated');
    if (first.status !== 'authenticated') return;
    trustedNow = new Date('2026-09-02T03:05:01.000Z');
    await expect(
      identity.revokeSession({
        sessionToken: first.sessionToken,
      }),
    ).resolves.toEqual({ status: 'applied' });
    trustedNow = new Date('2026-09-02T03:05:02.000Z');
    await expect(
      identity.resolveSession({
        sessionToken: first.sessionToken,
      }),
    ).resolves.toBeUndefined();

    const second = await authenticateRoot(new Date('2026-09-02T03:06:00.000Z'));
    expect(second.status).toBe('authenticated');
    if (second.status !== 'authenticated') return;
    trustedNow = new Date('2026-09-02T04:06:00.001Z');
    await expect(
      identity.resolveSession({
        at: new Date('2026-09-02T03:06:00.001Z'),
        sessionToken: second.sessionToken,
      }),
    ).rejects.toThrow();
    await expect(
      identity.resolveSession({
        sessionToken: second.sessionToken,
      }),
    ).resolves.toBeUndefined();

    const third = await authenticateRoot(new Date('2026-09-02T04:07:00.000Z'));
    expect(third.status).toBe('authenticated');
    if (third.status !== 'authenticated') return;
    trustedNow = new Date('2026-09-02T04:07:01.000Z');
    await expect(
      identity.revokeAllSessions(
        {
          targetAccountRef: rootAccountRef,
        },
        rootActor,
      ),
    ).resolves.toEqual({ revokedCount: 1 });
    trustedNow = new Date('2026-09-02T04:07:02.000Z');
    await expect(
      identity.resolveSession({
        sessionToken: third.sessionToken,
      }),
    ).resolves.toBeUndefined();
  });

  test('binds CSRF to unexpired sessions through MFA rotation and revocation', async () => {
    const at = new Date('2026-09-02T07:00:00.000Z');
    trustedNow = at;
    const preauth = await identity.beginPasswordAuthentication({
      loginName: rootLogin,
      password: new AdminSecretText(rootPassword),
    });
    if (preauth.status !== 'mfa_required') throw new Error('Synthetic login failed');
    const input = {
      csrfToken: preauth.csrfToken,
      expectedOrigin: 'http://127.0.0.1:3004',
      requestOrigin: 'http://127.0.0.1:3004',
      sessionToken: preauth.sessionToken,
    };
    await expect(identity.validateCsrf(input)).resolves.toBe(true);
    await expect(
      identity.validateCsrf({ ...input, requestOrigin: 'https://example.invalid' }),
    ).resolves.toBe(false);
    await expect(
      identity.validateCsrf({ ...input, csrfToken: new AdminSecretText('synthetic-wrong-csrf') }),
    ).resolves.toBe(false);
    const active = await identity.completeMfaAuthentication({
      code: generateTotpCode(rootMfaSeed, at, totpPolicy),
      preauthenticationToken: preauth.sessionToken,
    });
    if (active.status !== 'authenticated') throw new Error('Synthetic MFA failed');
    await expect(identity.validateCsrf(input)).resolves.toBe(false);
    const activeInput = {
      ...input,
      csrfToken: active.csrfToken,
      sessionToken: active.sessionToken,
    };
    await expect(identity.validateCsrf(activeInput)).resolves.toBe(true);
    await expect(
      identity.validateCsrf({ ...activeInput, csrfToken: preauth.csrfToken }),
    ).resolves.toBe(false);
    trustedNow = active.expiresAt;
    await expect(identity.validateCsrf(activeInput)).resolves.toBe(false);
    trustedNow = at;
    await identity.revokeSession({ sessionToken: active.sessionToken });
    await expect(identity.validateCsrf(activeInput)).resolves.toBe(false);
  });

  test('stores content-free append-only authentication and authorization audit history', async () => {
    const rows = await pool.query<{
      readonly action: string;
      readonly object_ref: string | null;
      readonly reason_code: string;
      readonly request_key: string | null;
    }>(
      `select action, object_ref, reason_code, request_key
       from admin_audit_events
       order by id`,
    );
    const serialized = JSON.stringify(rows.rows);
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(serialized).not.toContain(rootLogin);
    expect(serialized).not.toContain(rootPassword);
    expect(serialized).not.toContain('Synthetic-wrong-passphrase-2026');
    expect(rows.rows.every((row) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.reason_code))).toBe(
      true,
    );
    await expect(pool.query(`delete from admin_audit_events`)).rejects.toThrow(
      'Phase 4 evidence is append-only',
    );
  });
});
