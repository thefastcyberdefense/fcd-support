import type pg from 'pg';

import type { NormalizedMetaEvent } from '../meta/normalized-event.js';
import type { WebhookReceiptInput } from '../receipts/webhook-receipt.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export interface StoreWebhookReceiptResult {
  readonly insertedEventCount: number;
  readonly outcome: 'accepted' | 'duplicate';
  readonly receiptId: string;
}

interface ReceiptRow {
  readonly id: string;
}

function eventValues(
  event: NormalizedMetaEvent,
  payloadSha256: string,
  index: number,
  receivedAt: Date,
): readonly unknown[] {
  const supportedEvent = event.kind !== 'unsupported' ? event : undefined;
  const messageEvent =
    event.kind === 'business_message_echo' || event.kind === 'customer_message' ? event : undefined;
  const statusEvent = event.kind === 'message_status' ? event : undefined;
  const isStaleMessage =
    messageEvent !== undefined &&
    messageEvent.occurredAt.getTime() < receivedAt.getTime() - 5 * 60 * 1000;
  const isTooFarFuture =
    supportedEvent !== undefined &&
    supportedEvent.occurredAt.getTime() > receivedAt.getTime() + 60 * 1000;
  const admissionOutcome =
    event.kind === 'unsupported' || isTooFarFuture
      ? 'unsupported'
      : isStaleMessage
        ? 'stale'
        : 'pending';
  const storesProcessableDetails = admissionOutcome === 'pending';

  return [
    supportedEvent?.idempotencyKey ?? `meta:unsupported:${payloadSha256}:${String(index)}`,
    event.channel,
    event.kind,
    storesProcessableDetails ? supportedEvent?.channelAccountId : undefined,
    storesProcessableDetails ? supportedEvent?.contactId : undefined,
    storesProcessableDetails ? supportedEvent?.externalMessageId : undefined,
    supportedEvent?.occurredAt,
    storesProcessableDetails ? messageEvent?.text : undefined,
    storesProcessableDetails ? statusEvent?.status : undefined,
    event.kind === 'unsupported'
      ? event.reasonCode
      : isTooFarFuture
        ? 'event_time_too_far_future'
        : undefined,
    admissionOutcome,
  ];
}

export class PostgresReceiptStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async store(input: WebhookReceiptInput): Promise<StoreWebhookReceiptResult> {
    return withBoundedTransaction(this.pool, async (client) => {
      const receipt = await client.query<ReceiptRow>(
        `insert into webhook_receipts (payload_sha256, received_at, event_count)
         values ($1, $2, $3)
         on conflict (payload_sha256) do nothing
         returning id`,
        [input.payloadSha256, input.receivedAt, input.events.length],
      );
      const receiptId = receipt.rows[0]?.id;

      if (receiptId === undefined) {
        const existing = await client.query<ReceiptRow>(
          `select id
           from webhook_receipts
           where payload_sha256 = $1`,
          [input.payloadSha256],
        );
        const existingReceiptId = existing.rows[0]?.id;

        if (existingReceiptId === undefined) {
          throw new Error('Duplicate receipt could not be resolved');
        }

        return {
          insertedEventCount: 0,
          outcome: 'duplicate',
          receiptId: existingReceiptId,
        };
      }

      let insertedEventCount = 0;
      for (const [index, event] of input.events.entries()) {
        const insertedEvent = await client.query(
          `insert into webhook_events
             (receipt_id, idempotency_key, channel, event_kind, channel_account_id,
              contact_id, external_message_id, occurred_at, message_text,
              message_status, reason_code, admission_outcome)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (idempotency_key) do nothing
           returning id`,
          [receiptId, ...eventValues(event, input.payloadSha256, index, input.receivedAt)],
        );
        insertedEventCount += insertedEvent.rowCount ?? 0;
      }

      await client.query('commit');
      return {
        insertedEventCount,
        outcome: insertedEventCount === 0 && input.events.length > 0 ? 'duplicate' : 'accepted',
        receiptId,
      };
    });
  }
}
