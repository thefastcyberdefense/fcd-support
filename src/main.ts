import { createSafeLogger } from './logging.js';
import { createWebhookRuntime } from './runtime.js';

const logger = createSafeLogger();

try {
  const runtime = await createWebhookRuntime({ environment: process.env, logger });
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.app.close().catch(() => {
      logger.error('service_start_failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await runtime.start();
} catch {
  logger.error('service_start_failed');
  process.exitCode = 1;
}
