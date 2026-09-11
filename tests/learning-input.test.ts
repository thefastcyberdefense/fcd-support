import { describe, expect, test } from 'vitest';
import {
  parseGapObservation,
  parseInsightRun,
  parseQuestionDigest,
  parseOwnerAnswer,
  parseLearningPolicy,
} from '../src/learning/learning-input.js';

const observedAt = new Date('2026-09-05T06:00:00.000Z');
const gap = {
  observationRef: 'OBSERVATION_TEST_gap',
  requestKey: 'REQUEST_TEST_gap',
  webhookEventId: '1',
  language: 'en',
  gapKind: 'faq_miss',
  observedAt,
  retentionDeadline: new Date('2026-10-01T06:00:00.000Z'),
};
const policy = {
  minimumGroupCount: 3,
  digestIntervalMilliseconds: 259200000,
  maximumQuestionsPerDigest: 5,
  questionCooldownMilliseconds: 604800000,
  maximumDigestAppearances: 2,
  maximumObservationsPerRun: 1000,
};

describe('closed learning inputs', () => {
  test('adds an empty bounded candidate set without inventing summary text', () => {
    expect(parseGapObservation(gap)).toEqual({ ...gap, candidateVersionRefs: [] });
  });
  test.each([
    { webhookEventId: 'PSID_TEST_external' },
    { webhookEventId: '9223372036854775808' },
    { language: 'fr' },
    { gapKind: 'unrestricted' },
    { observedAt: new Date('invalid') },
    { retentionDeadline: observedAt },
    { candidateVersionRefs: Array.from({ length: 9 }, (_, i) => 'VERSION_TEST_' + String(i)) },
    { candidateVersionRefs: ['VERSION_TEST_1', 'VERSION_TEST_1'] },
    {
      sanitizedSummary:
        'Synthetic customer text must not become a summary merely by naming it sanitized.',
    },
    { sanitizedSummary: 'synthetic_token_do_not_retain' },
    { rawMessage: 'SYNTHETIC_PRIVATE_MARKER' },
    { authorization: 'synthetic_secret' },
    { contactId: 'PSID_TEST_external' },
    { rawPayload: {} },
    { tools: [] },
    {
      candidateVersionRefs: [
        { versionRef: 'VERSION_TEST_1', rawMessage: 'SYNTHETIC_PRIVATE_MARKER' },
      ],
    },
  ])('rejects unsafe or ambiguous observation shape %#', (override) => {
    expect(() => parseGapObservation({ ...gap, ...override })).toThrow(
      'Learning observation is invalid',
    );
  });
  test('accepts only the closed non-customer summary matching the gap category', () => {
    expect(
      parseGapObservation({ ...gap, sanitizedSummary: 'No reviewed FAQ matched.' }),
    ).toMatchObject({ sanitizedSummary: 'No reviewed FAQ matched.' });
    expect(() =>
      parseGapObservation({
        ...gap,
        gapKind: 'escalation',
        sanitizedSummary: 'No reviewed FAQ matched.',
      }),
    ).toThrow();
  });
  test('does not expose input values in validation errors', () => {
    try {
      parseGapObservation({ ...gap, rawMessage: 'SYNTHETIC_PRIVATE_MARKER' });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
      expect(String(error)).toContain('Learning observation is invalid');
    }
  });
  test('requires bounded reporting windows and reference-only digest commands', () => {
    const run = {
      runRef: 'RUN_TEST_learning',
      requestKey: 'REQUEST_TEST_run',
      windowStartedAt: observedAt,
      windowEndedAt: new Date('2026-09-06T06:00:00.000Z'),
    };
    expect(parseInsightRun(run)).toEqual(run);
    expect(() => parseInsightRun({ ...run, windowEndedAt: observedAt })).toThrow();
    expect(() => parseInsightRun({ ...run, minimumGroupCount: 1 })).toThrow();
    expect(
      parseQuestionDigest({ digestRef: 'DIGEST_TEST_learning', requestKey: 'REQUEST_TEST_digest' }),
    ).toEqual({ digestRef: 'DIGEST_TEST_learning', requestKey: 'REQUEST_TEST_digest' });
    expect(() =>
      parseQuestionDigest({
        digestRef: 'DIGEST_TEST_learning',
        requestKey: 'REQUEST_TEST_digest',
        questions: ['Synthetic arbitrary question'],
      }),
    ).toThrow();
  });
  test('accepts a bounded bilingual owner answer, never a publication command', () => {
    const answer = {
      questionRef: 'QUESTION_TEST_learning',
      requestKey: 'REQUEST_TEST_answer',
      answeredAt: observedAt,
      answerText: 'Synthetic reviewed owner answer.',
      answerBn: 'সিনথেটিক মালিকের উত্তর।',
    };
    expect(parseOwnerAnswer(answer)).toEqual(answer);
    for (const override of [
      { answerBn: '' },
      { answerText: 'x'.repeat(4001) },
      { publish: true },
      { state: 'approved' },
      { reviewerReference: 'ADMIN_TEST_forged' },
      { rawMessage: 'SYNTHETIC_PRIVATE_MARKER' },
    ]) {
      expect(() => parseOwnerAnswer({ ...answer, ...override })).toThrow('Owner answer is invalid');
    }
  });
  test('requires explicit operational policy and accepts non-default settings', () => {
    expect(parseLearningPolicy(policy)).toEqual(policy);
    expect(
      parseLearningPolicy({
        ...policy,
        minimumGroupCount: 5,
        maximumQuestionsPerDigest: 2,
        digestIntervalMilliseconds: 604800000,
        questionCooldownMilliseconds: 1209600000,
      }),
    ).toMatchObject({
      minimumGroupCount: 5,
      maximumQuestionsPerDigest: 2,
      digestIntervalMilliseconds: 604800000,
    });
    expect(() => parseLearningPolicy({})).toThrow();
  });
  test.each([
    { minimumGroupCount: 1 },
    { maximumQuestionsPerDigest: 6 },
    { maximumQuestionsPerDigest: 0 },
    { digestIntervalMilliseconds: 0 },
    { digestIntervalMilliseconds: 60000 },
    { digestIntervalMilliseconds: 86400000 },
    { digestIntervalMilliseconds: 259199999 },
    { questionCooldownMilliseconds: 1 },
    { maximumDigestAppearances: 0 },
    { maximumObservationsPerRun: 0 },
    { minimumGroupCount: NaN },
    { maximumObservationsPerRun: 2 },
    { maximumDigestAppearances: 1.5 },
  ])('rejects unsafe operational policy %#', (override) => {
    expect(() => parseLearningPolicy({ ...policy, ...override })).toThrow(
      'Learning policy is invalid',
    );
  });
});
