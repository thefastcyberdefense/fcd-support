import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const syntheticN8nSecret = 'synthetic_n8n_signing_secret_not_operational';
export interface FakeN8nServer {
  readonly origin: string;
  readonly requests: readonly { readonly keys: readonly string[]; readonly outcome: string }[];
  acceptedNotificationCount(): number;
  acceptThenDisconnect(): void;
  close(): Promise<void>;
}

/** Authored from scratch: no real n8n workflow, credential, or notification data. */
export async function startFakeN8nServer(options: {
  readonly now: () => Date;
  readonly maximumSkewSeconds: number;
  readonly maximumRequestBytes: number;
}): Promise<FakeN8nServer> {
  const accepted = new Map<string, string>();
  const requests: { keys: readonly string[]; outcome: string }[] = [];
  let disconnect = false;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const item of request) {
        const chunk = Buffer.from(item as Uint8Array);
        length += chunk.byteLength;
        if (length > options.maximumRequestBytes) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const timestamp = request.headers['x-fcd-timestamp'];
      const signature = request.headers['x-fcd-signature'];
      const key = request.headers['idempotency-key'];
      const reject = (outcome: string, status: number) => {
        requests.push({ keys: [], outcome });
        response.writeHead(status).end();
      };
      if (request.method !== 'POST' || request.url !== '/webhook/fcd-notification') {
        reject('route_rejected', 404);
        return;
      }
      if (
        typeof timestamp !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/u.test(timestamp) ||
        !Number.isSafeInteger(Number(timestamp)) ||
        Math.abs(Math.floor(options.now().getTime() / 1000) - Number(timestamp)) >
          options.maximumSkewSeconds ||
        typeof signature !== 'string' ||
        !/^sha256=[a-f0-9]{64}$/u.test(signature)
      ) {
        reject('authentication_failed', 401);
        return;
      }
      const mac = createHmac('sha256', syntheticN8nSecret)
        .update(timestamp)
        .update('.')
        .update(body)
        .digest();
      if (!timingSafeEqual(mac, Buffer.from(signature.slice(7), 'hex'))) {
        reject('authentication_failed', 401);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        reject('shape_rejected', 400);
        return;
      }
      const value =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const keys = ['schemaVersion', 'type', 'reference', 'occurredAt', 'idempotencyKey'];
      if (
        JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) ||
        value.schemaVersion !== 1 ||
        ![
          'operator_privacy_request',
          'operator_marketing_opt_out',
          'operator_support_escalation',
          'operator_outbound_escalation',
        ].includes(String(value.type)) ||
        typeof value.reference !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.reference) ||
        typeof value.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.idempotencyKey) ||
        typeof value.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(value.occurredAt)) ||
        new Date(value.occurredAt).toISOString() !== value.occurredAt ||
        key !== value.idempotencyKey ||
        JSON.stringify(value) !== body.toString('utf8')
      ) {
        reject('shape_rejected', 400);
        return;
      }
      // Synthetic fingerprint metadata detects a reused key with a different body.
      const fingerprint = createHash('sha256').update(body).digest('hex');
      const prior = accepted.get(value.idempotencyKey);
      if (prior !== undefined && prior !== fingerprint) {
        reject('key_conflict', 409);
        return;
      }
      accepted.set(value.idempotencyKey, fingerprint);
      requests.push({ keys, outcome: prior === undefined ? 'accepted' : 'duplicate' });
      if (disconnect) {
        disconnect = false;
        response.destroy();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ accepted: true, idempotencyKey: value.idempotencyKey }));
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('synthetic_n8n_bind_failed');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    acceptedNotificationCount: () => accepted.size,
    acceptThenDisconnect: () => {
      disconnect = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
