import { z } from 'zod';

import type { N8nClient } from './n8n-client.js';
import type { NotificationClaim, N8nResult } from './notification-types.js';

export interface NotificationWorkStore {
  readonly reconcile: (limit: number, evaluatedAt: Date) => Promise<{ readonly created: number }>;
  readonly expire: (input: {
    readonly evaluatedAt: Date;
    readonly limit: number;
  }) => Promise<{ readonly expired: number }>;
  readonly claim: (input: {
    readonly workerRef: string;
    readonly evaluatedAt: Date;
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }) => Promise<readonly NotificationClaim[]>;
  readonly authorize: (input: {
    readonly workRef: string;
    readonly leaseRef: string;
    readonly evaluatedAt: Date;
    readonly requiredLeaseMilliseconds: number;
  }) => Promise<boolean>;
  readonly finish: (input: {
    readonly workRef: string;
    readonly leaseRef: string;
    readonly evaluatedAt: Date;
    readonly result: N8nResult;
  }) => Promise<void>;
}
export interface NotificationWorkerOptions {
  readonly store: NotificationWorkStore;
  readonly client: N8nClient;
  readonly now: () => Date;
  readonly batchSize: number;
  readonly leaseMilliseconds: number;
  readonly maximumCallMilliseconds: number;
}
export class NotificationWorker {
  private readonly options: NotificationWorkerOptions;
  public constructor(options: NotificationWorkerOptions) {
    if (
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 1000 ||
      !Number.isSafeInteger(options.leaseMilliseconds) ||
      options.leaseMilliseconds < 1000 ||
      options.leaseMilliseconds > 600000 ||
      !Number.isSafeInteger(options.maximumCallMilliseconds) ||
      options.maximumCallMilliseconds < 1 ||
      options.maximumCallMilliseconds > 300000 ||
      options.leaseMilliseconds <= options.maximumCallMilliseconds ||
      typeof options.now !== 'function'
    )
      throw new TypeError('notification_worker_configuration_invalid');
    this.options = Object.freeze({ ...options });
  }
  public async runBatch(input: {
    readonly workerRef: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly claimed: number;
    readonly accepted: number;
    readonly retryable: number;
    readonly failed: number;
    readonly skipped: number;
    readonly unsettled: number;
  }> {
    if (
      !z
        .strictObject({
          workerRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
          signal: z.instanceof(AbortSignal).optional(),
        })
        .safeParse(input).success
    )
      throw new TypeError('notification_work_invalid');
    const counts = { claimed: 0, accepted: 0, retryable: 0, failed: 0, skipped: 0, unsettled: 0 };
    const aborted = () => input.signal?.aborted === true;
    if (aborted()) return Object.freeze(counts);
    const { store, client, now, batchSize, leaseMilliseconds, maximumCallMilliseconds } =
      this.options;
    await store.expire({ evaluatedAt: now(), limit: batchSize });
    if (aborted()) return Object.freeze(counts);
    await store.reconcile(batchSize, now());
    if (aborted()) return Object.freeze(counts);
    const claims = await store.claim({
      workerRef: input.workerRef,
      evaluatedAt: now(),
      limit: batchSize,
      leaseMilliseconds,
    });
    counts.claimed = claims.length;
    for (const claim of claims) {
      if (aborted()) break;
      try {
        if (
          !(await store.authorize({
            workRef: claim.workRef,
            leaseRef: claim.leaseRef,
            evaluatedAt: now(),
            requiredLeaseMilliseconds: maximumCallMilliseconds,
          }))
        ) {
          counts.skipped += 1;
          continue;
        }
      } catch {
        counts.unsettled += 1;
        continue;
      }
      if (aborted()) break;
      let result: N8nResult;
      try {
        result = await client.send({
          notification: claim.notification,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        result = { status: 'retryable', reasonCode: 'transport_failure' };
      }
      try {
        await store.finish({
          workRef: claim.workRef,
          leaseRef: claim.leaseRef,
          evaluatedAt: now(),
          result,
        });
        if (result.status === 'accepted') counts.accepted += 1;
        else if (result.status === 'retryable') counts.retryable += 1;
        else counts.failed += 1;
      } catch {
        counts.unsettled += 1;
      }
    }
    return Object.freeze(counts);
  }
}
