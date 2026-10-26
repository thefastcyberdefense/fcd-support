import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { inspect } from 'node:util';
import { z } from 'zod';

import type { NotificationEnvelope, N8nResult } from './notification-types.js';
import { notificationTypes } from './notification-types.js';

export interface N8nSigningSecret {
  readonly kind: 'n8n_signing_secret';
  toString(): string;
}
export interface N8nDestination {
  readonly address: string;
  readonly family: 4 | 6;
}
export type N8nFetch = (
  url: string,
  init: RequestInit,
  destination: N8nDestination,
) => Promise<{ readonly response: Response; readonly remoteAddress: string }>;
export interface N8nClientOptions {
  readonly origin: string;
  readonly path: string;
  readonly signingSecret: N8nSigningSecret;
  readonly timeoutMilliseconds: number;
  readonly maximumResponseBytes: number;
  readonly now: () => Date;
  readonly syntheticMode?: boolean;
  readonly fetch?: N8nFetch;
  readonly resolve?: (hostname: string) => Promise<readonly N8nDestination[]>;
}
export interface N8nClient {
  send(input: {
    readonly notification: NotificationEnvelope;
    readonly signal?: AbortSignal;
  }): Promise<N8nResult>;
}

const secrets = new WeakMap<N8nSigningSecret, Buffer>();
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const envelope = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.enum(notificationTypes),
  reference,
  occurredAt: z.date(),
  idempotencyKey: reference,
});
const acknowledgement = z.strictObject({ accepted: z.literal(true), idempotencyKey: reference });

export function createN8nSigningSecret(value: string): N8nSigningSecret {
  if (typeof value !== 'string' || !/^\S{32,4096}$/u.test(value))
    throw new TypeError('n8n_configuration_invalid');
  const wrapper: N8nSigningSecret = Object.freeze(
    Object.defineProperties(
      { kind: 'n8n_signing_secret' as const },
      {
        toJSON: { value: () => '[REDACTED]' },
        toString: { value: () => '[REDACTED]' },
        [inspect.custom]: { value: () => '[REDACTED]' },
      },
    ),
  );
  secrets.set(wrapper, Buffer.from(value, 'utf8'));
  return wrapper;
}

function normalizeAddress(address: string): string {
  if (/^::ffff:[0-9.]+$/iu.test(address)) return address.slice(7);
  if (isIP(address) === 6) return new URL(`http://[${address}]`).hostname;
  return address;
}

function isAllowedAddress(address: string, synthetic: boolean): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number);
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (synthetic && address === '127.0.0.1')
    );
  }
  if (isIP(address) === 6) return /^f[cd]/iu.test(address) || (synthetic && address === '::1');
  return false;
}

function endpoint(options: N8nClientOptions): URL {
  try {
    const origin = new URL(options.origin);
    const hostname = origin.hostname.replace(/^\[|\]$/gu, '');
    const syntheticLoopback =
      options.syntheticMode === true && (hostname === '127.0.0.1' || hostname === '::1');
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.origin !== options.origin ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      (!syntheticLoopback &&
        (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname) || hostname === 'localhost')) ||
      !/^\/[A-Za-z0-9/_-]+$/u.test(options.path) ||
      options.path.includes('//') ||
      !secrets.has(options.signingSecret) ||
      typeof options.now !== 'function' ||
      !Number.isSafeInteger(options.timeoutMilliseconds) ||
      options.timeoutMilliseconds < 1 ||
      options.timeoutMilliseconds > 300000 ||
      !Number.isSafeInteger(options.maximumResponseBytes) ||
      options.maximumResponseBytes < 1 ||
      options.maximumResponseBytes > 1048576 ||
      (options.fetch !== undefined && options.syntheticMode !== true)
    )
      throw new Error();
    return new URL(options.path, origin);
  } catch {
    throw new TypeError('n8n_configuration_invalid');
  }
}

class DestinationRejected extends Error {}

/** No connection pooling: every connection uses a freshly validated DNS answer. */
const socketFetch: N8nFetch = (url, init, destination) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'POST',
      headers: Object.fromEntries(new Headers(init.headers)),
      agent: false,
      family: destination.family,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [destination]);
        else callback(null, destination.address, destination.family);
      },
      ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
    });
    request.once('error', reject);
    request.once('socket', (socket) => {
      // Headers and signed body are not flushed until the connected peer is checked.
      socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (
          normalizeAddress(socket.remoteAddress ?? '') !== normalizeAddress(destination.address)
        ) {
          request.destroy(new DestinationRejected());
          return;
        }
        request.end(init.body as string);
      });
    });
    request.once('response', (incoming) => {
      const remoteAddress = incoming.socket.remoteAddress ?? '';
      const headers = new Headers();
      for (const [key, values] of Object.entries(incoming.headers)) {
        if (Array.isArray(values)) for (const value of values) headers.append(key, value);
        else if (values !== undefined) headers.set(key, values);
      }
      const status = incoming.statusCode ?? 500;
      const response = new Response(
        status === 204 || status === 205 || status === 304
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
        { status, headers },
      );
      if (response.body === null) incoming.destroy();
      resolve({ response, remoteAddress });
    });
  });

function cancelBody(response: Response | undefined): void {
  try {
    void response?.body?.cancel().catch(() => undefined);
  } catch {
    /* Only closed outcomes escape. */
  }
}

async function readAcknowledgement(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maximum)) throw new Error();
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (reader === undefined) throw new Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      onAbort();
      throw new Error();
    }
    let item = await reader.read();
    while (!item.done) {
      size += item.value.byteLength;
      if (size > maximum) throw new Error();
      chunks.push(item.value);
      item = await reader.read();
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createN8nClient(options: N8nClientOptions): N8nClient {
  const target = endpoint(options);
  const secret = secrets.get(options.signingSecret);
  if (secret === undefined) throw new TypeError('n8n_configuration_invalid');
  const timeoutMilliseconds = options.timeoutMilliseconds;
  const maximumResponseBytes = options.maximumResponseBytes;
  const now = options.now;
  const synthetic = options.syntheticMode === true;
  const fetch = options.fetch ?? socketFetch;
  const resolve =
    options.resolve ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
        address,
        family: family as 4 | 6,
      })));
  return Object.freeze({
    async send(input: {
      readonly notification: NotificationEnvelope;
      readonly signal?: AbortSignal;
    }): Promise<N8nResult> {
      const parsed = envelope.safeParse(input.notification);
      if (!parsed.success) return { status: 'terminal_failed', reasonCode: 'invalid_response' };
      if (input.signal?.aborted === true)
        return { status: 'retryable', reasonCode: 'transport_failure' };
      const controller = new AbortController();
      const isAborted = () => controller.signal.aborted;
      let timedOut = false;
      const hasTimedOut = () => timedOut;
      let response: Response | undefined;
      let rejectAbort: () => void = () => undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => {
          reject(new Error());
        };
      });
      const onAbort = () => {
        controller.abort();
        cancelBody(response);
        rejectAbort();
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMilliseconds);
      const execute = async (): Promise<N8nResult> => {
        const addresses = await resolve(target.hostname.replace(/^\[|\]$/gu, ''));
        if (isAborted()) throw new Error();
        const destination = addresses[0];
        if (
          destination === undefined ||
          addresses.some(
            ({ address, family }) =>
              isIP(address) !== family || !isAllowedAddress(address, synthetic),
          )
        )
          throw new DestinationRejected();
        const timestamp = String(Math.floor(now().getTime() / 1000));
        if (!/^(?:0|[1-9][0-9]*)$/u.test(timestamp) || !Number.isSafeInteger(Number(timestamp)))
          throw new Error();
        const body = JSON.stringify({
          schemaVersion: parsed.data.schemaVersion,
          type: parsed.data.type,
          reference: parsed.data.reference,
          occurredAt: parsed.data.occurredAt.toISOString(),
          idempotencyKey: parsed.data.idempotencyKey,
        });
        const signature = createHmac('sha256', secret)
          .update(timestamp, 'utf8')
          .update('.')
          .update(body, 'utf8')
          .digest('hex');
        const result = await fetch(
          target.href,
          {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            body,
            headers: {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body, 'utf8')),
              'x-fcd-timestamp': timestamp,
              'x-fcd-signature': `sha256=${signature}`,
              'idempotency-key': parsed.data.idempotencyKey,
            },
          },
          destination,
        );
        response = result.response;
        if (isAborted()) {
          cancelBody(response);
          throw new Error();
        }
        if (normalizeAddress(result.remoteAddress) !== normalizeAddress(destination.address))
          throw new DestinationRejected();
        if (
          response.redirected ||
          (response.url !== '' && response.url !== target.href) ||
          (response.status >= 300 && response.status < 400)
        )
          throw new DestinationRejected();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403)
            return { status: 'terminal_failed', reasonCode: 'authentication_failed' };
          if (response.status === 408 || response.status === 429 || response.status >= 500)
            return { status: 'retryable', reasonCode: 'transport_failure' };
          return { status: 'terminal_failed', reasonCode: 'invalid_response' };
        }
        try {
          const accepted = acknowledgement.safeParse(
            await readAcknowledgement(response, maximumResponseBytes, controller.signal),
          );
          return accepted.success && accepted.data.idempotencyKey === parsed.data.idempotencyKey
            ? { status: 'accepted', reasonCode: 'ok' }
            : { status: 'retryable', reasonCode: 'invalid_response' };
        } catch {
          return { status: 'retryable', reasonCode: 'invalid_response' };
        }
      };
      try {
        return await Promise.race([execute(), aborted]);
      } catch (error) {
        if (error instanceof DestinationRejected)
          return { status: 'terminal_failed', reasonCode: 'destination_rejected' };
        return { status: 'retryable', reasonCode: hasTimedOut() ? 'timeout' : 'transport_failure' };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        cancelBody(response);
      }
    },
  });
}
