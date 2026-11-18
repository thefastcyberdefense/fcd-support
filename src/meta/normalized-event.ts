export type MetaChannel = 'messenger' | 'whatsapp';
export type ProviderMessageStatus = 'delivered' | 'failed' | 'read' | 'sent';
export type DeliveryState = 'provider_accepted' | ProviderMessageStatus;
export type NormalizedAttachmentKind = 'audio' | 'document' | 'image' | 'unsupported';

export interface NormalizedMediaAttachment {
  readonly caption?: string;
  readonly filename?: string;
  readonly kind: NormalizedAttachmentKind;
  readonly mediaId?: string;
  readonly mediaUrl?: string;
  readonly mimeType?: string;
  readonly rawType: string;
  readonly sha256?: string;
  readonly voice?: boolean;
}

interface NormalizedMessageBase {
  readonly channel: MetaChannel;
  readonly channelAccountId: string;
  readonly contactId: string;
  readonly externalMessageId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
}

export interface NormalizedCustomerMessage extends NormalizedMessageBase {
  readonly attachments?: readonly NormalizedMediaAttachment[];
  readonly kind: 'customer_message';
  readonly text: string;
}

export interface NormalizedBusinessMessageEcho extends NormalizedMessageBase {
  readonly kind: 'business_message_echo';
  readonly text: string;
}

export interface NormalizedMessageStatus extends NormalizedMessageBase {
  readonly kind: 'message_status';
  readonly status: ProviderMessageStatus;
}

export interface NormalizedUnsupportedEvent {
  readonly kind: 'unsupported';
  readonly channel: MetaChannel | 'unknown';
  readonly reasonCode: string;
}

export type NormalizedMetaEvent =
  | NormalizedBusinessMessageEcho
  | NormalizedCustomerMessage
  | NormalizedMessageStatus
  | NormalizedUnsupportedEvent;
