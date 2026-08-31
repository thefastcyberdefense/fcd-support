import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { PostgresConsentPolicy } from '../../src/persistence/postgres-consent-policy.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresReceiptStore } from '../../src/persistence/postgres-receipt-store.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import type {
  ChannelIdentitySelector,
  ExecuteDeletionInput,
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
       restore_deletion_gates, privacy_deletion_runs,
       privacy_notification_intents, privacy_request_events,
       privacy_request_locations, privacy_requests, privacy_suppressions,
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

function executeCommand(input: {
  readonly executedAt: Date;
  readonly fixtureKey: string;
  readonly requestRef: string;
}): ExecuteDeletionInput {
  return {
    executedAt: input.executedAt,
    requestKey: `synthetic-deletion-execute-${input.fixtureKey}`,
    requestRef: input.requestRef,
  };
}

async function prepareApprovedDeletionRequest(input: {
  readonly fixtureKey: string;
  readonly requestedAt: Date;
}): Promise<{
  readonly identity: ChannelIdentitySelector;
  readonly policy: PostgresDeletionPolicy;
  readonly requestRef: string;
}> {
  const prepared = await prepareDeletionRequest(input);
  const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `${input.fixtureKey}-confirmation`,
    identity: prepared.identity,
    messageText: 'Synthetic explicit deletion confirmation',
    occurredAt: new Date(input.requestedAt.getTime() + 60_000),
  });
  await prepared.policy.reviewRequest(
    reviewCommand({
      confirmationEventId: confirmation.eventId,
      decidedAt: new Date(input.requestedAt.getTime() + 120_000),
      fixtureKey: input.fixtureKey,
      requestRef: prepared.requestRef,
    }),
    supportReviewer,
  );
  return prepared;
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

describe('PostgresDeletionPolicy approved local erasure', () => {
  test('pseudonymizes every linked identity and clears governed content in one transaction', async () => {
    const requestedAt = new Date('2026-08-31T06:00:00.000Z');
    const prepared = await prepareDeletionRequest({ fixtureKey: 'execute', requestedAt });
    const messengerIdentity = identity('execute-linked', 'messenger');
    await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'execute-linked-message',
      identity: messengerIdentity,
      messageText: 'Synthetic linked Messenger content',
      occurredAt: new Date('2026-08-31T06:00:30.000Z'),
    });
    const contacts = await pool.query<{
      readonly contact_id: string;
      readonly external_contact_id: string;
    }>(
      `select contact_id, external_contact_id
       from channel_identities
       where (channel = $1 and channel_account_id = $2 and external_contact_id = $3)
          or (channel = $4 and channel_account_id = $5 and external_contact_id = $6)
       order by channel`,
      [
        prepared.identity.channel,
        prepared.identity.channelAccountId,
        prepared.identity.externalContactId,
        messengerIdentity.channel,
        messengerIdentity.channelAccountId,
        messengerIdentity.externalContactId,
      ],
    );
    const subjectContactId = contacts.rows.find(
      (row) => row.external_contact_id === prepared.identity.externalContactId,
    )?.contact_id;
    if (subjectContactId === undefined) throw new Error('Synthetic subject contact missing');
    await pool.query(
      `update channel_identities
       set contact_id = $1
       where channel = $2 and channel_account_id = $3 and external_contact_id = $4`,
      [
        subjectContactId,
        messengerIdentity.channel,
        messengerIdentity.channelAccountId,
        messengerIdentity.externalContactId,
      ],
    );

    const echoId = await insertSyntheticPendingEvent(pool, {
      channel: messengerIdentity.channel,
      channelAccountId: messengerIdentity.channelAccountId,
      contactId: messengerIdentity.externalContactId,
      eventKind: 'business_message_echo',
      fixtureKey: 'execute-linked-echo',
      messageText: 'Synthetic linked human reply',
      occurredAt: new Date('2026-08-31T06:01:00.000Z'),
    });
    await new PostgresConversationEventProcessor(pool).processEvent(echoId);
    const statusId = await insertSyntheticPendingEvent(pool, {
      channel: prepared.identity.channel,
      channelAccountId: prepared.identity.channelAccountId,
      contactId: prepared.identity.externalContactId,
      eventKind: 'message_status',
      fixtureKey: 'execute-linked-status',
      messageStatus: 'delivered',
      occurredAt: new Date('2026-08-31T06:01:30.000Z'),
    });
    await new PostgresConversationEventProcessor(pool).processEvent(statusId);
    await new PostgresConsentPolicy(pool).recordReviewerCommand(
      {
        identity: messengerIdentity,
        action: 'grant',
        category: 'security_updates',
        wording: 'Synthetic approved static consent wording',
        wordingVersion: '2026-08',
        source: 'reviewer_recorded',
        sourceAt: new Date('2026-08-31T06:01:45.000Z'),
        idempotencyKey: 'synthetic-deletion-execute-consent',
      },
      supportReviewer,
    );
    const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'execute-confirmation',
      identity: prepared.identity,
      messageText: 'Synthetic explicit deletion confirmation',
      occurredAt: new Date('2026-08-31T06:02:00.000Z'),
    });
    await prepared.policy.reviewRequest(
      reviewCommand({
        confirmationEventId: confirmation.eventId,
        decidedAt: new Date('2026-08-31T06:03:00.000Z'),
        fixtureKey: 'execute',
        requestRef: prepared.requestRef,
      }),
      supportReviewer,
    );

    const result = await prepared.policy.executeApprovedRequest({
      executedAt: new Date('2026-08-31T06:04:00.000Z'),
      requestKey: 'synthetic-deletion-execute',
      requestRef: prepared.requestRef,
    });

    expect(Object.keys(result).sort()).toEqual([
      'conversationsProcessed',
      'identitiesPseudonymized',
      'messagesCleared',
      'requestRef',
      'status',
      'tombstonesCreated',
    ]);
    expect(result).toEqual({
      conversationsProcessed: 2,
      identitiesPseudonymized: 2,
      messagesCleared: 4,
      requestRef: prepared.requestRef,
      status: 'applied',
      tombstonesCreated: 2,
    });
    const identities = await pool.query<{
      readonly channel: string;
      readonly channel_account_id: string;
      readonly external_contact_id: string;
    }>(
      `select channel, channel_account_id, external_contact_id
       from channel_identities
       where contact_id = $1
       order by channel`,
      [subjectContactId],
    );
    expect(identities.rows).toHaveLength(2);
    for (const row of identities.rows) {
      expect(row.channel_account_id).toMatch(/^deleted:[0-9a-f-]{36}$/);
      expect(row.external_contact_id).toMatch(/^deleted:[0-9a-f-]{36}$/);
      expect(row.channel_account_id).not.toBe(row.external_contact_id);
    }
    const events = await pool.query<{
      readonly channel_account_id: string | null;
      readonly contact_id: string | null;
      readonly external_message_id: string | null;
      readonly idempotency_key: string;
      readonly message_status: string | null;
      readonly message_text: string | null;
    }>(
      `select idempotency_key, channel_account_id, contact_id, external_message_id,
              message_text, message_status
       from webhook_events
       order by id`,
    );
    expect(events.rows).toHaveLength(5);
    for (const row of events.rows) {
      expect(row.idempotency_key).toMatch(/^privacy:test-v1:[0-9a-f]{64}$/);
      expect(row).toMatchObject({
        channel_account_id: null,
        contact_id: null,
        external_message_id: null,
        message_status: null,
        message_text: null,
      });
    }
    const request = await pool.query(
      `select state, contact_id, source_webhook_event_id
       from privacy_requests where request_ref = $1`,
      [prepared.requestRef],
    );
    expect(request.rows).toEqual([
      { contact_id: null, source_webhook_event_id: null, state: 'in_progress' },
    ]);
    const locations = await pool.query<{
      readonly location_code: string;
      readonly outcome_code: string | null;
      readonly state: string;
    }>(
      `select location_code, state, outcome_code
       from privacy_request_locations
       where request_id = (select id from privacy_requests where request_ref = $1)
       order by location_code`,
      [prepared.requestRef],
    );
    expect(locations.rows.filter((row) => row.state === 'completed')).toEqual([
      {
        location_code: 'pending_outbound',
        outcome_code: 'local_erasure_complete',
        state: 'completed',
      },
      {
        location_code: 'primary_postgres',
        outcome_code: 'local_erasure_complete',
        state: 'completed',
      },
    ]);
    expect(locations.rows.filter((row) => row.state === 'pending')).toHaveLength(5);
    const boundedEvidence = await pool.query<{
      readonly audit_rows: number;
      readonly consent_rows: number;
      readonly retention_rows: number;
      readonly runs: number;
      readonly tombstones: number;
    }>(
      `select
         (select count(*)::int from privacy_suppressions
          where category = 'deletion_tombstone') as tombstones,
         (select count(*)::int from privacy_deletion_runs) as runs,
         (select count(*)::int from consent_events) as consent_rows,
         (select count(*)::int from retention_events) as retention_rows,
         (select count(*)::int from policy_audit_outcomes) as audit_rows`,
    );
    expect(boundedEvidence.rows).toHaveLength(1);
    const evidence = boundedEvidence.rows[0];
    if (evidence === undefined) throw new Error('Synthetic erasure evidence missing');
    expect(evidence).toMatchObject({
      consent_rows: 1,
      runs: 1,
      tombstones: 2,
    });
    expect(evidence.audit_rows).toBeGreaterThanOrEqual(0);
    expect(evidence.retention_rows).toBeGreaterThanOrEqual(0);
    await expect(
      prepared.policy.isIdentityDeleted(prepared.identity, new Date('2026-08-31T06:05:00.000Z')),
    ).resolves.toBe(true);
    await expect(
      prepared.policy.isIdentityDeleted(messengerIdentity, new Date('2026-08-31T06:05:00.000Z')),
    ).resolves.toBe(true);
    const serialized = JSON.stringify({
      events: events.rows,
      identities: identities.rows,
      request: request.rows,
    });
    for (const rawValue of [
      prepared.identity.channelAccountId,
      prepared.identity.externalContactId,
      messengerIdentity.channelAccountId,
      messengerIdentity.externalContactId,
      'Synthetic explicit deletion confirmation',
      'Synthetic linked Messenger content',
      'Synthetic linked human reply',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
  });

  test('returns the recorded result for exact replay and rejects changed execution material', async () => {
    const prepared = await prepareApprovedDeletionRequest({
      fixtureKey: 'execute-replay',
      requestedAt: new Date('2026-08-31T06:10:00.000Z'),
    });
    const command = executeCommand({
      executedAt: new Date('2026-08-31T06:13:00.000Z'),
      fixtureKey: 'execute-replay',
      requestRef: prepared.requestRef,
    });

    const applied = await prepared.policy.executeApprovedRequest(command);
    await expect(prepared.policy.executeApprovedRequest(command)).resolves.toEqual({
      ...applied,
      status: 'duplicate',
    });
    await expect(
      prepared.policy.executeApprovedRequest({
        ...command,
        executedAt: new Date('2026-08-31T06:13:00.001Z'),
      }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    const evidence = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from privacy_deletion_runs`,
    );
    expect(evidence.rows).toEqual([{ count: 1 }]);
  });

  test('serializes concurrent exact executions into one application and one duplicate', async () => {
    const prepared = await prepareApprovedDeletionRequest({
      fixtureKey: 'execute-concurrent',
      requestedAt: new Date('2026-08-31T06:20:00.000Z'),
    });
    const command = executeCommand({
      executedAt: new Date('2026-08-31T06:23:00.000Z'),
      fixtureKey: 'execute-concurrent',
      requestRef: prepared.requestRef,
    });

    const results = await Promise.all([
      prepared.policy.executeApprovedRequest(command),
      prepared.policy.executeApprovedRequest(command),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'duplicate']);
    const evidence = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from privacy_deletion_runs`,
    );
    expect(evidence.rows).toEqual([{ count: 1 }]);
  });

  test('refuses unconfirmed and rejected requests without creating erasure state', async () => {
    const unconfirmed = await prepareDeletionRequest({
      fixtureKey: 'execute-unconfirmed',
      requestedAt: new Date('2026-08-31T06:30:00.000Z'),
    });
    await expect(
      unconfirmed.policy.executeApprovedRequest(
        executeCommand({
          executedAt: new Date('2026-08-31T06:31:00.000Z'),
          fixtureKey: 'execute-unconfirmed',
          requestRef: unconfirmed.requestRef,
        }),
      ),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });

    const rejected = await prepareDeletionRequest({
      fixtureKey: 'execute-rejected',
      requestedAt: new Date('2026-08-31T06:32:00.000Z'),
    });
    const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'execute-rejected-confirmation',
      identity: rejected.identity,
      occurredAt: new Date('2026-08-31T06:33:00.000Z'),
    });
    await rejected.policy.reviewRequest(
      reviewCommand({
        confirmationEventId: confirmation.eventId,
        decidedAt: new Date('2026-08-31T06:34:00.000Z'),
        decision: 'reject',
        fixtureKey: 'execute-rejected',
        reasonCode: 'request_withdrawn',
        requestRef: rejected.requestRef,
      }),
      supportReviewer,
    );
    await expect(
      rejected.policy.executeApprovedRequest(
        executeCommand({
          executedAt: new Date('2026-08-31T06:35:00.000Z'),
          fixtureKey: 'execute-rejected',
          requestRef: rejected.requestRef,
        }),
      ),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });
    const erasureState = await pool.query(
      `select
         (select count(*)::int from privacy_deletion_runs) as runs,
         (select count(*)::int from privacy_suppressions) as tombstones`,
    );
    expect(erasureState.rows).toEqual([{ runs: 0, tombstones: 0 }]);
  });

  test('rolls back tombstones and mutations when aggregate evidence cannot be written', async () => {
    const prepared = await prepareApprovedDeletionRequest({
      fixtureKey: 'execute-rollback',
      requestedAt: new Date('2026-08-31T06:40:00.000Z'),
    });
    await pool.query(
      `create function synthetic_reject_deletion_run()
       returns trigger language plpgsql as $$
       begin
         raise exception using errcode = 'P0001',
           message = 'synthetic deletion run rejection';
       end;
       $$;
       create trigger synthetic_reject_deletion_run
         before insert on privacy_deletion_runs
         for each row execute function synthetic_reject_deletion_run()`,
    );
    try {
      await expect(
        prepared.policy.executeApprovedRequest(
          executeCommand({
            executedAt: new Date('2026-08-31T06:43:00.000Z'),
            fixtureKey: 'execute-rollback',
            requestRef: prepared.requestRef,
          }),
        ),
      ).rejects.toThrow('synthetic deletion run rejection');
    } finally {
      await pool.query(
        `drop trigger if exists synthetic_reject_deletion_run on privacy_deletion_runs;
         drop function if exists synthetic_reject_deletion_run()`,
      );
    }
    const afterRollback = await pool.query(
      `select
         (select state from privacy_requests where request_ref = $1) as request_state,
         (select count(*)::int from privacy_deletion_runs) as runs,
         (select count(*)::int from privacy_suppressions) as tombstones,
         (select count(*)::int from channel_identities
          where channel_account_id = $2 and external_contact_id = $3) as raw_identities,
         (select count(*)::int from webhook_events
          where channel_account_id = $2 and contact_id = $3 and message_text is not null) as raw_events,
         (select count(*)::int from privacy_request_locations
          where request_id = (select id from privacy_requests where request_ref = $1)
            and state = 'completed') as completed_locations`,
      [
        prepared.requestRef,
        prepared.identity.channelAccountId,
        prepared.identity.externalContactId,
      ],
    );
    expect(afterRollback.rows).toEqual([
      {
        completed_locations: 0,
        raw_events: 2,
        raw_identities: 1,
        request_state: 'human_review',
        runs: 0,
        tombstones: 0,
      },
    ]);
  });

  test('suppresses later events for the erased identity without resurrecting customer state', async () => {
    const prepared = await prepareApprovedDeletionRequest({
      fixtureKey: 'execute-resurrection',
      requestedAt: new Date('2026-08-31T06:50:00.000Z'),
    });
    await prepared.policy.executeApprovedRequest(
      executeCommand({
        executedAt: new Date('2026-08-31T06:53:00.000Z'),
        fixtureKey: 'execute-resurrection',
        requestRef: prepared.requestRef,
      }),
    );
    const before = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from channel_identities) as identities,
         (select count(*)::int from conversations) as conversations,
         (select count(*)::int from conversation_retention_states) as retention_states,
         (select count(*)::int from consent_events) as consent_events`,
    );
    const receipt = await new PostgresReceiptStore(pool, keyring).store({
      events: [
        {
          channel: prepared.identity.channel,
          channelAccountId: prepared.identity.channelAccountId,
          contactId: prepared.identity.externalContactId,
          externalMessageId: 'wamid.TEST_execute_resurrection_after',
          idempotencyKey: 'whatsapp:message:wamid.TEST_execute_resurrection_after',
          kind: 'customer_message',
          occurredAt: new Date('2026-08-31T06:54:00.000Z'),
          text: 'Synthetic content sent after completed local erasure',
        },
      ],
      payloadSha256: 'e'.repeat(64),
      receivedAt: new Date('2026-08-31T06:54:05.000Z'),
    });
    expect(receipt).toMatchObject({ insertedEventCount: 1, outcome: 'accepted' });
    const suppressed = await pool.query<{
      readonly id: string;
      readonly [key: string]: unknown;
    }>(
      `select id, idempotency_key, admission_outcome, reason_code,
              channel_account_id, contact_id, external_message_id, message_text
       from webhook_events where receipt_id = $1`,
      [receipt.receiptId],
    );
    expect(suppressed.rows).toHaveLength(1);
    expect(suppressed.rows[0]).toMatchObject({
      admission_outcome: 'suppressed',
      channel_account_id: null,
      contact_id: null,
      external_message_id: null,
      message_text: null,
      reason_code: 'deletion_tombstone',
    });
    expect(suppressed.rows[0]?.idempotency_key).toMatch(/^privacy:test-v1:[0-9a-f]{64}$/);
    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(suppressed.rows[0]?.id ?? ''),
    ).resolves.toEqual({ status: 'not_processable' });
    const after = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from channel_identities) as identities,
         (select count(*)::int from conversations) as conversations,
         (select count(*)::int from conversation_retention_states) as retention_states,
         (select count(*)::int from consent_events) as consent_events`,
    );
    expect(after.rows).toEqual(before.rows);
    const serialized = JSON.stringify(suppressed.rows);
    expect(serialized).not.toContain(prepared.identity.channelAccountId);
    expect(serialized).not.toContain(prepared.identity.externalContactId);
    expect(serialized).not.toContain('Synthetic content sent after completed local erasure');
  });
});
