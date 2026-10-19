import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { createIsolatedTestDatabase, rollbackThroughMigration } from './test-database.js';

test.skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')(
  'compiled private deployment commands forward-migrate and retain content-free revision evidence',
  async () => {
    const database = await createIsolatedTestDatabase('deployment_cli');
    const root = await mkdtemp('/run/fcd-support/deployment-cli-');
    await chmod(root, 0o700);
    const file = join(root, 'database');
    await writeFile(file, database.connectionString, { mode: 0o600 });
    const ordinary = operationsEnvironment();
    const environment = {
      ...ordinary,
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      DATABASE_URL_FILE: file,
      OPS_DATABASE_SCHEMA: database.schema,
      OPS_GIT_REVISION: 'a'.repeat(40),
      OPS_SCHEMA_REVISION: '000015',
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
      expect((await cli('migrate')).code).toBe(0);
      expect(
        (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
      ).toEqual([{ count: 15 }]);
      expect((await cli('verify-runtime')).code).toBe(1);
      expect((await cli('deployment-started')).code).toBe(0);
      expect((await cli('verify-runtime')).code).toBe(0);
      expect((await cli('deployment-succeeded')).code).toBe(0);
      expect(
        (await database.pool.query('select status from operations_deployments order by id')).rows,
      ).toEqual([{ status: 'started' }, { status: 'succeeded' }]);
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
      await rm(root, { recursive: true, force: true });
    }
  },
);
