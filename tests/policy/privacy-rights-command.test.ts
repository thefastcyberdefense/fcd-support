import { describe, expect, test } from 'vitest';

import {
  parseAttestPrivacyLocationInput,
  parseCollectAccessDataInput,
  parseExecuteCorrectionInput,
  parseExplicitMarketingReoptInInput,
  parseMarketingOptOutInput,
  parseProcessPrivacyIntentInput,
  parseReviewPrivacyRequestInput,
} from '../../src/policy/privacy-rights-command.js';

const syntheticIdentity = {
  channel: 'whatsapp',
  channelAccountId: 'ACCOUNT_TEST_privacy_rights',
  externalContactId: 'CONTACT_TEST_privacy_rights',
} as const;
const effectiveAt = new Date('2026-08-31T04:00:00.000Z');

describe('privacy intent processing command', () => {
  const valid = {
    requestKey: 'privacy-intake-test-a',
    sourceWebhookEventId: '101',
  };

  test('accepts bounded processing material', () => {
    expect(parseProcessPrivacyIntentInput(valid)).toEqual(valid);
  });

  test.each([
    { ...valid, sourceWebhookEventId: 'not-an-id' },
    { ...valid, requestKey: ' ' },
    { ...valid, requestKey: 'x'.repeat(129) },
    { ...valid, unexpected: true },
  ])('rejects invalid processing material', (candidate) => {
    expect(() => parseProcessPrivacyIntentInput(candidate)).toThrow();
  });
});

describe('privacy request review command', () => {
  const valid = {
    decidedAt: effectiveAt,
    decision: 'approve',
    reasonCode: 'identity_verified',
    requestKey: 'privacy-review-test-a',
    requestRef: 'PRIVACY_TEST_request_a',
    verificationMethod: 'same_channel_context',
  } as const;

  test.each(['same_channel_context', 'known_name'] as const)(
    'accepts approved verification method %s',
    (verificationMethod) => {
      expect(parseReviewPrivacyRequestInput({ ...valid, verificationMethod })).toMatchObject({
        verificationMethod,
      });
    },
  );

  test.each(['password', 'otp', 'access_token', 'payment_credential', 'security_answer'])(
    'rejects secret-based verification method %s',
    (verificationMethod) => {
      expect(() => parseReviewPrivacyRequestInput({ ...valid, verificationMethod })).toThrow();
    },
  );

  test.each([
    { ...valid, decision: 'approve', reasonCode: 'identity_ambiguous' },
    { ...valid, decision: 'reject', reasonCode: 'identity_verified' },
    { ...valid, decidedAt: new Date(Number.NaN) },
    { ...valid, reviewerNote: 'free-form text is prohibited' },
  ])('rejects conflicting or unbounded review material', (candidate) => {
    expect(() => parseReviewPrivacyRequestInput(candidate)).toThrow();
  });

  test.each(['identity_ambiguous', 'request_withdrawn'] as const)(
    'accepts bounded rejection reason %s',
    (reasonCode) => {
      expect(
        parseReviewPrivacyRequestInput({
          ...valid,
          decision: 'reject',
          reasonCode,
        }),
      ).toMatchObject({ decision: 'reject', reasonCode });
    },
  );
});

describe('privacy checklist command', () => {
  const valid = {
    checkedAt: effectiveAt,
    locationCode: 'offline_archives',
    outcomeCode: 'location_complete',
    requestKey: 'privacy-location-test-a',
    requestRef: 'PRIVACY_TEST_request_a',
  } as const;

  test.each([
    ['primary_postgres', 'location_complete'],
    ['meta_provider', 'location_not_applicable'],
    ['offline_archives', 'location_failed'],
  ] as const)('accepts closed checklist pair %s/%s', (locationCode, outcomeCode) => {
    expect(parseAttestPrivacyLocationInput({ ...valid, locationCode, outcomeCode })).toMatchObject({
      locationCode,
      outcomeCode,
    });
  });

  test.each([
    { ...valid, locationCode: 'operator-laptop-c-drive' },
    { ...valid, outcomeCode: 'looked_everywhere' },
    { ...valid, checkedAt: new Date(Number.NaN) },
    { ...valid, path: 'C:/customer-export.json' },
  ])('rejects unapproved checklist material', (candidate) => {
    expect(() => parseAttestPrivacyLocationInput(candidate)).toThrow();
  });
});

describe('specialized privacy commands', () => {
  test('accepts bounded access and correction envelopes without customer values', () => {
    expect(
      parseCollectAccessDataInput({
        collectedAt: effectiveAt,
        requestKey: 'privacy-access-test-a',
        requestRef: 'PRIVACY_TEST_request_a',
      }),
    ).toMatchObject({ requestRef: 'PRIVACY_TEST_request_a' });
    expect(
      parseExecuteCorrectionInput({
        executedAt: effectiveAt,
        fieldKey: 'synthetic_profile_name',
        requestKey: 'privacy-correction-test-a',
        requestRef: 'PRIVACY_TEST_request_a',
      }),
    ).toMatchObject({ fieldKey: 'synthetic_profile_name' });
  });

  test.each([
    {
      executedAt: effectiveAt,
      fieldKey: 'contacts.updated_at = now()',
      requestKey: 'privacy-correction-test-a',
      requestRef: 'PRIVACY_TEST_request_a',
    },
    {
      executedAt: effectiveAt,
      fieldKey: 'synthetic_profile_name',
      requestKey: 'privacy-correction-test-a',
      requestRef: 'PRIVACY_TEST_request_a',
      value: 'must be handler-specific and in memory',
    },
  ])('rejects generic correction material', (candidate) => {
    expect(() => parseExecuteCorrectionInput(candidate)).toThrow();
  });

  test('accepts immediate opt-out and canonicalizes explicit re-opt-in categories', () => {
    expect(
      parseMarketingOptOutInput({
        effectiveAt,
        requestKey: 'privacy-opt-out-test-a',
        sourceWebhookEventId: '102',
      }),
    ).toMatchObject({ sourceWebhookEventId: '102' });

    expect(
      parseExplicitMarketingReoptInInput({
        categories: ['newsletter', 'security_updates'],
        effectiveAt,
        identity: syntheticIdentity,
        requestKey: 'privacy-reopt-in-test-a',
        scope: 'source_identity',
        verificationMethod: 'same_channel_context',
      }),
    ).toMatchObject({ categories: ['newsletter', 'security_updates'] });
  });

  test.each([
    { categories: [] },
    { categories: ['newsletter', 'newsletter'] },
    { categories: ['Newsletter'] },
    { categories: ['security updates'] },
    { categories: ['unknown_campaign'] },
    { categories: ['x'.repeat(65)] },
  ])('rejects invalid re-opt-in category set $categories', ({ categories }) => {
    expect(() =>
      parseExplicitMarketingReoptInInput({
        categories,
        effectiveAt,
        identity: syntheticIdentity,
        requestKey: 'privacy-reopt-in-test-a',
        scope: 'source_identity',
        verificationMethod: 'same_channel_context',
      }),
    ).toThrow();
  });

  test.each(['password', 'otp', 'access_token', 'payment_credential'])(
    'rejects prohibited re-opt-in verification %s',
    (verificationMethod) => {
      expect(() =>
        parseExplicitMarketingReoptInInput({
          categories: ['newsletter'],
          effectiveAt,
          identity: syntheticIdentity,
          requestKey: 'privacy-reopt-in-test-a',
          scope: 'all_linked_identities',
          verificationMethod,
        }),
      ).toThrow();
    },
  );
});
