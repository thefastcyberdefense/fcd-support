import pg from 'pg';
import { z } from 'zod';

import { createN8nClient, createN8nSigningSecret } from '../notifications/n8n-client.js';
import { NotificationWorker } from '../notifications/notification-worker.js';
import { PostgresNotificationWork } from '../persistence/postgres-notification-work.js';
import { loadOperationsConfig } from './operations-config.js';
import type { RoleRuntimeOptions } from './role-runtime.js';
import { databaseReadinessPorts } from './role-runtime.js';
import type { RuntimeLifecycle } from './operations-types.js';
import { checkRuntimeReadiness } from './runtime-readiness.js';
import { loadRoleEnvironment } from './secret-files.js';
import { createWorkerLoop } from './worker-loop.js';

const integer = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));

export async function createNotificationRuntime(
  options: RoleRuntimeOptions,
): Promise<RuntimeLifecycle> {
  if (
    options.role !== 'notification' ||
    (options.testTransports !== undefined && options.environment.NODE_ENV !== 'test')
  )
    throw new Error('notification_runtime_configuration_invalid');
  const environment = await loadRoleEnvironment('notification', options.environment);
  const config = loadOperationsConfig('notification', environment);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(environment.OPS_GIT_REVISION);
  const schemaRevision = z
    .string()
    .regex(/^\d{6}$/u)
    .parse(environment.OPS_SCHEMA_REVISION);
  const delivery = config.n8nExecutionEnabled
    ? z
        .object({
          N8N_ORIGIN: z.string(),
          N8N_PATH: z.string(),
          N8N_PROVIDER_TIMEOUT_MS: integer(100, 300000),
          N8N_MAX_RESPONSE_BYTES: integer(1, 1048576),
          N8N_MAX_ATTEMPTS: integer(1, 100),
          N8N_RETRY_BASE_MS: integer(100, 86400000),
          N8N_RETRY_MAXIMUM_MS: integer(100, 604800000),
          N8N_ALLOW_LOOPBACK_FAKE: z.enum(['true', 'false']),
        })
        .refine((value) => value.N8N_RETRY_BASE_MS <= value.N8N_RETRY_MAXIMUM_MS)
        .parse(environment)
    : undefined;
  if (delivery?.N8N_ALLOW_LOOPBACK_FAKE === 'true' && environment.NODE_ENV !== 'test')
    throw new Error('notification_runtime_configuration_invalid');
  const testTransport = options.testTransports?.n8n;
  const client =
    delivery === undefined
      ? undefined
      : createN8nClient({
          origin: delivery.N8N_ORIGIN,
          path: delivery.N8N_PATH,
          signingSecret: createN8nSigningSecret(environment.N8N_ESCALATION_WEBHOOK_SECRET ?? ''),
          now: options.now,
          timeoutMilliseconds: delivery.N8N_PROVIDER_TIMEOUT_MS,
          maximumResponseBytes: delivery.N8N_MAX_RESPONSE_BYTES,
          syntheticMode: delivery.N8N_ALLOW_LOOPBACK_FAKE === 'true',
          ...(testTransport === undefined
            ? {}
            : {
                fetch: async (
                  url: string,
                  init: RequestInit,
                  destination: { readonly address: string },
                ) => ({
                  response: await testTransport(url, init),
                  remoteAddress: destination.address,
                }),
              }),
        });
  const pool = (options.poolFactory ?? ((configuration) => new pg.Pool(configuration)))({
    connectionString: environment.DATABASE_URL,
    max: config.batchSize,
    connectionTimeoutMillis: config.maximumCallMilliseconds,
    query_timeout: config.maximumCallMilliseconds,
    statement_timeout: config.maximumCallMilliseconds,
    idle_in_transaction_session_timeout: config.maximumCallMilliseconds,
    idleTimeoutMillis: config.maximumCallMilliseconds,
  });
  pool.on('error', () => {
    options.logger.error('database_pool_error');
  });
  const worker =
    delivery === undefined || client === undefined
      ? undefined
      : new NotificationWorker({
          client,
          now: options.now,
          batchSize: config.batchSize,
          leaseMilliseconds: config.leaseMilliseconds,
          maximumCallMilliseconds: delivery.N8N_PROVIDER_TIMEOUT_MS,
          store: new PostgresNotificationWork(pool, {
            maximumAttempts: delivery.N8N_MAX_ATTEMPTS,
            retryBaseMilliseconds: delivery.N8N_RETRY_BASE_MS,
            retryMaximumMilliseconds: delivery.N8N_RETRY_MAXIMUM_MS,
          }),
        });
  const loop = createWorkerLoop({
    now: options.now,
    pollMilliseconds: config.pollMilliseconds,
    shutdownGraceMilliseconds: config.maximumCallMilliseconds + config.shutdownGraceMilliseconds,
    onHeartbeat: (heartbeat) => {
      options.onHeartbeat?.(
        !config.n8nExecutionEnabled && heartbeat.state === 'unavailable'
          ? { ...heartbeat, state: 'disabled' }
          : heartbeat,
      );
    },
    isReady: async () => {
      if (!config.n8nExecutionEnabled) return false;
      return (
        (
          await checkRuntimeReadiness(
            {
              role: 'notification',
              revision,
              expectedSchemaRevision: schemaRevision,
              externalExecutionEnabled: true,
              timeoutMilliseconds: config.maximumCallMilliseconds,
            },
            databaseReadinessPorts(pool, options.now, () => Promise.resolve(true)),
          )
        ).state === 'healthy'
      );
    },
    runBatch: async (signal) => {
      if (worker !== undefined && !signal.aborted)
        await worker.runBatch({ workerRef: 'notification', signal });
    },
  });
  let stopped: Promise<void> | undefined;
  return {
    start: async () => {
      await loop.start();
      options.logger.info('worker_started');
    },
    stop: () => {
      stopped ??= (async () => {
        const began = performance.now();
        await loop.stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            pool.end(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => {
                  reject(new Error('runtime_shutdown_timeout'));
                },
                Math.max(0, config.stopGraceMilliseconds - (performance.now() - began)),
              );
            }),
          ]);
          options.logger.info('worker_stopped');
        } finally {
          clearTimeout(timer);
        }
      })();
      return stopped;
    },
  };
}
