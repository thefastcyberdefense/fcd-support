import { noopSafeLogger, type SafeLogContext, type SafeLogger } from '../logging.js';
import type { ReadableStream } from 'node:stream/web';
import { isPrivateManifestBaseUrl } from './model-config.js';
import { parseManifestOutput } from './manifest-output.js';
import {
  readBuiltManifestRequestContext,
  type ManifestChatCompletionsRequest,
} from './manifest-request.js';
import type { ManifestDecisionEnvelope } from './model-types.js';

export type ManifestClientFailureReason =
  | 'aborted'
  | 'invalid_envelope'
  | 'invalid_request'
  | 'malformed_body'
  | 'network_failure'
  | 'non_2xx'
  | 'oversized_body'
  | 'provider_exhausted'
  | 'timeout';

export type ManifestClientResult =
  | { readonly status: 'completed'; readonly value: ManifestDecisionEnvelope }
  | { readonly reasonCode: ManifestClientFailureReason; readonly status: 'failed' };

export interface ManifestCompleteInput {
  readonly logicalRequestId: string;
  readonly request: ManifestChatCompletionsRequest;
  readonly signal?: AbortSignal;
}

export interface ManifestTimerHandle {
  cancel(): void;
}

export type ManifestFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ManifestTimerScheduler = (callback: () => void, delayMs: number) => ManifestTimerHandle;

export interface ManifestClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: ManifestFetch;
  readonly logger?: SafeLogger;
  readonly maximumResponseBytes: number;
  readonly schedule?: ManifestTimerScheduler;
  readonly totalTimeoutMs: number;
}

export interface ManifestClient {
  complete(input: ManifestCompleteInput): Promise<ManifestClientResult>;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface AbortState {
  callerAborted: boolean;
  timedOut: boolean;
}

function readAbortReason(state: AbortState): 'aborted' | 'timeout' | undefined {
  if (state.callerAborted) return 'aborted';
  if (state.timedOut) return 'timeout';
  return undefined;
}

function defaultSchedule(callback: () => void, delayMs: number): ManifestTimerHandle {
  const timer = setTimeout(callback, delayMs);
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

function configurationIsValid(options: ManifestClientOptions): boolean {
  return (
    isPrivateManifestBaseUrl(options.baseUrl) &&
    /^\S{16,4096}$/u.test(options.apiKey) &&
    Number.isSafeInteger(options.maximumResponseBytes) &&
    options.maximumResponseBytes >= 1 &&
    options.maximumResponseBytes <= 1_048_576 &&
    Number.isSafeInteger(options.totalTimeoutMs) &&
    options.totalTimeoutMs >= 1 &&
    options.totalTimeoutMs <= 120_000 &&
    (options.fetch === undefined || typeof options.fetch === 'function') &&
    (options.schedule === undefined || typeof options.schedule === 'function')
  );
}

type BoundedBodyResult =
  | { readonly status: 'accepted'; readonly value: string }
  | { readonly reasonCode: 'malformed_body' | 'oversized_body'; readonly status: 'rejected' };

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error response content and cancellation details are deliberately discarded.
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
      return { status: 'rejected', reasonCode: 'oversized_body' };
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
        // The closed oversized-body result is sufficient.
      }
      return { status: 'rejected', reasonCode: 'oversized_body' };
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
    return { status: 'rejected', reasonCode: 'malformed_body' };
  }
}

function readAssistantContent(rawBody: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined;
  const choices = (decoded as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) return undefined;
  const choice: unknown = (choices as unknown[])[0];
  if (typeof choice !== 'object' || choice === null) return undefined;
  const choiceRecord = choice as Record<string, unknown>;
  if (
    choiceRecord.finish_reason !== 'stop' ||
    'tool_calls' in choiceRecord ||
    'function_call' in choiceRecord
  ) {
    return undefined;
  }
  const message = choiceRecord.message;
  if (typeof message !== 'object' || message === null) return undefined;
  const messageRecord = message as Record<string, unknown>;
  if ('tool_calls' in messageRecord || 'function_call' in messageRecord) return undefined;
  return messageRecord.role === 'assistant' && typeof messageRecord.content === 'string'
    ? messageRecord.content
    : undefined;
}

function failed(reasonCode: ManifestClientFailureReason): ManifestClientResult {
  return Object.freeze({ status: 'failed', reasonCode });
}

export function createManifestClient(options: ManifestClientOptions): ManifestClient {
  if (!configurationIsValid(options)) {
    throw new TypeError('Manifest client configuration is invalid');
  }
  const fetchImplementation: ManifestFetch = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? noopSafeLogger;
  const schedule = options.schedule ?? defaultSchedule;
  const endpoint = `${options.baseUrl}/chat/completions`;
  const apiKey = options.apiKey;
  const maximumResponseBytes = options.maximumResponseBytes;
  const totalTimeoutMs = options.totalTimeoutMs;

  return Object.freeze({
    async complete(input: ManifestCompleteInput): Promise<ManifestClientResult> {
      const requestContext = readBuiltManifestRequestContext(input.request);
      const requestIdIsValid =
        typeof input.logicalRequestId === 'string' && requestIdPattern.test(input.logicalRequestId);

      const logFailure = (
        reason: ManifestClientFailureReason,
        statusCode?: number,
      ): ManifestClientResult => {
        const context: SafeLogContext = requestIdIsValid
          ? statusCode === undefined
            ? { reason, requestId: input.logicalRequestId }
            : { reason, requestId: input.logicalRequestId, statusCode }
          : { reason };
        logger.warn('manifest_request_failed', context);
        return failed(reason);
      };

      if (!requestIdIsValid || requestContext === undefined) return logFailure('invalid_request');
      if (input.signal?.aborted === true) return logFailure('aborted');

      const abortController = new AbortController();
      const abortState = { callerAborted: false, timedOut: false };
      let rejectAbort: (reason: Error) => void = () => undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onCallerAbort = (): void => {
        abortState.callerAborted = true;
        abortController.abort();
        rejectAbort(new Error('Manifest caller aborted'));
      };
      input.signal?.addEventListener('abort', onCallerAbort, { once: true });
      const timeout = schedule(() => {
        abortState.timedOut = true;
        abortController.abort();
        rejectAbort(new Error('Manifest total timeout'));
      }, totalTimeoutMs);

      try {
        const response = await Promise.race([
          fetchImplementation(endpoint, {
            body: JSON.stringify(input.request),
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            method: 'POST',
            redirect: 'error',
            signal: abortController.signal,
          }),
          abortPromise,
        ]);
        const fetchAbortReason = readAbortReason(abortState);
        if (fetchAbortReason !== undefined) {
          void cancelBody(response);
          return logFailure(fetchAbortReason);
        }
        if (!response.ok) {
          void cancelBody(response);
          return logFailure(
            response.status === 429 ? 'provider_exhausted' : 'non_2xx',
            response.status,
          );
        }

        const boundedBody = await Promise.race([
          readBoundedBody(response, maximumResponseBytes),
          abortPromise,
        ]);
        const bodyAbortReason = readAbortReason(abortState);
        if (bodyAbortReason !== undefined) return logFailure(bodyAbortReason);
        if (boundedBody.status === 'rejected') return logFailure(boundedBody.reasonCode);
        const assistantContent = readAssistantContent(boundedBody.value);
        if (assistantContent === undefined) return logFailure('malformed_body');
        const parsed = parseManifestOutput(assistantContent, {
          knowledge: requestContext.knowledge,
          maximumResponseBytes,
          requiredLanguage: requestContext.requiredLanguage,
        });
        if (parsed.status === 'rejected') return logFailure('invalid_envelope');

        logger.info('manifest_request_completed', {
          requestId: input.logicalRequestId,
          statusCode: response.status,
        });
        return Object.freeze({ status: 'completed', value: parsed.value });
      } catch {
        if (abortState.callerAborted) return logFailure('aborted');
        if (abortState.timedOut) return logFailure('timeout');
        return logFailure('network_failure');
      } finally {
        timeout.cancel();
        input.signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  });
}
