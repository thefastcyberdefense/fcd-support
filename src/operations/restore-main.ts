import { lstat, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { AdminSecretBytes } from '../admin/admin-types.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../persistence/postgres-runtime-grants.js';
import {
  assertDatabaseIdentity,
  parseDatabaseIdentity,
  type DatabaseIdentity,
} from './database-identity.js';
import { readCheckpointWatermark, validateCheckpointManifest } from './deletion-checkpoint.js';
import { bindOperationConnectionString, operationApplicationName } from './operation-reference.js';
import { loadPrivacyKeyring } from './privacy-keyring.js';
import { parseRestoreCommand, type RestoreCommand } from './restore-command.js';
import { restoreAndReconcile } from './restore.js';
import { readSecretFile } from './secret-files.js';

const path = z
  .string()
  .min(2)
  .max(4096)
  .regex(/^\/[A-Za-z0-9._/-]+$/u)
  .refine((value) => !value.endsWith('/') && posix.normalize(value) === value);
const databaseName = z.string().regex(/^fcd_support(?:_[a-z0-9_]+)?$/u);
const fileNames = [
  'RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE',
  'RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE',
  'RESTORE_TARGET_OWNER_DATABASE_URL_FILE',
  'RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE',
  'PRIVACY_HMAC_KEYRING_FILE',
  'RECOVERY_MANIFEST_HMAC_FILE',
  'BACKUP_AGE_IDENTITY_FILE',
] as const;
const credential =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|KEYRING|HMAC|AGE_IDENTITY)(?:_|$)/u;

export interface RestoreCommandOptions {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
  readonly verifyPasswordDirectory?: (path: string) => Promise<void>;
  readonly createPool?: (options: pg.PoolConfig) => pg.Pool;
  readonly restore?: typeof restoreAndReconcile;
  readonly configureGrants?: typeof configureRuntimeGrants;
  readonly write: (line: string) => void;
  readonly error: (line: string) => void;
}

function settings(environment: RestoreCommandOptions['environment'], command: RestoreCommand) {
  const allowedFiles = new Set<string>(fileNames);
  allowedFiles.add('RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY');
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === '') continue;
    if ((credential.test(name) && !allowedFiles.has(name)) || /^PG[A-Z_0-9]+$/u.test(name))
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
    databaseName: databaseName.parse(environment.OPS_SOURCE_DATABASE_NAME),
  });
  if (
    source.systemIdentifier === command.target.systemIdentifier ||
    source.databaseName !== command.target.databaseName
  )
    throw new Error('invalid');
  databaseName.parse(command.target.databaseName);
  const sourceAlias = z
    .literal('fcd-support-source-postgres')
    .parse(environment.RESTORE_SOURCE_SERVICE_ALIAS);
  const targetAlias = z
    .literal('fcd-support-restore-postgres')
    .parse(environment.RESTORE_TARGET_SERVICE_ALIAS);
  const rolePrefix = z
    .string()
    .regex(/^fcd_[a-z0-9_]{1,28}$/u)
    .parse(environment.OPS_DATABASE_ROLE_PREFIX);
  const number = (name: string, maximum: number) =>
    z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(maximum))
      .parse(environment[name]);
  const secretFiles = Object.fromEntries(
    fileNames.map((name) => [name, path.parse(environment[name])]),
  ) as Record<(typeof fileNames)[number], string>;
  const passwordDirectory = path.parse(environment.RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY);
  const archiveDirectory = path.parse(environment.BACKUP_ARCHIVE_DIRECTORY);
  const checkpointDirectory = path.parse(environment.CHECKPOINT_ARCHIVE_DIRECTORY);
  const temporaryDirectory = path.parse(environment.BACKUP_TMPFS_DIRECTORY);
  if (
    [archiveDirectory, checkpointDirectory].some(
      (directory) =>
        temporaryDirectory === directory ||
        temporaryDirectory.startsWith(`${directory}/`) ||
        directory.startsWith(`${temporaryDirectory}/`),
    )
  )
    throw new Error('invalid');
  return {
    reference,
    applicationName,
    source,
    sourceAlias,
    targetAlias,
    rolePrefix,
    secretFiles,
    passwordDirectory,
    archiveDirectory,
    checkpointDirectory,
    temporaryDirectory,
    timeoutMilliseconds: number('OPS_MAX_CALL_MS', 300000),
    maximumCheckpointAgeMilliseconds: number('CHECKPOINT_MAX_AGE_MS', 31536000000),
    maximumCheckpointRows: number('CHECKPOINT_MAX_ROWS', 2147483647),
    maximumCheckpointPayloadBytes: number('CHECKPOINT_MAX_PAYLOAD_BYTES', Number.MAX_SAFE_INTEGER),
    batchLimit: number('RESTORE_BATCH_LIMIT', 1000),
    maximumBatches: number('RESTORE_MAX_BATCHES', 1000000),
  };
}

async function requirePasswordDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    ![0, 1000].includes(info.uid) ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(directory)) !== directory
  )
    throw new Error('invalid');
}

async function readBytes(
  read: NonNullable<RestoreCommandOptions['readSecret']>,
  file: string,
  minimum: number,
  maximum: number,
) {
  const bytes = await read(file);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < minimum || bytes.byteLength > maximum) {
    bytes.fill(0);
    throw new Error('invalid');
  }
  return bytes;
}

export async function connectionString(
  read: NonNullable<RestoreCommandOptions['readSecret']>,
  file: string,
  expected: {
    readonly databaseName: string;
    readonly role: string;
    readonly alias: string;
    readonly reference: string;
  },
) {
  const bytes = await readBytes(read, file, 1, 8192);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .replace(/\r?\n$/u, '');
    const uri = new URL(text);
    if (
      !['postgres:', 'postgresql:'].includes(uri.protocol) ||
      uri.hash !== '' ||
      uri.search !== '' ||
      !uri.hostname ||
      (uri.port !== '' && uri.port !== '5432') ||
      /[\r\n\0]/u.test(text) ||
      text.trim() !== text ||
      decodeURIComponent(uri.pathname) !== `/${expected.databaseName}` ||
      decodeURIComponent(uri.username) !== expected.role ||
      uri.password === '' ||
      /[\r\n\0]/u.test(decodeURIComponent(uri.password))
    )
      throw new Error('invalid');
    // Docker's generic `postgres` alias is ambiguous on a two-network job.
    // A protected host controller supplies the two closed, distinct aliases.
    uri.hostname = expected.alias;
    uri.port = '5432';
    return bindOperationConnectionString(uri.toString(), expected.reference);
  } finally {
    bytes.fill(0);
  }
}

export async function verifyPool(
  pool: pg.Pool,
  expected: DatabaseIdentity,
  role: string,
  readOnly: boolean,
) {
  const client = await pool.connect();
  try {
    await assertDatabaseIdentity(client, expected);
    const actual = (
      await client.query<{
        name: string;
        session: string;
        privileged: boolean;
        memberships: boolean;
        read_only: boolean;
      }>(`select current_user as name,session_user as session,
      (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls) as privileged,
      exists(select 1 from pg_catalog.pg_auth_members where member=r.oid) as memberships,
      current_setting('default_transaction_read_only')='on' as read_only
      from pg_catalog.pg_roles r where r.rolname=current_user`)
    ).rows[0];
    if (
      actual?.name !== role ||
      actual.session !== role ||
      (role !== 'postgres' && (actual.privileged || actual.memberships)) ||
      (readOnly && !actual.read_only)
    )
      throw new Error('invalid');
  } finally {
    client.release(true);
  }
}

async function boundedClose(pool: pg.Pool, milliseconds: number) {
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

/** Dedicated owner-capable restore job. The host retains its deployment lock
 * and independently proves target isolation before invoking this SQL driver. */
export async function runRestoreCommand(options: RestoreCommandOptions): Promise<0 | 1> {
  const pools: pg.Pool[] = [];
  const state = { failed: false };
  let timeoutMilliseconds = 1000;
  try {
    const command = parseRestoreCommand(options.args);
    const config = settings(options.environment, command);
    timeoutMilliseconds = config.timeoutMilliseconds;
    await (options.verifyPasswordDirectory ?? requirePasswordDirectory)(config.passwordDirectory);
    const read = options.readSecret ?? readSecretFile;
    const roles = [
      `${config.rolePrefix}_checkpoint`,
      `${config.rolePrefix}_backup`,
      'postgres',
      `${config.rolePrefix}_migrator`,
    ];
    const uriFiles = fileNames.slice(0, 4);
    const uris: string[] = [];
    for (const [index, fileName] of uriFiles.entries()) {
      const role = roles[index];
      if (role === undefined) throw new Error('invalid');
      uris.push(
        await connectionString(read, config.secretFiles[fileName], {
          databaseName: command.target.databaseName,
          role,
          alias: index < 2 ? config.sourceAlias : config.targetAlias,
          reference: config.reference,
        }),
      );
    }
    const keyringBytes = await readBytes(
      read,
      config.secretFiles.PRIVACY_HMAC_KEYRING_FILE,
      1,
      65536,
    );
    let keyring;
    try {
      keyring = loadPrivacyKeyring(keyringBytes);
    } finally {
      keyringBytes.fill(0);
    }
    const signingBytes = await readBytes(
      read,
      config.secretFiles.RECOVERY_MANIFEST_HMAC_FILE,
      32,
      4096,
    );
    let checkpointSigningKey: AdminSecretBytes;
    try {
      checkpointSigningKey = new AdminSecretBytes(Buffer.from(signingBytes));
    } finally {
      signingBytes.fill(0);
    }
    const makePool = options.createPool ?? ((input: pg.PoolConfig) => new pg.Pool(input));
    for (const [index, uri] of uris.entries()) {
      const poolUri = new URL(uri);
      poolUri.searchParams.delete('options');
      const pool = makePool({
        connectionString: poolUri.toString(),
        ssl: false,
        max: 1,
        connectionTimeoutMillis: config.timeoutMilliseconds,
        query_timeout: config.timeoutMilliseconds,
        statement_timeout: config.timeoutMilliseconds,
        idle_in_transaction_session_timeout: config.timeoutMilliseconds,
        application_name: config.applicationName,
        options: `-c application_name=${config.applicationName} -c search_path=${command.target.schema},public${index < 2 ? ' -c default_transaction_read_only=on' : ''}`,
      });
      pools.push(pool);
      const onError = () => {
        state.failed = true;
      };
      pool.on('error', onError);
      pool.on('connect', (client) => {
        client.on('error', onError);
        client.once('end', () => {
          client.off('error', onError);
        });
      });
    }
    const [sourcePool, archiveSourcePool, targetPool, migratorPool] = pools;
    const targetConnectionString = uris[2];
    const migratorRole = roles[3];
    if (
      !sourcePool ||
      !archiveSourcePool ||
      !targetPool ||
      !migratorPool ||
      !targetConnectionString ||
      !migratorRole
    )
      throw new Error('invalid');
    const targetIdentity = parseDatabaseIdentity({
      systemIdentifier: command.target.systemIdentifier,
      databaseName: command.target.databaseName,
    });
    await verifyPool(sourcePool, config.source, roles[0] ?? '', true);
    await verifyPool(archiveSourcePool, config.source, roles[1] ?? '', true);
    await verifyPool(targetPool, targetIdentity, 'postgres', false);
    const checkpointBytes = await readBytes(
      read,
      posix.join(config.checkpointDirectory, command.checkpointRef, 'manifest.json'),
      1,
      65536,
    );
    let checkpoint;
    const clock = options.now ?? (() => new Date());
    try {
      checkpoint = validateCheckpointManifest(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkpointBytes)),
        {
          signingKey: checkpointSigningKey,
          expectedWatermark: await readCheckpointWatermark(sourcePool),
          evaluatedAt: clock(),
          maximumAgeMilliseconds: config.maximumCheckpointAgeMilliseconds,
        },
      );
      if (checkpoint.checkpointRef !== command.checkpointRef) throw new Error('invalid');
    } finally {
      checkpointBytes.fill(0);
    }
    if (state.failed) throw new Error('invalid');
    const passwordFiles = Object.fromEntries(
      [...runtimeDatabaseRoles, 'migrator'].map((role) => [
        role,
        posix.join(config.passwordDirectory, `bootstrap-${role.replaceAll('_', '-')}-password`),
      ]),
    );
    const configure = options.configureGrants ?? configureRuntimeGrants;
    // Grant preparation acquires its own owner session. Bind that acquisition,
    // rather than relying on a prior sample from a different physical session.
    const grantPool = new Proxy(targetPool, {
      get(pool, key, receiver): unknown {
        if (key !== 'connect') return Reflect.get(pool, key, receiver) as unknown;
        return async () => {
          const owner = await pool.connect();
          try {
            await assertDatabaseIdentity(owner, targetIdentity);
            return owner;
          } catch {
            owner.release(true);
            throw new Error('invalid');
          }
        };
      },
    });
    const grant = async (phase: 'prepare' | 'converge') => {
      await verifyPool(targetPool, targetIdentity, 'postgres', false);
      await configure(grantPool, {
        schema: command.target.schema,
        database: command.target.databaseName,
        rolePrefix: config.rolePrefix,
        passwordFiles,
        phase,
        timeoutMilliseconds: config.timeoutMilliseconds,
      });
    };
    const evidence = await (options.restore ?? restoreAndReconcile)({
      sourcePool,
      archiveSourcePool,
      targetPool,
      expectedSourceDatabaseIdentity: config.source,
      targetConnectionString,
      expectedTargetSystemIdentifier: command.target.systemIdentifier,
      schema: command.target.schema,
      backupRef: command.backupRef,
      archiveDirectory: config.archiveDirectory,
      temporaryDirectory: config.temporaryDirectory,
      manifestHmacFile: config.secretFiles.RECOVERY_MANIFEST_HMAC_FILE,
      identityFile: config.secretFiles.BACKUP_AGE_IDENTITY_FILE,
      timeoutMilliseconds: config.timeoutMilliseconds,
      target: command.target,
      restoreRef: command.restoreRef,
      gitRevision: command.gitRevision,
      expectedSchemaRevision: command.schemaRevision,
      keyring,
      checkpoint,
      checkpointSigningKey,
      checkpointArchiveFile: posix.join(
        config.checkpointDirectory,
        command.checkpointRef,
        'archive.age',
      ),
      maximumCheckpointAgeMilliseconds: config.maximumCheckpointAgeMilliseconds,
      maximumCheckpointRows: config.maximumCheckpointRows,
      maximumCheckpointPayloadBytes: config.maximumCheckpointPayloadBytes,
      batchLimit: config.batchLimit,
      maximumBatches: config.maximumBatches,
      clock,
      migration: {
        pool: migratorPool,
        roleName: migratorRole,
        prepare: async () => {
          await grant('prepare');
          await verifyPool(migratorPool, targetIdentity, migratorRole, false);
        },
        converge: () => grant('converge'),
      },
    });
    z.literal('deletion_verified').parse(evidence.status);
    if (
      evidence.restoreRef !== command.restoreRef ||
      evidence.backupRef !== command.backupRef ||
      evidence.checkpointRef !== command.checkpointRef
    )
      throw new Error('invalid');
  } catch {
    state.failed = true;
  } finally {
    const closed = await Promise.allSettled(
      pools.map((pool) => boundedClose(pool, timeoutMilliseconds)),
    );
    if (closed.some((result) => result.status === 'rejected')) state.failed = true;
  }
  if (state.failed) {
    options.error('restore_command_failed\n');
    return 1;
  }
  options.write('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
  return 0;
}

export async function runRestoreMain(): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 1000 ||
    process.getegid?.() !== 1000
  ) {
    process.stderr.write('restore_command_failed\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runRestoreCommand({
    args: process.argv.slice(2),
    environment: process.env,
    write: (line) => {
      process.stdout.write(line);
    },
    error: (line) => {
      process.stderr.write(line);
    },
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRestoreMain();
