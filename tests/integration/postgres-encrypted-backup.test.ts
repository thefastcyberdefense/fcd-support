import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { createEncryptedBackup, verifyEncryptedBackup } from '../../src/operations/backup.js';
import { PostgresOperationsStore } from '../../src/persistence/postgres-operations-store.js';
import { runScheduledBackup } from '../../src/operations/backup-command.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { createIsolatedTestDatabase, requireIsolatedTestDatabaseUrl } from './test-database.js';

async function recipient(identity: string): Promise<string> {
  const child = spawn('age-keygen', ['-y', identity], { stdio: ['ignore', 'pipe', 'ignore'] });
  let value = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text: string) => {
    value += text;
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('synthetic_key_generation_failed'));
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('synthetic_key_generation_failed'));
    });
  });
  if (!/^age1[0-9a-z]+\n$/u.test(value)) throw new Error('synthetic_recipient_invalid');
  return value;
}
async function generateIdentity(path: string) {
  const child = spawn('age-keygen', ['--output', path], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('synthetic_key_generation_failed'));
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('synthetic_key_generation_failed'));
    });
  });
  await chmod(path, 0o600);
}

test.skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')(
  'real custom-format PostgreSQL backup encrypts with public recipient only and separately verifies',
  async () => {
    const archiveRoot = process.env.BACKUP_TEST_ARCHIVE_ROOT;
    if (archiveRoot !== undefined && archiveRoot !== '/var/lib/fcd-support/backups')
      throw new Error('synthetic_archive_root_invalid');
    const base = requireIsolatedTestDatabaseUrl(process.env);
    const database = await createIsolatedTestDatabase('encrypted_backup');
    const root = await mkdtemp(join(tmpdir(), 'fcd-encrypted-backup-test-'));
    await chmod(root, 0o700);
    const archiveDirectory = join(archiveRoot ?? root, `archives_${basename(root)}`);
    const temporaryDirectory = join(root, 'work');
    const identityFile = join(root, 'identity');
    const wrongIdentityFile = join(root, 'wrong-identity');
    const recipientFile = join(root, 'recipient');
    const manifestHmacFile = join(root, 'hmac');
    try {
      await mkdir(archiveDirectory, { mode: 0o700 });
      await mkdir(temporaryDirectory, { mode: 0o700 });
      await generateIdentity(identityFile);
      await generateIdentity(wrongIdentityFile);
      await writeFile(recipientFile, await recipient(identityFile), { mode: 0o600 });
      await writeFile(manifestHmacFile, 'synthetic_backup_manifest_hmac_'.repeat(3), {
        mode: 0o600,
      });
      await database.pool.query('create table synthetic_backup_marker (value text not null)');
      await database.pool.query(
        "insert into synthetic_backup_marker values ('Synthetic encrypted backup fixture only')",
      );
      const options = {
        connectionString: base,
        schemas: [database.schema],
        archiveDirectory,
        temporaryDirectory,
        recipientFile,
        manifestHmacFile,
        gitRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        backupClass: 'pre_migration' as const,
        now: new Date('2030-01-01T00:00:00.000Z'),
        timeoutMilliseconds: 10000,
      };
      // The encryption invocation cannot access either identity even through an accidental path.
      await chmod(identityFile, 0o000);
      await chmod(wrongIdentityFile, 0o000);
      const manifest = await createEncryptedBackup(options);
      expect(manifest.state).toBe('created');
      const files = await readdir(join(archiveDirectory, manifest.backupRef));
      expect(files).toEqual(['archive.age', 'manifest.json']);
      const bytes = await readFile(join(archiveDirectory, manifest.backupRef, 'archive.age'));
      expect(bytes.subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
      expect(bytes.includes(Buffer.from('Synthetic encrypted backup fixture only'))).toBe(false);
      expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false);
      expect(
        (await stat(join(archiveDirectory, manifest.backupRef, 'archive.age'))).mode & 0o777,
      ).toBe(0o600);
      expect(await readdir(temporaryDirectory)).toEqual([]);
      await chmod(identityFile, 0o600);
      await chmod(wrongIdentityFile, 0o600);
      await expect(
        verifyEncryptedBackup({
          ...options,
          identityFile: wrongIdentityFile,
          expectedManifest: manifest,
        }),
      ).rejects.toThrow('backup_verification_failed');
      expect(
        await verifyEncryptedBackup({ ...options, identityFile, expectedManifest: manifest }),
      ).toEqual({ status: 'verified' });
      const store = new PostgresOperationsStore(database.pool);
      const { signature: _signature, ...catalog } = manifest;
      void _signature;
      await store.recordBackup({ ...catalog, createdAt: new Date(manifest.createdAt) });
      await store.recordBackup({
        ...catalog,
        createdAt: new Date(manifest.createdAt),
        state: 'verified',
      });
      const result = await database.pool.query<{ state: string }>(
        'select state from operations_backups',
      );
      expect(result.rows).toEqual([{ state: 'verified' }]);
      const body = await readFile(
        join(archiveDirectory, manifest.backupRef, 'manifest.json'),
        'utf8',
      );
      expect(body).not.toContain('Synthetic encrypted backup fixture only');
      expect(body).not.toContain('AGE-SECRET-KEY');
      const runs = await Promise.all([
        runScheduledBackup(database.pool, { ...options, backupClass: 'daily' }),
        runScheduledBackup(database.pool, { ...options, backupClass: 'daily' }),
      ]);
      expect(runs.map((run) => run.status).sort()).toEqual(['created', 'skipped']);
      const daily = await database.pool.query<{ count: string }>(
        "select count(*) from operations_backups where class='daily'",
      );
      expect(daily.rows[0]?.count).toBe('1');
      expect(
        (await runScheduledBackup(database.pool, { ...options, backupClass: 'daily' })).status,
      ).toBe('skipped');
      const databaseFile = join(root, 'database');
      await writeFile(databaseFile, base, { mode: 0o600 });
      const config = operationsEnvironment();
      const commonEnvironment = {
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        ...config,
        NODE_ENV: 'production',
        OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
          ...(JSON.parse(config.OPS_RESOURCE_LIMITS_JSON) as Record<string, unknown>),
          verify_backup: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 32 },
        }),
        DATABASE_URL_FILE: databaseFile,
        RECOVERY_MANIFEST_HMAC_FILE: manifestHmacFile,
        BACKUP_ARCHIVE_DIRECTORY: archiveDirectory,
        BACKUP_TMPFS_DIRECTORY: temporaryDirectory,
        OPS_GIT_REVISION: 'a'.repeat(40),
        OPS_SCHEMA_REVISION: '000016',
      };
      async function cli(args: readonly string[], env: NodeJS.ProcessEnv) {
        const child = spawn(process.execPath, ['/app/dist/operations-main.js', ...args], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (text: string) => {
          output += text;
          if (output.length > 4096) child.kill('SIGKILL');
        });
        child.stderr.resume();
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', () => {
            reject(new Error('synthetic_operations_spawn_failed'));
          });
          child.once('close', resolve);
        });
        expect(code).toBe(0);
        if (args[0] === 'pre-migration-backup') {
          expect(output.trim()).toMatch(/^backup_[a-f0-9]{32}$/u);
          return output.trim();
        }
        expect(JSON.parse(output)).toMatchObject({
          status: 'completed',
          processed: 1,
          reasonCode: 'ok',
        });
        return undefined;
      }
      // Bootstrap has no operations tables in the connection's public schema.
      await chmod(identityFile, 0o000);
      const before = await readdir(archiveDirectory);
      await cli(['backup', 'pre_migration', '2001-01-01T00:00:00.000Z'], {
        ...commonEnvironment,
        BACKUP_ENCRYPTION_RECIPIENT_FILE: recipientFile,
      });
      const newRefs = (await readdir(archiveDirectory)).filter((ref) => !before.includes(ref));
      expect(newRefs).toHaveLength(1);
      await chmod(identityFile, 0o600);
      const newRef = newRefs[0];
      if (newRef === undefined) throw new Error('synthetic_archive_missing');
      await cli(['verify-backup', newRef], {
        ...commonEnvironment,
        BACKUP_AGE_IDENTITY_FILE: identityFile,
      });
      await chmod(identityFile, 0o000);
      const returnedRef = await cli(['pre-migration-backup', '2001-01-02T00:00:00.000Z'], {
        ...commonEnvironment,
        BACKUP_ENCRYPTION_RECIPIENT_FILE: recipientFile,
      });
      expect(await readdir(archiveDirectory)).toContain(returnedRef);
      if (returnedRef === undefined) throw new Error('synthetic_archive_reference_missing');
      const bootstrapManifest = JSON.parse(
        await readFile(join(archiveDirectory, returnedRef, 'manifest.json'), 'utf8'),
      ) as { schemaRevision: string };
      expect(bootstrapManifest.schemaRevision).toBe('000000');
    } finally {
      await chmod(identityFile, 0o600).catch(() => undefined);
      await chmod(wrongIdentityFile, 0o600).catch(() => undefined);
      await rm(archiveDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await database.dispose();
    }
  },
);
