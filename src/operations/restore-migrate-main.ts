import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { isPostgresImageMetadata } from './postgres-image-metadata.js';
import { parseDatabaseIdentity } from './database-identity.js';
import { runForwardMigrations } from './forward-migration.js';
import { operationApplicationName } from './operation-reference.js';
import { connectionString, verifyPool } from './restore-main.js';
import { readSecretFile } from './secret-files.js';

export interface RestoreMigrateCommandOptions {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
  readonly createPool?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly migrate?: typeof runForwardMigrations;
  readonly write: (line: string) => void | Promise<void>;
  readonly error: (line: string) => void;
}

function settings(options: RestoreMigrateCommandOptions) {
  const [, systemIdentifier] = z.tuple([z.literal('migrate'), z.string()]).parse(options.args);
  const environment = options.environment;
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === '') continue;
    if (
      ((/(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|KEYRING|HMAC|AGE_IDENTITY|AGE_RECIPIENT)(?:_|$)/u.test(
        name,
      ) ||
        name.endsWith('_FILE')) &&
        name !== 'DATABASE_URL_FILE') ||
      (/^(?:PG[A-Z_0-9]+|RESTORE_.*|BACKUP_.*|CHECKPOINT_.*|OPS_SOURCE_.*)$/u.test(name) &&
        !['BACKUP_DAILY_RETENTION', 'BACKUP_MONTHLY_RETENTION', 'BACKUP_CALENDAR'].includes(name) &&
        !isPostgresImageMetadata(name, value))
    )
      throw new Error('invalid');
  }
  if (
    environment.NODE_ENV !== 'production' ||
    ['MODEL_EXECUTION_ENABLED', 'OUTBOUND_EXECUTION_ENABLED', 'N8N_EXECUTION_ENABLED'].some(
      (name) => environment[name] !== 'false',
    )
  )
    throw new Error('invalid');
  const databaseName = z
    .string()
    .regex(/^fcd_support(?:_[a-z0-9_]+)?$/u)
    .parse(environment.OPS_DATABASE_NAME);
  const identity = parseDatabaseIdentity({ systemIdentifier, databaseName });
  const schema = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/u)
    .parse(environment.OPS_DATABASE_SCHEMA);
  const rolePrefix = z
    .string()
    .regex(/^fcd_[a-z0-9_]{1,28}$/u)
    .parse(environment.OPS_DATABASE_ROLE_PREFIX);
  const schemaRevision = z
    .string()
    .regex(/^[0-9]{6}$/u)
    .parse(environment.OPS_SCHEMA_REVISION);
  z.string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(environment.OPS_GIT_REVISION);
  const reference = z.string().parse(environment.OPS_OPERATION_REFERENCE);
  const applicationName = operationApplicationName(reference);
  const timeoutMilliseconds = z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(300000))
    .parse(environment.OPS_MAX_CALL_MS);
  const uriFile = z
    .string()
    .min(2)
    .max(4096)
    .regex(/^\/[A-Za-z0-9._/-]+$/u)
    .refine((value) => !value.endsWith('/') && posix.normalize(value) === value)
    .parse(environment.DATABASE_URL_FILE);
  return {
    identity,
    schema,
    role: `${rolePrefix}_migrator`,
    schemaRevision,
    reference,
    applicationName,
    timeoutMilliseconds,
    uriFile,
  };
}

async function closePool(pool: pg.Pool, timeoutMilliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('invalid'));
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Target-only migration. This process receives no source URL, archive mount,
 * owner credential, keyring or bootstrap password capability. */
export async function runRestoreMigrateCommand(
  options: RestoreMigrateCommandOptions,
): Promise<0 | 1> {
  let pool: pg.Pool | undefined;
  const state = { failed: false };
  let timeoutMilliseconds = 1000;
  try {
    const config = settings(options);
    timeoutMilliseconds = config.timeoutMilliseconds;
    const uri = new URL(
      await connectionString(options.readSecret ?? readSecretFile, config.uriFile, {
        databaseName: config.identity.databaseName,
        role: config.role,
        alias: 'fcd-support-restore-postgres',
        reference: config.reference,
      }),
    );
    uri.searchParams.delete('options');
    pool = (options.createPool ?? ((configuration: pg.PoolConfig) => new pg.Pool(configuration)))({
      connectionString: uri.toString(),
      ssl: false,
      max: 1,
      connectionTimeoutMillis: timeoutMilliseconds,
      query_timeout: timeoutMilliseconds,
      statement_timeout: timeoutMilliseconds,
      idle_in_transaction_session_timeout: timeoutMilliseconds,
      application_name: config.applicationName,
      options: `-c application_name=${config.applicationName} -c search_path=${config.schema},public`,
    });
    const onFailure = () => {
      state.failed = true;
    };
    pool.on('error', onFailure);
    pool.on('connect', (client) => {
      client.on('error', onFailure);
      client.once('end', () => {
        client.off('error', onFailure);
      });
    });
    await verifyPool(pool, config.identity, config.role, false);
    if (state.failed) throw new Error('invalid');
    // runForwardMigrations repeats physical identity and restricted-principal
    // checks on its own DDL-owning connection before any migration executes.
    const migrated = await (options.migrate ?? runForwardMigrations)(pool, {
      schema: config.schema,
      expectedSchemaRevision: config.schemaRevision,
      timeoutMilliseconds,
      expectedDatabaseIdentity: config.identity,
      expectedMigratorRole: config.role,
    });
    if (migrated.schemaRevision !== config.schemaRevision) throw new Error('invalid');
  } catch {
    state.failed = true;
  } finally {
    if (pool !== undefined) {
      try {
        await closePool(pool, timeoutMilliseconds);
      } catch {
        state.failed = true;
      }
    }
  }
  if (!state.failed) {
    try {
      await options.write('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
      return 0;
    } catch {
      /* Failed stdout follows the generic failure path. */
    }
  }
  options.error('restore_migrate_command_failed\n');
  return 1;
}

export async function runRestoreMigrateMain(): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 1000 ||
    process.getegid?.() !== 1000
  ) {
    process.stderr.write('restore_migrate_command_failed\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runRestoreMigrateCommand({
    args: process.argv.slice(2),
    environment: process.env,
    write: (line) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) => {
          if (error) reject(new Error('invalid'));
          else resolve();
        });
      }),
    error: (line) => {
      process.stderr.write(line);
    },
  });
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRestoreMigrateMain();
