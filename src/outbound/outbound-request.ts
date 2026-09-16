import { inspect } from 'node:util';

import { z } from 'zod';

export const WHATSAPP_TEXT_MAX_CODE_POINTS = 4096;
export const MESSENGER_TEXT_MAX_CODE_POINTS = 2000;

const opaqueReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const accountReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const recipientReference = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/\s/u.test(value) &&
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && (codePoint < 127 || codePoint > 159);
      }),
  );
const maximumResponseBytes = z.number().int().min(1024).max(1_048_576);
const providerTimeoutMs = z.number().int().min(100).max(300_000);
const templateName = z
  .string()
  .regex(/^[a-z0-9_]+$/u)
  .max(512);

const commonShape = {
  attemptRef: opaqueReference,
  channelAccountId: accountReference,
  intentRef: opaqueReference,
  maximumResponseBytes,
  providerTimeoutMs,
  recipient: recipientReference,
} as const;

function boundedText(maximumCodePoints: number): z.ZodString {
  return z
    .string()
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes('\u0000') &&
        Array.from(value).length <= maximumCodePoints,
    );
}

const whatsappTextSchema = z.strictObject({
  ...commonShape,
  text: boundedText(WHATSAPP_TEXT_MAX_CODE_POINTS),
});
const messengerTextSchema = z.strictObject({
  ...commonShape,
  text: boundedText(MESSENGER_TEXT_MAX_CODE_POINTS),
});
const whatsappTemplateSchema = z.strictObject({
  ...commonShape,
  locale: z.enum(['bn_BD', 'en_US']),
  templateName,
});

export interface WhatsAppTextBody {
  readonly messaging_product: 'whatsapp';
  readonly recipient_type: 'individual';
  readonly text: {
    readonly body: string;
    readonly preview_url: false;
  };
  readonly to: string;
  readonly type: 'text';
}

export interface WhatsAppFixedTemplateBody {
  readonly messaging_product: 'whatsapp';
  readonly template: {
    readonly language: { readonly code: 'bn_BD' | 'en_US' };
    readonly name: string;
  };
  readonly to: string;
  readonly type: 'template';
}

export interface MessengerTextBody {
  readonly message: { readonly text: string };
  readonly messaging_type: 'RESPONSE';
  readonly recipient: { readonly id: string };
}

interface PreparedContextBase {
  readonly attemptRef: string;
  readonly channelAccountId: string;
  readonly endpointPath: string;
  readonly intentRef: string;
  readonly maximumResponseBytes: number;
  readonly method: 'POST';
  readonly providerTimeoutMs: number;
}

export interface PreparedWhatsAppTextRequestContext extends PreparedContextBase {
  readonly body: WhatsAppTextBody;
  readonly channel: 'whatsapp';
  readonly messageKind: 'support_text';
}

export interface PreparedWhatsAppFixedTemplateRequestContext extends PreparedContextBase {
  readonly body: WhatsAppFixedTemplateBody;
  readonly channel: 'whatsapp';
  readonly messageKind: 'fixed_template';
}

export interface PreparedMessengerTextRequestContext extends PreparedContextBase {
  readonly body: MessengerTextBody;
  readonly channel: 'messenger';
  readonly messageKind: 'support_text';
}

export type PreparedOutboundRequestContext =
  | PreparedMessengerTextRequestContext
  | PreparedWhatsAppFixedTemplateRequestContext
  | PreparedWhatsAppTextRequestContext;

export interface PreparedOutboundRequest {
  readonly channel: 'messenger' | 'whatsapp';
  readonly messageKind: 'fixed_template' | 'support_text';
  readonly method: 'POST';
  readonly prepared: true;
  readonly toJSON: () => PreparedOutboundRequestSnapshot;
  readonly [inspect.custom]: () => PreparedOutboundRequestSnapshot;
}

export interface PreparedOutboundRequestSnapshot {
  readonly channel: 'messenger' | 'whatsapp';
  readonly messageKind: 'fixed_template' | 'support_text';
  readonly method: 'POST';
  readonly prepared: true;
}

const issuedRequests = new WeakSet<object>();
const requestContexts = new WeakMap<object, PreparedOutboundRequestContext>();

function endpointPath(channelAccountId: string): string {
  return `/v25.0/${encodeURIComponent(channelAccountId)}/messages`;
}

function issuePreparedRequest(context: PreparedOutboundRequestContext): PreparedOutboundRequest {
  const snapshot: PreparedOutboundRequestSnapshot = Object.freeze({
    channel: context.channel,
    messageKind: context.messageKind,
    method: 'POST',
    prepared: true,
  });
  const request: PreparedOutboundRequest = Object.freeze({
    [inspect.custom]: () => snapshot,
    channel: context.channel,
    messageKind: context.messageKind,
    method: 'POST',
    prepared: true,
    toJSON: () => snapshot,
  });
  issuedRequests.add(request);
  requestContexts.set(request, context);
  return request;
}

export function buildWhatsAppTextRequest(input: unknown): PreparedOutboundRequest {
  const parsed = whatsappTextSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid WhatsApp text request');
  const value = parsed.data;
  const body: WhatsAppTextBody = Object.freeze({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    text: Object.freeze({ body: value.text, preview_url: false }),
    to: value.recipient,
    type: 'text',
  });
  return issuePreparedRequest(
    Object.freeze({
      attemptRef: value.attemptRef,
      body,
      channel: 'whatsapp',
      channelAccountId: value.channelAccountId,
      endpointPath: endpointPath(value.channelAccountId),
      intentRef: value.intentRef,
      maximumResponseBytes: value.maximumResponseBytes,
      messageKind: 'support_text',
      method: 'POST',
      providerTimeoutMs: value.providerTimeoutMs,
    }),
  );
}

export function buildWhatsAppFixedTemplateRequest(input: unknown): PreparedOutboundRequest {
  const parsed = whatsappTemplateSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid WhatsApp fixed-template request');
  const value = parsed.data;
  const body: WhatsAppFixedTemplateBody = Object.freeze({
    messaging_product: 'whatsapp',
    template: Object.freeze({
      language: Object.freeze({ code: value.locale }),
      name: value.templateName,
    }),
    to: value.recipient,
    type: 'template',
  });
  return issuePreparedRequest(
    Object.freeze({
      attemptRef: value.attemptRef,
      body,
      channel: 'whatsapp',
      channelAccountId: value.channelAccountId,
      endpointPath: endpointPath(value.channelAccountId),
      intentRef: value.intentRef,
      maximumResponseBytes: value.maximumResponseBytes,
      messageKind: 'fixed_template',
      method: 'POST',
      providerTimeoutMs: value.providerTimeoutMs,
    }),
  );
}

export function buildMessengerTextRequest(input: unknown): PreparedOutboundRequest {
  const parsed = messengerTextSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid Messenger text request');
  const value = parsed.data;
  const body: MessengerTextBody = Object.freeze({
    message: Object.freeze({ text: value.text }),
    messaging_type: 'RESPONSE',
    recipient: Object.freeze({ id: value.recipient }),
  });
  return issuePreparedRequest(
    Object.freeze({
      attemptRef: value.attemptRef,
      body,
      channel: 'messenger',
      channelAccountId: value.channelAccountId,
      endpointPath: endpointPath(value.channelAccountId),
      intentRef: value.intentRef,
      maximumResponseBytes: value.maximumResponseBytes,
      messageKind: 'support_text',
      method: 'POST',
      providerTimeoutMs: value.providerTimeoutMs,
    }),
  );
}

export function readPreparedOutboundRequest(
  value: unknown,
): PreparedOutboundRequestContext | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  return issuedRequests.has(value) ? requestContexts.get(value) : undefined;
}
