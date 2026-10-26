import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { noopSafeLogger, type SafeLogger } from '../logging.js';
import { PostgresAdminIdentity } from '../persistence/postgres-admin-identity.js';
import { PostgresAdminDashboard } from '../persistence/postgres-admin-dashboard.js';
import { PostgresAdminOperations } from '../persistence/postgres-admin-operations.js';
import { buildAdminApp } from './admin-app.js';
import { loadAdminConfig } from './admin-config.js';
import { AesGcmAdminSecretProtector } from './mfa.js';
import { loadRoleEnvironment } from '../operations/secret-files.js';
import { startAdminSocket, type AdminSocketHandle } from './admin-socket.js';

export interface CreateAdminRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger?: SafeLogger;
  readonly now?: () => Date;
  readonly poolFactory?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
  readonly hostHealthSnapshot?: () => Promise<unknown>;
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
  readonly stop: () => Promise<'closed' | 'process_exit_required'>;
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
    operations: new PostgresAdminOperations(pool, identity, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.hostHealthSnapshot === undefined
        ? {}
        : { hostSnapshot: options.hostHealthSnapshot }),
      modelEnabled: options.environment.MODEL_EXECUTION_ENABLED === 'true',
      notificationsEnabled: options.environment.N8N_EXECUTION_ENABLED === 'true',
      outboundEnabled: options.environment.OUTBOUND_EXECUTION_ENABLED === 'true',
    }),
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
  let poolClosure: Promise<void> | undefined;
  const closePool = () => (poolClosure ??= pool.end());
  app.addHook('onClose', closePool);
  let socket: AdminSocketHandle | undefined;
  let startInvoked = false;
  let stopping: Promise<'closed' | 'process_exit_required'> | undefined;
  return {
    app,
    stop: () =>
      (stopping ??= (async () => {
        if (socket === undefined) {
          await app.close();
          return 'closed';
        }
        const status = await socket.close();
        await closePool();
        return status;
      })()),
    start: async () => {
      if (startInvoked) throw new Error('admin_socket_invalid');
      startInvoked = true;
      try {
        if (config.listener.kind === 'unix')
          socket = await startAdminSocket(app, config.listener.path);
        else await app.listen({ host: config.listener.host, port: config.listener.port });
      } catch (error) {
        if (error instanceof Error && error.message === 'admin_socket_exit_required')
          await closePool();
        else await app.close();
        throw error;
      }
      logger.info('admin_service_started');
    },
  };
}
