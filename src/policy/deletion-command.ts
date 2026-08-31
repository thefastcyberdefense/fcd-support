import { z } from 'zod';

import type {
  ExecuteDeletionInput,
  OpenDeletionRequestInput,
  RestoreDeletionBatchInput,
  RestoreDeletionFinalizeInput,
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

const keyVersion = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,64}$/);
const requiredKeyVersions = z
  .array(keyVersion)
  .min(1)
  .max(32)
  .refine((versions) => new Set(versions).size === versions.length, {
    message: 'requiredKeyVersions must not contain duplicates',
  })
  .transform((versions) => [...versions].sort());
const restoreGateFields = {
  evaluatedAt: validDate,
  gateRef: boundedString,
  gitRevision: z.string().regex(/^[0-9a-f]{40}$/),
  requestKey: boundedString,
  requiredKeyVersions,
};
const restoreDeletionBatchSchema = z.strictObject({
  ...restoreGateFields,
  limit: z.number().int().min(1).max(1_000),
});
const restoreDeletionFinalizeSchema = z.strictObject(restoreGateFields);

export function parseOpenDeletionRequestInput(input: unknown): OpenDeletionRequestInput {
  return openDeletionRequestSchema.parse(input);
}

export function parseReviewDeletionRequestInput(input: unknown): ReviewDeletionRequestInput {
  return reviewDeletionRequestSchema.parse(input);
}

export function parseExecuteDeletionInput(input: unknown): ExecuteDeletionInput {
  return executeDeletionSchema.parse(input);
}

export function parseRestoreDeletionBatchInput(input: unknown): RestoreDeletionBatchInput {
  return restoreDeletionBatchSchema.parse(input);
}

export function parseRestoreDeletionFinalizeInput(input: unknown): RestoreDeletionFinalizeInput {
  return restoreDeletionFinalizeSchema.parse(input);
}
