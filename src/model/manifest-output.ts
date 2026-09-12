import { z } from 'zod';

import { inspectSensitiveText } from '../safety/sensitive-data-gate.js';
import type {
  ManifestDecisionEnvelope,
  ManifestKnowledgeRecord,
  ManifestOutputRejectionReason,
  ManifestOutputValidationContext,
  ManifestOutputValidationResult,
} from './model-types.js';

const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const envelopeSchema = z.strictObject({
  answer: z.string(),
  decision: z.enum(['answer', 'escalate']),
  knowledgeReferences: z.array(z.string().regex(referencePattern)).max(100),
  language: z.enum(['en', 'bn']),
  needsHumanReview: z.boolean(),
  reasonCode: z.enum([
    'human_review_required',
    'insufficient_published_knowledge',
    'published_knowledge_answer',
  ]),
});
const approvedUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.username === '' && url.password === '';
});
const validationContextSchema = z.strictObject({
  knowledge: z
    .array(
      z.strictObject({
        approvedUrls: z.array(approvedUrlSchema).max(100),
        fact: z.string().trim().min(1).max(100_000),
        reference: z.string().regex(referencePattern),
      }),
    )
    .max(100),
  maximumResponseBytes: z.number().int().min(1).max(1_048_576),
  requiredLanguage: z.enum(['en', 'bn']),
});

function rejected(reasonCode: ManifestOutputRejectionReason): ManifestOutputValidationResult {
  return Object.freeze({ status: 'rejected', reasonCode });
}

function parseContext(value: unknown): ManifestOutputValidationContext {
  const parsed = validationContextSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Manifest output validation context is invalid');
  const context = parsed.data;
  const references = new Set<string>();
  for (const item of context.knowledge) {
    if (
      references.has(item.reference) ||
      new Set(item.approvedUrls).size !== item.approvedUrls.length
    ) {
      throw new TypeError('Manifest output validation context is invalid');
    }
    references.add(item.reference);
  }
  return context;
}

function languageMatches(value: string, language: 'bn' | 'en'): boolean {
  let hasExpectedLetter = false;
  for (const character of value) {
    if (!/\p{Letter}/u.test(character)) continue;
    const latin = /\p{Script=Latin}/u.test(character);
    const bengali = /\p{Script=Bengali}/u.test(character);
    if (language === 'en') {
      if (!latin) return false;
      hasExpectedLetter = true;
    } else {
      if (!latin && !bengali) return false;
      if (bengali) hasExpectedLetter = true;
    }
  }
  return hasExpectedLetter;
}

function extractUrls(value: string): readonly string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>"')\]]+/giu)].map((match) =>
    match[0].replace(/[.,!?;:]+$/gu, ''),
  );
}

function containsActionClaim(value: string): boolean {
  return (
    /\b(?:i|we)\s+(?:have\s+)?(?:accessed|called|cancelled|changed|checked|closed|contacted|created|deleted|emailed|executed|opened|refunded|reset|ran|sent|updated)\b/iu.test(
      value,
    ) ||
    /\b(?:function call|plugin|tool)\b/iu.test(value) ||
    /(?:আমি|আমরা).*(?:পাঠিয়েছি|পরিবর্তন করেছি|রিসেট করেছি|তৈরি করেছি|ফেরত দিয়েছি)/u.test(value)
  );
}

function protectedAssertions(value: string): ReadonlySet<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const matches = normalized.match(
    /(?:৳\s*)?\b\d+(?:[.,]\d+)*(?:\s*(?:%|bdt|usd|eur|gbp|taka))?\b|\b(?:bdt|usd|eur|gbp|taka)\b/giu,
  );
  return new Set(matches ?? []);
}

const supportStopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'please',
  'should',
  'that',
  'the',
  'these',
  'this',
  'those',
  'to',
  'use',
  'using',
  'was',
  'we',
  'were',
  'with',
  'would',
  'you',
  'your',
  'আমি',
  'আমরা',
  'আর',
  'এই',
  'ও',
  'ওই',
  'কি',
  'কী',
  'জন্য',
  'তা',
  'থেকে',
  'দিয়ে',
  'যে',
]);
const negationTerms = new Set([
  'free',
  'never',
  'no',
  'not',
  'unavailable',
  'without',
  'না',
  'নয়',
  'নেই',
  'বিনা',
  'বিনামূল্যে',
]);

function lexicalTokens(value: string): ReadonlySet<string> {
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"')\]]+/giu, ' ');
  const normalized = withoutUrls.normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = normalized.match(/[\p{Letter}\p{Mark}\p{Number}]+/gu) ?? [];
  return new Set(tokens.filter((token) => !supportStopWords.has(token)));
}

function hasLexicalSupport(answer: string, facts: string): boolean {
  const answerTokens = lexicalTokens(answer);
  const factTokens = lexicalTokens(facts);
  if (answerTokens.size === 0 || factTokens.size === 0) return false;
  for (const term of negationTerms) {
    if (answerTokens.has(term) && !factTokens.has(term)) return false;
  }
  for (const token of answerTokens) if (!factTokens.has(token)) return false;
  return true;
}

function referencedKnowledge(
  references: readonly string[],
  knowledge: readonly ManifestKnowledgeRecord[],
): readonly ManifestKnowledgeRecord[] | undefined {
  const byReference = new Map(knowledge.map((item) => [item.reference, item]));
  const selected: ManifestKnowledgeRecord[] = [];
  for (const reference of references) {
    const item = byReference.get(reference);
    if (item === undefined) return undefined;
    selected.push(item);
  }
  return selected;
}

export function parseManifestOutput(
  raw: unknown,
  contextValue: unknown,
): ManifestOutputValidationResult {
  const context = parseContext(contextValue);
  if (typeof raw !== 'string') return rejected('invalid_schema');
  if (new TextEncoder().encode(raw).byteLength > context.maximumResponseBytes) {
    return rejected('oversized_output');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return rejected('malformed_json');
  }
  const parsed = envelopeSchema.safeParse(decoded);
  if (!parsed.success) return rejected('invalid_schema');
  const value = parsed.data;
  if (new Set(value.knowledgeReferences).size !== value.knowledgeReferences.length) {
    return rejected('invalid_schema');
  }
  if (
    (value.decision === 'answer' &&
      (value.answer.trim().length === 0 ||
        value.needsHumanReview ||
        value.reasonCode !== 'published_knowledge_answer')) ||
    (value.decision === 'escalate' &&
      (value.answer !== '' ||
        value.knowledgeReferences.length !== 0 ||
        !value.needsHumanReview ||
        value.reasonCode === 'published_knowledge_answer'))
  ) {
    return rejected('invalid_schema');
  }
  if (value.language !== context.requiredLanguage) return rejected('wrong_language');
  if (value.decision === 'escalate') {
    const reasonCode =
      value.reasonCode === 'human_review_required'
        ? 'human_review_required'
        : 'insufficient_published_knowledge';
    const envelope: ManifestDecisionEnvelope = Object.freeze({
      answer: '',
      decision: 'escalate',
      knowledgeReferences: Object.freeze([] as const),
      language: value.language,
      needsHumanReview: true,
      reasonCode,
    });
    return Object.freeze({ status: 'accepted', value: envelope });
  }
  if (!languageMatches(value.answer, context.requiredLanguage)) return rejected('wrong_language');

  const selected = referencedKnowledge(value.knowledgeReferences, context.knowledge);
  if (selected === undefined) return rejected('unsupported_reference');
  if (selected.length === 0) return rejected('unsupported_claim');
  try {
    const inspection = inspectSensitiveText(value.answer, value.language, {
      maximumInputCodePoints: Math.max(1, Array.from(value.answer).length),
    });
    if (inspection.status !== 'safe') return rejected('sensitive_output');
  } catch {
    return rejected('sensitive_output');
  }
  if (containsActionClaim(value.answer)) return rejected('action_claim');

  const allowedUrls = new Set(selected.flatMap((item) => [...item.approvedUrls]));
  if (extractUrls(value.answer).some((url) => !allowedUrls.has(url))) {
    return rejected('unapproved_url');
  }
  const selectedFacts = selected.map(({ fact }) => fact).join('\n');
  const allowedAssertions = protectedAssertions(selectedFacts);
  if ([...protectedAssertions(value.answer)].some((claim) => !allowedAssertions.has(claim))) {
    return rejected('unsupported_claim');
  }
  if (!hasLexicalSupport(value.answer, selectedFacts)) return rejected('unsupported_claim');

  return Object.freeze({
    status: 'accepted',
    value: Object.freeze({
      answer: value.answer,
      decision: 'answer',
      knowledgeReferences: Object.freeze([...value.knowledgeReferences]),
      language: value.language,
      needsHumanReview: false,
      reasonCode: 'published_knowledge_answer',
    }),
  });
}
