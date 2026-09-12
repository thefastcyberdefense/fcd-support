import { describe, expect, test } from 'vitest';

import { parseManifestOutput } from '../src/model/manifest-output.js';

const context = Object.freeze({
  knowledge: [
    {
      approvedUrls: ['https://support.example.invalid/plans'],
      fact: 'The reviewed synthetic plan costs 100 BDT.',
      reference: 'VERSION_TEST_manifest_plan',
    },
  ],
  maximumResponseBytes: 4096,
  requiredLanguage: 'en' as const,
});

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answer: 'The reviewed synthetic plan costs 100 BDT.',
    decision: 'answer',
    knowledgeReferences: ['VERSION_TEST_manifest_plan'],
    language: 'en',
    needsHumanReview: false,
    reasonCode: 'published_knowledge_answer',
    ...overrides,
  });
}

describe('Manifest structured output validation', () => {
  test('accepts a grounded answer and a content-free escalation envelope', () => {
    expect(parseManifestOutput(output(), context)).toEqual({
      status: 'accepted',
      value: {
        answer: 'The reviewed synthetic plan costs 100 BDT.',
        decision: 'answer',
        knowledgeReferences: ['VERSION_TEST_manifest_plan'],
        language: 'en',
        needsHumanReview: false,
        reasonCode: 'published_knowledge_answer',
      },
    });
    expect(
      parseManifestOutput(
        output({
          answer: '',
          decision: 'escalate',
          knowledgeReferences: [],
          needsHumanReview: true,
          reasonCode: 'insufficient_published_knowledge',
        }),
        context,
      ),
    ).toEqual({
      status: 'accepted',
      value: {
        answer: '',
        decision: 'escalate',
        knowledgeReferences: [],
        language: 'en',
        needsHumanReview: true,
        reasonCode: 'insufficient_published_knowledge',
      },
    });
  });

  test.each([
    ['malformed_json', '{not-json'],
    ['invalid_schema', output({ unexpected: 'field' })],
    ['invalid_schema', output({ needsHumanReview: 'false' })],
    ['invalid_schema', output({ reasonCode: 'unbounded_reason' })],
  ])('returns only closed %s evidence for invalid data', (reasonCode, raw) => {
    const result = parseManifestOutput(raw, context);
    expect(result).toEqual({ status: 'rejected', reasonCode });
    expect(Object.keys(result).sort()).toEqual(['reasonCode', 'status']);
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  test('rejects unsupported and duplicate knowledge references', () => {
    expect(
      parseManifestOutput(output({ knowledgeReferences: ['VERSION_TEST_unknown'] }), context),
    ).toEqual({ status: 'rejected', reasonCode: 'unsupported_reference' });
    expect(
      parseManifestOutput(
        output({
          knowledgeReferences: ['VERSION_TEST_manifest_plan', 'VERSION_TEST_manifest_plan'],
        }),
        context,
      ),
    ).toEqual({ status: 'rejected', reasonCode: 'invalid_schema' });
  });

  test('rejects answer envelopes without support and unsupported numeric business claims', () => {
    expect(parseManifestOutput(output({ knowledgeReferences: [] }), context)).toEqual({
      status: 'rejected',
      reasonCode: 'unsupported_claim',
    });
    expect(
      parseManifestOutput(
        output({ answer: 'The reviewed synthetic plan costs 999 BDT.' }),
        context,
      ),
    ).toEqual({ status: 'rejected', reasonCode: 'unsupported_claim' });
  });

  test.each([
    'The synthetic service includes a guaranteed refund.',
    'The reviewed synthetic plan does not cost 100 BDT.',
    'The reviewed synthetic plan costs 100 BDT and includes a guaranteed refund.',
  ])('rejects unrelated or contradictory prose despite a valid reference: %s', (answer) => {
    expect(parseManifestOutput(output({ answer }), context)).toEqual({
      status: 'rejected',
      reasonCode: 'unsupported_claim',
    });
  });

  test('rejects wrong-language output', () => {
    expect(
      parseManifestOutput(output({ answer: 'সিনথেটিক উত্তর।', language: 'bn' }), context),
    ).toEqual({ status: 'rejected', reasonCode: 'wrong_language' });
  });

  test('accepts a grounded Bangla answer and rejects English-only text for Bangla', () => {
    const banglaContext = {
      knowledge: [
        {
          approvedUrls: [],
          fact: 'সিনথেটিক সহায়তা পরিকল্পনার মূল্য ১০০ টাকা।',
          reference: 'VERSION_TEST_manifest_plan_bn',
        },
      ],
      maximumResponseBytes: 4096,
      requiredLanguage: 'bn',
    } as const;
    const banglaOutput = JSON.stringify({
      answer: 'সিনথেটিক সহায়তা পরিকল্পনার মূল্য ১০০ টাকা।',
      decision: 'answer',
      knowledgeReferences: ['VERSION_TEST_manifest_plan_bn'],
      language: 'bn',
      needsHumanReview: false,
      reasonCode: 'published_knowledge_answer',
    });
    expect(parseManifestOutput(banglaOutput, banglaContext)).toMatchObject({
      status: 'accepted',
    });
    expect(
      parseManifestOutput(
        JSON.stringify({
          answer: 'Synthetic support plan.',
          decision: 'answer',
          knowledgeReferences: ['VERSION_TEST_manifest_plan_bn'],
          language: 'bn',
          needsHumanReview: false,
          reasonCode: 'published_knowledge_answer',
        }),
        banglaContext,
      ),
    ).toEqual({ status: 'rejected', reasonCode: 'wrong_language' });
  });

  test('rejects secret-shaped output without returning it', () => {
    const sensitiveValue = '123456';
    const result = parseManifestOutput(
      output({ answer: `Use OTP: ${sensitiveValue} to access the synthetic portal.` }),
      context,
    );
    expect(result).toEqual({ status: 'rejected', reasonCode: 'sensitive_output' });
    expect(JSON.stringify(result)).not.toContain(sensitiveValue);
  });

  test('allows only URLs present in referenced published knowledge', () => {
    expect(
      parseManifestOutput(
        output({
          answer: 'Use https://support.example.invalid/plans for the reviewed synthetic plan.',
        }),
        context,
      ),
    ).toMatchObject({ status: 'accepted' });
    expect(
      parseManifestOutput(
        output({ answer: 'Use https://unapproved.example.invalid/path for help.' }),
        context,
      ),
    ).toEqual({ status: 'rejected', reasonCode: 'unapproved_url' });
  });

  test.each([
    'I have reset your synthetic account.',
    'I used a tool to change the synthetic account.',
  ])('rejects tool or external-action claim: %s', (answer) => {
    expect(parseManifestOutput(output({ answer }), context)).toEqual({
      status: 'rejected',
      reasonCode: 'action_claim',
    });
  });

  test('rejects response bytes before JSON parsing', () => {
    const result = parseManifestOutput(output({ answer: 'x'.repeat(5000) }), context);
    expect(result).toEqual({ status: 'rejected', reasonCode: 'oversized_output' });
  });

  test('rejects inconsistent answer/escalation state combinations', () => {
    const cases = [
      output({ needsHumanReview: true }),
      output({ decision: 'escalate' }),
      output({ answer: '', decision: 'answer' }),
      output({
        answer: '',
        decision: 'escalate',
        knowledgeReferences: [],
        needsHumanReview: true,
        reasonCode: 'published_knowledge_answer',
      }),
    ];
    for (const raw of cases) {
      expect(parseManifestOutput(raw, context)).toEqual({
        status: 'rejected',
        reasonCode: 'invalid_schema',
      });
    }
  });
});
