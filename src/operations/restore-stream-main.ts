import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { isPostgresImageMetadata } from './postgres-image-metadata.js';
import {
  assertDatabaseIdentity,
  parseDatabaseIdentity,
  type DatabaseIdentity,
} from './database-identity.js';
import { operationApplicationName } from './operation-reference.js';
import { parseRestoreCommand, type RestoreCommand } from './restore-command.js';
import { connectionString, verifyPool } from './restore-main.js';
import { restoreEncryptedBackup } from './restore.js';
import { readSecretFile } from './secret-files.js';

export interface RestoreStreamCommandOptions {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
  readonly createPool?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly restore?: typeof restoreEncryptedBackup;
  readonly write: (line: string) => void | Promise<void>;
  readonly error: (line: string) => void;
}

export const restoreJobPath = z
  .string()
  .min(2)
  .max(4096)
  .regex(/^\/[A-Za-z0-9._/-]+$/u)
  .refine((value) => !value.endsWith('/') && posix.normalize(value) === value);

/** Shared validation contains no credentials or implied capabilities. Each leg
 * supplies its exact file and writable/archive-directory allowlist. */
export function restoreJobSettings(
  environment: RestoreStreamCommandOptions['environment'],
  command: RestoreCommand,
  fileNames: readonly string[],
  directories: readonly string[],
) {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === '') continue;
    if (
      ((/(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|KEYRING|HMAC|AGE_IDENTITY|AGE_RECIPIENT)(?:_|$)/u.test(
        name,
      ) ||
        name.endsWith('_FILE')) &&
        !fileNames.includes(name)) ||
      (/^PG[A-Z_0-9]+$/u.test(name) && !isPostgresImageMetadata(name, value)) ||
      ([
        'BACKUP_ARCHIVE_DIRECTORY',
        'BACKUP_TMPFS_DIRECTORY',
        'CHECKPOINT_ARCHIVE_DIRECTORY',
      ].includes(name) &&
        !directories.includes(name))
    )
      throw new Error('invalid');
  }
  if (
    environment.NODE_ENV !== 'production' ||
    ['MODEL_EXECUTION_ENABLED', 'OUTBOUND_EXECUTION_ENABLED', 'N8N_EXECUTION_ENABLED'].some(
      (name) => environment[name] !== 'false',
    ) ||
    environment.OPS_GIT_REVISION !== command.gitRevision ||
    environment.OPS_SCHEMA_REVISION !== command.schemaRevision ||
    environment.OPS_DATABASE_SCHEMA !== command.target.schema
  )
    throw new Error('invalid');
  const reference = z.string().parse(environment.OPS_OPERATION_REFERENCE);
  const applicationName = operationApplicationName(reference);
  const source = parseDatabaseIdentity({
    systemIdentifier: environment.OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER,
    databaseName: environment.OPS_SOURCE_DATABASE_NAME,
  });
  if (
    !/^fcd_support(?:_[a-z0-9_]+)?$/u.test(source.databaseName) ||
    source.databaseName !== command.target.databaseName ||
    source.systemIdentifier === command.target.systemIdentifier
  )
    throw new Error('invalid');
  const number = (name: string, maximum: number) =>
    z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(maximum))
      .parse(environment[name]);
  return {
    reference,
    applicationName,
    source,
    number,
    sourceAlias: z
      .literal('fcd-support-source-postgres')
      .parse(environment.RESTORE_SOURCE_SERVICE_ALIAS),
    targetAlias: z
      .literal('fcd-support-restore-postgres')
      .parse(environment.RESTORE_TARGET_SERVICE_ALIAS),
    rolePrefix: z
      .string()
      .regex(/^fcd_[a-z0-9_]{1,28}$/u)
      .parse(environment.OPS_DATABASE_ROLE_PREFIX),
    timeoutMilliseconds: number('OPS_MAX_CALL_MS', 300000),
    files: Object.fromEntries(
      fileNames.map((name) => [name, restoreJobPath.parse(environment[name])]),
    ),
  };
}

export function owningRestoreSessions(pool: pg.Pool, expected: DatabaseIdentity): pg.Pool {
  return new Proxy(pool, {
    get(original, key, receiver): unknown {
      if (key !== 'connect') return Reflect.get(original, key, receiver) as unknown;
      return async () => {
        const client = await original.connect();
        try {
          await assertDatabaseIdentity(client, expected);
          return client;
        } catch {
          client.release(true);
          throw new Error('invalid');
        }
      };
    },
  });
}

export function restoreJobPool(
  uri: string,
  command: RestoreCommand,
  config: ReturnType<typeof restoreJobSettings>,
  readOnly: boolean,
  create: NonNullable<RestoreStreamCommandOptions['createPool']>,
  failed: () => void,
): pg.Pool {
  const poolUri = new URL(uri);
  poolUri.searchParams.delete('options');
  const pool = create({
    connectionString: poolUri.toString(),
    ssl: false,
    max: 1,
    connectionTimeoutMillis: config.timeoutMilliseconds,
    query_timeout: config.timeoutMilliseconds,
    statement_timeout: config.timeoutMilliseconds,
    idle_in_transaction_session_timeout: config.timeoutMilliseconds,
    application_name: config.applicationName,
    options: `-c application_name=${config.applicationName} -c search_path=${command.target.schema},public${readOnly ? ' -c default_transaction_read_only=on' : ''}`,
  });
  pool.on('error', failed);
  pool.on('connect', (client) => {
    client.on('error', failed);
    client.once('end', () => {
      client.off('error', failed);
    });
  });
  return pool;
}

export async function closeRestoreJobPool(pool: pg.Pool, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('invalid'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const files = [
  'RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE',
  'RESTORE_TARGET_OWNER_DATABASE_URL_FILE',
  'RECOVERY_MANIFEST_HMAC_FILE',
  'BACKUP_AGE_IDENTITY_FILE',
] as const;

/** Archive metadata read + isolated stream only. No grant, migration,
 * checkpoint, runtime-role password or promotion capability is accepted. */
export async function runRestoreStreamCommand(
  options: RestoreStreamCommandOptions,
): Promise<0 | 1> {
  const pools: pg.Pool[] = [];
  const state = { failed: false };
  let milliseconds = 1000;
  try {
    const command = parseRestoreCommand(options.args);
    const config = restoreJobSettings(options.environment, command, files, [
      'BACKUP_ARCHIVE_DIRECTORY',
      'BACKUP_TMPFS_DIRECTORY',
    ]);
    milliseconds = config.timeoutMilliseconds;
    const archiveDirectory = restoreJobPath.parse(options.environment.BACKUP_ARCHIVE_DIRECTORY);
    const temporaryDirectory = restoreJobPath.parse(options.environment.BACKUP_TMPFS_DIRECTORY);
    if (
      temporaryDirectory === archiveDirectory ||
      temporaryDirectory.startsWith(`${archiveDirectory}/`) ||
      archiveDirectory.startsWith(`${temporaryDirectory}/`)
    )
      throw new Error('invalid');
    const read = options.readSecret ?? readSecretFile;
    const sourceRole = `${config.rolePrefix}_archive_reader`;
    const sourceUri = await connectionString(
      read,
      config.files.RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE ?? '',
      {
        databaseName: config.source.databaseName,
        role: sourceRole,
        alias: config.sourceAlias,
        reference: config.reference,
      },
    );
    const targetUri = await connectionString(
      read,
      config.files.RESTORE_TARGET_OWNER_DATABASE_URL_FILE ?? '',
      {
        databaseName: command.target.databaseName,
        role: 'postgres',
        alias: config.targetAlias,
        reference: config.reference,
      },
    );
    if (new URL(sourceUri).password === new URL(targetUri).password) throw new Error('invalid');
    const create =
      options.createPool ?? ((configuration: pg.PoolConfig) => new pg.Pool(configuration));
    const onFailure = () => {
      state.failed = true;
    };
    for (const [index, uri] of [sourceUri, targetUri].entries())
      pools.push(restoreJobPool(uri, command, config, index === 0, create, onFailure));
    const source = pools[0];
    const target = pools[1];
    if (!source || !target) throw new Error('invalid');
    const targetIdentity = parseDatabaseIdentity({
      systemIdentifier: command.target.systemIdentifier,
      databaseName: command.target.databaseName,
    });
    await verifyPool(source, config.source, sourceRole, true);
    await verifyPool(target, targetIdentity, 'postgres', false);
    if (state.failed) throw new Error('invalid');
    const outcome = await (options.restore ?? restoreEncryptedBackup)({
      sourcePool: owningRestoreSessions(source, config.source),
      expectedSourceDatabaseIdentity: config.source,
      targetConnectionString: targetUri,
      expectedTargetSystemIdentifier: command.target.systemIdentifier,
      schema: command.target.schema,
      backupRef: command.backupRef,
      archiveDirectory,
      temporaryDirectory,
      manifestHmacFile: config.files.RECOVERY_MANIFEST_HMAC_FILE ?? '',
      identityFile: config.files.BACKUP_AGE_IDENTITY_FILE ?? '',
      timeoutMilliseconds: config.timeoutMilliseconds,
    });
    z.literal('restored').parse(outcome.status);
    if (
      outcome.backupRef !== command.backupRef ||
      outcome.sourceSystemIdentifier !== config.source.systemIdentifier ||
      outcome.targetSystemIdentifier !== targetIdentity.systemIdentifier
    )
      throw new Error('invalid');
  } catch {
    state.failed = true;
  } finally {
    const closed = await Promise.allSettled(
      pools.map((pool) => closeRestoreJobPool(pool, milliseconds)),
    );
    if (closed.some((result) => result.status === 'rejected')) state.failed = true;
  }
  if (!state.failed) {
    try {
      await options.write('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
      return 0;
    } catch {
      // A failed stdout write follows the same generic failure path.
    }
  }
  options.error('restore_stream_command_failed\n');
  return 1;
}

export async function runRestoreStreamMain(): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 1000 ||
    process.getegid?.() !== 1000
  ) {
    process.stderr.write('restore_stream_command_failed\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runRestoreStreamCommand({
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
  await runRestoreStreamMain();
