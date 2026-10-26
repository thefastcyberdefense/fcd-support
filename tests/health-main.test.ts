import { EventEmitter } from 'node:events';
import pg from 'pg';
import { expect, test, vi } from 'vitest';
import { runHealthCommand } from '../src/operations/health-main.js';
import type { HealthDatabaseSnapshot } from '../src/operations/health-collector.js';
import type { HealthObservation } from '../src/operations/operations-types.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

const at = new Date('2030-01-01T00:00:00.000Z');
function environment() {
  return {
    ...operationsEnvironment(),
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1/fcd_support_test',
    OPS_GIT_REVISION: 'a'.repeat(40),
    OPS_SCHEMA_REVISION: '000016',
    OPS_DATABASE_SYSTEM_IDENTIFIER: '7300000000000000000',
    OPS_DATABASE_NAME: 'fcd_support_test',
    OPS_DATABASE_SCHEMA: 'public',
    OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
      health: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
    }),
  };
}
test('health CLI uses role-only database configuration and emits closed journal events', async () => {
  const lines: string[] = [];
  const journal: string[] = [];
  let closed = false;
  const status = await runHealthCommand({
    environment: environment(),
    args: ['health'],
    input: {},
    now: () => at,
    write: (line) => lines.push(line),
    journal: (line) => journal.push(line),
    ports: () => ({
      database: { read: () => Promise.reject(new Error('synthetic_external_secret_url_sql')) },
      store: { recordHealth: () => Promise.resolve() },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    }),
  });
  expect(status).toBe(0);
  expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
    { status: 'completed', processed: 0, reasonCode: 'dependency_unavailable' },
  ]);
  expect(journal.map((line) => JSON.parse(line) as unknown)).toEqual([
    {
      event: 'operations_health',
      state: 'unavailable',
      component: 'postgres',
      checkedAt: at.toISOString(),
    },
  ]);
  expect(closed).toBe(true);
});
test('health CLI rejects arbitrary host payloads without echoing them', async () => {
  const lines: string[] = [];
  let connections = 0;
  const status = await runHealthCommand({
    environment: environment(),
    args: ['health'],
    input: { hostSnapshot: { error: 'synthetic_external_secret' } },
    now: () => at,
    write: (line) => lines.push(line),
    ports: () => {
      connections++;
      throw new Error('synthetic_unexpected_connect');
    },
  });
  expect(status).toBe(1);
  expect(connections).toBe(0);
  expect(lines.join('')).not.toContain('synthetic_external_secret');
  expect(lines).toEqual([]);
});
test('health CLI replays a supplied bounded gap and accepts only closed availability evidence', async () => {
  const lines: string[] = [];
  const checks: unknown[] = [];
  const status = await runHealthCommand({
    environment: environment(),
    args: ['health'],
    input: {
      outageGap: {
        startedAt: '2020-01-01T00:00:00.000Z',
        lastObservedAt: '2020-01-01T00:01:00.000Z',
      },
    },
    now: () => at,
    write: (line) => lines.push(line),
    ports: () => ({
      database: {
        read: () =>
          Promise.resolve({
            schemaRevision: '000016',
            gitRevision: 'a'.repeat(40),
            backupCreatedAt: null,
            backupVerified: false,
            deletionCheckpointAt: null,
            queues: [],
          }),
      },
      store: {
        recordHealth: (value) => {
          checks.push(value);
          return Promise.resolve();
        },
      },
      close: () => Promise.resolve(),
    }),
  });
  expect(status).toBe(0);
  expect(checks.slice(0, 2)).toMatchObject([
    {
      component: 'postgres',
      state: 'unavailable',
      checkedAt: new Date('2029-12-31T00:00:00.000Z'),
    },
    { component: 'postgres', state: 'healthy', checkedAt: at },
  ]);
  expect(lines.join('')).not.toContain('startedAt');
  expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
    { status: 'completed', processed: 11, reasonCode: 'ok' },
  ]);
});
test('ambiguous pool closure cannot produce a success acknowledgement', async () => {
  const lines: string[] = [];
  const status = await runHealthCommand({
    environment: environment(),
    args: ['health'],
    input: {},
    now: () => at,
    write: (line) => lines.push(line),
    ports: () => ({
      database: { read: () => Promise.reject(new Error('synthetic_down')) },
      store: { recordHealth: () => Promise.resolve() },
      close: () => Promise.reject(new Error('synthetic_close_ambiguous')),
    }),
  });
  expect(status).toBe(1);
  expect(lines).toEqual([]);
});

const healthySnapshot = (): HealthDatabaseSnapshot => ({
  schemaRevision: '000016',
  gitRevision: 'a'.repeat(40),
  backupCreatedAt: new Date(at.getTime() - 2000),
  backupVerified: true,
  deletionCheckpointAt: at,
  queues: [],
});

test('custom health limits reach the ports and govern backup staleness and outage replay', async () => {
  const checks: HealthObservation[] = [];
  let resolved: unknown;
  const status = await runHealthCommand({
    environment: {
      ...environment(),
      OPS_MAX_CALL_MS: '6000',
      OPS_HEALTH_BACKUP_STALE_MS: '1000',
      OPS_HEALTH_MAX_OUTAGE_GAP_MS: '5000',
    },
    args: ['health'],
    input: {
      outageGap: {
        startedAt: '2029-01-01T00:00:00.000Z',
        lastObservedAt: '2029-01-01T00:01:00.000Z',
      },
    },
    now: () => at,
    write: () => undefined,
    ports: (_environment, _now, limits) => {
      resolved = limits;
      return {
        database: { read: () => Promise.resolve(healthySnapshot()) },
        store: {
          recordHealth: (value) => {
            checks.push(value);
            return Promise.resolve();
          },
        },
        close: () => Promise.resolve(),
      };
    },
  });
  expect(status).toBe(0);
  expect(resolved).toEqual({
    maximumCallMilliseconds: 6000,
    backupStaleMilliseconds: 1000,
    maximumOutageGapMilliseconds: 5000,
  });
  expect(checks[0]).toMatchObject({
    component: 'postgres',
    checkedAt: new Date('2029-12-31T23:59:55.000Z'),
  });
  expect(checks.find((value) => value.component === 'backup')).toMatchObject({
    state: 'degraded',
    reasonCode: 'stale',
  });
});

test('configured collector deadlines above four seconds allow a slower healthy database', async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  try {
    const result = runHealthCommand({
      environment: { ...environment(), OPS_MAX_CALL_MS: '6000' },
      args: ['health'],
      input: {},
      now: () => at,
      write: (line) => {
        lines.push(line);
      },
      ports: () => ({
        database: {
          read: () =>
            new Promise((done) => {
              setTimeout(() => {
                done(healthySnapshot());
              }, 5000);
            }),
        },
        store: { recordHealth: () => Promise.resolve() },
        close: () => Promise.resolve(),
      }),
    });
    await vi.advanceTimersByTimeAsync(4500);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(0);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { status: 'completed', processed: 11, reasonCode: 'ok' },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  { OPS_HEALTH_BACKUP_STALE_MS: '0' },
  { OPS_HEALTH_BACKUP_STALE_MS: '604800001' },
  { OPS_HEALTH_BACKUP_STALE_MS: '1.5' },
  { OPS_HEALTH_MAX_OUTAGE_GAP_MS: '0' },
  { OPS_HEALTH_MAX_OUTAGE_GAP_MS: '86400001' },
  { OPS_HEALTH_MAX_OUTAGE_GAP_MS: '01' },
  { OPS_MAX_CALL_MS: '0' },
])('invalid health settings fail before input or connection acquisition: %j', async (change) => {
  let inputs = 0;
  let connections = 0;
  const lines: string[] = [];
  const status = await runHealthCommand({
    environment: { ...environment(), ...change },
    args: ['health'],
    input: {},
    readInput: () => {
      inputs++;
      return Promise.resolve({});
    },
    write: (line) => {
      lines.push(line);
    },
    ports: () => {
      connections++;
      throw new Error('synthetic_unexpected_connect');
    },
  });
  expect(status).toBe(1);
  expect(inputs).toBe(0);
  expect(connections).toBe(0);
  expect(lines).toEqual([]);
});

test('stdin receives the validated call deadline and health-only policy defaults remain unchanged', async () => {
  let inputDeadline: number | undefined;
  let resolved: unknown;
  const checks: HealthObservation[] = [];
  const status = await runHealthCommand({
    environment: { ...environment(), OPS_MAX_CALL_MS: '6000' },
    args: ['health'],
    readInput: (milliseconds) => {
      inputDeadline = milliseconds;
      return Promise.resolve({});
    },
    now: () => at,
    write: () => undefined,
    ports: (_environment, _now, limits) => {
      resolved = limits;
      return {
        database: { read: () => Promise.resolve(healthySnapshot()) },
        store: {
          recordHealth: (value) => {
            checks.push(value);
            return Promise.resolve();
          },
        },
        close: () => Promise.resolve(),
      };
    },
  });
  expect(status).toBe(0);
  expect(inputDeadline).toBe(6000);
  expect(resolved).toEqual({
    maximumCallMilliseconds: 6000,
    backupStaleMilliseconds: 129600000,
    maximumOutageGapMilliseconds: 86400000,
  });
  expect(checks.find((value) => value.component === 'backup')).toMatchObject({
    state: 'healthy',
    reasonCode: 'ok',
  });
});

test.each(['connection-refused', 'commit-socket-error'])(
  'production database ports distinguish %s from a healthy completed collection',
  async (fault) => {
    const lines: string[] = [];
    const timeouts: unknown[] = [];
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string, values?: readonly unknown[]) {
        await Promise.resolve();
        if (sql.includes('statement_timeout')) timeouts.push(values);
        if (sql.includes('pg_control_system'))
          return { rows: [{ id: '7300000000000000000', name: 'fcd_support_test' }] };
        if (sql.includes('last_collected_at'))
          return {
            rows: [
              {
                last_collected_at: null,
                schema_revision: '000016',
                git_revision: 'a'.repeat(40),
                deployment_state: 'succeeded',
                backup_created_at: null,
                backup_state: null,
                backup_verified_at: null,
                restore_state: null,
                restore_recorded_at: null,
                checkpoint_at: null,
              },
            ],
          };
        if (sql === 'commit') client.emit('error', new Error('synthetic_private_commit_socket'));
        return { rows: [] };
      },
      release: () => undefined,
    });
    const connect = vi.spyOn(pg.Pool.prototype, 'connect');
    const connectPhysical = (() =>
      fault === 'connection-refused'
        ? Promise.reject(new Error('synthetic_private_connection_refused'))
        : Promise.resolve(client as unknown as pg.PoolClient)) as pg.Pool['connect'];
    // pg.Pool.connect also has a void callback overload; this command uses its Promise overload.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    connect.mockImplementation(connectPhysical);
    try {
      const status = await runHealthCommand({
        environment: { ...environment(), OPS_MAX_CALL_MS: '6000' },
        args: ['health'],
        input: {},
        now: () => at,
        write: (line) => {
          lines.push(line);
        },
      });
      if (fault === 'connection-refused') {
        expect(status).toBe(0);
        expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
          { status: 'completed', processed: 0, reasonCode: 'dependency_unavailable' },
        ]);
      } else {
        expect(status).toBe(1);
        expect(lines).toEqual([]);
        expect(timeouts[0]).toEqual(['6000ms']);
        expect(() =>
          client.emit('error', new Error('synthetic_private_late_socket')),
        ).not.toThrow();
        client.emit('end');
        expect(client.listenerCount('error')).toBe(0);
      }
    } finally {
      connect.mockRestore();
    }
  },
);
