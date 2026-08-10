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
    entry: z.array(z.unknown()),
  })
  .loose();

const entrySchema = z
  .object({
    changes: z.array(z.unknown()),
    id: z.string(),
  })
  .loose();

const changeSchema = z
  .object({
    field: z.string(),
    value: z.unknown(),
  })
  .loose();

const messagesValueSchema = z
  .object({
    messages: z.array(z.unknown()).optional(),
    metadata: z.object({ phone_number_id: z.string() }).loose(),
    statuses: z.array(z.unknown()).optional(),
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

  for (const entryInput of parsed.data.entry) {
    const parsedEntry = entrySchema.safeParse(entryInput);
    if (!parsedEntry.success) {
      events.push({
        kind: 'unsupported',
        channel: 'whatsapp',
        reasonCode: 'invalid_whatsapp_entry',
      });
      continue;
    }

    for (const changeInput of parsedEntry.data.changes) {
      const parsedChange = changeSchema.safeParse(changeInput);
      if (!parsedChange.success) {
        events.push({
          kind: 'unsupported',
          channel: 'whatsapp',
          reasonCode: 'invalid_whatsapp_change',
        });
        continue;
      }

      const change = parsedChange.data;
      if (change.field !== 'messages') {
        events.push({
          kind: 'unsupported',
          channel: 'whatsapp',
          reasonCode: `unsupported_change_field:${change.field}`,
        });
        continue;
      }

      const parsedValue = messagesValueSchema.safeParse(change.value);
      if (!parsedValue.success) {
        events.push({
          kind: 'unsupported',
          channel: 'whatsapp',
          reasonCode: 'invalid_messages_change',
        });
        continue;
      }

      const channelAccountId = parsedValue.data.metadata.phone_number_id;

      for (const messageInput of parsedValue.data.messages ?? []) {
        const parsedMessage = messageSchema.safeParse(messageInput);
        if (!parsedMessage.success) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: 'invalid_message_item',
          });
          continue;
        }

        const message = parsedMessage.data;
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

      for (const statusInput of parsedValue.data.statuses ?? []) {
        const parsedStatus = statusSchema.safeParse(statusInput);
        if (!parsedStatus.success) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: 'invalid_status_item',
          });
          continue;
        }

        const status = parsedStatus.data;
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
