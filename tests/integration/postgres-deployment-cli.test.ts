import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import {
  createIsolatedTestDatabase,
  rollbackThroughMigration,
  requireIsolatedTestDatabaseUrl,
} from './test-database.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';

async function disposeDeploymentRoles(prefix: string, roles: readonly string[]) {
  const owner = new pg.Pool({
    connectionString: requireIsolatedTestDatabaseUrl(process.env),
    max: 1,
  });
  try {
    for (const role of roles) {
      const name = `${prefix}_${role}`;
      if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name))
        throw new Error('synthetic_role_scope_invalid');
      const present = await owner.query('select 1 from pg_roles where rolname=$1', [name]);
      if (present.rowCount !== 0) {
        await owner.query(`drop owned by "${name}"`);
        await owner.query(`drop role "${name}"`);
      }
    }
  } finally {
    await owner.end();
  }
}

test.skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')(
  'compiled private deployment commands forward-migrate and retain content-free revision evidence',
  async () => {
    const database = await createIsolatedTestDatabase('deployment_cli');
    const root = await mkdtemp('/run/fcd-support/deployment-cli-');
    await chmod(root, 0o700);
    const file = join(root, 'database');
    const ownerFile = join(root, 'owner-database');
    const prefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const roles = [...runtimeDatabaseRoles, 'migrator'];
    const passwordFiles: Record<string, string> = {};
    for (const role of roles) {
      const path = join(root, `bootstrap-${role.replaceAll('_', '-')}-password`);
      passwordFiles[role] = path;
      await writeFile(path, `synthetic_${prefix}_${role}_password_only`, { mode: 0o600 });
    }
    const migrateUrl = new URL(database.connectionString);
    migrateUrl.username = `${prefix}_migrator`;
    migrateUrl.password = `synthetic_${prefix}_migrator_password_only`;
    await writeFile(file, migrateUrl.toString(), { mode: 0o600 });
    await writeFile(ownerFile, database.connectionString, { mode: 0o600 });
    const ordinary = operationsEnvironment();
    const systemIdentifier = (
      await database.pool.query<{ id: string }>(
        'select system_identifier::text as id from pg_control_system()',
      )
    ).rows[0]?.id;
    if (systemIdentifier === undefined) throw new Error('synthetic_cluster_missing');
    const environment = {
      ...ordinary,
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      DATABASE_URL_FILE: file,
      OPS_DATABASE_SCHEMA: database.schema,
      OPS_DATABASE_NAME: 'fcd_support_test',
      OPS_DATABASE_ROLE_PREFIX: prefix,
      OPS_DATABASE_SYSTEM_IDENTIFIER: systemIdentifier,
      OPS_GIT_REVISION: 'a'.repeat(40),
      OPS_SCHEMA_REVISION: '000016',
      OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
        migrate: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 32 },
      }),
    };
    async function cli(
      command: string,
      override: Record<string, string> = {},
      extra: readonly string[] = [],
    ) {
      const child = spawn(process.execPath, ['/app/dist/operations-main.js', command, ...extra], {
        cwd: '/app',
        env: { ...environment, ...override },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let error = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (value: string) => {
        output += value;
        if (output.length > 2048) child.kill('SIGKILL');
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (value: string) => {
        error += value;
        if (error.length > 2048) child.kill('SIGKILL');
      });
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', () => {
          reject(new Error('synthetic_cli_spawn_failed'));
        });
        child.once('close', done);
      });
      return { code, output, error };
    }
    try {
      await rollbackThroughMigration(database, 1);
      await configureRuntimeGrants(database.pool, {
        schema: database.schema,
        database: 'fcd_support_test',
        rolePrefix: prefix,
        passwordFiles,
        phase: 'prepare',
      });
      for (const override of [
        { DATABASE_URL_FILE: ownerFile },
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '1111111111111111111' },
        { OPS_DATABASE_NAME: 'fcd_support_foreign' },
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '' },
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '0' },
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '18446744073709551616' },
      ]) {
        const refused = await cli('migrate', override);
        expect(refused.code).toBe(1);
        expect(refused.error).toBe('');
        expect(JSON.parse(refused.output)).toMatchObject({
          event: 'operations_job_failed',
          level: 'error',
        });
        expect(
          (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (await database.pool.query("select to_regclass('webhook_receipts') is null as absent"))
            .rows,
        ).toEqual([{ absent: true }]);
      }
      // A correctly named managed role must still refuse if a later operator
      // change gives it owner-level authority.
      await database.pool.query(`alter role "${prefix}_migrator" superuser`);
      try {
        expect((await cli('migrate')).code).toBe(1);
        expect(
          (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await database.pool.query(`alter role "${prefix}_migrator" nosuperuser`);
      }
      expect((await cli('migrate')).code).toBe(0);
      expect(
        (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
      ).toEqual([{ count: 16 }]);
      expect((await cli('verify-runtime')).code).toBe(1);
      const holder = await database.pool.connect();
      try {
        await holder.query('select pg_advisory_lock(hashtextextended($1,0))', [
          `fcd-support:deployment:${database.schema}`,
        ]);
        expect((await cli('deployment-started')).code).toBe(1);
      } finally {
        holder.release(true);
      }
      expect((await cli('deployment-started')).code).toBe(0);
      expect((await cli('verify-runtime')).code).toBe(0);
      expect((await cli('deployment-succeeded')).code).toBe(0);
      expect(
        (await database.pool.query('select status from operations_deployments order by id')).rows,
      ).toEqual([{ status: 'started' }, { status: 'succeeded' }]);
      for (const job of [
        'deployment-started',
        'deployment-succeeded',
        'deployment-failed',
        'verify-runtime',
      ]) {
        for (const override of [
          { OPS_DATABASE_SYSTEM_IDENTIFIER: '1111111111111111111' },
          { DATABASE_URL_FILE: ownerFile },
        ]) {
          const refused = await cli(job, override);
          expect(refused.code).toBe(1);
          expect(refused.error).toBe('');
          expect(JSON.parse(refused.output)).toMatchObject({
            event: 'operations_job_failed',
            level: 'error',
          });
        }
        expect(
          (await database.pool.query('select count(*)::int as count from operations_deployments'))
            .rows,
        ).toEqual([{ count: 2 }]);
      }
      for (const result of [
        await cli('migrate', { MODEL_EXECUTION_ENABLED: 'true' }),
        await cli('migrate', { OPS_SCHEMA_REVISION: '000014' }),
        await cli('migrate', {}, ['unexpected']),
      ]) {
        expect(result.code).toBe(1);
        expect(result.error).toBe('');
        expect(JSON.parse(result.output)).toMatchObject({
          event: 'operations_job_failed',
          level: 'error',
        });
      }
    } finally {
      await database.dispose();
      await disposeDeploymentRoles(prefix, roles);
      await rm(root, { recursive: true, force: true });
    }
  },
);
