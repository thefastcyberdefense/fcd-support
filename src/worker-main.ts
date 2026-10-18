import { pathToFileURL } from 'node:url';

import { createSafeLogger } from './logging.js';
import { createReplyRuntime } from './operations/reply-runtime.js';
import { writeRuntimeHeartbeat } from './operations/role-runtime.js';

export async function runWorkerMain(): Promise<void> {
  const logger = createSafeLogger();
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'reply')
      throw new Error('worker_role_invalid');
    const runtime = await createReplyRuntime({
      role: 'reply',
      environment: process.env,
      logger,
      now: () => new Date(),
      onHeartbeat: (heartbeat) => {
        writeRuntimeHeartbeat('/run/fcd-support/heartbeat.json', heartbeat);
      },
    });
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void runtime.stop().catch(() => {
        logger.error('worker_stop_failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await runtime.start();
  } catch {
    logger.error('worker_start_failed');
    process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runWorkerMain();
