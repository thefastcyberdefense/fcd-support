import { z } from 'zod';

import type { ConsentCommand } from './policy-types.js';

const categoryPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const identitySchema = z.strictObject({
  channel: z.enum(['messenger', 'whatsapp']),
  channelAccountId: z.string().trim().min(1).max(255),
  externalContactId: z.string().trim().min(1).max(255),
});

const commandFields = {
  identity: identitySchema,
  action: z.enum(['grant', 'revoke']),
  category: z.string().trim().regex(categoryPattern),
  wording: z.string().trim().min(1).max(500),
  wordingVersion: z.string().trim().min(1).max(64),
  sourceAt: z.date().refine((sourceAt) => !Number.isNaN(sourceAt.getTime())),
  idempotencyKey: z.string().trim().min(1).max(128),
};

const consentCommandSchema = z.discriminatedUnion('source', [
  z.strictObject({
    ...commandFields,
    source: z.literal('customer_message'),
    sourceWebhookEventId: z.string().regex(/^\d+$/),
  }),
  z.strictObject({
    ...commandFields,
    source: z.literal('reviewer_recorded'),
  }),
]);

export function parseConsentCommand(input: unknown): ConsentCommand {
  return consentCommandSchema.parse(input);
}
