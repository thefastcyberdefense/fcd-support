import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createN8nClient, createN8nSigningSecret } from '../../src/notifications/n8n-client.js';
import {
  NotificationWorker,
  type NotificationWorkStore,
} from '../../src/notifications/notification-worker.js';
import { PostgresNotificationWork } from '../../src/persistence/postgres-notification-work.js';
import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import {
  startFakeN8nServer,
  syntheticN8nSecret,
  type FakeN8nServer,
} from '../helpers/fake-n8n-server.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { seedReviewedRestore } from './restore-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';
import { createNotificationRuntime } from '../../src/operations/notification-runtime.js';
import { noopSafeLogger } from '../../src/logging.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';

let db: IsolatedTestDatabase;
const at = new Date('2030-04-01T00:00:00.000Z');
const retryPolicy = {
  maximumAttempts: 3,
  retryBaseMilliseconds: 1000,
  retryMaximumMilliseconds: 2000,
};
const identity = {
  channel: 'messenger' as const,
  channelAccountId: 'PAGE_TEST_notification_flow',
  externalContactId: 'CONTACT_TEST_notification_flow',
};
beforeAll(async () => {
  db = await createIsolatedTestDatabase('notification_flow');
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.pool.query(
    'truncate contacts, webhook_receipts, privacy_suppressions, runtime_restore_quarantine, operations_restore_bindings, runtime_recovery_reviews, runtime_recovery_holds restart identity cascade',
  );
});

class NotificationFlowFixture {
  public readonly work = new PostgresNotificationWork(db.pool, retryPolicy);
  public now = new Date(at);
  public fake!: FakeN8nServer;
  public async start(): Promise<void> {
    this.fake = await startFakeN8nServer({
      now: () => this.now,
      maximumSkewSeconds: 30,
      maximumRequestBytes: 2048,
    });
  }
  public worker(store: NotificationWorkStore = this.work): NotificationWorker {
    return new NotificationWorker({
      store,
      now: () => this.now,
      batchSize: 5,
      leaseMilliseconds: 5000,
      maximumCallMilliseconds: 1000,
      client: createN8nClient({
        origin: this.fake.origin,
        path: '/webhook/fcd-notification',
        syntheticMode: true,
        signingSecret: createN8nSigningSecret(syntheticN8nSecret),
        timeoutMilliseconds: 1000,
        maximumResponseBytes: 1024,
        now: () => this.now,
      }),
    });
  }
  public runBatch() {
    return this.worker().runBatch({ workerRef: 'WORKER_TEST_notification_flow' });
  }
  public advanceRetryClock() {
    this.now = new Date(this.now.getTime() + 1000);
  }
  public async deliveredWorkCount() {
    return (
      await db.pool.query<{ n: number }>(
        "select count(*)::int as n from notification_delivery_work where state='delivered'",
      )
    ).rows[0]?.n;
  }
  public async authorityProjection() {
    return (
      await db.pool.query<{
        consent: number;
        privacy_events: number;
        suppressions: number;
        conversations: number;
        pauses: number;
        open_escalations: number;
      }>(`select
      (select count(*)::int from consent_events) as consent,
      (select count(*)::int from privacy_request_events) as privacy_events,
      (select count(*)::int from privacy_suppressions) as suppressions,
      (select count(*)::int from conversations) as conversations,
      (select count(*)::int from conversations where ai_paused_until is not null) as pauses,
      (select count(*)::int from support_escalation_outcomes where state='open') as open_escalations`)
    ).rows;
  }
}
async function seedSource() {
  const source = await insertSyntheticAppliedCustomerEvent(db.pool, {
    fixtureKey: 'notification_flow',
    identity,
    occurredAt: at,
  });
  await db.pool.query(
    `insert into support_escalation_outcomes
    (escalation_ref,conversation_id,source_webhook_event_id,reason_code,state,request_key,created_at,updated_at)
    values ('ESCALATION_TEST_notification_flow',$1,$2,'provider_failure','open','REQUEST_TEST_notification_flow',$3,$3)`,
    [source.conversationId, source.eventId, at],
  );
  return source;
}
async function withFixture(operation: (fixture: NotificationFlowFixture) => Promise<void>) {
  const fixture = new NotificationFlowFixture();
  await fixture.start();
  try {
    await operation(fixture);
  } finally {
    await fixture.fake.close();
  }
}

describe('PostgreSQL signed notification flow', () => {
  test('enabled composed daemon delivers through the actual synthetic socket and durable queue', async () => {
    await seedSource();
    await db.pool.query(
      "insert into operations_deployments (git_revision,schema_revision,recorded_at,status) values ($1,'000016',$2,'started')",
      ['c'.repeat(40), at],
    );
    await withFixture(async (fixture) => {
      const common = operationsEnvironment();
      const resources = JSON.parse(common.OPS_RESOURCE_LIMITS_JSON) as Record<string, unknown>;
      const runtime = await createNotificationRuntime({
        role: 'notification',
        now: () => fixture.now,
        logger: noopSafeLogger,
        environment: {
          ...common,
          DATABASE_URL: db.connectionString,
          OPS_RESOURCE_LIMITS_JSON: JSON.stringify({ ...resources, notification: resources.reply }),
          OPS_GIT_REVISION: 'c'.repeat(40),
          OPS_SCHEMA_REVISION: '000016',
          N8N_EXECUTION_ENABLED: 'true',
          N8N_ORIGIN: fixture.fake.origin,
          N8N_PATH: '/webhook/fcd-notification',
          N8N_ESCALATION_WEBHOOK_SECRET: syntheticN8nSecret,
          N8N_PROVIDER_TIMEOUT_MS: '1000',
          N8N_MAX_RESPONSE_BYTES: '1024',
          N8N_MAX_ATTEMPTS: '3',
          N8N_RETRY_BASE_MS: '1000',
          N8N_RETRY_MAXIMUM_MS: '2000',
          N8N_ALLOW_LOOPBACK_FAKE: 'true',
        },
      });
      try {
        await runtime.start();
        for (let attempt = 0; attempt < 150; attempt++) {
          if ((await fixture.deliveredWorkCount()) === 1) break;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
        }
        expect(await fixture.deliveredWorkCount()).toBe(1);
        expect(fixture.fake.acceptedNotificationCount()).toBe(1);
      } finally {
        await runtime.stop();
      }
    });
  });
  test('lost acknowledgement retries the same key without duplicate notification', async () => {
    await seedSource();
    await withFixture(async (fixture) => {
      fixture.fake.acceptThenDisconnect();
      expect((await fixture.runBatch()).retryable).toBe(1);
      fixture.advanceRetryClock();
      expect((await fixture.runBatch()).accepted).toBe(1);
      expect(fixture.fake.acceptedNotificationCount()).toBe(1);
      expect(await fixture.deliveredWorkCount()).toBe(1);
      expect(
        (await db.pool.query('select count(*)::int as n from notification_delivery_attempts')).rows,
      ).toEqual([{ n: 2 }]);
    });
  });
  test('n8n outage cannot mutate consent or conversation authority and attempts are capped', async () => {
    const source = await insertSyntheticAppliedCustomerEvent(db.pool, {
      fixtureKey: 'notification_flow_opt_out',
      identity,
      occurredAt: new Date('2025-04-01T00:00:00.000Z'),
      messageText: 'STOP MARKETING',
    });
    await new PostgresPrivacyRightsPolicy(db.pool, syntheticPrivacyKeyring).processAppliedEvent({
      sourceWebhookEventId: source.eventId,
      requestKey: 'REQUEST_TEST_notification_opt_out',
    });
    await db.pool.query(
      'update conversation_retention_states set expires_at=$2 where conversation_id=$1',
      [source.conversationId, new Date(at.getTime() + 86400000)],
    );
    await db.pool.query('update privacy_notification_intents set created_at=$1,updated_at=$1', [
      at,
    ]);
    const fixture = new NotificationFlowFixture();
    await fixture.start();
    const worker = fixture.worker();
    const before = await fixture.authorityProjection();
    await fixture.fake.close();
    for (let attempt = 0; attempt < 4; attempt++) {
      await worker.runBatch({ workerRef: 'WORKER_TEST_notification_outage' });
      fixture.now = new Date(fixture.now.getTime() + 2000);
    }
    expect(await fixture.authorityProjection()).toEqual(before);
    expect(
      (
        await db.pool.query(
          'select state,reason_code,attempt_count from notification_delivery_work',
        )
      ).rows,
    ).toEqual([{ state: 'failed', reason_code: 'retry_exhausted', attempt_count: 3 }]);
  });
  test.each(['retention', 'quarantine', 'lease'] as const)(
    'post-claim %s change refuses dispatch',
    async (change) => {
      const source = await seedSource();
      await withFixture(async (fixture) => {
        const store: NotificationWorkStore = {
          reconcile: (limit, date) => fixture.work.reconcile(limit, date),
          expire: (input) => fixture.work.expire(input),
          authorize: (input) => fixture.work.authorize(input),
          finish: (input) => fixture.work.finish(input),
          claim: async (input) => {
            const claims = await fixture.work.claim(input);
            if (change === 'retention')
              await db.pool.query(
                'update conversation_retention_states set expires_at=$2,anchor_at=$3 where conversation_id=$1',
                [
                  source.conversationId,
                  new Date(at.getTime() - 1),
                  new Date(at.getTime() - 86400000),
                ],
              );
            if (change === 'lease') fixture.now = new Date(at.getTime() + 4500);
            if (change === 'quarantine') {
              await seedReviewedRestore(db.pool, 'RESTORE_TEST_notification_flow', at);
              await db.pool.query(
                "insert into runtime_restore_quarantine(source_kind,source_id,restore_ref,reason,recorded_at) select 'notification_work',id,'RESTORE_TEST_notification_flow','restore_quarantined',$1 from notification_delivery_work",
                [at],
              );
            }
            return claims;
          },
        };
        expect(
          (await fixture.worker(store).runBatch({ workerRef: 'WORKER_TEST_notification_change' }))
            .skipped,
        ).toBe(1);
        expect(fixture.fake.acceptedNotificationCount()).toBe(0);
      });
    },
  );
  test.each(['before_reconciliation', 'after_claim'] as const)(
    'verified deletion cancels notification work %s without discarding delivery evidence',
    async (stage) => {
      const source = await seedSource();
      const deletion = new PostgresDeletionPolicy(db.pool, syntheticPrivacyKeyring);
      const opened = await deletion.openRequest({
        identity,
        requestedAt: at,
        sourceWebhookEventId: source.eventId,
        requestKey: 'REQUEST_TEST_notification_delete',
      });
      const confirmation = await insertSyntheticAppliedCustomerEvent(db.pool, {
        fixtureKey: 'notification_flow_delete_confirmation',
        identity,
        occurredAt: new Date(at.getTime() + 1000),
        messageText: 'Synthetic explicit deletion confirmation',
      });
      await deletion.reviewRequest(
        {
          requestRef: opened.requestRef,
          confirmationWebhookEventId: confirmation.eventId,
          decidedAt: new Date(at.getTime() + 2000),
          decision: 'approve',
          verificationMethod: 'explicit_confirmation',
          reasonCode: 'customer_confirmed',
          requestKey: 'REQUEST_TEST_notification_delete_review',
        },
        { reviewerRef: 'REVIEWER_TEST_notification_flow', roles: ['support_reviewer'] },
      );
      await withFixture(async (fixture) => {
        fixture.now = new Date(at.getTime() + 3000);
        const erase = async () => {
          const result = await deletion.executeApprovedRequest({
            requestRef: opened.requestRef,
            executedAt: fixture.now,
            requestKey: 'REQUEST_TEST_notification_delete_execute',
          });
          expect(result.tombstonesCreated).toBe(1);
        };
        if (stage === 'before_reconciliation') await erase();
        const store: NotificationWorkStore = {
          reconcile: (limit, date) => fixture.work.reconcile(limit, date),
          expire: (input) => fixture.work.expire(input),
          authorize: (input) => fixture.work.authorize(input),
          finish: (input) => fixture.work.finish(input),
          claim: async (input) => {
            const claims = await fixture.work.claim(input);
            if (stage === 'after_claim') await erase();
            return claims;
          },
        };
        expect(
          (await fixture.worker(store).runBatch({ workerRef: 'WORKER_TEST_notification_delete' }))
            .accepted,
        ).toBe(0);
        expect(fixture.fake.acceptedNotificationCount()).toBe(0);
        expect(
          (
            await db.pool.query(`select state,reason_code,lease_ref,worker_ref,lease_expires_at,
          next_attempt_at from notification_delivery_work order by id`)
          ).rows,
        ).toEqual(
          expect.arrayContaining([
            {
              state: 'failed',
              reason_code: 'source_unavailable',
              lease_ref: null,
              worker_ref: null,
              lease_expires_at: null,
              next_attempt_at: null,
            },
          ]),
        );
        expect(await fixture.work.reconcile(10, fixture.now)).toEqual({ created: 0 });
        expect((await fixture.runBatch()).accepted).toBe(0);
      });
    },
  );
});
