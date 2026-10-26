import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import { z } from 'zod';
import { PostgresOperationsStore } from '../persistence/postgres-operations-store.js';
import {
  createEncryptedBackup,
  readBackupManifest,
  requireBackupDirectory,
  type BackupManifest,
  type BackupOptions,
} from './backup.js';

export function parseBackupCommand(args: readonly string[]) {
  try {
    if (args[0] === 'scheduled-backup') {
      const [, backupClass, scheduledAt] = z
        .tuple([
          z.literal('scheduled-backup'),
          z.enum(['daily', 'monthly']),
          z.iso.datetime({ precision: 3 }),
        ])
        .parse(args);
      return {
        job: 'backup' as const,
        backupClass,
        scheduledAt: new Date(scheduledAt),
        referenceOnly: true as const,
      };
    }
    if (args[0] === 'pre-migration-backup') {
      const [, scheduledAt] = z
        .tuple([z.literal('pre-migration-backup'), z.iso.datetime({ precision: 3 })])
        .parse(args);
      return {
        job: 'backup' as const,
        backupClass: 'pre_migration' as const,
        scheduledAt: new Date(scheduledAt),
        referenceOnly: true as const,
      };
    }
    if (args[0] === 'backup') {
      const [, backupClass, scheduledAt] = z
        .tuple([
          z.literal('backup'),
          z.enum(['daily', 'monthly', 'pre_migration']),
          z.iso.datetime({ precision: 3 }),
        ])
        .parse(args);
      return { job: 'backup' as const, backupClass, scheduledAt: new Date(scheduledAt) };
    }
    if (args[0] === 'verify-backup') {
      const [, backupRef] = z
        .tuple([z.literal('verify-backup'), z.string().regex(/^backup_[a-f0-9]{32}$/u)])
        .parse(args);
      return { job: 'verify-backup' as const, backupRef };
    }
    const [, scheduledAt] = z
      .tuple([z.literal('prune-backups'), z.iso.datetime({ precision: 3 })])
      .parse(args);
    return { job: 'prune-backups' as const, scheduledAt: new Date(scheduledAt) };
  } catch {
    throw new Error('operations_command_invalid');
  }
}

export async function registerBackup(
  pool: pg.Pool,
  manifest: BackupManifest,
  state: 'created' | 'verified',
): Promise<void> {
  const { signature: _signature, ...material } = manifest;
  void _signature;
  const store = new PostgresOperationsStore(pool);
  const prior = await pool.query<{ state: string }>(
    'select state from operations_backups where backup_ref=$1',
    [manifest.backupRef],
  );
  if (prior.rows.length === 0)
    await store.recordBackup({
      ...material,
      createdAt: new Date(material.createdAt),
      state: 'created',
    });
  const current = prior.rows[0]?.state;
  if (current !== undefined && !['created', 'verified', 'restore_verified'].includes(current))
    throw new Error('backup_catalog_invalid');
  if (current === 'restore_verified' || current === 'verified') {
    await store.recordBackup({
      ...material,
      createdAt: new Date(material.createdAt),
      state: current,
    });
    return;
  }
  if (state === 'verified')
    await store.recordBackup({ ...material, createdAt: new Date(material.createdAt), state });
}
export async function hasBackupCatalog(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ available: boolean }>(
    "select to_regclass('operations_backups') is not null as available",
  );
  return result.rows[0]?.available === true;
}
export async function listCatalogManifests(
  pool: Pick<pg.Pool, 'query'>,
  archiveDirectory: string,
  keyFile: string,
): Promise<readonly BackupManifest[]> {
  const rows = await pool.query<{
    backup_ref: string;
    state: BackupManifest['state'];
    class: BackupManifest['class'];
    created_at: Date;
    git_revision: string;
    schema_revision: string;
    ciphertext_bytes: string;
    ciphertext_sha256: string;
  }>(
    "select backup_ref,state,class,created_at,git_revision,schema_revision,ciphertext_bytes,ciphertext_sha256 from operations_backups where state <> 'pruned'",
  );
  const manifests: BackupManifest[] = [];
  for (const row of rows.rows) {
    const manifest = await readBackupManifest(archiveDirectory, row.backup_ref, keyFile);
    if (
      manifest.class !== row.class ||
      manifest.createdAt !== row.created_at.toISOString() ||
      manifest.gitRevision !== row.git_revision ||
      manifest.schemaRevision !== row.schema_revision ||
      manifest.ciphertextBytes !== Number(row.ciphertext_bytes) ||
      manifest.ciphertextSha256 !== row.ciphertext_sha256
    )
      throw new Error('backup_catalog_invalid');
    manifests.push({ ...manifest, state: row.state });
  }
  return manifests;
}

export async function runScheduledBackup(
  pool: pg.Pool,
  options: BackupOptions,
): Promise<{
  status: 'created' | 'skipped';
  manifest?: BackupManifest;
}> {
  const client = await pool.connect();
  try {
    // A session lock spans pg_dump without keeping an idle database transaction.
    await client.query(
      "select pg_advisory_lock(hashtextextended('fcd-support:backup-schedule',0))",
    );
    if (options.backupClass === 'pre_migration') throw new Error('backup_schedule_invalid');
    const start = new Date(options.now);
    start.setUTCHours(0, 0, 0, 0);
    if (options.backupClass === 'monthly') start.setUTCDate(1);
    const end = new Date(start);
    if (options.backupClass === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1);
    else end.setUTCDate(end.getUTCDate() + 1);
    const prior = await client.query<{ backup_ref: string; state: string }>(
      'select backup_ref,state from operations_backups where class=$1 and created_at >= $2 and created_at < $3',
      [options.backupClass, start, end],
    );
    if (prior.rows.length > 0) {
      const entry = prior.rows[0];
      if (
        prior.rows.length !== 1 ||
        entry === undefined ||
        !['created', 'verified', 'restore_verified'].includes(entry.state)
      )
        throw new Error('invalid');
      const catalog = await listCatalogManifests(
        client,
        options.archiveDirectory,
        options.manifestHmacFile,
      );
      const manifest = catalog.find((value) => value.backupRef === entry.backup_ref);
      if (manifest === undefined) throw new Error('invalid');
      return { status: 'skipped', manifest };
    }
    // Recover a signed commit made immediately before a crash/catalog failure.
    await requireBackupDirectory(options.archiveDirectory);
    let manifest: BackupManifest | undefined;
    for (const ref of await readdir(options.archiveDirectory)) {
      if (!/^backup_[a-f0-9]{32}$/u.test(ref)) throw new Error('backup_archive_invalid');
      const entry = await readBackupManifest(
        options.archiveDirectory,
        ref,
        options.manifestHmacFile,
      );
      const createdAt = new Date(entry.createdAt);
      if (entry.class === options.backupClass && createdAt >= start && createdAt < end) {
        if (manifest !== undefined || entry.state !== 'created')
          throw new Error('backup_archive_invalid');
        manifest = entry;
      }
    }
    manifest ??= await createEncryptedBackup(options);
    const { signature: _signature, ...material } = manifest;
    void _signature;
    await client.query('begin');
    try {
      await new PostgresOperationsStore({ transactionClient: client }).recordBackup({
        ...material,
        createdAt: new Date(material.createdAt),
        state: 'created',
      });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    return { status: 'created', manifest };
  } catch {
    throw new Error('backup_schedule_failed');
  } finally {
    // Destroy this dedicated connection; release of every session lock is certain
    // even when the SQL path failed or a rollback could not be confirmed.
    client.release(true);
  }
}
