import { createSafeLogger } from './logging.js';
import { createRuntime } from './runtime.js';

const logger = createSafeLogger();

try {
  const runtime = createRuntime({ environment: process.env, logger });
  await runtime.start();
} catch {
  logger.error('service_start_failed');
  process.exitCode = 1;
}
