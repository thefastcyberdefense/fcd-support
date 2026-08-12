import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { insertSyntheticPendingEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let databaseConnectionString: string;
let pool: pg.Pool;
let testSchema: string;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_conversation_event_processor',
  );
  databaseConnectionString = database.connectionString;
  disposeDatabase = database.dispose;
  pool = database.pool;
  testSchema = database.schema;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       policy_audit_outcomes, consent_events, human_pause_events,
       webhook_event_applications, conversations, channel_identities,
       contacts, webhook_events, webhook_receipts
     restart identity`,
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

async function prepareResumedConversationEcho(input: {
  readonly echoOccurredAt: string;
  readonly fixtureKey: string;
  readonly resumeAt: string;
}): Promise<{
  readonly conversationId: string;
  readonly echoEventId: string;
  readonly processor: PostgresConversationEventProcessor;
}> {
  const processor = new PostgresConversationEventProcessor(pool);
  const customerEventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${input.fixtureKey}`,
    contactId: `PSID_TEST_${input.fixtureKey}`,
    eventKind: 'customer_message',
    fixtureKey: `${input.fixtureKey}-customer`,
    messageText: 'Synthetic provider-time conversation seed',
    occurredAt: new Date('2026-08-11T08:00:00.000Z'),
  });
  const customerResult = await processor.processEvent(customerEventId);
  if (customerResult.status !== 'applied' || customerResult.conversationId === undefined) {
    throw new Error('Synthetic provider-time seed was not applied');
  }

  await pool.query(
    `update conversations
     set ai_paused_until = null,
         last_authorized_resume_at = $2::timestamptz,
         updated_at = $2::timestamptz,
         row_version = row_version + 1
     where id = $1`,
    [customerResult.conversationId, input.resumeAt],
  );
  const echoEventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${input.fixtureKey}`,
    contactId: `PSID_TEST_${input.fixtureKey}`,
    eventKind: 'business_message_echo',
    fixtureKey: `${input.fixtureKey}-echo`,
    messageText: 'Synthetic provider-time echo',
    occurredAt: new Date(input.echoOccurredAt),
  });
  await pool.query(`update webhook_events set occurred_at = $2::timestamptz where id = $1`, [
    echoEventId,
    input.echoOccurredAt,
  ]);

  return { conversationId: customerResult.conversationId, echoEventId, processor };
}

async function waitForDatabaseLockWaiters(
  applicationName: string,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  let observed = { active: 0, waiting: 0 };

  while (Date.now() < deadline) {
    const activity = await pool.query<{
      readonly active: number;
      readonly waiting: number;
    }>(
      `select
         count(*) filter (where state = 'active')::int as active,
         count(*) filter (where state = 'active' and wait_event_type = 'Lock')::int as waiting
       from pg_stat_activity
       where application_name = $1`,
      [applicationName],
    );
    observed = activity.rows[0] ?? observed;
    if (observed.active === expectedCount && observed.waiting === expectedCount) {
      return;
    }
  }

  throw new Error(
    `Synthetic contention barrier observed ${String(observed.waiting)}/${String(observed.active)} lock waiters`,
  );
}

describe('PostgresConversationEventProcessor', () => {
  test('applies a customer message to bounded policy state without copying its text', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_first_state',
      contactId: 'PSID_TEST_first_state',
      eventKind: 'customer_message',
      externalMessageId: 'MID_TEST_first_state',
      fixtureKey: 'first-state',
      messageText: 'Synthetic private support question',
      occurredAt: new Date('2026-08-11T01:00:00.000Z'),
    });

    const result = await new PostgresConversationEventProcessor(pool).processEvent(webhookEventId);

    expect(result).toMatchObject({
      eventId: webhookEventId,
      outcome: 'customer_message_applied',
      status: 'applied',
    });
    const counts = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from channel_identities) as identities,
         (select count(*)::int from conversations) as conversations,
         (select count(*)::int from webhook_event_applications) as applications,
         (select count(*)::int from policy_audit_outcomes) as audits`,
    );
    expect(counts.rows).toEqual([
      { applications: 1, audits: 1, contacts: 1, conversations: 1, identities: 1 },
    ]);

    const phaseThreeTextColumns = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.columns
       where table_schema = current_schema()
         and table_name in (
           'contacts', 'channel_identities', 'conversations',
           'webhook_event_applications', 'human_pause_events',
           'consent_events', 'policy_audit_outcomes'
         )
         and column_name = 'message_text'`,
    );
    expect(phaseThreeTextColumns.rows).toEqual([]);

    const stored = await pool.query<{
      readonly channel_identity_id: string;
      readonly conversation_id: string;
      readonly decision_type: string;
      readonly evaluated_at: Date;
      readonly outcome: string;
      readonly phase_two_text: string;
      readonly reason_code: string;
      readonly related_webhook_event_id: string;
    }>(
      `select
         (select message_text from webhook_events where id = $1) as phase_two_text,
         decision_type, outcome, reason_code, conversation_id,
         channel_identity_id, related_webhook_event_id, evaluated_at
       from policy_audit_outcomes`,
      [webhookEventId],
    );
    expect(stored.rows).toMatchObject([
      {
        decision_type: 'event_application',
        evaluated_at: new Date('2026-08-11T01:00:00.000Z'),
        outcome: 'applied',
        phase_two_text: 'Synthetic private support question',
        reason_code: 'customer_message_applied',
        related_webhook_event_id: webhookEventId,
      },
    ]);
    expect(stored.rows[0]?.channel_identity_id).toMatch(/^\d+$/);
    expect(stored.rows[0]?.conversation_id).toMatch(/^\d+$/);
  });

  test('preserves identity and conversation timestamp bounds when customer events arrive out of order', async () => {
    const laterEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_out_of_order_customer',
      contactId: 'PSID_TEST_out_of_order_customer',
      createdAt: new Date('2026-08-11T05:00:00.000Z'),
      eventKind: 'customer_message',
      fixtureKey: 'out-of-order-customer-later',
      messageText: 'Synthetic later customer event',
      occurredAt: new Date('2026-08-11T05:00:00.000Z'),
    });
    const earlierEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_out_of_order_customer',
      contactId: 'PSID_TEST_out_of_order_customer',
      createdAt: new Date('2026-08-11T06:00:00.000Z'),
      eventKind: 'customer_message',
      fixtureKey: 'out-of-order-customer-earlier',
      messageText: 'Synthetic delayed earlier customer event',
      occurredAt: new Date('2026-08-11T03:00:00.000Z'),
    });
    const processor = new PostgresConversationEventProcessor(pool);

    const later = await processor.processEvent(laterEventId);
    const earlier = await processor.processEvent(earlierEventId);
    if (later.status !== 'applied' || later.conversationId === undefined) {
      throw new Error('Synthetic later customer event was not applied');
    }

    expect(later).toMatchObject({ outcome: 'customer_message_applied', status: 'applied' });
    expect(earlier).toMatchObject({
      conversationId: later.conversationId,
      outcome: 'customer_message_applied',
      status: 'applied',
    });
    const state = await pool.query(
      `select identity.first_seen_at, identity.last_seen_at,
              conversation.created_at, conversation.last_activity_at,
              conversation.row_version
       from channel_identities as identity
       join conversations as conversation
         on conversation.channel_identity_id = identity.id
       where identity.channel = 'messenger'
         and identity.channel_account_id = 'PAGE_TEST_out_of_order_customer'
         and identity.external_contact_id = 'PSID_TEST_out_of_order_customer'`,
    );
    expect(state.rows).toEqual([
      {
        created_at: new Date('2026-08-11T05:00:00.000Z'),
        first_seen_at: new Date('2026-08-11T03:00:00.000Z'),
        last_activity_at: new Date('2026-08-11T05:00:00.000Z'),
        last_seen_at: new Date('2026-08-11T05:00:00.000Z'),
        row_version: '2',
      },
    ]);
  });

  test('processes named and next events without permission to read message text', async () => {
    const namedEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_minimized_named',
      contactId: 'PSID_TEST_minimized_named',
      eventKind: 'customer_message',
      fixtureKey: 'minimized-named',
      messageText: 'Synthetic content excluded from the named policy query',
      occurredAt: new Date('2026-08-11T01:10:00.000Z'),
    });
    const nextEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_minimized_next',
      contactId: 'CONTACT_TEST_minimized_next',
      eventKind: 'customer_message',
      fixtureKey: 'minimized-next',
      messageText: 'Synthetic content excluded from the next policy query',
      occurredAt: new Date('2026-08-11T01:20:00.000Z'),
    });
    const restrictedRole = `synthetic_policy_${randomUUID().replaceAll('-', '')}`;
    const currentUser = await pool.query<{ readonly current_user: string }>(`select current_user`);
    const owner = currentUser.rows[0]?.current_user;
    if (owner === undefined || !/^[a-zA-Z0-9_]+$/.test(owner)) {
      throw new Error('Synthetic role setup could not identify a safe database owner');
    }

    await pool.query(
      `create role "${restrictedRole}" nologin;
       grant "${restrictedRole}" to "${owner}";
       grant usage on schema "${testSchema}" to "${restrictedRole}";
       grant select
         (id, admission_outcome, channel, channel_account_id, contact_id,
          event_kind, occurred_at, created_at),
         update (admission_outcome)
         on webhook_events to "${restrictedRole}";
       grant select, insert, update on
         contacts, channel_identities, conversations, webhook_event_applications,
         human_pause_events, policy_audit_outcomes
         to "${restrictedRole}";
       grant usage, select on all sequences in schema "${testSchema}"
         to "${restrictedRole}"`,
    );
    const restrictedUrl = new URL(databaseConnectionString);
    const connectionOptions = restrictedUrl.searchParams.get('options') ?? '';
    restrictedUrl.searchParams.set(
      'options',
      `${connectionOptions} -c role=${restrictedRole}`.trim(),
    );
    const restrictedPool = new pg.Pool({ connectionString: restrictedUrl.toString(), max: 1 });

    try {
      const processor = new PostgresConversationEventProcessor(restrictedPool);
      await expect(processor.processEvent(namedEventId)).resolves.toMatchObject({
        eventId: namedEventId,
        status: 'applied',
      });
      await expect(processor.processNext()).resolves.toMatchObject({
        eventId: nextEventId,
        status: 'applied',
      });
    } finally {
      await restrictedPool.end();
      await pool.query(
        `drop owned by "${restrictedRole}";
         revoke "${restrictedRole}" from "${owner}";
         drop role "${restrictedRole}"`,
      );
    }
  });

  test('returns the existing application when the same event is replayed', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_replay',
      contactId: 'PSID_TEST_replay',
      eventKind: 'customer_message',
      fixtureKey: 'replay',
      messageText: 'Synthetic replay question',
      occurredAt: new Date('2026-08-11T02:00:00.000Z'),
    });
    const processor = new PostgresConversationEventProcessor(pool);

    const first = await processor.processEvent(webhookEventId);
    const replay = await processor.processEvent(webhookEventId);

    expect(first).toMatchObject({ status: 'applied' });
    expect(replay).toEqual({
      conversationId: first.status === 'applied' ? first.conversationId : undefined,
      eventId: webhookEventId,
      outcome: 'customer_message_applied',
      status: 'already_applied',
    });
    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_event_applications) as applications,
         (select count(*)::int from policy_audit_outcomes) as audits`,
    );
    expect(counts.rows).toEqual([{ applications: 1, audits: 1 }]);
  });

  test('replaying the same echo cannot mutate its pause application', async () => {
    const echoEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_echo_replay',
      contactId: 'PSID_TEST_echo_replay',
      eventKind: 'business_message_echo',
      fixtureKey: 'echo-replay',
      messageText: 'Synthetic replayed echo',
      occurredAt: new Date('2026-08-11T02:05:00.000Z'),
    });
    const processor = new PostgresConversationEventProcessor(pool);
    const first = await processor.processEvent(echoEventId);
    expect(first).toMatchObject({ outcome: 'business_echo_paused', status: 'applied' });
    const conversationId = first.status === 'applied' ? first.conversationId : undefined;
    const beforeReplay = await pool.query(
      `select ai_paused_until, row_version,
              (select count(*)::int
               from human_pause_events
               where source_webhook_event_id = $2) as pause_history_count,
              (select count(*)::int
               from webhook_event_applications
               where webhook_event_id = $2) as application_count
       from conversations
       where id = $1`,
      [conversationId, echoEventId],
    );

    const replay = await processor.processEvent(echoEventId);

    expect(replay).toEqual({
      conversationId,
      eventId: echoEventId,
      outcome: 'business_echo_paused',
      status: 'already_applied',
    });
    expect(beforeReplay.rows).toEqual([
      {
        ai_paused_until: new Date('2026-08-12T02:05:00.000Z'),
        application_count: 1,
        pause_history_count: 1,
        row_version: '2',
      },
    ]);
    const afterReplay = await pool.query(
      `select ai_paused_until, row_version,
              (select count(*)::int
               from human_pause_events
               where source_webhook_event_id = $2) as pause_history_count,
              (select count(*)::int
               from webhook_event_applications
               where webhook_event_id = $2) as application_count
       from conversations
       where id = $1`,
      [conversationId, echoEventId],
    );
    expect(afterReplay.rows).toEqual(beforeReplay.rows);
  });

  test('serializes concurrent named processing into one state transition', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_concurrent_apply',
      contactId: 'CONTACT_TEST_concurrent_apply',
      eventKind: 'customer_message',
      fixtureKey: 'concurrent-apply',
      messageText: 'Synthetic concurrent application',
      occurredAt: new Date('2026-08-11T02:10:00.000Z'),
    });
    const applicationName = `synthetic_policy_contention_${randomUUID().replaceAll('-', '')}`;
    const contentionPool = new pg.Pool({
      application_name: applicationName,
      connectionString: databaseConnectionString,
      max: 8,
    });
    const prewarmedClients = await Promise.all(
      Array.from({ length: 8 }, async () => contentionPool.connect()),
    );
    for (const client of prewarmedClients) {
      client.release();
    }
    const processor = new PostgresConversationEventProcessor(contentionPool);
    const blocker = await pool.connect();
    const advisoryLockKey = 4_204_001;
    let blockerTransactionOpen = false;
    let calls: ReturnType<PostgresConversationEventProcessor['processEvent']>[] = [];
    let results: Awaited<ReturnType<PostgresConversationEventProcessor['processEvent']>>[];

    try {
      await pool.query(
        `create function synthetic_hold_event_application()
         returns trigger language plpgsql as $$
         begin
           perform pg_advisory_xact_lock(4204001);
           return new;
         end;
         $$;
         create trigger synthetic_hold_event_application
           before insert on webhook_event_applications
           for each row execute function synthetic_hold_event_application()`,
      );
      await blocker.query('begin');
      blockerTransactionOpen = true;
      await blocker.query(`select pg_advisory_xact_lock($1)`, [advisoryLockKey]);

      calls = Array.from({ length: 8 }, () => processor.processEvent(webhookEventId));
      await waitForDatabaseLockWaiters(applicationName, 8);
      await blocker.query('commit');
      blockerTransactionOpen = false;
      results = await Promise.all(calls);
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query('rollback');
      }
      await Promise.allSettled(calls);
      blocker.release();
      await contentionPool.end();
      await pool.query(
        `drop trigger if exists synthetic_hold_event_application
           on webhook_event_applications;
         drop function if exists synthetic_hold_event_application()`,
      );
    }

    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'already_applied')).toHaveLength(7);
    const counts = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from channel_identities) as identities,
         (select count(*)::int from conversations) as conversations,
         (select count(*)::int from webhook_event_applications) as applications,
         (select count(*)::int from policy_audit_outcomes) as audits`,
    );
    expect(counts.rows).toEqual([
      { applications: 1, audits: 1, contacts: 1, conversations: 1, identities: 1 },
    ]);
  });

  test('isolates identical external contact text by account and channel', async () => {
    const events = [
      {
        channel: 'messenger' as const,
        channelAccountId: 'PAGE_TEST_isolation_one',
        fixtureKey: 'isolation-account-one',
      },
      {
        channel: 'messenger' as const,
        channelAccountId: 'PAGE_TEST_isolation_two',
        fixtureKey: 'isolation-account-two',
      },
      {
        channel: 'whatsapp' as const,
        channelAccountId: 'PHONE_TEST_isolation',
        fixtureKey: 'isolation-channel',
      },
    ];
    const processor = new PostgresConversationEventProcessor(pool);
    for (const event of events) {
      const webhookEventId = await insertSyntheticPendingEvent(pool, {
        ...event,
        contactId: 'EXTERNAL_TEST_same_text',
        eventKind: 'customer_message',
        messageText: 'Synthetic identity isolation message',
        occurredAt: new Date('2026-08-11T02:20:00.000Z'),
      });
      await processor.processEvent(webhookEventId);
    }

    const identities = await pool.query<{
      readonly channel: string;
      readonly channel_account_id: string;
      readonly contact_id: string;
      readonly conversation_id: string;
      readonly external_contact_id: string;
    }>(
      `select channel, channel_account_id, external_contact_id, contact_id,
              conversations.id as conversation_id
       from channel_identities
       join conversations on conversations.channel_identity_id = channel_identities.id
       order by channel, channel_account_id`,
    );
    expect(
      identities.rows.map(({ channel, channel_account_id, external_contact_id }) => ({
        channel,
        channel_account_id,
        external_contact_id,
      })),
    ).toEqual([
      {
        channel: 'messenger',
        channel_account_id: 'PAGE_TEST_isolation_one',
        external_contact_id: 'EXTERNAL_TEST_same_text',
      },
      {
        channel: 'messenger',
        channel_account_id: 'PAGE_TEST_isolation_two',
        external_contact_id: 'EXTERNAL_TEST_same_text',
      },
      {
        channel: 'whatsapp',
        channel_account_id: 'PHONE_TEST_isolation',
        external_contact_id: 'EXTERNAL_TEST_same_text',
      },
    ]);
    expect(new Set(identities.rows.map((row) => row.contact_id)).size).toBe(3);
    expect(new Set(identities.rows.map((row) => row.conversation_id)).size).toBe(3);
  });

  test('claims pending events in stable order and skips ineligible rows', async () => {
    const processor = new PostgresConversationEventProcessor(pool);
    const commonTime = new Date('2026-08-11T02:30:00.000Z');
    const staleId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_claim',
      contactId: 'PSID_TEST_claim_stale',
      createdAt: new Date('2026-08-11T02:29:00.000Z'),
      eventKind: 'customer_message',
      fixtureKey: 'claim-stale',
      messageText: 'Synthetic stale claim row',
      occurredAt: commonTime,
    });
    await pool.query(`update webhook_events set admission_outcome = 'stale' where id = $1`, [
      staleId,
    ]);
    const unsupportedId = await insertSyntheticPendingEvent(pool, {
      channel: 'unknown',
      createdAt: new Date('2026-08-11T02:29:10.000Z'),
      eventKind: 'unsupported',
      fixtureKey: 'claim-unsupported',
    });
    await pool.query(`update webhook_events set admission_outcome = 'unsupported' where id = $1`, [
      unsupportedId,
    ]);
    const alreadyAppliedId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_claim',
      contactId: 'PSID_TEST_claim_applied',
      createdAt: new Date('2026-08-11T02:29:20.000Z'),
      eventKind: 'customer_message',
      fixtureKey: 'claim-applied',
      messageText: 'Synthetic already applied claim row',
      occurredAt: commonTime,
    });
    await processor.processEvent(alreadyAppliedId);
    const firstPendingId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_claim',
      contactId: 'PSID_TEST_claim_first',
      createdAt: commonTime,
      eventKind: 'customer_message',
      fixtureKey: 'claim-first',
      messageText: 'Synthetic first claim row',
      occurredAt: commonTime,
    });
    const secondPendingId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_claim',
      contactId: 'PSID_TEST_claim_second',
      createdAt: commonTime,
      eventKind: 'customer_message',
      fixtureKey: 'claim-second',
      messageText: 'Synthetic second claim row',
      occurredAt: commonTime,
    });

    await expect(processor.processNext()).resolves.toMatchObject({
      eventId: firstPendingId,
      status: 'applied',
    });
    await expect(processor.processNext()).resolves.toMatchObject({
      eventId: secondPendingId,
      status: 'applied',
    });
    await expect(processor.processNext()).resolves.toEqual({ status: 'no_pending_event' });
  });

  test('claims the next row while the oldest pending row is locked by another caller', async () => {
    const oldestEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_skip_locked',
      contactId: 'PSID_TEST_skip_locked_oldest',
      createdAt: new Date('2026-08-11T02:31:00.000Z'),
      eventKind: 'customer_message',
      fixtureKey: 'skip-locked-oldest',
      messageText: 'Synthetic locked oldest event',
      occurredAt: new Date('2026-08-11T02:31:00.000Z'),
    });
    const nextEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_skip_locked',
      contactId: 'PSID_TEST_skip_locked-next',
      createdAt: new Date('2026-08-11T02:32:00.000Z'),
      eventKind: 'customer_message',
      fixtureKey: 'skip-locked-next',
      messageText: 'Synthetic next claim event',
      occurredAt: new Date('2026-08-11T02:32:00.000Z'),
    });
    const oldestLocker = await pool.connect();
    let lockerTransactionOpen = false;

    try {
      await oldestLocker.query('begin');
      lockerTransactionOpen = true;
      await oldestLocker.query(`select id from webhook_events where id = $1 for update`, [
        oldestEventId,
      ]);

      const claimed = await new PostgresConversationEventProcessor(pool).processNext();

      expect(claimed).toMatchObject({ eventId: nextEventId, status: 'applied' });
      const whileLocked = await pool.query(
        `select webhook_event_id from webhook_event_applications order by webhook_event_id`,
      );
      expect(whileLocked.rows).toEqual([{ webhook_event_id: nextEventId }]);
      await oldestLocker.query('commit');
      lockerTransactionOpen = false;
    } finally {
      if (lockerTransactionOpen) {
        await oldestLocker.query('rollback');
      }
      oldestLocker.release();
    }

    await expect(new PostgresConversationEventProcessor(pool).processNext()).resolves.toMatchObject(
      {
        eventId: oldestEventId,
        status: 'applied',
      },
    );
  });

  test('a new processor instance returns the application committed by the first instance', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_restart',
      contactId: 'PSID_TEST_restart',
      eventKind: 'customer_message',
      fixtureKey: 'restart',
      messageText: 'Synthetic restart state',
      occurredAt: new Date('2026-08-11T02:40:00.000Z'),
    });

    await new PostgresConversationEventProcessor(pool).processEvent(webhookEventId);
    const afterRestart = await new PostgresConversationEventProcessor(pool).processEvent(
      webhookEventId,
    );

    expect(afterRestart).toMatchObject({
      eventId: webhookEventId,
      outcome: 'customer_message_applied',
      status: 'already_applied',
    });
  });

  test('ignores a message status without creating identity or conversation state', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_status',
      contactId: 'CONTACT_TEST_status',
      eventKind: 'message_status',
      externalMessageId: 'MID_TEST_status',
      fixtureKey: 'status',
      messageStatus: 'delivered',
      occurredAt: new Date('2026-08-11T02:50:00.000Z'),
    });

    const result = await new PostgresConversationEventProcessor(pool).processEvent(webhookEventId);

    expect(result).toEqual({
      eventId: webhookEventId,
      outcome: 'message_status_ignored',
      status: 'applied',
    });
    const counts = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from channel_identities) as identities,
         (select count(*)::int from conversations) as conversations,
         (select count(*)::int from webhook_event_applications) as applications,
         (select count(*)::int from policy_audit_outcomes) as audits`,
    );
    expect(counts.rows).toEqual([
      { applications: 1, audits: 1, contacts: 0, conversations: 0, identities: 0 },
    ]);
  });

  test('returns not processable for absent, stale, and unsupported named rows', async () => {
    const staleId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_not_processable',
      contactId: 'PSID_TEST_not_processable',
      eventKind: 'customer_message',
      fixtureKey: 'not-processable-stale',
      messageText: 'Synthetic stale named row',
      occurredAt: new Date('2026-08-11T03:00:00.000Z'),
    });
    await pool.query(`update webhook_events set admission_outcome = 'stale' where id = $1`, [
      staleId,
    ]);
    const unsupportedId = await insertSyntheticPendingEvent(pool, {
      channel: 'unknown',
      eventKind: 'unsupported',
      fixtureKey: 'not-processable-unsupported',
    });
    await pool.query(`update webhook_events set admission_outcome = 'unsupported' where id = $1`, [
      unsupportedId,
    ]);
    const processor = new PostgresConversationEventProcessor(pool);

    await expect(processor.processEvent('999999999')).resolves.toEqual({
      status: 'not_processable',
    });
    await expect(processor.processEvent(staleId)).resolves.toEqual({ status: 'not_processable' });
    await expect(processor.processEvent(unsupportedId)).resolves.toEqual({
      status: 'not_processable',
    });
    const state = await pool.query(
      `select count(*)::int as applications from webhook_event_applications`,
    );
    expect(state.rows).toEqual([{ applications: 0 }]);
  });

  test('rejects malformed pending normalized state without policy mutation', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      eventKind: 'customer_message',
      fixtureKey: 'invalid-pending',
      messageText: 'Synthetic malformed pending state',
      occurredAt: new Date('2026-08-11T03:10:00.000Z'),
    });

    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(webhookEventId),
    ).rejects.toMatchObject({ name: 'InvalidPendingWebhookEventError' });
    const counts = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from webhook_event_applications) as applications,
         (select count(*)::int from policy_audit_outcomes) as audits`,
    );
    expect(counts.rows).toEqual([{ applications: 0, audits: 0, contacts: 0 }]);
  });

  test('applies a business echo pause for 24 hours from provider occurrence time', async () => {
    const customerEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_echo_pause',
      contactId: 'PSID_TEST_echo_pause',
      eventKind: 'customer_message',
      fixtureKey: 'echo-pause-customer',
      messageText: 'Synthetic conversation seed',
      occurredAt: new Date('2026-08-11T04:00:00.000Z'),
    });
    const processor = new PostgresConversationEventProcessor(pool);
    const customerResult = await processor.processEvent(customerEventId);
    const echoEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_echo_pause',
      contactId: 'PSID_TEST_echo_pause',
      eventKind: 'business_message_echo',
      fixtureKey: 'echo-pause',
      messageText: 'Synthetic echo text must not affect policy',
      occurredAt: new Date('2026-08-11T05:00:00.000Z'),
    });

    const result = await processor.processEvent(echoEventId);

    expect(result).toEqual({
      conversationId:
        customerResult.status === 'applied' ? customerResult.conversationId : undefined,
      eventId: echoEventId,
      outcome: 'business_echo_paused',
      status: 'applied',
    });
    const state = await pool.query(
      `select ai_paused_until, last_activity_at, row_version,
              pause.action, pause.effective_at, pause.resulting_pause_until,
              pause.actor_kind, pause.source_webhook_event_id,
              application.outcome as application_outcome,
              audit.outcome as audit_outcome, audit.reason_code
       from conversations
       join human_pause_events as pause on pause.conversation_id = conversations.id
       join webhook_event_applications as application
         on application.webhook_event_id = pause.source_webhook_event_id
       join policy_audit_outcomes as audit
         on audit.related_webhook_event_id = pause.source_webhook_event_id`,
    );
    expect(state.rows).toEqual([
      {
        action: 'pause',
        actor_kind: 'business_echo',
        ai_paused_until: new Date('2026-08-12T05:00:00.000Z'),
        application_outcome: 'business_echo_paused',
        audit_outcome: 'applied',
        effective_at: new Date('2026-08-11T05:00:00.000Z'),
        last_activity_at: new Date('2026-08-11T05:00:00.000Z'),
        reason_code: 'business_echo_pause',
        resulting_pause_until: new Date('2026-08-12T05:00:00.000Z'),
        row_version: '2',
        source_webhook_event_id: echoEventId,
      },
    ]);
  });

  test('never shortens an existing pause when an older echo is applied later', async () => {
    const processor = new PostgresConversationEventProcessor(pool);
    const laterEchoId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_echo_max',
      contactId: 'CONTACT_TEST_echo_max',
      eventKind: 'business_message_echo',
      fixtureKey: 'echo-max-later',
      messageText: 'Synthetic later echo',
      occurredAt: new Date('2026-08-11T07:00:00.000Z'),
    });
    const olderEchoId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_echo_max',
      contactId: 'CONTACT_TEST_echo_max',
      eventKind: 'business_message_echo',
      fixtureKey: 'echo-max-older',
      messageText: 'Synthetic older echo',
      occurredAt: new Date('2026-08-11T06:00:00.000Z'),
    });

    await processor.processEvent(laterEchoId);
    await processor.processEvent(olderEchoId);

    const state = await pool.query(
      `select ai_paused_until, last_activity_at, row_version,
              count(pause.id)::int as pause_events,
              max(pause.resulting_pause_until) as latest_result
       from conversations
       join human_pause_events as pause on pause.conversation_id = conversations.id
       group by conversations.id`,
    );
    expect(state.rows).toEqual([
      {
        ai_paused_until: new Date('2026-08-12T07:00:00.000Z'),
        last_activity_at: new Date('2026-08-11T07:00:00.000Z'),
        latest_result: new Date('2026-08-12T07:00:00.000Z'),
        pause_events: 2,
        row_version: '3',
      },
    ]);
  });

  test('ignores a provider echo older than a non-null authorized resume', async () => {
    const { conversationId, echoEventId, processor } = await prepareResumedConversationEcho({
      echoOccurredAt: '2026-08-11T09:00:00.000499+00:00',
      fixtureKey: 'echo-resume-older',
      resumeAt: '2026-08-11T09:00:00.000500+00:00',
    });
    const before = await pool.query(`select * from conversations where id = $1`, [conversationId]);

    const result = await processor.processEvent(echoEventId);

    expect(result).toMatchObject({
      eventId: echoEventId,
      outcome: 'business_echo_ignored_before_resume',
      status: 'applied',
    });
    const after = await pool.query(`select * from conversations where id = $1`, [conversationId]);
    expect(after.rows).toEqual(before.rows);
    const pauses = await pool.query(
      `select count(*)::int as count from human_pause_events where conversation_id = $1`,
      [conversationId],
    );
    expect(pauses.rows).toEqual([{ count: 0 }]);
  });

  test('ignores a provider echo equal to a non-null authorized resume', async () => {
    const { conversationId, echoEventId, processor } = await prepareResumedConversationEcho({
      echoOccurredAt: '2026-08-11T09:00:00.000500+00:00',
      fixtureKey: 'echo-resume-equal',
      resumeAt: '2026-08-11T09:00:00.000500+00:00',
    });
    const before = await pool.query(`select * from conversations where id = $1`, [conversationId]);

    const result = await processor.processEvent(echoEventId);

    expect(result).toMatchObject({
      eventId: echoEventId,
      outcome: 'business_echo_ignored_before_resume',
      status: 'applied',
    });
    const after = await pool.query(`select * from conversations where id = $1`, [conversationId]);
    expect(after.rows).toEqual(before.rows);
    const outcomes = await pool.query(
      `select
         (select count(*)::int from human_pause_events where conversation_id = $2) as pauses,
         application.outcome as application_outcome,
         audit.outcome as audit_outcome,
         audit.reason_code
       from webhook_event_applications as application
       join policy_audit_outcomes as audit
         on audit.related_webhook_event_id = application.webhook_event_id
       where application.webhook_event_id = $1`,
      [echoEventId, conversationId],
    );
    expect(outcomes.rows).toEqual([
      {
        application_outcome: 'business_echo_ignored_before_resume',
        audit_outcome: 'ignored',
        pauses: 0,
        reason_code: 'echo_not_later_than_resume',
      },
    ]);
  });

  test('pauses for a provider echo one microsecond later than an authorized resume', async () => {
    const { conversationId, echoEventId, processor } = await prepareResumedConversationEcho({
      echoOccurredAt: '2026-08-11T09:00:00.000501+00:00',
      fixtureKey: 'echo-resume-later',
      resumeAt: '2026-08-11T09:00:00.000500+00:00',
    });

    const result = await processor.processEvent(echoEventId);

    expect(result).toMatchObject({
      eventId: echoEventId,
      outcome: 'business_echo_paused',
      status: 'applied',
    });
    const state = await pool.query(
      `select
         conversations.ai_paused_until = source_event.occurred_at + interval '24 hours'
           as exact_deadline,
         pause.effective_at = source_event.occurred_at as exact_effective_at,
         pause.resulting_pause_until = conversations.ai_paused_until
           as exact_resulting_pause_until,
         conversations.row_version,
         application.outcome as application_outcome
       from conversations
       join human_pause_events as pause on pause.conversation_id = conversations.id
       join webhook_event_applications as application
         on application.webhook_event_id = pause.source_webhook_event_id
       join webhook_events as source_event on source_event.id = pause.source_webhook_event_id
       where conversations.id = $1`,
      [conversationId],
    );
    expect(state.rows).toEqual([
      {
        application_outcome: 'business_echo_paused',
        exact_deadline: true,
        exact_effective_at: true,
        exact_resulting_pause_until: true,
        row_version: '3',
      },
    ]);
  });

  test('rolls back all policy state when the closed audit insert fails', async () => {
    const webhookEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_audit_rollback',
      contactId: 'PSID_TEST_audit_rollback',
      eventKind: 'business_message_echo',
      fixtureKey: 'audit-rollback',
      messageText: 'Synthetic rollback question',
      occurredAt: new Date('2026-08-11T03:20:00.000Z'),
    });
    await pool.query(
      `create function synthetic_reject_policy_audit()
       returns trigger language plpgsql as $$
       begin
         raise exception using errcode = 'P0001', message = 'synthetic audit rejection';
       end;
       $$;
       create trigger synthetic_reject_policy_audit
         before insert on policy_audit_outcomes
         for each row execute function synthetic_reject_policy_audit()`,
    );

    try {
      await expect(
        new PostgresConversationEventProcessor(pool).processEvent(webhookEventId),
      ).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await pool.query(
        `drop trigger if exists synthetic_reject_policy_audit on policy_audit_outcomes;
         drop function if exists synthetic_reject_policy_audit()`,
      );
    }

    const counts = await pool.query(
      `select
         (select count(*)::int from contacts) as contacts,
         (select count(*)::int from channel_identities) as identities,
         (select count(*)::int from conversations) as conversations,
         (select count(*)::int from human_pause_events) as pauses,
         (select count(*)::int from webhook_event_applications) as applications,
         (select count(*)::int from policy_audit_outcomes) as audits`,
    );
    expect(counts.rows).toEqual([
      { applications: 0, audits: 0, contacts: 0, conversations: 0, identities: 0, pauses: 0 },
    ]);
  });
});
