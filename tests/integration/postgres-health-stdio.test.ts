import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import {
  reapChildProcess,
  reapChildProcesses,
  waitForBarrier,
  waitForExit,
} from '../helpers/process-lifecycle.js';
import {
  createIsolatedTestDatabase,
  requireIsolatedTestDatabaseUrl,
  type IsolatedTestDatabase,
} from './test-database.js';

const native = process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const healthEntry = existsSync('/app/dist/operations/health-main.js')
  ? '/app/dist/operations/health-main.js'
  : resolve('dist/operations/health-main.js');
const revision = 'a'.repeat(40);
const hostSecretMarker = 'synthetic_pg_host_marker_do_not_echo';

interface SystemIdentifierRow {
  readonly id: string;
}

interface CountRow {
  readonly count: string;
}

interface HealthCheckRow {
  readonly component: string;
  readonly state: string;
  readonly reason_code: string;
}

describe.runIf(native)(
  'real built dist/operations/health-main.js PostgreSQL stdio contract',
  () => {
    let database: IsolatedTestDatabase | undefined;
    let secretRoot = '';
    let prefix = '';
    let systemIdentifier = '';
    let healthPassword = '';
    let healthDatabaseFile = '';
    const children: ChildProcess[] = [];

    beforeAll(async () => {
      const db = await createIsolatedTestDatabase('health_stdio');
      database = db;
      secretRoot = await mkdtemp(join(tmpdir(), 'fcd-pg-health-stdio-'));
      await chmod(secretRoot, 0o700);
      prefix = `fcd_test_${randomBytes(6).toString('hex')}`;
      const passwordFiles: Record<string, string> = {};
      for (const role of [...runtimeDatabaseRoles, 'migrator']) {
        const password = `synthetic_${role}_${randomBytes(16).toString('hex')}`;
        if (role === 'health') healthPassword = password;
        const file = join(secretRoot, `${role}-password`);
        await writeFile(file, password, { mode: 0o600 });
        passwordFiles[role] = file;
      }

      const idResult = await db.pool.query<SystemIdentifierRow>(
        'select system_identifier::text as id from pg_catalog.pg_control_system()',
      );
      systemIdentifier = idResult.rows[0]?.id ?? '';
      expect(systemIdentifier).toMatch(/^[1-9][0-9]{0,19}$/u);

      await configureRuntimeGrants(db.pool, {
        schema: db.schema,
        database: 'fcd_support_test',
        rolePrefix: prefix,
        passwordFiles,
        phase: 'converge',
      });

      const url = new URL(db.connectionString);
      url.username = `${prefix}_health`;
      url.password = healthPassword;
      url.search = '';
      healthDatabaseFile = join(secretRoot, 'health-database');
      await writeFile(healthDatabaseFile, url.toString(), { mode: 0o600 });
    });

    afterEach(async () => {
      await reapChildProcesses(children.splice(0), {
        termTimeoutMs: 500,
        killTimeoutMs: 500,
        processGroup: true,
      });
    });

    afterAll(async () => {
      if (database !== undefined) {
        await database.dispose();
        if (/^fcd_test_[a-f0-9]{12}$/u.test(prefix)) {
          const cleanup = new pg.Pool({
            connectionString: requireIsolatedTestDatabaseUrl(process.env),
            connectionTimeoutMillis: 5_000,
            idleTimeoutMillis: 5_000,
            max: 2,
          });
          try {
            for (const role of [...runtimeDatabaseRoles, 'migrator']) {
              const name = `${prefix}_${role}`;
              if (/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name)) {
                await cleanup.query(`drop owned by "${name}"`).catch(() => undefined);
                await cleanup.query(`drop role if exists "${name}"`);
              }
            }
          } finally {
            await cleanup.end();
          }
        }
      }
      if (secretRoot !== '') {
        await rm(secretRoot, { recursive: true, force: true });
      }
    });

    function activeDatabase(): IsolatedTestDatabase {
      if (database === undefined) throw new Error('missing_database');
      return database;
    }

    function buildEnv(overrides: Record<string, string | undefined> = {}) {
      return {
        PATH: process.env.PATH,
        ...operationsEnvironment(),
        NODE_ENV: 'production',
        OPS_GIT_REVISION: revision,
        OPS_SCHEMA_REVISION: '000016',
        OPS_DATABASE_SYSTEM_IDENTIFIER: systemIdentifier,
        OPS_DATABASE_NAME: 'fcd_support_test',
        OPS_DATABASE_SCHEMA: activeDatabase().schema,
        OPS_DATABASE_ROLE_PREFIX: prefix,
        DATABASE_URL_FILE: healthDatabaseFile,
        OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
          health: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
        }),
        ...overrides,
      };
    }

    test('persists 11 real health rows to synthetic PostgreSQL and emits canonical ok acknowledgement while stdin stays open', async () => {
      expect(existsSync(healthEntry)).toBe(true);
      const db = activeDatabase();
      const before = await db.pool.query<CountRow>(
        'select count(*)::text as count from operations_health_checks',
      );
      const beforeCount = Number(before.rows[0]?.count ?? '0');

      const child = spawn(process.execPath, [healthEntry, 'health'], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildEnv(),
      });
      children.push(child);

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const frame =
        JSON.stringify({
          hostSnapshot: {
            checkedAt: new Date().toISOString(),
            services: [
              {
                component: 'webhook',
                running: true,
                health: 'healthy',
                gitRevision: revision,
              },
            ],
            adminSocket: 'healthy',
            manifestAttestation: 'not_verified',
            publicRouteCheck: { state: 'not_verified' },
          },
          availability: { manifest: 'healthy', n8n: 'unavailable' },
        }) + '\n';

      const ackBarrier = waitForBarrier(
        child,
        '{"status":"completed","processed":11,"reasonCode":"ok"}\n',
        { timeoutMs: 10_000 },
      );
      child.stdin.write(frame);
      await ackBarrier;
      expect(child.stdin.writableEnded).toBe(false);

      const exit = await waitForExit(child, { timeoutMs: 5_000 });
      expect(exit).toEqual({ code: 0, signal: null });
      expect(child.stdin.writableEnded).toBe(false);
      expect(stdout).toBe('{"status":"completed","processed":11,"reasonCode":"ok"}\n');
      expect(stdout + stderr).not.toContain(healthPassword);
      expect(stdout + stderr).not.toContain('hostSnapshot');

      await reapChildProcess(child, {
        termTimeoutMs: 500,
        killTimeoutMs: 500,
        processGroup: true,
      });

      const after = await db.pool.query<CountRow>(
        'select count(*)::text as count from operations_health_checks',
      );
      expect(Number(after.rows[0]?.count ?? '0') - beforeCount).toBe(11);

      const latest = await db.pool.query<HealthCheckRow>(
        `select distinct on (component) component, state, reason_code
         from operations_health_checks
         order by component, checked_at desc, id desc`,
      );
      expect(latest.rows).toHaveLength(11);
      expect(latest.rows.find((row) => row.component === 'postgres')).toEqual({
        component: 'postgres',
        state: 'healthy',
        reason_code: 'ok',
      });
      expect(latest.rows.find((row) => row.component === 'webhook')).toEqual({
        component: 'webhook',
        state: 'healthy',
        reason_code: 'ok',
      });

      const intents = await db.pool.query<CountRow>(
        'select count(*)::text as count from outbound_intents',
      );
      expect(Number(intents.rows[0]?.count ?? '0')).toBe(0);
    });

    test.each([
      ['malformed-eof', { payload: `{"hostSnapshot":"${hostSecretMarker}"`, closeStdin: true }],
      [
        'malformed-open-timeout',
        {
          payload: `{"hostSnapshot":"${hostSecretMarker}"\n`,
          closeStdin: false,
          extraEnv: { OPS_MAX_CALL_MS: '200' },
        },
      ],
      ['oversized', { payload: `{"x":"${'y'.repeat(16_385)}"}\n`, closeStdin: true }],
      [
        'stalled-silent',
        { payload: null, closeStdin: false, extraEnv: { OPS_MAX_CALL_MS: '200' } },
      ],
      [
        'invalid-schema-revision',
        { payload: '{}\n', closeStdin: false, extraEnv: { OPS_SCHEMA_REVISION: 'bad_rev' } },
      ],
    ] as const)(
      'refuses %s fault with exit 1, zero acknowledgement, and zero new PostgreSQL rows',
      async (_label, spec) => {
        expect(existsSync(healthEntry)).toBe(true);
        const db = activeDatabase();
        const before = await db.pool.query<CountRow>(
          'select count(*)::text as count from operations_health_checks',
        );
        const beforeCount = Number(before.rows[0]?.count ?? '0');

        const child = spawn(process.execPath, [healthEntry, 'health'], {
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildEnv('extraEnv' in spec ? spec.extraEnv : {}),
        });
        children.push(child);

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        if (spec.payload !== null) {
          if (spec.closeStdin) child.stdin.end(spec.payload);
          else child.stdin.write(spec.payload);
        }

        const exit = await waitForExit(child, { timeoutMs: 5_000 });
        expect(exit.code).toBe(1);
        expect(stdout).toBe('');
        expect(JSON.parse(stderr.trim()) as unknown).toMatchObject({
          event: 'operations_health',
          component: 'postgres',
          state: 'unknown',
        });
        expect(stdout + stderr).not.toContain(healthPassword);
        expect(stdout + stderr).not.toContain(hostSecretMarker);

        await reapChildProcess(child, {
          termTimeoutMs: 500,
          killTimeoutMs: 500,
          processGroup: true,
        });

        const after = await db.pool.query<CountRow>(
          'select count(*)::text as count from operations_health_checks',
        );
        expect(Number(after.rows[0]?.count ?? '0')).toBe(beforeCount);

        const intents = await db.pool.query<CountRow>(
          'select count(*)::text as count from outbound_intents',
        );
        expect(Number(intents.rows[0]?.count ?? '0')).toBe(0);
      },
    );
  },
);
