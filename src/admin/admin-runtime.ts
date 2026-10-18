import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { noopSafeLogger, type SafeLogger } from '../logging.js';
import { PostgresAdminIdentity } from '../persistence/postgres-admin-identity.js';
import { PostgresAdminDashboard } from '../persistence/postgres-admin-dashboard.js';
import { buildAdminApp } from './admin-app.js';
import { loadAdminConfig } from './admin-config.js';
import { AesGcmAdminSecretProtector } from './mfa.js';
import { loadRoleEnvironment } from '../operations/secret-files.js';

export interface CreateAdminRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger?: SafeLogger;
  readonly now?: () => Date;
  readonly poolFactory?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
}
export async function createAdminRoleRuntime(
  options: CreateAdminRuntimeOptions,
): Promise<AdminRuntime> {
  const environment = await loadRoleEnvironment('admin', options.environment, options.readSecret);
  return createAdminRuntime({ ...options, environment });
}
export interface AdminRuntime {
  readonly app: FastifyInstance;
  readonly start: () => Promise<void>;
}
export function createAdminRuntime(options: CreateAdminRuntimeOptions): AdminRuntime {
  const config = loadAdminConfig(options.environment);
  const logger = options.logger ?? noopSafeLogger;
  const pool = (options.poolFactory ?? ((configuration) => new pg.Pool(configuration)))({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 750,
    idleTimeoutMillis: 30000,
    idle_in_transaction_session_timeout: 4000,
    lock_timeout: 750,
    max: 10,
    query_timeout: 4000,
    statement_timeout: 3000,
  });
  pool.on('error', () => {
    logger.error('database_pool_error');
  });
  const identity = new PostgresAdminIdentity(pool, {
    mfaProtector: new AesGcmAdminSecretProtector(config.mfaKeyVersion, config.mfaEncryptionKey),
    now: options.now,
    passwordPolicy: config.passwordPolicy,
    preauthenticationTtlMilliseconds: config.preauthenticationTtlMilliseconds,
    sessionHmacKey: config.sessionHmacKey,
    sessionTtlMilliseconds: config.sessionTtlMilliseconds,
    totpPolicy: config.totpPolicy,
  });
  const dashboard = new PostgresAdminDashboard(pool, identity, {
    ...(options.now === undefined ? {} : { now: options.now }),
    listLimit: config.listLimit,
    learningPolicy: config.learningPolicy,
  });
  const app = buildAdminApp({
    listLimit: config.listLimit,
    identity,
    dashboard,
    logger,
    now: options.now,
    origin: config.origin,
    secureCookie: config.secureCookie,
    actionKey: config.sessionHmacKey,
    actionTtlMilliseconds: config.actionTtlMilliseconds,
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return {
    app,
    start: async () => {
      try {
        await app.listen({ host: config.host, port: config.port });
      } catch (error) {
        await app.close();
        throw error;
      }
      logger.info('admin_service_started');
    },
  };
}
