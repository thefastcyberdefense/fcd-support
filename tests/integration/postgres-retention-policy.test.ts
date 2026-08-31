import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import {
  PostgresRetentionPolicy,
  RetentionIdempotencyConflictError,
  RetentionNoReclassificationHistoryError,
  RetentionSourceAuthorityError,
} from '../../src/persistence/postgres-retention-policy.js';
import { PolicyOwnerAuthorizationError } from '../../src/policy/reviewer-principal.js';
import { insertSyntheticPendingEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const supportReviewer = {
  reviewerRef: 'REVIEWER_TEST_retention',
  roles: ['support_reviewer'],
};

const policyOwner = {
  reviewerRef: 'OWNER_TEST_retention',
  roles: ['policy_owner'],
};

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_retention_policy',
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

async function applyCustomerMessage(input: {
  readonly fixtureKey: string;
  readonly occurredAt: Date;
}): Promise<{ readonly conversationId: string; readonly eventId: string }> {
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${input.fixtureKey}`,
    contactId: `PSID_TEST_${input.fixtureKey}`,
    eventKind: 'customer_message',
    fixtureKey: `${input.fixtureKey}-customer`,
    messageText: 'Synthetic retention policy customer message',
    occurredAt: input.occurredAt,
  });
  const applied = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  if (applied.status !== 'applied' || applied.conversationId === undefined) {
    throw new Error('Synthetic customer event was not applied');
  }
  return { conversationId: applied.conversationId, eventId };
}

async function applyBusinessEcho(input: {
  readonly conversationId: string;
  readonly fixtureKey: string;
  readonly occurredAt: Date;
  readonly provenHuman: boolean;
}): Promise<string> {
  const identity = await pool.query<{
    readonly channel_account_id: string;
    readonly external_contact_id: string;
  }>(
    `select identity.channel_account_id, identity.external_contact_id
     from conversations as conversation
     join channel_identities as identity on identity.id = conversation.channel_identity_id
     where conversation.id = $1`,
    [input.conversationId],
  );
  const row = identity.rows[0];
  if (row === undefined) {
    throw new Error('Synthetic conversation identity was not found');
  }

  await pool.query(
    `update conversations
     set last_authorized_resume_at = $2,
         ai_paused_until = null
     where id = $1`,
    [
      input.conversationId,
      input.provenHuman
        ? new Date(input.occurredAt.getTime() - 1)
        : new Date(input.occurredAt.getTime() + 1),
    ],
  );
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: row.channel_account_id,
    contactId: row.external_contact_id,
    eventKind: 'business_message_echo',
    fixtureKey: `${input.fixtureKey}-echo`,
    messageText: 'Synthetic retention policy business echo',
    occurredAt: input.occurredAt,
  });
  const applied = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  const expectedOutcome = input.provenHuman
    ? 'business_echo_paused'
    : 'business_echo_ignored_before_resume';
  if (
    applied.status !== 'applied' ||
    applied.conversationId !== input.conversationId ||
    applied.outcome !== expectedOutcome
  ) {
    throw new Error('Synthetic business echo did not reach the expected application outcome');
  }
  return eventId;
}

describe('PostgresRetentionPolicy qualifying lead events', () => {
  test('promotes casual retention from an authoritative customer event with exact month-end clamping', async () => {
    const occurredAt = new Date('2024-02-29T06:07:08.009Z');
    const { conversationId, eventId } = await applyCustomerMessage({
      fixtureKey: 'lead-customer-month-end',
      occurredAt,
    });

    const result = await new PostgresRetentionPolicy(pool).recordQualifyingEvent(
      {
        conversationId,
        requestKey: 'lead-customer-month-end',
        sourceWebhookEventId: eventId,
        targetClass: 'unconverted_lead',
      },
      supportReviewer,
    );

    expect(result).toMatchObject({ status: 'applied' });
    expect(result.retentionEventId).toMatch(/^\d+$/);
    const state = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [conversationId],
    );
    expect(state.rows).toEqual([
      {
        anchor_at: occurredAt,
        expires_at: new Date('2025-02-28T06:07:08.009Z'),
        lifecycle_class: 'unconverted_lead',
        relationship_status: null,
        row_version: '2',
      },
    ]);
    const history = await pool.query(
      `select decision_type, outcome, reason_code, actor_type, source_type,
              previous_class, resulting_class, effective_at,
              resulting_anchor_at, resulting_expires_at,
              source_webhook_event_id, reviewer_reference, request_key
       from retention_events
       where id = $1`,
      [result.retentionEventId],
    );
    expect(history.rows).toEqual([
      {
        actor_type: 'support_reviewer',
        decision_type: 'classification_change',
        effective_at: occurredAt,
        outcome: 'applied',
        previous_class: 'casual_chat',
        reason_code: 'lead_interaction',
        request_key: 'lead-customer-month-end',
        resulting_anchor_at: occurredAt,
        resulting_class: 'unconverted_lead',
        resulting_expires_at: new Date('2025-02-28T06:07:08.009Z'),
        reviewer_reference: 'REVIEWER_TEST_retention',
        source_type: 'customer_message',
        source_webhook_event_id: eventId,
      },
    ]);
  });

  test('promotes and advances lead retention only from proven human echoes newer than the stored anchor', async () => {
    const seed = await applyCustomerMessage({
      fixtureKey: 'lead-human-echo',
      occurredAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const firstEchoAt = new Date('2024-01-31T10:11:12.013Z');
    const firstEchoId = await applyBusinessEcho({
      conversationId: seed.conversationId,
      fixtureKey: 'lead-human-echo-first',
      occurredAt: firstEchoAt,
      provenHuman: true,
    });
    const policy = new PostgresRetentionPolicy(pool);

    await expect(
      policy.recordQualifyingEvent(
        {
          conversationId: seed.conversationId,
          requestKey: 'lead-human-echo-first',
          sourceWebhookEventId: firstEchoId,
          targetClass: 'unconverted_lead',
        },
        supportReviewer,
      ),
    ).resolves.toMatchObject({ status: 'applied' });

    const newerEchoAt = new Date('2024-02-29T10:11:12.013Z');
    const newerEchoId = await applyBusinessEcho({
      conversationId: seed.conversationId,
      fixtureKey: 'lead-human-echo-newer',
      occurredAt: newerEchoAt,
      provenHuman: true,
    });
    await expect(
      policy.recordQualifyingEvent(
        {
          conversationId: seed.conversationId,
          requestKey: 'lead-human-echo-newer',
          sourceWebhookEventId: newerEchoId,
          targetClass: 'unconverted_lead',
        },
        supportReviewer,
      ),
    ).resolves.toMatchObject({ status: 'applied' });

    const olderEchoAt = new Date('2024-01-15T10:11:12.013Z');
    const olderEchoId = await applyBusinessEcho({
      conversationId: seed.conversationId,
      fixtureKey: 'lead-human-echo-older',
      occurredAt: olderEchoAt,
      provenHuman: true,
    });
    await expect(
      policy.recordQualifyingEvent(
        {
          conversationId: seed.conversationId,
          requestKey: 'lead-human-echo-older',
          sourceWebhookEventId: olderEchoId,
          targetClass: 'unconverted_lead',
        },
        supportReviewer,
      ),
    ).resolves.toMatchObject({ status: 'ignored' });

    const state = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [seed.conversationId],
    );
    expect(state.rows).toEqual([
      {
        anchor_at: newerEchoAt,
        expires_at: new Date('2025-02-28T10:11:12.013Z'),
        lifecycle_class: 'unconverted_lead',
        row_version: '3',
      },
    ]);
    const echoHistory = await pool.query(
      `select outcome, reason_code, effective_at, resulting_anchor_at,
              resulting_expires_at, source_type
       from retention_events
       where request_key like 'lead-human-echo-%'
       order by id`,
    );
    expect(echoHistory.rows).toEqual([
      {
        effective_at: firstEchoAt,
        outcome: 'applied',
        reason_code: 'human_reply',
        resulting_anchor_at: firstEchoAt,
        resulting_expires_at: new Date('2025-01-31T10:11:12.013Z'),
        source_type: 'business_message_echo',
      },
      {
        effective_at: newerEchoAt,
        outcome: 'applied',
        reason_code: 'human_reply',
        resulting_anchor_at: newerEchoAt,
        resulting_expires_at: new Date('2025-02-28T10:11:12.013Z'),
        source_type: 'business_message_echo',
      },
      {
        effective_at: olderEchoAt,
        outcome: 'ignored',
        reason_code: 'out_of_order_ignored',
        resulting_anchor_at: newerEchoAt,
        resulting_expires_at: new Date('2025-02-28T10:11:12.013Z'),
        source_type: 'business_message_echo',
      },
    ]);
  });

  test('rejects unapplied, unsupported, status, other-conversation, mismatched-time, and unproven echo sources', async () => {
    const authoritative = await applyCustomerMessage({
      fixtureKey: 'lead-invalid-authoritative',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const other = await applyCustomerMessage({
      fixtureKey: 'lead-invalid-other',
      occurredAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const unappliedId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_lead_unapplied',
      contactId: 'PSID_TEST_lead_unapplied',
      eventKind: 'customer_message',
      fixtureKey: 'lead-invalid-unapplied',
      messageText: 'Synthetic unapplied lead source',
      occurredAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    const unsupportedId = await insertSyntheticPendingEvent(pool, {
      channel: 'unknown',
      eventKind: 'unsupported',
      fixtureKey: 'lead-invalid-unsupported',
    });
    const statusId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_lead_status',
      contactId: 'PSID_TEST_lead_status',
      eventKind: 'message_status',
      fixtureKey: 'lead-invalid-status',
      messageStatus: 'delivered',
      occurredAt: new Date('2026-01-04T00:00:00.000Z'),
    });
    await new PostgresConversationEventProcessor(pool).processEvent(statusId);
    const unprovenEchoId = await applyBusinessEcho({
      conversationId: authoritative.conversationId,
      fixtureKey: 'lead-invalid-unproven-echo',
      occurredAt: new Date('2026-01-05T00:00:00.000Z'),
      provenHuman: false,
    });

    const policy = new PostgresRetentionPolicy(pool);
    const invalidSources = [
      ['unapplied', unappliedId, authoritative.conversationId],
      ['unsupported', unsupportedId, authoritative.conversationId],
      ['status', statusId, authoritative.conversationId],
      ['other-conversation', other.eventId, authoritative.conversationId],
      ['unproven-echo', unprovenEchoId, authoritative.conversationId],
    ] as const;
    for (const [fixtureKey, sourceWebhookEventId, conversationId] of invalidSources) {
      await expect(
        policy.recordQualifyingEvent(
          {
            conversationId,
            requestKey: `lead-invalid-${fixtureKey}`,
            sourceWebhookEventId,
            targetClass: 'unconverted_lead',
          },
          supportReviewer,
        ),
      ).rejects.toBeInstanceOf(RetentionSourceAuthorityError);
    }

    await pool.query(
      `alter table webhook_events disable trigger webhook_events_retention_source_stability`,
    );
    try {
      await pool.query(`update webhook_events set occurred_at = $2 where id = $1`, [
        authoritative.eventId,
        new Date('2026-01-01T00:00:01.000Z'),
      ]);
    } finally {
      await pool.query(
        `alter table webhook_events enable trigger webhook_events_retention_source_stability`,
      );
    }
    await expect(
      policy.recordQualifyingEvent(
        {
          conversationId: authoritative.conversationId,
          requestKey: 'lead-invalid-mismatched-time',
          sourceWebhookEventId: authoritative.eventId,
          targetClass: 'unconverted_lead',
        },
        supportReviewer,
      ),
    ).rejects.toBeInstanceOf(RetentionSourceAuthorityError);

    const unintended = await pool.query(
      `select count(*)::int as count
       from retention_events
       where request_key like 'lead-invalid-%'`,
    );
    expect(unintended.rows).toEqual([{ count: 0 }]);
  });
});

describe('retention source stability', () => {
  test('freezes authoritative source kind and provider time while allowing content purge', async () => {
    const sourceAt = new Date('2026-02-03T04:05:06.007Z');
    const source = await applyCustomerMessage({
      fixtureKey: 'lead-source-stability',
      occurredAt: sourceAt,
    });
    await new PostgresRetentionPolicy(pool).recordQualifyingEvent(
      {
        conversationId: source.conversationId,
        requestKey: 'lead-source-stability',
        sourceWebhookEventId: source.eventId,
        targetClass: 'unconverted_lead',
      },
      supportReviewer,
    );

    await expect(
      pool.query(`update webhook_events set occurred_at = $2 where id = $1`, [
        source.eventId,
        new Date('2026-02-03T04:05:07.007Z'),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`update webhook_events set event_kind = 'unsupported' where id = $1`, [
        source.eventId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`update webhook_events set message_text = null where id = $1`, [source.eventId]),
    ).resolves.toMatchObject({ rowCount: 1 });

    const stable = await pool.query(
      `select event_kind, occurred_at, message_text
       from webhook_events
       where id = $1`,
      [source.eventId],
    );
    expect(stable.rows).toEqual([
      {
        event_kind: 'customer_message',
        message_text: null,
        occurred_at: sourceAt,
      },
    ]);
  });
});

async function applyCustomerMessageToConversation(input: {
  readonly conversationId: string;
  readonly fixtureKey: string;
  readonly occurredAt: Date;
}): Promise<string> {
  const identity = await pool.query<{
    readonly channel_account_id: string;
    readonly external_contact_id: string;
  }>(
    `select identity.channel_account_id, identity.external_contact_id
     from conversations as conversation
     join channel_identities as identity on identity.id = conversation.channel_identity_id
     where conversation.id = $1`,
    [input.conversationId],
  );
  const row = identity.rows[0];
  if (row === undefined) {
    throw new Error('Synthetic active conversation identity was not found');
  }
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: row.channel_account_id,
    contactId: row.external_contact_id,
    eventKind: 'customer_message',
    fixtureKey: `${input.fixtureKey}-customer`,
    messageText: 'Synthetic active-precedence customer message',
    occurredAt: input.occurredAt,
  });
  const applied = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  if (applied.status !== 'applied' || applied.conversationId !== input.conversationId) {
    throw new Error('Synthetic active-precedence customer event was not applied');
  }
  return eventId;
}

describe('PostgresRetentionPolicy active-client lifecycle', () => {
  test('requires policy_owner before opening a database connection', async () => {
    const unavailablePool = {
      connect(): never {
        throw new Error('Database access must not occur before authorization');
      },
    } as unknown as pg.Pool;
    const policy = new PostgresRetentionPolicy(unavailablePool);
    const operations = [
      () =>
        policy.startActiveRelationship(
          {
            conversationId: '1',
            effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
            relationshipStartedAt: new Date('2026-01-01T00:00:00.000Z'),
            requestKey: 'active-owner-required-start',
          },
          supportReviewer,
        ),
      () =>
        policy.reviewActiveRelationship(
          {
            conversationId: '1',
            requestKey: 'active-owner-required-review',
            reviewedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          supportReviewer,
        ),
      () =>
        policy.closeActiveRelationship(
          {
            conversationId: '1',
            effectiveAt: new Date('2026-01-02T00:00:00.000Z'),
            relationshipEndedAt: new Date('2026-01-01T00:00:00.000Z'),
            requestKey: 'active-owner-required-close',
          },
          supportReviewer,
        ),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(PolicyOwnerAuthorizationError);
    }
  });

  test('starts a lead relationship and advances only newer annual review boundaries', async () => {
    const source = await applyCustomerMessage({
      fixtureKey: 'active-start-review',
      occurredAt: new Date('2024-02-15T06:07:08.009Z'),
    });
    const policy = new PostgresRetentionPolicy(pool);
    await policy.recordQualifyingEvent(
      {
        conversationId: source.conversationId,
        requestKey: 'active-start-review-lead',
        sourceWebhookEventId: source.eventId,
        targetClass: 'unconverted_lead',
      },
      supportReviewer,
    );
    const relationshipStartedAt = new Date('2024-02-01T06:07:08.009Z');
    const startEffectiveAt = new Date('2024-02-29T06:07:08.009Z');

    await expect(
      policy.startActiveRelationship(
        {
          conversationId: source.conversationId,
          effectiveAt: startEffectiveAt,
          relationshipStartedAt,
          requestKey: 'active-start-review-start',
        },
        policyOwner,
      ),
    ).resolves.toMatchObject({ status: 'applied' });

    const reviewedAt = new Date('2025-02-28T06:07:08.009Z');
    await expect(
      policy.reviewActiveRelationship(
        {
          conversationId: source.conversationId,
          requestKey: 'active-start-review-newer',
          reviewedAt,
        },
        policyOwner,
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    const olderReviewAt = new Date('2024-12-31T06:07:08.009Z');
    await expect(
      policy.reviewActiveRelationship(
        {
          conversationId: source.conversationId,
          requestKey: 'active-start-review-older',
          reviewedAt: olderReviewAt,
        },
        policyOwner,
      ),
    ).resolves.toMatchObject({ status: 'ignored' });

    const state = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status,
              relationship_started_at, relationship_ended_at,
              final_paid_service_completed_at, last_active_review_at,
              next_active_review_at, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    expect(state.rows).toEqual([
      {
        anchor_at: null,
        expires_at: null,
        final_paid_service_completed_at: null,
        last_active_review_at: reviewedAt,
        lifecycle_class: 'active_client',
        next_active_review_at: new Date('2026-02-28T06:07:08.009Z'),
        relationship_ended_at: null,
        relationship_started_at: relationshipStartedAt,
        relationship_status: 'open',
        row_version: '4',
      },
    ]);
    const history = await pool.query(
      `select decision_type, outcome, reason_code, actor_type, source_type,
              previous_class, resulting_class, effective_at,
              relationship_started_at, next_active_review_at,
              reviewer_reference, request_key
       from retention_events
       where request_key like 'active-start-review-%'
         and request_key <> 'active-start-review-lead'
       order by id`,
    );
    expect(history.rows).toEqual([
      {
        actor_type: 'policy_owner',
        decision_type: 'classification_change',
        effective_at: startEffectiveAt,
        next_active_review_at: new Date('2025-02-28T06:07:08.009Z'),
        outcome: 'applied',
        previous_class: 'unconverted_lead',
        reason_code: 'active_relationship_started',
        relationship_started_at: relationshipStartedAt,
        request_key: 'active-start-review-start',
        resulting_class: 'active_client',
        reviewer_reference: 'OWNER_TEST_retention',
        source_type: 'reviewer_command',
      },
      {
        actor_type: 'policy_owner',
        decision_type: 'relationship_review',
        effective_at: reviewedAt,
        next_active_review_at: new Date('2026-02-28T06:07:08.009Z'),
        outcome: 'applied',
        previous_class: 'active_client',
        reason_code: 'active_relationship_reviewed',
        relationship_started_at: relationshipStartedAt,
        request_key: 'active-start-review-newer',
        resulting_class: 'active_client',
        reviewer_reference: 'OWNER_TEST_retention',
        source_type: 'reviewer_command',
      },
      {
        actor_type: 'policy_owner',
        decision_type: 'relationship_review',
        effective_at: olderReviewAt,
        next_active_review_at: new Date('2026-02-28T06:07:08.009Z'),
        outcome: 'ignored',
        previous_class: 'active_client',
        reason_code: 'out_of_order_ignored',
        relationship_started_at: relationshipStartedAt,
        request_key: 'active-start-review-older',
        resulting_class: 'active_client',
        reviewer_reference: 'OWNER_TEST_retention',
        source_type: 'reviewer_command',
      },
    ]);
  });

  test('closes from the later documented anchor with exact replay and conflict protection', async () => {
    const source = await applyCustomerMessage({
      fixtureKey: 'active-close',
      occurredAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const policy = new PostgresRetentionPolicy(pool);
    const relationshipStartedAt = new Date('2024-01-01T00:00:00.000Z');
    const startEffectiveAt = new Date('2024-01-02T00:00:00.000Z');
    await policy.startActiveRelationship(
      {
        conversationId: source.conversationId,
        effectiveAt: startEffectiveAt,
        relationshipStartedAt,
        requestKey: 'active-close-start',
      },
      policyOwner,
    );
    const closeInput = {
      conversationId: source.conversationId,
      effectiveAt: new Date('2024-03-01T00:00:00.000Z'),
      finalPaidServiceCompletedAt: new Date('2024-02-29T07:08:09.010Z'),
      relationshipEndedAt: new Date('2024-01-31T07:08:09.010Z'),
      requestKey: 'active-close-command',
    };

    const applied = await policy.closeActiveRelationship(closeInput, policyOwner);
    expect(applied).toMatchObject({ status: 'applied' });
    await expect(policy.closeActiveRelationship(closeInput, policyOwner)).resolves.toEqual({
      retentionEventId: applied.retentionEventId,
      status: 'duplicate',
    });
    await expect(
      policy.closeActiveRelationship(
        {
          ...closeInput,
          relationshipEndedAt: new Date('2024-02-01T07:08:09.010Z'),
        },
        policyOwner,
      ),
    ).rejects.toBeInstanceOf(RetentionIdempotencyConflictError);

    const state = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status,
              relationship_started_at, relationship_ended_at,
              final_paid_service_completed_at, last_active_review_at,
              next_active_review_at, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    expect(state.rows).toEqual([
      {
        anchor_at: closeInput.finalPaidServiceCompletedAt,
        expires_at: new Date('2026-02-28T07:08:09.010Z'),
        final_paid_service_completed_at: closeInput.finalPaidServiceCompletedAt,
        last_active_review_at: startEffectiveAt,
        lifecycle_class: 'active_client',
        next_active_review_at: null,
        relationship_ended_at: closeInput.relationshipEndedAt,
        relationship_started_at: relationshipStartedAt,
        relationship_status: 'closed',
        row_version: '3',
      },
    ]);
    const closeHistory = await pool.query(
      `select decision_type, outcome, reason_code, effective_at,
              resulting_anchor_at, resulting_expires_at,
              relationship_ended_at, final_paid_service_completed_at,
              reviewer_reference
       from retention_events
       where request_key = $1`,
      [closeInput.requestKey],
    );
    expect(closeHistory.rows).toEqual([
      {
        decision_type: 'relationship_close',
        effective_at: closeInput.effectiveAt,
        final_paid_service_completed_at: closeInput.finalPaidServiceCompletedAt,
        outcome: 'applied',
        reason_code: 'active_relationship_closed',
        relationship_ended_at: closeInput.relationshipEndedAt,
        resulting_anchor_at: closeInput.finalPaidServiceCompletedAt,
        resulting_expires_at: new Date('2026-02-28T07:08:09.010Z'),
        reviewer_reference: 'OWNER_TEST_retention',
      },
    ]);
  });

  test('preserves active precedence against later customer and lead classifications', async () => {
    const source = await applyCustomerMessage({
      fixtureKey: 'active-precedence',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const policy = new PostgresRetentionPolicy(pool);
    await policy.startActiveRelationship(
      {
        conversationId: source.conversationId,
        effectiveAt: new Date('2026-01-02T00:00:00.000Z'),
        relationshipStartedAt: new Date('2026-01-01T00:00:00.000Z'),
        requestKey: 'active-precedence-start',
      },
      policyOwner,
    );
    const laterCustomerId = await applyCustomerMessageToConversation({
      conversationId: source.conversationId,
      fixtureKey: 'active-precedence-later',
      occurredAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    await expect(
      policy.recordQualifyingEvent(
        {
          conversationId: source.conversationId,
          requestKey: 'active-precedence-lead-attempt',
          sourceWebhookEventId: laterCustomerId,
          targetClass: 'unconverted_lead',
        },
        supportReviewer,
      ),
    ).resolves.toMatchObject({ status: 'ignored' });
    const state = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status,
              relationship_started_at, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    expect(state.rows).toEqual([
      {
        anchor_at: null,
        expires_at: null,
        lifecycle_class: 'active_client',
        relationship_started_at: new Date('2026-01-01T00:00:00.000Z'),
        relationship_status: 'open',
        row_version: '2',
      },
    ]);
    const leadAttempt = await pool.query(
      `select outcome, reason_code, previous_class, resulting_class,
              resulting_anchor_at, resulting_expires_at
       from retention_events
       where request_key = 'active-precedence-lead-attempt'`,
    );
    expect(leadAttempt.rows).toEqual([
      {
        outcome: 'ignored',
        previous_class: 'active_client',
        reason_code: 'higher_precedence_preserved',
        resulting_anchor_at: null,
        resulting_class: 'active_client',
        resulting_expires_at: null,
      },
    ]);
  });
});

async function prepareClosedActiveHistory(input: {
  readonly boundaryAt: Date;
  readonly fixtureKey: string;
}): Promise<{
  readonly conversationId: string;
  readonly firstEventId: string;
  readonly newestQualifyingAt: Date;
  readonly secondEventId: string;
}> {
  const first = await applyCustomerMessage({
    fixtureKey: `${input.fixtureKey}-first`,
    occurredAt: new Date('2026-01-01T12:00:00.000Z'),
  });
  const newestQualifyingAt = new Date('2026-01-15T12:00:00.000Z');
  const secondEventId = await applyCustomerMessageToConversation({
    conversationId: first.conversationId,
    fixtureKey: `${input.fixtureKey}-second`,
    occurredAt: newestQualifyingAt,
  });
  const policy = new PostgresRetentionPolicy(pool);
  await policy.recordQualifyingEvent(
    {
      conversationId: first.conversationId,
      requestKey: `${input.fixtureKey}-lead`,
      sourceWebhookEventId: secondEventId,
      targetClass: 'unconverted_lead',
    },
    supportReviewer,
  );
  await policy.startActiveRelationship(
    {
      conversationId: first.conversationId,
      effectiveAt: new Date('2026-02-01T12:00:00.000Z'),
      relationshipStartedAt: new Date('2026-01-20T12:00:00.000Z'),
      requestKey: `${input.fixtureKey}-active-start`,
    },
    policyOwner,
  );
  await policy.closeActiveRelationship(
    {
      conversationId: first.conversationId,
      effectiveAt: new Date('2026-04-01T12:00:00.000Z'),
      relationshipEndedAt: new Date('2026-03-31T12:00:00.000Z'),
      requestKey: `${input.fixtureKey}-active-close`,
    },
    policyOwner,
  );
  await pool.query(`update webhook_events set message_text = null where id = $1`, [first.eventId]);
  await pool.query(
    `update conversation_retention_states
     set content_purged_through_at = $2
     where conversation_id = $1`,
    [first.conversationId, input.boundaryAt],
  );
  return {
    conversationId: first.conversationId,
    firstEventId: first.eventId,
    newestQualifyingAt,
    secondEventId,
  };
}

describe('PostgresRetentionPolicy history-backed reclassification', () => {
  test.each([
    {
      expectedExpiresAt: new Date('2026-03-16T12:00:00.000Z'),
      fixtureKey: 'history-casual',
      targetClass: 'casual_chat' as const,
    },
    {
      expectedExpiresAt: new Date('2027-01-15T12:00:00.000Z'),
      fixtureKey: 'history-lead',
      targetClass: 'unconverted_lead' as const,
    },
  ])(
    'reclassifies to $targetClass from the newest qualifying anchor without resurrecting content',
    async ({ expectedExpiresAt, fixtureKey, targetClass }) => {
      const fixture = await prepareClosedActiveHistory({
        boundaryAt: new Date('2026-01-10T12:00:00.000Z'),
        fixtureKey,
      });
      const effectiveAt = new Date('2026-04-02T12:00:00.000Z');
      const result = await new PostgresRetentionPolicy(pool).reclassifyFromHistory(
        {
          conversationId: fixture.conversationId,
          effectiveAt,
          requestKey: `${fixtureKey}-reclassify`,
          targetClass,
        },
        policyOwner,
      );

      expect(result).toMatchObject({ status: 'applied' });
      const state = await pool.query(
        `select lifecycle_class, anchor_at, expires_at, relationship_status,
                relationship_started_at, relationship_ended_at,
                final_paid_service_completed_at, last_active_review_at,
                next_active_review_at, content_purged_through_at
         from conversation_retention_states
         where conversation_id = $1`,
        [fixture.conversationId],
      );
      expect(state.rows).toEqual([
        {
          anchor_at: fixture.newestQualifyingAt,
          content_purged_through_at: new Date('2026-01-10T12:00:00.000Z'),
          expires_at: expectedExpiresAt,
          final_paid_service_completed_at: null,
          last_active_review_at: null,
          lifecycle_class: targetClass,
          next_active_review_at: null,
          relationship_ended_at: null,
          relationship_started_at: null,
          relationship_status: null,
        },
      ]);
      const history = await pool.query(
        `select decision_type, outcome, reason_code, actor_type, source_type,
                previous_class, resulting_class, effective_at,
                resulting_anchor_at, resulting_expires_at,
                source_webhook_event_id, reviewer_reference
         from retention_events
         where id = $1`,
        [result.retentionEventId],
      );
      expect(history.rows).toEqual([
        {
          actor_type: 'policy_owner',
          decision_type: 'reclassification',
          effective_at: effectiveAt,
          outcome: 'applied',
          previous_class: 'active_client',
          reason_code: 'history_reclassification',
          resulting_anchor_at: fixture.newestQualifyingAt,
          resulting_class: targetClass,
          resulting_expires_at: expectedExpiresAt,
          reviewer_reference: 'OWNER_TEST_retention',
          source_type: 'reviewer_command',
          source_webhook_event_id: null,
        },
      ]);
      const contentPresence = await pool.query(
        `select id, message_text is not null as content_present
         from webhook_events
         where id = any($1::bigint[])
         order by id`,
        [[fixture.firstEventId, fixture.secondEventId]],
      );
      expect(contentPresence.rows).toEqual([
        { content_present: false, id: fixture.firstEventId },
        { content_present: true, id: fixture.secondEventId },
      ]);
    },
  );

  test('rejects reclassification when no target anchor is strictly newer than the purge boundary', async () => {
    const boundaryAt = new Date('2026-01-15T12:00:00.000Z');
    const fixture = await prepareClosedActiveHistory({
      boundaryAt,
      fixtureKey: 'history-no-eligible-anchor',
    });
    const before = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status,
              content_purged_through_at, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [fixture.conversationId],
    );

    await expect(
      new PostgresRetentionPolicy(pool).reclassifyFromHistory(
        {
          conversationId: fixture.conversationId,
          effectiveAt: new Date('2026-04-02T12:00:00.000Z'),
          requestKey: 'history-no-eligible-anchor-reclassify',
          targetClass: 'casual_chat',
        },
        policyOwner,
      ),
    ).rejects.toBeInstanceOf(RetentionNoReclassificationHistoryError);
    const after = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status,
              content_purged_through_at, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [fixture.conversationId],
    );
    expect(after.rows).toEqual(before.rows);
    const history = await pool.query(
      `select count(*)::int as count
       from retention_events
       where request_key = 'history-no-eligible-anchor-reclassify'`,
    );
    expect(history.rows).toEqual([{ count: 0 }]);
  });
});

describe('PostgresRetentionPolicy concurrency and rollback', () => {
  test('serializes eight exact active-start commands into one mutation and seven duplicates', async () => {
    const source = await applyCustomerMessage({
      fixtureKey: 'active-concurrent-exact',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const input = {
      conversationId: source.conversationId,
      effectiveAt: new Date('2026-05-02T00:00:00.000Z'),
      relationshipStartedAt: new Date('2026-05-01T00:00:00.000Z'),
      requestKey: 'active-concurrent-exact-start',
    };
    const policy = new PostgresRetentionPolicy(pool);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => policy.startActiveRelationship(input, policyOwner)),
    );
    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'duplicate')).toHaveLength(7);
    expect(new Set(results.map((result) => result.retentionEventId)).size).toBe(1);
    const state = await pool.query(
      `select lifecycle_class, relationship_status, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    expect(state.rows).toEqual([
      { lifecycle_class: 'active_client', relationship_status: 'open', row_version: '2' },
    ]);
    const history = await pool.query(
      `select count(*)::int as count
       from retention_events
       where request_key = $1`,
      [input.requestKey],
    );
    expect(history.rows).toEqual([{ count: 1 }]);
  });

  test('allows one of two concurrent conflicting materials and rejects the other', async () => {
    const source = await applyCustomerMessage({
      fixtureKey: 'active-concurrent-conflict',
      occurredAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const policy = new PostgresRetentionPolicy(pool);
    const requestKey = 'active-concurrent-conflict-start';
    const first = policy.startActiveRelationship(
      {
        conversationId: source.conversationId,
        effectiveAt: new Date('2026-06-02T00:00:00.000Z'),
        relationshipStartedAt: new Date('2026-06-01T00:00:00.000Z'),
        requestKey,
      },
      policyOwner,
    );
    const second = policy.startActiveRelationship(
      {
        conversationId: source.conversationId,
        effectiveAt: new Date('2026-06-03T00:00:00.000Z'),
        relationshipStartedAt: new Date('2026-06-02T00:00:00.000Z'),
        requestKey,
      },
      policyOwner,
    );

    const settled = await Promise.allSettled([first, second]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<typeof first>> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.status).toBe('applied');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RetentionIdempotencyConflictError);
    const history = await pool.query(
      `select effective_at, relationship_started_at
       from retention_events
       where request_key = $1`,
      [requestKey],
    );
    expect(history.rows).toHaveLength(1);
    const state = await pool.query(
      `select last_active_review_at as effective_at, relationship_started_at
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    expect(state.rows).toEqual(history.rows);
  });

  test('rolls back active state when bounded history insertion fails', async () => {
    const source = await applyCustomerMessage({
      fixtureKey: 'active-history-rollback',
      occurredAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const before = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    await pool.query(`
      create function fail_synthetic_retention_history()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.request_key = 'active-history-rollback-start' then
          raise exception using errcode = 'P0001', message = 'synthetic retention history failure';
        end if;
        return new;
      end;
      $$;
      create trigger fail_synthetic_retention_history_insert
        before insert on retention_events
        for each row execute function fail_synthetic_retention_history();
    `);
    try {
      await expect(
        new PostgresRetentionPolicy(pool).startActiveRelationship(
          {
            conversationId: source.conversationId,
            effectiveAt: new Date('2026-07-02T00:00:00.000Z'),
            relationshipStartedAt: new Date('2026-07-01T00:00:00.000Z'),
            requestKey: 'active-history-rollback-start',
          },
          policyOwner,
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await pool.query(`
        drop trigger if exists fail_synthetic_retention_history_insert on retention_events;
        drop function if exists fail_synthetic_retention_history();
      `);
    }
    const after = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status, row_version
       from conversation_retention_states
       where conversation_id = $1`,
      [source.conversationId],
    );
    expect(after.rows).toEqual(before.rows);
    const history = await pool.query(
      `select count(*)::int as count
       from retention_events
       where request_key = 'active-history-rollback-start'`,
    );
    expect(history.rows).toEqual([{ count: 0 }]);
  });
});
