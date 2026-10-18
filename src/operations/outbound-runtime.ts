import pg from 'pg';
import { z } from 'zod';

import { loadOutboundConfig } from '../outbound/outbound-config.js';
import { MetaOutboundClient } from '../outbound/meta-outbound-client.js';
import { OutboundWorker } from '../outbound/outbound-worker.js';
import { PostgresOutboundPolicy } from '../persistence/postgres-outbound-policy.js';
import { PostgresOutboundWorkStore } from '../persistence/postgres-outbound-work-store.js';
import { loadOperationsConfig } from './operations-config.js';
import type { RuntimeLifecycle } from './operations-types.js';
import { loadPrivacyKeyring } from './privacy-keyring.js';
import type { RoleRuntimeOptions } from './role-runtime.js';
import { checkRuntimeReadiness } from './runtime-readiness.js';
import { loadRoleEnvironment } from './secret-files.js';
import { createWorkerLoop } from './worker-loop.js';

export async function createOutboundRuntime(
  options: RoleRuntimeOptions,
): Promise<RuntimeLifecycle> {
  if (
    options.role !== 'outbound' ||
    (options.testTransports !== undefined && options.environment.NODE_ENV !== 'test')
  )
    throw new Error('outbound_runtime_configuration_invalid');
  const environment = await loadRoleEnvironment('outbound', options.environment);
  const config = loadOperationsConfig('outbound', environment);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(environment.OPS_GIT_REVISION);
  const schemaRevision = z
    .string()
    .regex(/^\d{6}$/u)
    .parse(environment.OPS_SCHEMA_REVISION);
  const keyring = loadPrivacyKeyring(new TextEncoder().encode(environment.PRIVACY_HMAC_KEYRING));
  const provider = config.outboundExecutionEnabled ? loadOutboundConfig(environment) : undefined;
  const deployment =
    provider === undefined
      ? undefined
      : Object.freeze({
          ...provider.deploymentBounds,
          workerBatchSize: Math.min(provider.deploymentBounds.workerBatchSize, config.batchSize),
          leaseMs: Math.min(provider.deploymentBounds.leaseMs, config.leaseMilliseconds),
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
  const store =
    deployment === undefined ? undefined : new PostgresOutboundWorkStore(pool, keyring, deployment);
  const worker =
    provider === undefined || store === undefined
      ? undefined
      : new OutboundWorker({
          store,
          now: options.now,
          maximumResponseBytes: provider.maximumResponseBytes,
          provider: new MetaOutboundClient({
            config: provider,
            logger: options.logger,
            now: options.now,
            ...(options.testTransports?.meta === undefined
              ? {}
              : { fetch: options.testTransports.meta }),
          }),
        });
  const loop = createWorkerLoop({
    now: options.now,
    pollMilliseconds: config.pollMilliseconds,
    shutdownGraceMilliseconds: config.maximumCallMilliseconds + config.shutdownGraceMilliseconds,
    onHeartbeat: (heartbeat) => {
      options.onHeartbeat?.(
        !config.outboundExecutionEnabled && heartbeat.state === 'unavailable'
          ? { ...heartbeat, state: 'disabled' }
          : heartbeat,
      );
    },
    isReady: async () => {
      if (!config.outboundExecutionEnabled || deployment === undefined) return false;
      return (
        (
          await checkRuntimeReadiness(
            {
              role: 'outbound',
              revision,
              expectedSchemaRevision: schemaRevision,
              externalExecutionEnabled: true,
              timeoutMilliseconds: config.maximumCallMilliseconds,
            },
            {
              now: options.now,
              readSchemaRevision: async () =>
                (
                  await pool.query<{ name: string }>(
                    'select name from pgmigrations order by id desc limit 1',
                  )
                ).rows[0]?.name.split('_')[0] ?? '',
              readDeployedRevision: async () => {
                const row = (
                  await pool.query<{ git_revision: string; status: string }>(
                    'select git_revision,status from operations_deployments order by recorded_at desc,id desc limit 1',
                  )
                ).rows[0];
                return row?.status === 'started' || row?.status === 'succeeded'
                  ? row.git_revision
                  : '';
              },
              hasRequiredPolicy: async (_role, evaluatedAt) =>
                (
                  await new PostgresOutboundPolicy(pool).resolveEffectivePolicy(
                    evaluatedAt,
                    deployment,
                  )
                ).status === 'enabled',
              // No provider request is a readiness probe. Exact client endpoints are checked at send time.
              checkPrivateDependency: () => Promise.resolve('healthy'),
            },
          )
        ).state === 'healthy'
      );
    },
    runBatch: async (signal) => {
      if (worker !== undefined && !signal.aborted)
        await worker.runBatch({ evaluatedAt: options.now(), workerRef: 'outbound', signal });
    },
  });
  let stop: Promise<void> | undefined;
  return {
    start: async () => {
      await loop.start();
      options.logger.info('worker_started');
    },
    stop: () => {
      stop ??= (async () => {
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
      return stop;
    },
  };
}
