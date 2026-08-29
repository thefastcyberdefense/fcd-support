import { z } from 'zod';

import type {
  ExecuteDeletionInput,
  OpenDeletionRequestInput,
  ReviewDeletionRequestInput,
} from './policy-types.js';

const boundedString = z.string().trim().min(1).max(128);
const databaseId = z.string().regex(/^\d+$/);
const validDate = z.date().refine((value) => Number.isFinite(value.getTime()));

const identitySchema = z.strictObject({
  channel: z.enum(['messenger', 'whatsapp']),
  channelAccountId: z.string().trim().min(1).max(255),
  externalContactId: z.string().trim().min(1).max(255),
});

const openDeletionRequestSchema = z.strictObject({
  identity: identitySchema,
  requestedAt: validDate,
  requestKey: boundedString,
  sourceWebhookEventId: databaseId,
});

const reviewFields = {
  confirmationWebhookEventId: databaseId,
  decidedAt: validDate,
  requestKey: boundedString,
  requestRef: boundedString,
  verificationMethod: z.enum(['explicit_confirmation', 'known_name']),
};

const reviewDeletionRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...reviewFields,
    decision: z.literal('approve'),
    reasonCode: z.literal('customer_confirmed'),
  }),
  z.strictObject({
    ...reviewFields,
    decision: z.literal('reject'),
    reasonCode: z.enum(['identity_ambiguous', 'request_withdrawn']),
  }),
]);

const executeDeletionSchema = z.strictObject({
  executedAt: validDate,
  requestKey: boundedString,
  requestRef: boundedString,
});

export function parseOpenDeletionRequestInput(input: unknown): OpenDeletionRequestInput {
  return openDeletionRequestSchema.parse(input);
}

export function parseReviewDeletionRequestInput(input: unknown): ReviewDeletionRequestInput {
  return reviewDeletionRequestSchema.parse(input);
}

export function parseExecuteDeletionInput(input: unknown): ExecuteDeletionInput {
  return executeDeletionSchema.parse(input);
}
