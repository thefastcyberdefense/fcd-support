import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { z } from 'zod';
import {
  archiveDatabaseConnection,
  readBackupManifest,
  requireBackupDirectory,
  runArchivePipeline,
  verifyEncryptedBackup,
  writeArchiveExclusive,
  type BackupManifest,
  type BackupProcessPort,
} from './backup.js';

/** Internal SQL/stream leg only. The host controller must independently prove
 * fresh volume/network isolation before invoking this primitive. It neither
 * attaches applications nor produces deletion/promotion readiness evidence. */
export interface EncryptedRestoreOptions {
  readonly sourcePool: pg.Pool;
  readonly targetConnectionString: string;
  readonly expectedTargetSystemIdentifier: string;
  readonly schema: string;
  readonly backupRef: string;
  readonly archiveDirectory: string;
  readonly temporaryDirectory: string;
  readonly manifestHmacFile: string;
  readonly identityFile: string;
  readonly timeoutMilliseconds: number;
  readonly processes?: BackupProcessPort;
}
export interface EncryptedRestoreEvidence {
  readonly status: 'restored';
  readonly backupRef: string;
  readonly schemaRevision: string;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
}

async function systemIdentifier(client: pg.PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select system_identifier::text as id from pg_catalog.pg_control_system()',
  );
  return z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .parse(result.rows[0]?.id);
}
async function cataloguedManifest(
  client: pg.PoolClient,
  options: EncryptedRestoreOptions,
): Promise<BackupManifest> {
  const manifest = await readBackupManifest(
    options.archiveDirectory,
    options.backupRef,
    options.manifestHmacFile,
  );
  const result = await client.query<{
    state: string;
    class: string;
    created_at: Date;
    git_revision: string;
    schema_revision: string;
    ciphertext_bytes: string;
    ciphertext_sha256: string;
  }>(
    'select state,class,created_at,git_revision,schema_revision,ciphertext_bytes,ciphertext_sha256 from operations_backups where backup_ref=$1',
    [options.backupRef],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    result.rows.length !== 1 ||
    !['verified', 'restore_verified'].includes(row.state) ||
    manifest.state !== 'created' ||
    manifest.class !== row.class ||
    manifest.createdAt !== row.created_at.toISOString() ||
    manifest.gitRevision !== row.git_revision ||
    manifest.schemaRevision !== row.schema_revision ||
    manifest.ciphertextBytes !== Number(row.ciphertext_bytes) ||
    manifest.ciphertextSha256 !== row.ciphertext_sha256
  )
    throw new Error('invalid');
  return manifest;
}

async function requireEmptyDatabase(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ empty: boolean }>(`
    select
      not exists(select 1 from pg_catalog.pg_namespace
        where nspname !~ '^pg_' and nspname not in ('public','information_schema'))
      and not exists(select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
      and not exists(select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
      and not exists(select 1 from pg_catalog.pg_type t
        join pg_catalog.pg_namespace n on n.oid=t.typnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
      and not exists(select 1 from pg_catalog.pg_extension where extname <> 'plpgsql')
      and not exists(select 1 from pg_catalog.pg_largeobject_metadata)
      and not exists(select 1 from pg_catalog.pg_stat_activity
        where datname=current_database() and pid <> pg_backend_pid()) as empty`);
  if (result.rows[0]?.empty !== true) throw new Error('invalid');
}

async function closeRestoreAttempt(
  source: pg.PoolClient | undefined,
  target: pg.PoolClient | undefined,
  pool: pg.Pool | undefined,
  workDirectory: string | undefined,
) {
  let failed = false;
  for (const client of [source, target]) {
    try {
      client?.release(true);
    } catch {
      failed = true;
    }
  }
  try {
    await pool?.end();
  } catch {
    failed = true;
  }
  if (workDirectory !== undefined) {
    try {
      await rm(workDirectory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('restore_failed');
}

export async function restoreEncryptedBackup(
  options: EncryptedRestoreOptions,
): Promise<EncryptedRestoreEvidence> {
  let source: pg.PoolClient | undefined;
  let target: pg.PoolClient | undefined;
  let targetPool: pg.Pool | undefined;
  let workDirectory: string | undefined;
  let failure = 'restore_failed';
  try {
    z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
    z.string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(options.schema);
    z.string()
      .regex(/^[1-9][0-9]{0,19}$/u)
      .parse(options.expectedTargetSystemIdentifier);
    const connection = archiveDatabaseConnection(options.targetConnectionString);
    const database = z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(connection.env.PGDATABASE);
    source = await options.sourcePool.connect();
    await source.query("select set_config('statement_timeout',$1,false)", [
      `${String(options.timeoutMilliseconds)}ms`,
    ]);
    failure = 'restore_archive_invalid';
    const manifest = await cataloguedManifest(source, options);
    failure = 'restore_target_invalid';
    const sourceSystemIdentifier = await systemIdentifier(source);
    targetPool = new pg.Pool({
      connectionString: options.targetConnectionString,
      ssl: false,
      max: 1,
      connectionTimeoutMillis: options.timeoutMilliseconds,
      statement_timeout: options.timeoutMilliseconds,
      application_name: 'fcd-support-restore-control',
    });
    target = await targetPool.connect();
    const targetSystemIdentifier = await systemIdentifier(target);
    if (
      targetSystemIdentifier === sourceSystemIdentifier ||
      targetSystemIdentifier !== options.expectedTargetSystemIdentifier
    )
      throw new Error('invalid');
    const locked = await target.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended('fcd-support:isolated-restore',0)) as acquired",
    );
    if (locked.rows[0]?.acquired !== true) throw new Error('invalid');
    await requireEmptyDatabase(target);
    failure = 'restore_failed';
    await verifyEncryptedBackup({ ...options, expectedManifest: manifest });
    await requireBackupDirectory(options.temporaryDirectory);
    if (
      options.temporaryDirectory === options.archiveDirectory ||
      options.temporaryDirectory.startsWith(options.archiveDirectory + '/') ||
      options.archiveDirectory.startsWith(options.temporaryDirectory + '/') ||
      (process.platform === 'linux' &&
        (await statfs(options.temporaryDirectory)).type !== 0x01021994)
    )
      throw new Error('invalid');
    const candidate = join(options.temporaryDirectory, `restore_pgpass_${randomUUID()}`);
    await mkdir(candidate, { mode: 0o700 });
    workDirectory = candidate;
    const passFile = join(workDirectory, 'pgpass');
    await writeArchiveExclusive(passFile, connection.pass);
    // Recheck after the independent decrypt/list pass and before any SQL restore.
    await requireEmptyDatabase(target);
    const flags: Partial<typeof constants> = constants;
    const handle = await open(
      join(options.archiveDirectory, options.backupRef, 'archive.age'),
      constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== manifest.ciphertextBytes) throw new Error('invalid');
      const hash = createHash('sha256');
      let bytes = 0;
      const ciphertext = Readable.from(
        (async function* () {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            const buffer = chunk as Buffer;
            bytes += buffer.length;
            hash.update(buffer);
            yield buffer;
          }
        })(),
      );
      await runArchivePipeline(
        [
          { file: 'age', args: ['--decrypt', '--identity', options.identityFile] },
          {
            file: 'pg_restore',
            args: [
              '--exit-on-error',
              '--single-transaction',
              '--no-owner',
              '--no-acl',
              '--dbname',
              database,
            ],
            env: {
              ...connection.env,
              PGPASSFILE: passFile,
              PGAPPNAME: 'fcd-support-isolated-restore',
              PGOPTIONS: `-c statement_timeout=${String(options.timeoutMilliseconds)} -c lock_timeout=${String(options.timeoutMilliseconds)}`,
            },
          },
        ],
        options,
        ciphertext,
      );
      const after = await handle.stat();
      if (
        bytes !== manifest.ciphertextBytes ||
        hash.digest('hex') !== manifest.ciphertextSha256 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new Error('invalid');
    } finally {
      await handle.close();
    }
    if (
      (await systemIdentifier(target)) !== targetSystemIdentifier ||
      (await systemIdentifier(source)) !== sourceSystemIdentifier
    )
      throw new Error('invalid');
    const installed = await target.query<{ present: boolean }>(
      'select to_regclass($1) is not null as present',
      [`${options.schema}.pgmigrations`],
    );
    let schemaRevision = '000000';
    if (installed.rows[0]?.present === true) {
      const latest = await target.query<{ name: string }>(
        `select name from "${options.schema}".pgmigrations order by name desc limit 1`,
      );
      if (latest.rows.length !== 0)
        schemaRevision = z
          .string()
          .regex(/^[0-9]{6}_[a-z0-9_]+$/u)
          .parse(latest.rows[0]?.name)
          .slice(0, 6);
    }
    if (schemaRevision !== manifest.schemaRevision) throw new Error('invalid');
    return {
      status: 'restored',
      backupRef: manifest.backupRef,
      schemaRevision,
      sourceSystemIdentifier,
      targetSystemIdentifier,
    };
  } catch {
    throw new Error(failure);
  } finally {
    // Never drop target objects/volumes on error: an ambiguous stream must stay isolated.
    await closeRestoreAttempt(source, target, targetPool, workDirectory);
  }
}
