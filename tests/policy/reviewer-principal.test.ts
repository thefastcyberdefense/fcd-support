import { describe, expect, test } from 'vitest';

import { requirePolicyOwner, requireSupportReviewer } from '../../src/policy/reviewer-principal.js';

describe('support reviewer principal validation', () => {
  test('accepts a trimmed opaque reviewer reference with the support reviewer role', () => {
    expect(
      requireSupportReviewer({
        reviewerRef: '  reviewer-42  ',
        roles: ['incident_reader', 'support_reviewer'],
      }),
    ).toEqual({
      reviewerRef: 'reviewer-42',
      roles: ['incident_reader', 'support_reviewer'],
    });
  });

  test.each([
    ['a missing reviewer role', { reviewerRef: 'reviewer-42', roles: ['incident_reader'] }],
    ['a blank reviewer reference', { reviewerRef: '   ', roles: ['support_reviewer'] }],
    [
      'a reviewer reference over 128 characters',
      { reviewerRef: 'a'.repeat(129), roles: ['support_reviewer'] },
    ],
    [
      'more than 16 roles',
      {
        reviewerRef: 'reviewer-42',
        roles: Array.from({ length: 17 }, (_, index) => `role-${String(index)}`),
      },
    ],
    ['a blank role', { reviewerRef: 'reviewer-42', roles: ['support_reviewer', '  '] }],
    [
      'an unknown object field',
      { reviewerRef: 'reviewer-42', roles: ['support_reviewer'], authorization: 'synthetic-value' },
    ],
  ])('rejects %s', (reason, input) => {
    if (reason === 'a missing reviewer role') {
      expect(() => requireSupportReviewer(input)).toThrow('Support reviewer role required');
      return;
    }

    expect(() => requireSupportReviewer(input)).toThrow();
  });

  test('does not accept or return credential-shaped principal fields', () => {
    const principal = requireSupportReviewer({
      reviewerRef: 'reviewer-42',
      roles: ['support_reviewer'],
    });

    expect(principal).not.toHaveProperty('authorization');
    expect(principal).not.toHaveProperty('token');
    expect(principal).not.toHaveProperty('credential');
    expect(() =>
      requireSupportReviewer({
        reviewerRef: 'reviewer-42',
        roles: ['support_reviewer'],
        token: 'synthetic-value',
      }),
    ).toThrow();
  });
});

describe('policy owner principal validation', () => {
  test('accepts a trimmed opaque reviewer reference with the policy owner role', () => {
    expect(
      requirePolicyOwner({
        reviewerRef: '  policy-owner-42  ',
        roles: ['support_reviewer', 'policy_owner'],
      }),
    ).toEqual({
      reviewerRef: 'policy-owner-42',
      roles: ['support_reviewer', 'policy_owner'],
    });
  });

  test('rejects a valid support reviewer without the policy owner role', () => {
    expect(() =>
      requirePolicyOwner({ reviewerRef: 'reviewer-42', roles: ['support_reviewer'] }),
    ).toThrow('Policy owner role required');
  });

  test('does not accept or return credential-shaped policy owner fields', () => {
    const principal = requirePolicyOwner({
      reviewerRef: 'policy-owner-42',
      roles: ['policy_owner'],
    });

    expect(principal).not.toHaveProperty('authorization');
    expect(principal).not.toHaveProperty('token');
    expect(principal).not.toHaveProperty('credential');
    expect(() =>
      requirePolicyOwner({
        reviewerRef: 'policy-owner-42',
        roles: ['policy_owner'],
        token: 'synthetic_rejected',
      }),
    ).toThrow();
  });
});
