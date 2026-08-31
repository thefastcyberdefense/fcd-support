import { z } from 'zod';

import type {
  AttestPrivacyLocationInput,
  CollectAccessDataInput,
  ExecuteCorrectionInput,
  ExplicitMarketingReoptInInput,
  MarketingOptOutInput,
  ProcessPrivacyIntentInput,
  ReviewPrivacyRequestInput,
} from './policy-types.js';

const boundedString = z.string().trim().min(1).max(128);
const databaseId = z.string().regex(/^\d+$/);
const validDate = z.date().refine((value) => Number.isFinite(value.getTime()));
const category = z.enum(['newsletter', 'product_offers', 'product_updates', 'security_updates']);
const categories = z
  .array(category)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: 'categories must not contain duplicates',
  })
  .transform((values) => [...values].sort());

const identitySchema = z.strictObject({
  channel: z.enum(['messenger', 'whatsapp']),
  channelAccountId: z.string().trim().min(1).max(255),
  externalContactId: z.string().trim().min(1).max(255),
});

const processPrivacyIntentSchema = z.strictObject({
  requestKey: boundedString,
  sourceWebhookEventId: databaseId,
});

const reviewFields = {
  decidedAt: validDate,
  requestKey: boundedString,
  requestRef: boundedString,
  verificationMethod: z.enum(['same_channel_context', 'known_name']),
};
const reviewPrivacyRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...reviewFields,
    decision: z.literal('approve'),
    reasonCode: z.literal('identity_verified'),
  }),
  z.strictObject({
    ...reviewFields,
    decision: z.literal('reject'),
    reasonCode: z.enum(['identity_ambiguous', 'request_withdrawn']),
  }),
]);

const privacyLocationCode = z.enum([
  'backup_tombstone_gate',
  'manifest_recordings',
  'meta_provider',
  'offline_archives',
  'operator_exports',
  'pending_outbound',
  'primary_postgres',
]);
const attestPrivacyLocationSchema = z.strictObject({
  checkedAt: validDate,
  locationCode: privacyLocationCode,
  outcomeCode: z.enum(['location_complete', 'location_failed', 'location_not_applicable']),
  requestKey: boundedString,
  requestRef: boundedString,
});

const collectAccessDataSchema = z.strictObject({
  collectedAt: validDate,
  requestKey: boundedString,
  requestRef: boundedString,
});

const executeCorrectionSchema = z.strictObject({
  executedAt: validDate,
  fieldKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  requestKey: boundedString,
  requestRef: boundedString,
});

const marketingOptOutSchema = z.strictObject({
  effectiveAt: validDate,
  requestKey: boundedString,
  sourceWebhookEventId: databaseId,
});

const explicitMarketingReoptInSchema = z.strictObject({
  categories,
  effectiveAt: validDate,
  identity: identitySchema,
  requestKey: boundedString,
  scope: z.enum(['source_identity', 'all_linked_identities']),
  verificationMethod: z.enum(['same_channel_context', 'known_name']),
});

export function parseProcessPrivacyIntentInput(input: unknown): ProcessPrivacyIntentInput {
  return processPrivacyIntentSchema.parse(input);
}

export function parseReviewPrivacyRequestInput(input: unknown): ReviewPrivacyRequestInput {
  return reviewPrivacyRequestSchema.parse(input);
}

export function parseAttestPrivacyLocationInput(input: unknown): AttestPrivacyLocationInput {
  return attestPrivacyLocationSchema.parse(input);
}

export function parseCollectAccessDataInput(input: unknown): CollectAccessDataInput {
  return collectAccessDataSchema.parse(input);
}

export function parseExecuteCorrectionInput(input: unknown): ExecuteCorrectionInput {
  return executeCorrectionSchema.parse(input);
}

export function parseMarketingOptOutInput(input: unknown): MarketingOptOutInput {
  return marketingOptOutSchema.parse(input);
}

export function parseExplicitMarketingReoptInInput(input: unknown): ExplicitMarketingReoptInInput {
  return explicitMarketingReoptInSchema.parse(input);
}
