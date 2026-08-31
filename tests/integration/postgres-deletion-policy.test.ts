import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import type {
  ChannelIdentitySelector,
  OpenDeletionRequestInput,
  PrivacyHmacKeyring,
  ReviewDeletionRequestInput,
} from '../../src/policy/policy-types.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const keyring: PrivacyHmacKeyring = {
  activeVersion: 'test-v1',
  keys: new Map([['test-v1', Buffer.alloc(32, 0x41)]]),
};

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_deletion_policy',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       retention_job_runs, retention_events, conversation_retention_states,
       policy_audit_outcomes, consent_events, human_pause_events,
       webhook_event_applications, conversations, channel_identities,
       contacts, webhook_events, webhook_receipts
     restart identity cascade`,
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

function identity(fixtureKey: string, channel: 'messenger' | 'whatsapp' = 'whatsapp') {
  return {
    channel,
    channelAccountId: `${channel === 'whatsapp' ? 'PHONE' : 'PAGE'}_TEST_${fixtureKey}`,
    externalContactId: `${channel === 'whatsapp' ? 'WA' : 'PSID'}_TEST_${fixtureKey}`,
  } satisfies ChannelIdentitySelector;
}

function openCommand(input: {
  readonly eventId: string;
  readonly identity: ChannelIdentitySelector;
  readonly requestedAt: Date;
  readonly requestKey: string;
}): OpenDeletionRequestInput {
  return {
    identity: input.identity,
    requestedAt: input.requestedAt,
    requestKey: input.requestKey,
    sourceWebhookEventId: input.eventId,
  };
}

const supportReviewer = {
  reviewerRef: 'reviewer-opaque-deletion',
  roles: ['support_reviewer'],
} as const;

async function prepareDeletionRequest(input: {
  readonly fixtureKey: string;
  readonly requestedAt: Date;
}): Promise<{
  readonly identity: ChannelIdentitySelector;
  readonly policy: PostgresDeletionPolicy;
  readonly requestRef: string;
}> {
  const customerIdentity = identity(input.fixtureKey);
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `${input.fixtureKey}-request`,
    identity: customerIdentity,
    messageText: 'DELETE MY DATA',
    occurredAt: input.requestedAt,
  });
  const policy = new PostgresDeletionPolicy(pool, keyring);
  const opened = await policy.openRequest(
    openCommand({
      eventId: source.eventId,
      identity: customerIdentity,
      requestedAt: input.requestedAt,
      requestKey: `synthetic-deletion-open-${input.fixtureKey}`,
    }),
  );
  return { identity: customerIdentity, policy, requestRef: opened.requestRef };
}

function reviewCommand(input: {
  readonly confirmationEventId: string;
  readonly decidedAt: Date;
  readonly decision?: 'approve' | 'reject';
  readonly fixtureKey: string;
  readonly reasonCode?: 'customer_confirmed' | 'identity_ambiguous' | 'request_withdrawn';
  readonly requestRef: string;
  readonly verificationMethod?: 'explicit_confirmation' | 'known_name';
}): ReviewDeletionRequestInput {
  if (input.decision === 'reject') {
    return {
      confirmationWebhookEventId: input.confirmationEventId,
      decidedAt: input.decidedAt,
      decision: 'reject',
      reasonCode:
        input.reasonCode === 'request_withdrawn' ? 'request_withdrawn' : 'identity_ambiguous',
      requestKey: `synthetic-deletion-review-${input.fixtureKey}`,
      requestRef: input.requestRef,
      verificationMethod: input.verificationMethod ?? 'explicit_confirmation',
    };
  }
  return {
    confirmationWebhookEventId: input.confirmationEventId,
    decidedAt: input.decidedAt,
    decision: 'approve',
    reasonCode: 'customer_confirmed',
    requestKey: `synthetic-deletion-review-${input.fixtureKey}`,
    requestRef: input.requestRef,
    verificationMethod: input.verificationMethod ?? 'explicit_confirmation',
  };
}

describe('PostgresDeletionPolicy request intake', () => {
  test('opens one bounded request, checklist, event, and operator notification', async () => {
    const requestedAt = new Date('2026-08-31T03:10:00.000Z');
    const customerIdentity = identity('open');
    const { eventId } = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'deletion-open',
      identity: customerIdentity,
      messageText: 'DELETE MY DATA',
      occurredAt: requestedAt,
    });
    const result = await new PostgresDeletionPolicy(pool, keyring).openRequest(
      openCommand({
        eventId,
        identity: customerIdentity,
        requestedAt,
        requestKey: 'synthetic-deletion-open',
      }),
    );

    expect(result).toMatchObject({ status: 'opened' });
    expect(result.requestRef).toMatch(/^[0-9a-f-]{36}$/);
    const request = await pool.query(
      `select request_ref, request_type, state, contact_id is not null as has_contact,
              source_webhook_event_id, received_at, target_at, decision_at,
              completed_at, reviewer_reference, decision_code, reason_code
       from privacy_requests`,
    );
    expect(request.rows).toEqual([
      {
        request_ref: result.requestRef,
        request_type: 'deletion',
        state: 'awaiting_confirmation',
        has_contact: true,
        source_webhook_event_id: eventId,
        received_at: requestedAt,
        target_at: null,
        decision_at: null,
        completed_at: null,
        reviewer_reference: null,
        decision_code: null,
        reason_code: null,
      },
    ]);
    const locations = await pool.query(
      `select location_code, required, state, outcome_code, reviewer_reference, checked_at
       from privacy_request_locations
       order by location_code`,
    );
    expect(locations.rows).toEqual(
      [
        'backup_tombstone_gate',
        'manifest_recordings',
        'meta_provider',
        'offline_archives',
        'operator_exports',
        'pending_outbound',
        'primary_postgres',
      ].map((locationCode) => ({
        location_code: locationCode,
        required: true,
        state: 'pending',
        outcome_code: null,
        reviewer_reference: null,
        checked_at: null,
      })),
    );
    const events = await pool.query(
      `select action, outcome, reason_code, previous_state, resulting_state,
              actor_type, reviewer_reference, source_webhook_event_id,
              effective_at, request_key
       from privacy_request_events`,
    );
    expect(events.rows).toEqual([
      {
        action: 'request_received',
        outcome: 'applied',
        reason_code: 'customer_requested',
        previous_state: null,
        resulting_state: 'awaiting_confirmation',
        actor_type: 'customer',
        reviewer_reference: null,
        source_webhook_event_id: eventId,
        effective_at: requestedAt,
        request_key: 'synthetic-deletion-open',
      },
    ]);
    const notifications = await pool.query(
      `select notification_type, state, attempt_count, idempotency_key
       from privacy_notification_intents`,
    );
    expect(notifications.rows).toEqual([
      {
        notification_type: 'operator_privacy_request',
        state: 'pending',
        attempt_count: 0,
        idempotency_key: `operator-privacy-request:${result.requestRef}`,
      },
    ]);
    const serialized = JSON.stringify({
      events: events.rows,
      locations: locations.rows,
      notifications: notifications.rows,
      request: request.rows,
    });
    expect(serialized).not.toContain(customerIdentity.channelAccountId);
    expect(serialized).not.toContain(customerIdentity.externalContactId);
    expect(serialized).not.toContain('DELETE MY DATA');
  });

  test('returns the same request reference on exact replay and rejects changed material', async () => {
    const requestedAt = new Date('2026-08-31T03:20:00.000Z');
    const firstIdentity = identity('replay-first');
    const first = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'deletion-replay-first',
      identity: firstIdentity,
      occurredAt: requestedAt,
    });
    const command = openCommand({
      eventId: first.eventId,
      identity: firstIdentity,
      requestedAt,
      requestKey: 'synthetic-deletion-replay',
    });
    const policy = new PostgresDeletionPolicy(pool, keyring);

    const opened = await policy.openRequest(command);
    await expect(policy.openRequest(command)).resolves.toEqual({
      status: 'duplicate',
      requestRef: opened.requestRef,
    });

    const secondIdentity = identity('replay-second');
    const second = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'deletion-replay-second',
      identity: secondIdentity,
      occurredAt: requestedAt,
    });
    await expect(
      policy.openRequest(
        openCommand({
          eventId: second.eventId,
          identity: secondIdentity,
          requestedAt,
          requestKey: command.requestKey,
        }),
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    const counts = await pool.query(
      `select
         (select count(*)::int from privacy_requests) as requests,
         (select count(*)::int from privacy_request_locations) as locations,
         (select count(*)::int from privacy_request_events) as events,
         (select count(*)::int from privacy_notification_intents) as notifications`,
    );
    expect(counts.rows).toEqual([{ requests: 1, locations: 7, events: 1, notifications: 1 }]);
  });

  test('rejects unapplied and cross-identity source events without mutation', async () => {
    const requestedAt = new Date('2026-08-31T03:30:00.000Z');
    const pendingIdentity = identity('pending');
    const pendingEventId = await insertSyntheticPendingEvent(pool, {
      channel: pendingIdentity.channel,
      channelAccountId: pendingIdentity.channelAccountId,
      contactId: pendingIdentity.externalContactId,
      eventKind: 'customer_message',
      fixtureKey: 'deletion-pending',
      messageText: 'DELETE MY DATA',
      occurredAt: requestedAt,
    });
    const appliedIdentity = identity('applied');
    const applied = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'deletion-cross-identity',
      identity: appliedIdentity,
      occurredAt: requestedAt,
    });
    const policy = new PostgresDeletionPolicy(pool, keyring);

    await expect(
      policy.openRequest(
        openCommand({
          eventId: pendingEventId,
          identity: pendingIdentity,
          requestedAt,
          requestKey: 'synthetic-deletion-pending',
        }),
      ),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });
    await expect(
      policy.openRequest(
        openCommand({
          eventId: applied.eventId,
          identity: { ...appliedIdentity, externalContactId: 'WA_TEST_cross_identity_other' },
          requestedAt,
          requestKey: 'synthetic-deletion-cross-identity',
        }),
      ),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });
    expect((await pool.query('select id from privacy_requests')).rows).toEqual([]);
  });
});

describe('PostgresDeletionPolicy reviewer decisions', () => {
  test.each(['explicit_confirmation', 'known_name'] as const)(
    'approves same-identity evidence using %s without storing evidence content',
    async (verificationMethod) => {
      const requestedAt = new Date('2026-08-31T04:00:00.000Z');
      const decidedAt = new Date('2026-08-31T04:02:00.000Z');
      const prepared = await prepareDeletionRequest({
        fixtureKey: `approve-${verificationMethod}`,
        requestedAt,
      });
      const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
        fixtureKey: `approve-${verificationMethod}-confirmation`,
        identity: prepared.identity,
        messageText: 'Synthetic confirmation content that must not enter privacy evidence',
        occurredAt: new Date('2026-08-31T04:01:00.000Z'),
      });
      const command = reviewCommand({
        confirmationEventId: confirmation.eventId,
        decidedAt,
        fixtureKey: `approve-${verificationMethod}`,
        requestRef: prepared.requestRef,
        verificationMethod,
      });

      await expect(prepared.policy.reviewRequest(command, supportReviewer)).resolves.toEqual({
        requestRef: prepared.requestRef,
        state: 'human_review',
        status: 'applied',
      });
      await expect(prepared.policy.reviewRequest(command, supportReviewer)).resolves.toEqual({
        requestRef: prepared.requestRef,
        state: 'human_review',
        status: 'duplicate',
      });

      const request = await pool.query(
        `select state, decision_at, reviewer_reference, decision_code, reason_code
         from privacy_requests
         where request_ref = $1`,
        [prepared.requestRef],
      );
      expect(request.rows).toEqual([
        {
          state: 'human_review',
          decision_at: decidedAt,
          reviewer_reference: supportReviewer.reviewerRef,
          decision_code: verificationMethod,
          reason_code: 'customer_confirmed',
        },
      ]);
      const decisionEvents = await pool.query(
        `select action, outcome, reason_code, previous_state, resulting_state,
                actor_type, reviewer_reference, source_webhook_event_id,
                effective_at, request_key
         from privacy_request_events
         where action = 'reviewer_decision'`,
      );
      expect(decisionEvents.rows).toEqual([
        {
          action: 'reviewer_decision',
          outcome: 'applied',
          reason_code: 'customer_confirmed',
          previous_state: 'awaiting_confirmation',
          resulting_state: 'human_review',
          actor_type: 'support_reviewer',
          reviewer_reference: supportReviewer.reviewerRef,
          source_webhook_event_id: confirmation.eventId,
          effective_at: decidedAt,
          request_key: `synthetic-deletion-review-approve-${verificationMethod}`,
        },
      ]);
      const serialized = JSON.stringify({
        decisionEvents: decisionEvents.rows,
        request: request.rows,
      });
      expect(serialized).not.toContain(prepared.identity.channelAccountId);
      expect(serialized).not.toContain(prepared.identity.externalContactId);
      expect(serialized).not.toContain('Synthetic confirmation content');
    },
  );

  test('records an explicit ambiguous rejection as a terminal reviewer decision', async () => {
    const prepared = await prepareDeletionRequest({
      fixtureKey: 'ambiguous-reject',
      requestedAt: new Date('2026-08-31T04:10:00.000Z'),
    });
    const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'ambiguous-reject-confirmation',
      identity: prepared.identity,
      occurredAt: new Date('2026-08-31T04:11:00.000Z'),
    });
    const command = reviewCommand({
      confirmationEventId: confirmation.eventId,
      decidedAt: new Date('2026-08-31T04:12:00.000Z'),
      decision: 'reject',
      fixtureKey: 'ambiguous-reject',
      reasonCode: 'identity_ambiguous',
      requestRef: prepared.requestRef,
    });

    await expect(prepared.policy.reviewRequest(command, supportReviewer)).resolves.toEqual({
      requestRef: prepared.requestRef,
      state: 'rejected',
      status: 'applied',
    });
    const state = await pool.query(
      `select request.state, request.decision_code, request.reason_code,
              history.outcome, history.resulting_state
       from privacy_requests as request
       join privacy_request_events as history on history.request_id = request.id
       where request.request_ref = $1 and history.action = 'reviewer_decision'`,
      [prepared.requestRef],
    );
    expect(state.rows).toEqual([
      {
        state: 'rejected',
        decision_code: 'explicit_confirmation',
        reason_code: 'identity_ambiguous',
        outcome: 'rejected',
        resulting_state: 'rejected',
      },
    ]);
  });

  test('serializes concurrent exact approvals into one application and one duplicate', async () => {
    const prepared = await prepareDeletionRequest({
      fixtureKey: 'concurrent-review',
      requestedAt: new Date('2026-08-31T04:20:00.000Z'),
    });
    const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'concurrent-review-confirmation',
      identity: prepared.identity,
      occurredAt: new Date('2026-08-31T04:21:00.000Z'),
    });
    const command = reviewCommand({
      confirmationEventId: confirmation.eventId,
      decidedAt: new Date('2026-08-31T04:22:00.000Z'),
      fixtureKey: 'concurrent-review',
      requestRef: prepared.requestRef,
    });

    const results = await Promise.all([
      prepared.policy.reviewRequest(command, supportReviewer),
      prepared.policy.reviewRequest(command, supportReviewer),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'duplicate']);
    const count = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count
       from privacy_request_events
       where action = 'reviewer_decision'`,
    );
    expect(count.rows).toEqual([{ count: 1 }]);
  });

  test.each([
    ['cross identity', 'cross_identity'],
    ['cross channel', 'cross_channel'],
    ['pre-request event', 'pre_request'],
    ['unapplied event', 'unapplied'],
  ] as const)('rejects %s confirmation evidence without transition', async (_label, scenario) => {
    const requestedAt = new Date('2026-08-31T04:30:00.000Z');
    const prepared = await prepareDeletionRequest({
      fixtureKey: `invalid-${scenario}`,
      requestedAt,
    });
    const confirmationAt =
      scenario === 'pre_request'
        ? new Date('2026-08-31T04:29:59.000Z')
        : new Date('2026-08-31T04:31:00.000Z');
    const confirmationIdentity =
      scenario === 'cross_channel'
        ? identity(`invalid-${scenario}`, 'messenger')
        : scenario === 'cross_identity'
          ? { ...prepared.identity, externalContactId: 'WA_TEST_invalid_review_other' }
          : prepared.identity;
    const confirmationEventId =
      scenario === 'unapplied'
        ? await insertSyntheticPendingEvent(pool, {
            channel: confirmationIdentity.channel,
            channelAccountId: confirmationIdentity.channelAccountId,
            contactId: confirmationIdentity.externalContactId,
            eventKind: 'customer_message',
            fixtureKey: `invalid-${scenario}-confirmation`,
            occurredAt: confirmationAt,
          })
        : (
            await insertSyntheticAppliedCustomerEvent(pool, {
              fixtureKey: `invalid-${scenario}-confirmation`,
              identity: confirmationIdentity,
              occurredAt: confirmationAt,
            })
          ).eventId;
    const command = reviewCommand({
      confirmationEventId,
      decidedAt: new Date('2026-08-31T04:32:00.000Z'),
      fixtureKey: `invalid-${scenario}`,
      requestRef: prepared.requestRef,
    });

    await expect(prepared.policy.reviewRequest(command, supportReviewer)).rejects.toMatchObject({
      name: 'PolicyRecordNotFoundError',
    });
    const request = await pool.query(
      `select state, decision_at from privacy_requests where request_ref = $1`,
      [prepared.requestRef],
    );
    expect(request.rows).toEqual([{ state: 'awaiting_confirmation', decision_at: null }]);
  });

  test('rejects unauthorized review and secret-based verification without mutation', async () => {
    const prepared = await prepareDeletionRequest({
      fixtureKey: 'invalid-review-authority',
      requestedAt: new Date('2026-08-31T04:40:00.000Z'),
    });
    const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'invalid-review-authority-confirmation',
      identity: prepared.identity,
      occurredAt: new Date('2026-08-31T04:41:00.000Z'),
    });
    const command = reviewCommand({
      confirmationEventId: confirmation.eventId,
      decidedAt: new Date('2026-08-31T04:42:00.000Z'),
      fixtureKey: 'invalid-review-authority',
      requestRef: prepared.requestRef,
    });

    await expect(
      prepared.policy.reviewRequest(command, { reviewerRef: 'unauthorized', roles: [] }),
    ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    await expect(
      prepared.policy.reviewRequest(
        { ...command, verificationMethod: 'otp', requestKey: 'synthetic-secret-review' },
        supportReviewer,
      ),
    ).rejects.toThrow();
    const events = await pool.query(
      `select id from privacy_request_events where action = 'reviewer_decision'`,
    );
    expect(events.rows).toEqual([]);
  });

  test('rejects changed decision-key material and rolls back when history insertion fails', async () => {
    const prepared = await prepareDeletionRequest({
      fixtureKey: 'review-conflict-rollback',
      requestedAt: new Date('2026-08-31T04:50:00.000Z'),
    });
    const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'review-conflict-rollback-confirmation',
      identity: prepared.identity,
      occurredAt: new Date('2026-08-31T04:51:00.000Z'),
    });
    const command = reviewCommand({
      confirmationEventId: confirmation.eventId,
      decidedAt: new Date('2026-08-31T04:52:00.000Z'),
      fixtureKey: 'review-conflict-rollback',
      requestRef: prepared.requestRef,
    });

    await pool.query(
      `create function synthetic_reject_deletion_review_history()
       returns trigger language plpgsql as $$
       begin
         if new.action = 'reviewer_decision' then
           raise exception using errcode = 'P0001',
             message = 'synthetic deletion review history rejection';
         end if;
         return new;
       end;
       $$;
       create trigger synthetic_reject_deletion_review_history
         before insert on privacy_request_events
         for each row execute function synthetic_reject_deletion_review_history()`,
    );
    try {
      await expect(prepared.policy.reviewRequest(command, supportReviewer)).rejects.toThrow(
        'synthetic deletion review history rejection',
      );
    } finally {
      await pool.query(
        `drop trigger if exists synthetic_reject_deletion_review_history on privacy_request_events;
         drop function if exists synthetic_reject_deletion_review_history()`,
      );
    }
    const afterRollback = await pool.query(
      `select state, decision_at, reviewer_reference, decision_code, reason_code
       from privacy_requests where request_ref = $1`,
      [prepared.requestRef],
    );
    expect(afterRollback.rows).toEqual([
      {
        state: 'awaiting_confirmation',
        decision_at: null,
        reviewer_reference: null,
        decision_code: null,
        reason_code: null,
      },
    ]);

    await prepared.policy.reviewRequest(command, supportReviewer);
    await expect(
      prepared.policy.reviewRequest(
        { ...command, decidedAt: new Date('2026-08-31T04:52:00.001Z') },
        supportReviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });
});

describe('PostgresDeletionPolicy tombstone lookup', () => {
  test('matches exact identities across retained key versions and honors time bounds', async () => {
    const customerIdentity = identity('tombstone-lookup');
    const oldKey = Buffer.alloc(32, 0x42);
    const rotatingKeyring: PrivacyHmacKeyring = {
      activeVersion: 'test-v2',
      keys: new Map([
        ['test-v1', oldKey],
        ['test-v2', Buffer.alloc(32, 0x43)],
      ]),
    };
    const effectiveAt = new Date('2026-08-31T05:00:00.000Z');
    const expiresAt = new Date('2026-09-01T05:00:00.000Z');
    await pool.query(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at,
          key_version, expires_at)
       values ($1, $2, 'deletion_tombstone', 'customer_deletion', $3, 'test-v1', $4)`,
      [
        createIdentityHmac(customerIdentity, { key: oldKey, version: 'test-v1' }),
        customerIdentity.channel,
        effectiveAt,
        expiresAt,
      ],
    );
    const policy = new PostgresDeletionPolicy(pool, rotatingKeyring);

    await expect(policy.isIdentityDeleted(customerIdentity, effectiveAt)).resolves.toBe(true);
    await expect(
      policy.isIdentityDeleted(
        { ...customerIdentity, externalContactId: 'WA_TEST_tombstone_other' },
        effectiveAt,
      ),
    ).resolves.toBe(false);
    await expect(policy.isIdentityDeleted(customerIdentity, expiresAt)).resolves.toBe(false);
  });
});
