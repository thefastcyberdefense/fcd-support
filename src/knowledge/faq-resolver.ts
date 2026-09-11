import { normalizeFaqText } from './faq-normalization.js';
import type { KnowledgeAliasInput, KnowledgeLanguage } from './knowledge-types.js';
import { isIssuedSensitiveTextInspection } from '../safety/sensitive-data-gate.js';
import type { SensitiveTextInspection } from '../safety/sensitive-data-types.js';

export interface PreparedFaqResolutionText {
  readonly language: KnowledgeLanguage;
  readonly normalizedText: string;
}

const preparedFaqTexts = new WeakSet<object>();

export function prepareFaqResolutionText(
  inspection: SensitiveTextInspection,
): PreparedFaqResolutionText {
  if (!isIssuedSensitiveTextInspection(inspection)) {
    throw new TypeError('Sensitive-data inspection provenance is invalid');
  }
  if (inspection.status === 'blocked') {
    throw new TypeError('Blocked sensitive text cannot enter FAQ resolution');
  }
  const prepared = Object.freeze({
    language: inspection.language,
    normalizedText: normalizeFaqText(inspection.sanitizedText),
  });
  preparedFaqTexts.add(prepared);
  return prepared;
}

export function readPreparedFaqResolutionText(input: unknown): PreparedFaqResolutionText {
  if (typeof input !== 'object' || input === null || !preparedFaqTexts.has(input)) {
    throw new TypeError('Prepared FAQ text is invalid');
  }
  return input as PreparedFaqResolutionText;
}

export type FaqMatchKind =
  'exact_alias' | 'exact_example' | 'exact_intent' | 'exact_question' | 'trigram_similarity';

export interface FaqResolutionPolicy {
  readonly ambiguityMargin: number;
  readonly maximumCandidates: number;
  readonly minimumSimilarity: number;
}

export interface FaqCandidate {
  readonly aliasKind: KnowledgeAliasInput['kind'] | 'question';
  readonly answer: string;
  readonly itemReference: string;
  readonly language: KnowledgeLanguage;
  readonly normalizedPhrase: string;
  readonly similarity: number;
  readonly versionReference: string;
}

export type FaqResolution =
  | {
      readonly answer: string;
      readonly itemReference: string;
      readonly language: KnowledgeLanguage;
      readonly matchKind: FaqMatchKind;
      readonly status: 'match';
      readonly versionReference: string;
    }
  | {
      readonly reasonCode: 'multiple_exact_matches' | 'similarity_margin';
      readonly status: 'ambiguous';
    }
  | {
      readonly reasonCode: 'below_threshold' | 'no_candidates';
      readonly status: 'miss';
    };

const aliasPriority: Readonly<Record<FaqCandidate['aliasKind'], number>> = Object.freeze({
  question: 0,
  alias: 1,
  example: 2,
  intent: 3,
});

const exactKind: Readonly<Record<FaqCandidate['aliasKind'], FaqMatchKind>> = Object.freeze({
  question: 'exact_question',
  alias: 'exact_alias',
  example: 'exact_example',
  intent: 'exact_intent',
});

const opaqueReference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validatePolicy(policy: FaqResolutionPolicy): void {
  if (
    !Number.isFinite(policy.minimumSimilarity) ||
    policy.minimumSimilarity <= 0 ||
    policy.minimumSimilarity > 1 ||
    !Number.isFinite(policy.ambiguityMargin) ||
    policy.ambiguityMargin < 0 ||
    policy.ambiguityMargin >= policy.minimumSimilarity ||
    !Number.isSafeInteger(policy.maximumCandidates) ||
    policy.maximumCandidates < 2 ||
    policy.maximumCandidates > 100
  ) {
    throw new TypeError('FAQ resolution policy is invalid');
  }
}

function validateInput(normalizedInput: string): void {
  try {
    if (normalizeFaqText(normalizedInput) !== normalizedInput) throw new Error('not normalized');
  } catch {
    throw new TypeError('FAQ resolution input is invalid');
  }
}

function validateCandidate(candidate: FaqCandidate, language: KnowledgeLanguage): void {
  try {
    if (
      candidate.language !== language ||
      !opaqueReference.test(candidate.itemReference) ||
      !opaqueReference.test(candidate.versionReference) ||
      !Number.isFinite(candidate.similarity) ||
      candidate.similarity < 0 ||
      candidate.similarity > 1 ||
      candidate.answer.trim().length === 0 ||
      Array.from(candidate.answer).length > 4000 ||
      normalizeFaqText(candidate.normalizedPhrase) !== candidate.normalizedPhrase
    ) {
      throw new Error('invalid candidate');
    }
  } catch {
    throw new TypeError('FAQ candidate is invalid');
  }
}

function compareCandidatePreference(
  left: FaqCandidate,
  right: FaqCandidate,
  normalizedInput: string,
): number {
  const leftExact = left.normalizedPhrase === normalizedInput;
  const rightExact = right.normalizedPhrase === normalizedInput;
  if (leftExact !== rightExact) return leftExact ? -1 : 1;
  if (left.similarity !== right.similarity) return right.similarity - left.similarity;
  const priority = aliasPriority[left.aliasKind] - aliasPriority[right.aliasKind];
  if (priority !== 0) return priority;
  return left.normalizedPhrase.localeCompare(right.normalizedPhrase, 'en-US');
}

function collapseVersionCandidates(
  candidates: readonly FaqCandidate[],
  normalizedInput: string,
): readonly FaqCandidate[] {
  const byVersion = new Map<string, FaqCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.itemReference}\u0000${candidate.versionReference}`;
    const current = byVersion.get(key);
    if (
      current === undefined ||
      compareCandidatePreference(candidate, current, normalizedInput) < 0
    ) {
      byVersion.set(key, candidate);
    }
  }
  return [...byVersion.values()];
}

function match(candidate: FaqCandidate, matchKind: FaqMatchKind): FaqResolution {
  return Object.freeze({
    status: 'match',
    answer: candidate.answer,
    itemReference: candidate.itemReference,
    language: candidate.language,
    matchKind,
    versionReference: candidate.versionReference,
  });
}

export function decideFaqResolution(
  normalizedInput: string,
  language: KnowledgeLanguage,
  candidates: readonly FaqCandidate[],
  policy: FaqResolutionPolicy,
): FaqResolution {
  validateInput(normalizedInput);
  validatePolicy(policy);
  if (candidates.length > policy.maximumCandidates) {
    throw new TypeError('FAQ candidate set exceeds policy');
  }
  for (const candidate of candidates) validateCandidate(candidate, language);

  const unique = collapseVersionCandidates(candidates, normalizedInput);
  const exact = unique
    .filter(({ normalizedPhrase }) => normalizedPhrase === normalizedInput)
    .sort((left, right) => compareCandidatePreference(left, right, normalizedInput));
  if (exact.length > 1) {
    return Object.freeze({ status: 'ambiguous', reasonCode: 'multiple_exact_matches' });
  }
  const exactCandidate = exact[0];
  if (exactCandidate !== undefined) {
    return match(exactCandidate, exactKind[exactCandidate.aliasKind]);
  }

  const ranked = [...unique].sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.itemReference.localeCompare(right.itemReference, 'en-US') ||
      left.versionReference.localeCompare(right.versionReference, 'en-US') ||
      aliasPriority[left.aliasKind] - aliasPriority[right.aliasKind] ||
      left.normalizedPhrase.localeCompare(right.normalizedPhrase, 'en-US'),
  );
  const best = ranked[0];
  if (best === undefined) return Object.freeze({ status: 'miss', reasonCode: 'no_candidates' });
  if (best.similarity < policy.minimumSimilarity) {
    return Object.freeze({ status: 'miss', reasonCode: 'below_threshold' });
  }

  const second = ranked[1];
  if (
    second !== undefined &&
    (best.similarity === second.similarity ||
      best.similarity - second.similarity < policy.ambiguityMargin)
  ) {
    return Object.freeze({ status: 'ambiguous', reasonCode: 'similarity_margin' });
  }
  return match(best, 'trigram_similarity');
}
