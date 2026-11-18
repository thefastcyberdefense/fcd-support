import { createHmac } from 'node:crypto';
import { z } from 'zod';

const MAX_STANDARD_PAYLOAD_BYTES = 256 * 1024;
const MAX_CLI_PROBE_PAYLOAD_BYTES = 512 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const INVALID_VERIFY_TOKEN_PROBE = 'synthetic_invalid_verify_token_probe';

const probePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\/[A-Za-z0-9._/-]*$/u)
  .refine((value) => !value.includes('..') && !value.includes('//'));

const challengeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/u);

const signatureModeSchema = z.enum(['valid', 'invalid', 'unsigned']);

export type WebhookProbeSignatureMode = z.infer<typeof signatureModeSchema>;
export type WebhookProbeMode = 'verify' | 'post' | 'closed-route';

export interface WebhookProbeResult {
  readonly ok: boolean;
  readonly mode: WebhookProbeMode;
  readonly targetOrigin: string;
  readonly path: string;
  readonly signatureMode: WebhookProbeSignatureMode | 'none';
  readonly payloadBytes: number;
  readonly statusCode: number;
  readonly expectedStatus: number;
}

export interface VerifyWebhookProbeOptions {
  readonly mode: 'verify';
  readonly baseUrl: string;
  readonly path?: string | undefined;
  readonly verifyToken?: string | undefined;
  readonly invalidToken?: boolean | undefined;
  readonly challenge?: string | undefined;
  readonly timeoutMilliseconds?: number | undefined;
  readonly expectedStatus?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export interface PostWebhookProbeOptions {
  readonly mode: 'post';
  readonly baseUrl: string;
  readonly path?: string | undefined;
  readonly rawBody: Buffer;
  readonly appSecret?: string | undefined;
  readonly signatureMode?: WebhookProbeSignatureMode | undefined;
  readonly allowOversized?: boolean | undefined;
  readonly contentType?: string | undefined;
  readonly timeoutMilliseconds?: number | undefined;
  readonly expectedStatus?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export interface ClosedRouteProbeOptions {
  readonly mode: 'closed-route';
  readonly baseUrl: string;
  readonly path: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly expectedStatus?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export type MetaWebhookProbeOptions =
  VerifyWebhookProbeOptions | PostWebhookProbeOptions | ClosedRouteProbeOptions;

function parseTargetOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('webhook_probe_url_invalid');
  }
  return parsed.origin;
}

function parseTimeoutMilliseconds(value: number | undefined): number {
  return z
    .number()
    .int()
    .min(100)
    .max(60_000)
    .parse(value ?? DEFAULT_TIMEOUT_MS);
}

function parseExpectedStatus(value: number | undefined, fallback: number): number {
  return z
    .number()
    .int()
    .min(100)
    .max(599)
    .parse(value ?? fallback);
}

async function readBoundedTextResponse(response: Response): Promise<string> {
  if (response.body === null) return '';
  const stream: AsyncIterable<unknown> = response.body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error('webhook_probe_response_invalid_chunk');
    }
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BODY_BYTES) {
      throw new Error('webhook_probe_response_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function flipLastHexChar(signature: string): string {
  const last = signature.at(-1) ?? '0';
  const flipped = last === '0' ? '1' : '0';
  return `${signature.slice(0, -1)}${flipped}`;
}

/**
 * Computes the exact Meta `X-Hub-Signature-256` HMAC over raw UTF-8 payload bytes.
 */
export function signMetaWebhookPayload(rawBody: Buffer, appSecret: string): string {
  if (!Buffer.isBuffer(rawBody) || appSecret.length === 0) {
    throw new Error('webhook_probe_secret_invalid');
  }
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Executes a non-secret, content-free Meta webhook verification, signed POST, or closed-route probe.
 */
export async function runMetaWebhookProbe(
  options: MetaWebhookProbeOptions,
): Promise<WebhookProbeResult> {
  const targetOrigin = parseTargetOrigin(options.baseUrl);
  const timeoutMs = parseTimeoutMilliseconds(options.timeoutMilliseconds);
  const fetchImpl = options.fetch ?? fetch;
  const path = probePathSchema.parse(
    options.mode === 'closed-route' ? options.path : (options.path ?? '/webhooks/meta'),
  );

  if (options.mode === 'verify') {
    const challenge = challengeSchema.parse(options.challenge ?? 'synthetic_challenge_probe');
    const invalidToken = options.invalidToken === true;
    const token = invalidToken ? INVALID_VERIFY_TOKEN_PROBE : (options.verifyToken ?? '');
    if (token.length === 0) {
      throw new Error('webhook_probe_verify_token_missing');
    }
    const expectedStatus = parseExpectedStatus(options.expectedStatus, invalidToken ? 403 : 200);
    const targetUrl = new URL(path, targetOrigin);
    targetUrl.searchParams.set('hub.mode', 'subscribe');
    targetUrl.searchParams.set('hub.verify_token', token);
    targetUrl.searchParams.set('hub.challenge', challenge);
    const response = await fetchImpl(targetUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readBoundedTextResponse(response);
    const ok = response.status === expectedStatus && (expectedStatus !== 200 || body === challenge);
    return Object.freeze({
      ok,
      mode: 'verify',
      targetOrigin,
      path,
      signatureMode: 'none',
      payloadBytes: 0,
      statusCode: response.status,
      expectedStatus,
    });
  }

  if (options.mode === 'closed-route') {
    const expectedStatus = parseExpectedStatus(options.expectedStatus, 404);
    const response = await fetchImpl(new URL(path, targetOrigin), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return Object.freeze({
      ok: response.status === expectedStatus,
      mode: 'closed-route',
      targetOrigin,
      path,
      signatureMode: 'none',
      payloadBytes: 0,
      statusCode: response.status,
      expectedStatus,
    });
  }

  const signatureMode = signatureModeSchema.parse(options.signatureMode ?? 'valid');
  const rawBody = options.rawBody;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new Error('webhook_probe_payload_empty');
  }
  if (rawBody.length > MAX_CLI_PROBE_PAYLOAD_BYTES) {
    throw new Error('webhook_probe_payload_exceeds_hard_cap');
  }
  if (rawBody.length > MAX_STANDARD_PAYLOAD_BYTES && options.allowOversized !== true) {
    throw new Error('webhook_probe_payload_too_large');
  }

  const headers: Record<string, string> = {
    'content-type': z
      .string()
      .min(1)
      .max(128)
      .parse(options.contentType ?? 'application/json'),
  };
  if (signatureMode === 'valid') {
    const secret = options.appSecret ?? '';
    if (secret.length === 0) throw new Error('webhook_probe_secret_missing');
    headers['x-hub-signature-256'] = signMetaWebhookPayload(rawBody, secret);
  } else if (signatureMode === 'invalid') {
    const secret = options.appSecret ?? '';
    headers['x-hub-signature-256'] =
      secret.length > 0
        ? flipLastHexChar(signMetaWebhookPayload(rawBody, secret))
        : `sha256=${'f'.repeat(64)}`;
  }

  const expectedStatus = parseExpectedStatus(
    options.expectedStatus,
    signatureMode === 'valid' ? 200 : 401,
  );
  const response = await fetchImpl(new URL(path, targetOrigin), {
    method: 'POST',
    headers,
    body: new Uint8Array(rawBody),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel().catch(() => undefined);
  return Object.freeze({
    ok: response.status === expectedStatus,
    mode: 'post',
    targetOrigin,
    path,
    signatureMode,
    payloadBytes: rawBody.length,
    statusCode: response.status,
    expectedStatus,
  });
}
