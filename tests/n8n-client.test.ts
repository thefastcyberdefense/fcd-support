import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createN8nClient,
  createN8nSigningSecret,
  type N8nClientOptions,
} from '../src/notifications/n8n-client.js';
import {
  startFakeN8nServer,
  syntheticN8nSecret,
  type FakeN8nServer,
} from './helpers/fake-n8n-server.js';

const at = new Date('2030-04-01T00:00:00.000Z');
const notification = {
  schemaVersion: 1 as const,
  type: 'operator_support_escalation' as const,
  reference: 'NOTIFICATION_TEST_synthetic',
  occurredAt: at,
  idempotencyKey: 'NOTIFICATION_TEST_synthetic',
};
let fake: FakeN8nServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
function options(changes: Partial<N8nClientOptions> = {}): N8nClientOptions {
  return {
    origin: 'http://n8n:5678',
    path: '/webhook/fcd-notification',
    signingSecret: createN8nSigningSecret(syntheticN8nSecret),
    now: () => at,
    timeoutMilliseconds: 1000,
    maximumResponseBytes: 1024,
    ...changes,
  };
}
function syntheticFetch(body: string, status = 200, remoteAddress = '10.12.0.2') {
  return vi.fn(() => Promise.resolve({ response: new Response(body, { status }), remoteAddress }));
}
const resolvePrivate = () => Promise.resolve([{ address: '10.12.0.2', family: 4 as const }]);

describe('minimized signed private n8n client', () => {
  test('canonical UTF-8 envelope has only five keys and signs timestamp dot body', async () => {
    const fetch = syntheticFetch(
      JSON.stringify({ accepted: true, idempotencyKey: notification.idempotencyKey }),
    );
    const client = createN8nClient(
      options({ syntheticMode: true, fetch, resolve: resolvePrivate }),
    );
    expect(await client.send({ notification })).toEqual({ status: 'accepted', reasonCode: 'ok' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.stringify({
      schemaVersion: 1,
      type: notification.type,
      reference: notification.reference,
      occurredAt: at.toISOString(),
      idempotencyKey: notification.idempotencyKey,
    });
    expect(url).toBe('http://n8n:5678/webhook/fcd-notification');
    expect(init.body).toBe(body);
    const timestamp = String(Math.floor(at.getTime() / 1000));
    expect(new Headers(init.headers).get('x-fcd-signature')).toBe(
      `sha256=${createHmac('sha256', syntheticN8nSecret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`,
    );
    expect(new Headers(init.headers).get('x-fcd-timestamp')).toBe(timestamp);
    expect(new Headers(init.headers).get('idempotency-key')).toBe(notification.idempotencyKey);
    expect(init.redirect).toBe('error');
  });
  test('default socket transport delivers once across an acknowledgement loss', async () => {
    fake = await startFakeN8nServer({
      now: () => at,
      maximumSkewSeconds: 30,
      maximumRequestBytes: 2048,
    });
    const client = createN8nClient(options({ origin: fake.origin, syntheticMode: true }));
    fake.acceptThenDisconnect();
    expect(await client.send({ notification })).toEqual({
      status: 'retryable',
      reasonCode: 'transport_failure',
    });
    expect(await client.send({ notification })).toEqual({ status: 'accepted', reasonCode: 'ok' });
    expect(fake.acceptedNotificationCount()).toBe(1);
    expect(fake.requests.map((r) => r.outcome)).toEqual(['accepted', 'duplicate']);
  });
  test('signing secret wrapper stays redacted when serialized or inspected', () => {
    const secret = createN8nSigningSecret(syntheticN8nSecret);
    expect(JSON.stringify(secret)).not.toContain(syntheticN8nSecret);
    expect(inspect(secret)).not.toContain(syntheticN8nSecret);
    expect(String(secret)).not.toContain(syntheticN8nSecret);
  });
  test.each([
    'http://example.invalid',
    'http://10.12.0.2',
    'http://127.0.0.1',
    'http://user:synthetic@n8n:5678',
    'http://n8n:5678/other',
    'http://n8n:5678?query=1',
    'http://n8n:5678#fragment',
    'https://n8n.example.invalid',
    'http://n8n-',
  ])('rejects non-private-alias or credential-bearing origin %s', (origin) => {
    expect(() => createN8nClient(options({ origin }))).toThrow('n8n_configuration_invalid');
  });
  test.each([
    '/../secret',
    '//other/path',
    '/webhook/notification?secret=synthetic',
    '/webhook/%2fsecret',
    '/webhook/x#fragment',
  ])('rejects unsafe path %s', (path) => {
    expect(() => createN8nClient(options({ path }))).toThrow('n8n_configuration_invalid');
  });
  test('injected transports are restricted to explicit synthetic mode', () => {
    expect(() => createN8nClient(options({ fetch: syntheticFetch('{}') }))).toThrow(
      'n8n_configuration_invalid',
    );
  });
  test.each([
    '8.8.8.8',
    '169.254.1.2',
    '127.0.0.1',
    '::1',
    'fe80::1',
    '2001:db8::1',
    '::ffff:8.8.8.8',
  ])('rejects forbidden DNS destination %s without connecting', async (address) => {
    const client = createN8nClient(
      options({
        resolve: () => Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]),
      }),
    );
    expect(await client.send({ notification })).toEqual({
      status: 'terminal_failed',
      reasonCode: 'destination_rejected',
    });
  });
  test('rejects mixed private/public answers and resolves again on every attempt', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([{ address: '10.12.0.2', family: 4 }])
      .mockResolvedValueOnce([
        { address: '10.12.0.2', family: 4 },
        { address: '8.8.8.8', family: 4 },
      ]);
    const fetch = syntheticFetch(
      JSON.stringify({ accepted: true, idempotencyKey: notification.idempotencyKey }),
    );
    const client = createN8nClient(options({ syntheticMode: true, fetch, resolve }));
    expect((await client.send({ notification })).status).toBe('accepted');
    expect((await client.send({ notification })).reasonCode).toBe('destination_rejected');
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  test('rejects a socket destination that differs from the selected DNS address', async () => {
    const fetch = syntheticFetch('{}', 200, '10.12.0.3');
    const client = createN8nClient(
      options({ syntheticMode: true, fetch, resolve: resolvePrivate }),
    );
    expect(await client.send({ notification })).toEqual({
      status: 'terminal_failed',
      reasonCode: 'destination_rejected',
    });
  });
  test.each([
    '{}',
    '{',
    JSON.stringify({ accepted: true, idempotencyKey: 'NOTIFICATION_TEST_wrong' }),
    JSON.stringify({ accepted: true, idempotencyKey: notification.idempotencyKey, extra: true }),
    JSON.stringify({ accepted: 'true', idempotencyKey: notification.idempotencyKey }),
    'x'.repeat(2048),
  ])('rejects malformed, non-exact or oversized acknowledgement', async (body) => {
    const client = createN8nClient(
      options({ syntheticMode: true, fetch: syntheticFetch(body), resolve: resolvePrivate }),
    );
    expect(await client.send({ notification })).toEqual({
      status: 'retryable',
      reasonCode: 'invalid_response',
    });
  });
  test.each([
    [301, 'terminal_failed', 'destination_rejected'],
    [401, 'terminal_failed', 'authentication_failed'],
    [403, 'terminal_failed', 'authentication_failed'],
    [400, 'terminal_failed', 'invalid_response'],
    [409, 'terminal_failed', 'invalid_response'],
    [429, 'retryable', 'transport_failure'],
    [503, 'retryable', 'transport_failure'],
  ] as const)(
    'status %i is bounded and its error body is never read',
    async (status, state, reason) => {
      const response = new Response('SYNTHETIC_ERROR_MUST_NOT_BE_READ', { status });
      if (response.body === null) throw new Error('synthetic_body_missing');
      const read = vi.spyOn(response.body, 'getReader');
      const client = createN8nClient(
        options({
          syntheticMode: true,
          resolve: resolvePrivate,
          fetch: () => Promise.resolve({ response, remoteAddress: '10.12.0.2' }),
        }),
      );
      expect(await client.send({ notification })).toEqual({ status: state, reasonCode: reason });
      expect(read).not.toHaveBeenCalled();
    },
  );
  test('extra notification fields fail closed before transport', async () => {
    const fetch = syntheticFetch('{}');
    const client = createN8nClient(
      options({ syntheticMode: true, fetch, resolve: resolvePrivate }),
    );
    expect(
      (
        await client.send({
          notification: {
            ...notification,
            customerText: 'Synthetic forbidden field',
          } as typeof notification,
        })
      ).status,
    ).toBe('terminal_failed');
    expect(fetch).not.toHaveBeenCalled();
  });
  test('deadline also bounds a stalled resolver', async () => {
    const client = createN8nClient(
      options({ timeoutMilliseconds: 10, resolve: () => new Promise(() => undefined) }),
    );
    expect(await client.send({ notification })).toEqual({
      status: 'retryable',
      reasonCode: 'timeout',
    });
  });
  test('deadline bounds transport and a stalled success body', async () => {
    for (const fetch of [
      () => new Promise<never>(() => undefined),
      () =>
        Promise.resolve({
          response: new Response(
            new ReadableStream({
              start() {
                /* Synthetic stalled body. */
              },
            }),
          ),
          remoteAddress: '10.12.0.2',
        }),
    ]) {
      const client = createN8nClient(
        options({ timeoutMilliseconds: 10, syntheticMode: true, resolve: resolvePrivate, fetch }),
      );
      expect(await client.send({ notification })).toEqual({
        status: 'retryable',
        reasonCode: 'timeout',
      });
    }
  });
  test('timeout actively cancels a stalled success reader', async () => {
    const cancel = vi.fn();
    const client = createN8nClient(
      options({
        timeoutMilliseconds: 10,
        syntheticMode: true,
        resolve: resolvePrivate,
        fetch: () =>
          Promise.resolve({
            response: new Response(new ReadableStream({ cancel })),
            remoteAddress: '10.12.0.2',
          }),
      }),
    );
    expect(await client.send({ notification })).toEqual({
      status: 'retryable',
      reasonCode: 'timeout',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  test('caller cancellation returns bounded ambiguity without waiting for transport', async () => {
    const controller = new AbortController();
    const client = createN8nClient(
      options({
        syntheticMode: true,
        resolve: resolvePrivate,
        fetch: () => new Promise(() => undefined),
      }),
    );
    const pending = client.send({ notification, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: 'retryable', reasonCode: 'transport_failure' });
  });
  test('receiver rejects bad MAC, stale/future signing time, mutation and extra fields', async () => {
    fake = await startFakeN8nServer({
      now: () => at,
      maximumSkewSeconds: 30,
      maximumRequestBytes: 2048,
    });
    const body = JSON.stringify({ ...notification, occurredAt: at.toISOString() });
    for (const [offset, alter, extra] of [
      [-31, false, false],
      [31, false, false],
      [0, true, false],
      [0, false, true],
    ] as const) {
      const timestamp = String(Math.floor(at.getTime() / 1000) + offset);
      const signature = createHmac('sha256', syntheticN8nSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      const sent = extra
        ? body.slice(0, -1) + ',"extra":true}'
        : alter
          ? body.replace('support_escalation', 'outbound_escalation')
          : body;
      const response = await fetch(`${fake.origin}/webhook/fcd-notification`, {
        method: 'POST',
        body: sent,
        headers: {
          'x-fcd-timestamp': timestamp,
          'x-fcd-signature': `sha256=${signature}`,
          'idempotency-key': notification.idempotencyKey,
        },
      });
      expect(response.status).toBe(401);
    }
    const timestamp = String(Math.floor(at.getTime() / 1000));
    const withExtra = body.slice(0, -1) + ',"extra":true}';
    const response = await fetch(`${fake.origin}/webhook/fcd-notification`, {
      method: 'POST',
      body: withExtra,
      headers: {
        'x-fcd-timestamp': timestamp,
        'x-fcd-signature': `sha256=${createHmac('sha256', syntheticN8nSecret).update(`${timestamp}.${withExtra}`).digest('hex')}`,
        'idempotency-key': notification.idempotencyKey,
      },
    });
    expect(response.status).toBe(400);
    expect(fake.acceptedNotificationCount()).toBe(0);
  });
});
