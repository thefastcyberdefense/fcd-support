import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMaintenance } from '../../src/operations/maintenance.js';
import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let db: IsolatedTestDatabase;
const at = new Date('2025-04-01T00:00:00.000Z');
const bounds = {
  global1Minute: 120,
  globalUtcDay: 900,
  leaseMs: 25000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 80,
  perContact15Minute: 3,
  perContact24Hour: 30,
  providerTimeoutMs: 8000,
  retryBaseMs: 5000,
  retryMaximumMs: 30000,
  whatsappAccount1Minute: 90,
  workerBatchSize: 10,
};
const learningPolicy = {
  minimumGroupCount: 3,
  digestIntervalMilliseconds: 259200000,
  maximumQuestionsPerDigest: 5,
  questionCooldownMilliseconds: 604800000,
  maximumDigestAppearances: 2,
  maximumObservationsPerRun: 1000,
};
const options = () => ({
  pool: db.pool,
  keyring: syntheticPrivacyKeyring,
  now: () => at,
  scheduledAt: at,
  runRef: 'RUN_TEST_maintenance',
  limit: 10,
  learningPolicy,
  outboundBounds: bounds,
  learningWindowMilliseconds: 86400000,
});
beforeAll(async () => {
  db = await createIsolatedTestDatabase('runtime_maintenance');
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.pool.query(
    'truncate contacts,webhook_receipts,privacy_requests,privacy_suppressions,retention_job_runs,customer_insight_runs,owner_question_digests restart identity cascade',
  );
});

async function source(key: string, occurredAt: Date, text: string) {
  const identity = {
    channel: 'messenger',
    channelAccountId: 'PAGE_TEST_maintenance',
    externalContactId: `CONTACT_TEST_${key}`,
  } as const;
  return {
    ...(await insertSyntheticAppliedCustomerEvent(db.pool, {
      fixtureKey: key,
      identity,
      occurredAt,
      messageText: text,
    })),
    identity,
  };
}
describe('PostgreSQL bounded runtime maintenance', () => {
  test('retention delegates existing erasure policy and exact slot replay is safe', async () => {
    await source(
      'maintenance_retention',
      new Date('2025-01-01T00:00:00.000Z'),
      'Synthetic expired source',
    );
    expect(await runMaintenance('retention', options())).toMatchObject({
      status: 'completed',
      processed: 1,
      reasonCode: 'ok',
    });
    expect(
      await db.pool.query('select message_text is null as erased from webhook_events'),
    ).toMatchObject({ rows: [{ erased: true }] });
    await runMaintenance('retention', options());
    expect(await db.pool.query('select count(*)::int as n from retention_job_runs')).toMatchObject({
      rows: [{ n: 1 }],
    });
  });
  test('only verified reviewed deletion executes; external privacy checklist stays pending', async () => {
    const policy = new PostgresDeletionPolicy(db.pool, syntheticPrivacyKeyring);
    for (const [index, key] of ['approved', 'unreviewed'].entries()) {
      const requestedAt = new Date(at.getTime() - 60000);
      const request = await source(`maintenance_${key}`, requestedAt, 'DELETE MY DATA');
      const opened = await policy.openIntentRequest({
        identity: request.identity,
        requestedAt,
        requestKey: `REQUEST_TEST_${key}`,
        sourceWebhookEventId: request.eventId,
      });
      if (index === 0) {
        const confirmation = await insertSyntheticAppliedCustomerEvent(db.pool, {
          fixtureKey: 'maintenance_confirm',
          identity: request.identity,
          occurredAt: new Date(at.getTime() - 30000),
          messageText: 'Synthetic explicit deletion confirmation',
        });
        await policy.reviewRequest(
          {
            requestRef: opened.requestRef,
            requestKey: 'REQUEST_TEST_review',
            decision: 'approve',
            reasonCode: 'customer_confirmed',
            verificationMethod: 'explicit_confirmation',
            confirmationWebhookEventId: confirmation.eventId,
            decidedAt: new Date(at.getTime() - 10000),
          },
          { reviewerRef: 'REVIEWER_TEST_maintenance', roles: ['support_reviewer'] },
        );
      }
    }
    expect(await runMaintenance('deletion', options())).toMatchObject({
      status: 'completed',
      processed: 1,
    });
    expect(
      (
        await db.pool.query<{ state: string }>('select state from privacy_requests order by id')
      ).rows.map((row) => row.state),
    ).toEqual(['in_progress', 'awaiting_confirmation']);
    expect(
      await db.pool.query(
        "select count(*)::int as n from privacy_request_locations where location_code='meta_provider' and state='pending'",
      ),
    ).toMatchObject({ rows: [{ n: 2 }] });
    await runMaintenance('deletion', options());
    expect(
      await db.pool.query('select count(*)::int as n from privacy_deletion_runs'),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });
  test('learning creates one content-free aggregate run under stable complete windows', async () => {
    await runMaintenance('learning', options());
    await runMaintenance('learning', options());
    expect(
      await db.pool.query('select count(*)::int as n from customer_insight_runs'),
    ).toMatchObject({ rows: [{ n: 1 }] });
    expect(await db.pool.query('select count(*)::int as n from knowledge_versions')).toMatchObject({
      rows: [{ n: 0 }],
    });
    expect(await db.pool.query('select count(*)::int as n from outbound_intents')).toMatchObject({
      rows: [{ n: 0 }],
    });
  });
  test('empty lease recovery is bounded and future scheduling is rejected', async () => {
    expect(await runMaintenance('lease_recovery', options())).toMatchObject({
      status: 'completed',
      processed: 0,
    });
    expect(
      await runMaintenance('learning', { ...options(), scheduledAt: new Date(at.getTime() + 1) }),
    ).toEqual({ status: 'failed', processed: 0, reasonCode: 'configuration_invalid' });
  });
});
