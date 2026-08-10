import { z } from 'zod';

import type { NormalizedMetaEvent, NormalizedMessageStatus } from './normalized-event.js';

const messageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    text: z.object({ body: z.string() }).optional(),
    timestamp: z.string(),
    type: z.string(),
  })
  .loose();

const statusSchema = z
  .object({
    id: z.string(),
    recipient_id: z.string(),
    status: z.string(),
    timestamp: z.string(),
  })
  .loose();

const envelopeSchema = z
  .object({
    object: z.literal('whatsapp_business_account'),
    entry: z.array(
      z
        .object({
          changes: z.array(
            z
              .object({
                field: z.string(),
                value: z
                  .object({
                    messages: z.array(messageSchema).optional(),
                    metadata: z.object({ phone_number_id: z.string() }).loose(),
                    statuses: z.array(statusSchema).optional(),
                  })
                  .loose(),
              })
              .loose(),
          ),
          id: z.string(),
        })
        .loose(),
    ),
  })
  .loose();

const supportedStatuses = new Set<NormalizedMessageStatus['status']>([
  'delivered',
  'failed',
  'read',
  'sent',
]);

function parseWhatsAppTimestamp(timestamp: string): Date | undefined {
  const seconds = Number(timestamp);

  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return undefined;
  }

  const occurredAt = new Date(seconds * 1000);
  return Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt;
}

export function normalizeWhatsAppWebhook(payload: unknown): readonly NormalizedMetaEvent[] {
  const parsed = envelopeSchema.safeParse(payload);

  if (!parsed.success) {
    return [{ kind: 'unsupported', channel: 'whatsapp', reasonCode: 'invalid_whatsapp_envelope' }];
  }

  const events: NormalizedMetaEvent[] = [];

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        events.push({
          kind: 'unsupported',
          channel: 'whatsapp',
          reasonCode: `unsupported_change_field:${change.field}`,
        });
        continue;
      }

      const channelAccountId = change.value.metadata.phone_number_id;

      for (const message of change.value.messages ?? []) {
        if (message.type !== 'text' || message.text === undefined) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: `unsupported_message_type:${message.type}`,
          });
          continue;
        }

        const occurredAt = parseWhatsAppTimestamp(message.timestamp);
        if (occurredAt === undefined) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: 'invalid_message_timestamp',
          });
          continue;
        }

        events.push({
          kind: 'customer_message',
          channel: 'whatsapp',
          channelAccountId,
          contactId: message.from,
          externalMessageId: message.id,
          idempotencyKey: `whatsapp:message:${message.id}`,
          occurredAt,
          text: message.text.body,
        });
      }

      for (const status of change.value.statuses ?? []) {
        if (!supportedStatuses.has(status.status as NormalizedMessageStatus['status'])) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: `unsupported_status:${status.status}`,
          });
          continue;
        }

        const occurredAt = parseWhatsAppTimestamp(status.timestamp);
        if (occurredAt === undefined) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: 'invalid_status_timestamp',
          });
          continue;
        }

        const normalizedStatus = status.status as NormalizedMessageStatus['status'];
        events.push({
          kind: 'message_status',
          channel: 'whatsapp',
          channelAccountId,
          contactId: status.recipient_id,
          externalMessageId: status.id,
          idempotencyKey: `whatsapp:status:${status.id}:${normalizedStatus}:${status.timestamp}`,
          occurredAt,
          status: normalizedStatus,
        });
      }
    }
  }

  return events;
}
