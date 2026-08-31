import type pg from 'pg';

import type { NormalizedMetaEvent } from '../meta/normalized-event.js';
import {
  createIdentityHmac,
  createReplayHmac,
  requirePrivacyHmacKeyring,
} from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
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
  suppressed: boolean,
  privacyKeyring: PrivacyHmacKeyring,
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
  const admissionOutcome = suppressed
    ? 'suppressed'
    : event.kind === 'unsupported' || isTooFarFuture
      ? 'unsupported'
      : isStaleMessage
        ? 'stale'
        : 'pending';
  const storesProcessableDetails = admissionOutcome === 'pending';
  const activeKey = privacyKeyring.keys.get(privacyKeyring.activeVersion);
  if (activeKey === undefined) throw new Error('Active privacy key is missing');
  const idempotencyKey = suppressed
    ? `privacy:${privacyKeyring.activeVersion}:${createReplayHmac(
        supportedEvent?.idempotencyKey ?? '',
        {
          key: activeKey,
          version: privacyKeyring.activeVersion,
        },
      )}`
    : (supportedEvent?.idempotencyKey ?? `meta:unsupported:${payloadSha256}:${String(index)}`);

  return [
    idempotencyKey,
    event.channel,
    event.kind,
    storesProcessableDetails ? supportedEvent?.channelAccountId : undefined,
    storesProcessableDetails ? supportedEvent?.contactId : undefined,
    storesProcessableDetails ? supportedEvent?.externalMessageId : undefined,
    supportedEvent?.occurredAt,
    storesProcessableDetails ? messageEvent?.text : undefined,
    storesProcessableDetails ? statusEvent?.status : undefined,
    suppressed
      ? 'deletion_tombstone'
      : event.kind === 'unsupported'
        ? event.reasonCode
        : isTooFarFuture
          ? 'event_time_too_far_future'
          : undefined,
    admissionOutcome,
  ];
}

export class PostgresReceiptStore {
  private readonly privacyKeyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    privacyKeyring: PrivacyHmacKeyring,
  ) {
    this.privacyKeyring = requirePrivacyHmacKeyring(privacyKeyring);
  }

  public async store(input: WebhookReceiptInput): Promise<StoreWebhookReceiptResult> {
    return withBoundedTransaction(
      this.pool,
      async (client) => {
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
          const suppressed = await this.isDeletedIdentity(client, event, input.receivedAt);
          const insertedEvent = await client.query(
            `insert into webhook_events
             (receipt_id, idempotency_key, channel, event_kind, channel_account_id,
              contact_id, external_message_id, occurred_at, message_text,
              message_status, reason_code, admission_outcome)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (idempotency_key) do nothing
           returning id`,
            [
              receiptId,
              ...eventValues(
                event,
                input.payloadSha256,
                index,
                input.receivedAt,
                suppressed,
                this.privacyKeyring,
              ),
            ],
          );
          insertedEventCount += insertedEvent.rowCount ?? 0;
        }

        return {
          insertedEventCount,
          outcome: insertedEventCount === 0 && input.events.length > 0 ? 'duplicate' : 'accepted',
          receiptId,
        };
      },
      { lockTimeoutMilliseconds: 750 },
    );
  }

  private async isDeletedIdentity(
    client: pg.PoolClient,
    event: NormalizedMetaEvent,
    evaluatedAt: Date,
  ): Promise<boolean> {
    if (event.kind === 'unsupported') return false;
    const keyVersions: string[] = [];
    const identityHmacs: string[] = [];
    for (const [version, key] of this.privacyKeyring.keys) {
      keyVersions.push(version);
      identityHmacs.push(
        createIdentityHmac(
          {
            channel: event.channel,
            channelAccountId: event.channelAccountId,
            externalContactId: event.contactId,
          },
          { key, version },
        ),
      );
    }
    const selected = await client.query<{ readonly suppressed: boolean }>(
      `select exists (
         select 1
         from privacy_suppressions
         where channel = $1
           and category = 'deletion_tombstone'
           and effective_at <= $2
           and (expires_at is null or expires_at > $2)
           and (key_version, identity_hmac) in (
             select * from unnest($3::text[], $4::text[])
           )
       ) as suppressed`,
      [event.channel, evaluatedAt, keyVersions, identityHmacs],
    );
    return selected.rows[0]?.suppressed ?? false;
  }
}
