import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type FakeMetaOutcome = 'accepted' | 'definite_rejection' | 'redirect' | 'unknown';

export interface FakeMetaRequestRecord {
  readonly authorizationPresent: boolean;
  readonly authorizationWasSynthetic: boolean;
  readonly contentTypeJson: boolean;
  readonly forbiddenFieldPresent: boolean;
  readonly messengerTextShape: boolean;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly requestBodyBytes: number;
  readonly responseOutcome: FakeMetaOutcome;
  readonly whatsappTemplateShape: boolean;
  readonly whatsappTextShape: boolean;
}

export interface FakeMetaResponse {
  readonly body: string;
  readonly delayMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly outcome: FakeMetaOutcome;
  readonly statusCode: number;
}

export interface FakeMetaServer {
  readonly abortCount: number;
  readonly baseUrl: string;
  readonly callCount: number;
  readonly requests: readonly FakeMetaRequestRecord[];
  close(): Promise<void>;
  enqueueResponse(response: FakeMetaResponse): void;
  reset(): void;
}

const forbiddenKeys = new Set([
  'access_token',
  'attachment',
  'components',
  'metadata',
  'quick_replies',
  'sender_action',
  'tag',
  'token',
]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  const record = recordOf(value);
  if (record === undefined) return false;
  return Object.entries(record).some(
    ([key, child]) => forbiddenKeys.has(key) || containsForbiddenField(child),
  );
}

function whatsappTextShape(value: unknown): boolean {
  const body = recordOf(value);
  const text = recordOf(body?.text);
  return (
    body !== undefined &&
    text !== undefined &&
    exactKeys(body, ['messaging_product', 'recipient_type', 'text', 'to', 'type']) &&
    exactKeys(text, ['body', 'preview_url']) &&
    body.messaging_product === 'whatsapp' &&
    body.recipient_type === 'individual' &&
    body.type === 'text' &&
    typeof body.to === 'string' &&
    typeof text.body === 'string' &&
    text.preview_url === false
  );
}

function whatsappTemplateShape(value: unknown): boolean {
  const body = recordOf(value);
  const template = recordOf(body?.template);
  const language = recordOf(template?.language);
  return (
    body !== undefined &&
    template !== undefined &&
    language !== undefined &&
    exactKeys(body, ['messaging_product', 'template', 'to', 'type']) &&
    exactKeys(template, ['language', 'name']) &&
    exactKeys(language, ['code']) &&
    body.messaging_product === 'whatsapp' &&
    body.type === 'template' &&
    typeof body.to === 'string' &&
    typeof template.name === 'string' &&
    (language.code === 'bn_BD' || language.code === 'en_US')
  );
}

function messengerTextShape(value: unknown): boolean {
  const body = recordOf(value);
  const recipient = recordOf(body?.recipient);
  const message = recordOf(body?.message);
  return (
    body !== undefined &&
    recipient !== undefined &&
    message !== undefined &&
    exactKeys(body, ['message', 'messaging_type', 'recipient']) &&
    exactKeys(recipient, ['id']) &&
    exactKeys(message, ['text']) &&
    body.messaging_type === 'RESPONSE' &&
    typeof recipient.id === 'string' &&
    typeof message.text === 'string'
  );
}

export async function startFakeMetaServer(
  options: { readonly host?: string } = {},
): Promise<FakeMetaServer> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new TypeError('Synthetic Meta server requires loopback');

  const requests: FakeMetaRequestRecord[] = [];
  const responses: FakeMetaResponse[] = [];
  let abortCount = 0;
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let countedAbort = false;
    request.once('aborted', () => {
      if (!countedAbort) {
        countedAbort = true;
        abortCount += 1;
      }
    });
    const authorization = request.headers.authorization;
    const authorizationWasSynthetic =
      typeof authorization === 'string' &&
      /^Bearer SYNTHETIC_[A-Z0-9_]+_NOT_OPERATIONAL$/u.test(authorization);
    if (!authorizationWasSynthetic) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"synthetic authorization required"}');
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
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    const queued = responses.shift() ?? {
      body: '{"error":"no synthetic response queued"}',
      outcome: 'unknown' as const,
      statusCode: 500,
    };
    const contentType = request.headers['content-type'];
    requests.push(
      Object.freeze({
        authorizationPresent: typeof authorization === 'string',
        authorizationWasSynthetic,
        contentTypeJson:
          (Array.isArray(contentType) ? contentType.join(',') : contentType) === 'application/json',
        forbiddenFieldPresent: containsForbiddenField(body),
        messengerTextShape: messengerTextShape(body),
        method: request.method,
        path: request.url,
        requestBodyBytes,
        responseOutcome: queued.outcome,
        whatsappTemplateShape: whatsappTemplateShape(body),
        whatsappTextShape: whatsappTextShape(body),
      }),
    );

    if ((queued.delayMs ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, queued.delayMs);
      });
    }
    if (response.destroyed) return;
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
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Synthetic Meta server did not bind a TCP address');
  }

  return {
    get abortCount() {
      return abortCount;
    },
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    get callCount() {
      return requests.length;
    },
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
      abortCount = 0;
    },
  };
}
