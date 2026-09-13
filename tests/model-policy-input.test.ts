import { describe, expect, test } from 'vitest';

import {
  parseModelPolicyCreateInput,
  parseModelPolicyTransitionInput,
} from '../src/model/model-policy-input.js';

const values = Object.freeze({
  approvedProviderAttempts: 3,
  architectureProviderCeiling: 5,
  concurrentCalls: 4,
  cooldownMs: 1000,
  faqAmbiguityMargin: 0.05,
  faqMinimumSimilarity: 0.7,
  globalUtcDayCalls: 300,
  maximumFaqCandidates: 10,
  outputTokens: 600,
  perContact15MinuteCalls: 3,
  perContact24HourCalls: 20,
  queueCapacity: 25,
  totalTimeoutMs: 20_000,
});

describe('model policy input', () => {
  test('accepts a complete explicit policy and preserves customized values', () => {
    const parsed = parseModelPolicyCreateInput({
      createdAt: new Date('2026-09-13T02:00:00Z'),
      createdByAccountRef: 'ADMIN_TEST_policy_owner',
      policyRef: 'POLICY_TEST_custom',
      requestKey: 'REQUEST_TEST_policy_custom',
      values: {
        ...values,
        concurrentCalls: 7,
        cooldownMs: 4321,
        outputTokens: 777,
        queueCapacity: 19,
        totalTimeoutMs: 12_345,
      },
    });

    expect(parsed.values).toMatchObject({
      concurrentCalls: 7,
      cooldownMs: 4321,
      outputTokens: 777,
      queueCapacity: 19,
      totalTimeoutMs: 12_345,
    });
  });

  test('has no implicit policy defaults', () => {
    expect(() =>
      parseModelPolicyCreateInput({
        createdAt: new Date('2026-09-13T02:00:00Z'),
        createdByAccountRef: 'ADMIN_TEST_policy_owner',
        policyRef: 'POLICY_TEST_missing',
        requestKey: 'REQUEST_TEST_policy_missing',
        values: {},
      }),
    ).toThrow('Model policy input is invalid');
  });

  test.each([
    { ...values, perContact15MinuteCalls: 21 },
    { ...values, perContact24HourCalls: 301 },
    { ...values, approvedProviderAttempts: 5, architectureProviderCeiling: 4 },
    { ...values, faqAmbiguityMargin: 0.7 },
    { ...values, totalTimeoutMs: 0 },
    { ...values, queueCapacity: -1 },
  ])('rejects unsafe or contradictory values', (invalidValues) => {
    expect(() =>
      parseModelPolicyCreateInput({
        createdAt: new Date('2026-09-13T02:00:00Z'),
        createdByAccountRef: 'ADMIN_TEST_policy_owner',
        policyRef: 'POLICY_TEST_invalid',
        requestKey: 'REQUEST_TEST_policy_invalid',
        values: invalidValues,
      }),
    ).toThrow('Model policy input is invalid');
  });

  test('accepts only closed transition actions and bounded reasons', () => {
    expect(
      parseModelPolicyTransitionInput({
        action: 'activate',
        effectiveAt: new Date('2026-09-13T03:00:00Z'),
        policyRef: 'POLICY_TEST_custom',
        reasonCode: 'approved_activation',
        requestKey: 'REQUEST_TEST_policy_activate',
        reviewerAccountRef: 'ADMIN_TEST_policy_owner',
      }),
    ).toMatchObject({ action: 'activate', reasonCode: 'approved_activation' });
    expect(() =>
      parseModelPolicyTransitionInput({
        action: 'publish',
        effectiveAt: new Date('2026-09-13T03:00:00Z'),
        policyRef: 'POLICY_TEST_custom',
        reasonCode: 'unsafe',
        requestKey: 'REQUEST_TEST_policy_publish',
        reviewerAccountRef: 'ADMIN_TEST_policy_owner',
      }),
    ).toThrow('Model policy transition is invalid');
  });
});
