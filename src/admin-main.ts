import { createAdminRoleRuntime } from './admin/admin-runtime.js';
import { createSafeLogger } from './logging.js';

const logger = createSafeLogger();
try {
  const runtime = await createAdminRoleRuntime({ environment: process.env, logger });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
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
