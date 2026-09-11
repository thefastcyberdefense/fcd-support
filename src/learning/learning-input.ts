import { z } from 'zod';
import {
  gapKinds,
  gapSummaries,
  type GapObservationInput,
  type InsightRunInput,
  type QuestionDigestInput,
  type OwnerAnswerInput,
  type LearningPolicy,
} from './learning-types.js';

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const date = z.date().refine((value) => Number.isFinite(value.getTime()));
const internalId = z
  .string()
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const observation = z
  .strictObject({
    observationRef: reference,
    requestKey: reference,
    webhookEventId: internalId,
    language: z.enum(['en', 'bn']),
    gapKind: z.enum(gapKinds),
    candidateVersionRefs: z.array(reference).max(8).default([]),
    sanitizedSummary: z.string().min(1).max(1000).optional(),
    observedAt: date,
    retentionDeadline: date,
  })
  .refine(
    (value) =>
      value.retentionDeadline > value.observedAt &&
      new Set(value.candidateVersionRefs).size === value.candidateVersionRefs.length &&
      (value.sanitizedSummary === undefined ||
        value.sanitizedSummary === gapSummaries[value.gapKind]),
  );
const insightRun = z
  .strictObject({
    runRef: reference,
    requestKey: reference,
    windowStartedAt: date,
    windowEndedAt: date,
  })
  .refine((value) => value.windowEndedAt > value.windowStartedAt);
const digest = z.strictObject({ digestRef: reference, requestKey: reference });
const ownerAnswer = z.strictObject({
  questionRef: reference,
  requestKey: reference,
  answeredAt: date,
  answerText: z.string().trim().min(1).max(4000),
  answerBn: z.string().trim().min(1).max(4000),
});
// Values remain configurable within the approved cadence and storage/resource safety bounds.
const policy = z
  .strictObject({
    minimumGroupCount: z.number().int().min(2).max(1000),
    digestIntervalMilliseconds: z.number().int().min(259200000).max(31536000000),
    maximumQuestionsPerDigest: z.number().int().min(1).max(5),
    questionCooldownMilliseconds: z.number().int().min(60000).max(31536000000),
    maximumDigestAppearances: z.number().int().min(1).max(10),
    maximumObservationsPerRun: z.number().int().min(2).max(10000),
  })
  .refine(
    (value) =>
      value.questionCooldownMilliseconds >= value.digestIntervalMilliseconds &&
      value.maximumObservationsPerRun >= value.minimumGroupCount,
  );

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError(message);
  return result.data;
}
export const parseGapObservation = (input: unknown): GapObservationInput =>
  parse(observation, input, 'Learning observation is invalid');
export const parseInsightRun = (input: unknown): InsightRunInput =>
  parse(insightRun, input, 'Insight run is invalid');
export const parseQuestionDigest = (input: unknown): QuestionDigestInput =>
  parse(digest, input, 'Question digest is invalid');
export const parseOwnerAnswer = (input: unknown): OwnerAnswerInput =>
  parse(ownerAnswer, input, 'Owner answer is invalid');
export const parseLearningPolicy = (input: unknown): LearningPolicy =>
  parse(policy, input, 'Learning policy is invalid');
