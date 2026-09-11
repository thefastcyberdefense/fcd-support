import { describe, expect, test } from 'vitest';

import {
  decideFaqResolution,
  prepareFaqResolutionText,
  readPreparedFaqResolutionText,
  type FaqCandidate,
  type FaqResolutionPolicy,
} from '../src/knowledge/faq-resolver.js';
import { inspectSensitiveText } from '../src/safety/sensitive-data-gate.js';

const policy = {
  ambiguityMargin: 0.05,
  maximumCandidates: 10,
  minimumSimilarity: 0.7,
} satisfies FaqResolutionPolicy;

function candidate(overrides: Partial<FaqCandidate> = {}): FaqCandidate {
  return {
    aliasKind: 'question',
    answer: 'Synthetic reviewed answer.',
    itemReference: 'faq.synthetic.primary',
    language: 'en',
    normalizedPhrase: 'how do i open a support request',
    similarity: 0.82,
    versionReference: 'VERSION_TEST_faq_primary_1',
    ...overrides,
  };
}

describe('FAQ resolution decision', () => {
  test('issue opaque normalized text only from a successful sensitive-data inspection', () => {
    const safe = inspectSensitiveText('How do I open a synthetic support request?', 'en', {
      maximumInputCodePoints: 200,
    });
    const prepared = prepareFaqResolutionText(safe);

    expect(readPreparedFaqResolutionText(prepared)).toEqual({
      language: 'en',
      normalizedText: 'how do i open a synthetic support request',
    });
    const redacted = prepareFaqResolutionText(
      inspectSensitiveText('How can I sign in? OTP: 123456', 'en', {
        maximumInputCodePoints: 200,
      }),
    );
    expect(JSON.stringify(readPreparedFaqResolutionText(redacted))).not.toContain('123456');
    expect(() =>
      prepareFaqResolutionText(
        inspectSensitiveText('OTP: 123456', 'en', { maximumInputCodePoints: 200 }),
      ),
    ).toThrow('Blocked sensitive text cannot enter FAQ resolution');
    expect(() =>
      readPreparedFaqResolutionText({
        language: 'en',
        normalizedText: 'forged normalized text',
      }),
    ).toThrow('Prepared FAQ text is invalid');
    expect(() =>
      prepareFaqResolutionText({
        status: 'safe',
        language: 'en',
        reasonCode: 'no_sensitive_data',
        categories: [],
        markers: [],
        sanitizedText: 'forged gate bypass',
      }),
    ).toThrow('Sensitive-data inspection provenance is invalid');
  });

  test('give one exact question priority over stronger fuzzy candidates', () => {
    const result = decideFaqResolution(
      'how do i open a support request',
      'en',
      [
        candidate({ similarity: 0.71 }),
        candidate({
          aliasKind: 'alias',
          itemReference: 'faq.synthetic.other',
          normalizedPhrase: 'how can i open a support ticket',
          similarity: 0.99,
          versionReference: 'VERSION_TEST_faq_other_1',
        }),
      ],
      policy,
    );

    expect(result).toEqual({
      status: 'match',
      answer: 'Synthetic reviewed answer.',
      itemReference: 'faq.synthetic.primary',
      language: 'en',
      matchKind: 'exact_question',
      versionReference: 'VERSION_TEST_faq_primary_1',
    });
  });

  test.each([
    ['alias', 'exact_alias'],
    ['example', 'exact_example'],
    ['intent', 'exact_intent'],
  ] as const)('return the closed %s match kind', (aliasKind, matchKind) => {
    expect(
      decideFaqResolution(
        'synthetic exact phrase',
        'en',
        [candidate({ aliasKind, normalizedPhrase: 'synthetic exact phrase', similarity: 1 })],
        policy,
      ),
    ).toMatchObject({ status: 'match', matchKind });
  });

  test('select one strong similarity candidate above the supplied threshold', () => {
    expect(
      decideFaqResolution(
        'open support request',
        'en',
        [candidate({ normalizedPhrase: 'open a support request', similarity: 0.84 })],
        policy,
      ),
    ).toEqual({
      status: 'match',
      answer: 'Synthetic reviewed answer.',
      itemReference: 'faq.synthetic.primary',
      language: 'en',
      matchKind: 'trigram_similarity',
      versionReference: 'VERSION_TEST_faq_primary_1',
    });
  });

  test('return ambiguity when the top two versions are inside the supplied margin', () => {
    expect(
      decideFaqResolution(
        'open support request',
        'en',
        [
          candidate({ normalizedPhrase: 'open a support request', similarity: 0.84 }),
          candidate({
            itemReference: 'faq.synthetic.secondary',
            normalizedPhrase: 'start a support request',
            similarity: 0.8,
            versionReference: 'VERSION_TEST_faq_secondary_1',
          }),
        ],
        policy,
      ),
    ).toEqual({ status: 'ambiguous', reasonCode: 'similarity_margin' });
  });

  test('return a miss when the best candidate is below the supplied threshold', () => {
    expect(
      decideFaqResolution(
        'unrelated synthetic request',
        'en',
        [candidate({ similarity: 0.69 })],
        policy,
      ),
    ).toEqual({ status: 'miss', reasonCode: 'below_threshold' });
  });

  test('return a closed miss for an empty candidate set', () => {
    expect(decideFaqResolution('synthetic missing faq', 'en', [], policy)).toEqual({
      status: 'miss',
      reasonCode: 'no_candidates',
    });
  });

  test('select the exact stored Bangla answer and language', () => {
    expect(
      decideFaqResolution(
        'আমি কীভাবে সহায়তা চাইব',
        'bn',
        [
          candidate({
            answer: 'সিনথেটিক পর্যালোচিত উত্তর।',
            language: 'bn',
            normalizedPhrase: 'আমি কীভাবে সহায়তা চাইব',
            similarity: 1,
          }),
        ],
        policy,
      ),
    ).toMatchObject({
      status: 'match',
      answer: 'সিনথেটিক পর্যালোচিত উত্তর।',
      language: 'bn',
      matchKind: 'exact_question',
    });
  });

  test('collapse duplicate aliases for one version and prefer its exact question', () => {
    const result = decideFaqResolution(
      'synthetic exact phrase',
      'en',
      [
        candidate({
          aliasKind: 'intent',
          normalizedPhrase: 'synthetic exact phrase',
          similarity: 1,
        }),
        candidate({
          aliasKind: 'question',
          normalizedPhrase: 'synthetic exact phrase',
          similarity: 1,
        }),
      ],
      policy,
    );

    expect(result).toMatchObject({ status: 'match', matchKind: 'exact_question' });
  });

  test('produce the same closed ambiguity for deterministic score ties in any input order', () => {
    const left = candidate({
      itemReference: 'faq.synthetic.a',
      normalizedPhrase: 'synthetic answer a',
      similarity: 0.9,
      versionReference: 'VERSION_TEST_faq_a_1',
    });
    const right = candidate({
      itemReference: 'faq.synthetic.b',
      normalizedPhrase: 'synthetic answer b',
      similarity: 0.9,
      versionReference: 'VERSION_TEST_faq_b_1',
    });

    expect(decideFaqResolution('synthetic answer', 'en', [left, right], policy)).toEqual(
      decideFaqResolution('synthetic answer', 'en', [right, left], policy),
    );
    expect(decideFaqResolution('synthetic answer', 'en', [left, right], policy)).toEqual({
      status: 'ambiguous',
      reasonCode: 'similarity_margin',
    });
    expect(
      decideFaqResolution('synthetic answer', 'en', [left, right], {
        ...policy,
        ambiguityMargin: 0,
      }),
    ).toEqual({ status: 'ambiguous', reasonCode: 'similarity_margin' });
  });

  test('reject non-normalized input, invalid policy, and unbounded candidate sets', () => {
    expect(() => decideFaqResolution('Synthetic Question?', 'en', [], policy)).toThrow(
      'FAQ resolution input is invalid',
    );
    expect(() =>
      decideFaqResolution('synthetic question', 'en', [], {
        ...policy,
        ambiguityMargin: 0.8,
        minimumSimilarity: 0.7,
      }),
    ).toThrow('FAQ resolution policy is invalid');
    expect(() =>
      decideFaqResolution(
        'synthetic question',
        'en',
        Array.from({ length: 11 }, (_, index) =>
          candidate({ versionReference: `VERSION_TEST_bound_${String(index)}` }),
        ),
        policy,
      ),
    ).toThrow('FAQ candidate set exceeds policy');
  });
});
