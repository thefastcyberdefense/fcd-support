import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { noopSafeLogger, type SafeLogger } from './logging.js';
import type { NormalizedMetaEvent } from './meta/normalized-event.js';

export interface CreateRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger?: SafeLogger;
  readonly receiptSink?: (events: readonly NormalizedMetaEvent[]) => Promise<void>;
}

export interface AppRuntime {
  readonly app: FastifyInstance;
  readonly start: () => Promise<void>;
}

function unavailableReceiptSink(): Promise<void> {
  return Promise.reject(new Error('Durable receipt sink is not configured'));
}

export function createRuntime(options: CreateRuntimeOptions): AppRuntime {
  const config = loadConfig(options.environment);
  const logger = options.logger ?? noopSafeLogger;
  const app = buildApp({
    logger,
    metaAppSecret: config.metaAppSecret,
    metaVerifyToken: config.metaVerifyToken,
    receiptSink: options.receiptSink ?? unavailableReceiptSink,
  });

  return {
    app,
    start: async () => {
      await app.listen({ host: config.host, port: config.port });
      logger.info('service_started');
    },
  };
}
