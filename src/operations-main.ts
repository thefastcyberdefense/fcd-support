import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';

import { createSafeLogger } from './logging.js';
import { maintenanceJobs, runMaintenance } from './operations/maintenance.js';
import { createMaintenancePool } from './operations/maintenance-pool.js';
import { loadOperationsConfig } from './operations/operations-config.js';
import { loadPrivacyKeyring } from './operations/privacy-keyring.js';
import { databaseReadinessPorts } from './operations/role-runtime.js';
import { checkRuntimeReadiness } from './operations/runtime-readiness.js';
import { loadRoleEnvironment, readSecretFile } from './operations/secret-files.js';
import { AdminSecretBytes } from './admin/admin-types.js';
import { exportDeletionCheckpoint } from './operations/deletion-checkpoint.js';
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
import { runForwardMigrations } from './operations/forward-migration.js';
import { assertMigrationPrincipal } from './operations/migration-principal.js';
import { assertDatabaseIdentity, parseDatabaseIdentity } from './operations/database-identity.js';

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
    if (
      [
        'migrate',
        'deployment-started',
        'deployment-succeeded',
        'deployment-failed',
        'verify-runtime',
      ].includes(args[0] ?? '')
    ) {
      const [job] = z
        .tuple([
          z.enum([
            'migrate',
            'deployment-started',
            'deployment-succeeded',
            'deployment-failed',
            'verify-runtime',
          ]),
        ])
        .parse(args);
      const environment = await loadRoleEnvironment('migrate', process.env);
      const config = loadOperationsConfig('migrate', environment);
      if (
        config.modelExecutionEnabled ||
        config.outboundExecutionEnabled ||
        config.n8nExecutionEnabled
      )
        throw new Error('invalid');
      const revision = z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .parse(environment.OPS_GIT_REVISION);
      const schemaRevision = z
        .string()
        .regex(/^[0-9]{6}$/u)
        .parse(environment.OPS_SCHEMA_REVISION);
      const schema = z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/u)
        .parse(environment.OPS_DATABASE_SCHEMA ?? 'public');
      const expectedDatabaseIdentity = {
        systemIdentifier: z
          .string()
          .regex(/^[1-9][0-9]{0,19}$/u)
          .refine((value) => BigInt(value) <= 18446744073709551615n)
          .parse(environment.OPS_DATABASE_SYSTEM_IDENTIFIER),
        databaseName: z
          .string()
          .max(63)
          .regex(/^fcd_support(?:_[a-z0-9_]+)?$/u)
          .parse(environment.OPS_DATABASE_NAME),
      };
      const databaseState = { failed: false };
      const rolePrefix = z
        .string()
        .regex(/^fcd_[a-z0-9_]{1,28}$/u)
        .parse(environment.OPS_DATABASE_ROLE_PREFIX);
      const expectedMigratorRole = `${rolePrefix}_migrator`;
      pool = new pg.Pool({
        connectionString: environment.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: config.maximumCallMilliseconds,
        query_timeout: config.maximumCallMilliseconds,
        statement_timeout: config.maximumCallMilliseconds,
      });
      pool.on('error', () => {
        databaseState.failed = true;
        logger.error('database_pool_error');
      });
      if (job === 'migrate')
        await runForwardMigrations(pool, {
          schema,
          expectedSchemaRevision: schemaRevision,
          timeoutMilliseconds: config.maximumCallMilliseconds,
          expectedDatabaseIdentity,
          expectedMigratorRole,
        });
      else {
        const client = await pool.connect();
        const connectionError = () => {
          databaseState.failed = true;
        };
        client.on('error', connectionError);
        client.once('end', () => {
          client.off('error', connectionError);
        });
        try {
          await client.query('begin');
          await client.query(
            "select pg_catalog.set_config('lock_timeout',$1,true),pg_catalog.set_config('statement_timeout',$1,true),pg_catalog.set_config('transaction_timeout',$1,true)",
            [`${String(config.maximumCallMilliseconds)}ms`],
          );
          const identity = (
            await client.query<{ id: string; name: string }>(
              'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
            )
          ).rows[0];
          if (
            identity?.id !== expectedDatabaseIdentity.systemIdentifier ||
            identity.name !== expectedDatabaseIdentity.databaseName
          )
            throw new Error('invalid');
          await assertMigrationPrincipal(client, {
            schema,
            databaseName: expectedDatabaseIdentity.databaseName,
            roleName: expectedMigratorRole,
          });
          await client.query("select pg_catalog.set_config('search_path',$1,true)", [
            `pg_catalog,"${schema}",pg_temp`,
          ]);
          const lock = await client.query<{ acquired: boolean }>(
            'select pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1,0)) as acquired',
            [`fcd-support:deployment:${schema}`],
          );
          if (lock.rows[0]?.acquired !== true) throw new Error('invalid');
          const actual = await client.query<{ name: string }>(
            `select name from "${schema}".pgmigrations order by name desc limit 1`,
          );
          if (actual.rows[0]?.name.slice(0, 6) !== schemaRevision) throw new Error('invalid');
          if (job === 'verify-runtime') {
            const latest = await client.query<{ git_revision: string; status: string }>(
              `select git_revision,status from "${schema}".operations_deployments order by recorded_at desc,id desc limit 1`,
            );
            const row = latest.rows[0];
            if (row?.git_revision !== revision || !['started', 'succeeded'].includes(row.status))
              throw new Error('invalid');
          } else
            await new PostgresOperationsStore({ transactionClient: client }).recordDeployment({
              gitRevision: revision,
              schemaRevision,
              recordedAt: new Date(),
              status:
                job === 'deployment-started'
                  ? 'started'
                  : job === 'deployment-succeeded'
                    ? 'succeeded'
                    : 'failed',
            });
          await client.query('commit');
        } catch {
          try {
            await client.query('rollback');
          } catch {
            /* One-shot connection closes below. */
          }
          throw new Error('invalid');
        } finally {
          client.release(true);
        }
      }
      const completedPool = pool;
      pool = undefined;
      await completedPool.end();
      if (databaseState.failed) throw new Error('invalid');
      process.stdout.write(
        `${JSON.stringify({ status: 'completed', processed: 1, reasonCode: 'ok' })}\n`,
      );
      return;
    }
    if (args[0] === 'checkpoint') {
      z.tuple([z.literal('checkpoint')]).parse(args);
      const environment = await loadRoleEnvironment('checkpoint', process.env);
      const config = loadOperationsConfig('checkpoint', environment);
      const expectedDatabaseIdentity = parseDatabaseIdentity({
        systemIdentifier: environment.OPS_DATABASE_SYSTEM_IDENTIFIER,
        databaseName: environment.OPS_DATABASE_NAME,
      });
      const sourceState = { failed: false };
      const file = (name: string) => z.string().min(1).parse(process.env[name]);
      const number = (name: string) =>
        z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .transform(Number)
          .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
          .parse(environment[name]);
      pool = new pg.Pool({
        connectionString: environment.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: config.maximumCallMilliseconds,
        query_timeout: config.maximumCallMilliseconds,
        statement_timeout: config.maximumCallMilliseconds,
      });
      pool.on('error', () => {
        sourceState.failed = true;
        logger.error('database_pool_error');
      });
      const bytes = await readSecretFile(file('RECOVERY_MANIFEST_HMAC_FILE'));
      let signingKey: AdminSecretBytes;
      try {
        signingKey = new AdminSecretBytes(Buffer.from(bytes));
      } finally {
        bytes.fill(0);
      }
      const manifest = await exportDeletionCheckpoint({
        expectedDatabaseIdentity,
        sourcePool: pool,
        recipientFile: file('BACKUP_ENCRYPTION_RECIPIENT_FILE'),
        signingKey,
        archiveDirectory: z.string().min(1).parse(environment.CHECKPOINT_ARCHIVE_DIRECTORY),
        sourceRevision: z
          .string()
          .regex(/^[a-f0-9]{40}$/u)
          .parse(environment.OPS_GIT_REVISION),
        schemaRevision: z
          .string()
          .regex(/^[0-9]{6}$/u)
          .parse(environment.OPS_SCHEMA_REVISION),
        now: new Date(),
        timeoutMilliseconds: config.maximumCallMilliseconds,
        maximumRows: number('CHECKPOINT_MAX_ROWS'),
        maximumPayloadBytes: number('CHECKPOINT_MAX_PAYLOAD_BYTES'),
      });
      const completedPool = pool;
      pool = undefined;
      await completedPool.end();
      if (sourceState.failed) throw new Error('invalid');
      process.stdout.write(
        `${JSON.stringify({ status: 'completed', processed: manifest.rowCount, reasonCode: 'ok' })}\n`,
      );
      return;
    }
    if (
      [
        'backup',
        'scheduled-backup',
        'pre-migration-backup',
        'verify-backup',
        'prune-backups',
      ].includes(args[0] ?? '')
    ) {
      const command = parseBackupCommand(args);
      const role = command.job === 'verify-backup' ? 'verify_backup' : 'backup';
      const environment = await loadRoleEnvironment(role, process.env);
      const config = loadOperationsConfig(role, environment);
      const expectedDatabaseIdentity = parseDatabaseIdentity({
        systemIdentifier: environment.OPS_DATABASE_SYSTEM_IDENTIFIER,
        databaseName: environment.OPS_DATABASE_NAME,
      });
      const sourceState = { failed: false };
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
        sourceState.failed = true;
        logger.error('database_pool_error');
      });
      const targetClient = await pool.connect();
      targetClient.on('error', () => {
        sourceState.failed = true;
      });
      try {
        await assertDatabaseIdentity(targetClient, expectedDatabaseIdentity);
      } finally {
        targetClient.release(true);
      }
      let processed = 0;
      let skipped = false;
      let createdReference: string | undefined;
      if ('scheduledAt' in command && command.scheduledAt > new Date())
        throw new Error('operations_command_invalid');
      if (command.job === 'backup') {
        let sourceSchemaRevision = z
          .string()
          .regex(/^[0-9]{6}$/u)
          .parse(environment.OPS_SCHEMA_REVISION);
        if (command.backupClass === 'pre_migration') {
          const registry = await pool.query<{ present: boolean }>(
            "select to_regclass('pgmigrations') is not null as present",
          );
          sourceSchemaRevision = '000000';
          if (registry.rows[0]?.present === true) {
            const current = await pool.query<{ name: string }>(
              'select name from pgmigrations order by name desc limit 1',
            );
            const name = current.rows[0]?.name;
            if (name !== undefined) {
              if (!/^[0-9]{6}_[a-z0-9_]+$/u.test(name)) throw new Error('invalid');
              sourceSchemaRevision = name.slice(0, 6);
            }
          }
        }
        const options = {
          expectedDatabaseIdentity,
          ...common,
          connectionString: z.string().min(1).parse(environment.DATABASE_URL),
          recipientFile: pathSetting('BACKUP_ENCRYPTION_RECIPIENT_FILE'),
          temporaryDirectory: pathSetting('BACKUP_TMPFS_DIRECTORY'),
          gitRevision: z
            .string()
            .regex(/^[a-f0-9]{40}$/u)
            .parse(environment.OPS_GIT_REVISION),
          schemaRevision: sourceSchemaRevision,
          backupClass: command.backupClass,
          now: command.scheduledAt,
        };
        if (command.backupClass === 'pre_migration') {
          const manifest = await createEncryptedBackup(options);
          createdReference = manifest.backupRef;
          // A signed archive exists before the first operations table is installed.
          if (await hasBackupCatalog(pool)) await registerBackup(pool, manifest, 'created');
          processed = 1;
        } else {
          const result = await runScheduledBackup(pool, options);
          createdReference = result.manifest?.backupRef;
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
      const completedPool = pool;
      pool = undefined;
      await completedPool.end();
      if (sourceState.failed) throw new Error('invalid');
      if ('referenceOnly' in command) {
        if (createdReference === undefined) throw new Error('invalid');
        process.stdout.write(`${createdReference}\n`);
        return;
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
    const databaseState = { failed: false };
    pool = createMaintenancePool({
      connectionString: z.string().min(1).parse(environment.DATABASE_URL),
      expectedDatabaseIdentity: parseDatabaseIdentity({
        systemIdentifier: environment.OPS_DATABASE_SYSTEM_IDENTIFIER,
        databaseName: environment.OPS_DATABASE_NAME,
      }),
      schema: z.string().parse(environment.OPS_DATABASE_SCHEMA),
      rolePrefix: z.string().parse(environment.OPS_DATABASE_ROLE_PREFIX),
      operationReference: z.string().parse(environment.OPS_OPERATION_REFERENCE),
      max: config.batchSize,
      timeoutMilliseconds: config.maximumCallMilliseconds,
    });
    pool.on('error', () => {
      databaseState.failed = true;
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
    const completedPool = pool;
    pool = undefined;
    await completedPool.end();
    if (databaseState.failed) throw new Error('operations_job_failed');
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
