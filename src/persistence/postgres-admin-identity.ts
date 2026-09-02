import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import { AdminSecretBytes, AdminSecretText } from '../admin/admin-types.js';
import {
  type AdminSecretProtector,
  type ProtectedMfaSeed,
  type TotpPolicy,
  protectMfaSeed,
  verifyTotpCode,
} from '../admin/mfa.js';
import {
  type AdminPasswordHash,
  type AdminPasswordPolicy,
  hashAdminPassword,
  verifyAdminPassword,
} from '../admin/password-hash.js';
import { createAdminSessionToken, hashAdminSessionToken } from '../admin/session-token.js';
import { withBoundedTransaction } from './postgres-transaction.js';

const adminRoleSchema = z.enum([
  'knowledge_editor',
  'knowledge_reviewer',
  'support_reviewer',
  'administrator',
]);
const accountRefSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const requestKeySchema = z.string().trim().min(1).max(96);
const validDateSchema = z.date().refine((value) => Number.isFinite(value.getTime()));
const secretBytesSchema = z.instanceof(AdminSecretBytes);
const secretTextSchema = z.instanceof(AdminSecretText);
const createAccountSchema = z.strictObject({
  accountRef: accountRefSchema,
  createdAt: validDateSchema,
  loginName: z.string().min(1).max(256),
  mfaSeed: secretBytesSchema,
  password: secretTextSchema,
  requestKey: requestKeySchema,
});
const roleCommandSchema = z.strictObject({
  effectiveAt: validDateSchema,
  requestKey: requestKeySchema,
  role: adminRoleSchema,
  targetAccountRef: accountRefSchema,
});
const beginAuthenticationSchema = z.strictObject({
  loginName: z.string().max(256),
  password: secretTextSchema,
});
const completeAuthenticationSchema = z.strictObject({
  code: z.string().max(16),
  preauthenticationToken: secretTextSchema,
});
const sessionCommandSchema = z.strictObject({
  sessionToken: secretTextSchema,
});
const revokeAllSchema = z.strictObject({
  targetAccountRef: accountRefSchema,
});

export type AdminRole = z.infer<typeof adminRoleSchema>;

export interface PostgresAdminIdentityOptions {
  readonly mfaProtector: AdminSecretProtector;
  readonly now?: (() => Date) | undefined;
  readonly passwordPolicy: AdminPasswordPolicy;
  readonly preauthenticationTtlMilliseconds: number;
  readonly randomSource?: ((size: number) => Buffer) | undefined;
  readonly sessionHmacKey: AdminSecretBytes;
  readonly sessionTtlMilliseconds: number;
  readonly totpPolicy: TotpPolicy;
}

export type AdminAccountCreationAuthority =
  | { readonly kind: 'initial_bootstrap' }
  | { readonly actorAccountRef: string; readonly kind: 'administrator' };

export type AdminAuthenticationResult =
  | { readonly status: 'denied' }
  | {
      readonly csrfToken: AdminSecretText;
      readonly expiresAt: Date;
      readonly sessionToken: AdminSecretText;
      readonly status: 'mfa_required';
    };

export type AdminMfaAuthenticationResult =
  | { readonly status: 'denied' }
  | {
      readonly csrfToken: AdminSecretText;
      readonly expiresAt: Date;
      readonly sessionToken: AdminSecretText;
      readonly status: 'authenticated';
    };

export interface ResolvedAdminSession {
  readonly accountRef: string;
  readonly expiresAt: Date;
  readonly roles: readonly AdminRole[];
}

export class AdminIdentityConflictError extends Error {
  public override readonly name = 'AdminIdentityConflictError';
}

export class AdminIdentityNotAuthorizedError extends Error {
  public override readonly name = 'AdminIdentityNotAuthorizedError';
}

export class AdminIdentityNotFoundError extends Error {
  public override readonly name = 'AdminIdentityNotFoundError';
}

interface AccountCredentialRow {
  readonly account_ref: string;
  readonly id: string;
  readonly password_algorithm: 'scrypt_v1';
  readonly password_block_size: number;
  readonly password_cost: number;
  readonly password_hash: Buffer;
  readonly password_key_length: number;
  readonly password_parallelization: number;
  readonly password_salt: Buffer;
  readonly row_version: string;
  readonly state: 'active' | 'revoked';
}

interface MfaSessionRow {
  readonly account_id: string;
  readonly account_ref: string;
  readonly authentication_tag: Buffer;
  readonly encrypted_material: Buffer;
  readonly encryption_nonce: Buffer;
  readonly expires_at: Date;
  readonly key_version: string;
  readonly last_accepted_counter: string | null;
  readonly mfa_id: string;
  readonly session_id: string;
  readonly state: 'active' | 'expired' | 'preauth' | 'revoked';
}

interface ActiveSessionRow {
  readonly account_id: string;
  readonly account_ref: string;
  readonly account_state: 'active' | 'revoked';
  readonly expires_at: Date;
  readonly session_id: string;
  readonly state: 'active' | 'expired' | 'preauth' | 'revoked';
}

interface ExistingRoleCommandRow {
  readonly action: 'assign' | 'revoke';
  readonly effective_at: Date;
  readonly role: AdminRole;
  readonly target_account_ref: string;
}

interface AccountIdentityRow {
  readonly account_ref: string;
  readonly id: string;
  readonly state: 'active' | 'revoked';
}

type RandomSource = (size: number) => Buffer;

const denied = { status: 'denied' } as const;
const dummyPassword = 'Synthetic-timing-equalization-passphrase';

function millisecondsAreValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 60_000 && value <= 86_400_000;
}

function normalizeLoginName(value: string): string | undefined {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized) ? normalized : undefined;
}

function isPostgresError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function addMilliseconds(at: Date, milliseconds: number): Date {
  const result = new Date(at.getTime() + milliseconds);
  if (!Number.isFinite(result.getTime())) throw new TypeError('Admin identity time is invalid');
  return result;
}

function passwordHashFromRow(row: AccountCredentialRow): AdminPasswordHash {
  return {
    algorithm: row.password_algorithm,
    blockSize: row.password_block_size,
    cost: row.password_cost,
    hash: new AdminSecretBytes(row.password_hash),
    keyLength: row.password_key_length,
    parallelization: row.password_parallelization,
    salt: new AdminSecretBytes(row.password_salt),
  };
}

function protectedSeedFromRow(row: MfaSessionRow): ProtectedMfaSeed {
  return {
    authenticationTag: new AdminSecretBytes(row.authentication_tag),
    encryptedMaterial: new AdminSecretBytes(row.encrypted_material),
    encryptionNonce: new AdminSecretBytes(row.encryption_nonce),
    keyVersion: row.key_version,
  };
}

function authorityAccountRef(authority: AdminAccountCreationAuthority): string | undefined {
  if (authority.kind === 'initial_bootstrap') return undefined;
  const parsed = accountRefSchema.safeParse(authority.actorAccountRef);
  if (!parsed.success) throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
  return parsed.data;
}

export class PostgresAdminIdentity {
  readonly #dummyPasswordHash: Promise<AdminPasswordHash>;
  readonly #now: () => Date;
  readonly #randomSource: RandomSource;

  public constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresAdminIdentityOptions,
  ) {
    if (
      !millisecondsAreValid(options.preauthenticationTtlMilliseconds) ||
      !millisecondsAreValid(options.sessionTtlMilliseconds) ||
      options.preauthenticationTtlMilliseconds >= options.sessionTtlMilliseconds
    ) {
      throw new TypeError('Admin identity session policy is invalid');
    }
    const hmacKey = options.sessionHmacKey.copy();
    try {
      if (hmacKey.length < 32) throw new TypeError('Admin identity HMAC key is invalid');
    } finally {
      hmacKey.fill(0);
    }
    this.#now = options.now ?? (() => new Date());
    this.#randomSource = options.randomSource ?? randomBytes;
    this.#dummyPasswordHash = hashAdminPassword(
      dummyPassword,
      options.passwordPolicy,
      this.#randomSource,
    );
  }

  public async createAccount(
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly accountRef: string; readonly status: 'applied' | 'duplicate' }> {
    const command = createAccountSchema.parse(input);
    const loginName = normalizeLoginName(command.loginName);
    if (loginName === undefined) throw new TypeError('Admin account input is invalid');
    const mfaSeed = command.mfaSeed.copy();
    if (mfaSeed.length < 16 || mfaSeed.length > 64) {
      mfaSeed.fill(0);
      throw new TypeError('Admin account input is invalid');
    }
    const actorAccountRef = authorityAccountRef(authority);
    const passwordHash = await hashAdminPassword(
      command.password.reveal(),
      this.options.passwordPolicy,
      this.#randomSource,
    );
    const protectedMfa = protectMfaSeed(
      command.mfaSeed,
      this.options.mfaProtector,
      this.#randomSource,
    );
    mfaSeed.fill(0);

    const passwordSalt = passwordHash.salt.copy();
    const passwordBytes = passwordHash.hash.copy();
    const encryptedMaterial = protectedMfa.encryptedMaterial.copy();
    const encryptionNonce = protectedMfa.encryptionNonce.copy();
    const authenticationTag = protectedMfa.authenticationTag.copy();
    try {
      return await withBoundedTransaction(this.pool, async (client) => {
        await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
          command.requestKey,
        ]);

        let actorAccountId: string | undefined;
        if (authority.kind === 'initial_bootstrap') {
          await client.query(`lock table admin_accounts in share row exclusive mode`);
          const count = await client.query<{ readonly count: string }>(
            `select count(*)::text as count from admin_accounts`,
          );
          if (count.rows[0]?.count !== '0') {
            throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
          }
        } else if (actorAccountRef !== undefined) {
          actorAccountId = await this.requireAdministrator(
            client,
            actorAccountRef,
            this.trustedNow(),
          );
        }

        const existing = await client.query<{ readonly object_ref: string }>(
          `select object_ref
           from admin_audit_events
           where request_key = $1 and action = 'account_created'`,
          [command.requestKey],
        );
        if (existing.rows[0] !== undefined) {
          if (existing.rows[0].object_ref !== command.accountRef) {
            throw new AdminIdentityConflictError('Admin account request conflicts');
          }
          return { accountRef: command.accountRef, status: 'duplicate' };
        }

        let inserted: pg.QueryResult<{ readonly id: string }>;
        try {
          inserted = await client.query<{ readonly id: string }>(
            `insert into admin_accounts (
               account_ref, login_name, password_algorithm, password_cost,
               password_block_size, password_parallelization, password_key_length,
               password_salt, password_hash, state, created_at, updated_at,
               password_changed_at, revoked_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10, $10, null)
             returning id`,
            [
              command.accountRef,
              loginName,
              passwordHash.algorithm,
              passwordHash.cost,
              passwordHash.blockSize,
              passwordHash.parallelization,
              passwordHash.keyLength,
              passwordSalt,
              passwordBytes,
              command.createdAt,
            ],
          );
        } catch (error) {
          if (isPostgresError(error, '23505')) {
            throw new AdminIdentityConflictError('Admin account already exists');
          }
          throw error;
        }
        const accountId = inserted.rows[0]?.id;
        if (accountId === undefined) throw new Error('Admin account insert failed');
        await client.query(
          `insert into admin_mfa_credentials (
             account_id, algorithm, key_version, encrypted_material, encryption_nonce,
             authentication_tag, last_accepted_counter, created_at, updated_at, revoked_at
           ) values ($1, 'totp_sha1_v1', $2, $3, $4, $5, null, $6, $6, null)`,
          [
            accountId,
            protectedMfa.keyVersion,
            encryptedMaterial,
            encryptionNonce,
            authenticationTag,
            command.createdAt,
          ],
        );

        if (authority.kind === 'initial_bootstrap') {
          actorAccountId = accountId;
          const roleRequestKey = `${command.requestKey}.administrator`;
          await client.query(
            `insert into admin_role_assignments (
               account_id, role, action, actor_account_id, effective_at, request_key
             ) values ($1, 'administrator', 'assign', $1, $2, $3)`,
            [accountId, command.createdAt, roleRequestKey],
          );
          await this.insertAudit(client, {
            action: 'role_assigned',
            actorAccountId,
            effectiveAt: command.createdAt,
            objectRef: command.accountRef,
            objectType: 'account',
            reasonCode: 'initial_bootstrap',
            requestKey: roleRequestKey,
            result: 'applied',
          });
        }

        await this.insertAudit(client, {
          action: 'account_created',
          actorAccountId,
          effectiveAt: command.createdAt,
          objectRef: command.accountRef,
          objectType: 'account',
          reasonCode:
            authority.kind === 'initial_bootstrap' ? 'initial_bootstrap' : 'administrator_created',
          requestKey: command.requestKey,
          result: 'applied',
        });
        return { accountRef: command.accountRef, status: 'applied' };
      });
    } finally {
      passwordSalt.fill(0);
      passwordBytes.fill(0);
      encryptedMaterial.fill(0);
      encryptionNonce.fill(0);
      authenticationTag.fill(0);
    }
  }

  public assignRole(
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly role: AdminRole; readonly status: 'applied' | 'duplicate' }> {
    return this.recordRoleChange('assign', input, authority);
  }

  public revokeRole(
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly role: AdminRole; readonly status: 'applied' | 'duplicate' }> {
    return this.recordRoleChange('revoke', input, authority);
  }

  public async beginPasswordAuthentication(input: unknown): Promise<AdminAuthenticationResult> {
    const at = this.trustedNow();
    const parsed = beginAuthenticationSchema.safeParse(input);
    const loginName = parsed.success ? normalizeLoginName(parsed.data.loginName) : undefined;
    const candidatePassword = parsed.success ? parsed.data.password.reveal() : dummyPassword;
    const passwordIsStructurallyValid =
      candidatePassword.length >= 14 && candidatePassword.length <= 256 && loginName !== undefined;

    const selected =
      loginName === undefined
        ? undefined
        : await withBoundedTransaction(this.pool, async (client) => {
            const result = await client.query<AccountCredentialRow>(
              `select id, account_ref, password_algorithm, password_cost, password_block_size,
                      password_parallelization, password_key_length, password_salt, password_hash,
                      state, row_version
               from admin_accounts
               where login_name = $1`,
              [loginName],
            );
            return result.rows[0];
          });
    const hash =
      selected === undefined ? await this.#dummyPasswordHash : passwordHashFromRow(selected);
    const verification = await verifyAdminPassword(
      passwordIsStructurallyValid ? candidatePassword : dummyPassword,
      hash,
      this.options.passwordPolicy,
    );
    if (
      !parsed.success ||
      !passwordIsStructurallyValid ||
      selected?.state !== 'active' ||
      !verification.valid
    ) {
      await this.recordAuthenticationFailure('password_authentication_failed', at);
      return denied;
    }

    const sessionToken = createAdminSessionToken(this.#randomSource);
    const csrfToken = createAdminSessionToken(this.#randomSource);
    const sessionHash = hashAdminSessionToken(
      sessionToken,
      this.options.sessionHmacKey,
      'admin-session-v1',
    ).copy();
    const csrfHash = hashAdminSessionToken(
      csrfToken,
      this.options.sessionHmacKey,
      'admin-csrf-v1',
    ).copy();
    const expiresAt = addMilliseconds(at, this.options.preauthenticationTtlMilliseconds);
    try {
      const created = await withBoundedTransaction(this.pool, async (client) => {
        const current = await client.query<{ readonly id: string }>(
          `select id from admin_accounts
           where id = $1 and row_version = $2 and state = 'active'
           for update`,
          [selected.id, selected.row_version],
        );
        if (current.rows[0] === undefined) return false;
        const session = await client.query<{ readonly id: string }>(
          `insert into admin_sessions (
             account_id, session_hash, csrf_hash, state, created_at, expires_at,
             last_seen_at, authenticated_at, revoked_at
           ) values ($1, $2, $3, 'preauth', $4, $5, $4, null, null)
           returning id`,
          [selected.id, sessionHash, csrfHash, at, expiresAt],
        );
        const sessionId = session.rows[0]?.id;
        if (sessionId === undefined) throw new Error('Admin session insert failed');
        await this.insertAudit(client, {
          action: 'password_authentication_passed',
          actorAccountId: selected.id,
          effectiveAt: at,
          objectRef: selected.account_ref,
          objectType: 'account',
          reasonCode: 'credential_verified',
          result: 'applied',
        });
        await this.insertAudit(client, {
          action: 'session_created',
          actorAccountId: selected.id,
          effectiveAt: at,
          objectRef: `SESSION_${sessionId}`,
          objectType: 'session',
          reasonCode: 'mfa_pending',
          result: 'applied',
        });
        return true;
      });
      if (!created) {
        await this.recordAuthenticationFailure('password_authentication_failed', at);
        return denied;
      }
      return { csrfToken, expiresAt, sessionToken, status: 'mfa_required' };
    } finally {
      sessionHash.fill(0);
      csrfHash.fill(0);
    }
  }

  public async completeMfaAuthentication(input: unknown): Promise<AdminMfaAuthenticationResult> {
    const at = this.trustedNow();
    const parsed = completeAuthenticationSchema.safeParse(input);
    if (!parsed.success) {
      await this.recordAuthenticationFailure('mfa_authentication_failed', at);
      return denied;
    }
    const preauthenticationHash = hashAdminSessionToken(
      parsed.data.preauthenticationToken,
      this.options.sessionHmacKey,
      'admin-session-v1',
    ).copy();
    const sessionToken = createAdminSessionToken(this.#randomSource);
    const csrfToken = createAdminSessionToken(this.#randomSource);
    const activeSessionHash = hashAdminSessionToken(
      sessionToken,
      this.options.sessionHmacKey,
      'admin-session-v1',
    ).copy();
    const csrfHash = hashAdminSessionToken(
      csrfToken,
      this.options.sessionHmacKey,
      'admin-csrf-v1',
    ).copy();
    const expiresAt = addMilliseconds(at, this.options.sessionTtlMilliseconds);
    try {
      return await withBoundedTransaction(this.pool, async (client) => {
        const selected = await client.query<MfaSessionRow>(
          `select session.id as session_id, session.account_id, session.state,
                  session.expires_at, account.account_ref, mfa.id as mfa_id,
                  mfa.key_version, mfa.encrypted_material, mfa.encryption_nonce,
                  mfa.authentication_tag, mfa.last_accepted_counter
           from admin_sessions as session
           join admin_accounts as account on account.id = session.account_id
           join admin_mfa_credentials as mfa on mfa.account_id = account.id
           where session.session_hash = $1
             and account.state = 'active'
             and mfa.revoked_at is null
           for update of session, account, mfa`,
          [preauthenticationHash],
        );
        const row = selected.rows[0];
        if (row?.state !== 'preauth' || at.getTime() >= row.expires_at.getTime()) {
          if (row?.state === 'preauth') {
            await client.query(
              `update admin_sessions
               set state = 'expired', revoked_at = $2, row_version = row_version + 1
               where id = $1 and state = 'preauth'`,
              [row.session_id, at],
            );
          }
          await this.insertAudit(client, {
            action: 'mfa_authentication_failed',
            effectiveAt: at,
            reasonCode: 'authentication_denied',
            result: 'denied',
          });
          return denied;
        }

        const verification: ReturnType<typeof verifyTotpCode> = (() => {
          try {
            return verifyTotpCode({
              at,
              code: parsed.data.code,
              lastAcceptedCounter:
                row.last_accepted_counter === null ? null : Number(row.last_accepted_counter),
              policy: this.options.totpPolicy,
              protectedSeed: protectedSeedFromRow(row),
              protector: this.options.mfaProtector,
            });
          } catch {
            return { valid: false };
          }
        })();
        if (!verification.valid) {
          await this.insertAudit(client, {
            action: 'mfa_authentication_failed',
            effectiveAt: at,
            reasonCode: 'authentication_denied',
            result: 'denied',
          });
          return denied;
        }

        const accepted = await client.query(
          `update admin_mfa_credentials
           set last_accepted_counter = $2, updated_at = $3, row_version = row_version + 1
           where id = $1
             and (last_accepted_counter is null or last_accepted_counter < $2)`,
          [row.mfa_id, verification.counter, at],
        );
        if (accepted.rowCount !== 1) {
          await this.insertAudit(client, {
            action: 'mfa_authentication_failed',
            effectiveAt: at,
            reasonCode: 'authentication_denied',
            result: 'denied',
          });
          return denied;
        }

        await client.query(
          `update admin_sessions
           set state = 'revoked', revoked_at = $2, row_version = row_version + 1
           where id = $1 and state = 'preauth'`,
          [row.session_id, at],
        );
        const active = await client.query<{ readonly id: string }>(
          `insert into admin_sessions (
             account_id, session_hash, csrf_hash, state, created_at, expires_at,
             last_seen_at, authenticated_at, revoked_at
           ) values ($1, $2, $3, 'active', $4, $5, $4, $4, null)
           returning id`,
          [row.account_id, activeSessionHash, csrfHash, at, expiresAt],
        );
        const activeSessionId = active.rows[0]?.id;
        if (activeSessionId === undefined) throw new Error('Admin session rotation failed');
        await this.insertAudit(client, {
          action: 'mfa_authentication_passed',
          actorAccountId: row.account_id,
          effectiveAt: at,
          objectRef: row.account_ref,
          objectType: 'account',
          reasonCode: 'mfa_verified',
          result: 'applied',
        });
        await this.insertAudit(client, {
          action: 'session_revoked',
          actorAccountId: row.account_id,
          effectiveAt: at,
          objectRef: `SESSION_${row.session_id}`,
          objectType: 'session',
          reasonCode: 'session_rotated',
          result: 'applied',
        });
        await this.insertAudit(client, {
          action: 'session_created',
          actorAccountId: row.account_id,
          effectiveAt: at,
          objectRef: `SESSION_${activeSessionId}`,
          objectType: 'session',
          reasonCode: 'mfa_complete',
          result: 'applied',
        });
        return { csrfToken, expiresAt, sessionToken, status: 'authenticated' };
      });
    } finally {
      preauthenticationHash.fill(0);
      activeSessionHash.fill(0);
      csrfHash.fill(0);
    }
  }

  public async resolveSession(input: unknown): Promise<ResolvedAdminSession | undefined> {
    const at = this.trustedNow();
    const command = sessionCommandSchema.parse(input);
    const sessionHash = hashAdminSessionToken(
      command.sessionToken,
      this.options.sessionHmacKey,
      'admin-session-v1',
    ).copy();
    try {
      return await withBoundedTransaction(this.pool, async (client) => {
        const selected = await client.query<ActiveSessionRow>(
          `select session.id as session_id, session.account_id, session.state,
                  session.expires_at, account.account_ref, account.state as account_state
           from admin_sessions as session
           join admin_accounts as account on account.id = session.account_id
           where session.session_hash = $1
           for update of session, account`,
          [sessionHash],
        );
        const row = selected.rows[0];
        if (row?.state !== 'active' || row.account_state !== 'active') {
          return undefined;
        }
        if (at.getTime() >= row.expires_at.getTime()) {
          await client.query(
            `update admin_sessions
             set state = 'expired', revoked_at = $2, row_version = row_version + 1
             where id = $1 and state = 'active'`,
            [row.session_id, at],
          );
          return undefined;
        }
        await client.query(
          `update admin_sessions
           set last_seen_at = $2, row_version = row_version + 1
           where id = $1`,
          [row.session_id, at],
        );
        const roles = await this.currentRoles(client, row.account_id, at);
        return { accountRef: row.account_ref, expiresAt: row.expires_at, roles };
      });
    } finally {
      sessionHash.fill(0);
    }
  }

  public async revokeSession(
    input: unknown,
  ): Promise<{ readonly status: 'applied' | 'duplicate' }> {
    const at = this.trustedNow();
    const command = sessionCommandSchema.parse(input);
    const sessionHash = hashAdminSessionToken(
      command.sessionToken,
      this.options.sessionHmacKey,
      'admin-session-v1',
    ).copy();
    try {
      return await withBoundedTransaction(this.pool, async (client) => {
        const selected = await client.query<{
          readonly account_id: string;
          readonly id: string;
          readonly state: string;
        }>(
          `select id, account_id, state
           from admin_sessions
           where session_hash = $1
           for update`,
          [sessionHash],
        );
        const row = selected.rows[0];
        if (row === undefined || (row.state !== 'active' && row.state !== 'preauth')) {
          return { status: 'duplicate' };
        }
        await client.query(
          `update admin_sessions
           set state = 'revoked', revoked_at = $2, row_version = row_version + 1
           where id = $1`,
          [row.id, at],
        );
        await this.insertAudit(client, {
          action: 'session_revoked',
          actorAccountId: row.account_id,
          effectiveAt: at,
          objectRef: `SESSION_${row.id}`,
          objectType: 'session',
          reasonCode: 'logout',
          result: 'applied',
        });
        return { status: 'applied' };
      });
    } finally {
      sessionHash.fill(0);
    }
  }

  public async revokeAllSessions(
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly revokedCount: number }> {
    const at = this.trustedNow();
    const command = revokeAllSchema.parse(input);
    if (authority.kind !== 'administrator') {
      throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
    }
    const actorAccountRef = authorityAccountRef(authority);
    if (actorAccountRef === undefined) {
      throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      const actorId = await this.requireAdministrator(client, actorAccountRef, at);
      const target = await this.requireActiveAccount(client, command.targetAccountRef);
      await client.query(
        `update admin_sessions
         set state = 'expired', revoked_at = $2, row_version = row_version + 1
         where account_id = $1
           and state in ('active', 'preauth')
           and expires_at <= $2`,
        [target.id, at],
      );
      const revoked = await client.query(
        `update admin_sessions
         set state = 'revoked', revoked_at = $2, row_version = row_version + 1
         where account_id = $1
           and state in ('active', 'preauth')
           and expires_at > $2`,
        [target.id, at],
      );
      await this.insertAudit(client, {
        action: 'session_revoked',
        actorAccountId: actorId,
        effectiveAt: at,
        objectRef: target.account_ref,
        objectType: 'account',
        reasonCode: 'bulk_revocation',
        result: revoked.rowCount === 0 ? 'duplicate' : 'applied',
      });
      return { revokedCount: revoked.rowCount ?? 0 };
    });
  }

  private async recordRoleChange(
    action: 'assign' | 'revoke',
    input: unknown,
    authority: AdminAccountCreationAuthority,
  ): Promise<{ readonly role: AdminRole; readonly status: 'applied' | 'duplicate' }> {
    const command = roleCommandSchema.parse(input);
    if (authority.kind !== 'administrator') {
      throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
    }
    const actorAccountRef = authorityAccountRef(authority);
    if (actorAccountRef === undefined) {
      throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const actorId = await this.requireAdministrator(client, actorAccountRef, this.trustedNow());
      const existing = await client.query<ExistingRoleCommandRow>(
        `select assignment.action, assignment.role, assignment.effective_at,
                account.account_ref as target_account_ref
         from admin_role_assignments as assignment
         join admin_accounts as account on account.id = assignment.account_id
         where assignment.request_key = $1`,
        [command.requestKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        if (
          existingRow.action !== action ||
          existingRow.role !== command.role ||
          existingRow.target_account_ref !== command.targetAccountRef ||
          existingRow.effective_at.getTime() !== command.effectiveAt.getTime()
        ) {
          throw new AdminIdentityConflictError('Admin role request conflicts');
        }
        return { role: command.role, status: 'duplicate' };
      }

      const target = await this.requireActiveAccount(client, command.targetAccountRef);
      if (action === 'revoke' && command.role === 'administrator') {
        const administratorCount = await this.countActiveAdministrators(
          client,
          command.effectiveAt,
        );
        const targetRoles = await this.currentRoles(client, target.id, command.effectiveAt);
        if (targetRoles.includes('administrator') && administratorCount <= 1) {
          throw new AdminIdentityConflictError('The final administrator role cannot be revoked');
        }
      }
      await client.query(
        `insert into admin_role_assignments (
           account_id, role, action, actor_account_id, effective_at, request_key
         ) values ($1, $2, $3, $4, $5, $6)`,
        [target.id, command.role, action, actorId, command.effectiveAt, command.requestKey],
      );
      await this.insertAudit(client, {
        action: action === 'assign' ? 'role_assigned' : 'role_revoked',
        actorAccountId: actorId,
        effectiveAt: command.effectiveAt,
        objectRef: target.account_ref,
        objectType: 'account',
        reasonCode: action === 'assign' ? 'administrator_assignment' : 'administrator_revocation',
        requestKey: command.requestKey,
        result: 'applied',
      });
      return { role: command.role, status: 'applied' };
    });
  }

  private async requireAdministrator(
    client: pg.PoolClient,
    actorAccountRef: string,
    evaluatedAt: Date,
  ): Promise<string> {
    const actor = await this.requireActiveAccount(client, actorAccountRef);
    const roles = await this.currentRoles(client, actor.id, evaluatedAt);
    if (!roles.includes('administrator')) {
      throw new AdminIdentityNotAuthorizedError('Admin action is not authorized');
    }
    return actor.id;
  }

  private trustedNow(): Date {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('Admin identity clock is invalid');
    }
    return new Date(value);
  }

  private async requireActiveAccount(
    client: pg.PoolClient,
    accountRef: string,
  ): Promise<AccountIdentityRow> {
    const selected = await client.query<AccountIdentityRow>(
      `select id, account_ref, state
       from admin_accounts
       where account_ref = $1
       for update`,
      [accountRef],
    );
    const row = selected.rows[0];
    if (row?.state !== 'active') {
      throw new AdminIdentityNotFoundError('Admin account was not found');
    }
    return row;
  }

  private async currentRoles(
    client: pg.PoolClient,
    accountId: string,
    evaluatedAt: Date,
  ): Promise<readonly AdminRole[]> {
    const selected = await client.query<{ readonly role: AdminRole }>(
      `select current.role
       from (
         select distinct on (role) role, action
         from admin_role_assignments
         where account_id = $1 and effective_at <= $2
         order by role, effective_at desc, id desc
       ) as current
       where current.action = 'assign'
       order by current.role`,
      [accountId, evaluatedAt],
    );
    return selected.rows.map((row) => row.role);
  }

  private async countActiveAdministrators(
    client: pg.PoolClient,
    evaluatedAt: Date,
  ): Promise<number> {
    const selected = await client.query<{ readonly count: string }>(
      `select count(*)::text as count
       from admin_accounts as account
       where account.state = 'active'
         and exists (
           select 1
           from (
             select assignment.action
             from admin_role_assignments as assignment
             where assignment.account_id = account.id
               and assignment.role = 'administrator'
               and assignment.effective_at <= $1
             order by assignment.effective_at desc, assignment.id desc
             limit 1
           ) as current
           where current.action = 'assign'
         )`,
      [evaluatedAt],
    );
    return Number(selected.rows[0]?.count ?? '0');
  }

  private async recordAuthenticationFailure(
    action: 'mfa_authentication_failed' | 'password_authentication_failed',
    at: Date,
  ): Promise<void> {
    await withBoundedTransaction(this.pool, async (client) => {
      await this.insertAudit(client, {
        action,
        effectiveAt: at,
        reasonCode: 'authentication_denied',
        result: 'denied',
      });
    });
  }

  private async insertAudit(
    client: pg.PoolClient,
    event: {
      readonly action:
        | 'account_created'
        | 'mfa_authentication_failed'
        | 'mfa_authentication_passed'
        | 'password_authentication_failed'
        | 'password_authentication_passed'
        | 'role_assigned'
        | 'role_revoked'
        | 'session_created'
        | 'session_revoked';
      readonly actorAccountId?: string | undefined;
      readonly effectiveAt: Date;
      readonly objectRef?: string | undefined;
      readonly objectType?: 'account' | 'session' | undefined;
      readonly reasonCode: string;
      readonly requestKey?: string | undefined;
      readonly result: 'applied' | 'denied' | 'duplicate' | 'failed';
    },
  ): Promise<void> {
    await client.query(
      `insert into admin_audit_events (
         actor_account_id, action, result, object_type, object_ref,
         reason_code, request_key, effective_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.actorAccountId ?? null,
        event.action,
        event.result,
        event.objectType ?? null,
        event.objectRef ?? null,
        event.reasonCode,
        event.requestKey ?? null,
        event.effectiveAt,
      ],
    );
  }
}
