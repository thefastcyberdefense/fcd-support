import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createSafeLogger } from '../src/logging.js';
import { loadOutboundConfig } from '../src/outbound/outbound-config.js';
import { MetaOutboundClient } from '../src/outbound/meta-outbound-client.js';
import {
  buildMessengerTextRequest,
  buildWhatsAppFixedTemplateRequest,
  buildWhatsAppTextRequest,
  type PreparedOutboundRequest,
} from '../src/outbound/outbound-request.js';
import { startFakeMetaServer, type FakeMetaServer } from './helpers/fake-meta-server.js';

const whatsappCredential = 'SYNTHETIC_WHATSAPP_CREDENTIAL_NOT_OPERATIONAL';
const messengerCredential = 'SYNTHETIC_PAGE_CREDENTIAL_NOT_OPERATIONAL';
const whatsappAccount = 'PHONE_TEST_meta_client';
const messengerAccount = 'PAGE_TEST_meta_client';
const recipient = 'RECIPIENT_TEST_meta_client';

function environment(baseUrl: string, maximumResponseBytes = 65_536) {
  return {
    META_GRAPH_API_VERSION: 'v25.0',
    META_MESSENGER_PAGE_ID: messengerAccount,
    META_PAGE_ACCESS_TOKEN: messengerCredential,
    META_WHATSAPP_ACCESS_TOKEN: whatsappCredential,
    META_WHATSAPP_PHONE_NUMBER_ID: whatsappAccount,
    OUTBOUND_ALLOW_LOOPBACK_FAKE: 'true',
    OUTBOUND_MAX_DEFINITE_RETRIES: '3',
    OUTBOUND_MAX_GLOBAL_1_MINUTE: '150',
    OUTBOUND_MAX_GLOBAL_UTC_DAY: '1000',
    OUTBOUND_MAX_LEASE_MS: '30000',
    OUTBOUND_MAX_MESSENGER_ACCOUNT_1_MINUTE: '100',
    OUTBOUND_MAX_PER_CONTACT_15_MINUTE: '4',
    OUTBOUND_MAX_PER_CONTACT_24_HOUR: '40',
    OUTBOUND_MAX_PROVIDER_TIMEOUT_MS: '10000',
    OUTBOUND_MAX_RESPONSE_BYTES: String(maximumResponseBytes),
    OUTBOUND_MAX_WHATSAPP_ACCOUNT_1_MINUTE: '100',
    OUTBOUND_MAX_WORKER_BATCH_SIZE: '20',
    OUTBOUND_META_BASE_URL: baseUrl,
    OUTBOUND_MIN_RETRY_BASE_MS: '1000',
    OUTBOUND_MIN_RETRY_MAXIMUM_MS: '60000',
  } as const;
}

function whatsappRequest(
  options: {
    readonly accountId?: string;
    readonly maximumResponseBytes?: number;
    readonly providerTimeoutMs?: number;
    readonly text?: string;
  } = {},
): PreparedOutboundRequest {
  return buildWhatsAppTextRequest({
    attemptRef: 'ATTEMPT_TEST_meta_client_whatsapp',
    channelAccountId: options.accountId ?? whatsappAccount,
    intentRef: 'INTENT_TEST_meta_client_whatsapp',
    maximumResponseBytes: options.maximumResponseBytes ?? 4096,
    providerTimeoutMs: options.providerTimeoutMs ?? 5000,
    recipient,
    text: options.text ?? 'Synthetic reviewed WhatsApp response.',
  });
}

function messengerRequest(): PreparedOutboundRequest {
  return buildMessengerTextRequest({
    attemptRef: 'ATTEMPT_TEST_meta_client_messenger',
    channelAccountId: messengerAccount,
    intentRef: 'INTENT_TEST_meta_client_messenger',
    maximumResponseBytes: 4096,
    providerTimeoutMs: 5000,
    recipient,
    text: 'Synthetic reviewed Messenger response.',
  });
}

function whatsappSuccess(providerMessageId = 'META_MESSAGE_TEST_whatsapp'): string {
  return JSON.stringify({
    contacts: [{ input: recipient, wa_id: recipient }],
    messages: [{ id: providerMessageId }],
    messaging_product: 'whatsapp',
  });
}

function messengerSuccess(providerMessageId = 'META_MESSAGE_TEST_messenger'): string {
  return JSON.stringify({ message_id: providerMessageId, recipient_id: recipient });
}

function paddedJson(body: string, targetBytes: number): string {
  const length = Buffer.byteLength(body);
  if (length > targetBytes) throw new Error('Synthetic JSON exceeds requested padding target');
  return `${body}${' '.repeat(targetBytes - length)}`;
}

describe('fail-closed Meta outbound client', () => {
  let server: FakeMetaServer;

  beforeAll(async () => {
    server = await startFakeMetaServer();
  });

  beforeEach(() => {
    server.reset();
  });

  afterAll(async () => {
    await server.close();
  });

  function client(
    overrides: Partial<ConstructorParameters<typeof MetaOutboundClient>[0]> = {},
    maximumResponseBytes = 65_536,
  ) {
    return new MetaOutboundClient({
      config: loadOutboundConfig(environment(server.baseUrl, maximumResponseBytes)),
      ...overrides,
    });
  }

  test('posts one exact WhatsApp v25.0 request and accepts one provider ID', async () => {
    server.enqueueResponse({
      body: whatsappSuccess(),
      outcome: 'accepted',
      statusCode: 200,
    });

    await expect(client().send({ request: whatsappRequest() })).resolves.toEqual({
      providerMessageId: 'META_MESSAGE_TEST_whatsapp',
      status: 'accepted',
    });
    expect(server.callCount).toBe(1);
    expect(server.requests[0]).toEqual({
      authorizationPresent: true,
      authorizationWasSynthetic: true,
      contentTypeJson: true,
      forbiddenFieldPresent: false,
      messengerTextShape: false,
      method: 'POST',
      path: '/v25.0/PHONE_TEST_meta_client/messages',
      requestBodyBytes: server.requests[0]?.requestBodyBytes,
      responseOutcome: 'accepted',
      whatsappTemplateShape: false,
      whatsappTextShape: true,
    });
    expect(server.requests[0]?.requestBodyBytes).toBeGreaterThan(0);
  });

  test('posts one exact Messenger RESPONSE request and accepts one provider ID', async () => {
    server.enqueueResponse({
      body: messengerSuccess(),
      outcome: 'accepted',
      statusCode: 200,
    });

    await expect(client().send({ request: messengerRequest() })).resolves.toEqual({
      providerMessageId: 'META_MESSAGE_TEST_messenger',
      status: 'accepted',
    });
    expect(server.requests[0]).toMatchObject({
      authorizationPresent: true,
      authorizationWasSynthetic: true,
      forbiddenFieldPresent: false,
      messengerTextShape: true,
      method: 'POST',
      path: '/v25.0/PAGE_TEST_meta_client/messages',
      whatsappTemplateShape: false,
      whatsappTextShape: false,
    });
  });

  test('sends a fixed WhatsApp template with no components', async () => {
    server.enqueueResponse({
      body: whatsappSuccess('META_MESSAGE_TEST_template'),
      outcome: 'accepted',
      statusCode: 200,
    });
    const request = buildWhatsAppFixedTemplateRequest({
      attemptRef: 'ATTEMPT_TEST_meta_client_template',
      channelAccountId: whatsappAccount,
      intentRef: 'INTENT_TEST_meta_client_template',
      locale: 'bn_BD',
      maximumResponseBytes: 4096,
      providerTimeoutMs: 5000,
      recipient,
      templateName: 'synthetic_reviewed_notice',
    });

    await expect(client().send({ request })).resolves.toEqual({
      providerMessageId: 'META_MESSAGE_TEST_template',
      status: 'accepted',
    });
    expect(server.requests[0]).toMatchObject({
      forbiddenFieldPresent: false,
      whatsappTemplateShape: true,
    });
  });

  test('rejects forged or cross-account requests before any HTTP call', async () => {
    const forged = { ...whatsappRequest() } as PreparedOutboundRequest;

    await expect(client().send({ request: forged })).resolves.toEqual({
      status: 'aborted_before_dispatch',
    });
    await expect(
      client().send({ request: whatsappRequest({ accountId: 'PHONE_TEST_wrong_account' }) }),
    ).resolves.toEqual({ status: 'aborted_before_dispatch' });
    expect(server.callCount).toBe(0);
  });

  test.each([
    ['not-json'],
    [JSON.stringify({ messaging_product: 'whatsapp', messages: [] })],
    [
      JSON.stringify({
        messaging_product: 'whatsapp',
        messages: [{ id: 'META_MESSAGE_TEST_one' }, { id: 'META_MESSAGE_TEST_two' }],
      }),
    ],
    [JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'invalid id' }] })],
    [
      JSON.stringify({
        extra: true,
        messaging_product: 'whatsapp',
        messages: [{ id: 'META_MESSAGE_TEST_extra' }],
      }),
    ],
  ])(
    'maps malformed, missing, duplicate, or invalid WhatsApp success data to unknown',
    async (body) => {
      server.enqueueResponse({ body, outcome: 'unknown', statusCode: 200 });

      await expect(client().send({ request: whatsappRequest() })).resolves.toEqual({
        reasonCode: 'invalid_response',
        status: 'delivery_unknown',
      });
    },
  );

  test.each([
    [JSON.stringify({ recipient_id: recipient })],
    [JSON.stringify({ message_id: 'invalid id', recipient_id: recipient })],
    [
      JSON.stringify({
        extra: true,
        message_id: 'META_MESSAGE_TEST_extra',
        recipient_id: recipient,
      }),
    ],
  ])('strictly validates Messenger success data', async (body) => {
    server.enqueueResponse({ body, outcome: 'unknown', statusCode: 200 });

    await expect(client().send({ request: messengerRequest() })).resolves.toEqual({
      reasonCode: 'invalid_response',
      status: 'delivery_unknown',
    });
  });

  test('accepts the exact response-byte ceiling and rejects one byte over it', async () => {
    const exact = paddedJson(whatsappSuccess('META_MESSAGE_TEST_exact_bytes'), 1024);
    server.enqueueResponse({ body: exact, outcome: 'accepted', statusCode: 200 });
    server.enqueueResponse({ body: `${exact} `, outcome: 'unknown', statusCode: 200 });
    const request = whatsappRequest({ maximumResponseBytes: 1024 });

    await expect(client({}, 1024).send({ request })).resolves.toEqual({
      providerMessageId: 'META_MESSAGE_TEST_exact_bytes',
      status: 'accepted',
    });
    await expect(client({}, 1024).send({ request })).resolves.toEqual({
      reasonCode: 'oversized_response',
      status: 'delivery_unknown',
    });
    expect(server.callCount).toBe(2);
  });

  test('maps reviewed 400 and 429 outcomes without reading or returning their bodies', async () => {
    const sensitiveBody = 'SYNTHETIC_PROVIDER_DETAIL_MUST_NOT_APPEAR';
    server.enqueueResponse({
      body: sensitiveBody,
      outcome: 'definite_rejection',
      statusCode: 400,
    });
    server.enqueueResponse({
      body: sensitiveBody,
      headers: { 'retry-after': '5' },
      outcome: 'definite_rejection',
      statusCode: 429,
    });
    const now = new Date('2026-09-17T00:00:00.000Z');
    const outbound = client({ now: () => now });

    await expect(outbound.send({ request: whatsappRequest() })).resolves.toEqual({
      reasonCode: 'provider_rejected',
      retryAfter: undefined,
      status: 'definitely_rejected',
    });
    await expect(outbound.send({ request: whatsappRequest() })).resolves.toEqual({
      reasonCode: 'rate_limited',
      retryAfter: new Date('2026-09-17T00:00:05.000Z'),
      status: 'definitely_rejected',
    });
  });

  test('does not consume a non-success response body', async () => {
    let canceled = false;
    const response = {
      body: {
        cancel() {
          canceled = true;
          return Promise.resolve();
        },
      },
      headers: new Headers(),
      ok: false,
      status: 400,
    } as unknown as Response;
    const fetchCall = vi.fn(() => Promise.resolve(response));

    await expect(
      client({ fetch: fetchCall }).send({ request: whatsappRequest() }),
    ).resolves.toEqual({
      reasonCode: 'provider_rejected',
      retryAfter: undefined,
      status: 'definitely_rejected',
    });
    expect(canceled).toBe(true);
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('maps 500 to unknown and never retries', async () => {
    server.enqueueResponse({ body: 'synthetic ignored', outcome: 'unknown', statusCode: 500 });

    await expect(client().send({ request: whatsappRequest() })).resolves.toEqual({
      reasonCode: 'invalid_response',
      status: 'delivery_unknown',
    });
    expect(server.callCount).toBe(1);
  });

  test('times out one attempt even when an injected transport ignores abort', async () => {
    const fetchCall = vi.fn(() => new Promise<Response>(() => undefined));

    await expect(
      client({
        fetch: fetchCall,
        schedule: (callback) => {
          callback();
          return { cancel: () => undefined };
        },
      }).send({ request: whatsappRequest() }),
    ).resolves.toEqual({ reasonCode: 'timeout', status: 'delivery_unknown' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('returns aborted-before-dispatch for a caller signal already canceled', async () => {
    const fetchCall = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client({ fetch: fetchCall }).send({ request: whatsappRequest(), signal: controller.signal }),
    ).resolves.toEqual({ status: 'aborted_before_dispatch' });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  test('treats caller cancellation after HTTP starts as unknown and never retries', async () => {
    const controller = new AbortController();
    const fetchCall = vi.fn((_url: string, init: RequestInit) => {
      controller.abort();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Synthetic abort', 'AbortError'));
        });
      });
    });

    await expect(
      client({ fetch: fetchCall }).send({ request: whatsappRequest(), signal: controller.signal }),
    ).resolves.toEqual({ reasonCode: 'network_failure', status: 'delivery_unknown' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('maps a loopback connect failure to unknown without retry', async () => {
    const disconnected = new MetaOutboundClient({
      config: loadOutboundConfig(environment('http://127.0.0.1:1')),
    });

    await expect(disconnected.send({ request: whatsappRequest() })).resolves.toEqual({
      reasonCode: 'network_failure',
      status: 'delivery_unknown',
    });
  });

  test('rejects redirects without following the target', async () => {
    server.enqueueResponse({
      body: '',
      headers: { location: 'http://127.0.0.1:9/forbidden-target' },
      outcome: 'redirect',
      statusCode: 302,
    });

    await expect(client().send({ request: whatsappRequest() })).resolves.toEqual({
      reasonCode: 'redirect',
      status: 'delivery_unknown',
    });
    expect(server.callCount).toBe(1);
  });

  test('writes only closed log fields and never provider/customer/credential detail', async () => {
    const lines: string[] = [];
    const privateText = 'SYNTHETIC_PRIVATE_OUTBOUND_CONTENT';
    const providerDetail = 'SYNTHETIC_PROVIDER_PRIVATE_DETAIL';
    server.enqueueResponse({
      body: whatsappSuccess('META_MESSAGE_TEST_private_provider_id'),
      outcome: 'accepted',
      statusCode: 200,
    });
    server.enqueueResponse({ body: providerDetail, outcome: 'unknown', statusCode: 500 });
    const outbound = client({ logger: createSafeLogger({ write: (line) => lines.push(line) }) });

    await outbound.send({ request: whatsappRequest({ text: privateText }) });
    await outbound.send({ request: whatsappRequest({ text: privateText }) });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      channel: 'whatsapp',
      event: 'meta_outbound_completed',
      statusCode: 200,
    });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
      channel: 'whatsapp',
      event: 'meta_outbound_failed',
      reason: 'invalid_body',
      statusCode: 500,
    });
    const visible = lines.join(' ');
    for (const hidden of [
      privateText,
      providerDetail,
      recipient,
      whatsappCredential,
      messengerCredential,
      'META_MESSAGE_TEST_private_provider_id',
      server.baseUrl,
    ]) {
      expect(visible).not.toContain(hidden);
    }
  });

  test('fake server refuses non-loopback bind and non-synthetic authorization', async () => {
    await expect(startFakeMetaServer({ host: '0.0.0.0' })).rejects.toThrow('requires loopback');
    const response = await fetch(`${server.baseUrl}/v25.0/${whatsappAccount}/messages`, {
      body: '{}',
      headers: { authorization: 'Bearer forbidden-real-looking-value' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(server.callCount).toBe(0);
  });
});
