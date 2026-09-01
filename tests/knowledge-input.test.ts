import { describe, expect, test } from 'vitest';

import {
  parseKnowledgeProposal,
  parseKnowledgePublicationCommand,
  parseKnowledgeReviewCommand,
  parseKnowledgeSourceInput,
} from '../src/knowledge/knowledge-input.js';

const createdAt = new Date('2026-09-01T12:00:00.000Z');

function validFaqProposal(): Record<string, unknown> {
  return {
    aliases: [
      { language: 'en', kind: 'alias', phrase: 'Synthetic account help' },
      { language: 'bn', kind: 'example', phrase: 'সিনথেটিক অ্যাকাউন্ট সহায়তা' },
    ],
    answers: {
      en: 'Use the reviewed synthetic support process.',
      bn: 'পর্যালোচিত সিনথেটিক সহায়তা প্রক্রিয়া ব্যবহার করুন।',
    },
    applicability: 'Synthetic support catalog only',
    authorReference: 'ADMIN_TEST_editor',
    contentSha256: 'b'.repeat(64),
    createdAt,
    itemKey: 'faq.synthetic.account-help',
    kind: 'faq',
    questions: {
      en: 'How do I get synthetic account help?',
      bn: 'আমি কীভাবে সিনথেটিক অ্যাকাউন্ট সহায়তা পাব?',
    },
    requestKey: 'REQUEST_TEST_proposal',
    sourceRef: 'SOURCE_TEST_manual',
    sourceSha256: 'a'.repeat(64),
    tags: ['account-help', 'synthetic'],
    versionRef: 'VERSION_TEST_faq_1',
  };
}

describe('knowledge inputs', () => {
  test('parse a strict bilingual FAQ proposal', () => {
    const parsed = parseKnowledgeProposal(validFaqProposal());

    expect(parsed).toMatchObject({
      itemKey: 'faq.synthetic.account-help',
      kind: 'faq',
      questions: {
        en: 'How do I get synthetic account help?',
        bn: 'আমি কীভাবে সিনথেটিক অ্যাকাউন্ট সহায়তা পাব?',
      },
      tags: ['account-help', 'synthetic'],
    });
    expect(parsed.createdAt).toEqual(createdAt);
  });

  test('allow a bilingual business fact without FAQ questions', () => {
    const proposal = validFaqProposal();
    proposal.kind = 'business_fact';
    proposal.itemKey = 'fact.synthetic.support-hours';
    delete proposal.questions;

    const parsed = parseKnowledgeProposal(proposal);
    expect(parsed).toMatchObject({ kind: 'business_fact' });
    expect('questions' in parsed).toBe(false);
  });

  test('reject incomplete bilingual FAQ content', () => {
    const proposal = validFaqProposal();
    proposal.questions = { en: 'Synthetic English only?' };

    expect(() => parseKnowledgeProposal(proposal)).toThrow('Knowledge proposal is invalid');
  });

  test('reject unknown fields and unbounded collections', () => {
    const unknown = { ...validFaqProposal(), arbitraryPatch: '/answer/en' };
    const tooManyTags = {
      ...validFaqProposal(),
      tags: Array.from({ length: 33 }, (_, index) => `synthetic-${String(index)}`),
    };

    expect(() => parseKnowledgeProposal(unknown)).toThrow('Knowledge proposal is invalid');
    expect(() => parseKnowledgeProposal(tooManyTags)).toThrow('Knowledge proposal is invalid');
  });

  test('reject malformed provenance, request keys, and dates', () => {
    const badDigest = { ...validFaqProposal(), sourceSha256: 'not-a-digest' };
    const badRequest = { ...validFaqProposal(), requestKey: ' ' };
    const badDate = { ...validFaqProposal(), createdAt: new Date(Number.NaN) };

    expect(() => parseKnowledgeProposal(badDigest)).toThrow('Knowledge proposal is invalid');
    expect(() => parseKnowledgeProposal(badRequest)).toThrow('Knowledge proposal is invalid');
    expect(() => parseKnowledgeProposal(badDate)).toThrow('Knowledge proposal is invalid');
  });

  test('accept only HTTPS URLs for website sources', () => {
    const base = {
      createdAt,
      createdByReference: 'ADMIN_TEST_editor',
      label: 'Synthetic website source',
      sourceRef: 'SOURCE_TEST_website',
      sourceType: 'website',
    };

    expect(
      parseKnowledgeSourceInput({ ...base, approvedUrl: 'https://example.invalid/support' }),
    ).toMatchObject({ approvedUrl: 'https://example.invalid/support', sourceType: 'website' });
    expect(() =>
      parseKnowledgeSourceInput({ ...base, approvedUrl: 'http://example.invalid/support' }),
    ).toThrow('Knowledge source is invalid');
    expect(() => parseKnowledgeSourceInput({ ...base })).toThrow('Knowledge source is invalid');
    expect(() =>
      parseKnowledgeSourceInput({
        ...base,
        approvedUrl: 'https://example.invalid/support',
        sourceType: 'manual_business',
      }),
    ).toThrow('Knowledge source is invalid');
  });

  test('parse closed review commands and reject generic mutation input', () => {
    expect(
      parseKnowledgeReviewCommand({
        action: 'approve',
        effectiveAt: createdAt,
        reasonCode: 'business_fact_verified',
        requestKey: 'REQUEST_TEST_approve',
        reviewerReference: 'ADMIN_TEST_reviewer',
        versionRef: 'VERSION_TEST_faq_1',
      }),
    ).toMatchObject({ action: 'approve', reasonCode: 'business_fact_verified' });

    expect(() =>
      parseKnowledgeReviewCommand({
        action: 'approve',
        effectiveAt: createdAt,
        patch: { answer: 'Synthetic bypass' },
        reasonCode: 'business_fact_verified',
        requestKey: 'REQUEST_TEST_approve',
        reviewerReference: 'ADMIN_TEST_reviewer',
        versionRef: 'VERSION_TEST_faq_1',
      }),
    ).toThrow('Knowledge review command is invalid');
  });

  test('bind superseding publish and rollback to prior versions without inventing one for retire', () => {
    const base = {
      effectiveAt: createdAt,
      itemKey: 'faq.synthetic.account-help',
      reasonCode: 'reviewed_publication',
      requestKey: 'REQUEST_TEST_publish',
      reviewerReference: 'ADMIN_TEST_reviewer',
      versionRef: 'VERSION_TEST_faq_1',
    };

    expect(parseKnowledgePublicationCommand({ ...base, action: 'publish' })).toMatchObject({
      action: 'publish',
    });
    expect(
      parseKnowledgePublicationCommand({
        ...base,
        action: 'publish',
        priorVersionRef: 'VERSION_TEST_faq_0',
      }),
    ).toMatchObject({ action: 'publish', priorVersionRef: 'VERSION_TEST_faq_0' });
    expect(parseKnowledgePublicationCommand({ ...base, action: 'retire' })).toMatchObject({
      action: 'retire',
    });
    expect(() =>
      parseKnowledgePublicationCommand({
        ...base,
        action: 'retire',
        priorVersionRef: 'VERSION_TEST_faq_0',
      }),
    ).toThrow('Knowledge publication command is invalid');
    expect(() => parseKnowledgePublicationCommand({ ...base, action: 'rollback' })).toThrow(
      'Knowledge publication command is invalid',
    );
    expect(
      parseKnowledgePublicationCommand({
        ...base,
        action: 'rollback',
        priorVersionRef: 'VERSION_TEST_faq_2',
      }),
    ).toMatchObject({ action: 'rollback', priorVersionRef: 'VERSION_TEST_faq_2' });
  });
});
