/* eslint-disable @typescript-eslint/require-await -- async mocks implement promise-based boundaries */
import { describe, expect, test, vi } from 'vitest';

import { readPreparedOutboundRequest } from '../src/outbound/outbound-request.js';
import { OutboundWorker, type OutboundWorkerStore } from '../src/outbound/outbound-worker.js';
import type { OutboundProviderResult } from '../src/outbound/outbound-types.js';
import type { ClaimedOutboundIntent } from '../src/persistence/postgres-outbound-work-store.js';

const evaluatedAt = new Date('2026-09-17T01:00:00.000Z');

function claim(
  intentRef: string,
  channel: 'messenger' | 'whatsapp' = 'whatsapp',
): ClaimedOutboundIntent {
  return {
    channel,
    intentRef,
    leaseExpiresAt: new Date('2026-09-17T01:01:00.000Z'),
    leaseRef: `LEASE_TEST_${intentRef}`,
    messageKind: 'support_text' as const,
    purpose: 'customer_support' as const,
  };
}

function textDispatch(intentRef: string, channel: 'messenger' | 'whatsapp' = 'whatsapp') {
  return {
    channel,
    channelAccountId: channel === 'whatsapp' ? 'PHONE_TEST_worker' : 'PAGE_TEST_worker',
    messageKind: 'support_text' as const,
    providerTimeoutMs: 250,
    recipient: `RECIPIENT_TEST_${intentRef}`,
    text: 'Synthetic support answer.',
  };
}

function authorized(intentRef: string, channel: 'messenger' | 'whatsapp' = 'whatsapp') {
  return {
    attemptNumber: 1,
    attemptRef: `ATTEMPT_TEST_${intentRef}`,
    dispatch: textDispatch(intentRef, channel),
    status: 'authorized' as const,
  };
}

function accepted(intentRef: string): OutboundProviderResult {
  return { providerMessageId: `META_MESSAGE_TEST_${intentRef}`, status: 'accepted' };
}

function baseStore(claims: readonly ClaimedOutboundIntent[] = [claim('one')]) {
  return {
    authorizeAttempt: vi.fn<OutboundWorkerStore['authorizeAttempt']>(async ({ intentRef }) =>
      authorized(intentRef),
    ),
    claimBatch: vi.fn<OutboundWorkerStore['claimBatch']>(async () => claims),
    markDispatchStarted: vi.fn<OutboundWorkerStore['markDispatchStarted']>(async () => ({
      status: 'started',
    })),
    recordProviderResult: vi.fn<OutboundWorkerStore['recordProviderResult']>(async ({ result }) => {
      if (result.status === 'accepted') {
        return { intentState: 'provider_accepted', status: 'recorded' };
      }
      if (result.status === 'delivery_unknown') {
        return { intentState: 'delivery_unknown', status: 'recorded' };
      }
      return { intentState: 'pending', nextAttemptAt: evaluatedAt, status: 'recorded' };
    }),
  } satisfies OutboundWorkerStore;
}

describe('OutboundWorker', () => {
  test('samples time again before the second authorization in a slow batch', async () => {
    let now = evaluatedAt;
    const store = baseStore([claim('first'), claim('second')]);
    const denied: string[] = [];
    store.authorizeAttempt.mockImplementation(async ({ intentRef, evaluatedAt: checkedAt }) => {
      if (checkedAt > evaluatedAt) {
        denied.push('window_closed');
        return { status: 'denied', reason: 'window_closed' };
      }
      return authorized(intentRef);
    });
    const provider = {
      send: vi.fn(async () => {
        now = new Date(evaluatedAt.getTime() + 1000);
        return accepted('first');
      }),
    };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => now,
    });
    const result = await worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_clock' });
    expect(result.accepted).toBe(1);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(denied).toContain('window_closed');
    expect(store.recordProviderResult).toHaveBeenCalledWith(
      expect.objectContaining({ completedAt: now }),
    );
  });
  test('does not claim work when the batch signal is already canceled', async () => {
    const store = baseStore();
    const provider = { send: vi.fn(async () => accepted('unexpected')) };
    const controller = new AbortController();
    controller.abort();
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({
        evaluatedAt,
        signal: controller.signal,
        workerRef: 'WORKER_TEST_preaborted',
      }),
    ).resolves.toEqual({
      accepted: 0,
      canceled: 0,
      claimed: 0,
      deferred: 0,
      failed: 0,
      unknown: 0,
    });
    expect(store.claimBatch).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  test('claims, authorizes, marks dispatch, calls once, and persists one accepted result', async () => {
    const order: string[] = [];
    const store = baseStore();
    store.claimBatch.mockImplementation(async () => {
      order.push('claim');
      return [claim('one')];
    });
    store.authorizeAttempt.mockImplementation(async () => {
      order.push('authorize');
      return authorized('one');
    });
    store.markDispatchStarted.mockImplementation(async () => {
      order.push('dispatch-start');
      return { status: 'started' as const };
    });
    store.recordProviderResult.mockImplementation(async () => {
      order.push('persist');
      return { intentState: 'provider_accepted' as const, status: 'recorded' as const };
    });
    const provider = {
      send: vi.fn(async ({ request }: { readonly request: unknown }) => {
        order.push('provider');
        const context = readPreparedOutboundRequest(request);
        expect(context).toMatchObject({
          attemptRef: 'ATTEMPT_TEST_one',
          channel: 'whatsapp',
          channelAccountId: 'PHONE_TEST_worker',
          intentRef: 'one',
          maximumResponseBytes: 8192,
          messageKind: 'support_text',
          providerTimeoutMs: 250,
        });
        return accepted('one');
      }),
    };
    const worker = new OutboundWorker({
      maximumResponseBytes: 8192,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_one' })).resolves.toEqual({
      accepted: 1,
      canceled: 0,
      claimed: 1,
      deferred: 0,
      failed: 0,
      unknown: 0,
    });
    expect(order).toEqual(['claim', 'authorize', 'dispatch-start', 'provider', 'persist']);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(store.recordProviderResult).toHaveBeenCalledWith({
      attemptRef: 'ATTEMPT_TEST_one',
      completedAt: evaluatedAt,
      leaseRef: 'LEASE_TEST_one',
      result: accepted('one'),
    });
  });

  test('builds only the closed Messenger text and WhatsApp fixed-template variants', async () => {
    const claims = [
      claim('messenger', 'messenger'),
      { ...claim('template'), messageKind: 'fixed_template' as const },
    ];
    const store = baseStore(claims);
    store.authorizeAttempt
      .mockResolvedValueOnce(authorized('messenger', 'messenger'))
      .mockResolvedValueOnce({
        attemptNumber: 1,
        attemptRef: 'ATTEMPT_TEST_template',
        dispatch: {
          channel: 'whatsapp' as const,
          channelAccountId: 'PHONE_TEST_worker',
          locale: 'bn_BD' as const,
          messageKind: 'fixed_template' as const,
          providerTimeoutMs: 250,
          recipient: 'RECIPIENT_TEST_template',
          templateName: 'support_followup_test',
        },
        status: 'authorized' as const,
      });
    const contexts: unknown[] = [];
    const provider = {
      send: vi.fn(async ({ request }: { readonly request: unknown }) => {
        contexts.push(readPreparedOutboundRequest(request));
        return accepted(String(contexts.length));
      }),
    };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_shapes' }),
    ).resolves.toMatchObject({
      accepted: 2,
      claimed: 2,
    });
    expect(contexts).toMatchObject([
      { channel: 'messenger', messageKind: 'support_text' },
      { channel: 'whatsapp', messageKind: 'fixed_template' },
    ]);
  });

  test('never builds or calls when authorization is denied or an attempt is already active', async () => {
    const store = baseStore([claim('denied'), claim('duplicate')]);
    store.authorizeAttempt
      .mockResolvedValueOnce({ reason: 'pause_active' as const, status: 'denied' as const })
      .mockResolvedValueOnce({
        attemptNumber: 1,
        attemptRef: 'ATTEMPT_TEST_duplicate',
        status: 'duplicate' as const,
      });
    const provider = { send: vi.fn(async () => accepted('unexpected')) };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_closed' }),
    ).resolves.toEqual({
      accepted: 0,
      canceled: 1,
      claimed: 2,
      deferred: 1,
      failed: 0,
      unknown: 0,
    });
    expect(provider.send).not.toHaveBeenCalled();
    expect(store.markDispatchStarted).not.toHaveBeenCalled();
    expect(store.recordProviderResult).not.toHaveBeenCalled();
  });

  test('maps persisted retry, terminal failure, and unknown outcomes into closed batch counts', async () => {
    const claims = [claim('retry'), claim('failed'), claim('unknown')];
    const store = baseStore(claims);
    store.authorizeAttempt.mockImplementation(async ({ intentRef }) => authorized(intentRef));
    store.recordProviderResult
      .mockResolvedValueOnce({
        intentState: 'pending' as const,
        nextAttemptAt: new Date('2026-09-17T01:00:01.000Z'),
        status: 'recorded' as const,
      })
      .mockResolvedValueOnce({
        intentState: 'terminal_failed' as const,
        status: 'recorded' as const,
      })
      .mockResolvedValueOnce({
        intentState: 'delivery_unknown' as const,
        status: 'recorded' as const,
      });
    const providerResults: OutboundProviderResult[] = [
      { reasonCode: 'provider_rejected', retryAfter: undefined, status: 'definitely_rejected' },
      { reasonCode: 'provider_rejected', retryAfter: undefined, status: 'definitely_rejected' },
      { reasonCode: 'timeout', status: 'delivery_unknown' },
    ];
    const provider = { send: vi.fn(async () => providerResults.shift() ?? accepted('unexpected')) };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_results' }),
    ).resolves.toEqual({
      accepted: 0,
      canceled: 0,
      claimed: 3,
      deferred: 1,
      failed: 1,
      unknown: 1,
    });
    expect(provider.send).toHaveBeenCalledTimes(3);
  });

  test('a pre-dispatch database failure never calls the provider and does not stop later claims', async () => {
    const store = baseStore([claim('broken'), claim('healthy')]);
    store.authorizeAttempt
      .mockRejectedValueOnce(new Error('synthetic database failure'))
      .mockResolvedValueOnce(authorized('healthy'));
    const provider = { send: vi.fn(async () => accepted('healthy')) };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_db_before' }),
    ).resolves.toEqual({
      accepted: 1,
      canceled: 0,
      claimed: 2,
      deferred: 0,
      failed: 1,
      unknown: 0,
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  test('a provider throw or post-dispatch persistence failure is unknown without compensating send', async () => {
    const store = baseStore([claim('transport'), claim('persistence')]);
    store.authorizeAttempt.mockImplementation(async ({ intentRef }) => authorized(intentRef));
    store.recordProviderResult.mockRejectedValueOnce(new Error('synthetic database failure'));
    const provider = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('synthetic transport failure'))
        .mockResolvedValueOnce(accepted('persistence')),
    };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_unknown' }),
    ).resolves.toEqual({
      accepted: 0,
      canceled: 0,
      claimed: 2,
      deferred: 0,
      failed: 0,
      unknown: 2,
    });
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(store.recordProviderResult).toHaveBeenCalledTimes(1);
  });

  test('cancellation before dispatch is persisted as deferred without a provider call', async () => {
    const store = baseStore();
    const controller = new AbortController();
    store.authorizeAttempt.mockImplementation(async () => {
      controller.abort();
      return authorized('one');
    });
    const provider = { send: vi.fn(async () => accepted('unexpected')) };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, signal: controller.signal, workerRef: 'WORKER_TEST_abort' }),
    ).resolves.toMatchObject({ claimed: 1, deferred: 1 });
    expect(store.markDispatchStarted).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
    expect(store.recordProviderResult).toHaveBeenCalledWith({
      attemptRef: 'ATTEMPT_TEST_one',
      completedAt: evaluatedAt,
      leaseRef: 'LEASE_TEST_one',
      result: { status: 'aborted_before_dispatch' },
    });
  });

  test('normalizes an adapter preflight abort after dispatch_started to delivery_unknown', async () => {
    const store = baseStore();
    const provider = {
      send: vi.fn(async () => ({ status: 'aborted_before_dispatch' as const })),
    };
    const worker = new OutboundWorker({
      maximumResponseBytes: 4096,
      provider,
      store,
      now: () => evaluatedAt,
    });

    await expect(
      worker.runBatch({ evaluatedAt, workerRef: 'WORKER_TEST_late_abort' }),
    ).resolves.toMatchObject({
      claimed: 1,
      unknown: 1,
    });
    expect(store.recordProviderResult).toHaveBeenCalledWith({
      attemptRef: 'ATTEMPT_TEST_one',
      completedAt: evaluatedAt,
      leaseRef: 'LEASE_TEST_one',
      result: { reasonCode: 'network_failure', status: 'delivery_unknown' },
    });
  });
});
