import { describe, expect, test, vi } from 'vitest';

import {
  NotificationWorker,
  type NotificationWorkStore,
} from '../src/notifications/notification-worker.js';
import type { NotificationClaim } from '../src/notifications/notification-types.js';

const at = new Date('2030-04-01T00:00:00.000Z');
const claim: NotificationClaim = {
  workRef: 'NOTIFICATION_TEST_synthetic',
  leaseRef: 'LEASE_TEST_synthetic',
  attemptNumber: 1,
  notification: {
    schemaVersion: 1,
    type: 'operator_support_escalation',
    reference: 'NOTIFICATION_TEST_synthetic',
    occurredAt: at,
    idempotencyKey: 'NOTIFICATION_TEST_synthetic',
  },
};
function fixture() {
  const events: string[] = [];
  const store: NotificationWorkStore = {
    reconcile: vi.fn(() => {
      events.push('reconcile');
      return Promise.resolve({ created: 1 });
    }),
    expire: vi.fn(() => {
      events.push('expire');
      return Promise.resolve({ expired: 0 });
    }),
    claim: vi.fn(() => {
      events.push('claim');
      return Promise.resolve([claim]);
    }),
    authorize: vi.fn(() => {
      events.push('authorize');
      return Promise.resolve(true);
    }),
    finish: vi.fn(() => {
      events.push('finish');
      return Promise.resolve();
    }),
  };
  const client = {
    send: vi.fn(() => {
      events.push('send');
      return Promise.resolve({ status: 'accepted' as const, reasonCode: 'ok' as const });
    }),
  };
  const worker = new NotificationWorker({
    store,
    client,
    now: () => at,
    batchSize: 2,
    leaseMilliseconds: 5000,
    maximumCallMilliseconds: 1000,
  });
  return { store, client, worker, events };
}
describe('durable notification worker', () => {
  test('reconciles and expires, rechecks authorization then settles exact leased work', async () => {
    const f = fixture();
    expect(await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic' })).toEqual({
      claimed: 1,
      accepted: 1,
      retryable: 0,
      failed: 0,
      skipped: 0,
      unsettled: 0,
    });
    expect(f.events).toEqual(['expire', 'reconcile', 'claim', 'authorize', 'send', 'finish']);
    expect(f.store.authorize).toHaveBeenCalledWith({
      workRef: claim.workRef,
      leaseRef: claim.leaseRef,
      evaluatedAt: at,
      requiredLeaseMilliseconds: 1000,
    });
    expect(f.store.finish).toHaveBeenCalledWith({
      workRef: claim.workRef,
      leaseRef: claim.leaseRef,
      evaluatedAt: at,
      result: { status: 'accepted', reasonCode: 'ok' },
    });
  });
  test('erasure, retention expiry, quarantine or lease denial cannot dispatch cached claims', async () => {
    const f = fixture();
    vi.mocked(f.store.authorize).mockResolvedValue(false);
    expect((await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic' })).skipped).toBe(1);
    expect(f.client.send).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
  });
  test('failed authorization cannot produce a notification', async () => {
    const f = fixture();
    vi.mocked(f.store.authorize).mockRejectedValue(new Error('Synthetic DB unavailable'));
    expect((await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic' })).unsettled).toBe(1);
    expect(f.client.send).not.toHaveBeenCalled();
  });
  test('transport ambiguity settles as retryable with the unchanged source key', async () => {
    const f = fixture();
    f.client.send.mockRejectedValue(new Error('Synthetic transport ambiguous'));
    expect((await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic' })).retryable).toBe(1);
    expect(f.client.send).toHaveBeenCalledWith({ notification: claim.notification });
    expect(f.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({ result: { status: 'retryable', reasonCode: 'transport_failure' } }),
    );
  });
  test('lost durable settlement remains unsettled for lease expiry rather than false delivery', async () => {
    const f = fixture();
    vi.mocked(f.store.finish).mockRejectedValue(new Error('Synthetic acknowledgement lost'));
    const result = await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic' });
    expect(result.accepted).toBe(0);
    expect(result.unsettled).toBe(1);
  });
  test('already aborted batches perform no database or network work', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      (await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic', signal: controller.signal }))
        .claimed,
    ).toBe(0);
    expect(f.events).toEqual([]);
  });
  test('shutdown after authorization does not dispatch', async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.store.authorize).mockImplementation(() => {
      controller.abort();
      return Promise.resolve(true);
    });
    await f.worker.runBatch({ workerRef: 'WORKER_TEST_synthetic', signal: controller.signal });
    expect(f.client.send).not.toHaveBeenCalled();
  });
  test('later claims are authorized using current time rather than the batch time', async () => {
    const f = fixture();
    let time = at.getTime();
    vi.mocked(f.store.claim).mockResolvedValue([
      claim,
      { ...claim, workRef: 'NOTIFICATION_TEST_later', leaseRef: 'LEASE_TEST_later' },
    ]);
    f.client.send.mockImplementation(() => {
      time += 1000;
      return Promise.resolve({ status: 'accepted', reasonCode: 'ok' });
    });
    const worker = new NotificationWorker({
      store: f.store,
      client: f.client,
      now: () => new Date(time),
      batchSize: 2,
      leaseMilliseconds: 5000,
      maximumCallMilliseconds: 1000,
    });
    await worker.runBatch({ workerRef: 'WORKER_TEST_synthetic' });
    expect(
      vi.mocked(f.store.authorize).mock.calls.map(([input]) => input.evaluatedAt.getTime()),
    ).toEqual([at.getTime(), at.getTime() + 1000]);
  });
});
