import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type pg from 'pg';

import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import type { ChannelIdentitySelector, PrivacyHmacKeyring } from '../../src/policy/policy-types.js';

export const syntheticPrivacyKeyring = {
  activeVersion: 'TEST_v1',
  keys: new Map([['TEST_v1', Buffer.alloc(32, 0x51)]]),
} satisfies PrivacyHmacKeyring;

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

export async function insertSyntheticAppliedCustomerEvent(
  pool: pg.Pool,
  input: {
    readonly fixtureKey: string;
    readonly identity: ChannelIdentitySelector;
    readonly messageText?: string;
    readonly occurredAt: Date;
  },
): Promise<{ readonly conversationId: string; readonly eventId: string }> {
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: input.identity.channel,
    channelAccountId: input.identity.channelAccountId,
    contactId: input.identity.externalContactId,
    eventKind: 'customer_message',
    fixtureKey: input.fixtureKey,
    messageText:
      input.messageText ?? 'Synthetic deletion-policy source text excluded from privacy state',
    occurredAt: input.occurredAt,
  });
  const result = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  if (
    result.status !== 'applied' ||
    result.outcome !== 'customer_message_applied' ||
    result.conversationId === undefined
  ) {
    throw new Error('Synthetic deletion-policy customer source was not applied');
  }
  return { conversationId: result.conversationId, eventId };
}
