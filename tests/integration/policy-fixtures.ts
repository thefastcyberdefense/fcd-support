import { createHash } from 'node:crypto';

import type pg from 'pg';

export interface SyntheticPendingEventInput {
  readonly channel: 'messenger' | 'unknown' | 'whatsapp';
  readonly channelAccountId?: string;
  readonly contactId?: string;
  readonly createdAt?: Date;
  readonly eventKind:
    'business_message_echo' | 'customer_message' | 'message_status' | 'unsupported';
  readonly externalMessageId?: string;
  readonly fixtureKey: string;
  readonly messageStatus?: 'delivered' | 'failed' | 'read' | 'sent';
  readonly messageText?: string;
  readonly occurredAt?: Date;
}

export async function insertSyntheticPendingEvent(
  pool: pg.Pool,
  input: SyntheticPendingEventInput,
): Promise<string> {
  const digest = createHash('sha256').update(`synthetic-policy:${input.fixtureKey}`).digest('hex');
  const receipt = await pool.query<{ readonly id: string }>(
    `insert into webhook_receipts (payload_sha256, received_at, event_count)
     values ($1, $2, 1)
     returning id`,
    [digest, input.createdAt ?? input.occurredAt ?? new Date('2026-08-11T00:00:00.000Z')],
  );
  const receiptId = receipt.rows[0]?.id;
  if (receiptId === undefined) {
    throw new Error('Synthetic receipt insert returned no identifier');
  }

  const event = await pool.query<{ readonly id: string }>(
    `insert into webhook_events
       (receipt_id, idempotency_key, channel, event_kind, channel_account_id,
        contact_id, external_message_id, occurred_at, message_text, message_status,
        admission_outcome, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
     returning id`,
    [
      receiptId,
      `synthetic:policy:${input.fixtureKey}`,
      input.channel,
      input.eventKind,
      input.channelAccountId,
      input.contactId,
      input.externalMessageId,
      input.occurredAt,
      input.messageText,
      input.messageStatus,
      input.createdAt ?? input.occurredAt ?? new Date('2026-08-11T00:00:00.000Z'),
    ],
  );
  const eventId = event.rows[0]?.id;
  if (eventId === undefined || !/^\d+$/.test(eventId)) {
    throw new Error('Synthetic event insert returned no decimal identifier');
  }

  return eventId;
}
