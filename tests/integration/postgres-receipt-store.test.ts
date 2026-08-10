import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { NormalizedMetaEvent } from '../../src/meta/normalized-event.js';
import { PostgresReceiptStore } from '../../src/persistence/postgres-receipt-store.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('postgres_receipt_store');
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query('truncate table webhook_events, webhook_receipts restart identity cascade');
});

afterAll(async () => {
  await disposeDatabase?.();
});

describe('PostgresReceiptStore', () => {
  test('atomically stores a new receipt and normalized event', async () => {
    const store = new PostgresReceiptStore(pool);
    const result = await store.store({
      events: [
        {
          kind: 'customer_message',
          channel: 'whatsapp',
          channelAccountId: 'PHONE_TEST_store',
          contactId: 'CONTACT_TEST_store',
          externalMessageId: 'wamid.TEST_store',
          idempotencyKey: 'whatsapp:message:wamid.TEST_store',
          occurredAt: new Date('2026-08-11T00:00:00.000Z'),
          text: 'Synthetic support question for receipt storage',
        },
      ],
      payloadSha256: 'c'.repeat(64),
      receivedAt: new Date('2026-08-11T00:01:00.000Z'),
    });

    expect(result).toMatchObject({ outcome: 'accepted', insertedEventCount: 1 });

    const receipt = await pool.query(
      `select payload_sha256, event_count, received_at
       from webhook_receipts`,
    );
    expect(receipt.rows).toEqual([
      {
        payload_sha256: 'c'.repeat(64),
        event_count: 1,
        received_at: new Date('2026-08-11T00:01:00.000Z'),
      },
    ]);

    const event = await pool.query(
      `select idempotency_key, channel, event_kind, channel_account_id, contact_id,
              external_message_id, occurred_at, message_text, message_status,
              reason_code, admission_outcome
       from webhook_events`,
    );
    expect(event.rows).toEqual([
      {
        idempotency_key: 'whatsapp:message:wamid.TEST_store',
        channel: 'whatsapp',
        event_kind: 'customer_message',
        channel_account_id: 'PHONE_TEST_store',
        contact_id: 'CONTACT_TEST_store',
        external_message_id: 'wamid.TEST_store',
        occurred_at: new Date('2026-08-11T00:00:00.000Z'),
        message_text: 'Synthetic support question for receipt storage',
        message_status: null,
        reason_code: null,
        admission_outcome: 'pending',
      },
    ]);
  });

  test('treats an exact delivery retry as a successful no-op', async () => {
    const store = new PostgresReceiptStore(pool);
    const input = {
      events: [
        {
          kind: 'customer_message' as const,
          channel: 'messenger' as const,
          channelAccountId: 'PAGE_TEST_duplicate',
          contactId: 'PSID_TEST_duplicate',
          externalMessageId: 'm_TEST_duplicate',
          idempotencyKey: 'messenger:message:PAGE_TEST_duplicate:m_TEST_duplicate',
          occurredAt: new Date('2026-08-11T00:02:00.000Z'),
          text: 'Synthetic duplicate delivery',
        },
      ],
      payloadSha256: 'd'.repeat(64),
      receivedAt: new Date('2026-08-11T00:02:30.000Z'),
    };

    const first = await store.store(input);
    const retry = await store.store(input);

    expect(first).toMatchObject({ outcome: 'accepted', insertedEventCount: 1 });
    expect(retry).toEqual({
      outcome: 'duplicate',
      insertedEventCount: 0,
      receiptId: first.receiptId,
    });

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 1, events: 1 }]);
  });

  test('deduplicates the same logical event across different delivery payloads', async () => {
    const store = new PostgresReceiptStore(pool);
    const event = {
      kind: 'message_status' as const,
      channel: 'whatsapp' as const,
      channelAccountId: 'PHONE_TEST_event_duplicate',
      contactId: 'CONTACT_TEST_event_duplicate',
      externalMessageId: 'wamid.TEST_event_duplicate',
      idempotencyKey: 'whatsapp:status:wamid.TEST_event_duplicate:delivered:1786400400',
      occurredAt: new Date('2026-08-11T00:20:00.000Z'),
      status: 'delivered' as const,
    };

    const first = await store.store({
      events: [event],
      payloadSha256: 'e'.repeat(64),
      receivedAt: new Date('2026-08-11T00:20:05.000Z'),
    });
    const retry = await store.store({
      events: [event],
      payloadSha256: 'f'.repeat(64),
      receivedAt: new Date('2026-08-11T00:20:10.000Z'),
    });

    expect(first).toMatchObject({ outcome: 'accepted', insertedEventCount: 1 });
    expect(retry).toMatchObject({ outcome: 'duplicate', insertedEventCount: 0 });

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 2, events: 1 }]);
  });

  test('records an inbound message older than five minutes as stale', async () => {
    const store = new PostgresReceiptStore(pool);

    await store.store({
      events: [
        {
          kind: 'customer_message',
          channel: 'messenger',
          channelAccountId: 'PAGE_TEST_stale',
          contactId: 'PSID_TEST_stale',
          externalMessageId: 'm_TEST_stale',
          idempotencyKey: 'messenger:message:PAGE_TEST_stale:m_TEST_stale',
          occurredAt: new Date('2026-08-11T00:04:59.000Z'),
          text: 'Synthetic stale support question',
        },
      ],
      payloadSha256: '1'.repeat(64),
      receivedAt: new Date('2026-08-11T00:10:00.000Z'),
    });

    const result = await pool.query(
      `select admission_outcome, channel_account_id, contact_id,
              external_message_id, message_text
       from webhook_events`,
    );
    expect(result.rows).toEqual([
      {
        admission_outcome: 'stale',
        channel_account_id: null,
        contact_id: null,
        external_message_id: null,
        message_text: null,
      },
    ]);
  });

  test('quarantines an event more than sixty seconds in the future', async () => {
    const store = new PostgresReceiptStore(pool);

    await store.store({
      events: [
        {
          kind: 'customer_message',
          channel: 'whatsapp',
          channelAccountId: 'PHONE_TEST_future',
          contactId: 'CONTACT_TEST_future',
          externalMessageId: 'wamid.TEST_future',
          idempotencyKey: 'whatsapp:message:wamid.TEST_future',
          occurredAt: new Date('2026-08-11T00:11:01.000Z'),
          text: 'Synthetic future-dated support question',
        },
      ],
      payloadSha256: '2'.repeat(64),
      receivedAt: new Date('2026-08-11T00:10:00.000Z'),
    });

    const result = await pool.query(
      `select admission_outcome, channel_account_id, contact_id,
              external_message_id, message_text, reason_code
       from webhook_events`,
    );
    expect(result.rows).toEqual([
      {
        admission_outcome: 'unsupported',
        channel_account_id: null,
        contact_id: null,
        external_message_id: null,
        message_text: null,
        reason_code: 'event_time_too_far_future',
      },
    ]);
  });

  test('retains delayed status transitions received out of order', async () => {
    const store = new PostgresReceiptStore(pool);
    const statusBase = {
      kind: 'message_status' as const,
      channel: 'whatsapp' as const,
      channelAccountId: 'PHONE_TEST_out_of_order',
      contactId: 'CONTACT_TEST_out_of_order',
      externalMessageId: 'wamid.TEST_out_of_order',
    };

    await store.store({
      events: [
        {
          ...statusBase,
          idempotencyKey: 'whatsapp:status:wamid.TEST_out_of_order:read:1786409400',
          occurredAt: new Date('2026-08-11T02:10:00.000Z'),
          status: 'read',
        },
      ],
      payloadSha256: '5'.repeat(64),
      receivedAt: new Date('2026-08-11T02:30:00.000Z'),
    });
    await store.store({
      events: [
        {
          ...statusBase,
          idempotencyKey: 'whatsapp:status:wamid.TEST_out_of_order:delivered:1786408800',
          occurredAt: new Date('2026-08-11T02:00:00.000Z'),
          status: 'delivered',
        },
      ],
      payloadSha256: '6'.repeat(64),
      receivedAt: new Date('2026-08-11T02:30:05.000Z'),
    });

    const result = await pool.query(
      `select message_status, occurred_at, admission_outcome
       from webhook_events
       order by id`,
    );
    expect(result.rows).toEqual([
      {
        message_status: 'read',
        occurred_at: new Date('2026-08-11T02:10:00.000Z'),
        admission_outcome: 'pending',
      },
      {
        message_status: 'delivered',
        occurred_at: new Date('2026-08-11T02:00:00.000Z'),
        admission_outcome: 'pending',
      },
    ]);
  });

  test('rolls back the receipt and every event when one insert fails', async () => {
    const store = new PostgresReceiptStore(pool);
    const invalidEvent = {
      kind: 'unsupported',
      channel: 'invalid_channel',
      reasonCode: 'synthetic_constraint_failure',
    } as unknown as NormalizedMetaEvent;

    await expect(
      store.store({
        events: [
          {
            kind: 'customer_message',
            channel: 'messenger',
            channelAccountId: 'PAGE_TEST_rollback',
            contactId: 'PSID_TEST_rollback',
            externalMessageId: 'm_TEST_rollback',
            idempotencyKey: 'messenger:message:PAGE_TEST_rollback:m_TEST_rollback',
            occurredAt: new Date('2026-08-11T00:30:00.000Z'),
            text: 'Synthetic event before rollback',
          },
          invalidEvent,
        ],
        payloadSha256: '3'.repeat(64),
        receivedAt: new Date('2026-08-11T00:30:05.000Z'),
      }),
    ).rejects.toMatchObject({ code: '23514' });

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 0, events: 0 }]);
  });

  test('accepts one logical event under concurrent exact retries', async () => {
    const store = new PostgresReceiptStore(pool);
    const input = {
      events: [
        {
          kind: 'customer_message' as const,
          channel: 'whatsapp' as const,
          channelAccountId: 'PHONE_TEST_concurrent',
          contactId: 'CONTACT_TEST_concurrent',
          externalMessageId: 'wamid.TEST_concurrent',
          idempotencyKey: 'whatsapp:message:wamid.TEST_concurrent',
          occurredAt: new Date('2026-08-11T00:40:00.000Z'),
          text: 'Synthetic concurrent delivery',
        },
      ],
      payloadSha256: '4'.repeat(64),
      receivedAt: new Date('2026-08-11T00:40:05.000Z'),
    };

    const results = await Promise.all(Array.from({ length: 8 }, async () => store.store(input)));

    expect(results.filter((result) => result.outcome === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'duplicate')).toHaveLength(7);

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 1, events: 1 }]);
  });
});
