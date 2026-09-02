import { Buffer } from 'node:buffer';

import { describe, expect, test, vi } from 'vitest';

import { AdminSecretBytes, AdminSecretText } from '../src/admin/admin-types.js';
import {
  AdminBootstrapError,
  runAdminBootstrap,
  type AdminBootstrapIo,
} from '../src/admin/admin-bootstrap.js';

const enteredLogin = 'Synthetic.Owner';
const enteredPassword = 'Synthetic-owner-passphrase-2026';
const enteredMfaSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function bootstrapIo(outputs: string[]): AdminBootstrapIo {
  const values = [enteredLogin, enteredPassword, enteredMfaSeed];
  return {
    readSecret: vi.fn(() => Promise.resolve(new AdminSecretText(values.shift() ?? 'missing'))),
    write: (message) => outputs.push(message),
  };
}

describe('admin bootstrap', () => {
  test('reads every bootstrap value through masked input and writes no secret', async () => {
    const outputs: string[] = [];
    const io = bootstrapIo(outputs);
    let createdInput: unknown;
    const createAccount = vi.fn((input: unknown) => {
      createdInput = input;
      return Promise.resolve({
        accountRef: 'ADMIN_TEST_bootstrap_owner',
        status: 'applied' as const,
      });
    });

    await expect(
      runAdminBootstrap({
        accountRefSource: () => 'ADMIN_TEST_bootstrap_owner',
        identity: { createAccount },
        io,
        now: () => new Date('2026-09-02T05:00:00.000Z'),
        requestKeySource: () => 'REQUEST_TEST_bootstrap_owner',
      }),
    ).resolves.toEqual({ accountRef: 'ADMIN_TEST_bootstrap_owner' });

    expect(io.readSecret).toHaveBeenCalledTimes(3);
    expect(createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountRef: 'ADMIN_TEST_bootstrap_owner',
        loginName: enteredLogin,
        requestKey: 'REQUEST_TEST_bootstrap_owner',
      }),
      { kind: 'initial_bootstrap' },
    );
    const call = createdInput as { readonly mfaSeed: AdminSecretBytes };
    expect(call.mfaSeed.copy()).toEqual(
      Buffer.concat([
        Buffer.from('Hello!\u00de\u00ad\u00be\u00ef', 'latin1'),
        Buffer.from('Hello!\u00de\u00ad\u00be\u00ef', 'latin1'),
      ]),
    );
    expect(outputs.join('\n')).toContain('ADMIN_TEST_bootstrap_owner');
    expect(outputs.join('\n')).not.toContain(enteredLogin);
    expect(outputs.join('\n')).not.toContain(enteredPassword);
    expect(outputs.join('\n')).not.toContain(enteredMfaSeed);
  });

  test('returns one secret-free bootstrap error when account creation fails', async () => {
    const outputs: string[] = [];
    const io = bootstrapIo(outputs);
    const createAccount = vi.fn(() =>
      Promise.reject(new Error(`Failure involving ${enteredPassword}`)),
    );

    await expect(
      runAdminBootstrap({
        accountRefSource: () => 'ADMIN_TEST_bootstrap_failure',
        identity: { createAccount },
        io,
        now: () => new Date('2026-09-02T05:01:00.000Z'),
        requestKeySource: () => 'REQUEST_TEST_bootstrap_failure',
      }),
    ).rejects.toEqual(new AdminBootstrapError('Admin bootstrap failed'));
    expect(outputs).toEqual(['Admin bootstrap failed.']);
    expect(outputs.join('\n')).not.toContain(enteredPassword);
  });
});
