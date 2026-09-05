import { createHash, createHmac } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { createSafeLogger } from '../src/logging.js';
import type { NormalizedMetaEvent } from '../src/meta/normalized-event.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function sign(rawBody: Buffer | string, secret = 'test_app_secret'): string {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

async function injectMethodStatus(
  app: FastifyInstance,
  method: string,
  url: string,
): Promise<number> {
  const injectAnyMethod = app.inject.bind(app) as unknown as (options: {
    readonly method: string;
    readonly url: string;
  }) => Promise<{ readonly statusCode: number }>;
  const response = await injectAnyMethod({ method, url });
  return response.statusCode;
}

function createTestApp(options?: { readonly rejectReceipt?: boolean }): {
  readonly app: FastifyInstance;
  readonly received: NormalizedMetaEvent[][];
} {
  const received: NormalizedMetaEvent[][] = [];
  const app = buildApp({
    metaAppSecret: 'test_app_secret',
    metaVerifyToken: 'test_verify_token',
    receiptSink: (receipt) => {
      if (options?.rejectReceipt === true) {
        return Promise.reject(new Error('synthetic receipt failure'));
      }
      received.push([...receipt.events]);
      return Promise.resolve();
    },
  });
  apps.push(app);
  return { app, received };
}

describe('Meta webhook HTTP boundary', () => {
  test('returns the verification challenge for a matching GET request', async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=test_verify_token&hub.challenge=987654321',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('987654321');
  });

  test('returns 403 for an invalid verification token', async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=987654321',
    });

    expect(response.statusCode).toBe(403);
  });

  test('verifies, parses, normalizes, and submits a valid event', async () => {
    const { app, received } = createTestApp();
    const rawBody = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'PAGE_TEST',
          time: 1786400000000,
          messaging: [
            {
              sender: { id: 'PSID_TEST_http' },
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400000000,
              message: { mid: 'm_TEST_http', text: 'Synthetic support question http' },
            },
          ],
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('EVENT_RECEIVED');
    expect(received).toEqual([
      [
        {
          kind: 'customer_message',
          channel: 'messenger',
          channelAccountId: 'PAGE_TEST',
          contactId: 'PSID_TEST_http',
          externalMessageId: 'm_TEST_http',
          idempotencyKey: 'messenger:message:PAGE_TEST:m_TEST_http',
          occurredAt: new Date('2026-08-10T22:13:20.000Z'),
          text: 'Synthetic support question http',
        },
      ],
    ]);
  });

  test('rejects an invalid signature before attempting to parse JSON', async () => {
    const { app, received } = createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      payload: '{invalid json',
    });

    expect(response.statusCode).toBe(401);
    expect(received).toEqual([]);
  });

  test('rejects malformed JSON after a valid signature', async () => {
    const { app, received } = createTestApp();
    const rawBody = '{invalid json';

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(400);
    expect(received).toEqual([]);
  });

  test('rejects malformed UTF-8 after verifying its original bytes', async () => {
    const { app, received } = createTestApp();
    const rawBody = Buffer.concat([
      Buffer.from('{"message":"', 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', 'utf8'),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(400);
    expect(received).toEqual([]);
  });

  test('returns 503 when accepted work cannot reach the receipt sink', async () => {
    const { app } = createTestApp({ rejectReceipt: true });
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(503);
  });

  test('submits a payload fingerprint and receipt time to the durable sink', async () => {
    const receipts: unknown[] = [];
    const receivedAt = new Date('2026-08-11T01:00:00.000Z');
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const app = buildApp({
      metaAppSecret: 'test_app_secret',
      metaVerifyToken: 'test_verify_token',
      now: () => receivedAt,
      receiptSink: (receipt) => {
        receipts.push(receipt);
        return Promise.resolve();
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(receipts).toEqual([
      {
        events: [
          {
            kind: 'unsupported',
            channel: 'unknown',
            reasonCode: 'unsupported_meta_object',
          },
        ],
        payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
        receivedAt,
      },
    ]);
  });

  test('logs admission outcomes without secrets, signatures, or customer content', async () => {
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (line) => lines.push(line) });
    const rawBody = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'PAGE_TEST',
          messaging: [
            {
              sender: { id: 'PSID_TEST_logging' },
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400000000,
              message: {
                mid: 'm_TEST_logging',
                text: 'SYNTHETIC_CUSTOMER_CONTENT_MUST_NOT_APPEAR',
              },
            },
          ],
        },
      ],
    });
    const signature = sign(rawBody);
    const received: NormalizedMetaEvent[][] = [];
    const app = buildApp({
      logger,
      metaAppSecret: 'test_app_secret',
      metaVerifyToken: 'test_verify_token',
      receiptSink: (receipt) => {
        received.push([...receipt.events]);
        return Promise.resolve();
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"meta_webhook_accepted"');
    expect(lines[0]).toContain('"statusCode":200');
    expect(lines[0]).toContain('"eventCount":1');
    expect(lines[0]).not.toContain('SYNTHETIC_CUSTOMER_CONTENT_MUST_NOT_APPEAR');
    expect(lines[0]).not.toContain(signature);
    expect(lines[0]).not.toContain('test_app_secret');
  });

  test('rejects an oversized body before receipt', async () => {
    const { app, received } = createTestApp();
    const rawBody = JSON.stringify({ value: 'a'.repeat(256 * 1024) });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(413);
    expect(received).toEqual([]);
  });

  test.each([
    { method: 'GET' as const, url: '/health' },
    { method: 'POST' as const, url: '/webhooks/meta/extra' },
    { method: 'DELETE' as const, url: '/webhooks/meta' },
    { method: 'HEAD' as const, url: '/webhooks/meta' },
    { method: 'OPTIONS' as const, url: '/webhooks/meta' },
    { method: 'PATCH' as const, url: '/webhooks/meta' },
    { method: 'TRACE' as const, url: '/webhooks/meta' },
    { method: 'PUT' as const, url: '/webhooks/meta' },
  ])('returns 404 for $method $url', async ({ method, url }) => {
    const { app } = createTestApp();

    expect(await injectMethodStatus(app, method, url)).toBe(404);
  });

  test('marks application-generated 404s so ingress isolation can detect misrouting', async () => {
    const { app } = createTestApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-fcd-route-scope']).toBe('application');
  });

  test.each(['/admin', '/admin/knowledge', '/api/admin', '/api/admin/knowledge'])(
    'keeps private administration route %s absent from the public app',
    async (url) => {
      const { app } = createTestApp();

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);
      expect(response.headers['x-fcd-route-scope']).toBe('application');
    },
  );
});
