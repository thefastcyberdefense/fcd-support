import { createHmac } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, describe, expect, test } from 'vitest';

import { createSafeLogger } from '../src/logging.js';
import { createRuntime } from '../src/runtime.js';

const apps: FastifyInstance[] = [];
const environment = {
  META_APP_SECRET: 'synthetic_app_secret_1234567890',
  META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
} as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('local runtime', () => {
  test('fails closed when no durable receipt sink has been configured', async () => {
    const runtime = createRuntime({ environment });
    apps.push(runtime.app);
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const signature = `sha256=${createHmac('sha256', environment.META_APP_SECRET)
      .update(rawBody)
      .digest('hex')}`;

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(503);
  });

  test('rejects invalid configuration before creating a server', () => {
    expect(() => createRuntime({ environment: {} })).toThrow(
      'Invalid configuration: META_APP_SECRET, META_VERIFY_TOKEN',
    );
  });

  test('handles idle database pool errors without exposing error details', () => {
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (line) => lines.push(line) });
    const pool = new pg.Pool({ max: 1 });
    const runtime = createRuntime({
      environment: {
        ...environment,
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/synthetic_database',
      },
      logger,
      poolFactory: () => pool,
    });
    apps.push(runtime.app);

    pool.emit('error', new Error('SYNTHETIC_DATABASE_DETAIL_MUST_NOT_APPEAR'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"database_pool_error"');
    expect(lines[0]).not.toContain('SYNTHETIC_DATABASE_DETAIL_MUST_NOT_APPEAR');
  });
});
