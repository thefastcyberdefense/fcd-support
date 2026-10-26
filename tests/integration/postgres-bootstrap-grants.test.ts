import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { expect, test } from 'vitest';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { runForwardMigrations } from '../../src/operations/forward-migration.js';
import { PostgresOperationsStore } from '../../src/persistence/postgres-operations-store.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { createEncryptedBackup, verifyEncryptedBackup } from '../../src/operations/backup.js';
import {
  createIsolatedTestDatabase,
  rollbackThroughMigration,
  requireIsolatedTestDatabaseUrl,
} from './test-database.js';

async function disposeRoles(prefix: string, roles: readonly string[]) {
  const owner = new pg.Pool({
    connectionString: requireIsolatedTestDatabaseUrl(process.env),
    max: 1,
  });
  try {
    for (const role of roles) {
      const name = `${prefix}_${role}`;
      if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name))
        throw new Error('synthetic_role_scope_invalid');
      const exists = await owner.query<{ present: boolean }>(
        'select exists(select 1 from pg_roles where rolname=$1) as present',
        [name],
      );
      if (exists.rows[0]?.present === true) {
        await owner.query(`drop owned by "${name}"`);
        await owner.query(`drop role "${name}"`);
      }
    }
  } finally {
    await owner.end();
  }
}

type Mode = 'empty' | 'admission' | 'current' | 'foreign_function' | 'foreign_type' | 'deadline';
async function scenario(mode: Mode, viaCli = false) {
  const database = await createIsolatedTestDatabase(`boot_${mode}`);
  const prefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const root = await mkdtemp(join(tmpdir(), 'fcd-bootstrap-grants-test-'));
  await chmod(root, 0o700);
  const roles = [...runtimeDatabaseRoles, 'migrator'];
  const passwordFiles: Record<string, string> = {};
  const pools: pg.Pool[] = [];
  const loginUrl = (role: string) => {
    const url = new URL(database.connectionString);
    url.username = `${prefix}_${role}`;
    url.password = `synthetic_${prefix}_${role}_password_only`;
    return url.toString();
  };
  const login = (role: string) => {
    const pool = new pg.Pool({
      connectionString: loginUrl(role),
      max: 1,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
    });
    pools.push(pool);
    return pool;
  };
  try {
    if (mode !== 'current')
      await rollbackThroughMigration(
        database,
        mode === 'empty' || mode === 'deadline' || mode.startsWith('foreign_') ? 1 : 2,
      );
    if (mode === 'empty' || mode === 'deadline' || mode.startsWith('foreign_'))
      await database.pool.query('drop table pgmigrations');
    else
      await database.pool.query(
        'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
        ['a'.repeat(64), new Date('2030-04-01T00:00:00.000Z')],
      );
    for (const role of roles) {
      const file = join(root, `bootstrap-${role.replaceAll('_', '-')}-password`);
      passwordFiles[role] = file;
      await writeFile(file, `synthetic_${prefix}_${role}_password_only`, { mode: 0o600 });
    }
    const command = {
      database: 'fcd_support_test',
      schema: database.schema,
      rolePrefix: prefix,
      passwordFiles,
      phase: 'prepare' as const,
    };
    const systemIdentifier = (
      await database.pool.query<{ id: string }>(
        'select system_identifier::text as id from pg_control_system()',
      )
    ).rows[0]?.id;
    if (systemIdentifier === undefined) throw new Error('synthetic_cluster_missing');
    const databaseFile = join(root, 'owner-database');
    if (viaCli) await writeFile(databaseFile, database.connectionString, { mode: 0o600 });
    const invoke = async (phase: 'prepare' | 'converge', expectedId = systemIdentifier) => {
      const entry = existsSync('/app/dist/operations/bootstrap-main.js')
        ? '/app/dist/operations/bootstrap-main.js'
        : resolve('dist/operations/bootstrap-main.js');
      const child = spawn(process.execPath, [entry, phase, expectedId, root], {
        env: {
          ...operationsEnvironment(),
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          DATABASE_URL_FILE: databaseFile,
          OPS_DATABASE_NAME: 'fcd_support_test',
          OPS_DATABASE_SCHEMA: database.schema,
          OPS_DATABASE_ROLE_PREFIX: prefix,
          OPS_OPERATION_REFERENCE: `operation_${randomUUID().replaceAll('-', '')}`,
          OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
            migrate: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 32 },
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (value: string) => {
        stdout += value;
        if (stdout.length > 2048) child.kill('SIGKILL');
      });
      child.stderr.on('data', (value: string) => {
        stderr += value;
        if (stderr.length > 2048) child.kill('SIGKILL');
      });
      const status = await new Promise<number | null>((done, reject) => {
        child.once('error', () => {
          reject(new Error('synthetic_bootstrap_spawn_failed'));
        });
        child.once('close', done);
      });
      return { status, stdout, stderr };
    };
    const bootstrap = async (phase: 'prepare' | 'converge') => {
      if (!viaCli) {
        await configureRuntimeGrants(database.pool, { ...command, phase });
        return;
      }
      expect(await invoke(phase)).toEqual({
        status: 0,
        stdout: '{"status":"completed","processed":1,"reasonCode":"ok"}\n',
        stderr: '',
      });
    };
    if (mode === 'deadline') {
      await expect(
        configureRuntimeGrants(database.pool, { ...command, timeoutMilliseconds: 1 }),
      ).rejects.toThrow(/^runtime_grants_invalid$/u);
      expect(
        (
          await database.pool.query(
            'select count(*)::int as count from pg_roles where starts_with(rolname,$1)',
            [prefix + '_'],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      return;
    }
    if (mode.startsWith('foreign_')) {
      await database.pool.query(
        mode === 'foreign_function'
          ? 'create function synthetic_foreign() returns integer language sql as $$select 1$$'
          : "create type synthetic_foreign as enum ('synthetic')",
      );
      await expect(configureRuntimeGrants(database.pool, command)).rejects.toThrow(
        /^runtime_grants_invalid$/u,
      );
      expect(
        (
          await database.pool.query(
            'select count(*)::int as count from pg_roles where starts_with(rolname,$1)',
            [prefix + '_'],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      return;
    }
    if (viaCli) {
      expect(await invoke('prepare', '1111111111111111111')).toEqual({
        status: 1,
        stdout: '',
        stderr: 'runtime_bootstrap_failed\n',
      });
      expect(
        (
          await database.pool.query(
            'select count(*)::int as count from pg_roles where starts_with(rolname,$1)',
            [prefix + '_'],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    }
    await bootstrap('prepare');
    await bootstrap('prepare');
    const webhook = login('webhook');
    const backup = login('backup');
    const archiveReader = login('archive_reader');
    const migrator = login('migrator');
    const assertArchiveReader = async (catalogAvailable: boolean, businessAvailable: boolean) => {
      expect(
        (
          await archiveReader.query<{ correct: boolean }>(
            `select system_identifier::text=$1 and current_database()=$2 as correct from pg_catalog.pg_control_system()`,
            [systemIdentifier, 'fcd_support_test'],
          )
        ).rows,
      ).toEqual([{ correct: true }]);
      for (const sql of [
        'create table synthetic_archive_forbidden(id integer)',
        'create temporary table synthetic_archive_forbidden(id integer)',
        'create schema synthetic_archive_forbidden',
        `set role "${prefix}_backup"`,
        `set role "${prefix}_migrator"`,
      ])
        await expect(archiveReader.query(sql)).rejects.toMatchObject({ code: '42501' });
      if (businessAvailable) {
        await expect(
          archiveReader.query('select count(*) from webhook_receipts'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          archiveReader.query('select count(*) from pgmigrations'),
        ).rejects.toMatchObject({ code: '42501' });
      }
      if (catalogAvailable) {
        await expect(
          archiveReader.query('select count(*) from operations_backups'),
        ).resolves.toMatchObject({ rowCount: 1 });
        await expect(
          archiveReader.query('select count(*) from operations_backup_events'),
        ).resolves.toMatchObject({ rowCount: 1 });
        for (const sql of [
          "insert into operations_backups(backup_ref) values('backup_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')",
          'update operations_backups set state=state where false',
          'delete from operations_backups where false',
          'truncate operations_backups',
          'insert into operations_backup_events(backup_id) values(-1)',
          'update operations_backup_events set state=state where false',
          'delete from operations_backup_events where false',
          'truncate operations_backup_events',
          'select * from contacts',
          'select * from privacy_suppressions',
          'select * from admin_accounts',
          'select * from operations_deployments',
          'select last_value from contacts_id_seq',
          "select nextval('contacts_id_seq')",
          'select lock_deletion_checkpoint_source()',
        ])
          await expect(archiveReader.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    };
    // Admission-only schemas lack catalog tables, but their archive login is
    // already barred from existing business tables before migration.
    await assertArchiveReader(mode === 'current', mode !== 'empty');
    expect(
      (
        await migrator.query(
          'select not rolsuper and not rolcreaterole as restricted from pg_roles where rolname=current_user',
        )
      ).rows,
    ).toEqual([{ restricted: true }]);
    await expect(
      webhook.query('create table synthetic_forbidden(id integer)'),
    ).rejects.toMatchObject({ code: '42501' });
    if (viaCli) {
      const identityFile = join(root, 'identity');
      const recipientFile = join(root, 'recipient');
      const manifestHmacFile = join(root, 'hmac');
      const archiveDirectory = join(root, 'archives');
      const temporaryDirectory = join(root, 'work');
      await mkdir(archiveDirectory, { mode: 0o700 });
      await mkdir(temporaryDirectory, { mode: 0o700 });
      const keygen = async (args: readonly string[]) => {
        const child = spawn('age-keygen', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (part: string) => {
          output += part;
          if (output.length > 256) child.kill('SIGKILL');
        });
        const code = await new Promise<number | null>((done, reject) => {
          child.once('error', () => {
            reject(new Error('synthetic_key_generation_failed'));
          });
          child.once('close', done);
        });
        if (code !== 0) throw new Error('synthetic_key_generation_failed');
        return output;
      };
      await keygen(['--output', identityFile]);
      await chmod(identityFile, 0o600);
      const recipient = await keygen(['-y', identityFile]);
      if (!/^age1[0-9a-z]+\n$/u.test(recipient)) throw new Error('synthetic_recipient_invalid');
      await writeFile(recipientFile, recipient, { mode: 0o600 });
      await writeFile(manifestHmacFile, 'synthetic_bootstrap_manifest_hmac_'.repeat(3), {
        mode: 0o600,
      });
      await chmod(identityFile, 0o000);
      // Exercise the prepared backup login against the old/empty schema before
      // the migrator runs. Its encryption process cannot read the identity.
      const backupUrl = new URL(loginUrl('backup'));
      // pg_dump receives the explicit schema allowlist; the fixture's pool-only
      // search_path URI option is intentionally rejected by the backup API.
      backupUrl.search = '';
      const manifest = await createEncryptedBackup({
        connectionString: backupUrl.toString(),
        expectedDatabaseIdentity: { systemIdentifier, databaseName: 'fcd_support_test' },
        schemas: [database.schema],
        archiveDirectory,
        temporaryDirectory,
        recipientFile,
        manifestHmacFile,
        gitRevision: 'a'.repeat(40),
        schemaRevision: mode === 'empty' ? '000000' : '000001',
        backupClass: 'pre_migration',
        now: new Date('2030-04-01T00:00:00.000Z'),
        timeoutMilliseconds: 10000,
      });
      await chmod(identityFile, 0o600);
      await expect(
        verifyEncryptedBackup({
          archiveDirectory,
          identityFile,
          manifestHmacFile,
          expectedManifest: manifest,
          timeoutMilliseconds: 10000,
        }),
      ).resolves.toEqual({ status: 'verified' });
    }
    if (mode !== 'empty') {
      await expect(webhook.query('select count(*) from webhook_receipts')).rejects.toMatchObject({
        code: '42501',
      });
      expect(
        (await backup.query('select count(*)::int as count from webhook_receipts')).rows,
      ).toEqual([{ count: 1 }]);
      await expect(backup.query('delete from webhook_receipts')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(backup.query("select nextval('webhook_receipts_id_seq')")).rejects.toMatchObject(
        { code: '42501' },
      );
    }
    if (mode === 'current') {
      const material = {
        backupRef: `backup_${randomUUID().replaceAll('-', '')}`,
        class: 'pre_migration' as const,
        createdAt: new Date('2030-04-01T00:00:00.000Z'),
        gitRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        ciphertextBytes: 128,
        ciphertextSha256: 'b'.repeat(64),
      };
      await new PostgresOperationsStore(backup).recordBackup({ ...material, state: 'created' });
      await new PostgresOperationsStore(login('verify_backup')).recordBackup({
        ...material,
        state: 'verified',
      });
      expect(
        (
          await database.pool.query('select state from operations_backups where backup_ref=$1', [
            material.backupRef,
          ])
        ).rows,
      ).toEqual([{ state: 'verified' }]);
    }
    await expect(
      runForwardMigrations(migrator, {
        schema: database.schema,
        expectedSchemaRevision: '000016',
        timeoutMilliseconds: 10000,
      }),
    ).resolves.toEqual({ schemaRevision: '000016' });
    // Prepared app roles remain barred from new business tables until the
    // independently invoked post-migration convergence step.
    await expect(webhook.query('select count(*) from webhook_receipts')).rejects.toMatchObject({
      code: '42501',
    });
    await bootstrap('converge');
    await assertArchiveReader(true, true);
    await webhook.query(
      'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
      ['b'.repeat(64), new Date('2030-04-01T00:00:01.000Z')],
    );
    expect(
      (await backup.query('select count(*)::int as count from webhook_receipts')).rows,
    ).toEqual([{ count: mode !== 'empty' ? 2 : 1 }]);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await database.dispose();
    await disposeRoles(prefix, roles);
    await rm(root, { recursive: true, force: true });
  }
}

test.each([
  'empty',
  'admission',
  'current',
  'foreign_function',
  'foreign_type',
  'deadline',
] as const)(
  'prepare grants validates %s before nonsuperuser migration and runtime data access',
  (mode) => scenario(mode),
  20000,
);
test
  .skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')
  .each(['empty', 'admission'] as const)(
  'compiled bootstrap binds actual cluster identity and backs up %s before separate migration',
  (mode) => scenario(mode, true),
  20000,
);
