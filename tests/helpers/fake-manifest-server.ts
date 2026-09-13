import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface FakeManifestRequestRecord {
  readonly authorizationPresent: boolean;
  readonly authorizationWasSynthetic: boolean;
  readonly contentType: string | undefined;
  readonly forbiddenFieldPresent: boolean;
  readonly maxTokens: number | undefined;
  readonly messageCount: number | undefined;
  readonly method: string | undefined;
  readonly model: string | undefined;
  readonly path: string | undefined;
  readonly redactionMarkerPresent: boolean;
  readonly requestBodyBytes: number;
  readonly sensitiveShapePresent: boolean;
  readonly stream: boolean | undefined;
  readonly topLevelKeys: readonly string[];
}

export interface FakeManifestResponse {
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

export interface FakeManifestServer {
  readonly baseUrl: string;
  readonly requests: readonly FakeManifestRequestRecord[];
  close(): Promise<void>;
  enqueueResponse(response: FakeManifestResponse): void;
  reset(): void;
}

const forbiddenKeys = new Set([
  'fallback',
  'function_call',
  'functions',
  'plugin',
  'plugins',
  'provider',
  'providers',
  'routing',
  'tool_choice',
  'tools',
]);

function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => forbiddenKeys.has(key) || containsForbiddenField(child),
  );
}

export async function startFakeManifestServer(): Promise<FakeManifestServer> {
  const requests: FakeManifestRequestRecord[] = [];
  const responses: FakeManifestResponse[] = [];
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const authorization = request.headers.authorization;
    const authorizationWasSynthetic =
      typeof authorization === 'string' &&
      /^Bearer SYNTHETIC_[A-Z0-9_]+_NOT_OPERATIONAL$/u.test(authorization);
    if (typeof authorization === 'string' && !authorizationWasSynthetic) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"non-synthetic authorization rejected"}');
      return;
    }

    const chunks: Buffer[] = [];
    let requestBodyBytes = 0;
    for await (const chunkValue of request) {
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue as Uint8Array);
      requestBodyBytes += chunk.byteLength;
      if (requestBodyBytes > 262_144) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    const bodyRecord =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const contentType = request.headers['content-type'];
    requests.push(
      Object.freeze({
        authorizationPresent: typeof authorization === 'string',
        authorizationWasSynthetic,
        contentType: Array.isArray(contentType) ? contentType.join(',') : contentType,
        forbiddenFieldPresent: containsForbiddenField(body),
        maxTokens: typeof bodyRecord.max_tokens === 'number' ? bodyRecord.max_tokens : undefined,
        messageCount: Array.isArray(bodyRecord.messages) ? bodyRecord.messages.length : undefined,
        method: request.method,
        model: typeof bodyRecord.model === 'string' ? bodyRecord.model : undefined,
        path: request.url,
        redactionMarkerPresent: bodyText.includes('[REDACTED_'),
        requestBodyBytes,
        sensitiveShapePresent: /\b(?:otp|password|token)\s*:\s*(?!\[REDACTED_)[^\s"}]+/iu.test(
          bodyText,
        ),
        stream: typeof bodyRecord.stream === 'boolean' ? bodyRecord.stream : undefined,
        topLevelKeys: Object.keys(bodyRecord).sort(),
      }),
    );

    const queued = responses.shift() ?? {
      body: '{"error":"no synthetic response queued"}',
      statusCode: 500,
    };
    response.writeHead(queued.statusCode, {
      'content-type': 'application/json',
      ...queued.headers,
    });
    response.end(queued.body);
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Synthetic Manifest server did not bind a TCP address');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
    enqueueResponse(response) {
      responses.push(response);
    },
    reset() {
      requests.splice(0, requests.length);
      responses.splice(0, responses.length);
    },
  };
}
