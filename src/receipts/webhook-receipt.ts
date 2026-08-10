import type { NormalizedMetaEvent } from '../meta/normalized-event.js';

export interface WebhookReceiptInput {
  readonly events: readonly NormalizedMetaEvent[];
  readonly payloadSha256: string;
  readonly receivedAt: Date;
}

export type WebhookReceiptSink = (receipt: WebhookReceiptInput) => Promise<unknown>;
