import pg from 'pg';
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';

import { noopSafeLogger } from '../src/logging.js';
import { createOutboundRuntime } from '../src/operations/outbound-runtime.js';
import { createWorkerLoop } from '../src/operations/worker-loop.js';
import { startWorkerWithSignals } from '../src/worker-main.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

function environment() {
  const resources = JSON.parse(operationsEnvironment().OPS_RESOURCE_LIMITS_JSON) as Record<
    string,
    unknown
  >;
  return {
    ...operationsEnvironment(),
    OPS_RESOURCE_LIMITS_JSON: JSON.stringify({ ...resources, outbound: resources.reply }),
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1/fcd_support_test',
    PRIVACY_HMAC_KEYRING: JSON.stringify({
      activeVersion: 'TEST_v1',
      keys: [{ version: 'TEST_v1', keyBase64url: Buffer.alloc(32, 0x51).toString('base64url') }],
    }),
    OPS_GIT_REVISION: 'c'.repeat(40),
    OPS_SCHEMA_REVISION: '000014',
  };
}
describe('private outbound runtime', () => {
  test('SIGTERM during a call stops future batches and drains once under the configured bound', async () => {
    vi.useFakeTimers();
    try {
      const runBatch = vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
      );
      const loop = createWorkerLoop({
        runBatch,
        isReady: () => Promise.resolve(true),
        now: () => new Date(0),
        pollMilliseconds: 100,
        shutdownGraceMilliseconds: 500,
      });
      const stop = vi.fn(() => loop.stop());
      const failed = vi.fn();
      const signals = new EventEmitter();
      await startWorkerWithSignals({ start: () => loop.start(), stop }, signals, failed);
      await vi.advanceTimersByTimeAsync(0);
      signals.emit('SIGTERM');
      signals.emit('SIGINT');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      expect(stop).toHaveBeenCalledOnce();
      expect(runBatch).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  test('disabled outbound stays idle with zero claims, provider calls or credentials', async () => {
    const pool = new pg.Pool();
    const query = vi.spyOn(pool, 'query');
    const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
    const runtime = await createOutboundRuntime({
      role: 'outbound',
      environment: environment(),
      logger: noopSafeLogger,
      now: () => new Date('2030-03-01T00:00:00.000Z'),
      poolFactory: () => pool,
    });
    await runtime.start();
    await runtime.stop();
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });
  test('missing privacy keyring fails before a pool can be constructed', async () => {
    const poolFactory = vi.fn(() => new pg.Pool());
    await expect(
      createOutboundRuntime({
        role: 'outbound',
        environment: { ...environment(), PRIVACY_HMAC_KEYRING: undefined },
        logger: noopSafeLogger,
        now: () => new Date(),
        poolFactory,
      }),
    ).rejects.toThrow();
    expect(poolFactory).not.toHaveBeenCalled();
  });
});
