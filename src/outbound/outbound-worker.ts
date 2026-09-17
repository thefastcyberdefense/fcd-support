import { z } from 'zod';

import type {
  AuthorizeAttemptResult,
  ClaimedOutboundIntent,
  DispatchStartResult,
  RecordProviderResultResult,
} from '../persistence/postgres-outbound-work-store.js';
import {
  buildMessengerTextRequest,
  buildWhatsAppFixedTemplateRequest,
  buildWhatsAppTextRequest,
  type PreparedOutboundRequest,
} from './outbound-request.js';
import type { OutboundProviderResult } from './outbound-types.js';

const opaqueReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));
const batchInputSchema = z.strictObject({
  evaluatedAt: validDate,
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
  workerRef: opaqueReference,
});

export interface OutboundBatchResult {
  readonly accepted: number;
  readonly canceled: number;
  readonly claimed: number;
  readonly deferred: number;
  readonly failed: number;
  readonly unknown: number;
}

export interface OutboundWorkerStore {
  authorizeAttempt(input: {
    readonly evaluatedAt: Date;
    readonly intentRef: string;
    readonly leaseRef: string;
  }): Promise<AuthorizeAttemptResult>;
  claimBatch(input: {
    readonly claimedAt: Date;
    readonly workerRef: string;
  }): Promise<readonly ClaimedOutboundIntent[]>;
  markDispatchStarted(input: {
    readonly attemptRef: string;
    readonly leaseRef: string;
    readonly startedAt: Date;
  }): Promise<DispatchStartResult>;
  recordProviderResult(input: {
    readonly attemptRef: string;
    readonly completedAt: Date;
    readonly leaseRef: string;
    readonly result: OutboundProviderResult;
  }): Promise<RecordProviderResultResult>;
}

export interface OutboundWorkerProvider {
  send(input: {
    readonly request: PreparedOutboundRequest;
    readonly signal?: AbortSignal;
  }): Promise<OutboundProviderResult>;
}

export interface OutboundWorkerOptions {
  readonly maximumResponseBytes: number;
  readonly provider: OutboundWorkerProvider;
  readonly store: OutboundWorkerStore;
}

interface MutableBatchResult {
  accepted: number;
  canceled: number;
  claimed: number;
  deferred: number;
  failed: number;
  unknown: number;
}

function buildRequest(
  claim: ClaimedOutboundIntent,
  authorization: Extract<AuthorizeAttemptResult, { readonly status: 'authorized' }>,
  maximumResponseBytes: number,
): PreparedOutboundRequest {
  const common = {
    attemptRef: authorization.attemptRef,
    channelAccountId: authorization.dispatch.channelAccountId,
    intentRef: claim.intentRef,
    maximumResponseBytes,
    providerTimeoutMs: authorization.dispatch.providerTimeoutMs,
    recipient: authorization.dispatch.recipient,
  } as const;
  if (authorization.dispatch.messageKind === 'fixed_template') {
    return buildWhatsAppFixedTemplateRequest({
      ...common,
      locale: authorization.dispatch.locale,
      templateName: authorization.dispatch.templateName,
    });
  }
  if (authorization.dispatch.channel === 'messenger') {
    return buildMessengerTextRequest({ ...common, text: authorization.dispatch.text });
  }
  return buildWhatsAppTextRequest({ ...common, text: authorization.dispatch.text });
}

function countPersisted(result: RecordProviderResultResult, counts: MutableBatchResult): void {
  switch (result.intentState) {
    case 'provider_accepted':
      counts.accepted += 1;
      break;
    case 'pending':
      counts.deferred += 1;
      break;
    case 'delivery_unknown':
      counts.unknown += 1;
      break;
    case 'terminal_failed':
      counts.failed += 1;
      break;
  }
}

export class OutboundWorker {
  readonly #maximumResponseBytes: number;
  readonly #provider: OutboundWorkerProvider;
  readonly #store: OutboundWorkerStore;

  public constructor(options: OutboundWorkerOptions) {
    if (
      !Number.isSafeInteger(options.maximumResponseBytes) ||
      options.maximumResponseBytes < 1024 ||
      options.maximumResponseBytes > 1_048_576 ||
      typeof options.provider.send !== 'function' ||
      typeof options.store.claimBatch !== 'function' ||
      typeof options.store.authorizeAttempt !== 'function' ||
      typeof options.store.markDispatchStarted !== 'function' ||
      typeof options.store.recordProviderResult !== 'function'
    ) {
      throw new TypeError('Outbound worker configuration is invalid');
    }
    this.#maximumResponseBytes = options.maximumResponseBytes;
    this.#provider = options.provider;
    this.#store = options.store;
  }

  public async runBatch(inputValue: {
    readonly evaluatedAt: Date;
    readonly signal?: AbortSignal;
    readonly workerRef: string;
  }): Promise<OutboundBatchResult> {
    const input = batchInputSchema.parse(inputValue);
    if (input.signal?.aborted === true) {
      return Object.freeze({
        accepted: 0,
        canceled: 0,
        claimed: 0,
        deferred: 0,
        failed: 0,
        unknown: 0,
      });
    }
    const claims = await this.#store.claimBatch({
      claimedAt: input.evaluatedAt,
      workerRef: input.workerRef,
    });
    const counts: MutableBatchResult = {
      accepted: 0,
      canceled: 0,
      claimed: claims.length,
      deferred: 0,
      failed: 0,
      unknown: 0,
    };
    for (const claim of claims) {
      await this.#processClaim(
        claim,
        {
          evaluatedAt: input.evaluatedAt,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        counts,
      );
    }
    return Object.freeze({ ...counts });
  }

  async #processClaim(
    claim: ClaimedOutboundIntent,
    input: { readonly evaluatedAt: Date; readonly signal?: AbortSignal },
    counts: MutableBatchResult,
  ): Promise<void> {
    let authorization: AuthorizeAttemptResult;
    try {
      authorization = await this.#store.authorizeAttempt({
        evaluatedAt: input.evaluatedAt,
        intentRef: claim.intentRef,
        leaseRef: claim.leaseRef,
      });
    } catch {
      counts.failed += 1;
      return;
    }
    if (authorization.status === 'denied') {
      counts.canceled += 1;
      return;
    }
    if (authorization.status === 'duplicate') {
      counts.deferred += 1;
      return;
    }

    if (input.signal?.aborted === true) {
      try {
        const persisted = await this.#store.recordProviderResult({
          attemptRef: authorization.attemptRef,
          completedAt: input.evaluatedAt,
          leaseRef: claim.leaseRef,
          result: { status: 'aborted_before_dispatch' },
        });
        countPersisted(persisted, counts);
      } catch {
        counts.failed += 1;
      }
      return;
    }

    let request: PreparedOutboundRequest;
    try {
      request = buildRequest(claim, authorization, this.#maximumResponseBytes);
    } catch {
      counts.failed += 1;
      return;
    }
    try {
      const started = await this.#store.markDispatchStarted({
        attemptRef: authorization.attemptRef,
        leaseRef: claim.leaseRef,
        startedAt: input.evaluatedAt,
      });
      if (started.status === 'duplicate') {
        counts.deferred += 1;
        return;
      }
    } catch {
      counts.failed += 1;
      return;
    }

    let providerResult: OutboundProviderResult;
    try {
      const result = await this.#provider.send({
        request,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      providerResult =
        result.status === 'aborted_before_dispatch'
          ? { reasonCode: 'network_failure', status: 'delivery_unknown' }
          : result;
    } catch {
      counts.unknown += 1;
      return;
    }
    try {
      const persisted = await this.#store.recordProviderResult({
        attemptRef: authorization.attemptRef,
        completedAt: input.evaluatedAt,
        leaseRef: claim.leaseRef,
        result: providerResult,
      });
      countPersisted(persisted, counts);
    } catch {
      counts.unknown += 1;
    }
  }
}
