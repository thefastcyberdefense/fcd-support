import pg from 'pg';

import { createManifestClient } from '../model/manifest-client.js';
import { PostgresConversationEventProcessor } from '../persistence/postgres-conversation-event-processor.js';
import { PostgresModelAllowance } from '../persistence/postgres-model-allowance.js';
import { PostgresModelPolicy } from '../persistence/postgres-model-policy.js';
import { PostgresOutboundIntentStore } from '../persistence/postgres-outbound-intent-store.js';
import {
  PostgresProcessingWork,
  type ProcessingClaim,
} from '../persistence/postgres-processing-work.js';
import { PostgresReplyDraftStore } from '../persistence/postgres-reply-draft-store.js';
import { ModelReplyService } from '../replies/model-reply-service.js';
import { ReplyDecisionService } from '../replies/reply-decision-service.js';
import { inspectSensitiveText } from '../safety/sensitive-data-gate.js';
import { loadOperationsConfig } from './operations-config.js';
import type { RuntimeLifecycle } from './operations-types.js';
import { loadPrivacyKeyring } from './privacy-keyring.js';
import { loadReplySettings } from './reply-config.js';
import { runReplyStage } from './reply-pipeline.js';
import { PostgresReplyRuntimeState, PostgresRuntimeFaqResolver } from './reply-state.js';
import type { RoleRuntimeOptions } from './role-runtime.js';
import { checkRuntimeReadiness } from './runtime-readiness.js';
import { loadRoleEnvironment } from './secret-files.js';
import { createWorkerLoop } from './worker-loop.js';

export async function createReplyRuntime(options: RoleRuntimeOptions): Promise<RuntimeLifecycle> {
  if (
    options.role !== 'reply' ||
    (options.testTransports !== undefined && options.environment.NODE_ENV !== 'test')
  )
    throw new Error('reply_configuration_invalid');
  const environment = await loadRoleEnvironment('reply', options.environment);
  const config = loadOperationsConfig('reply', environment);
  const settings = loadReplySettings(environment, config.modelExecutionEnabled);
  const keyring = loadPrivacyKeyring(new TextEncoder().encode(environment.PRIVACY_HMAC_KEYRING));
  const modelConfig = settings.model;
  const manifest =
    modelConfig === undefined
      ? undefined
      : createManifestClient({
          apiKey: modelConfig.apiKey ?? '',
          baseUrl: modelConfig.baseUrl,
          maximumResponseBytes: modelConfig.deploymentCeilings.responseBytes,
          totalTimeoutMs: modelConfig.deploymentCeilings.totalTimeoutMs,
          logger: options.logger,
          ...(options.testTransports?.manifest === undefined
            ? {}
            : { fetch: options.testTransports.manifest }),
        });
  const pool = (options.poolFactory ?? ((configuration) => new pg.Pool(configuration)))({
    connectionString: environment.DATABASE_URL,
    connectionTimeoutMillis: config.maximumCallMilliseconds,
    query_timeout: config.maximumCallMilliseconds,
    statement_timeout: config.maximumCallMilliseconds,
    idle_in_transaction_session_timeout: config.maximumCallMilliseconds,
    idleTimeoutMillis: config.maximumCallMilliseconds,
    max: config.batchSize,
  });
  pool.on('error', () => {
    options.logger.error('database_pool_error');
  });
  const work = new PostgresProcessingWork(pool);
  const drafts = new PostgresReplyDraftStore(pool, keyring);
  const state = new PostgresReplyRuntimeState(pool, keyring);
  const processor = new PostgresConversationEventProcessor(pool);
  const decision = new ReplyDecisionService({
    store: drafts,
    inspectSensitiveText,
    faqResolver: new PostgresRuntimeFaqResolver(pool, settings.faq),
  });
  const model =
    manifest === undefined || modelConfig === undefined
      ? undefined
      : new ModelReplyService({
          store: drafts,
          manifest,
          deployment: modelConfig.deploymentCeilings,
          manifestAttestation: settings.attestation,
          policy: new PostgresModelPolicy(pool),
          allowance: new PostgresModelAllowance(pool),
          now: options.now,
        });
  const intent = new PostgresOutboundIntentStore(pool, keyring, settings.outboundBounds);
  const loop = createWorkerLoop({
    now: options.now,
    pollMilliseconds: config.pollMilliseconds,
    shutdownGraceMilliseconds: config.maximumCallMilliseconds + config.shutdownGraceMilliseconds,
    ...(options.onHeartbeat === undefined ? {} : { onHeartbeat: options.onHeartbeat }),
    isReady: async () => {
      // Core readiness must not suppress FAQ/safe escalation during a model outage.
      // Model policy and Manifest attestations are rechecked at the model-use boundary.
      const result = await checkRuntimeReadiness(
        {
          role: 'reply',
          revision: settings.revision,
          expectedSchemaRevision: settings.schemaRevision,
          externalExecutionEnabled: false,
          timeoutMilliseconds: config.maximumCallMilliseconds,
        },
        {
          now: options.now,
          readSchemaRevision: async () => {
            const result = await pool.query<{ name: string }>(
              'select name from pgmigrations order by id desc limit 1',
            );
            return result.rows[0]?.name.split('_')[0] ?? '';
          },
          readDeployedRevision: async () => {
            const result = await pool.query<{ git_revision: string; status: string }>(
              'select git_revision,status from operations_deployments order by recorded_at desc,id desc limit 1',
            );
            const row = result.rows[0];
            return row?.status === 'started' || row?.status === 'succeeded' ? row.git_revision : '';
          },
          hasRequiredPolicy: () => Promise.resolve(true),
          checkPrivateDependency: () => Promise.resolve('healthy'),
        },
      );
      return result.state === 'healthy';
    },
    runBatch: async (signal) => {
      const isAborted = (): boolean => signal.aborted;
      try {
        if (isAborted()) return;
        await work.reconcile(config.batchSize, options.now());
        for (let index = 0; index < config.batchSize && !isAborted(); index++) {
          // Claim one at a time: queued items must not consume their leases while earlier calls run.
          const claim = (
            await work.claim({
              workerRef: 'reply',
              evaluatedAt: options.now(),
              limit: 1,
              leaseMilliseconds: config.leaseMilliseconds,
            })
          )[0];
          if (claim === undefined) break;
          let current: ProcessingClaim = claim;
          for (let step = 0; step < 4 && !isAborted(); step++) {
            const result = await runReplyStage(current, {
              processor,
              decision,
              model,
              drafts,
              state,
              intent,
              work,
              now: options.now,
              signal,
            });
            if (result !== 'advanced') break;
            // Load durable stage after the domain transaction, never infer reply completion from application.
            const stored = await pool.query<{ stage: ProcessingClaim['stage'] }>(
              'select stage from runtime_processing_work where work_ref=$1 and lease_ref=$2',
              [claim.workRef, claim.leaseRef],
            );
            const stage = stored.rows[0]?.stage;
            if (stage === undefined) break;
            current = { ...claim, stage };
          }
        }
      } catch {
        options.logger.error('worker_batch_failed');
        throw new Error('reply_batch_failed');
      }
    },
  });
  let stop: Promise<void> | undefined;
  return Object.freeze({
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
  });
}
