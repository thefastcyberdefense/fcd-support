import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readHealthInput, runHealthCommand } from '../src/operations/health-main.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const evidenceLibrary = resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/');

describe('health transport held-open stdin contract', () => {
  test('consumes newline-framed JSON without waiting for stream EOF across 10 sequential frames', async () => {
    for (let i = 1; i <= 10; i++) {
      const stream = new PassThrough();
      const promise = readHealthInput(500, stream);
      stream.write(JSON.stringify({ availability: { manifest: 'healthy', iteration: i } }) + '\n');
      const result = await promise;
      expect(result).toEqual({ availability: { manifest: 'healthy', iteration: i } });
      expect(stream.destroyed).toBe(true);
    }
  });

  test('refuses malformed, oversized or stalled stdin', async () => {
    // Malformed JSON frame
    const malformed = new PassThrough();
    const malformedPromise = readHealthInput(500, malformed);
    malformed.end('{"incomplete_json\n');
    await expect(malformedPromise).rejects.toThrow();

    // Oversized input exceeding 16KB
    const oversized = new PassThrough();
    const oversizedPromise = readHealthInput(500, oversized);
    oversized.write('x'.repeat(16_385));
    await expect(oversizedPromise).rejects.toThrow('health_input_invalid');

    // Stalled / timeout input
    const stalled = new PassThrough();
    const stalledPromise = readHealthInput(50, stalled);
    await expect(stalledPromise).rejects.toThrow('health_input_invalid');
    expect(stalled.destroyed).toBe(true);
  });
});

describe('closed diagnostic classification for health transport outcomes', () => {
  const allowedClasses = [
    'completed',
    'dependency_unavailable',
    'empty',
    'carriage_return',
    'multiple_lines',
    'log_read_failed',
    'unexpected',
  ] as const;

  test.each([
    ['{"status":"completed","processed":1,"reasonCode":"ok"}', 'completed'],
    [
      '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}',
      'dependency_unavailable',
    ],
    ['', 'empty'],
    ['log_read_failed', 'log_read_failed'],
    ['valid_prefix\r', 'carriage_return'],
    ['line_one\nline_two', 'multiple_lines'],
    ['{"status":"completed","processed":99999999999999999999,"reasonCode":"ok"}', 'unexpected'],
    ['raw_customer_secret_token_12345', 'unexpected'],
  ] as const)('classifies outcome "%s" as %s without leaking body', (input, expectedClass) => {
    const result = spawnSync(
      bash,
      ['-c', `source "$TASK_LIBRARY"; synthetic_host_health_ack_diagnostic "$TASK_INPUT"`],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: evidenceLibrary,
          TASK_INPUT: input,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`synthetic_health_ack_diagnostic=${expectedClass}\n`);
    expect(result.stdout).not.toContain('raw_customer_secret_token_12345');
    expect(allowedClasses).toContain(expectedClass);
  });
});

describe('sequential health execution and bounded uncertainty stopping', () => {
  test('runs sequential health checks and stops immediately on first uncertainty without retry', async () => {
    const outcomes: string[] = [];
    const journal: string[] = [];
    let failureInjected = false;

    // Simulate up to 10 sequential health executions
    for (let iteration = 1; iteration <= 10; iteration++) {
      if (iteration === 4) {
        failureInjected = true;
      }

      const lines: string[] = [];
      const status = await runHealthCommand({
        environment: {
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
        },
        args: ['health'],
        input: {},
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        write: (line) => lines.push(line),
        journal: (line) => journal.push(line),
        ports: () => {
          if (failureInjected) {
            throw new Error('synthetic_postgres_timeout');
          }
          return {
            database: {
              read: () =>
                Promise.resolve({
                  schemaRevision: '000016',
                  gitRevision: 'a'.repeat(40),
                  backupCreatedAt: new Date('2030-01-01T00:00:00.000Z'),
                  backupVerified: true,
                  deletionCheckpointAt: new Date('2030-01-01T00:00:00.000Z'),
                  queues: [],
                }),
            },
            store: { recordHealth: () => Promise.resolve() },
            close: () => Promise.resolve(),
          };
        },
      });

      if (status !== 0) {
        outcomes.push(`iteration_${String(iteration)}_failed`);
        // Stop immediately on uncertainty; do NOT retry!
        break;
      } else {
        outcomes.push(`iteration_${String(iteration)}_passed`);
      }
    }

    // Must have stopped at iteration 4 without attempting iterations 5-10
    expect(outcomes).toEqual([
      'iteration_1_passed',
      'iteration_2_passed',
      'iteration_3_passed',
      'iteration_4_failed',
    ]);
  });
});
