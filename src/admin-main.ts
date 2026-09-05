import { createAdminRuntime } from './admin/admin-runtime.js';
import { createSafeLogger } from './logging.js';

const logger = createSafeLogger();
try {
  const runtime = createAdminRuntime({ environment: process.env, logger });
  const shutdown = () => {
    void runtime.app.close().catch(() => {
      logger.error('admin_service_start_failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.start();
} catch {
  logger.error('admin_service_start_failed');
  process.exitCode = 1;
}
