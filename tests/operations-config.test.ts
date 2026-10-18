import { describe, expect, test } from 'vitest';

import { loadOperationsConfig } from '../src/operations/operations-config.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

describe('explicit operational configuration', () => {
  test('snapshots configurable values without enabling external execution', () => {
    const config = loadOperationsConfig('webhook', operationsEnvironment());
    expect(config).toMatchObject({
      role: 'webhook',
      pollMilliseconds: 1000,
      batchSize: 10,
      leaseMilliseconds: 60000,
      shutdownGraceMilliseconds: 5000,
      dailyRetention: 45,
      monthlyRetention: 6,
      modelExecutionEnabled: false,
      outboundExecutionEnabled: false,
      n8nExecutionEnabled: false,
      resourceLimits: { webhook: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 } },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.resourceLimits.webhook)).toBe(true);
  });

  test('accepts reviewed stricter customizable operation values', () => {
    expect(
      loadOperationsConfig('backup', {
        ...operationsEnvironment(),
        OPS_POLL_MS: '2000',
        OPS_BATCH_SIZE: '3',
        BACKUP_DAILY_RETENTION: '90',
        BACKUP_MONTHLY_RETENTION: '12',
      }),
    ).toMatchObject({
      pollMilliseconds: 2000,
      batchSize: 3,
      dailyRetention: 90,
      monthlyRetention: 12,
    });
  });

  test.each([
    'OPS_POLL_MS',
    'OPS_BATCH_SIZE',
    'OPS_LEASE_MS',
    'OPS_MAX_CALL_MS',
    'OPS_SHUTDOWN_GRACE_MS',
    'OPS_STOP_GRACE_MS',
    'OPS_HEALTH_STALE_MS',
    'OPS_HOST_CPUS',
    'OPS_HOST_MEMORY_MIB',
    'OPS_RESOURCE_LIMITS_JSON',
    'OPS_RESOURCE_BOUNDS_JSON',
    'BACKUP_DAILY_RETENTION',
    'BACKUP_MONTHLY_RETENTION',
    'BACKUP_CALENDAR',
    'MAINTENANCE_CALENDAR',
    'MODEL_EXECUTION_ENABLED',
    'OUTBOUND_EXECUTION_ENABLED',
    'N8N_EXECUTION_ENABLED',
  ])('requires explicit %s', (setting) => {
    const input: Record<string, string | undefined> = { ...operationsEnvironment() };
    input[setting] = undefined;
    expect(() => loadOperationsConfig('webhook', input)).toThrow(/^configuration_invalid$/u);
  });

  test.each([
    ['BACKUP_DAILY_RETENTION', '44'],
    ['BACKUP_MONTHLY_RETENTION', '5'],
    ['BACKUP_DAILY_RETENTION', '3651'],
    ['BACKUP_MONTHLY_RETENTION', '121'],
    ['OPS_POLL_MS', '99'],
    ['OPS_POLL_MS', '60001'],
    ['OPS_BATCH_SIZE', '0'],
    ['OPS_BATCH_SIZE', '1001'],
    ['OPS_SHUTDOWN_GRACE_MS', '-1'],
    ['OPS_SHUTDOWN_GRACE_MS', '300001'],
    ['OPS_BATCH_SIZE', '1.5'],
    ['OPS_BATCH_SIZE', ''],
    ['OPS_BATCH_SIZE', 'Infinity'],
    ['OPS_HOST_CPUS', 'NaN'],
    ['MODEL_EXECUTION_ENABLED', 'yes'],
    ['N8N_EXECUTION_ENABLED', '1'],
    ['OPS_STOP_GRACE_MS', '25000'],
    ['OPS_LEASE_MS', '20000'],
    ['OPS_HEALTH_STALE_MS', '500'],
  ])('rejects invalid or inconsistent %s=%s', (setting, value) => {
    expect(() =>
      loadOperationsConfig('webhook', { ...operationsEnvironment(), [setting]: value }),
    ).toThrow(/^configuration_invalid$/u);
  });

  test.each(['$(synthetic-command)', '*-*-* 00:00:00; synthetic', '\nsynthetic', ''])(
    'rejects unsafe scheduler expressions %#',
    (calendar) => {
      expect(() =>
        loadOperationsConfig('backup', { ...operationsEnvironment(), BACKUP_CALENDAR: calendar }),
      ).toThrow(/^configuration_invalid$/u);
    },
  );

  test.each([
    { cpus: 5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
    { cpus: 0, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
    { cpus: 0.5, memoryMiB: 9000, pids: 64, tmpfsMiB: 16 },
    { cpus: 0.5, memoryMiB: 31, pids: 64, tmpfsMiB: 16 },
    { cpus: 0.5, memoryMiB: 256, pids: 1, tmpfsMiB: 16 },
    { cpus: 0.5, memoryMiB: 64, pids: 64, tmpfsMiB: 64 },
    { cpus: 0.5, memoryMiB: 256.5, pids: 64, tmpfsMiB: 16 },
  ])('rejects resource limits outside protected/host capacity %#', (limits) => {
    expect(() =>
      loadOperationsConfig('webhook', {
        ...operationsEnvironment(),
        OPS_RESOURCE_LIMITS_JSON: JSON.stringify({ webhook: limits }),
      }),
    ).toThrow(/^configuration_invalid$/u);
  });

  test('rejects missing role resources and reversed deployment floors/ceilings', () => {
    expect(() => loadOperationsConfig('admin', operationsEnvironment())).toThrow(
      'configuration_invalid',
    );
    expect(() =>
      loadOperationsConfig('webhook', {
        ...operationsEnvironment(),
        OPS_RESOURCE_BOUNDS_JSON: JSON.stringify({
          minimum: { cpus: 1, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
          maximum: { cpus: 0.5, memoryMiB: 128, pids: 32, tmpfsMiB: 8 },
        }),
      }),
    ).toThrow('configuration_invalid');
  });

  test('requires existing Manifest safety configuration when model use is enabled', () => {
    expect(() =>
      loadOperationsConfig('reply', {
        ...operationsEnvironment(),
        MODEL_EXECUTION_ENABLED: 'true',
      }),
    ).toThrow(/^configuration_invalid$/u);
  });

  test('validates resources even when other roles supplied their resources in the same file', () => {
    expect(() =>
      loadOperationsConfig('webhook', {
        ...operationsEnvironment(),
        OPS_RESOURCE_LIMITS_JSON: '{"synthetic_unknown_role":{}}',
      }),
    ).toThrow('configuration_invalid');
  });
});
