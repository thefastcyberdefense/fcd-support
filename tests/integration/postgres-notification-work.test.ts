import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresNotificationWork } from '../../src/persistence/postgres-notification-work.js';
import { seedReviewedRestore } from './restore-fixtures.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import {
  createIsolatedTestDatabase,
  rollbackThroughMigration,
  type IsolatedTestDatabase,
} from './test-database.js';

let db: IsolatedTestDatabase;
const at = new Date('2030-02-01T00:00:00.000Z');
const policy = { maximumAttempts: 3, retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 8000 };
let work: PostgresNotificationWork;
beforeAll(async () => {
  db = await createIsolatedTestDatabase('notification_work');
  work = new PostgresNotificationWork(db.pool, policy);
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.pool.query('truncate contacts, webhook_receipts restart identity cascade');
});

async function seedSource() {
  const source = await insertSyntheticAppliedCustomerEvent(db.pool, {
    fixtureKey: 'notification_work',
    identity: {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_notify',
      externalContactId: 'CONTACT_TEST_notify',
    },
    occurredAt: at,
  });
  await db.pool.query(
    `insert into support_escalation_outcomes
    (escalation_ref,conversation_id,source_webhook_event_id,reason_code,state,request_key,created_at,updated_at)
    values ('ESCALATION_TEST_notification',$1,$2,'provider_failure','open','REQUEST_TEST_notification',$3,$3)`,
    [source.conversationId, source.eventId, at],
  );
  return source;
}
const claimInput = () => ({
  workerRef: 'WORKER_TEST_notify',
  evaluatedAt: at,
  limit: 10,
  leaseMilliseconds: 1000,
});
async function claim() {
  await seedSource();
  await work.reconcile(10, at);
  const first = (await work.claim(claimInput()))[0];
  if (first === undefined) throw new Error('Synthetic notification missing');
  return first;
}

describe('PostgreSQL notification delivery work', () => {
  test.each([
    ['REQUEST MY DATA', 'operator_privacy_request'],
    ['STOP MARKETING', 'operator_marketing_opt_out'],
  ] as const)(
    'delivers %s notification without changing privacy or consent authority',
    async (messageText, type) => {
      const source = await insertSyntheticAppliedCustomerEvent(db.pool, {
        fixtureKey: 'notification_privacy',
        identity: {
          channel: 'messenger',
          channelAccountId: 'PAGE_TEST_privacy',
          externalContactId: 'CONTACT_TEST_privacy',
        },
        occurredAt: new Date('2025-02-01T00:00:00.000Z'),
        messageText,
      });
      const rights = new PostgresPrivacyRightsPolicy(db.pool, syntheticPrivacyKeyring);
      await rights.processAppliedEvent({
        sourceWebhookEventId: source.eventId,
        requestKey: 'REQUEST_TEST_privacy',
      });
      await db.pool.query(
        'update conversation_retention_states set expires_at=$2 where conversation_id=$1',
        [source.conversationId, new Date(at.getTime() + 86400000)],
      );
      await db.pool.query('update privacy_notification_intents set created_at=$1,updated_at=$1', [
        at,
      ]);
      const before = await db.pool.query(`select
      (select count(*)::int from privacy_request_events) as events,
      (select count(*)::int from consent_events) as consent_events,
      (select count(*)::int from privacy_suppressions) as suppressions`);
      expect(await work.reconcile(10, at)).toEqual({ created: 1 });
      const first = (await work.claim(claimInput()))[0];
      if (first === undefined) throw new Error('Synthetic privacy notification missing');
      expect(first.notification.type).toBe(type);
      await work.finish({
        workRef: first.workRef,
        leaseRef: first.leaseRef,
        evaluatedAt: at,
        result: { status: 'accepted', reasonCode: 'ok' },
      });
      expect(
        await db.pool.query('select state,attempt_count from privacy_notification_intents'),
      ).toMatchObject({ rows: [{ state: 'delivered', attempt_count: 1 }] });
      expect(
        (
          await db.pool.query(`select
      (select count(*)::int from privacy_request_events) as events,
      (select count(*)::int from consent_events) as consent_events,
      (select count(*)::int from privacy_suppressions) as suppressions`)
        ).rows,
      ).toEqual(before.rows);
    },
  );

  test('reconciles outbound escalation without resolving delivery or the escalation', async () => {
    const source = await insertSyntheticAppliedCustomerEvent(db.pool, {
      fixtureKey: 'notification_outbound',
      identity: {
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST_outbound',
        externalContactId: 'CONTACT_TEST_outbound',
      },
      occurredAt: at,
    });
    await db.pool.query(
      `insert into outbound_escalation_outcomes
      (escalation_ref,conversation_id,reason_code,state,request_key,created_at,updated_at)
      values ('ESCALATION_TEST_outbound',$1,'delivery_unknown','open','REQUEST_TEST_outbound',$2,$2)`,
      [source.conversationId, at],
    );
    expect(await work.reconcile(10, at)).toEqual({ created: 1 });
    const first = (await work.claim(claimInput()))[0];
    if (first === undefined) throw new Error('Synthetic outbound notification missing');
    expect(first.notification.type).toBe('operator_outbound_escalation');
    await work.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'accepted', reasonCode: 'ok' },
    });
    expect(await db.pool.query('select state from outbound_escalation_outcomes')).toMatchObject({
      rows: [{ state: 'open' }],
    });
    expect(await db.pool.query('select count(*)::int as n from outbound_intents')).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  test('migration fourteen refuses populated downgrade without losing delivery work', async () => {
    await seedSource();
    await work.reconcile(10, at);
    await expect(rollbackThroughMigration(db, 14)).rejects.toMatchObject({ code: '55000' });
    expect(
      await db.pool.query('select count(*)::int as n from notification_delivery_work'),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });

  test('migration fourteen rolls down empty and reapplies', async () => {
    const empty = await createIsolatedTestDatabase('runtime_work_cycle');
    try {
      await rollbackThroughMigration(empty, 14);
      expect(
        await empty.pool.query("select to_regclass('notification_delivery_work') as relation"),
      ).toMatchObject({ rows: [{ relation: null }] });
      await empty.runMigrations('up');
      expect(
        await empty.pool.query(
          "select to_regclass('notification_delivery_work') is not null as present",
        ),
      ).toMatchObject({ rows: [{ present: true }] });
    } finally {
      await empty.dispose();
    }
  });

  test.each(['pending', 'leased'] as const)(
    'stored retention deadline closes %s work even after its source lifetime extends',
    async (state) => {
      const source = await seedSource();
      await work.reconcile(10, at);
      if (state === 'leased') await work.claim(claimInput());
      await db.pool.query('update notification_delivery_work set retention_deadline=$1', [
        new Date(at.getTime() + 500),
      ]);
      await db.pool.query(
        'update conversation_retention_states set expires_at=$2 where conversation_id=$1',
        [source.conversationId, new Date(at.getTime() + 86400000)],
      );
      expect(await work.expire({ evaluatedAt: new Date(at.getTime() + 1000), limit: 10 })).toEqual({
        expired: 1,
      });
      expect(
        await db.pool.query('select state,reason_code from notification_delivery_work'),
      ).toMatchObject({
        rows: [{ state: 'failed', reason_code: 'retention_expired' }],
      });
    },
  );

  test('quarantined notification parents cannot be reconciled or claimed', async () => {
    await seedSource();
    const source = await db.pool.query<{ id: string }>(
      'select id from support_escalation_outcomes',
    );
    await seedReviewedRestore(db.pool, 'RESTORE_TEST_notification', at);
    try {
      await db.pool.query(
        "insert into runtime_restore_quarantine(source_kind,source_id,restore_ref,reason,recorded_at) values ('support_escalation',$1,'RESTORE_TEST_notification','restore_quarantined',$2)",
        [source.rows[0]?.id, at],
      );
      expect(await work.reconcile(10, at)).toEqual({ created: 0 });
      await db.pool.query('truncate runtime_restore_quarantine');
      expect(await work.reconcile(10, at)).toEqual({ created: 1 });
      await db.pool.query(
        "insert into runtime_restore_quarantine(source_kind,source_id,restore_ref,reason,recorded_at) values ('support_escalation',$1,'RESTORE_TEST_notification','restore_quarantined',$2)",
        [source.rows[0]?.id, at],
      );
      expect(await work.claim(claimInput())).toEqual([]);
    } finally {
      await db.pool.query(
        'truncate runtime_restore_quarantine,runtime_recovery_reviews,runtime_recovery_holds',
      );
    }
  });

  test('expiration closes pending work when its source retention ended', async () => {
    const source = await seedSource();
    await work.reconcile(10, at);
    await db.pool.query(
      `update conversation_retention_states set expires_at=$2,anchor_at=$3
      where conversation_id=$1`,
      [source.conversationId, new Date(at.getTime() - 1), new Date(at.getTime() - 86400000)],
    );
    expect(await work.expire({ evaluatedAt: at, limit: 10 })).toEqual({ expired: 1 });
    expect(
      await db.pool.query('select state,reason_code from notification_delivery_work'),
    ).toMatchObject({ rows: [{ state: 'failed', reason_code: 'source_unavailable' }] });
  });
  test('reconciles one minimized work item independently of n8n availability', async () => {
    await seedSource();
    expect(await work.reconcile(10, at)).toEqual({ created: 1 });
    expect(await work.reconcile(10, at)).toEqual({ created: 0 });
    const [first] = await work.claim(claimInput());
    expect(first?.notification).toMatchObject({
      schemaVersion: 1,
      type: 'operator_support_escalation',
    });
    expect(JSON.stringify(first)).not.toContain('CONTACT_TEST');
    expect(JSON.stringify(first)).not.toContain('messageText');
  });

  test('concurrent workers claim a single attempt', async () => {
    await seedSource();
    await work.reconcile(10, at);
    const claims = await Promise.all([
      work.claim(claimInput()),
      work.claim({ ...claimInput(), workerRef: 'WORKER_TEST_other' }),
    ]);
    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0]?.attemptNumber).toBe(1);
  });

  test('retry and expired leases keep the same downstream idempotency key', async () => {
    const first = await claim();
    await work.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'retryable', reasonCode: 'transport_failure' },
    });
    expect(await work.claim(claimInput())).toEqual([]);
    const second = (
      await work.claim({ ...claimInput(), evaluatedAt: new Date(at.getTime() + 1000) })
    )[0];
    expect(second?.notification.idempotencyKey).toBe(first.notification.idempotencyKey);
    expect(second?.attemptNumber).toBe(2);
    expect(await work.expire({ evaluatedAt: new Date(at.getTime() + 2000), limit: 10 })).toEqual({
      expired: 1,
    });
    const third = (
      await work.claim({ ...claimInput(), evaluatedAt: new Date(at.getTime() + 4000) })
    )[0];
    expect(third?.notification.idempotencyKey).toBe(first.notification.idempotencyKey);
    expect(third?.attemptNumber).toBe(3);
  });

  test('accepted delivery is replay safe and cannot resolve the business escalation', async () => {
    const first = await claim();
    const input = {
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'accepted', reasonCode: 'ok' } as const,
    };
    await work.finish(input);
    await work.finish(input);
    expect(await work.claim(claimInput())).toEqual([]);
    expect(
      await db.pool.query('select count(*)::int as n from notification_delivery_attempts'),
    ).toMatchObject({ rows: [{ n: 1 }] });
    expect(await db.pool.query('select state from support_escalation_outcomes')).toMatchObject({
      rows: [{ state: 'open' }],
    });
    await expect(
      work.finish({
        ...input,
        result: { status: 'terminal_failed', reasonCode: 'authentication_failed' },
      }),
    ).rejects.toThrow('runtime_work_conflict');
  });

  test('wrong-owner and expired completion attempts cannot alter delivery state', async () => {
    const first = await claim();
    const input = {
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'accepted', reasonCode: 'ok' } as const,
    };
    await expect(work.finish({ ...input, leaseRef: 'LEASE_TEST_wrong' })).rejects.toThrow(
      'runtime_work_conflict',
    );
    await expect(
      work.finish({ ...input, evaluatedAt: new Date(at.getTime() + 1000) }),
    ).rejects.toThrow('runtime_work_conflict');
  });

  test('retry exhaustion is terminal under the supplied customizable policy', async () => {
    const bounded = new PostgresNotificationWork(db.pool, { ...policy, maximumAttempts: 1 });
    await seedSource();
    await bounded.reconcile(10, at);
    const first = (await bounded.claim(claimInput()))[0];
    if (first === undefined) throw new Error('Synthetic bounded notification missing');
    await bounded.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'retryable', reasonCode: 'timeout' },
    });
    expect(
      await db.pool.query('select state, reason_code from notification_delivery_work'),
    ).toMatchObject({ rows: [{ state: 'failed', reason_code: 'retry_exhausted' }] });
  });

  test('expired or unprovable source retention cannot create new delivery work', async () => {
    const source = await seedSource();
    await db.pool.query(
      `update conversation_retention_states set expires_at = $2,
      anchor_at = $3 where conversation_id = $1`,
      [source.conversationId, new Date(at.getTime() - 1), new Date(at.getTime() - 86400000)],
    );
    expect(await work.reconcile(10, at)).toEqual({ created: 0 });
  });

  test('notification attempts are append-only and parent constraints reject forged sources', async () => {
    const first = await claim();
    await work.finish({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      result: { status: 'accepted', reasonCode: 'ok' },
    });
    await expect(db.pool.query('delete from notification_delivery_attempts')).rejects.toMatchObject(
      { code: '55000' },
    );
    await expect(
      db.pool.query('update notification_delivery_work set support_escalation_id = 999999'),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
