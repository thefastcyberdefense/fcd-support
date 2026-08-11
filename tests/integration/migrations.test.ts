import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let runMigrations: IsolatedTestDatabase['runMigrations'];
let schema: string;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('migrations');
  disposeDatabase = database.dispose;
  pool = database.pool;
  runMigrations = database.runMigrations;
  schema = database.schema;
});

afterAll(async () => {
  await disposeDatabase?.();
});

describe('Phase 2 database migrations', () => {
  test('create the Phase 2 and Phase 3A tables', async () => {
    const result = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'channel_identities',
           'consent_events',
           'contacts',
           'conversations',
           'human_pause_events',
           'policy_audit_outcomes',
           'webhook_event_applications',
           'webhook_events',
           'webhook_receipts'
         )
       order by table_name`,
      [schema],
    );

    expect(result.rows).toEqual([
      { table_name: 'channel_identities' },
      { table_name: 'consent_events' },
      { table_name: 'contacts' },
      { table_name: 'conversations' },
      { table_name: 'human_pause_events' },
      { table_name: 'policy_audit_outcomes' },
      { table_name: 'webhook_event_applications' },
      { table_name: 'webhook_events' },
      { table_name: 'webhook_receipts' },
    ]);
  });

  test('enforce receipt digest uniqueness and format', async () => {
    const validDigest = 'a'.repeat(64);
    await pool.query(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 0)`,
      [validDigest],
    );

    await expect(
      pool.query(
        `insert into webhook_receipts (payload_sha256, event_count)
         values ($1, 0)`,
        [validDigest],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      pool.query(
        `insert into webhook_receipts (payload_sha256, event_count)
         values ($1, 0)`,
        ['not-a-sha256-digest'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('enforce event idempotency and bounded outcome values', async () => {
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['b'.repeat(64)],
    );
    const receiptId = receipt.rows[0]?.id;
    expect(receiptId).toBeDefined();

    const insertEvent = (idempotencyKey: string, outcome: string) =>
      pool.query(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
         values ($1, $2, 'unknown', 'unsupported', $3)`,
        [receiptId, idempotencyKey, outcome],
      );

    await insertEvent('meta:unsupported:bbbb:0', 'unsupported');

    await expect(insertEvent('meta:unsupported:bbbb:0', 'unsupported')).rejects.toMatchObject({
      code: '23505',
    });
    await expect(insertEvent('meta:unsupported:bbbb:1', 'not_allowed')).rejects.toMatchObject({
      code: '23514',
    });
  });

  test('enforce Phase 3A identity, application, and closed-value constraints', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const contactId = contact.rows[0]?.id;
    expect(contactId).toBeDefined();

    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-account', 'synthetic-contact', now(), now())
       returning id`,
      [contactId],
    );
    const identityId = identity.rows[0]?.id;
    expect(identityId).toBeDefined();

    await expect(
      pool.query(
        `insert into channel_identities
           (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
         values ($1, 'messenger', 'synthetic-account', 'synthetic-contact', now(), now())`,
        [contactId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `insert into channel_identities
           (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
         values ($1, 'invalid-channel', 'synthetic-account-2', 'synthetic-contact-2', now(), now())`,
        [contactId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identityId],
    );
    const conversationId = conversation.rows[0]?.id;
    expect(conversationId).toBeDefined();

    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['c'.repeat(64)],
    );
    const receiptId = receipt.rows[0]?.id;
    const event = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:policy:application', 'messenger', 'customer_message', 'pending')
       returning id`,
      [receiptId],
    );
    const eventId = event.rows[0]?.id;
    expect(eventId).toBeDefined();
    const invalidOutcomeEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
       values ($1, 'synthetic:policy:invalid-outcome', 'messenger', 'message_status', 'pending')
       returning id`,
      [receiptId],
    );
    const invalidOutcomeEventId = invalidOutcomeEvent.rows[0]?.id;
    expect(invalidOutcomeEventId).toBeDefined();

    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'customer_message_applied')`,
      [eventId, conversationId],
    );
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'customer_message_applied')`,
        [eventId, conversationId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, outcome)
         values ($1, 'invalid_outcome')`,
        [invalidOutcomeEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, outcome)
         values (999992, 'message_status_ignored')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, actor_kind, effective_at, resulting_pause_until)
         values ($1, 'pause', 'reviewer', now(), now() + interval '24 hours')`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into policy_audit_outcomes (decision_type, outcome, reason_code, evaluated_at)
         values ('event_application', 'applied', 'invalid_reason', now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
         values ($1, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'invalid_source', now(), 'synthetic-consent-source')`,
        [identityId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const blankConsentCases: readonly {
      readonly category: string;
      readonly idempotencyKey: string;
      readonly wording: string;
      readonly wordingVersion: string;
    }[] = [
      {
        category: '',
        idempotencyKey: 'synthetic-consent-blank-category',
        wording: 'Synthetic approved consent wording',
        wordingVersion: 'v1',
      },
      {
        category: 'marketing',
        idempotencyKey: 'synthetic-consent-blank-wording',
        wording: ' ',
        wordingVersion: 'v1',
      },
      {
        category: 'marketing',
        idempotencyKey: 'synthetic-consent-blank-version',
        wording: 'Synthetic approved consent wording',
        wordingVersion: ' ',
      },
    ];
    for (const { category, idempotencyKey, wording, wordingVersion } of blankConsentCases) {
      await expect(
        pool.query(
          `insert into consent_events
             (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
           values ($1, $2, 'grant', $3, $4, 'reviewer_recorded', now(), $5)`,
          [identityId, category, wording, wordingVersion, idempotencyKey],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      pool.query(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key)
         values (999993, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'reviewer_recorded', now(), 'synthetic-consent-missing-identity')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('reject non-pending webhook events from every Phase 3A event reference', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-boundary-account', 'synthetic-boundary-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 4)
       returning id`,
      ['d'.repeat(64)],
    );

    const insertStaleEvent = async (idempotencyKey: string, eventKind: string) => {
      const event = await pool.query<{ readonly id: string }>(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
         values ($1, $2, 'messenger', $3, '2026-01-02T00:00:00Z', 'stale')
         returning id`,
        [receipt.rows[0]?.id, idempotencyKey, eventKind],
      );
      return event.rows[0]?.id;
    };

    const applicationEventId = await insertStaleEvent(
      'synthetic:boundary:application',
      'customer_message',
    );
    await expect(
      pool.query(
        `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'customer_message_applied')`,
        [applicationEventId, conversation.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const pauseEventId = await insertStaleEvent(
      'synthetic:boundary:pause',
      'business_message_echo',
    );
    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
         values ($1, $2, 'pause', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'business_echo')`,
        [conversation.rows[0]?.id, pauseEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const consentEventId = await insertStaleEvent('synthetic:boundary:consent', 'customer_message');
    await expect(
      pool.query(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version, source, source_at, idempotency_key, source_webhook_event_id)
         values ($1, 'marketing', 'grant', 'Synthetic approved consent wording', 'v1', 'customer_message', '2026-01-02T00:00:00Z', 'synthetic-boundary-consent', $2)`,
        [identity.rows[0]?.id, consentEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const auditEventId = await insertStaleEvent('synthetic:boundary:audit', 'message_status');
    await expect(
      pool.query(
        `insert into policy_audit_outcomes
           (decision_type, outcome, reason_code, related_webhook_event_id, evaluated_at)
         values ('event_application', 'ignored', 'message_status_ignored', $1, now())`,
        [auditEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('allow a resume deadline when a later authoritative echo remains', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-resume-account', 'synthetic-resume-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['e'.repeat(64)],
    );
    const echoEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
       values ($1, 'synthetic:resume:echo', 'messenger', 'business_message_echo', '2026-01-02T00:00:00Z', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );
    const echoEventId = echoEvent.rows[0]?.id;
    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'business_echo_paused')`,
      [echoEventId, conversation.rows[0]?.id],
    );
    await pool.query(
      `insert into human_pause_events
         (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
       values ($1, $2, 'pause', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'business_echo')`,
      [conversation.rows[0]?.id, echoEventId],
    );

    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until, actor_kind, reviewer_reference, reviewer_request_key)
         values ($1, 'resume', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-authoritative')`,
        [conversation.rows[0]?.id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  test('reject a business-echo pause without an authoritative application', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-unapplied-account', 'synthetic-unapplied-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)
       returning id`,
      ['f'.repeat(64)],
    );
    const echoEvent = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
       values ($1, 'synthetic:unapplied:echo', 'messenger', 'business_message_echo', '2026-01-02T00:00:00Z', 'pending')
       returning id`,
      [receipt.rows[0]?.id],
    );

    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
         values ($1, $2, 'pause', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'business_echo')`,
        [conversation.rows[0]?.id, echoEvent.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('prevent an authoritative echo application from being invalidated', async () => {
    const authoritativeApplication = await pool.query<{ readonly webhook_event_id: string }>(
      `select webhook_event_id
       from webhook_event_applications
       where outcome = 'business_echo_paused'
       order by webhook_event_id desc
       limit 1`,
    );
    const webhookEventId = authoritativeApplication.rows[0]?.webhook_event_id;
    expect(webhookEventId).toBeDefined();

    await expect(
      pool.query(
        `update webhook_event_applications
         set outcome = 'business_echo_ignored_before_resume'
         where webhook_event_id = $1`,
        [webhookEventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('serializes pending admission against a concurrent stale transition in both lock orders', async () => {
    const contact = await pool.query<{ readonly id: string }>(
      `insert into contacts default values returning id`,
    );
    const identity = await pool.query<{ readonly id: string }>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
       values ($1, 'messenger', 'synthetic-race-account', 'synthetic-race-contact', now(), now())
       returning id`,
      [contact.rows[0]?.id],
    );
    const conversation = await pool.query<{ readonly id: string }>(
      `insert into conversations (channel_identity_id, created_at, last_activity_at)
       values ($1, now(), now())
       returning id`,
      [identity.rows[0]?.id],
    );
    const receipt = await pool.query<{ readonly id: string }>(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 2)
       returning id`,
      ['1'.repeat(64)],
    );
    const insertPendingEvent = async (idempotencyKey: string) => {
      const event = await pool.query<{ readonly id: string }>(
        `insert into webhook_events
           (receipt_id, idempotency_key, channel, event_kind, admission_outcome)
         values ($1, $2, 'messenger', 'customer_message', 'pending')
         returning id`,
        [receipt.rows[0]?.id, idempotencyKey],
      );
      return event.rows[0]?.id;
    };
    const insertApplication = (client: pg.PoolClient, eventId: string | undefined) =>
      client.query(
        `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'customer_message_applied')`,
        [eventId, conversation.rows[0]?.id],
      );

    const referenceFirstEventId = await insertPendingEvent('synthetic:race:reference-first');
    const firstLocker = await pool.connect();
    const firstContender = await pool.connect();
    try {
      await firstLocker.query('begin');
      await firstLocker.query(`select id from webhook_events where id = $1 for update`, [
        referenceFirstEventId,
      ]);
      const referenceAttempt = insertApplication(firstContender, referenceFirstEventId);
      await expect(
        firstLocker.query(`update webhook_events set admission_outcome = 'stale' where id = $1`, [
          referenceFirstEventId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await firstLocker.query('commit');
      await expect(referenceAttempt).rejects.toMatchObject({ code: '23514' });
    } finally {
      await firstLocker.query('rollback').catch(() => undefined);
      firstLocker.release();
      firstContender.release();
    }

    const staleFirstEventId = await insertPendingEvent('synthetic:race:stale-first');
    const secondLocker = await pool.connect();
    const secondContender = await pool.connect();
    try {
      await secondLocker.query('begin');
      await secondLocker.query(
        `update webhook_events set admission_outcome = 'stale' where id = $1`,
        [staleFirstEventId],
      );
      const referenceAttempt = insertApplication(secondContender, staleFirstEventId);
      await secondLocker.query('commit');
      await expect(referenceAttempt).rejects.toMatchObject({ code: '23514' });
    } finally {
      await secondLocker.query('rollback').catch(() => undefined);
      secondLocker.release();
      secondContender.release();
    }
  });

  test('reject a non-null resume deadline after a later pause or resume supersedes it', async () => {
    const state = await pool.query<{
      readonly conversation_id: string;
      readonly receipt_id: string;
    }>(
      `select conversations.id as conversation_id, webhook_events.receipt_id
       from conversations
       join channel_identities on channel_identities.id = conversations.channel_identity_id
       join webhook_events on webhook_events.idempotency_key = 'synthetic:resume:echo'
       where channel_identities.channel_account_id = 'synthetic-resume-account'`,
    );
    const conversationId = state.rows[0]?.conversation_id;
    const receiptId = state.rows[0]?.receipt_id;
    expect(conversationId).toBeDefined();
    expect(receiptId).toBeDefined();
    const laterEcho = await pool.query<{ readonly id: string }>(
      `insert into webhook_events
         (receipt_id, idempotency_key, channel, event_kind, occurred_at, admission_outcome)
       values ($1, 'synthetic:resume:later-echo', 'messenger', 'business_message_echo', '2026-01-04T00:00:00Z', 'pending')
       returning id`,
      [receiptId],
    );
    const laterEchoId = laterEcho.rows[0]?.id;
    await pool.query(
      `insert into webhook_event_applications (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'business_echo_paused')`,
      [laterEchoId, conversationId],
    );
    await pool.query(
      `insert into human_pause_events
         (conversation_id, source_webhook_event_id, action, effective_at, resulting_pause_until, actor_kind)
       values ($1, $2, 'pause', '2026-01-04T00:00:00Z', '2026-01-05T00:00:00Z', 'business_echo')`,
      [conversationId, laterEchoId],
    );
    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until, actor_kind, reviewer_reference, reviewer_request_key)
         values ($1, 'resume', '2025-12-31T00:00:00Z', '2026-01-03T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-superseded-pause')`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      `insert into human_pause_events
         (conversation_id, action, effective_at, actor_kind, reviewer_reference, reviewer_request_key)
       values ($1, 'resume', '2026-01-06T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-later')`,
      [conversationId],
    );
    await expect(
      pool.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until, actor_kind, reviewer_reference, reviewer_request_key)
         values ($1, 'resume', '2025-12-30T00:00:00Z', '2026-01-03T00:00:00Z', 'reviewer', 'synthetic-reviewer', 'synthetic-resume-superseded-resume')`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('roll back and reapply the Phase 2 and Phase 3A migrations', async () => {
    await runMigrations('down', 2);

    const afterRollback = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'channel_identities',
           'consent_events',
           'contacts',
           'conversations',
           'human_pause_events',
           'policy_audit_outcomes',
           'webhook_event_applications',
           'webhook_events',
           'webhook_receipts'
         )`,
      [schema],
    );
    expect(afterRollback.rows).toEqual([]);

    await runMigrations('up');

    const afterReapply = await pool.query<{ readonly table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name in (
           'channel_identities',
           'consent_events',
           'contacts',
           'conversations',
           'human_pause_events',
           'policy_audit_outcomes',
           'webhook_event_applications',
           'webhook_events',
           'webhook_receipts'
         )
       order by table_name`,
      [schema],
    );
    expect(afterReapply.rows).toEqual([
      { table_name: 'channel_identities' },
      { table_name: 'consent_events' },
      { table_name: 'contacts' },
      { table_name: 'conversations' },
      { table_name: 'human_pause_events' },
      { table_name: 'policy_audit_outcomes' },
      { table_name: 'webhook_event_applications' },
      { table_name: 'webhook_events' },
      { table_name: 'webhook_receipts' },
    ]);
  });
});
