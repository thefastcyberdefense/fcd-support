import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createMaintenancePool,
  type MaintenancePoolOptions,
} from '../../src/operations/maintenance-pool.js';
import { databaseReadinessPorts } from '../../src/operations/role-runtime.js';
import { PostgresRetentionJob } from '../../src/persistence/postgres-retention-job.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { loadRoleEnvironment } from '../../src/operations/secret-files.js';
import { loadOperationsConfig } from '../../src/operations/operations-config.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import {
  createIsolatedTestDatabase,
  requireIsolatedTestDatabaseUrl,
  type IsolatedTestDatabase,
} from './test-database.js';

let database: IsolatedTestDatabase;
let root: string;
let systemIdentifier: string;
const rolePrefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const maintenanceRole = `${rolePrefix}_maintenance`;
const migratorRole = `${rolePrefix}_migrator`;
const operationReference = `operation_${randomUUID().replaceAll('-', '')}`;
const passwords: Record<string, string> = {};
const passwordFiles: Record<string, string> = {};
const cleanups: (() => Promise<void>)[] = [];
const at = new Date('2030-03-01T00:00:00.000Z');
const revision = 'a'.repeat(40);

const marker = () => `fcd-support:database-role:v1:fcd_support_test:${database.schema}:maintenance`;

beforeAll(async () => {
  database = await createIsolatedTestDatabase('maintenance_pool');
  cleanups.push(async () => {
    await database.dispose();
    const admin = new pg.Pool({ connectionString: requireIsolatedTestDatabaseUrl(process.env) });
    try {
      await dropFixtureRoles(admin);
    } finally {
      await admin.end();
    }
  });
  root = await mkdtemp(join(tmpdir(), 'fcd-maintenance-pool-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  for (const role of [...runtimeDatabaseRoles, 'migrator']) {
    const password = `synthetic_${rolePrefix}_${role}_password_only`;
    passwords[role] = password;
    const path = join(root, role);
    passwordFiles[role] = path;
    await writeFile(path, password, { mode: 0o600 });
  }
  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
  const actual = (
    await database.pool.query<{ id: string }>(
      'select system_identifier::text as id from pg_catalog.pg_control_system()',
    )
  ).rows[0]?.id;
  if (actual === undefined) throw new Error('synthetic_cluster_missing');
  systemIdentifier = actual;
  await database.pool.query(
    `insert into operations_deployments(git_revision,schema_revision,status,recorded_at)
    values($1,'000016','succeeded',$2)`,
    [revision, at],
  );
});

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function dropFixtureRoles(admin: pg.Pool) {
  for (const role of [...runtimeDatabaseRoles, 'migrator']) {
    const name = `${rolePrefix}_${role}`;
    if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name))
      throw new Error('synthetic_role_scope_invalid');
    await admin.query(`drop owned by "${name}"`);
    await admin.query(`drop role "${name}"`);
  }
}

function connectionFor(role = 'maintenance'): string {
  const url = new URL(database.connectionString);
  url.username = `${rolePrefix}_${role}`;
  url.password = passwords[role] ?? '';
  return url.toString();
}

function options(): MaintenancePoolOptions {
  return {
    connectionString: connectionFor(),
    expectedDatabaseIdentity: { systemIdentifier, databaseName: 'fcd_support_test' },
    schema: database.schema,
    rolePrefix,
    operationReference,
    max: 2,
    timeoutMilliseconds: 5000,
  };
}

test('every concurrent physical connection is scoped and reference-bound before readiness and retention queries', async () => {
  const pool = createMaintenancePool(options());
  const clients: pg.PoolClient[] = [];
  try {
    clients.push(await pool.connect());
    clients.push(await pool.connect());
    const pids = new Set<number>();
    for (const client of clients) {
      const context = (
        await client.query<{
          pid: number;
          name: string;
          application_name: string;
          search_path: string;
        }>(`select pg_catalog.pg_backend_pid() as pid,current_user as name,
          pg_catalog.current_setting('application_name') as application_name,
          pg_catalog.current_setting('search_path') as search_path`)
      ).rows[0];
      expect(context).toMatchObject({
        name: maintenanceRole,
        application_name: `fcd-support:${operationReference}`,
        search_path: `pg_catalog,"${database.schema}",pg_temp`,
      });
      if (context === undefined) throw new Error('synthetic_context_missing');
      pids.add(context.pid);
    }
    expect(pids.size).toBe(2);
    for (const client of clients.splice(0)) client.release();
    const readiness = databaseReadinessPorts(
      pool,
      () => at,
      () => Promise.resolve(true),
    );
    expect(await readiness.readSchemaRevision()).toBe('000016');
    expect(await readiness.readDeployedRevision()).toBe(revision);
    expect(
      await new PostgresRetentionJob(pool).runExpiredContentBatch({
        requestKey: 'REQUEST_TEST_bound_maintenance',
        evaluatedAt: at,
        limit: 1,
      }),
    ).toEqual({ status: 'applied', conversationsProcessed: 0, messagesPurged: 0 });
    expect(
      (await database.pool.query('select count(*)::int as count from retention_job_runs')).rows,
    ).toEqual([{ count: 1 }]);
  } finally {
    for (const client of clients) client.release(true);
    await pool.end();
  }
});

test('a later new physical connection rechecks principal scope before business writes', async () => {
  const pool = createMaintenancePool(options());
  const first = await pool.connect();
  try {
    await database.pool.query(`comment on role "${maintenanceRole}" is 'synthetic_foreign_scope'`);
    await expect(
      new PostgresRetentionJob(pool).runExpiredContentBatch({
        requestKey: 'REQUEST_TEST_rejected_new_connection',
        evaluatedAt: at,
        limit: 1,
      }),
    ).rejects.toThrow(/^maintenance_pool_invalid$/u);
    expect(pool.totalCount).toBe(1);
    expect(
      (
        await database.pool.query(
          "select count(*)::int as count from retention_job_runs where request_key='REQUEST_TEST_rejected_new_connection'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    await database.pool.query(`comment on role "${maintenanceRole}" is '${marker()}'`);
    const replacement = await pool.connect();
    try {
      const pids = await Promise.all(
        [first, replacement].map(
          async (client) =>
            (await client.query<{ pid: number }>('select pg_catalog.pg_backend_pid() as pid'))
              .rows[0]?.pid,
        ),
      );
      expect(new Set(pids).size).toBe(2);
    } finally {
      replacement.release(true);
    }
  } finally {
    await database.pool.query(`comment on role "${maintenanceRole}" is '${marker()}'`);
    first.release(true);
    await pool.end();
  }
});

test.each(['superuser', 'inherit', 'createdb', 'createrole', 'replication', 'bypassrls'])(
  'rejects an actual maintenance principal with %s privilege',
  async (privilege) => {
    const pool = createMaintenancePool(options());
    try {
      await database.pool.query(`alter role "${maintenanceRole}" ${privilege}`);
      await expect(pool.query('select 1')).rejects.toThrow(/^maintenance_pool_invalid$/u);
    } finally {
      await database.pool.query(`alter role "${maintenanceRole}" no${privilege}`);
      await pool.end();
    }
  },
);

test.each(['member', 'parent'])(
  'rejects actual role membership in the %s direction despite NOINHERIT',
  async (direction) => {
    const member = direction === 'member' ? maintenanceRole : `${rolePrefix}_health`;
    const parent = direction === 'member' ? `${rolePrefix}_health` : maintenanceRole;
    const pool = createMaintenancePool(options());
    try {
      await database.pool.query(`grant "${parent}" to "${member}"`);
      await expect(pool.query('select 1')).rejects.toThrow(/^maintenance_pool_invalid$/u);
    } finally {
      await database.pool.query(`revoke "${parent}" from "${member}"`);
      await pool.end();
    }
  },
);

test.each(['schema-create', 'database-create', 'database-temp', 'schema-owner'])(
  'rejects a maintenance connection with actual %s scope drift',
  async (fault) => {
    const pool = createMaintenancePool(options());
    const grant =
      fault === 'schema-create'
        ? `grant create on schema "${database.schema}" to "${maintenanceRole}"`
        : fault === 'schema-owner'
          ? `alter schema "${database.schema}" owner to "${maintenanceRole}"`
          : `grant ${fault === 'database-create' ? 'create' : 'temporary'} on database fcd_support_test to "${maintenanceRole}"`;
    const restore =
      fault === 'schema-create'
        ? `revoke create on schema "${database.schema}" from "${maintenanceRole}"`
        : fault === 'schema-owner'
          ? `alter schema "${database.schema}" owner to "${migratorRole}"`
          : `revoke ${fault === 'database-create' ? 'create' : 'temporary'} on database fcd_support_test from "${maintenanceRole}"`;
    try {
      await database.pool.query(grant);
      await expect(pool.query('select 1')).rejects.toThrow(/^maintenance_pool_invalid$/u);
    } finally {
      await database.pool.query(restore);
      if (fault === 'schema-owner') {
        // ALTER OWNER merges the old/new owner ACL entries. Restore the
        // original runtime USAGE grant as well as ownership for later controls.
        await database.pool.query(
          `grant usage on schema "${database.schema}" to "${maintenanceRole}";
           revoke create on schema "${database.schema}" from "${maintenanceRole}"`,
        );
      }
      await pool.end();
    }
  },
);

test.each(['owner-login', 'other-runtime-login', 'missing-schema', 'wrong-database'])(
  'rejects %s before accepting a business query',
  async (fault) => {
    const configuration = options();
    const pool = createMaintenancePool({
      ...configuration,
      ...(fault === 'owner-login' ? { connectionString: database.connectionString } : {}),
      ...(fault === 'other-runtime-login' ? { connectionString: connectionFor('health') } : {}),
      ...(fault === 'missing-schema' ? { schema: 'test_synthetic_missing_schema' } : {}),
      ...(fault === 'wrong-database'
        ? {
            expectedDatabaseIdentity: {
              systemIdentifier,
              databaseName: 'fcd_support_synthetic_other',
            },
          }
        : {}),
    });
    try {
      await expect(pool.query('select 1')).rejects.toThrow(/^maintenance_pool_invalid$/u);
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  },
);

test.skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')(
  'compiled maintenance refuses a foreign physical identity before creating a job result',
  async () => {
    const databaseFile = join(root, 'cli-maintenance-database');
    const keyringFile = join(root, 'cli-maintenance-keyring');
    await writeFile(databaseFile, connectionFor(), { mode: 0o600 });
    await writeFile(
      keyringFile,
      JSON.stringify({
        activeVersion: 'synthetic-v1',
        keys: [
          {
            version: 'synthetic-v1',
            keyBase64url: Buffer.alloc(32, 3).toString('base64url'),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const common = operationsEnvironment();
    const environment = {
      ...common,
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      DATABASE_URL_FILE: databaseFile,
      PRIVACY_HMAC_KEYRING_FILE: keyringFile,
      OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
        maintenance: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 16 },
      }),
      OPS_OPERATION_REFERENCE: operationReference,
      OPS_DATABASE_SCHEMA: database.schema,
      OPS_DATABASE_ROLE_PREFIX: rolePrefix,
      OPS_DATABASE_NAME: 'fcd_support_test',
      OPS_GIT_REVISION: revision,
      OPS_SCHEMA_REVISION: '000016',
      OPS_LEARNING_WINDOW_MS: '86400000',
      OPS_LEARNING_POLICY_JSON: JSON.stringify({
        minimumGroupCount: 3,
        digestIntervalMilliseconds: 259200000,
        maximumQuestionsPerDigest: 5,
        questionCooldownMilliseconds: 604800000,
        maximumDigestAppearances: 2,
        maximumObservationsPerRun: 1000,
      }),
      REPLY_OUTBOUND_BOUNDS_JSON: JSON.stringify({
        global1Minute: 120,
        globalUtcDay: 900,
        leaseMs: 25000,
        maximumDefiniteRetries: 2,
        messengerAccount1Minute: 80,
        perContact15Minute: 3,
        perContact24Hour: 30,
        providerTimeoutMs: 8000,
        retryBaseMs: 5000,
        retryMaximumMs: 30000,
        whatsappAccount1Minute: 90,
        workerBatchSize: 10,
      }),
    };
    const loaded = await loadRoleEnvironment('maintenance', environment);
    expect(loadOperationsConfig('maintenance', loaded).maximumCallMilliseconds).toBe(20000);
    const before = (await database.pool.query('select count(*)::int as n from retention_job_runs'))
      .rows;
    const invoke = (id: string, run: string) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['/app/dist/operations-main.js', 'retention', run, '2001-01-01T00:00:00.000Z'],
          {
            env: { ...environment, OPS_DATABASE_SYSTEM_IDENTIFIER: id },
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          if (output.length > 4096) child.kill('SIGKILL');
        });
        child.once('error', () => {
          reject(new Error('synthetic_cli_spawn_failed'));
        });
        child.once('close', (code) => {
          resolve({ code, output });
        });
      });
    const wrong =
      systemIdentifier === '1111111111111111111' ? '2222222222222222222' : '1111111111111111111';
    const refused = await invoke(wrong, 'RUN_TEST_wrong_physical');
    expect(refused.code).toBe(1);
    expect(refused.output).not.toContain('"status":"completed"');
    expect(
      (await database.pool.query('select count(*)::int as n from retention_job_runs')).rows,
    ).toEqual(before);
    const accepted = await invoke(systemIdentifier, 'RUN_TEST_right_physical');
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.output)).toMatchObject({ status: 'completed', reasonCode: 'ok' });
  },
);

test.skipIf(process.env.RUN_ISOLATED_RESTORE_TESTS !== 'synthetic-isolated-cluster-only')(
  'rejects a substituted physical cluster despite matching database, schema and dedicated principal scope',
  async () => {
    requireIsolatedTestDatabaseUrl(process.env);
    const targetOwnerUrl = 'postgresql://fcd_support_test@restore-postgres:5432/postgres';
    if (process.env.RESTORE_TEST_DATABASE_URL !== targetOwnerUrl)
      throw new Error('synthetic_restore_target_invalid');
    const owner = new pg.Pool({ connectionString: targetOwnerUrl, max: 1 });
    const databaseName = `fcd_support_maintenance_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const url = new URL(targetOwnerUrl);
    url.pathname = `/${databaseName}`;
    let target: pg.Pool | undefined;
    let created = false;
    let rolesCreated = false;
    try {
      const id = (
        await owner.query<{ id: string }>(
          'select system_identifier::text as id from pg_catalog.pg_control_system()',
        )
      ).rows[0]?.id;
      expect(id).toBeDefined();
      expect(id).not.toBe(systemIdentifier);
      if (id === undefined) throw new Error('synthetic_cluster_missing');
      await owner.query(`create database "${databaseName}" template template0`);
      created = true;
      target = new pg.Pool({ connectionString: url.toString(), max: 1 });
      await target.query(`create schema "${database.schema}"`);
      await configureRuntimeGrants(target, {
        schema: database.schema,
        database: databaseName,
        rolePrefix,
        passwordFiles,
        phase: 'prepare',
      });
      rolesCreated = true;
      await target.query(`create table "${database.schema}".synthetic_effects(id integer);
        grant select,insert on "${database.schema}".synthetic_effects to "${maintenanceRole}"`);
      url.username = maintenanceRole;
      url.password = passwords.maintenance ?? '';
      const targetOptions = {
        ...options(),
        connectionString: url.toString(),
        expectedDatabaseIdentity: { systemIdentifier: id, databaseName },
      };
      const control = createMaintenancePool(targetOptions);
      try {
        expect(
          (await control.query('select count(*)::int as count from synthetic_effects')).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await control.end();
      }
      const substituted = createMaintenancePool({
        ...targetOptions,
        expectedDatabaseIdentity: { systemIdentifier, databaseName },
      });
      try {
        await expect(
          substituted.query('insert into synthetic_effects(id) values(1)'),
        ).rejects.toThrow(/^maintenance_pool_invalid$/u);
        expect(
          (
            await target.query(
              `select count(*)::int as count from "${database.schema}".synthetic_effects`,
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await substituted.end();
      }
    } finally {
      if (target !== undefined) {
        if (rolesCreated) {
          await target.query(`drop schema "${database.schema}" cascade`);
          await dropFixtureRoles(target);
        }
        await target.end();
      }
      if (created) await owner.query(`drop database "${databaseName}"`);
      await owner.end();
    }
  },
);
