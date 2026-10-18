import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { noopSafeLogger, type SafeLogger } from './logging.js';
import { PostgresReceiptStore } from './persistence/postgres-receipt-store.js';
import type { PrivacyHmacKeyring } from './policy/policy-types.js';
import type { WebhookReceiptSink } from './receipts/webhook-receipt.js';
import { loadRoleEnvironment } from './operations/secret-files.js';
import { loadPrivacyKeyring } from './operations/privacy-keyring.js';

export interface CreateRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger?: SafeLogger;
  readonly poolFactory?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly privacyKeyring?: PrivacyHmacKeyring;
  readonly receiptSink?: WebhookReceiptSink;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
}
export async function createWebhookRuntime(options: CreateRuntimeOptions): Promise<AppRuntime> {
  const environment = await loadRoleEnvironment('webhook', options.environment, options.readSecret);
  const privacyKeyring = loadPrivacyKeyring(
    new TextEncoder().encode(environment.PRIVACY_HMAC_KEYRING),
  );
  return createRuntime({ ...options, environment, privacyKeyring });
}

export interface AppRuntime {
  readonly app: FastifyInstance;
  readonly start: () => Promise<void>;
}

function unavailableReceiptSink(): Promise<void> {
  return Promise.reject(new Error('Durable receipt sink is not configured'));
}

export function createRuntime(options: CreateRuntimeOptions): AppRuntime {
  const config = loadConfig(options.environment);
  const logger = options.logger ?? noopSafeLogger;
  const pool =
    options.receiptSink === undefined && config.databaseUrl !== undefined
      ? (options.poolFactory ?? ((configuration) => new pg.Pool(configuration)))({
          connectionString: config.databaseUrl,
          connectionTimeoutMillis: 750,
          idleTimeoutMillis: 30_000,
          idle_in_transaction_session_timeout: 4_000,
          lock_timeout: 750,
          max: 10,
          query_timeout: 4_000,
          statement_timeout: 3_000,
        })
      : undefined;
  pool?.on('error', () => {
    logger.error('database_pool_error');
  });
  const postgresStore =
    pool === undefined || options.privacyKeyring === undefined
      ? undefined
      : new PostgresReceiptStore(pool, options.privacyKeyring);
  const app = buildApp({
    logger,
    metaAppSecret: config.metaAppSecret,
    metaVerifyToken: config.metaVerifyToken,
    receiptSink:
      options.receiptSink ??
      (postgresStore === undefined
        ? unavailableReceiptSink
        : async (receipt) => postgresStore.store(receipt)),
  });

  if (pool !== undefined) {
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  return {
    app,
    start: async () => {
      await app.listen({ host: config.host, port: config.port });
      logger.info('service_started');
    },
  };
}
