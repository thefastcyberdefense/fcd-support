import pg from 'pg';
import { describe, expect, test, vi } from 'vitest';

import { runMaintenance } from '../src/operations/maintenance.js';
import { parseOperationsCommand } from '../src/operations-main.js';
import type { MaintenanceJob } from '../src/operations/operations-types.js';
import { syntheticPrivacyKeyring } from './integration/policy-fixtures.js';

describe('closed maintenance commands', () => {
  test('one-shot argument parser accepts only a closed job, opaque key and UTC time', () => {
    expect(
      parseOperationsCommand(['retention', 'RUN_TEST_slot', '2030-03-01T00:00:00.000Z']),
    ).toEqual({
      job: 'retention',
      runRef: 'RUN_TEST_slot',
      scheduledAt: new Date('2030-03-01T00:00:00.000Z'),
    });
    for (const args of [
      [],
      ['arbitrary', 'RUN_TEST_slot', '2030-03-01T00:00:00.000Z'],
      ['deletion', '../unsafe', '2030-03-01T00:00:00.000Z'],
      ['learning', 'RUN_TEST_slot', 'today'],
      ['retention', 'RUN_TEST_slot', '2030-03-01T00:00:00.000Z', 'extra'],
    ])
      expect(() => parseOperationsCommand(args)).toThrow('operations_command_invalid');
  });
  test('malformed job names fail before database access without echoing input', async () => {
    const pool = new pg.Pool();
    const connect = vi.spyOn(pool, 'connect');
    const result = await runMaintenance('synthetic_unapproved_job' as MaintenanceJob, {
      pool,
      keyring: syntheticPrivacyKeyring,
      now: () => new Date(),
      limit: 10,
      runRef: 'RUN_TEST_maintenance',
      scheduledAt: new Date(),
      learningPolicy: {
        minimumGroupCount: 3,
        digestIntervalMilliseconds: 259200000,
        maximumQuestionsPerDigest: 5,
        questionCooldownMilliseconds: 604800000,
        maximumDigestAppearances: 2,
        maximumObservationsPerRun: 1000,
      },
      outboundBounds: {
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
      },
      learningWindowMilliseconds: 86400000,
    });
    expect(result).toEqual({ status: 'failed', processed: 0, reasonCode: 'configuration_invalid' });
    expect(connect).not.toHaveBeenCalled();
    await pool.end();
  });
});
