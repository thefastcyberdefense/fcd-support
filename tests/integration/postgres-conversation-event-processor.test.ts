import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { insertSyntheticPendingEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_conversation_event_processor',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
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
    const processor = new PostgresConversationEventProcessor(pool);

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => processor.processEvent(webhookEventId)),
    );

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

  test('ignores an echo at the authorized resume boundary without changing conversation state', async () => {
    const processor = new PostgresConversationEventProcessor(pool);
    const customerEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_echo_resume_boundary',
      contactId: 'PSID_TEST_echo_resume_boundary',
      eventKind: 'customer_message',
      fixtureKey: 'echo-resume-customer',
      messageText: 'Synthetic resume-boundary seed',
      occurredAt: new Date('2026-08-11T08:00:00.000Z'),
    });
    const customerResult = await processor.processEvent(customerEventId);
    expect(customerResult.status).toBe('applied');
    await pool.query(
      `update conversations
       set ai_paused_until = null,
           last_authorized_resume_at = $2,
           updated_at = $2,
           row_version = row_version + 1
       where id = $1`,
      [
        customerResult.status === 'applied' ? customerResult.conversationId : undefined,
        new Date('2026-08-11T09:00:00.000Z'),
      ],
    );
    const before = await pool.query(`select * from conversations`);
    const echoEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_echo_resume_boundary',
      contactId: 'PSID_TEST_echo_resume_boundary',
      eventKind: 'business_message_echo',
      fixtureKey: 'echo-resume-boundary',
      messageText: 'Synthetic boundary echo',
      occurredAt: new Date('2026-08-11T09:00:00.000Z'),
    });

    const result = await processor.processEvent(echoEventId);

    expect(result).toMatchObject({
      eventId: echoEventId,
      outcome: 'business_echo_ignored_before_resume',
      status: 'applied',
    });
    const after = await pool.query(`select * from conversations`);
    expect(after.rows).toEqual(before.rows);
    const outcomes = await pool.query(
      `select
         (select count(*)::int from human_pause_events) as pauses,
         application.outcome as application_outcome,
         audit.outcome as audit_outcome,
         audit.reason_code
       from webhook_event_applications as application
       join policy_audit_outcomes as audit
         on audit.related_webhook_event_id = application.webhook_event_id
       where application.webhook_event_id = $1`,
      [echoEventId],
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
