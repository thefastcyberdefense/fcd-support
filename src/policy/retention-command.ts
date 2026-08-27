import { z } from 'zod';

import type {
  ActiveRelationshipCloseInput,
  ActiveRelationshipReviewInput,
  ActiveRelationshipStartInput,
  QualifyingRetentionEventInput,
  RetentionReclassificationInput,
} from './policy-types.js';

const decimalId = z.string().trim().regex(/^\d+$/);
const requestKey = z.string().trim().min(1).max(128);
const validDate = z.date().refine((value) => Number.isFinite(value.getTime()));
const lowerLifecycleClass = z.enum(['casual_chat', 'unconverted_lead']);

const qualifyingRetentionEventSchema = z.strictObject({
  conversationId: decimalId,
  requestKey,
  sourceWebhookEventId: decimalId,
  targetClass: lowerLifecycleClass,
});

const activeRelationshipStartSchema = z.strictObject({
  conversationId: decimalId,
  effectiveAt: validDate,
  relationshipStartedAt: validDate,
  requestKey,
});

const activeRelationshipReviewSchema = z.strictObject({
  conversationId: decimalId,
  requestKey,
  reviewedAt: validDate,
});

const activeRelationshipCloseSchema = z
  .strictObject({
    conversationId: decimalId,
    effectiveAt: validDate,
    finalPaidServiceCompletedAt: validDate.optional(),
    relationshipEndedAt: validDate.optional(),
    requestKey,
  })
  .refine(
    (value) =>
      value.relationshipEndedAt !== undefined || value.finalPaidServiceCompletedAt !== undefined,
    { message: 'An active-client close requires at least one documented anchor' },
  );

const retentionReclassificationSchema = z.strictObject({
  conversationId: decimalId,
  effectiveAt: validDate,
  requestKey,
  targetClass: lowerLifecycleClass,
});

export function parseQualifyingRetentionEventInput(input: unknown): QualifyingRetentionEventInput {
  return qualifyingRetentionEventSchema.parse(input);
}

export function parseActiveRelationshipStartInput(input: unknown): ActiveRelationshipStartInput {
  return activeRelationshipStartSchema.parse(input);
}

export function parseActiveRelationshipReviewInput(input: unknown): ActiveRelationshipReviewInput {
  return activeRelationshipReviewSchema.parse(input);
}

export function parseActiveRelationshipCloseInput(input: unknown): ActiveRelationshipCloseInput {
  const parsed = activeRelationshipCloseSchema.parse(input);
  return {
    conversationId: parsed.conversationId,
    effectiveAt: parsed.effectiveAt,
    requestKey: parsed.requestKey,
    ...(parsed.finalPaidServiceCompletedAt === undefined
      ? {}
      : { finalPaidServiceCompletedAt: parsed.finalPaidServiceCompletedAt }),
    ...(parsed.relationshipEndedAt === undefined
      ? {}
      : { relationshipEndedAt: parsed.relationshipEndedAt }),
  };
}

export function parseRetentionReclassificationInput(
  input: unknown,
): RetentionReclassificationInput {
  return retentionReclassificationSchema.parse(input);
}
