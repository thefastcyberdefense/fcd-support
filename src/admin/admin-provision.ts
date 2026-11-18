import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import pg from 'pg';
import { z } from 'zod';

import { createSafeLogger } from '../logging.js';
import { loadRoleEnvironment } from '../operations/secret-files.js';
import {
  PostgresAdminIdentity,
  type AdminAccountCreationAuthority,
  type AdminAccountSummary,
  type AdminRole,
} from '../persistence/postgres-admin-identity.js';
import { loadAdminConfig } from './admin-config.js';
import { AdminSecretBytes, AdminSecretText } from './admin-types.js';
import { AesGcmAdminSecretProtector } from './mfa.js';

const MAX_STDIN_BYTES = 64 * 1024;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const accountRefSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

const adminRoleSchema = z.enum([
  'administrator',
  'knowledge_editor',
  'knowledge_reviewer',
  'support_reviewer',
]);

const singleAccountSpecSchema = z.strictObject({
  accountRef: accountRefSchema.optional(),
  loginName: z.string().trim().min(1).max(256),
  password: z.string().min(14).max(256),
  mfaSeed: z.string().trim().min(26).max(128),
  role: adminRoleSchema.default('administrator'),
  requestKey: z.string().trim().min(1).max(80).optional(),
});

const batchProvisionInputSchema = z.strictObject({
  actorAccountRef: accountRefSchema.optional(),
  actorLoginName: z.string().trim().min(1).max(256).optional(),
  accounts: z.array(singleAccountSpecSchema).min(1).max(20),
});

const singleProvisionInputSchema = singleAccountSpecSchema.extend({
  actorAccountRef: accountRefSchema.optional(),
  actorLoginName: z.string().trim().min(1).max(256).optional(),
});

export class AdminProvisionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AdminProvisionError';
  }
}

export interface AdminProvisionIdentity {
  listAccounts(limit?: number): Promise<readonly AdminAccountSummary[]>;
  createAccount(
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly accountRef: string; readonly status: 'applied' | 'duplicate' }>;
  assignRole(
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly role: AdminRole; readonly status: 'applied' | 'duplicate' }>;
}

export interface ProvisionedAccountOutcome {
  readonly accountRef: string;
  readonly role: AdminRole;
  readonly accountStatus: 'applied' | 'duplicate';
  readonly roleStatus: 'applied' | 'duplicate';
}

export interface ProvisionAdminAccountsResult {
  readonly status: 'completed';
  readonly accounts: readonly ProvisionedAccountOutcome[];
}

export interface ProvisionAdminAccountsOptions {
  readonly identity: AdminProvisionIdentity;
  readonly input: unknown;
  readonly now?: (() => Date) | undefined;
  readonly requestKeySource?: (() => string) | undefined;
}

export interface RunAdminProvisionCliOptions {
  readonly identity: AdminProvisionIdentity;
  readonly now?: (() => Date) | undefined;
  readonly requestKeySource?: (() => string) | undefined;
  readonly readStdinUtf8: () => Promise<string>;
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
}

/**
 * Decodes an RFC 4648 Base32 TOTP secret seed into protected `AdminSecretBytes`.
 */
export function decodeBase32MfaSeed(seed: string): AdminSecretBytes {
  const normalized = seed.trim().replace(/\s+/gu, '').replace(/=+$/u, '').toUpperCase();
  if (normalized.length < 26 || normalized.length > 104 || /[^A-Z2-7]/u.test(normalized)) {
    throw new AdminProvisionError('Admin provisioning MFA seed is invalid');
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of normalized) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new AdminProvisionError('Admin provisioning MFA seed is invalid');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length < 16 || bytes.length > 64) {
    throw new AdminProvisionError('Admin provisioning MFA seed length is out of range');
  }
  const raw = Buffer.from(bytes);
  try {
    return new AdminSecretBytes(raw);
  } finally {
    raw.fill(0);
  }
}

function normalizeProvisionSpec(input: unknown) {
  const batch = batchProvisionInputSchema.safeParse(input);
  if (batch.success) {
    return {
      actorAccountRef: batch.data.actorAccountRef,
      actorLoginName: batch.data.actorLoginName,
      accounts: batch.data.accounts,
    };
  }
  const single = singleProvisionInputSchema.safeParse(input);
  if (single.success) {
    return {
      actorAccountRef: single.data.actorAccountRef,
      actorLoginName: single.data.actorLoginName,
      accounts: [
        {
          accountRef: single.data.accountRef,
          loginName: single.data.loginName,
          password: single.data.password,
          mfaSeed: single.data.mfaSeed,
          role: single.data.role,
          requestKey: single.data.requestKey,
        },
      ],
    };
  }
  throw new AdminProvisionError('Admin provisioning input is invalid');
}

function resolveAdministratorRef(
  existing: readonly AdminAccountSummary[],
  actorAccountRef?: string,
  actorLoginName?: string,
): string {
  const activeAdmins = existing.filter(
    (account) => account.state === 'active' && account.roles.includes('administrator'),
  );
  if (actorAccountRef !== undefined) {
    const match = activeAdmins.find((account) => account.accountRef === actorAccountRef);
    if (match === undefined) {
      throw new AdminProvisionError('Specified actorAccountRef is not an active administrator');
    }
    return match.accountRef;
  }
  if (actorLoginName !== undefined) {
    const normalized = actorLoginName.trim().toLowerCase();
    const match = activeAdmins.find((account) => account.loginName.toLowerCase() === normalized);
    if (match === undefined) {
      throw new AdminProvisionError('Specified actorLoginName is not an active administrator');
    }
    return match.accountRef;
  }
  throw new AdminProvisionError(
    'Non-empty admin provisioning requires actorAccountRef or actorLoginName',
  );
}

/**
 * Provisions one or more role-scoped admin accounts non-interactively without emitting secrets.
 */
export async function provisionAdminAccounts(
  options: ProvisionAdminAccountsOptions,
): Promise<ProvisionAdminAccountsResult> {
  const parsed = normalizeProvisionSpec(options.input);
  const now = options.now ?? (() => new Date());
  const requestKeySource =
    options.requestKeySource ?? (() => `PROVISION_${randomUUID().replaceAll('-', '')}`);

  const existing = await options.identity.listAccounts(500);
  let administratorRef: string | undefined;
  let initialBootstrapRequired = false;

  if (existing.length === 0) {
    const first = parsed.accounts[0];
    if (first?.role !== 'administrator') {
      throw new AdminProvisionError(
        'Initial empty-database provisioning requires administrator role first',
      );
    }
    initialBootstrapRequired = true;
  } else {
    administratorRef = resolveAdministratorRef(
      existing,
      parsed.actorAccountRef,
      parsed.actorLoginName,
    );
  }

  const outcomes: ProvisionedAccountOutcome[] = [];
  for (let index = 0; index < parsed.accounts.length; index++) {
    const item = parsed.accounts[index];
    if (item === undefined) continue;
    const requestKey = item.requestKey ?? requestKeySource();
    const accountRef =
      item.accountRef ??
      `ADMIN_${createHash('sha256').update(`${requestKey}:${item.loginName}`).digest('hex').slice(0, 24)}`;
    const timestamp = now();
    const passwordSecret = new AdminSecretText(item.password);
    const mfaSecret = decodeBase32MfaSeed(item.mfaSeed);

    const useInitial = initialBootstrapRequired && index === 0;
    const authority: AdminAccountCreationAuthority = useInitial
      ? { kind: 'initial_bootstrap' }
      : {
          kind: 'administrator',
          actorAccountRef:
            administratorRef ??
            (() => {
              throw new AdminProvisionError('Missing administrator authority');
            })(),
        };
    const created = await options.identity.createAccount(
      {
        accountRef,
        createdAt: timestamp,
        loginName: item.loginName,
        mfaSeed: mfaSecret,
        password: passwordSecret,
        requestKey,
      },
      authority,
    );

    if (useInitial) {
      administratorRef = created.accountRef;
      outcomes.push({
        accountRef: created.accountRef,
        role: 'administrator',
        accountStatus: created.status,
        roleStatus: created.status,
      });
      continue;
    }

    const assigned = await options.identity.assignRole(
      {
        effectiveAt: timestamp,
        requestKey: `${requestKey}.role.${item.role}`,
        role: item.role,
        targetAccountRef: created.accountRef,
      },
      {
        kind: 'administrator',
        actorAccountRef:
          administratorRef ??
          (() => {
            throw new AdminProvisionError('Missing administrator authority');
          })(),
      },
    );
    outcomes.push({
      accountRef: created.accountRef,
      role: assigned.role,
      accountStatus: created.status,
      roleStatus: assigned.status,
    });
  }

  return Object.freeze({
    status: 'completed',
    accounts: outcomes,
  });
}

async function readStdinUtf8Bounded(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) {
      throw new AdminProvisionError('Admin provisioning stdin payload is too large');
    }
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * Runs non-interactive stdin provisioning and writes only secret-free JSON metadata.
 */
export async function runAdminProvisionCli(options: RunAdminProvisionCliOptions): Promise<number> {
  try {
    const raw = await options.readStdinUtf8();
    const input = JSON.parse(raw) as unknown;
    const result = await provisionAdminAccounts({
      identity: options.identity,
      input,
      now: options.now,
      requestKeySource: options.requestKeySource,
    });
    options.writeOut(JSON.stringify(result));
    return 0;
  } catch (error) {
    const message =
      error instanceof AdminProvisionError ? error.message : 'Admin provisioning failed';
    options.writeErr(message);
    return 1;
  }
}

/**
 * Connects using the configured `admin` role environment and executes stdin provisioning.
 */
export async function runAdminProvisionFromEnvironment(
  environmentInput: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const logger = createSafeLogger();
  let pool: pg.Pool | undefined;
  try {
    const environment = await loadRoleEnvironment('admin', environmentInput);
    const config = loadAdminConfig(environment);
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 5_000,
    });
    pool.on('error', () => {
      logger.error('database_pool_error');
    });
    const identity = new PostgresAdminIdentity(pool, {
      mfaProtector: new AesGcmAdminSecretProtector(config.mfaKeyVersion, config.mfaEncryptionKey),
      passwordPolicy: config.passwordPolicy,
      preauthenticationTtlMilliseconds: config.preauthenticationTtlMilliseconds,
      sessionHmacKey: config.sessionHmacKey,
      sessionTtlMilliseconds: config.sessionTtlMilliseconds,
      totpPolicy: config.totpPolicy,
    });
    return await runAdminProvisionCli({
      identity,
      readStdinUtf8: readStdinUtf8Bounded,
      writeOut: (line) => {
        process.stdout.write(`${line}\n`);
      },
      writeErr: (line) => {
        process.stderr.write(`${line}\n`);
      },
    });
  } catch {
    process.stderr.write('Admin provisioning failed\n');
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (
    process.argv.length > 3 ||
    (process.argv.length === 3 && process.argv[2] !== '--provision-stdin')
  ) {
    process.stderr.write('Admin provisioning arguments are invalid\n');
    process.exitCode = 1;
  } else {
    process.exitCode = await runAdminProvisionFromEnvironment(process.env);
  }
}
