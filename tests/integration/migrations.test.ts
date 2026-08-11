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
