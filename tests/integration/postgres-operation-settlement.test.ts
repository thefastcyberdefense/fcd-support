import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  bindOperationConnectionString,
  operationApplicationName,
} from '../../src/operations/operation-reference.js';
import { inspectOperationSettlement } from '../../src/operations/operation-settlement.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';

let database: IsolatedTestDatabase;
let probe: pg.Pool;
let systemIdentifier: string;
const reference = `operation_${randomUUID().replaceAll('-', '')}`;
const probeReference = `operation_${randomUUID().replaceAll('-', '')}`;
const options = () => ({
  reference,
  probeReference,
  systemIdentifier,
  databaseName: 'fcd_support_test',
  schema: database.schema,
  timeoutMilliseconds: 3000,
});

beforeAll(async () => {
  database = await createIsolatedTestDatabase('operation_settlement');
  const actual = (
    await database.pool.query<{ id: string }>(
      'select system_identifier::text as id from pg_control_system()',
    )
  ).rows[0]?.id;
  if (actual === undefined) throw new Error('synthetic_cluster_missing');
  systemIdentifier = actual;
  probe = new pg.Pool({
    connectionString: bindOperationConnectionString(database.connectionString, probeReference),
    max: 1,
  });
});
afterAll(async () => {
  await probe.end();
  await database.dispose();
});

test('settlement closes its actual owner backend and releases both mutation barriers', async () => {
  await expect(inspectOperationSettlement(probe, options())).resolves.toEqual({
    status: 'settled',
  });
  const deadline = Date.now() + 3000;
  for (;;) {
    const result = await database.pool.query<{ count: string }>(
      'select count(*)::text as count from pg_stat_activity where application_name=$1',
      [operationApplicationName(probeReference)],
    );
    if (result.rows[0]?.count === '0') break;
    if (Date.now() >= deadline) throw new Error('synthetic_probe_backend_remains');
    await new Promise((done) => setTimeout(done, 10));
  }
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    for (const key of [
      `fcd-support:runtime-grants:fcd_support_test:${database.schema}`,
      `fcd-support:deployment:${database.schema}`,
    ]) {
      expect(
        (
          await client.query(
            'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired',
            [key],
          )
        ).rows,
      ).toEqual([{ acquired: true }]);
    }
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test.each(['same-database', 'other-database'])(
  'settlement refuses a lingering %s backend until its actual connection closes',
  async (mode) => {
    const url = new URL(database.connectionString);
    if (mode === 'other-database') {
      // Both DBs belong to this guarded, disposable synthetic PostgreSQL cluster.
      url.pathname = '/postgres';
      url.search = '';
    }
    const old = new pg.Pool({
      connectionString: bindOperationConnectionString(url.toString(), reference),
      max: 1,
    });
    try {
      await old.query('select 1');
      await expect(inspectOperationSettlement(probe, options())).rejects.toThrow(
        /^operations_job_unsettled$/u,
      );
    } finally {
      await old.end();
    }
    const deadline = Date.now() + 3000;
    for (;;) {
      const result = await database.pool.query<{ count: string }>(
        'select count(*)::text as count from pg_stat_activity where application_name=$1',
        [operationApplicationName(reference)],
      );
      if (result.rows[0]?.count === '0') break;
      if (Date.now() >= deadline) throw new Error('synthetic_old_backend_remains');
      await new Promise((done) => setTimeout(done, 10));
    }
    await expect(inspectOperationSettlement(probe, options())).resolves.toEqual({
      status: 'settled',
    });
  },
);

test.each(['runtime-grants', 'deployment'])(
  'settlement refuses the held %s advisory barrier without waiting or releasing its owner',
  async (kind) => {
    const blocker = await database.pool.connect();
    const key =
      kind === 'runtime-grants'
        ? `fcd-support:runtime-grants:fcd_support_test:${database.schema}`
        : `fcd-support:deployment:${database.schema}`;
    try {
      await blocker.query('begin');
      await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      await expect(inspectOperationSettlement(probe, options())).rejects.toThrow(
        /^operations_job_unsettled$/u,
      );
      expect(
        (
          await blocker.query(
            'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired',
            [key],
          )
        ).rows,
      ).toEqual([{ acquired: true }]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    await expect(inspectOperationSettlement(probe, options())).resolves.toEqual({
      status: 'settled',
    });
  },
);

test.each(['system', 'database'])('settlement refuses a substituted %s identity', async (kind) => {
  await expect(
    inspectOperationSettlement(probe, {
      ...options(),
      ...(kind === 'system'
        ? {
            systemIdentifier:
              systemIdentifier === '1111111111111111111'
                ? '2222222222222222222'
                : '1111111111111111111',
          }
        : { databaseName: 'fcd_support_other' }),
    }),
  ).rejects.toThrow(/^operations_job_unsettled$/u);
});

test('settlement refuses an untracked probe connection', async () => {
  await expect(inspectOperationSettlement(database.pool, options())).rejects.toThrow(
    /^operations_job_unsettled$/u,
  );
});

test
  .skipIf(
    process.platform !== 'linux' ||
      process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only',
  )
  .each(['settled', 'backend', 'identity', 'untracked'])(
  'compiled owner inspection handles %s with closed output and without role password files',
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-settlement-test-'));
    const secret = join(root, 'owner-database');
    const old = new pg.Pool({
      connectionString: bindOperationConnectionString(database.connectionString, reference),
      max: 1,
    });
    try {
      await writeFile(secret, database.connectionString, { mode: 0o600 });
      if (fault === 'backend') await old.query('select 1');
      const entry = existsSync('/app/dist/operations/bootstrap-main.js')
        ? '/app/dist/operations/bootstrap-main.js'
        : resolve('dist/operations/bootstrap-main.js');
      const child = spawn(
        process.execPath,
        [entry, 'inspect-settlement', reference, fault === 'identity' ? '1' : systemIdentifier],
        {
          env: {
            ...operationsEnvironment(),
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            DATABASE_URL_FILE: secret,
            OPS_DATABASE_NAME: 'fcd_support_test',
            OPS_DATABASE_SCHEMA: database.schema,
            OPS_DATABASE_ROLE_PREFIX: 'fcd_test_settlement',
            ...(fault === 'untracked' ? {} : { OPS_OPERATION_REFERENCE: probeReference }),
            OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
              migrate: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 32 },
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (part: string) => {
        stdout += part;
        if (stdout.length > 2048) child.kill('SIGKILL');
      });
      child.stderr.on('data', (part: string) => {
        stderr += part;
        if (stderr.length > 2048) child.kill('SIGKILL');
      });
      const status = await new Promise<number | null>((done, reject) => {
        child.once('error', () => {
          reject(new Error('synthetic_settlement_spawn_failed'));
        });
        child.once('close', done);
      });
      expect({ status, stdout, stderr }).toEqual(
        fault === 'settled'
          ? {
              status: 0,
              stdout: '{"status":"completed","processed":1,"reasonCode":"ok"}\n',
              stderr: '',
            }
          : { status: 1, stdout: '', stderr: 'runtime_bootstrap_failed\n' },
      );
    } finally {
      await old.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
