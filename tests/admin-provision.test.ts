import { Buffer } from 'node:buffer';

import { describe, expect, test, vi } from 'vitest';

import type {
  AdminAccountCreationAuthority,
  AdminAccountSummary,
  AdminRole,
} from '../src/persistence/postgres-admin-identity.js';
import {
  AdminProvisionError,
  decodeBase32MfaSeed,
  provisionAdminAccounts,
  runAdminProvisionCli,
  type AdminProvisionIdentity,
} from '../src/admin/admin-provision.js';

const sampleMfaSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const samplePassword = 'Synthetic-multi-role-passphrase-2026';

function fakeIdentity(initialAccounts: readonly AdminAccountSummary[] = []): {
  identity: AdminProvisionIdentity;
  accounts: Map<string, { accountRef: string; loginName: string; roles: Set<AdminRole> }>;
  calls: {
    kind: 'create' | 'role';
    accountRef: string;
    role?: AdminRole;
    authority: AdminAccountCreationAuthority;
  }[];
} {
  const accounts = new Map<
    string,
    { accountRef: string; loginName: string; roles: Set<AdminRole> }
  >();
  for (const item of initialAccounts) {
    accounts.set(item.accountRef, {
      accountRef: item.accountRef,
      loginName: item.loginName,
      roles: new Set(item.roles),
    });
  }
  const seenKeys = new Set<string>();
  const calls: {
    kind: 'create' | 'role';
    accountRef: string;
    role?: AdminRole;
    authority: AdminAccountCreationAuthority;
  }[] = [];

  const identity: AdminProvisionIdentity = {
    listAccounts: () =>
      Promise.resolve(
        [...accounts.values()].map((item) => ({
          accountRef: item.accountRef,
          loginName: item.loginName,
          state: 'active' as const,
          roles: [...item.roles],
          activeSessionCount: 0,
          createdAt: new Date('2026-11-18T10:00:00.000Z'),
        })),
      ),
    createAccount: (rawInput, authority) => {
      const input = rawInput as {
        accountRef: string;
        loginName: string;
        requestKey: string;
        password: { reveal(): string };
        mfaSeed: { copy(): Buffer };
      };
      expect(input.password.reveal().length).toBeGreaterThanOrEqual(14);
      expect(input.mfaSeed.copy().length).toBeGreaterThanOrEqual(16);
      calls.push({ kind: 'create', accountRef: input.accountRef, authority });
      if (seenKeys.has(input.requestKey)) {
        return Promise.resolve({ accountRef: input.accountRef, status: 'duplicate' as const });
      }
      seenKeys.add(input.requestKey);
      const roles = new Set<AdminRole>();
      if (authority.kind === 'initial_bootstrap') roles.add('administrator');
      accounts.set(input.accountRef, {
        accountRef: input.accountRef,
        loginName: input.loginName,
        roles,
      });
      return Promise.resolve({ accountRef: input.accountRef, status: 'applied' as const });
    },
    assignRole: (rawInput, authority) => {
      const input = rawInput as {
        targetAccountRef: string;
        role: AdminRole;
        requestKey: string;
      };
      calls.push({ kind: 'role', accountRef: input.targetAccountRef, role: input.role, authority });
      if (seenKeys.has(input.requestKey)) {
        return Promise.resolve({ role: input.role, status: 'duplicate' as const });
      }
      seenKeys.add(input.requestKey);
      const target = accounts.get(input.targetAccountRef);
      if (!target) return Promise.reject(new Error('missing_target'));
      target.roles.add(input.role);
      return Promise.resolve({ role: input.role, status: 'applied' as const });
    },
  };

  return { identity, accounts, calls };
}

describe('non-interactive multi-role admin provisioning (Gap G-5)', () => {
  test('decodes Base32 MFA seed identically to initial bootstrap', () => {
    expect(decodeBase32MfaSeed(sampleMfaSeed).copy()).toEqual(
      Buffer.concat([
        Buffer.from('Hello!\u00de\u00ad\u00be\u00ef', 'latin1'),
        Buffer.from('Hello!\u00de\u00ad\u00be\u00ef', 'latin1'),
      ]),
    );
  });

  test('provisions full 4-role matrix starting from an empty database', async () => {
    const mock = fakeIdentity();
    const result = await provisionAdminAccounts({
      identity: mock.identity,
      now: () => new Date('2026-11-18T10:00:00.000Z'),
      input: {
        accounts: [
          {
            loginName: 'synthetic.admin',
            password: samplePassword,
            mfaSeed: sampleMfaSeed,
            role: 'administrator',
            requestKey: 'REQ_ADMIN_1',
          },
          {
            loginName: 'synthetic.editor',
            password: samplePassword,
            mfaSeed: sampleMfaSeed,
            role: 'knowledge_editor',
            requestKey: 'REQ_EDITOR_1',
          },
          {
            loginName: 'synthetic.reviewer',
            password: samplePassword,
            mfaSeed: sampleMfaSeed,
            role: 'knowledge_reviewer',
            requestKey: 'REQ_KREV_1',
          },
          {
            loginName: 'synthetic.support',
            password: samplePassword,
            mfaSeed: sampleMfaSeed,
            role: 'support_reviewer',
            requestKey: 'REQ_SREV_1',
          },
        ],
      },
    });

    expect(result.status).toBe('completed');
    expect(result.accounts.map((a) => a.role)).toEqual([
      'administrator',
      'knowledge_editor',
      'knowledge_reviewer',
      'support_reviewer',
    ]);
    const adminRef = result.accounts[0]?.accountRef ?? '';
    expect(mock.calls[0]?.authority).toEqual({ kind: 'initial_bootstrap' });
    expect(
      mock.calls
        .slice(1)
        .every(
          (c) => c.authority.kind === 'administrator' && c.authority.actorAccountRef === adminRef,
        ),
    ).toBe(true);
    expect([...mock.accounts.values()].map((a) => [...a.roles])).toEqual([
      ['administrator'],
      ['knowledge_editor'],
      ['knowledge_reviewer'],
      ['support_reviewer'],
    ]);
  });

  test('provisions non-admin roles on a non-empty database using existing administrator actor', async () => {
    const mock = fakeIdentity([
      {
        accountRef: 'ADMIN_EXISTING_1',
        loginName: 'existing.owner',
        state: 'active',
        roles: ['administrator'],
        activeSessionCount: 0,
        createdAt: new Date('2026-11-16T00:00:00.000Z'),
      },
    ]);

    const result = await provisionAdminAccounts({
      identity: mock.identity,
      now: () => new Date('2026-11-18T10:00:00.000Z'),
      input: {
        actorLoginName: 'existing.owner',
        loginName: 'synthetic.reviewer',
        password: samplePassword,
        mfaSeed: sampleMfaSeed,
        role: 'support_reviewer',
        requestKey: 'REQ_SUPPORT_ONLY',
      },
    });

    expect(result.status).toBe('completed');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.accountRef).toMatch(/^ADMIN_/u);
    expect(result.accounts[0]?.role).toBe('support_reviewer');
    expect(result.accounts[0]?.accountStatus).toBe('applied');
    expect(result.accounts[0]?.roleStatus).toBe('applied');
    expect(
      mock.calls.every(
        (c) =>
          c.authority.kind === 'administrator' &&
          c.authority.actorAccountRef === 'ADMIN_EXISTING_1',
      ),
    ).toBe(true);
  });

  test('rejects non-empty DB without administrator actor or empty DB without administrator role first', async () => {
    const emptyMock = fakeIdentity();
    await expect(
      provisionAdminAccounts({
        identity: emptyMock.identity,
        now: () => new Date('2026-11-18T10:00:00.000Z'),
        input: {
          loginName: 'synthetic.editor',
          password: samplePassword,
          mfaSeed: sampleMfaSeed,
          role: 'knowledge_editor',
        },
      }),
    ).rejects.toBeInstanceOf(AdminProvisionError);

    const populatedMock = fakeIdentity([
      {
        accountRef: 'ADMIN_EXISTING_1',
        loginName: 'existing.owner',
        state: 'active',
        roles: ['administrator'],
        activeSessionCount: 0,
        createdAt: new Date('2026-11-16T00:00:00.000Z'),
      },
    ]);
    await expect(
      provisionAdminAccounts({
        identity: populatedMock.identity,
        now: () => new Date('2026-11-18T10:00:00.000Z'),
        input: {
          loginName: 'synthetic.editor',
          password: samplePassword,
          mfaSeed: sampleMfaSeed,
          role: 'knowledge_editor',
        },
      }),
    ).rejects.toBeInstanceOf(AdminProvisionError);
  });

  test('CLI prints zero passwords, MFA seeds, or loginNames on success or failure', async () => {
    const mock = fakeIdentity();
    const out: string[] = [];
    const err: string[] = [];

    const code = await runAdminProvisionCli({
      identity: mock.identity,
      now: () => new Date('2026-11-18T10:00:00.000Z'),
      readStdinUtf8: () =>
        Promise.resolve(
          JSON.stringify({
            loginName: 'Synthetic.Secret.Login',
            password: samplePassword,
            mfaSeed: sampleMfaSeed,
            role: 'administrator',
          }),
        ),
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
    });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    const combined = out.join('\n');
    expect(combined).not.toContain('Synthetic.Secret.Login');
    expect(combined).not.toContain(samplePassword);
    expect(combined).not.toContain(sampleMfaSeed);

    const err2: string[] = [];
    const out2: string[] = [];
    const failIdentity: AdminProvisionIdentity = {
      ...mock.identity,
      createAccount: vi.fn(() =>
        Promise.reject(new Error(`leak ${samplePassword} and ${sampleMfaSeed}`)),
      ),
    };
    const failCode = await runAdminProvisionCli({
      identity: failIdentity,
      now: () => new Date('2026-11-18T10:00:00.000Z'),
      readStdinUtf8: () =>
        Promise.resolve(
          JSON.stringify({
            actorLoginName: 'nonexistent',
            loginName: 'Synthetic.Secret.Login',
            password: samplePassword,
            mfaSeed: sampleMfaSeed,
            role: 'knowledge_editor',
          }),
        ),
      writeOut: (line) => out2.push(line),
      writeErr: (line) => err2.push(line),
    });
    expect(failCode).toBe(1);
    expect(out2).toEqual([]);
    expect(err2.join('\n')).not.toContain(samplePassword);
    expect(err2.join('\n')).not.toContain(sampleMfaSeed);
  });
});
