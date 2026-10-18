import type { RuntimeLifecycle } from './operations-types.js';
import type { RuntimeHeartbeat } from './runtime-readiness.js';

export interface WorkerLoopOptions {
  readonly runBatch: (signal: AbortSignal) => Promise<void>;
  readonly isReady: () => Promise<boolean>;
  readonly pollMilliseconds: number;
  readonly shutdownGraceMilliseconds: number;
  readonly now: () => Date;
  readonly onHeartbeat?: (heartbeat: RuntimeHeartbeat) => void;
}

export function createWorkerLoop(options: WorkerLoopOptions): RuntimeLifecycle {
  if (
    !Number.isSafeInteger(options.pollMilliseconds) ||
    options.pollMilliseconds < 1 ||
    options.pollMilliseconds > 60000 ||
    !Number.isSafeInteger(options.shutdownGraceMilliseconds) ||
    options.shutdownGraceMilliseconds < 0 ||
    options.shutdownGraceMilliseconds > 300000
  ) {
    throw new TypeError('worker_configuration_invalid');
  }
  const controller = new AbortController();
  let started = false;
  let stopping = false;
  const isStopping = (): boolean => stopping;
  let running: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  let wakePoll: (() => void) | undefined;

  function heartbeat(state: RuntimeHeartbeat['state']): void {
    try {
      options.onHeartbeat?.(Object.freeze({ state, checkedAt: options.now().toISOString() }));
    } catch {
      /* A failed heartbeat cannot publish sensitive error details. */
    }
  }
  async function poll(): Promise<void> {
    while (!isStopping()) {
      try {
        const ready = await options.isReady();
        if (isStopping()) break;
        heartbeat(ready ? 'healthy' : 'unavailable');
        if (ready) {
          await options.runBatch(controller.signal);
          if (!isStopping()) heartbeat('healthy');
        }
      } catch {
        if (!isStopping()) heartbeat('degraded');
      }
      if (isStopping()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, options.pollMilliseconds);
        function done(): void {
          clearTimeout(timer);
          wakePoll = undefined;
          resolve();
        }
        wakePoll = done;
      });
    }
  }

  return Object.freeze({
    start: () => {
      if (stopping) return Promise.reject(new Error('worker_stopped'));
      if (started) return Promise.resolve();
      started = true;
      running = poll();
      return Promise.resolve();
    },
    stop: () => {
      if (stopped !== undefined) return stopped;
      stopping = true;
      wakePoll?.();
      heartbeat('unknown');
      stopped = (async () => {
        if (running !== undefined) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              running,
              new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  controller.abort();
                  resolve();
                }, options.shutdownGraceMilliseconds);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        controller.abort();
        heartbeat('disabled');
      })();
      return stopped;
    },
  });
}
