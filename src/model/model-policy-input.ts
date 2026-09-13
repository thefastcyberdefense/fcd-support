import { z } from 'zod';

import type {
  ModelPolicyCreateInput,
  ModelPolicyTransitionInput,
  ModelPolicyValues,
} from './model-policy-types.js';

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const reasonCode = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const validDate = z.date().refine((value) => Number.isFinite(value.getTime()));

const valuesSchema: z.ZodType<ModelPolicyValues> = z
  .strictObject({
    approvedProviderAttempts: z.number().int().min(1).max(5),
    architectureProviderCeiling: z.number().int().min(1).max(5),
    concurrentCalls: z.number().int().min(1).max(100),
    cooldownMs: z.number().int().min(0).max(86_400_000),
    faqAmbiguityMargin: z.number().min(0).max(1),
    faqMinimumSimilarity: z.number().positive().max(1),
    globalUtcDayCalls: z.number().int().min(1).max(100_000),
    maximumFaqCandidates: z.number().int().min(2).max(100),
    outputTokens: z.number().int().min(1).max(4096),
    perContact15MinuteCalls: z.number().int().min(1).max(100),
    perContact24HourCalls: z.number().int().min(1).max(1000),
    queueCapacity: z.number().int().min(0).max(10_000),
    totalTimeoutMs: z.number().int().min(100).max(120_000),
  })
  .superRefine((value, context) => {
    if (
      value.perContact15MinuteCalls > value.perContact24HourCalls ||
      value.perContact24HourCalls > value.globalUtcDayCalls ||
      value.approvedProviderAttempts > value.architectureProviderCeiling ||
      value.faqAmbiguityMargin >= value.faqMinimumSimilarity
    ) {
      context.addIssue({ code: 'custom', message: 'Model policy values conflict' });
    }
  });

const createSchema = z.strictObject({
  createdAt: validDate,
  createdByAccountRef: reference,
  policyRef: reference,
  requestKey: reference,
  values: valuesSchema,
});

const transitionSchema = z.strictObject({
  action: z.enum(['submit', 'approve', 'activate', 'retire']),
  effectiveAt: validDate,
  policyRef: reference,
  reasonCode,
  requestKey: reference,
  reviewerAccountRef: reference,
});

export function parseModelPolicyCreateInput(input: unknown): ModelPolicyCreateInput {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Model policy input is invalid');
  return parsed.data;
}

export function parseModelPolicyValues(input: unknown): ModelPolicyValues {
  const parsed = valuesSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Model policy values are invalid');
  return parsed.data;
}

export function parseModelPolicyTransitionInput(input: unknown): ModelPolicyTransitionInput {
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Model policy transition is invalid');
  return parsed.data;
}
