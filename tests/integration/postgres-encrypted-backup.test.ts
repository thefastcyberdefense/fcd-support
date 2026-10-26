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
import { withVerifiedDatabaseSnapshot } from '../../src/operations/database-identity.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  bindOperationConnectionString,
  operationApplicationName,
} from '../../src/operations/operation-reference.js';

async function waitForOperationBackends(pool: pg.Pool, reference: string, expected: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from pg_catalog.pg_stat_activity where datname=current_database() and application_name=$1',
      [operationApplicationName(reference)],
    );
    if (result.rows[0]?.count === String(expected)) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('synthetic_operation_backend_count_mismatch');
}

test.skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')(
  'operation connection startup preserves namespace while overriding name options and disappears after close',
  async () => {
    const database = await createIsolatedTestDatabase('operation_reference');
    const reference = `operation_${randomUUID().replaceAll('-', '')}`;
    const original = new URL(database.connectionString);
    original.searchParams.set('application_name', 'synthetic_uri_spoof');
    original.searchParams.set(
      'options',
      `${original.searchParams.get('options') ?? ''} -c application_name=synthetic_option_spoof`,
    );
    const pool = new pg.Pool({
      connectionString: bindOperationConnectionString(original.toString(), reference),
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    try {
      const result = await pool.query<{ name: string; schema: string }>(
        "select current_setting('application_name') as name,current_schema() as schema",
      );
      expect(result.rows).toEqual([
        { name: operationApplicationName(reference), schema: database.schema },
      ]);
      await waitForOperationBackends(database.pool, reference, 1);
      await pool.end();
      await waitForOperationBackends(database.pool, reference, 0);
    } finally {
      if (!pool.ended) await pool.end();
      await database.dispose();
    }
  },
);

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
  'a lost snapshot connection refuses without an unhandled transport error',
  async () => {
    const database = await createIsolatedTestDatabase('snapshot_connection');
    try {
      const actual = (
        await database.pool.query<{ id: string; name: string }>(
          'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
        )
      ).rows[0];
      if (actual === undefined) throw new Error('synthetic_cluster_missing');
      const marker = `synthetic_snapshot_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(database.connectionString);
      url.searchParams.set('application_name', marker);
      let reached = false;
      let terminatedRows: unknown;
      await expect(
        withVerifiedDatabaseSnapshot(
          {
            connectionString: url.toString(),
            expectedDatabaseIdentity: { systemIdentifier: actual.id, databaseName: actual.name },
            timeoutMilliseconds: 3000,
          },
          async () => {
            reached = true;
            const terminated = await database.pool.query<{ terminated: boolean }>(
              'select pg_terminate_backend(pid) as terminated from pg_stat_activity where application_name=$1',
              [marker],
            );
            terminatedRows = terminated.rows;
          },
        ),
      ).rejects.toThrow('operations_database_target_invalid');
      expect(reached).toBe(true);
      expect(terminatedRows).toEqual([{ terminated: true }]);
      expect(
        (
          await database.pool.query(
            'select count(*)::int as count from pg_stat_activity where application_name=$1',
            [marker],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await database.dispose();
    }
  },
);

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
    let scheduledRole: string | undefined;
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
      const observed = (
        await database.pool.query<{ id: string; name: string }>(
          'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
        )
      ).rows[0];
      if (observed === undefined) throw new Error('synthetic_cluster_missing');
      const expectedDatabaseIdentity = {
        systemIdentifier: observed.id,
        databaseName: observed.name,
      };
      for (const expected of [
        { ...expectedDatabaseIdentity, systemIdentifier: '1111111111111111111' },
        { ...expectedDatabaseIdentity, databaseName: 'fcd_support_foreign' },
      ]) {
        await expect(
          createEncryptedBackup({
            ...options,
            expectedDatabaseIdentity: expected,
          }),
        ).rejects.toThrow('backup_failed');
        expect(await readdir(archiveDirectory)).toEqual([]);
        expect(await readdir(temporaryDirectory)).toEqual([]);
      }
      // The encryption invocation cannot access either identity even through an accidental path.
      await chmod(identityFile, 0o000);
      await chmod(wrongIdentityFile, 0o000);
      const reference = `operation_${randomUUID().replaceAll('-', '')}`;
      const locker = await database.pool.connect();
      let work: ReturnType<typeof createEncryptedBackup> | undefined;
      try {
        await locker.query('begin');
        await locker.query('lock table synthetic_backup_marker in access exclusive mode');
        work = createEncryptedBackup({
          ...options,
          connectionString: bindOperationConnectionString(options.connectionString, reference),
          expectedDatabaseIdentity,
        });
        // The lock keeps both the exporter and pg_dump visible long enough to
        // prove that every source connection has the same operation reference.
        void work.catch(() => undefined);
        await waitForOperationBackends(database.pool, reference, 2);
      } finally {
        await locker.query('rollback');
        locker.release();
      }
      const manifest = await work;
      await waitForOperationBackends(database.pool, reference, 0);
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
      expect(runs[0].manifest?.backupRef).toMatch(/^backup_[a-f0-9]{32}$/u);
      expect(runs[1].manifest?.backupRef).toBe(runs[0].manifest?.backupRef);
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
        OPS_DATABASE_SYSTEM_IDENTIFIER: expectedDatabaseIdentity.systemIdentifier,
        OPS_DATABASE_NAME: expectedDatabaseIdentity.databaseName,
      };
      async function cli(args: readonly string[], env: NodeJS.ProcessEnv, expectedCode = 0) {
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
        expect(code).toBe(expectedCode);
        if (expectedCode !== 0) {
          expect(JSON.parse(output)).toMatchObject({
            event: 'operations_job_failed',
            level: 'error',
          });
          return undefined;
        }
        if (args[0] === 'pre-migration-backup' || args[0] === 'scheduled-backup') {
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
      const beforeRefusals = await readdir(archiveDirectory);
      for (const override of [
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '1111111111111111111' },
        { OPS_DATABASE_NAME: 'fcd_support_foreign' },
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '' },
      ]) {
        await cli(
          ['pre-migration-backup', '2001-01-01T00:00:00.000Z'],
          { ...commonEnvironment, BACKUP_ENCRYPTION_RECIPIENT_FILE: recipientFile, ...override },
          1,
        );
        expect(await readdir(archiveDirectory)).toEqual(beforeRefusals);
      }
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
      // The dump boundary intentionally refuses arbitrary URI startup options.
      // Match deployment's role-bound namespace instead of passing the test
      // helper's pool-only search_path option to the backup process.
      const beforeInvalidConnection = await readdir(archiveDirectory);
      await expect(
        runScheduledBackup(database.pool, {
          ...options,
          connectionString: database.connectionString,
          expectedDatabaseIdentity,
          backupClass: 'daily',
          now: new Date('2001-01-03T00:00:00.000Z'),
        }),
      ).rejects.toThrow('backup_schedule_failed');
      expect(await readdir(archiveDirectory)).toEqual(beforeInvalidConnection);
      const role = `fcd_test_backup_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      if (!/^fcd_test_backup_[a-f0-9]{12}$/u.test(role))
        throw new Error('synthetic_role_scope_invalid');
      await database.pool.query(
        `create role "${role}" login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
         password 'synthetic_scheduled_backup_fixture_only'`,
      );
      scheduledRole = role;
      await database.pool.query(
        `grant connect on database fcd_support_test to "${role}";
         grant usage on schema "${database.schema}" to "${role}";
         grant select on all tables in schema "${database.schema}" to "${role}";
         grant select on all sequences in schema "${database.schema}" to "${role}";
         grant insert on operations_backups,operations_backup_events to "${role}";
         grant update(state) on operations_backups to "${role}";
         grant usage on sequence operations_backups_id_seq,operations_backup_events_id_seq to "${role}";
         alter role "${role}" in database fcd_support_test set search_path="${database.schema}"`,
      );
      const scheduledUrl = new URL(base);
      scheduledUrl.username = role;
      scheduledUrl.password = 'synthetic_scheduled_backup_fixture_only';
      scheduledUrl.search = '';
      const scopedPool = new pg.Pool({ connectionString: scheduledUrl.toString(), max: 1 });
      try {
        expect(
          (
            await scopedPool.query(
              `select current_user=$1 as correct_role,current_schema()=$2 as correct_schema,
               not rolsuper and not rolcreatedb and not rolcreaterole and not rolinherit as restricted
               from pg_catalog.pg_roles where rolname=current_user`,
              [role, database.schema],
            )
          ).rows,
        ).toEqual([{ correct_role: true, correct_schema: true, restricted: true }]);
      } finally {
        await scopedPool.end();
      }
      await writeFile(databaseFile, scheduledUrl.toString(), { mode: 0o600 });
      const scheduledEnvironment = {
        ...commonEnvironment,
        BACKUP_ENCRYPTION_RECIPIENT_FILE: recipientFile,
      };
      const scheduledRef = await cli(
        ['scheduled-backup', 'daily', '2001-01-03T00:00:00.000Z'],
        scheduledEnvironment,
      );
      expect(
        await cli(['scheduled-backup', 'daily', '2001-01-03T12:00:00.000Z'], scheduledEnvironment),
      ).toBe(scheduledRef);
      expect(scheduledRef).toBeDefined();
      if (scheduledRef === undefined) throw new Error('synthetic_scheduled_reference_missing');
      await chmod(identityFile, 0o600);
      await cli(['verify-backup', scheduledRef], {
        ...commonEnvironment,
        BACKUP_AGE_IDENTITY_FILE: identityFile,
      });
      expect(
        (
          await database.pool.query(`select count(*)::int as n from operations_backups
        where class='daily' and created_at >= '2001-01-03' and created_at < '2001-01-04'`)
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(
        (
          await database.pool.query('select state from operations_backups where backup_ref=$1', [
            scheduledRef,
          ])
        ).rows,
      ).toEqual([{ state: 'verified' }]);
    } finally {
      await chmod(identityFile, 0o600).catch(() => undefined);
      await chmod(wrongIdentityFile, 0o600).catch(() => undefined);
      await rm(archiveDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await database.dispose();
      if (scheduledRole !== undefined) {
        const cleanup = new pg.Pool({ connectionString: base, max: 1 });
        try {
          await cleanup.query(`drop owned by "${scheduledRole}"`);
          await cleanup.query(`drop role "${scheduledRole}"`);
        } finally {
          await cleanup.end();
        }
      }
    }
  },
);
