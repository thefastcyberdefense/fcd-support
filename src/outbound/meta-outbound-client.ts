import type { ReadableStream } from 'node:stream/web';

import { z } from 'zod';

import { noopSafeLogger, type SafeLogReason, type SafeLogger } from '../logging.js';
import type { OutboundProviderConfig, OutboundProviderResult } from './outbound-types.js';
import {
  readPreparedOutboundRequest,
  type PreparedOutboundRequest,
  type PreparedOutboundRequestContext,
} from './outbound-request.js';

export interface MetaTimerHandle {
  cancel(): void;
}

export type MetaFetch = (url: string, init: RequestInit) => Promise<Response>;
export type MetaTimerScheduler = (callback: () => void, delayMs: number) => MetaTimerHandle;

export interface MetaOutboundClientOptions {
  readonly config: OutboundProviderConfig;
  readonly fetch?: MetaFetch;
  readonly logger?: SafeLogger;
  readonly now?: () => Date;
  readonly schedule?: MetaTimerScheduler;
}

export interface MetaOutboundSendInput {
  readonly request: PreparedOutboundRequest;
  readonly signal?: AbortSignal;
}

interface AbortState {
  callerAborted: boolean;
  timedOut: boolean;
}

type BoundedBodyResult =
  { readonly status: 'accepted'; readonly value: string } | { readonly status: 'oversized' };
type FailedOutboundProviderResult = Exclude<
  OutboundProviderResult,
  { readonly status: 'accepted' }
>;

const accountReference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const maximumRetryAfterSeconds = 604_800;

function validProviderReference(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/\s/u.test(value) &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && (codePoint < 127 || codePoint > 159);
    })
  );
}

const providerReference = z.string().refine(validProviderReference);
const whatsappSuccessSchema = z.strictObject({
  contacts: z
    .array(
      z.strictObject({
        input: providerReference,
        wa_id: providerReference,
      }),
    )
    .length(1),
  messages: z.array(z.strictObject({ id: providerReference })).length(1),
  messaging_product: z.literal('whatsapp'),
});
const messengerSuccessSchema = z.strictObject({
  message_id: providerReference,
  recipient_id: providerReference,
});

function defaultSchedule(callback: () => void, delayMs: number): MetaTimerHandle {
  const timer = setTimeout(callback, delayMs);
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function baseUrlIsValid(config: OutboundProviderConfig): boolean {
  try {
    const url = new URL(config.baseUrl);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return false;
    }
    if (config.allowLoopbackFake) {
      const parts = url.hostname.split('.').map(Number);
      return (
        url.protocol === 'http:' &&
        parts.length === 4 &&
        parts[0] === 127 &&
        parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      );
    }
    return url.protocol === 'https:' && url.hostname === 'graph.facebook.com' && url.port === '';
  } catch {
    return false;
  }
}

function optionsAreValid(options: MetaOutboundClientOptions): boolean {
  const configValue: unknown = options.config;
  if (!isRecord(configValue)) return false;
  const whatsappValue = configValue.whatsapp;
  const messengerValue = configValue.messenger;
  const boundsValue = configValue.deploymentBounds;
  if (!isRecord(whatsappValue) || !isRecord(messengerValue) || !isRecord(boundsValue)) return false;
  const whatsappCredential = whatsappValue.credential;
  const messengerCredential = messengerValue.credential;
  if (!isRecord(whatsappCredential) || !isRecord(messengerCredential)) return false;
  const maximumResponseBytes = configValue.maximumResponseBytes;
  const providerTimeoutMs = boundsValue.providerTimeoutMs;
  const config = configValue as unknown as OutboundProviderConfig;
  return (
    configValue.graphApiVersion === 'v25.0' &&
    configValue.redirectPolicy === 'error' &&
    typeof configValue.baseUrl === 'string' &&
    typeof configValue.allowLoopbackFake === 'boolean' &&
    baseUrlIsValid(config) &&
    typeof whatsappValue.accountId === 'string' &&
    accountReference.test(whatsappValue.accountId) &&
    typeof messengerValue.accountId === 'string' &&
    accountReference.test(messengerValue.accountId) &&
    typeof whatsappCredential.reveal === 'function' &&
    typeof messengerCredential.reveal === 'function' &&
    typeof maximumResponseBytes === 'number' &&
    Number.isSafeInteger(maximumResponseBytes) &&
    maximumResponseBytes >= 1024 &&
    maximumResponseBytes <= 1_048_576 &&
    typeof providerTimeoutMs === 'number' &&
    Number.isSafeInteger(providerTimeoutMs) &&
    providerTimeoutMs >= 100 &&
    providerTimeoutMs <= 300_000 &&
    (options.fetch === undefined || typeof options.fetch === 'function') &&
    (options.logger === undefined ||
      (typeof options.logger.info === 'function' && typeof options.logger.warn === 'function')) &&
    (options.now === undefined || typeof options.now === 'function') &&
    (options.schedule === undefined || typeof options.schedule === 'function')
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response content and cancellation detail are deliberately discarded.
  }
}

async function readBoundedBody(
  response: Response,
  maximumResponseBytes: number,
): Promise<BoundedBodyResult> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maximumResponseBytes) {
      await cancelBody(response);
      return { status: 'oversized' };
    }
  }
  if (response.body === null) return { status: 'accepted', value: '' };

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let item = await reader.read();
  while (!item.done) {
    byteCount += item.value.byteLength;
    if (byteCount > maximumResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // Closed oversized result is sufficient.
      }
      return { status: 'oversized' };
    }
    chunks.push(item.value);
    item = await reader.read();
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { status: 'accepted', value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { status: 'accepted', value: '' };
  }
}

function accepted(providerMessageId: string): OutboundProviderResult {
  return Object.freeze({ providerMessageId, status: 'accepted' });
}

function definitelyRejected(
  reasonCode: 'provider_rejected' | 'rate_limited',
  retryAfter?: Date,
): OutboundProviderResult {
  return Object.freeze({ reasonCode, retryAfter, status: 'definitely_rejected' });
}

function unknown(
  reasonCode:
    'invalid_response' | 'network_failure' | 'oversized_response' | 'redirect' | 'timeout',
): OutboundProviderResult {
  return Object.freeze({ reasonCode, status: 'delivery_unknown' });
}

function parseSuccess(
  context: PreparedOutboundRequestContext,
  rawBody: string,
): OutboundProviderResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return unknown('invalid_response');
  }
  if (context.channel === 'whatsapp') {
    const parsed = whatsappSuccessSchema.safeParse(decoded);
    const providerMessageId = parsed.success ? parsed.data.messages[0]?.id : undefined;
    return providerMessageId === undefined
      ? unknown('invalid_response')
      : accepted(providerMessageId);
  }
  const parsed = messengerSuccessSchema.safeParse(decoded);
  return parsed.success ? accepted(parsed.data.message_id) : unknown('invalid_response');
}

function parseRetryAfter(value: string | null, now: Date): Date | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (/^\d{1,6}$/u.test(normalized)) {
    const seconds = Number(normalized);
    return seconds <= maximumRetryAfterSeconds
      ? new Date(now.getTime() + seconds * 1000)
      : undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed >= now.getTime() && parsed <= now.getTime() + 604_800_000
    ? new Date(parsed)
    : undefined;
}

function redirectFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.toLowerCase().includes('redirect')) return true;
  return redirectFailure((error as Error & { readonly cause?: unknown }).cause);
}

function requestIsAuthorized(
  context: PreparedOutboundRequestContext,
  config: OutboundProviderConfig,
): boolean {
  const account = context.channel === 'whatsapp' ? config.whatsapp : config.messenger;
  return (
    context.channelAccountId === account.accountId &&
    context.endpointPath === `/v25.0/${encodeURIComponent(account.accountId)}/messages` &&
    context.maximumResponseBytes <= config.maximumResponseBytes &&
    context.providerTimeoutMs <= config.deploymentBounds.providerTimeoutMs
  );
}

function safeReason(result: FailedOutboundProviderResult): SafeLogReason {
  if (result.status === 'aborted_before_dispatch') return 'aborted';
  if (result.status === 'definitely_rejected') return 'non_2xx';
  switch (result.reasonCode) {
    case 'timeout':
      return 'timeout';
    case 'network_failure':
    case 'redirect':
      return 'network_failure';
    case 'oversized_response':
      return 'oversized_body';
    case 'invalid_response':
      return 'invalid_body';
  }
}

function readAbortReason(state: AbortState): 'caller' | 'timeout' | undefined {
  if (state.timedOut) return 'timeout';
  if (state.callerAborted) return 'caller';
  return undefined;
}

export class MetaOutboundClient {
  readonly #config: OutboundProviderConfig;
  readonly #fetch: MetaFetch;
  readonly #logger: SafeLogger;
  readonly #now: () => Date;
  readonly #schedule: MetaTimerScheduler;

  public constructor(options: MetaOutboundClientOptions) {
    if (!optionsAreValid(options))
      throw new TypeError('Meta outbound client configuration is invalid');
    this.#config = options.config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? noopSafeLogger;
    this.#now = options.now ?? (() => new Date());
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  public async send(input: MetaOutboundSendInput): Promise<OutboundProviderResult> {
    const context = readPreparedOutboundRequest(input.request);
    const channel = context?.channel ?? 'unknown';
    const logResult = (result: OutboundProviderResult, statusCode?: number): void => {
      if (result.status === 'accepted') {
        this.#logger.info('meta_outbound_completed', {
          channel,
          ...(statusCode === undefined ? {} : { statusCode }),
        });
      } else {
        this.#logger.warn('meta_outbound_failed', {
          channel,
          reason: safeReason(result),
          ...(statusCode === undefined ? {} : { statusCode }),
        });
      }
    };
    if (context === undefined || !requestIsAuthorized(context, this.#config)) {
      const result = Object.freeze({ status: 'aborted_before_dispatch' as const });
      logResult(result);
      return result;
    }
    if (input.signal?.aborted === true) {
      const result = Object.freeze({ status: 'aborted_before_dispatch' as const });
      logResult(result);
      return result;
    }

    const account = context.channel === 'whatsapp' ? this.#config.whatsapp : this.#config.messenger;
    const abortController = new AbortController();
    const abortState: AbortState = { callerAborted: false, timedOut: false };
    let rejectAbort: (reason: Error) => void = () => undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onCallerAbort = (): void => {
      abortState.callerAborted = true;
      abortController.abort();
      rejectAbort(new Error('Meta caller aborted'));
    };
    input.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = this.#schedule(() => {
      abortState.timedOut = true;
      abortController.abort();
      rejectAbort(new Error('Meta provider timeout'));
    }, context.providerTimeoutMs);

    try {
      const fetchPromise = Promise.resolve()
        .then(() => {
          return this.#fetch(`${this.#config.baseUrl}${context.endpointPath}`, {
            body: JSON.stringify(context.body),
            headers: {
              authorization: `Bearer ${account.credential.reveal()}`,
              'content-type': 'application/json',
            },
            method: context.method,
            redirect: 'error',
            signal: abortController.signal,
          });
        })
        .then((response) => {
          if (abortState.callerAborted || abortState.timedOut) void cancelBody(response);
          return response;
        });
      const response = await Promise.race([fetchPromise, abortPromise]);
      const responseAbortReason = readAbortReason(abortState);
      if (responseAbortReason === 'timeout') {
        await cancelBody(response);
        const result = unknown('timeout');
        logResult(result);
        return result;
      }
      if (responseAbortReason === 'caller') {
        await cancelBody(response);
        const result = unknown('network_failure');
        logResult(result);
        return result;
      }
      if (response.status >= 300 && response.status <= 399) {
        await cancelBody(response);
        const result = unknown('redirect');
        logResult(result, response.status);
        return result;
      }
      if (!response.ok) {
        await cancelBody(response);
        const result =
          response.status === 400
            ? definitelyRejected('provider_rejected')
            : response.status === 429
              ? definitelyRejected(
                  'rate_limited',
                  parseRetryAfter(response.headers.get('retry-after'), this.#now()),
                )
              : unknown('invalid_response');
        logResult(result, response.status);
        return result;
      }

      const bounded = await Promise.race([
        readBoundedBody(response, context.maximumResponseBytes),
        abortPromise,
      ]);
      const bodyAbortReason = readAbortReason(abortState);
      if (bodyAbortReason === 'timeout') {
        const result = unknown('timeout');
        logResult(result);
        return result;
      }
      if (bodyAbortReason === 'caller') {
        const result = unknown('network_failure');
        logResult(result);
        return result;
      }
      const result =
        bounded.status === 'oversized'
          ? unknown('oversized_response')
          : parseSuccess(context, bounded.value);
      logResult(result, response.status);
      return result;
    } catch (error: unknown) {
      const abortReason = readAbortReason(abortState);
      const result =
        abortReason === 'timeout'
          ? unknown('timeout')
          : abortReason === 'caller'
            ? unknown('network_failure')
            : redirectFailure(error)
              ? unknown('redirect')
              : unknown('network_failure');
      logResult(result);
      return result;
    } finally {
      timeout.cancel();
      input.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
