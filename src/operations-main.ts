import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';

import { createSafeLogger } from './logging.js';
import { maintenanceJobs, runMaintenance } from './operations/maintenance.js';
import { loadOperationsConfig } from './operations/operations-config.js';
import { loadPrivacyKeyring } from './operations/privacy-keyring.js';
import { databaseReadinessPorts } from './operations/role-runtime.js';
import { checkRuntimeReadiness } from './operations/runtime-readiness.js';
import { loadRoleEnvironment } from './operations/secret-files.js';
import { parseLearningPolicy } from './learning/learning-input.js';
import { parseOutboundPolicyInput } from './outbound/outbound-policy-input.js';

export function parseOperationsCommand(args: readonly string[]) {
  try {
    const [job, runRef, scheduledAt] = z
      .tuple([
        z.enum(maintenanceJobs),
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
        z.iso.datetime(),
      ])
      .parse(args);
    return Object.freeze({ job, runRef, scheduledAt: new Date(scheduledAt) });
  } catch {
    throw new Error('operations_command_invalid');
  }
}

export async function runOperationsMain(): Promise<void> {
  const logger = createSafeLogger();
  let pool: pg.Pool | undefined;
  try {
    const command = parseOperationsCommand(process.argv.slice(2));
    const environment = await loadRoleEnvironment('maintenance', process.env);
    const config = loadOperationsConfig('maintenance', environment);
    const keyring = loadPrivacyKeyring(new TextEncoder().encode(environment.PRIVACY_HMAC_KEYRING));
    const learningPolicy = parseLearningPolicy(
      JSON.parse(z.string().max(4096).parse(environment.OPS_LEARNING_POLICY_JSON)),
    );
    const outboundBounds = parseOutboundPolicyInput(
      JSON.parse(z.string().max(4096).parse(environment.REPLY_OUTBOUND_BOUNDS_JSON)),
    );
    const learningWindowMilliseconds = z.coerce
      .number()
      .int()
      .min(1)
      .max(31536000000)
      .parse(environment.OPS_LEARNING_WINDOW_MS);
    const revision = z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .parse(environment.OPS_GIT_REVISION);
    const expectedSchemaRevision = z
      .string()
      .regex(/^\d{6}$/u)
      .parse(environment.OPS_SCHEMA_REVISION);
    pool = new pg.Pool({
      connectionString: environment.DATABASE_URL,
      max: config.batchSize,
      connectionTimeoutMillis: config.maximumCallMilliseconds,
      query_timeout: config.maximumCallMilliseconds,
      statement_timeout: config.maximumCallMilliseconds,
      idle_in_transaction_session_timeout: config.maximumCallMilliseconds,
    });
    pool.on('error', () => {
      logger.error('database_pool_error');
    });
    const ready = await checkRuntimeReadiness(
      {
        role: 'maintenance',
        revision,
        expectedSchemaRevision,
        externalExecutionEnabled: false,
        timeoutMilliseconds: config.maximumCallMilliseconds,
      },
      databaseReadinessPorts(
        pool,
        () => new Date(),
        () => Promise.resolve(true),
      ),
    );
    if (ready.state !== 'healthy') throw new Error('operations_readiness_failed');
    const result = await runMaintenance(command.job, {
      pool,
      keyring,
      learningPolicy,
      outboundBounds,
      now: () => new Date(),
      limit: Math.min(config.batchSize, 100),
      ...command,
      learningWindowMilliseconds,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch {
    logger.error('operations_job_failed');
    process.exitCode = 1;
  } finally {
    try {
      await pool?.end();
    } catch {
      logger.error('operations_job_failed');
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperationsMain();
