import { z } from 'zod';

import type { NormalizedMetaEvent } from './normalized-event.js';

const messagingEventSchema = z
  .object({
    message: z
      .object({
        is_echo: z.boolean().optional(),
        mid: z.string(),
        text: z.string().optional(),
      })
      .loose()
      .optional(),
    recipient: z.object({ id: z.string() }).loose(),
    sender: z.object({ id: z.string() }).loose(),
    timestamp: z.number(),
  })
  .loose();

const envelopeSchema = z
  .object({
    object: z.literal('page'),
    entry: z.array(z.unknown()),
  })
  .loose();

const entrySchema = z
  .object({
    id: z.string(),
    messaging: z.array(z.unknown()),
    time: z.number(),
  })
  .loose();

function parseMessengerTimestamp(timestamp: number): Date | undefined {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return undefined;
  }

  const occurredAt = new Date(timestamp);
  return Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt;
}

export function normalizeMessengerWebhook(payload: unknown): readonly NormalizedMetaEvent[] {
  const parsed = envelopeSchema.safeParse(payload);

  if (!parsed.success) {
    return [
      { kind: 'unsupported', channel: 'messenger', reasonCode: 'invalid_messenger_envelope' },
    ];
  }

  const events: NormalizedMetaEvent[] = [];

  for (const entryInput of parsed.data.entry) {
    const parsedEntry = entrySchema.safeParse(entryInput);
    if (!parsedEntry.success) {
      events.push({
        kind: 'unsupported',
        channel: 'messenger',
        reasonCode: 'invalid_messenger_entry',
      });
      continue;
    }

    const entry = parsedEntry.data;
    for (const messagingEventInput of entry.messaging) {
      const parsedMessagingEvent = messagingEventSchema.safeParse(messagingEventInput);
      if (!parsedMessagingEvent.success) {
        events.push({
          kind: 'unsupported',
          channel: 'messenger',
          reasonCode: 'invalid_messaging_event',
        });
        continue;
      }

      const messagingEvent = parsedMessagingEvent.data;
      const message = messagingEvent.message;
      if (message?.text === undefined) {
        events.push({
          kind: 'unsupported',
          channel: 'messenger',
          reasonCode: 'unsupported_messaging_event',
        });
        continue;
      }

      const occurredAt = parseMessengerTimestamp(messagingEvent.timestamp);
      if (occurredAt === undefined) {
        events.push({
          kind: 'unsupported',
          channel: 'messenger',
          reasonCode: 'invalid_messaging_timestamp',
        });
        continue;
      }

      const isEcho = message.is_echo === true;
      const contactId = isEcho ? messagingEvent.recipient.id : messagingEvent.sender.id;

      events.push({
        kind: isEcho ? 'business_message_echo' : 'customer_message',
        channel: 'messenger',
        channelAccountId: entry.id,
        contactId,
        externalMessageId: message.mid,
        idempotencyKey: `messenger:message:${entry.id}:${message.mid}`,
        occurredAt,
        text: message.text,
      });
    }
  }

  return events;
}
