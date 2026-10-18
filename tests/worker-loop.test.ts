import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createWorkerLoop } from '../src/operations/worker-loop.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const defaults = () => ({
  runBatch: vi.fn<(signal: AbortSignal) => Promise<void>>(() => Promise.resolve()),
  isReady: vi.fn(() => Promise.resolve(true)),
  pollMilliseconds: 100,
  shutdownGraceMilliseconds: 500,
  now: () => new Date(0),
});

describe('bounded worker lifecycle', () => {
  test('full call-plus-grace drain budget may exceed the separate grace setting ceiling', async () => {
    const loop = createWorkerLoop({ ...defaults(), shutdownGraceMilliseconds: 500000 });
    await loop.stop();
  });
  test('heartbeat exposes only closed states and supplied clock; observer errors do not stop polling', async () => {
    const options = defaults();
    const heartbeat = vi.fn(() => {
      throw new Error('synthetic_heartbeat_details');
    });
    const loop = createWorkerLoop({ ...options, onHeartbeat: heartbeat });
    await loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(options.runBatch).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledWith({
      state: 'healthy',
      checkedAt: '1970-01-01T00:00:00.000Z',
    });
    await loop.stop();
    expect(heartbeat).toHaveBeenLastCalledWith({
      state: 'disabled',
      checkedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  test('stop before start is safe and never creates a batch', async () => {
    const options = defaults();
    const loop = createWorkerLoop(options);
    await loop.stop();
    await loop.stop();
    await expect(loop.start()).rejects.toThrow('worker_stopped');
    expect(options.runBatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stop prevents new batches and aborts after supplied grace', async () => {
    let calls = 0;
    let signalSeen: AbortSignal | undefined;
    const loop = createWorkerLoop({
      ...defaults(),
      runBatch: async (signal) => {
        calls++;
        signalSeen = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    await loop.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(499);
    expect(signalSeen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(signalSeen?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
  });

  test('never overlaps batches and drains a completed batch without waiting for grace', async () => {
    let complete: (() => void) | undefined;
    const batch = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const loop = createWorkerLoop({ ...defaults(), runBatch: batch });
    await loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(batch).toHaveBeenCalledTimes(1);
    const stopped = loop.stop();
    complete?.();
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  test.each(['batch', 'readiness'] as const)(
    'stop is bounded even when %s ignores cancellation forever',
    async (kind) => {
      const never = async () => new Promise<never>(() => undefined);
      const loop = createWorkerLoop({
        ...defaults(),
        ...(kind === 'batch' ? { runBatch: never } : { isReady: never }),
      });
      await loop.start();
      await vi.advanceTimersByTimeAsync(0);
      const stopped = loop.stop();
      await vi.advanceTimersByTimeAsync(500);
      await stopped;
      expect(vi.getTimerCount()).toBe(0);
      await expect(loop.start()).rejects.toThrow('worker_stopped');
    },
  );

  test('readiness failure or pool outage prevents claims and recovers on a later poll', async () => {
    const options = defaults();
    options.isReady
      .mockRejectedValueOnce(new Error('synthetic_database_details'))
      .mockResolvedValueOnce(false);
    const loop = createWorkerLoop(options);
    await loop.start();
    await vi.advanceTimersByTimeAsync(199);
    expect(options.runBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(options.runBatch).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  test('start and stop are idempotent and batch rejection cannot leak an unhandled error', async () => {
    const options = defaults();
    options.runBatch.mockRejectedValueOnce(new Error('synthetic_batch_details'));
    const loop = createWorkerLoop(options);
    await Promise.all([loop.start(), loop.start()]);
    await vi.advanceTimersByTimeAsync(100);
    expect(options.runBatch).toHaveBeenCalledTimes(2);
    await Promise.all([loop.stop(), loop.stop()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stop during readiness prevents a later readiness result from starting a batch', async () => {
    const options = defaults();
    let ready: ((value: boolean) => void) | undefined;
    options.isReady.mockImplementation(
      async () =>
        new Promise<boolean>((resolve) => {
          ready = resolve;
        }),
    );
    const loop = createWorkerLoop(options);
    await loop.start();
    const stopped = loop.stop();
    ready?.(true);
    await stopped;
    expect(options.runBatch).not.toHaveBeenCalled();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'invalid poll bound %s is rejected',
    (pollMilliseconds) => {
      expect(() => createWorkerLoop({ ...defaults(), pollMilliseconds })).toThrow(
        'worker_configuration_invalid',
      );
    },
  );
});
