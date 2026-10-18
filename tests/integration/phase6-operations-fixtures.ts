import { Buffer } from 'node:buffer';

import type { AdminActor } from '../../src/admin/admin-app.js';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import { PostgresAdminIdentity } from '../../src/persistence/postgres-admin-identity.js';
import { PostgresOperationsStore } from '../../src/persistence/postgres-operations-store.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

export const operationsAt = new Date('2030-01-01T00:00:00.000Z');
export interface Phase6OperationsFixture {
  readonly db: IsolatedTestDatabase;
  readonly identity: PostgresAdminIdentity;
  readonly actor: AdminActor;
  readonly store: PostgresOperationsStore;
  readonly setNow: (value: Date) => void;
  readonly dispose: () => Promise<void>;
}

export async function createPhase6Fixture(): Promise<Phase6OperationsFixture> {
  const db = await createIsolatedTestDatabase('phase6_operations');
  try {
    let now = new Date(operationsAt);
    const seed = new AdminSecretBytes(Buffer.alloc(20, 9));
    const totpPolicy = {
      algorithm: 'sha1',
      digits: 6,
      periodSeconds: 30,
      verificationWindow: 0,
    } as const;
    const identity = new PostgresAdminIdentity(db.pool, {
      mfaProtector: new AesGcmAdminSecretProtector(
        'synthetic_operations_v1',
        new AdminSecretBytes(Buffer.alloc(32, 11)),
      ),
      sessionHmacKey: new AdminSecretBytes(Buffer.alloc(32, 12)),
      passwordPolicy: {
        algorithm: 'scrypt_v1',
        cost: 16384,
        blockSize: 8,
        parallelization: 1,
        saltLength: 16,
        keyLength: 32,
      },
      totpPolicy,
      preauthenticationTtlMilliseconds: 300000,
      sessionTtlMilliseconds: 3600000,
      now: () => now,
    });
    await identity.createAccount(
      {
        accountRef: 'ADMIN_TEST_operations',
        loginName: 'synthetic.operations',
        mfaSeed: seed,
        password: new AdminSecretText('synthetic_operations_passphrase'),
        requestKey: 'REQUEST_TEST_operations_bootstrap',
        createdAt: operationsAt,
      },
      { kind: 'initial_bootstrap' },
    );
    const first = await identity.beginPasswordAuthentication({
      loginName: 'synthetic.operations',
      password: new AdminSecretText('synthetic_operations_passphrase'),
    });
    if (first.status !== 'mfa_required') throw new Error('Synthetic preauthentication failed');
    const session = await identity.completeMfaAuthentication({
      code: generateTotpCode(seed, now, totpPolicy),
      preauthenticationToken: first.sessionToken,
    });
    if (session.status !== 'authenticated') throw new Error('Synthetic authentication failed');
    return {
      db,
      identity,
      actor: {
        accountRef: 'ADMIN_TEST_operations',
        roles: ['administrator'],
        sessionToken: session.sessionToken,
      },
      store: new PostgresOperationsStore(db.pool, { identity, now: () => now }),
      setNow: (value) => {
        now = new Date(value);
      },
      dispose: db.dispose,
    };
  } catch (error) {
    await db.dispose();
    throw error;
  }
}
