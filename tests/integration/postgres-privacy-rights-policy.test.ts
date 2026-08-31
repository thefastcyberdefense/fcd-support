import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_privacy_rights_policy',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       privacy_marketing_reopt_in_runs, privacy_access_runs, privacy_correction_runs,
       privacy_marketing_opt_out_runs, privacy_notification_intents,
       privacy_request_events, privacy_request_locations,
       privacy_deletion_runs, restore_deletion_gates, privacy_requests,
       privacy_suppressions, retention_job_runs, retention_events,
       conversation_retention_states, policy_audit_outcomes, consent_events,
       human_pause_events, webhook_event_applications, conversations,
       channel_identities, contacts, webhook_events, webhook_receipts
     restart identity cascade`,
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

const supportReviewer = {
  reviewerRef: 'REVIEWER_TEST_privacy_rights',
  roles: ['support_reviewer'],
} as const;

const identity = {
  channel: 'whatsapp',
  channelAccountId: 'ACCOUNT_TEST_privacy_rights',
  externalContactId: 'CONTACT_TEST_privacy_rights',
} as const;

async function createCommandEvent(
  fixtureKey: string,
  messageText: string,
  occurredAt = new Date('2026-08-31T05:00:00.000Z'),
) {
  return insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey,
    identity,
    messageText,
    occurredAt,
  });
}

describe('PostgresPrivacyRightsPolicy', () => {
  test.each([
    ['REQUEST MY DATA', 'access'],
    ['  correct   my data? ', 'correction'],
  ] as const)(
    'opens one reviewed %s request with content-free workflow state',
    async (text, type) => {
      const source = await createCommandEvent(`privacy-open-${type}`, text);
      const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);

      const result = await policy.processAppliedEvent({
        requestKey: `privacy-open-${type}`,
        sourceWebhookEventId: source.eventId,
      });

      expect(result).toMatchObject({ intent: type, status: 'opened' });
      if (result.status !== 'opened') {
        throw new Error('Synthetic privacy request was not opened');
      }
      const stored = await pool.query(
        `select request.request_ref, request.request_type, request.state,
              request.source_webhook_event_id,
              count(distinct location.location_code)::int as locations,
              count(distinct notification.id)::int as notifications
       from privacy_requests as request
       join privacy_request_locations as location on location.request_id = request.id
       join privacy_notification_intents as notification
         on notification.request_id = request.id
       where request.request_ref = $1
       group by request.id`,
        [result.requestRef],
      );
      expect(stored.rows).toEqual([
        {
          locations: 7,
          notifications: 1,
          request_ref: result.requestRef,
          request_type: type,
          source_webhook_event_id: source.eventId,
          state: 'human_review',
        },
      ]);
      const nonApplicable = await pool.query(
        `select location_code, required, state
       from privacy_request_locations
       where request_id = (
         select id from privacy_requests where request_ref = $1
       )
         and state = 'not_applicable'
       order by location_code`,
        [result.requestRef],
      );
      expect(nonApplicable.rows).toEqual(
        type === 'access'
          ? [{ location_code: 'backup_tombstone_gate', required: false, state: 'not_applicable' }]
          : [
              {
                location_code: 'backup_tombstone_gate',
                required: false,
                state: 'not_applicable',
              },
              { location_code: 'operator_exports', required: false, state: 'not_applicable' },
            ],
      );
    },
  );

  test('returns one duplicate result for exact and concurrent retry', async () => {
    const source = await createCommandEvent('privacy-open-retry', 'REQUEST MY DATA');
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const input = {
      requestKey: 'privacy-open-retry',
      sourceWebhookEventId: source.eventId,
    };

    const [left, right] = await Promise.all([
      policy.processAppliedEvent(input),
      policy.processAppliedEvent(input),
    ]);

    expect([left.status, right.status].sort()).toEqual(['duplicate', 'opened']);
    expect(left).toMatchObject({ intent: 'access' });
    expect(right).toMatchObject({ intent: 'access' });
    const counts = await pool.query(
      `select
         (select count(*)::int from privacy_requests) as requests,
         (select count(*)::int from privacy_notification_intents) as notifications,
         (select count(*)::int from privacy_request_events) as events`,
    );
    expect(counts.rows).toEqual([{ events: 1, notifications: 1, requests: 1 }]);
  });

  test('dispatches exact deletion intent into the existing verified workflow', async () => {
    const source = await createCommandEvent('privacy-delete-dispatch', 'DELETE MY DATA');
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const input = {
      requestKey: 'privacy-delete-dispatch',
      sourceWebhookEventId: source.eventId,
    };

    const opened = await policy.processAppliedEvent(input);
    const duplicate = await policy.processAppliedEvent(input);

    expect(opened).toMatchObject({ intent: 'deletion', status: 'opened' });
    expect(duplicate).toMatchObject({ intent: 'deletion', status: 'duplicate' });
    if (opened.status !== 'opened') {
      throw new Error('Synthetic deletion request was not opened');
    }
    const stored = await pool.query(
      `select request_type, state,
              (select count(*)::int
               from privacy_notification_intents
               where request_id = request.id) as notifications
       from privacy_requests as request
       where request_ref = $1`,
      [opened.requestRef],
    );
    expect(stored.rows).toEqual([
      {
        notifications: 1,
        request_type: 'deletion',
        state: 'awaiting_confirmation',
      },
    ]);
  });

  test('dispatches exact marketing opt-out immediately with content-free evidence', async () => {
    const source = await createCommandEvent('privacy-marketing-dispatch', 'STOP MARKETING');
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const input = {
      requestKey: 'privacy-marketing-dispatch',
      sourceWebhookEventId: source.eventId,
    };

    await expect(policy.processAppliedEvent(input)).resolves.toEqual({
      categoryRevocations: 0,
      intent: 'marketing_opt_out',
      linkedIdentities: 1,
      pendingIntentsCancelled: 0,
      status: 'applied',
      suppressionsCreated: 1,
    });
    await expect(policy.processAppliedEvent(input)).resolves.toMatchObject({
      intent: 'marketing_opt_out',
      status: 'duplicate',
    });
    const stored = await pool.query(
      `select
         (select count(*)::int from privacy_marketing_opt_out_runs) as runs,
         (select count(*)::int from privacy_notification_intents) as notifications,
         (select count(*)::int from privacy_suppressions
          where category = 'marketing_opt_out') as suppressions`,
    );
    expect(stored.rows).toEqual([{ notifications: 1, runs: 1, suppressions: 1 }]);
  });

  test('ignores non-exact text and rejects a non-applied source', async () => {
    const discussed = await createCommandEvent(
      'privacy-non-exact',
      'Please REQUEST MY DATA for this example',
    );
    const pendingEventId = await insertSyntheticPendingEvent(pool, {
      channel: identity.channel,
      channelAccountId: identity.channelAccountId,
      contactId: identity.externalContactId,
      eventKind: 'customer_message',
      fixtureKey: 'privacy-pending-source',
      messageText: 'REQUEST MY DATA',
      occurredAt: new Date('2026-08-31T05:01:00.000Z'),
    });
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);

    await expect(
      policy.processAppliedEvent({
        requestKey: 'privacy-non-exact',
        sourceWebhookEventId: discussed.eventId,
      }),
    ).resolves.toEqual({ status: 'not_a_privacy_intent' });
    await expect(
      policy.processAppliedEvent({
        requestKey: 'privacy-pending-source',
        sourceWebhookEventId: pendingEventId,
      }),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });
    await expect(
      pool.query(`select count(*)::int as count from privacy_requests`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  test('rejects request-key reuse with different authoritative material', async () => {
    const access = await createCommandEvent('privacy-conflict-access', 'REQUEST MY DATA');
    const correction = await createCommandEvent(
      'privacy-conflict-correction',
      'CORRECT MY DATA',
      new Date('2026-08-31T05:02:00.000Z'),
    );
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    await policy.processAppliedEvent({
      requestKey: 'privacy-conflicting-key',
      sourceWebhookEventId: access.eventId,
    });

    await expect(
      policy.processAppliedEvent({
        requestKey: 'privacy-conflicting-key',
        sourceWebhookEventId: correction.eventId,
      }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });

  test('rolls request creation back when notification insertion fails', async () => {
    const source = await createCommandEvent('privacy-notification-rollback', 'REQUEST MY DATA');
    await pool.query(`
      create function reject_synthetic_privacy_notification()
      returns trigger language plpgsql as $$
      begin
        raise exception using errcode = '23514', message = 'synthetic notification failure';
      end;
      $$;
      create trigger reject_synthetic_privacy_notification
        before insert on privacy_notification_intents
        for each row execute function reject_synthetic_privacy_notification();
    `);
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);

    try {
      await expect(
        policy.processAppliedEvent({
          requestKey: 'privacy-notification-rollback',
          sourceWebhookEventId: source.eventId,
        }),
      ).rejects.toMatchObject({ code: '23514' });
      const counts = await pool.query(
        `select
           (select count(*)::int from privacy_requests) as requests,
           (select count(*)::int from privacy_request_events) as events`,
      );
      expect(counts.rows).toEqual([{ events: 0, requests: 0 }]);
    } finally {
      await pool.query(`
        drop trigger reject_synthetic_privacy_notification
          on privacy_notification_intents;
        drop function reject_synthetic_privacy_notification();
      `);
    }
  });

  test('requires a reviewer and serializes approval plus checklist attestation', async () => {
    const source = await createCommandEvent('privacy-review-access', 'REQUEST MY DATA');
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const opened = await policy.processAppliedEvent({
      requestKey: 'privacy-review-access-open',
      sourceWebhookEventId: source.eventId,
    });
    if (opened.status !== 'opened' || opened.intent !== 'access') {
      throw new Error('Synthetic access request was not opened');
    }
    const reviewInput = {
      decidedAt: new Date('2026-08-31T05:05:00.000Z'),
      decision: 'approve',
      reasonCode: 'identity_verified',
      requestKey: 'privacy-review-access-approve',
      requestRef: opened.requestRef,
      verificationMethod: 'same_channel_context',
    } as const;

    await expect(
      policy.reviewRequest(reviewInput, {
        reviewerRef: 'REVIEWER_TEST_unauthorized',
        roles: [],
      }),
    ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    await expect(policy.reviewRequest(reviewInput, supportReviewer)).resolves.toEqual({
      requestRef: opened.requestRef,
      state: 'in_progress',
      status: 'applied',
    });
    await expect(policy.reviewRequest(reviewInput, supportReviewer)).resolves.toEqual({
      requestRef: opened.requestRef,
      state: 'in_progress',
      status: 'duplicate',
    });

    const locationInput = {
      checkedAt: new Date('2026-08-31T05:06:00.000Z'),
      locationCode: 'primary_postgres',
      outcomeCode: 'location_complete',
      requestKey: 'privacy-review-access-location',
      requestRef: opened.requestRef,
    } as const;
    await expect(policy.attestLocation(locationInput, supportReviewer)).resolves.toEqual({
      locationCode: 'primary_postgres',
      requestRef: opened.requestRef,
      state: 'completed',
      status: 'applied',
    });
    await expect(policy.attestLocation(locationInput, supportReviewer)).resolves.toEqual({
      locationCode: 'primary_postgres',
      requestRef: opened.requestRef,
      state: 'completed',
      status: 'duplicate',
    });
    await expect(
      policy.attestLocation(
        { ...locationInput, locationCode: 'offline_archives' },
        supportReviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    const stored = await pool.query(
      `select request.state, request.decision_code, request.reason_code,
              location.state as location_state,
              location.outcome_code
       from privacy_requests as request
       join privacy_request_locations as location on location.request_id = request.id
       where request.request_ref = $1
         and location.location_code = 'primary_postgres'`,
      [opened.requestRef],
    );
    expect(stored.rows).toEqual([
      {
        decision_code: 'same_channel_context',
        location_state: 'completed',
        outcome_code: 'location_complete',
        reason_code: 'identity_verified',
        state: 'in_progress',
      },
    ]);
  });

  test('records a bounded correction rejection and releases that request hold', async () => {
    const source = await createCommandEvent('privacy-reject-correction', 'CORRECT MY DATA');
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const opened = await policy.processAppliedEvent({
      requestKey: 'privacy-reject-correction-open',
      sourceWebhookEventId: source.eventId,
    });
    if (opened.status !== 'opened' || opened.intent !== 'correction') {
      throw new Error('Synthetic correction request was not opened');
    }

    await expect(
      policy.reviewRequest(
        {
          decidedAt: new Date('2026-08-31T05:10:00.000Z'),
          decision: 'reject',
          reasonCode: 'identity_ambiguous',
          requestKey: 'privacy-reject-correction-review',
          requestRef: opened.requestRef,
          verificationMethod: 'known_name',
        },
        supportReviewer,
      ),
    ).resolves.toEqual({
      requestRef: opened.requestRef,
      state: 'rejected',
      status: 'applied',
    });
    await expect(
      pool.query(
        `select state, decision_code, reason_code
         from privacy_requests where request_ref = $1`,
        [opened.requestRef],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          decision_code: 'known_name',
          reason_code: 'identity_ambiguous',
          state: 'rejected',
        },
      ],
    });
  });
});
