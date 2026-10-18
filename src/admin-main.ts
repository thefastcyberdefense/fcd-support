import { createAdminRoleRuntime } from './admin/admin-runtime.js';
import { createSafeLogger } from './logging.js';

const logger = createSafeLogger();
try {
  const runtime = await createAdminRoleRuntime({ environment: process.env, logger });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void runtime
      .stop()
      .then((status) => {
        if (status === 'process_exit_required') {
          logger.error('admin_service_start_failed');
          process.exit(1);
        }
      })
      .catch(() => {
        logger.error('admin_service_start_failed');
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.start();
} catch (error) {
  logger.error('admin_service_start_failed');
  if (error instanceof Error && error.message === 'admin_socket_exit_required') process.exit(1);
  process.exitCode = 1;
}
