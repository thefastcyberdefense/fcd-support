import { describe, expect, test } from 'vitest';
import {
  collectHealth,
  parseHostHealthSnapshot,
  type HealthCollectorOptions,
  type HealthJournalEvent,
  type HealthOutageGap,
} from '../src/operations/health-collector.js';
import type { HealthObservation } from '../src/operations/operations-types.js';

const at = new Date('2030-01-01T00:00:00.000Z');
const revision = 'a'.repeat(40);
function fixture() {
  const journal: HealthJournalEvent[] = [];
  const saved: HealthObservation[] = [];
  let gap: HealthOutageGap | undefined;
  const options: HealthCollectorOptions = {
    now: () => at,
    timeoutMilliseconds: 20,
    staleMilliseconds: 60_000,
    maximumOutageGapMilliseconds: 86_400_000,
    expectedSchemaRevision: '000016',
    expectedGitRevision: revision,
    modelEnabled: false,
    notificationsEnabled: false,
    database: {
      read: () =>
        Promise.resolve({
          schemaRevision: '000016',
          gitRevision: revision,
          backupCreatedAt: new Date(at.getTime() - 1000),
          backupVerified: true,
          deletionCheckpointAt: new Date(at.getTime() - 1000),
          queues: [],
        }),
    },
    store: {
      recordHealth: (value) => {
        saved.push(value);
        return Promise.resolve();
      },
    },
    journal: (value) => {
      journal.push(value);
    },
    outage: {
      read: () => Promise.resolve(gap),
      write: (value) => {
        gap = value;
        return Promise.resolve();
      },
      clear: () => {
        gap = undefined;
        return Promise.resolve();
      },
    },
  };
  return { options, journal, saved, gap: () => gap };
}

describe('content-free health collector', () => {
  test('database outage still writes only a fixed journal event', async () => {
    const f = fixture();
    await collectHealth({
      ...f.options,
      database: {
        read: () => Promise.reject(new Error('synthetic_external_secret <script> SQL url')),
      },
    });
    expect(f.journal).toEqual([
      {
        event: 'operations_health',
        state: 'unavailable',
        component: 'postgres',
        checkedAt: at.toISOString(),
      },
    ]);
    expect(f.saved).toEqual([]);
    expect(f.gap()).toEqual({ startedAt: at.toISOString(), lastObservedAt: at.toISOString() });
  });
  test('absence of host verification and disabled external paths never report healthy', async () => {
    const f = fixture();
    const report = await collectHealth(f.options);
    expect(report.find((v) => v.component === 'manifest')).toMatchObject({
      state: 'disabled',
      reasonCode: 'disabled',
    });
    expect(report.find((v) => v.component === 'n8n')).toMatchObject({
      state: 'disabled',
      reasonCode: 'disabled',
    });
    for (const component of ['webhook', 'reply', 'outbound', 'tunnel'])
      expect(report.find((v) => v.component === component)).toMatchObject({
        state: 'unknown',
        reasonCode: 'not_verified',
      });
  });
  test('bounded availability probes time out without inference or error text', async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    const report = await collectHealth({
      ...f.options,
      modelEnabled: true,
      manifestProbe: (received) => {
        signal = received;
        return new Promise(() => undefined);
      },
    });
    expect(report.find((v) => v.component === 'manifest')).toMatchObject({
      state: 'unavailable',
      reasonCode: 'timeout',
    });
    expect(signal?.aborted).toBe(true);
    expect(JSON.stringify(f.journal)).not.toContain('synthetic_external');
  });
  test('replays one bounded outage interval before recording recovery after host downtime', async () => {
    const f = fixture();
    await f.options.outage.write({
      startedAt: '2020-01-01T00:00:00.000Z',
      lastObservedAt: '2020-01-01T00:01:00.000Z',
    });
    await collectHealth(f.options);
    expect(f.saved.slice(0, 2)).toMatchObject([
      {
        component: 'postgres',
        state: 'unavailable',
        reasonCode: 'dependency_unavailable',
        checkedAt: new Date('2029-12-31T00:00:00.000Z'),
      },
      { component: 'postgres', state: 'healthy', checkedAt: at },
    ]);
    expect(f.gap()).toBeUndefined();
  });
  test('stale backup and mismatched migration revisions fail closed', async () => {
    const f = fixture();
    const report = await collectHealth({
      ...f.options,
      database: {
        read: () =>
          Promise.resolve({
            schemaRevision: '000015',
            gitRevision: revision,
            backupCreatedAt: new Date('2029-01-01T00:00:00.000Z'),
            backupVerified: true,
            deletionCheckpointAt: null,
            queues: [],
          }),
      },
    });
    expect(report.find((v) => v.component === 'backup')).toMatchObject({
      state: 'degraded',
      reasonCode: 'stale',
    });
    expect(report.find((v) => v.component === 'migration')).toMatchObject({
      state: 'unavailable',
      reasonCode: 'configuration_invalid',
    });
  });
  test('strict host snapshot rejects arbitrary external inspect/error fields', () => {
    expect(
      parseHostHealthSnapshot({
        checkedAt: at.toISOString(),
        services: [],
        error: 'synthetic_external_secret',
      }),
    ).toBeUndefined();
    expect(
      parseHostHealthSnapshot({
        checkedAt: at.toISOString(),
        services: [
          {
            component: 'webhook',
            running: true,
            health: 'healthy',
            gitRevision: revision,
            heartbeat: { checkedAt: at.toISOString(), state: 'healthy' },
          },
        ],
        adminSocket: 'healthy',
        manifestAttestation: 'not_verified',
        publicRouteCheck: { state: 'not_verified' },
      }),
    ).toBeDefined();
  });
  test('stale host snapshots and count-query failures never leave a healthy claim', async () => {
    const f = fixture();
    const report = await collectHealth({
      ...f.options,
      database: { read: () => Promise.reject(new Error('synthetic_count_query_failure')) },
    });
    expect(report).toEqual([
      expect.objectContaining({ component: 'postgres', state: 'unavailable' }),
    ]);
  });
  test('healthy Docker without a fresh worker heartbeat cannot hide downtime', async () => {
    const f = fixture();
    const report = await collectHealth({
      ...f.options,
      hostSnapshot: {
        checkedAt: at.toISOString(),
        services: [
          {
            component: 'reply',
            running: true,
            health: 'healthy',
            gitRevision: revision,
            heartbeat: { state: 'healthy', checkedAt: '2029-12-31T00:00:00.000Z' },
          },
        ],
        adminSocket: 'healthy',
        manifestAttestation: 'not_verified',
        publicRouteCheck: { state: 'not_verified' },
      },
    });
    expect(report.find((value) => value.component === 'reply')).toMatchObject({
      state: 'degraded',
      reasonCode: 'stale',
    });
  });
  test('stale host attestations cannot verify Manifest or tunnel availability', async () => {
    const f = fixture();
    const report = await collectHealth({
      ...f.options,
      modelEnabled: true,
      manifestProbe: () => Promise.resolve('healthy'),
      hostSnapshot: {
        checkedAt: '2029-12-31T00:00:00.000Z',
        services: [
          { component: 'tunnel', running: true, health: 'healthy', gitRevision: revision },
        ],
        adminSocket: 'healthy',
        manifestAttestation: 'verified',
        publicRouteCheck: { state: 'passed', checkedAt: '2029-12-31T00:00:00.000Z' },
      },
    });
    expect(report.find((value) => value.component === 'manifest')).toMatchObject({
      state: 'degraded',
      reasonCode: 'not_verified',
    });
    expect(report.find((value) => value.component === 'tunnel')).toMatchObject({
      state: 'unknown',
      reasonCode: 'stale',
    });
  });
  test('disabled paths never execute injected availability probes', async () => {
    const f = fixture();
    let calls = 0;
    await collectHealth({
      ...f.options,
      manifestProbe: () => {
        calls++;
        return Promise.resolve('healthy');
      },
      n8nProbe: () => {
        calls++;
        return Promise.resolve('healthy');
      },
    });
    expect(calls).toBe(0);
  });
  test('recovery after host downtime records a bounded collection gap without claiming unobserved uptime', async () => {
    const f = fixture();
    await collectHealth({
      ...f.options,
      database: {
        read: () =>
          Promise.resolve({
            schemaRevision: '000016',
            gitRevision: revision,
            backupCreatedAt: null,
            backupVerified: false,
            deletionCheckpointAt: null,
            queues: [],
            lastCollectedAt: new Date('2020-01-01T00:00:00.000Z'),
          }),
      },
    });
    expect(f.saved.slice(0, 2)).toMatchObject([
      {
        component: 'postgres',
        state: 'degraded',
        reasonCode: 'collection_failed',
        checkedAt: new Date('2029-12-31T00:00:00.000Z'),
      },
      { component: 'postgres', state: 'healthy', checkedAt: at },
    ]);
  });
});
