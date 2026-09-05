import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { PostgresAdminIdentity } from '../persistence/postgres-admin-identity.js';
import { AdminSecretBytes, AdminSecretText } from './admin-types.js';
import { AesGcmAdminSecretProtector } from './mfa.js';
import { loadAdminConfig } from './admin-config.js';

export interface AdminBootstrapIo {
  readonly readSecret: (prompt: string) => Promise<AdminSecretText>;
  readonly write: (message: string) => void;
}

interface AdminBootstrapIdentity {
  readonly createAccount: (
    input: unknown,
    authority: { readonly kind: 'initial_bootstrap' },
  ) => Promise<{ readonly accountRef: string; readonly status: 'applied' | 'duplicate' }>;
}

interface RunAdminBootstrapDependencies {
  readonly accountRefSource: () => string;
  readonly identity: AdminBootstrapIdentity;
  readonly io: AdminBootstrapIo;
  readonly now: () => Date;
  readonly requestKeySource: () => string;
}

export class AdminBootstrapError extends Error {
  public override readonly name = 'AdminBootstrapError';
}

function decodeBase32(value: string): Buffer {
  const normalized = value.normalize('NFKC').trim().replaceAll(' ', '').toUpperCase();
  if (!/^[A-Z2-7]{26,104}$/.test(normalized)) {
    throw new TypeError('MFA seed is invalid');
  }
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new TypeError('MFA seed is invalid');
    bits = (bits << 5) | index;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && bits !== 0) throw new TypeError('MFA seed is invalid');
  const result = Buffer.from(bytes);
  if (result.length < 16 || result.length > 64) {
    result.fill(0);
    throw new TypeError('MFA seed is invalid');
  }
  return result;
}

function requireReference(value: string, prefix: string): string {
  if (!new RegExp(`^${prefix}[A-Za-z0-9._:-]{1,96}$`).test(value)) {
    throw new TypeError('Admin bootstrap reference is invalid');
  }
  return value;
}

export async function runAdminBootstrap(
  dependencies: RunAdminBootstrapDependencies,
): Promise<{ readonly accountRef: string }> {
  let seedBytes: Buffer | undefined;
  try {
    const login = await dependencies.io.readSecret('Admin login: ');
    const password = await dependencies.io.readSecret('Admin password: ');
    const encodedMfaSeed = await dependencies.io.readSecret('TOTP seed (base32): ');
    seedBytes = decodeBase32(encodedMfaSeed.reveal());
    const accountRef = requireReference(dependencies.accountRefSource(), 'ADMIN_');
    const requestKey = requireReference(dependencies.requestKeySource(), 'REQUEST_');
    const result = await dependencies.identity.createAccount(
      {
        accountRef,
        createdAt: dependencies.now(),
        loginName: login.reveal(),
        mfaSeed: new AdminSecretBytes(seedBytes),
        password,
        requestKey,
      },
      { kind: 'initial_bootstrap' },
    );
    dependencies.io.write(`Admin account bootstrap completed for ${result.accountRef}.`);
    return { accountRef: result.accountRef };
  } catch {
    dependencies.io.write('Admin bootstrap failed.');
    throw new AdminBootstrapError('Admin bootstrap failed');
  } finally {
    seedBytes?.fill(0);
  }
}

function createMaskedTerminalIo(): AdminBootstrapIo {
  return {
    readSecret: (prompt) =>
      new Promise<AdminSecretText>((resolve, reject) => {
        const input = process.stdin;
        const output = process.stderr;
        if (!input.isTTY || typeof input.setRawMode !== 'function') {
          reject(new AdminBootstrapError('Masked terminal input is required'));
          return;
        }
        let value = '';
        const previousRawMode = input.isRaw;
        const cleanup = () => {
          input.off('data', onData);
          input.setRawMode(previousRawMode);
          input.pause();
        };
        const onData = (chunk: Buffer | string) => {
          const characters = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          for (const character of characters) {
            if (character === '\u0003') {
              cleanup();
              output.write('\n');
              reject(new AdminBootstrapError('Admin bootstrap interrupted'));
              return;
            }
            if (character === '\r' || character === '\n') {
              cleanup();
              output.write('\n');
              try {
                resolve(new AdminSecretText(value));
              } catch (error) {
                reject(error instanceof Error ? error : new Error('Masked input failed'));
              }
              return;
            }
            if (character === '\u007f' || character === '\b') {
              value = value.slice(0, -1);
            } else if (character >= ' ' && value.length < 512) {
              value += character;
            }
          }
        };
        output.write(prompt);
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
      }),
    write: (message) => process.stderr.write(`${message}\n`),
  };
}

async function runEntrypoint(): Promise<void> {
  let pool: pg.Pool | undefined;
  let bootstrapStarted = false;
  try {
    const configuration = loadAdminConfig(process.env);
    pool = new pg.Pool({
      connectionString: configuration.databaseUrl,
      connectionTimeoutMillis: 5_000,
      max: 1,
    });
    const identity = new PostgresAdminIdentity(pool, {
      mfaProtector: new AesGcmAdminSecretProtector(
        configuration.mfaKeyVersion,
        configuration.mfaEncryptionKey,
      ),
      passwordPolicy: configuration.passwordPolicy,
      preauthenticationTtlMilliseconds: configuration.preauthenticationTtlMilliseconds,
      sessionHmacKey: configuration.sessionHmacKey,
      sessionTtlMilliseconds: configuration.sessionTtlMilliseconds,
      totpPolicy: configuration.totpPolicy,
    });
    bootstrapStarted = true;
    await runAdminBootstrap({
      accountRefSource: () => `ADMIN_${randomUUID().replaceAll('-', '')}`,
      identity,
      io: createMaskedTerminalIo(),
      now: () => new Date(),
      requestKeySource: () => `REQUEST_admin_bootstrap_${randomUUID().replaceAll('-', '')}`,
    });
  } catch {
    if (!bootstrapStarted) process.stderr.write('Admin bootstrap failed.\n');
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runEntrypoint();
}
