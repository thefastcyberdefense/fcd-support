import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConsentPolicy } from '../../src/persistence/postgres-consent-policy.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import {
  PostgresRetentionJob,
  RetentionJobIdempotencyConflictError,
} from '../../src/persistence/postgres-retention-job.js';
import { PostgresRetentionPolicy } from '../../src/persistence/postgres-retention-policy.js';
import type { RetentionJobInput } from '../../src/policy/policy-types.js';
import { insertSyntheticPendingEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const supportReviewer = {
  reviewerRef: 'REVIEWER_TEST_retention_job',
  roles: ['support_reviewer'],
};

const policyOwner = {
  reviewerRef: 'OWNER_TEST_retention_job',
  roles: ['policy_owner'],
};

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('postgres_retention_job');
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

interface SyntheticConversation {
  readonly channelAccountId: string;
  readonly conversationId: string;
  readonly eventId: string;
  readonly externalContactId: string;
}

async function applyCustomerMessage(input: {
  readonly fixtureKey: string;
  readonly occurredAt: Date;
  readonly messageText?: string;
}): Promise<SyntheticConversation> {
  const channelAccountId = `PAGE_TEST_${input.fixtureKey}`;
  const externalContactId = `PSID_TEST_${input.fixtureKey}`;
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId,
    contactId: externalContactId,
    eventKind: 'customer_message',
    fixtureKey: `${input.fixtureKey}-customer`,
    messageText: input.messageText ?? 'Synthetic retention job customer message',
    occurredAt: input.occurredAt,
  });
  const applied = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  if (applied.status !== 'applied' || applied.conversationId === undefined) {
    throw new Error('Synthetic customer event was not applied');
  }
  return {
    channelAccountId,
    conversationId: applied.conversationId,
    eventId,
    externalContactId,
  };
}

async function applyBusinessEcho(input: {
  readonly conversation: SyntheticConversation;
  readonly fixtureKey: string;
  readonly occurredAt: Date;
}): Promise<string> {
  await pool.query(
    `update conversations
     set last_authorized_resume_at = $2,
         ai_paused_until = null
     where id = $1`,
    [input.conversation.conversationId, new Date(input.occurredAt.getTime() - 1)],
  );
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: input.conversation.channelAccountId,
    contactId: input.conversation.externalContactId,
    eventKind: 'business_message_echo',
    fixtureKey: `${input.fixtureKey}-echo`,
    messageText: 'Synthetic retention job later business echo',
    occurredAt: input.occurredAt,
  });
  const applied = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  if (applied.status !== 'applied' || applied.outcome !== 'business_echo_paused') {
    throw new Error('Synthetic business echo was not applied as a human pause');
  }
  return eventId;
}

async function promoteToLead(
  conversation: SyntheticConversation,
  requestKey: string,
): Promise<void> {
  await new PostgresRetentionPolicy(pool).recordQualifyingEvent(
    {
      conversationId: conversation.conversationId,
      requestKey,
      sourceWebhookEventId: conversation.eventId,
      targetClass: 'unconverted_lead',
    },
    supportReviewer,
  );
}

async function startActiveRelationship(input: {
  readonly conversation: SyntheticConversation;
  readonly relationshipStartedAt: Date;
  readonly requestKey: string;
}): Promise<void> {
  await new PostgresRetentionPolicy(pool).startActiveRelationship(
    {
      conversationId: input.conversation.conversationId,
      effectiveAt: input.relationshipStartedAt,
      relationshipStartedAt: input.relationshipStartedAt,
      requestKey: input.requestKey,
    },
    policyOwner,
  );
}

async function readPreservedCounts(): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(
    `select
       (select count(*)::int from contacts) as contacts,
       (select count(*)::int from channel_identities) as identities,
       (select count(*)::int from conversations) as conversations,
       (select count(*)::int from webhook_events) as events,
       (select count(*)::int from webhook_event_applications) as applications,
       (select count(*)::int from human_pause_events) as pauses,
       (select count(*)::int from consent_events) as consents,
       (select count(*)::int from policy_audit_outcomes) as audits,
       (select count(*)::int from conversation_retention_states) as retention_states,
       (select count(*)::int from retention_events) as retention_events`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Synthetic preservation count query returned no row');
  }
  return row;
}

describe('PostgresRetentionJob exact boundaries and preservation', () => {
  test('purges applied content at the exact casual deadline and preserves authoritative records', async () => {
    const anchorAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-03-02T00:00:00.000Z');
    const conversation = await applyCustomerMessage({
      fixtureKey: 'casual-boundary-preservation',
      occurredAt: anchorAt,
    });
    const laterEchoId = await applyBusinessEcho({
      conversation,
      fixtureKey: 'casual-boundary-preservation',
      occurredAt: new Date('2026-01-01T00:01:00.000Z'),
    });
    await new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).recordReviewerCommand(
      {
        action: 'grant',
        category: 'product_updates',
        idempotencyKey: 'consent-test-retention-job-preservation',
        identity: {
          channel: 'messenger',
          channelAccountId: conversation.channelAccountId,
          externalContactId: conversation.externalContactId,
        },
        source: 'reviewer_recorded',
        sourceAt: new Date('2026-01-01T00:02:00.000Z'),
        wording: 'Synthetic explicit opt-in wording',
        wordingVersion: 'TEST_v1',
      },
      supportReviewer,
    );
    const beforeCounts = await readPreservedCounts();

    await expect(
      new PostgresRetentionJob(pool).runExpiredContentBatch({
        evaluatedAt: new Date(expiresAt.getTime() - 1),
        limit: 10,
        requestKey: 'job-test-casual-before-boundary',
      }),
    ).resolves.toEqual({
      conversationsProcessed: 0,
      messagesPurged: 0,
      status: 'applied',
    });

    const beforeBoundary = await pool.query<{
      readonly content_purged_through_at: Date | null;
      readonly message_text: string | null;
    }>(
      `select state.content_purged_through_at, source.message_text
       from conversation_retention_states as state
       join webhook_events as source on source.id = $2
       where state.conversation_id = $1`,
      [conversation.conversationId, conversation.eventId],
    );
    expect(beforeBoundary.rows[0]).toEqual({
      content_purged_through_at: null,
      message_text: 'Synthetic retention job customer message',
    });

    await expect(
      new PostgresRetentionJob(pool).runExpiredContentBatch({
        evaluatedAt: expiresAt,
        limit: 10,
        requestKey: 'job-test-casual-exact-boundary',
      }),
    ).resolves.toEqual({
      conversationsProcessed: 1,
      messagesPurged: 1,
      status: 'applied',
    });

    const content = await pool.query<{
      readonly id: string;
      readonly message_text: string | null;
    }>(
      `select id, message_text
       from webhook_events
       where id in ($1, $2)
       order by id`,
      [conversation.eventId, laterEchoId],
    );
    expect(content.rows).toEqual([
      { id: conversation.eventId, message_text: null },
      { id: laterEchoId, message_text: 'Synthetic retention job later business echo' },
    ]);
    const state = await pool.query<{
      readonly anchor_at: Date;
      readonly content_purged_through_at: Date;
      readonly expires_at: Date;
      readonly lifecycle_class: string;
    }>(
      `select lifecycle_class, anchor_at, expires_at, content_purged_through_at
       from conversation_retention_states
       where conversation_id = $1`,
      [conversation.conversationId],
    );
    expect(state.rows[0]).toEqual({
      anchor_at: anchorAt,
      content_purged_through_at: anchorAt,
      expires_at: expiresAt,
      lifecycle_class: 'casual_chat',
    });
    await expect(readPreservedCounts()).resolves.toEqual(beforeCounts);
  });
});

describe('PostgresRetentionJob lifecycle selection', () => {
  test('honors exact lead and closed-active deadlines while excluding open active relationships', async () => {
    const lead = await applyCustomerMessage({
      fixtureKey: 'lead-exact-boundary',
      occurredAt: new Date('2025-03-02T00:00:00.000Z'),
    });
    await promoteToLead(lead, 'lead-test-exact-boundary');

    const closedActive = await applyCustomerMessage({
      fixtureKey: 'closed-active-exact-boundary',
      occurredAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    await startActiveRelationship({
      conversation: closedActive,
      relationshipStartedAt: new Date('2024-01-01T00:00:00.000Z'),
      requestKey: 'active-test-closed-start',
    });
    await new PostgresRetentionPolicy(pool).closeActiveRelationship(
      {
        conversationId: closedActive.conversationId,
        effectiveAt: new Date('2024-03-03T00:00:00.000Z'),
        relationshipEndedAt: new Date('2024-03-02T00:00:00.000Z'),
        requestKey: 'active-test-closed-close',
      },
      policyOwner,
    );

    const openActive = await applyCustomerMessage({
      fixtureKey: 'open-active-excluded',
      occurredAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    await startActiveRelationship({
      conversation: openActive,
      relationshipStartedAt: new Date('2024-01-01T00:00:00.000Z'),
      requestKey: 'active-test-open-start',
    });

    const job = new PostgresRetentionJob(pool);
    await expect(
      job.runExpiredContentBatch({
        evaluatedAt: new Date('2026-03-01T23:59:59.999Z'),
        limit: 10,
        requestKey: 'job-test-lifecycle-before-boundary',
      }),
    ).resolves.toMatchObject({ conversationsProcessed: 0, messagesPurged: 0 });
    await expect(
      job.runExpiredContentBatch({
        evaluatedAt: new Date('2026-03-02T00:00:00.000Z'),
        limit: 10,
        requestKey: 'job-test-lifecycle-exact-boundary',
      }),
    ).resolves.toEqual({
      conversationsProcessed: 2,
      messagesPurged: 2,
      status: 'applied',
    });

    const messages = await pool.query<{
      readonly id: string;
      readonly message_text: string | null;
    }>(
      `select id, message_text
       from webhook_events
       where id = any($1::bigint[])
       order by id`,
      [[lead.eventId, closedActive.eventId, openActive.eventId]],
    );
    expect(messages.rows).toEqual([
      { id: lead.eventId, message_text: null },
      { id: closedActive.eventId, message_text: null },
      { id: openActive.eventId, message_text: 'Synthetic retention job customer message' },
    ]);
  });
});

describe('PostgresRetentionJob batching and idempotency', () => {
  test('partitions in stable deadline and conversation order, replays counts, and rejects changed material', async () => {
    const first = await applyCustomerMessage({
      fixtureKey: 'batch-first',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = await applyCustomerMessage({
      fixtureKey: 'batch-second',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const third = await applyCustomerMessage({
      fixtureKey: 'batch-third',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const evaluatedAt = new Date('2026-03-02T00:00:00.000Z');
    const job = new PostgresRetentionJob(pool);
    const firstInput = {
      evaluatedAt,
      limit: 2,
      requestKey: 'job-test-stable-batch-first',
    };

    const firstRun = await job.runExpiredContentBatch(firstInput);
    expect(firstRun).toEqual({
      conversationsProcessed: 2,
      messagesPurged: 2,
      status: 'applied',
    });
    await expect(job.runExpiredContentBatch(firstInput)).resolves.toEqual({
      conversationsProcessed: 2,
      messagesPurged: 2,
      status: 'duplicate',
    });
    await expect(job.runExpiredContentBatch({ ...firstInput, limit: 3 })).rejects.toBeInstanceOf(
      RetentionJobIdempotencyConflictError,
    );

    const purged = await pool.query<{ readonly conversation_id: string }>(
      `select conversation_id
       from conversation_retention_states
       where content_purged_through_at is not null
       order by conversation_id`,
    );
    expect(purged.rows).toEqual([
      { conversation_id: first.conversationId },
      { conversation_id: second.conversationId },
    ]);

    await expect(
      job.runExpiredContentBatch({
        evaluatedAt,
        limit: 2,
        requestKey: 'job-test-stable-batch-second',
      }),
    ).resolves.toEqual({
      conversationsProcessed: 1,
      messagesPurged: 1,
      status: 'applied',
    });
    await expect(
      job.runExpiredContentBatch({
        evaluatedAt,
        limit: 2,
        requestKey: 'job-test-stable-batch-fresh-empty',
      }),
    ).resolves.toEqual({
      conversationsProcessed: 0,
      messagesPurged: 0,
      status: 'applied',
    });

    const runCount = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from retention_job_runs`,
    );
    expect(runCount.rows[0]?.count).toBe(3);
    expect(third.conversationId).toBeDefined();
  });

  test('different concurrent keys process each due state at most once with skip-locked batches', async () => {
    const conversations = await Promise.all(
      ['one', 'two', 'three', 'four'].map((suffix) =>
        applyCustomerMessage({
          fixtureKey: `concurrent-${suffix}`,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ),
    );
    const evaluatedAt = new Date('2026-03-02T00:00:00.000Z');
    const job = new PostgresRetentionJob(pool);
    const results = await Promise.all([
      job.runExpiredContentBatch({
        evaluatedAt,
        limit: 2,
        requestKey: 'job-test-concurrent-a',
      }),
      job.runExpiredContentBatch({
        evaluatedAt,
        limit: 2,
        requestKey: 'job-test-concurrent-b',
      }),
    ]);

    expect(results.reduce((total, result) => total + result.conversationsProcessed, 0)).toBe(4);
    expect(results.reduce((total, result) => total + result.messagesPurged, 0)).toBe(4);
    const states = await pool.query<{
      readonly conversation_id: string;
      readonly content_purged_through_at: Date | null;
    }>(
      `select conversation_id, content_purged_through_at
       from conversation_retention_states
       order by conversation_id`,
    );
    expect(states.rows).toHaveLength(conversations.length);
    expect(states.rows.every((row) => row.content_purged_through_at !== null)).toBe(true);
  });
});

describe('PostgresRetentionJob rollback, privacy, and validation', () => {
  test('rolls back content and state when aggregate evidence insertion fails', async () => {
    const conversation = await applyCustomerMessage({
      fixtureKey: 'rollback-evidence',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await pool.query(`
      create function reject_synthetic_retention_job_evidence()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception using errcode = '23514', message = 'synthetic retention job evidence failure';
      end;
      $$;
      create trigger reject_synthetic_retention_job_evidence
        before insert on retention_job_runs
        for each row execute function reject_synthetic_retention_job_evidence();
    `);

    try {
      await expect(
        new PostgresRetentionJob(pool).runExpiredContentBatch({
          evaluatedAt: new Date('2026-03-02T00:00:00.000Z'),
          limit: 10,
          requestKey: 'job-test-rollback-evidence',
        }),
      ).rejects.toThrow('synthetic retention job evidence failure');
    } finally {
      await pool.query(`
        drop trigger if exists reject_synthetic_retention_job_evidence on retention_job_runs;
        drop function if exists reject_synthetic_retention_job_evidence();
      `);
    }

    const rolledBack = await pool.query<{
      readonly content_purged_through_at: Date | null;
      readonly message_text: string | null;
      readonly run_count: number;
    }>(
      `select state.content_purged_through_at, source.message_text,
              (select count(*)::int from retention_job_runs) as run_count
       from conversation_retention_states as state
       join webhook_events as source on source.id = $2
       where state.conversation_id = $1`,
      [conversation.conversationId, conversation.eventId],
    );
    expect(rolledBack.rows[0]).toEqual({
      content_purged_through_at: null,
      message_text: 'Synthetic retention job customer message',
      run_count: 0,
    });
  });

  test('stores and returns only bounded aggregate evidence', async () => {
    await applyCustomerMessage({
      fixtureKey: 'privacy-evidence',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const result = await new PostgresRetentionJob(pool).runExpiredContentBatch({
      evaluatedAt: new Date('2026-03-02T00:00:00.000Z'),
      limit: 1,
      requestKey: 'job-test-privacy-evidence',
    });
    expect(Object.keys(result).sort()).toEqual([
      'conversationsProcessed',
      'messagesPurged',
      'status',
    ]);

    const columns = await pool.query<{ readonly column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'retention_job_runs'
       order by ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'request_key',
      'evaluated_at',
      'requested_limit',
      'status',
      'conversations_processed',
      'messages_purged',
      'completed_at',
    ]);
  });

  test('rejects invalid bounds before attempting a database connection', async () => {
    const unavailablePool = {
      connect(): never {
        throw new Error('database must not be touched for invalid input');
      },
    } as unknown as pg.Pool;
    const job = new PostgresRetentionJob(unavailablePool);
    const valid = {
      evaluatedAt: new Date('2026-03-02T00:00:00.000Z'),
      limit: 10,
      requestKey: 'job-test-valid-material',
    } satisfies RetentionJobInput;
    const invalidInputs = [
      { ...valid, evaluatedAt: new Date(Number.NaN) },
      { ...valid, limit: 0 },
      { ...valid, limit: 101 },
      { ...valid, limit: 1.5 },
      { ...valid, requestKey: '   ' },
      { ...valid, requestKey: 'x'.repeat(129) },
    ];

    for (const input of invalidInputs) {
      await expect(job.runExpiredContentBatch(input)).rejects.not.toThrow(
        'database must not be touched for invalid input',
      );
    }
  });
});
