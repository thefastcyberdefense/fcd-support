import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createSafeLogger } from '../src/logging.js';
import { createManifestClient } from '../src/model/manifest-client.js';
import { buildManifestRequest, prepareManifestText } from '../src/model/manifest-request.js';
import { inspectSensitiveText } from '../src/safety/sensitive-data-gate.js';
import {
  startFakeManifestServer,
  type FakeManifestServer,
} from './helpers/fake-manifest-server.js';

const syntheticApiKey = 'SYNTHETIC_MANIFEST_CREDENTIAL_NOT_OPERATIONAL';
const sensitiveValue = '123456';

function prepared(text: string) {
  return prepareManifestText(inspectSensitiveText(text, 'en', { maximumInputCodePoints: 4000 }));
}

function request() {
  return buildManifestRequest({
    currentRequest: prepared(`How much is the reviewed plan? OTP: ${sensitiveValue}`),
    language: 'en',
    limits: {
      maximumContextItems: 4,
      maximumInputCodePoints: 2000,
      maximumOutputTokens: 300,
    },
    publishedKnowledge: [
      {
        approvedUrls: [],
        fact: prepared('The reviewed synthetic plan costs 100 BDT.'),
        reference: 'VERSION_TEST_manifest_plan',
      },
    ],
    recentContext: [],
  });
}

function assistantContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answer: 'The reviewed synthetic plan costs 100 BDT.',
    decision: 'answer',
    knowledgeReferences: ['VERSION_TEST_manifest_plan'],
    language: 'en',
    needsHumanReview: false,
    reasonCode: 'published_knowledge_answer',
    ...overrides,
  });
}

function completionBody(content = assistantContent()): string {
  return JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content, role: 'assistant' } }],
  });
}

describe('tool-free Manifest HTTP client', () => {
  let server: FakeManifestServer;

  beforeAll(async () => {
    server = await startFakeManifestServer();
  });

  beforeEach(() => {
    server.reset();
  });

  afterAll(async () => {
    await server.close();
  });

  function client(overrides: Partial<Parameters<typeof createManifestClient>[0]> = {}) {
    return createManifestClient({
      apiKey: syntheticApiKey,
      baseUrl: server.baseUrl,
      maximumResponseBytes: 4096,
      totalTimeoutMs: 5000,
      ...overrides,
    });
  }

  test('sends one sanitized auto request with no tools and validates the grounded response', async () => {
    server.enqueueResponse({ body: completionBody(), statusCode: 200 });

    const result = await client().complete({
      logicalRequestId: 'VERSION_TEST_request_1',
      request: request(),
    });

    expect(result).toEqual({
      status: 'completed',
      value: {
        answer: 'The reviewed synthetic plan costs 100 BDT.',
        decision: 'answer',
        knowledgeReferences: ['VERSION_TEST_manifest_plan'],
        language: 'en',
        needsHumanReview: false,
        reasonCode: 'published_knowledge_answer',
      },
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      authorizationPresent: true,
      authorizationWasSynthetic: true,
      contentType: 'application/json',
      forbiddenFieldPresent: false,
      maxTokens: 300,
      messageCount: 2,
      method: 'POST',
      model: 'auto',
      path: '/v1/chat/completions',
      redactionMarkerPresent: true,
      sensitiveShapePresent: false,
      stream: false,
      topLevelKeys: ['max_tokens', 'messages', 'model', 'stream'],
    });
    expect(server.requests[0]?.requestBodyBytes).toBeGreaterThan(0);
    expect(JSON.stringify(server.requests)).not.toContain(sensitiveValue);
    expect(Object.keys(server.requests[0] ?? {})).not.toContain('authorization');
  });

  test.each([
    [429, 'provider_exhausted'],
    [503, 'non_2xx'],
  ] as const)(
    'maps HTTP %s without retaining its response body',
    async (statusCode, reasonCode) => {
      const lines: string[] = [];
      const sensitiveError = 'SYNTHETIC_ERROR_BODY_MUST_NOT_APPEAR';
      server.enqueueResponse({ body: sensitiveError, statusCode });

      const result = await client({
        logger: createSafeLogger({ write: (line) => lines.push(line) }),
      }).complete({ logicalRequestId: 'VERSION_TEST_http_failure', request: request() });

      expect(result).toEqual({ status: 'failed', reasonCode });
      expect(server.requests).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(sensitiveError);
      expect(lines[0]).not.toContain(syntheticApiKey);
    },
  );

  test('rejects oversized response bytes before JSON parsing', async () => {
    server.enqueueResponse({ body: 'x'.repeat(5000), statusCode: 200 });

    await expect(
      client({ maximumResponseBytes: 128 }).complete({
        logicalRequestId: 'VERSION_TEST_oversized',
        request: request(),
      }),
    ).resolves.toEqual({ status: 'failed', reasonCode: 'oversized_body' });
  });

  test.each([
    ['not-json', 'malformed_body'],
    [JSON.stringify({ choices: [] }), 'malformed_body'],
    [
      completionBody(assistantContent({ answer: 'Unsupported synthetic refund.' })),
      'invalid_envelope',
    ],
  ] as const)('fails closed for malformed or invalid response data', async (body, reasonCode) => {
    server.enqueueResponse({ body, statusCode: 200 });

    await expect(
      client().complete({ logicalRequestId: 'VERSION_TEST_invalid', request: request() }),
    ).resolves.toEqual({ status: 'failed', reasonCode });
  });

  test('times out one attempt without retrying', async () => {
    const fetchCall = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      if (init.signal?.aborted === true) {
        throw new DOMException('Synthetic abort', 'AbortError');
      }
      await new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Synthetic abort', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });

    const result = await client({
      fetch: fetchCall,
      schedule: (callback) => {
        callback();
        return { cancel: () => undefined };
      },
    }).complete({ logicalRequestId: 'VERSION_TEST_timeout', request: request() });

    expect(result).toEqual({ status: 'failed', reasonCode: 'timeout' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('does not accept a late response after the total timeout fires', async () => {
    const fetchCall = vi.fn(() => Promise.resolve(new Response(completionBody())));

    const result = await client({
      fetch: fetchCall,
      schedule: (callback) => {
        callback();
        return { cancel: () => undefined };
      },
    }).complete({ logicalRequestId: 'VERSION_TEST_late_timeout', request: request() });

    expect(result).toEqual({ status: 'failed', reasonCode: 'timeout' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('total timeout settles even when an injected transport ignores abort', async () => {
    const fetchCall = vi.fn(() => new Promise<Response>(() => undefined));

    const result = await client({
      fetch: fetchCall,
      schedule: (callback) => {
        callback();
        return { cancel: () => undefined };
      },
    }).complete({ logicalRequestId: 'VERSION_TEST_ignored_abort', request: request() });

    expect(result).toEqual({ status: 'failed', reasonCode: 'timeout' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('does not accept a response after caller cancellation', async () => {
    const abortController = new AbortController();
    const fetchCall = vi.fn(() => {
      abortController.abort();
      return Promise.resolve(new Response(completionBody()));
    });

    const result = await client({ fetch: fetchCall }).complete({
      logicalRequestId: 'VERSION_TEST_late_abort',
      request: request(),
      signal: abortController.signal,
    });

    expect(result).toEqual({ status: 'failed', reasonCode: 'aborted' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  test('honors caller cancellation before any network request', async () => {
    const fetchCall = vi.fn<typeof fetch>();
    const abortController = new AbortController();
    abortController.abort();

    const result = await client({ fetch: fetchCall }).complete({
      logicalRequestId: 'VERSION_TEST_aborted',
      request: request(),
      signal: abortController.signal,
    });

    expect(result).toEqual({ status: 'failed', reasonCode: 'aborted' });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  test('drops network exception details from the closed result and logs', async () => {
    const lines: string[] = [];
    const sensitiveError = 'SYNTHETIC_NETWORK_DETAIL_MUST_NOT_APPEAR';
    const fetchCall = vi.fn((): Promise<Response> => Promise.reject(new Error(sensitiveError)));

    const result = await client({
      fetch: fetchCall,
      logger: createSafeLogger({ write: (line) => lines.push(line) }),
    }).complete({ logicalRequestId: 'VERSION_TEST_network', request: request() });

    expect(result).toEqual({ status: 'failed', reasonCode: 'network_failure' });
    expect(fetchCall).toHaveBeenCalledTimes(1);
    expect(lines.join('')).not.toContain(sensitiveError);
  });

  test('does not follow a redirect to another host', async () => {
    server.enqueueResponse({
      body: '',
      headers: { location: 'http://127.0.0.1:9/other' },
      statusCode: 302,
    });

    const result = await client().complete({
      logicalRequestId: 'VERSION_TEST_redirect',
      request: request(),
    });

    expect(result).toEqual({ status: 'failed', reasonCode: 'network_failure' });
    expect(server.requests).toHaveLength(1);
  });

  test('rejects a response envelope containing a tool call despite valid text', async () => {
    server.enqueueResponse({
      body: JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: assistantContent(),
              role: 'assistant',
              tool_calls: [{ function: { name: 'forbidden' } }],
            },
          },
        ],
      }),
      statusCode: 200,
    });

    await expect(
      client().complete({ logicalRequestId: 'VERSION_TEST_tool_response', request: request() }),
    ).resolves.toEqual({ status: 'failed', reasonCode: 'malformed_body' });
  });

  test('rejects fabricated payloads and invalid client configuration before network access', async () => {
    const fetchCall = vi.fn<typeof fetch>();
    const fabricated = {
      max_tokens: 300,
      messages: [
        { content: 'synthetic', role: 'system' },
        { content: 'synthetic', role: 'user' },
      ],
      model: 'auto',
      stream: false,
      tools: [{ name: 'forbidden' }],
    } as unknown as ReturnType<typeof buildManifestRequest>;

    await expect(
      client({ fetch: fetchCall }).complete({
        logicalRequestId: 'VERSION_TEST_fabricated',
        request: fabricated,
      }),
    ).resolves.toEqual({ status: 'failed', reasonCode: 'invalid_request' });
    expect(fetchCall).not.toHaveBeenCalled();
    expect(() => client({ apiKey: '' })).toThrow('Manifest client configuration is invalid');
    expect(() => client({ baseUrl: `${server.baseUrl}?redirect=unsafe` })).toThrow(
      'Manifest client configuration is invalid',
    );
  });

  test('snapshots validated endpoint, credential, timeout, and byte ceiling', async () => {
    const options = {
      apiKey: syntheticApiKey,
      baseUrl: server.baseUrl,
      maximumResponseBytes: 4096,
      totalTimeoutMs: 5000,
    };
    const manifestClient = createManifestClient(options);
    options.apiKey = '';
    options.baseUrl = 'http://unsafe.example.invalid/v1';
    options.maximumResponseBytes = 1;
    options.totalTimeoutMs = 0;
    server.enqueueResponse({ body: completionBody(), statusCode: 200 });

    const result = await manifestClient.complete({
      logicalRequestId: 'VERSION_TEST_mutated_options',
      request: request(),
    });

    expect(result.status).toBe('completed');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.authorizationWasSynthetic).toBe(true);
  });
});
