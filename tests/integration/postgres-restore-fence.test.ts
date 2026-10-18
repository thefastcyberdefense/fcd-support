import { afterAll, beforeAll, expect, test } from 'vitest';
import { PostgresRestoreFence } from '../../src/persistence/postgres-restore-fence.js';
import { PostgresProcessingWork } from '../../src/persistence/postgres-processing-work.js';
import { PostgresNotificationWork } from '../../src/persistence/postgres-notification-work.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
} from './policy-fixtures.js';
import {
  createIsolatedTestDatabase,
  rollbackThroughMigration,
  type IsolatedTestDatabase,
} from './test-database.js';
import { seedReviewedRestore } from './restore-fixtures.js';

let target: IsolatedTestDatabase;
const at = new Date('2030-02-01T00:00:00.000Z');
const command = { restoreRef: 'RESTORE_TEST_fence', evaluatedAt: at };
beforeAll(async () => {
  target = await createIsolatedTestDatabase('restore_fence');
});
afterAll(async () => {
  await target.dispose();
});

test('fences inherited admitted events and processing work once under exact replay', async () => {
  const eventId = await insertSyntheticPendingEvent(target.pool, {
    fixtureKey: 'restore_fence_pending',
    channel: 'messenger',
    channelAccountId: 'PAGE_TEST_restore_fence',
    contactId: 'CONTACT_TEST_restore_fence',
    eventKind: 'customer_message',
    occurredAt: at,
    messageText: 'Synthetic restored pending customer event',
  });
  const work = new PostgresProcessingWork(target.pool);
  await work.reconcile(10, at);
  const fence = new PostgresRestoreFence(target.pool);
  const result = await fence.quarantine(command);
  expect(result.quarantined).toBeGreaterThanOrEqual(2);
  expect(await fence.quarantine(command)).toEqual(result);
  expect(await target.pool.query('select state from runtime_processing_work')).toMatchObject({
    rows: [{ state: 'quarantined' }],
  });
  expect(
    await work.claim({
      workerRef: 'WORKER_TEST_after_restore',
      evaluatedAt: at,
      limit: 10,
      leaseMilliseconds: 1000,
    }),
  ).toEqual([]);
  expect(
    await target.pool.query(
      "select count(*)::int as count from runtime_restore_quarantine where source_kind='webhook_event' and source_id=$1",
      [eventId],
    ),
  ).toMatchObject({ rows: [{ count: 1 }] });
});
test('a recovery hold blocks newly admitted processing independently of inherited source IDs', async () => {
  const work = new PostgresProcessingWork(target.pool);
  await insertSyntheticPendingEvent(target.pool, {
    fixtureKey: 'restore_fence_new',
    channel: 'messenger',
    channelAccountId: 'PAGE_TEST_restore_fence',
    contactId: 'CONTACT_TEST_restore_fence_new',
    eventKind: 'customer_message',
    occurredAt: at,
    messageText: 'Synthetic newly admitted event after restore fence',
  });
  expect(await work.reconcile(10, at)).toEqual({ created: 0 });
  await expect(target.pool.query('delete from runtime_recovery_holds')).rejects.toMatchObject({
    code: '55000',
  });
});
test('fence preserves notification attempt evidence and blocks inherited source regeneration', async () => {
  const isolated = await createIsolatedTestDatabase('restore_notification_fence');
  try {
    const source = await insertSyntheticAppliedCustomerEvent(isolated.pool, {
      fixtureKey: 'restore_notification_source',
      occurredAt: at,
      identity: {
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST_restore_notification',
        externalContactId: 'CONTACT_TEST_restore_notification',
      },
    });
    await isolated.pool.query(
      `insert into outbound_escalation_outcomes
      (escalation_ref,conversation_id,reason_code,state,request_key,created_at,updated_at)
      values ('ESCALATION_TEST_restore',$1,'delivery_unknown','open','REQUEST_TEST_restore',$2,$2)`,
      [source.conversationId, at],
    );
    const work = new PostgresNotificationWork(isolated.pool, {
      maximumAttempts: 3,
      retryBaseMilliseconds: 100,
      retryMaximumMilliseconds: 1000,
    });
    expect(await work.reconcile(10, at)).toEqual({ created: 1 });
    const first = (
      await work.claim({
        workerRef: 'WORKER_TEST_restore_notification',
        evaluatedAt: at,
        limit: 10,
        leaseMilliseconds: 1000,
      })
    )[0];
    if (first === undefined) throw new Error('synthetic_notification_missing');
    await work.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'retryable', reasonCode: 'timeout' },
    });
    const later = new Date(at.getTime() + 100);
    const claim = (
      await work.claim({
        workerRef: 'WORKER_TEST_restore_notification_retry',
        evaluatedAt: later,
        limit: 10,
        leaseMilliseconds: 1000,
      })
    )[0];
    if (claim === undefined) throw new Error('synthetic_notification_retry_missing');
    await new PostgresRestoreFence(isolated.pool).quarantine({
      ...command,
      evaluatedAt: later,
      restoreRef: 'RESTORE_TEST_notification_fence',
    });
    expect(await isolated.pool.query('select state from notification_delivery_work')).toMatchObject(
      { rows: [{ state: 'quarantined' }] },
    );
    expect(
      await work.claim({
        workerRef: 'WORKER_TEST_after_notification_restore',
        evaluatedAt: later,
        limit: 10,
        leaseMilliseconds: 1000,
      }),
    ).toEqual([]);
    await expect(
      work.finish({
        workRef: claim.workRef,
        leaseRef: claim.leaseRef,
        evaluatedAt: later,
        result: { status: 'accepted', reasonCode: 'ok' },
      }),
    ).rejects.toThrow();
    expect(
      (
        await isolated.pool.query(
          'select attempt_number,status,reason_code from notification_delivery_attempts',
        )
      ).rows,
    ).toEqual([{ attempt_number: 1, status: 'retryable', reason_code: 'timeout' }]);
  } finally {
    await isolated.dispose();
  }
});
test('source deletion clock advances on tombstone changes but not ordinary marketing suppression', async () => {
  const source = await createIsolatedTestDatabase('restore_checkpoint_clock');
  try {
    const clock = async () =>
      (
        await source.pool.query<{ revision: string }>(
          'select revision from deletion_checkpoint_clock',
        )
      ).rows[0]?.revision;
    expect(await clock()).toBe('0');
    await source.pool.query(
      `insert into privacy_suppressions (identity_hmac,channel,category,reason_code,effective_at,key_version)
      values ($1,'messenger','marketing_opt_out','customer_opt_out',$2,'synthetic-v1')`,
      ['a'.repeat(64), at],
    );
    expect(await clock()).toBe('0');
    await source.pool.query(
      `insert into privacy_suppressions (identity_hmac,channel,category,reason_code,effective_at,key_version)
      values ($1,'messenger','deletion_tombstone','customer_deletion',$2,'synthetic-v1')`,
      ['b'.repeat(64), at],
    );
    expect(await clock()).toBe('1');
    await source.pool.query(
      "update privacy_suppressions set expires_at='2031-01-01T00:00:00Z' where category='deletion_tombstone'",
    );
    expect(await clock()).toBe('2');
    await source.pool.query("delete from privacy_suppressions where category='deletion_tombstone'");
    expect(await clock()).toBe('3');
  } finally {
    await source.dispose();
  }
});
test('a blocked downgrade rolls back removal of newer recovery migrations too', async () => {
  const database = await createIsolatedTestDatabase('restore_atomic_downgrade');
  try {
    await insertSyntheticPendingEvent(database.pool, {
      fixtureKey: 'atomic_downgrade',
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_atomic_downgrade',
      contactId: 'CONTACT_TEST_atomic_downgrade',
      eventKind: 'customer_message',
      occurredAt: at,
      messageText: 'Synthetic downgrade guard fixture',
    });
    await new PostgresProcessingWork(database.pool).reconcile(10, at);
    await expect(rollbackThroughMigration(database, 14)).rejects.toMatchObject({ code: '55000' });
    expect(
      (
        await database.pool.query(
          "select to_regclass('runtime_restore_quarantine') is not null as present",
        )
      ).rows,
    ).toEqual([{ present: true }]);
  } finally {
    await database.dispose();
  }
});
test('only a current administrator review after the hold can release new work', async () => {
  const database = await createIsolatedTestDatabase('restore_review_guard');
  try {
    await seedReviewedRestore(database.pool, 'RESTORE_TEST_prior_reviewed', at);
    await new PostgresRestoreFence(database.pool).quarantine({
      restoreRef: 'RESTORE_TEST_review_guard',
      evaluatedAt: at,
    });
    const actor = (
      await database.pool.query<{ id: string }>(
        "select id from admin_accounts where account_ref='ADMIN_TEST_reviewed_restore_fixture'",
      )
    ).rows[0];
    if (actor === undefined) throw new Error('synthetic_actor_missing');
    const review = (reviewedAt: Date) =>
      database.pool.query(
        `insert into runtime_recovery_reviews
      (restore_ref,reviewer_account_id,reviewed_at,consent_reconciled,suppression_reconciled,pause_reconciled,privacy_reconciled,channel_policy_reconciled)
      values('RESTORE_TEST_review_guard',$1,$2,true,true,true,true,true)`,
        [actor.id, reviewedAt],
      );
    await expect(review(new Date(at.getTime() - 1))).rejects.toMatchObject({ code: '23514' });
    await database.pool.query(
      "update admin_accounts set state='revoked',revoked_at=$2 where id=$1",
      [actor.id, at],
    );
    await expect(review(at)).rejects.toMatchObject({ code: '42501' });
    expect((await database.pool.query('select runtime_recovery_held() as held')).rows).toEqual([
      { held: true },
    ]);
    await database.pool.query(
      "update admin_accounts set state='active',revoked_at=null where id=$1",
      [actor.id],
    );
    await review(new Date(at.getTime() + 1));
    expect((await database.pool.query('select runtime_recovery_held() as held')).rows).toEqual([
      { held: false },
    ]);
  } finally {
    await database.dispose();
  }
});
