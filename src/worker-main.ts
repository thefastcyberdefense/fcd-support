import { pathToFileURL } from 'node:url';

import { createSafeLogger } from './logging.js';
import { createReplyRuntime } from './operations/reply-runtime.js';
import { createOutboundRuntime } from './operations/outbound-runtime.js';
import { createNotificationRuntime } from './operations/notification-runtime.js';
import { writeRuntimeHeartbeat } from './operations/role-runtime.js';
import type { RuntimeLifecycle } from './operations/operations-types.js';

export async function startWorkerWithSignals(
  runtime: RuntimeLifecycle,
  signals: { once(event: 'SIGTERM' | 'SIGINT', handler: () => void): unknown },
  onStopFailure: () => void,
): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().catch(onStopFailure);
  };
  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
  await runtime.start();
}

export async function runWorkerMain(): Promise<void> {
  const logger = createSafeLogger();
  try {
    const role = process.argv[2];
    if (
      process.argv.length !== 3 ||
      (role !== 'reply' && role !== 'outbound' && role !== 'notification')
    )
      throw new Error('worker_role_invalid');
    const factory =
      role === 'reply'
        ? createReplyRuntime
        : role === 'outbound'
          ? createOutboundRuntime
          : createNotificationRuntime;
    const runtime = await factory({
      role,
      environment: process.env,
      logger,
      now: () => new Date(),
      onHeartbeat: (heartbeat) => {
        writeRuntimeHeartbeat('/run/fcd-support/heartbeat.json', heartbeat);
      },
    });
    await startWorkerWithSignals(runtime, process, () => {
      logger.error('worker_stop_failed');
      process.exitCode = 1;
    });
  } catch {
    logger.error('worker_start_failed');
    process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runWorkerMain();
