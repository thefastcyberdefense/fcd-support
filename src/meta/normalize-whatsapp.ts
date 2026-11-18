import { z } from 'zod';

import type {
  NormalizedMediaAttachment,
  NormalizedMetaEvent,
  NormalizedMessageStatus,
} from './normalized-event.js';

const mediaItemSchema = z
  .object({
    caption: z.string().optional(),
    filename: z.string().optional(),
    id: z.string().min(1),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    voice: z.boolean().optional(),
  })
  .loose();

const unsupportedMediaItemSchema = z
  .object({
    caption: z.string().optional(),
    id: z.string().min(1).optional(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
  })
  .loose();

const messageSchema = z
  .object({
    audio: mediaItemSchema.optional(),
    document: mediaItemSchema.optional(),
    from: z.string().min(1).optional(),
    from_user_id: z.string().min(1).optional(),
    id: z.string(),
    image: mediaItemSchema.optional(),
    sticker: unsupportedMediaItemSchema.optional(),
    text: z.object({ body: z.string() }).optional(),
    timestamp: z.string(),
    type: z.string(),
    video: unsupportedMediaItemSchema.optional(),
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

function buildWhatsAppAttachment(
  kind: NormalizedMediaAttachment['kind'],
  rawType: string,
  item: {
    readonly caption?: string | undefined;
    readonly filename?: string | undefined;
    readonly id?: string | undefined;
    readonly mime_type?: string | undefined;
    readonly sha256?: string | undefined;
    readonly voice?: boolean | undefined;
  },
): NormalizedMediaAttachment {
  return {
    kind,
    rawType,
    ...(item.id === undefined ? {} : { mediaId: item.id }),
    ...(item.mime_type === undefined ? {} : { mimeType: item.mime_type }),
    ...(item.filename === undefined ? {} : { filename: item.filename }),
    ...(item.caption === undefined ? {} : { caption: item.caption }),
    ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
    ...(item.voice === undefined ? {} : { voice: item.voice }),
  };
}

function normalizeWhatsAppContent(message: z.infer<typeof messageSchema>):
  | {
      readonly attachments?: readonly NormalizedMediaAttachment[];
      readonly text: string;
    }
  | undefined {
  if (message.type === 'text' && message.text !== undefined) {
    return { text: message.text.body };
  }
  if (message.type === 'image' && message.image !== undefined) {
    return {
      text: message.image.caption ?? '',
      attachments: [buildWhatsAppAttachment('image', 'image', message.image)],
    };
  }
  if (message.type === 'document' && message.document !== undefined) {
    return {
      text: message.document.caption ?? '',
      attachments: [buildWhatsAppAttachment('document', 'document', message.document)],
    };
  }
  if (message.type === 'audio' && message.audio !== undefined) {
    return {
      text: '',
      attachments: [buildWhatsAppAttachment('audio', 'audio', message.audio)],
    };
  }
  if (message.type === 'video' && message.video !== undefined) {
    return {
      text: message.video.caption ?? '',
      attachments: [buildWhatsAppAttachment('unsupported', 'video', message.video)],
    };
  }
  if (message.type === 'sticker' && message.sticker !== undefined) {
    return {
      text: message.sticker.caption ?? '',
      attachments: [buildWhatsAppAttachment('unsupported', 'sticker', message.sticker)],
    };
  }
  return undefined;
}

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
        const contactId =
          message.from ??
          (message.from_user_id === undefined ? undefined : `user_id:${message.from_user_id}`);
        if (contactId === undefined) {
          events.push({
            kind: 'unsupported',
            channel: 'whatsapp',
            reasonCode: 'invalid_message_item',
          });
          continue;
        }
        const content = normalizeWhatsAppContent(message);
        if (content === undefined) {
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
          contactId,
          externalMessageId: message.id,
          idempotencyKey: `whatsapp:message:${message.id}`,
          occurredAt,
          text: content.text,
          ...(content.attachments === undefined ? {} : { attachments: content.attachments }),
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
