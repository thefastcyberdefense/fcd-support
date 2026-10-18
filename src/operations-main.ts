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
import {
  createEncryptedBackup,
  readBackupManifest,
  verifyEncryptedBackup,
} from './operations/backup.js';
import { pruneEncryptedBackups } from './operations/backup-retention.js';
import {
  hasBackupCatalog,
  listCatalogManifests,
  parseBackupCommand,
  registerBackup,
  runScheduledBackup,
} from './operations/backup-command.js';
import { PostgresOperationsStore } from './persistence/postgres-operations-store.js';
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
    const args = process.argv.slice(2);
    if (['backup', 'verify-backup', 'prune-backups'].includes(args[0] ?? '')) {
      const command = parseBackupCommand(args);
      const role = command.job === 'verify-backup' ? 'verify_backup' : 'backup';
      const environment = await loadRoleEnvironment(role, process.env);
      const config = loadOperationsConfig(role, environment);
      const pathSetting = (name: string) => z.string().min(1).parse(process.env[name]);
      const common = {
        archiveDirectory: pathSetting('BACKUP_ARCHIVE_DIRECTORY'),
        manifestHmacFile: pathSetting('RECOVERY_MANIFEST_HMAC_FILE'),
        timeoutMilliseconds: config.maximumCallMilliseconds,
      };
      pool = new pg.Pool({
        connectionString: environment.DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: config.maximumCallMilliseconds,
        query_timeout: config.maximumCallMilliseconds,
        statement_timeout: config.maximumCallMilliseconds,
      });
      pool.on('error', () => {
        logger.error('database_pool_error');
      });
      let processed = 0;
      let skipped = false;
      if ('scheduledAt' in command && command.scheduledAt > new Date())
        throw new Error('operations_command_invalid');
      if (command.job === 'backup') {
        const options = {
          ...common,
          connectionString: z.string().min(1).parse(environment.DATABASE_URL),
          recipientFile: pathSetting('BACKUP_ENCRYPTION_RECIPIENT_FILE'),
          temporaryDirectory: pathSetting('BACKUP_TMPFS_DIRECTORY'),
          gitRevision: z
            .string()
            .regex(/^[a-f0-9]{40}$/u)
            .parse(environment.OPS_GIT_REVISION),
          schemaRevision: z
            .string()
            .regex(/^[0-9]{6}$/u)
            .parse(environment.OPS_SCHEMA_REVISION),
          backupClass: command.backupClass,
          now: command.scheduledAt,
        };
        if (command.backupClass === 'pre_migration') {
          const manifest = await createEncryptedBackup(options);
          // A signed archive exists before the first operations table is installed.
          if (await hasBackupCatalog(pool)) await registerBackup(pool, manifest, 'created');
          processed = 1;
        } else {
          const result = await runScheduledBackup(pool, options);
          skipped = result.status === 'skipped';
          processed = skipped ? 0 : 1;
        }
      } else if (command.job === 'verify-backup') {
        const manifest = await readBackupManifest(
          common.archiveDirectory,
          command.backupRef,
          common.manifestHmacFile,
        );
        await verifyEncryptedBackup({
          ...common,
          identityFile: pathSetting('BACKUP_AGE_IDENTITY_FILE'),
          expectedManifest: manifest,
        });
        if (await hasBackupCatalog(pool)) await registerBackup(pool, manifest, 'verified');
        processed = 1;
      } else {
        const client = await pool.connect();
        try {
          await client.query(
            "select pg_advisory_lock(hashtextextended('fcd-support:backup-schedule',0))",
          );
          const manifests = await listCatalogManifests(
            pool,
            common.archiveDirectory,
            common.manifestHmacFile,
          );
          const refs = await pruneEncryptedBackups({
            ...common,
            manifests,
            policy: { daily: config.dailyRetention, monthly: config.monthlyRetention },
            evaluatedAt: command.scheduledAt,
          });
          for (const ref of refs) {
            const manifest = manifests.find((entry) => entry.backupRef === ref);
            if (manifest === undefined) throw new Error('backup_catalog_invalid');
            const { signature: _signature, ...material } = manifest;
            void _signature;
            await new PostgresOperationsStore(pool).recordBackup({
              ...material,
              createdAt: new Date(material.createdAt),
              state: 'pruned',
            });
          }
          processed = refs.length;
        } finally {
          client.release(true);
        }
      }
      process.stdout.write(
        `${JSON.stringify({ status: skipped ? 'skipped' : 'completed', processed, reasonCode: skipped ? 'not_due' : 'ok' })}\n`,
      );
      return;
    }
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
