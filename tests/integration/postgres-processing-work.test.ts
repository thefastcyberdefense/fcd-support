import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresProcessingWork } from '../../src/persistence/postgres-processing-work.js';
import { insertSyntheticPendingEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let db: IsolatedTestDatabase;
let work: PostgresProcessingWork;
const at = new Date('2030-02-01T00:00:00.000Z');
beforeAll(async () => {
  db = await createIsolatedTestDatabase('processing_work');
  work = new PostgresProcessingWork(db.pool);
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.pool.query('truncate contacts, webhook_receipts restart identity cascade');
});
async function event(suffix = 'one'): Promise<string> {
  return insertSyntheticPendingEvent(db.pool, {
    channel: 'messenger',
    channelAccountId: 'PAGE_TEST_processing',
    contactId: `CONTACT_TEST_${suffix}`,
    eventKind: 'customer_message',
    messageText: 'Synthetic processing question',
    fixtureKey: `processing_${suffix}`,
    occurredAt: at,
  });
}
const claimInput = () => ({
  workerRef: 'WORKER_TEST_processing',
  evaluatedAt: at,
  limit: 10,
  leaseMilliseconds: 1000,
});
async function claim() {
  await event();
  await work.reconcile(10, at);
  const first = (await work.claim(claimInput()))[0];
  if (first === undefined) throw new Error('Synthetic claim missing');
  return first;
}

describe('durable processing work', () => {
  test('cannot complete a customer workflow before its remaining stages run', async () => {
    const first = await claim();
    await expect(
      work.finish({
        workRef: first.workRef,
        leaseRef: first.leaseRef,
        evaluatedAt: at,
        outcome: 'completed',
      }),
    ).rejects.toThrow('runtime_work_conflict');
  });
  test('repairs a crash after application with one resumable decision stage', async () => {
    const eventId = await event();
    await new PostgresConversationEventProcessor(db.pool).processEvent(eventId);
    expect(await work.reconcile(10, at)).toEqual({ created: 1 });
    expect(await work.reconcile(10, at)).toEqual({ created: 0 });
    expect(await work.claim(claimInput())).toMatchObject([
      { webhookEventId: eventId, stage: 'decide' },
    ]);
  });

  test('concurrent reconciliation and claims cannot duplicate logical work', async () => {
    await event('one');
    await event('two');
    const reconciled = await Promise.all([work.reconcile(10, at), work.reconcile(10, at)]);
    expect(reconciled.reduce((sum, result) => sum + result.created, 0)).toBe(2);
    const batches = await Promise.all([
      work.claim(claimInput()),
      work.claim({ ...claimInput(), workerRef: 'WORKER_TEST_other' }),
    ]);
    const refs = batches.flat().map((value) => value.workRef);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
  });

  test('expired leases retain their stage and reject the original owner', async () => {
    const first = await claim();
    await work.advance({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      stage: 'decide',
    });
    const reclaimed = await work.claim({
      ...claimInput(),
      evaluatedAt: new Date(at.getTime() + 1000),
    });
    expect(reclaimed).toMatchObject([{ workRef: first.workRef, stage: 'decide' }]);
    expect(reclaimed[0]?.leaseRef).not.toBe(first.leaseRef);
    await expect(
      work.finish({
        workRef: first.workRef,
        leaseRef: first.leaseRef,
        evaluatedAt: new Date(at.getTime() + 1000),
        outcome: 'blocked',
      }),
    ).rejects.toThrow('runtime_work_conflict');
  });

  test('stage advances are monotonic, replay safe and lease checked', async () => {
    const first = await claim();
    const input = {
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      stage: 'decide' as const,
    };
    await work.advance(input);
    await work.advance(input);
    await expect(work.advance({ ...input, stage: 'apply' })).rejects.toThrow(
      'runtime_work_conflict',
    );
    await expect(
      work.advance({ ...input, leaseRef: 'LEASE_TEST_wrong', stage: 'model' }),
    ).rejects.toThrow('runtime_work_conflict');
    await work.advance({ ...input, stage: 'enqueue' });
    await work.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      outcome: 'completed',
    });
    await work.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      outcome: 'completed',
    });
    await expect(
      work.finish({
        workRef: first.workRef,
        leaseRef: first.leaseRef,
        evaluatedAt: at,
        outcome: 'failed',
      }),
    ).rejects.toThrow('runtime_work_conflict');
    expect(await work.claim(claimInput())).toEqual([]);
  });

  test('stage jumps and foreign work references fail closed', async () => {
    const first = await claim();
    await expect(
      work.advance({
        workRef: first.workRef,
        leaseRef: first.leaseRef,
        evaluatedAt: at,
        stage: 'enqueue',
      }),
    ).rejects.toThrow('runtime_work_conflict');
    await expect(
      work.finish({
        workRef: 'WORK_TEST_absent',
        leaseRef: first.leaseRef,
        evaluatedAt: at,
        outcome: 'blocked',
      }),
    ).rejects.toThrow('runtime_work_conflict');
    await expect(work.claim({ ...claimInput(), limit: 1001 })).rejects.toThrow(
      'runtime_work_invalid',
    );
  });

  test('quarantined source cannot be newly reconciled or claimed', async () => {
    const eventId = await event();
    await db.pool.query(`create table runtime_restore_quarantine (
      source_kind text not null, source_id bigint not null, restore_ref text not null,
      primary key(source_kind, source_id))`);
    try {
      await db.pool.query(
        "insert into runtime_restore_quarantine values ('webhook_event',$1,'RESTORE_TEST_quarantine')",
        [eventId],
      );
      expect(await work.reconcile(10, at)).toEqual({ created: 0 });
      await db.pool.query('truncate runtime_restore_quarantine');
      expect(await work.reconcile(10, at)).toEqual({ created: 1 });
      await db.pool.query(
        "insert into runtime_restore_quarantine values ('webhook_event',$1,'RESTORE_TEST_quarantine')",
        [eventId],
      );
      expect(await work.claim(claimInput())).toEqual([]);
    } finally {
      await db.pool.query('drop table runtime_restore_quarantine');
    }
  });

  test('completed noncustomer applications never acquire reply work', async () => {
    const id = await insertSyntheticPendingEvent(db.pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_processing',
      contactId: 'CONTACT_TEST_echo',
      eventKind: 'business_message_echo',
      fixtureKey: 'processing_echo',
      occurredAt: at,
    });
    await new PostgresConversationEventProcessor(db.pool).processEvent(id);
    expect(await work.reconcile(10, at)).toEqual({ created: 0 });
  });

  test('work rows contain references and closed states only', async () => {
    await claim();
    const rows = await db.pool.query('select * from runtime_processing_work');
    expect(JSON.stringify(rows.rows)).not.toContain('Synthetic processing question');
    expect(JSON.stringify(rows.rows)).not.toContain('CONTACT_TEST');
    await expect(
      db.pool.query("update runtime_processing_work set stage='synthetic_unknown'"),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
