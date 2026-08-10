import type { NormalizedMetaEvent } from './normalized-event.js';
import { normalizeMessengerWebhook } from './normalize-messenger.js';
import { normalizeWhatsAppWebhook } from './normalize-whatsapp.js';

function readObjectName(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  return Reflect.get(payload, 'object');
}

export function normalizeMetaWebhook(payload: unknown): readonly NormalizedMetaEvent[] {
  const objectName = readObjectName(payload);

  if (objectName === 'whatsapp_business_account') {
    return normalizeWhatsAppWebhook(payload);
  }

  if (objectName === 'page') {
    return normalizeMessengerWebhook(payload);
  }

  return [{ kind: 'unsupported', channel: 'unknown', reasonCode: 'unsupported_meta_object' }];
}
