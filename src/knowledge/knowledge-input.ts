import { z } from 'zod';

import type {
  KnowledgeProposalInput,
  KnowledgePublicationCommand,
  KnowledgeReviewCommand,
  KnowledgeSourceInput,
} from './knowledge-types.js';

const opaqueReference = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const itemKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const reasonCode = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const tag = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));
const boundedQuestion = z.string().trim().min(1).max(1000);
const boundedAnswer = z.string().trim().min(1).max(4000);

const bilingualQuestionSchema = z.strictObject({
  bn: boundedQuestion,
  en: boundedQuestion,
});

const bilingualAnswerSchema = z.strictObject({
  bn: boundedAnswer,
  en: boundedAnswer,
});

const aliasSchema = z.strictObject({
  kind: z.enum(['alias', 'example', 'intent']),
  language: z.enum(['en', 'bn']),
  phrase: boundedQuestion,
});

const knowledgeProposalSchema = z
  .strictObject({
    aliases: z.array(aliasSchema).max(64).default([]),
    answers: bilingualAnswerSchema,
    applicability: z.string().trim().min(1).max(1000).optional(),
    authorReference: opaqueReference,
    contentSha256: digest,
    createdAt: validDate,
    itemKey,
    kind: z.enum(['faq', 'business_fact', 'safety_response', 'escalation_response']),
    questions: bilingualQuestionSchema.optional(),
    replacesVersionRef: opaqueReference.optional(),
    requestKey: opaqueReference,
    rollbackFromVersionRef: opaqueReference.optional(),
    sourceRef: opaqueReference,
    sourceSha256: digest,
    sourceSnapshotRef: opaqueReference.optional(),
    tags: z.array(tag).max(32).default([]),
    versionRef: opaqueReference,
  })
  .superRefine((value, context) => {
    if (value.kind === 'faq' && value.questions === undefined) {
      context.addIssue({ code: 'custom', path: ['questions'], message: 'required for FAQ' });
    }
    if (value.replacesVersionRef !== undefined && value.replacesVersionRef === value.versionRef) {
      context.addIssue({ code: 'custom', path: ['replacesVersionRef'], message: 'self reference' });
    }
    if (
      value.rollbackFromVersionRef !== undefined &&
      value.rollbackFromVersionRef === value.versionRef
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rollbackFromVersionRef'],
        message: 'self reference',
      });
    }
    if (new Set(value.tags).size !== value.tags.length) {
      context.addIssue({ code: 'custom', path: ['tags'], message: 'duplicate tag' });
    }
  });

const websiteUrl = z.url().refine((value) => new URL(value).protocol === 'https:');
const knowledgeSourceSchema = z
  .strictObject({
    approvedUrl: websiteUrl.max(2048).optional(),
    createdAt: validDate,
    createdByReference: opaqueReference,
    label: z.string().trim().min(1).max(200),
    sourceRef: opaqueReference,
    sourceType: z.enum(['manual_business', 'website', 'policy', 'support_gap']),
  })
  .superRefine((value, context) => {
    if (value.sourceType === 'website' && value.approvedUrl === undefined) {
      context.addIssue({ code: 'custom', path: ['approvedUrl'], message: 'required for website' });
    }
    if (value.sourceType !== 'website' && value.approvedUrl !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['approvedUrl'],
        message: 'allowed only for website',
      });
    }
  });

const knowledgeReviewSchema = z.strictObject({
  action: z.enum(['submit', 'approve', 'reject']),
  effectiveAt: validDate,
  reasonCode,
  requestKey: opaqueReference,
  reviewerReference: opaqueReference,
  versionRef: opaqueReference,
});

const publicationBase = {
  effectiveAt: validDate,
  itemKey,
  reasonCode,
  requestKey: opaqueReference,
  reviewerReference: opaqueReference,
  versionRef: opaqueReference,
} as const;

const knowledgePublicationSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...publicationBase,
    action: z.literal('publish'),
    priorVersionRef: opaqueReference.optional(),
  }),
  z.strictObject({ ...publicationBase, action: z.literal('retire') }),
  z.strictObject({
    ...publicationBase,
    action: z.literal('rollback'),
    priorVersionRef: opaqueReference,
  }),
]);

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new TypeError(message);
  }
  return result.data;
}

export function parseKnowledgeProposal(input: unknown): KnowledgeProposalInput {
  const parsed = parseOrThrow(knowledgeProposalSchema, input, 'Knowledge proposal is invalid');
  return {
    aliases: parsed.aliases,
    answers: parsed.answers,
    ...(parsed.applicability === undefined ? {} : { applicability: parsed.applicability }),
    authorReference: parsed.authorReference,
    contentSha256: parsed.contentSha256,
    createdAt: parsed.createdAt,
    itemKey: parsed.itemKey,
    kind: parsed.kind,
    ...(parsed.questions === undefined ? {} : { questions: parsed.questions }),
    ...(parsed.replacesVersionRef === undefined
      ? {}
      : { replacesVersionRef: parsed.replacesVersionRef }),
    requestKey: parsed.requestKey,
    ...(parsed.rollbackFromVersionRef === undefined
      ? {}
      : { rollbackFromVersionRef: parsed.rollbackFromVersionRef }),
    sourceRef: parsed.sourceRef,
    sourceSha256: parsed.sourceSha256,
    ...(parsed.sourceSnapshotRef === undefined
      ? {}
      : { sourceSnapshotRef: parsed.sourceSnapshotRef }),
    tags: parsed.tags,
    versionRef: parsed.versionRef,
  };
}

export function parseKnowledgeSourceInput(input: unknown): KnowledgeSourceInput {
  const parsed = parseOrThrow(knowledgeSourceSchema, input, 'Knowledge source is invalid');
  return {
    ...(parsed.approvedUrl === undefined ? {} : { approvedUrl: parsed.approvedUrl }),
    createdAt: parsed.createdAt,
    createdByReference: parsed.createdByReference,
    label: parsed.label,
    sourceRef: parsed.sourceRef,
    sourceType: parsed.sourceType,
  };
}

export function parseKnowledgeReviewCommand(input: unknown): KnowledgeReviewCommand {
  return parseOrThrow(knowledgeReviewSchema, input, 'Knowledge review command is invalid');
}

export function parseKnowledgePublicationCommand(input: unknown): KnowledgePublicationCommand {
  const parsed = parseOrThrow(
    knowledgePublicationSchema,
    input,
    'Knowledge publication command is invalid',
  );
  if (parsed.action === 'publish') {
    return {
      action: parsed.action,
      effectiveAt: parsed.effectiveAt,
      itemKey: parsed.itemKey,
      ...(parsed.priorVersionRef === undefined ? {} : { priorVersionRef: parsed.priorVersionRef }),
      reasonCode: parsed.reasonCode,
      requestKey: parsed.requestKey,
      reviewerReference: parsed.reviewerReference,
      versionRef: parsed.versionRef,
    };
  }
  return parsed;
}
