import { createHmac } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

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
});
