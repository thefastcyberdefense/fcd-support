import type { ReadableStream } from 'node:stream/web';

import { noopSafeLogger, type SafeLogContext, type SafeLogger } from '../logging.js';
import type { ModelGatewayTestOutcome } from './gateway-types.js';
import {
  isAllowedOpenAiCompatibleBaseUrl,
  isPrivateManifestBaseUrl,
  normalizeGatewayBaseUrl,
} from './model-config.js';
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
  | 'timeout'
  | 'truncated_completion';

export interface ModelTokenUsage {
  readonly completionTokens: number;
  readonly promptTokens: number;
}

export type ManifestClientResult =
  | {
      readonly status: 'completed';
      readonly usage?: ModelTokenUsage;
      readonly value: ManifestDecisionEnvelope;
    }
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

function configurationIsValid(
  options: ManifestClientOptions,
  urlValidator: (url: string) => boolean,
  minimumKeyLength: number,
): boolean {
  const keyPattern = new RegExp(`^\\S{${String(minimumKeyLength)},4096}$`, 'u');
  return (
    urlValidator(options.baseUrl) &&
    keyPattern.test(options.apiKey) &&
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

interface ParsedChoiceBody {
  readonly content: string;
  readonly finishReason: 'length' | 'stop';
  readonly usage?: ModelTokenUsage;
}

type ChoiceBodyResult =
  | { readonly status: 'ok'; readonly value: ParsedChoiceBody }
  | { readonly reasonCode: 'malformed_body' | 'truncated_completion'; readonly status: 'failed' };

function readTokenUsage(decoded: Record<string, unknown>): ModelTokenUsage | undefined {
  const usage = decoded.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const promptTokens = record.prompt_tokens;
  const completionTokens = record.completion_tokens;
  if (
    typeof promptTokens !== 'number' ||
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== 'number' ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return undefined;
  }
  return Object.freeze({ completionTokens, promptTokens });
}

function readChoiceBody(
  rawBody: string,
  allowedFinishReasons: readonly ('length' | 'stop')[] = ['stop'],
): ChoiceBodyResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  if (typeof decoded !== 'object' || decoded === null) {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  const decodedRecord = decoded as Record<string, unknown>;
  const choices = decodedRecord.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  const choice: unknown = (choices as unknown[])[0];
  if (typeof choice !== 'object' || choice === null) {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  const choiceRecord = choice as Record<string, unknown>;
  const finishReason = choiceRecord.finish_reason;
  if (
    (finishReason !== 'stop' && finishReason !== 'length') ||
    'tool_calls' in choiceRecord ||
    'function_call' in choiceRecord
  ) {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  const message = choiceRecord.message;
  if (typeof message !== 'object' || message === null) {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  const messageRecord = message as Record<string, unknown>;
  if ('tool_calls' in messageRecord || 'function_call' in messageRecord) {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  if (messageRecord.role !== 'assistant') {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  // Check token truncation only after verifying the envelope itself has no tool calls or invalid role.
  if (finishReason === 'length' && !allowedFinishReasons.includes('length')) {
    if (typeof messageRecord.content === 'string' || messageRecord.content === null) {
      return { status: 'failed', reasonCode: 'truncated_completion' };
    }
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  if (typeof messageRecord.content !== 'string') {
    return { status: 'failed', reasonCode: 'malformed_body' };
  }
  const usage = readTokenUsage(decodedRecord);
  return {
    status: 'ok',
    value: {
      content: messageRecord.content,
      finishReason,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function failed(reasonCode: ManifestClientFailureReason): ManifestClientResult {
  return Object.freeze({ status: 'failed', reasonCode });
}

type BoundedHttpResult =
  | { readonly body: string; readonly status: 'ok'; readonly statusCode: number }
  | {
      readonly reasonCode: Exclude<
        ManifestClientFailureReason,
        'invalid_envelope' | 'invalid_request'
      >;
      readonly status: 'failed';
      readonly statusCode?: number;
    };

async function postBoundedChatCompletion(input: {
  readonly apiKey: string;
  readonly body: string;
  readonly endpoint: string;
  readonly fetchImplementation: ManifestFetch;
  readonly maximumResponseBytes: number;
  readonly schedule: ManifestTimerScheduler;
  readonly signal?: AbortSignal;
  readonly totalTimeoutMs: number;
}): Promise<BoundedHttpResult> {
  if (input.signal?.aborted === true) return { status: 'failed', reasonCode: 'aborted' };

  const abortController = new AbortController();
  const abortState = { callerAborted: false, timedOut: false };
  let rejectAbort: (reason: Error) => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onCallerAbort = (): void => {
    abortState.callerAborted = true;
    abortController.abort();
    rejectAbort(new Error('Gateway caller aborted'));
  };
  input.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = input.schedule(() => {
    abortState.timedOut = true;
    abortController.abort();
    rejectAbort(new Error('Gateway total timeout'));
  }, input.totalTimeoutMs);

  try {
    const response = await Promise.race([
      input.fetchImplementation(input.endpoint, {
        body: input.body,
        headers: {
          authorization: `Bearer ${input.apiKey}`,
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
      return { status: 'failed', reasonCode: fetchAbortReason };
    }
    if (!response.ok) {
      void cancelBody(response);
      return {
        status: 'failed',
        reasonCode: response.status === 429 ? 'provider_exhausted' : 'non_2xx',
        statusCode: response.status,
      };
    }

    const boundedBody = await Promise.race([
      readBoundedBody(response, input.maximumResponseBytes),
      abortPromise,
    ]);
    const bodyAbortReason = readAbortReason(abortState);
    if (bodyAbortReason !== undefined) return { status: 'failed', reasonCode: bodyAbortReason };
    if (boundedBody.status === 'rejected') {
      return { status: 'failed', reasonCode: boundedBody.reasonCode };
    }
    return { status: 'ok', statusCode: response.status, body: boundedBody.value };
  } catch {
    if (abortState.callerAborted) return { status: 'failed', reasonCode: 'aborted' };
    if (abortState.timedOut) return { status: 'failed', reasonCode: 'timeout' };
    return { status: 'failed', reasonCode: 'network_failure' };
  } finally {
    timeout.cancel();
    input.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function buildValidatedClient(
  options: ManifestClientOptions,
  urlValidator: (url: string) => boolean,
  minimumKeyLength: number,
  configErrorMessage: string,
): ManifestClient {
  if (!configurationIsValid(options, urlValidator, minimumKeyLength)) {
    throw new TypeError(configErrorMessage);
  }
  const fetchImplementation: ManifestFetch = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? noopSafeLogger;
  const schedule = options.schedule ?? defaultSchedule;
  const endpoint = `${normalizeGatewayBaseUrl(options.baseUrl)}/chat/completions`;
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
      const result = await postBoundedChatCompletion({
        apiKey,
        body: JSON.stringify(input.request),
        endpoint,
        fetchImplementation,
        maximumResponseBytes,
        schedule,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        totalTimeoutMs,
      });
      if (result.status === 'failed') return logFailure(result.reasonCode, result.statusCode);
      const choiceResult = readChoiceBody(result.body, ['stop']);
      if (choiceResult.status === 'failed') {
        return logFailure(choiceResult.reasonCode, result.statusCode);
      }
      const choice = choiceResult.value;
      const parsed = parseManifestOutput(choice.content, {
        knowledge: requestContext.knowledge,
        maximumResponseBytes,
        requiredLanguage: requestContext.requiredLanguage,
      });
      if (parsed.status === 'rejected') return logFailure('invalid_envelope', result.statusCode);

      logger.info('manifest_request_completed', {
        requestId: input.logicalRequestId,
        statusCode: result.statusCode,
      });
      return Object.freeze({
        status: 'completed',
        ...(choice.usage === undefined ? {} : { usage: choice.usage }),
        value: parsed.value,
      });
    },
  });
}

export function createManifestClient(options: ManifestClientOptions): ManifestClient {
  return buildValidatedClient(
    options,
    isPrivateManifestBaseUrl,
    16,
    'Manifest client configuration is invalid',
  );
}

export function createOpenAiCompatibleClient(options: ManifestClientOptions): ManifestClient {
  return buildValidatedClient(
    options,
    isAllowedOpenAiCompatibleBaseUrl,
    8,
    'OpenAI-compatible client configuration is invalid',
  );
}

export async function probeGatewayConnection(options: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: ManifestFetch;
  readonly gatewayKind: 'manifest_default' | 'openai_compatible';
  readonly logger?: SafeLogger;
  readonly maximumResponseBytes?: number;
  readonly modelName: string;
  readonly now?: () => Date;
  readonly schedule?: ManifestTimerScheduler;
  readonly totalTimeoutMs?: number;
}): Promise<ModelGatewayTestOutcome> {
  const now = options.now ?? (() => new Date());
  const startedMs = Date.now();
  const testedAt = now();
  const maximumResponseBytes = options.maximumResponseBytes ?? 32_768;
  const totalTimeoutMs = options.totalTimeoutMs ?? 10_000;
  const validModel =
    options.gatewayKind === 'manifest_default'
      ? options.modelName === 'auto'
      : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(options.modelName);
  const urlValid =
    options.gatewayKind === 'manifest_default'
      ? isPrivateManifestBaseUrl(options.baseUrl)
      : isAllowedOpenAiCompatibleBaseUrl(options.baseUrl);
  if (
    !urlValid ||
    !validModel ||
    !/^\S{8,4096}$/u.test(options.apiKey) ||
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 256 ||
    maximumResponseBytes > 1_048_576 ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < 100 ||
    totalTimeoutMs > 120_000
  ) {
    return Object.freeze({
      latencyMs: 0,
      reasonCode: 'invalid_gateway_configuration',
      result: 'failed',
      testedAt,
    });
  }

  const endpoint = `${normalizeGatewayBaseUrl(options.baseUrl)}/chat/completions`;
  const logger = options.logger ?? noopSafeLogger;
  const result = await postBoundedChatCompletion({
    apiKey: options.apiKey,
    body: JSON.stringify({
      max_tokens: 16,
      messages: [
        { content: 'Respond briefly without tools.', role: 'system' },
        { content: 'ping', role: 'user' },
      ],
      model: options.modelName,
      stream: false,
    }),
    endpoint,
    fetchImplementation: options.fetch ?? globalThis.fetch,
    maximumResponseBytes,
    schedule: options.schedule ?? defaultSchedule,
    totalTimeoutMs,
  });
  const latencyMs = Math.min(120_000, Math.max(0, Date.now() - startedMs));

  if (result.status === 'failed') {
    const reasonCode =
      result.reasonCode === 'non_2xx'
        ? result.statusCode === 401 || result.statusCode === 403
          ? 'unauthorized'
          : result.statusCode === 404 || result.statusCode === 422
            ? 'model_or_endpoint_rejected'
            : 'non_2xx'
        : result.reasonCode;
    logger.warn('gateway_connection_test_failed', {
      reason: reasonCode,
      ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
    });
    return Object.freeze({
      ...(result.statusCode === undefined ? {} : { httpStatus: result.statusCode }),
      latencyMs,
      reasonCode,
      result: 'failed',
      testedAt,
    });
  }

  const choiceResult = readChoiceBody(result.body, ['stop', 'length']);
  if (choiceResult.status === 'failed' || choiceResult.value.content.trim().length === 0) {
    logger.warn('gateway_connection_test_failed', { reason: 'malformed_body', statusCode: 200 });
    return Object.freeze({
      httpStatus: result.statusCode,
      latencyMs,
      reasonCode: 'malformed_body',
      result: 'failed',
      testedAt,
    });
  }

  logger.info('gateway_connection_test_passed', { statusCode: result.statusCode });
  return Object.freeze({
    httpStatus: result.statusCode,
    latencyMs,
    reasonCode: 'ok',
    result: 'passed',
    testedAt,
  });
}
