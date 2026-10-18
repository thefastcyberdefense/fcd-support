import { describe, expect, test } from 'vitest';

import {
  META_RESPONSE_WINDOW_MS,
  consentCategoryForOutboundPurpose,
  evaluateOutboundEligibility,
  type OutboundEligibilityInput,
} from '../src/outbound/outbound-eligibility.js';

const customerAt = new Date('2026-09-15T10:00:00.000Z');
const evaluatedAt = new Date('2026-09-15T11:00:00.000Z');

function supportInput(override: Partial<OutboundEligibilityInput> = {}): OutboundEligibilityInput {
  return {
    activeClientReviewAt: null,
    channel: 'whatsapp',
    channelAccountId: 'PHONE_TEST_eligibility',
    echoHoldUntil: null,
    evaluatedAt,
    globalSuppressed: false,
    identityDeleted: false,
    latestConsentAction: null,
    lastCustomerMessageAt: customerAt,
    pauseUntil: null,
    policyAvailable: true,
    privacyHoldOpen: false,
    purpose: 'customer_support',
    requestedLocale: 'en_US',
    retentionDeadline: new Date('2026-09-22T10:00:00.000Z'),
    scopedSuppressed: false,
    source: {
      contentErased: false,
      kind: 'support_text',
      ready: true,
    },
    ...override,
  };
}

function templateInput(override: Partial<OutboundEligibilityInput> = {}): OutboundEligibilityInput {
  return supportInput({
    channel: 'whatsapp',
    latestConsentAction: 'grant',
    lastCustomerMessageAt: null,
    purpose: 'marketing_news',
    source: {
      active: true,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_eligibility',
      contentErased: false,
      kind: 'fixed_template',
      locale: 'en_US',
      purpose: 'marketing_news',
      ready: true,
      variableCount: 0,
    },
    ...override,
  });
}

describe('outbound eligibility', () => {
  test('an unreconciled recovery hold blocks otherwise eligible support and marketing', () => {
    expect(evaluateOutboundEligibility(supportInput({ recoveryHold: true }))).toEqual({
      eligible: false,
      reason: 'restore_quarantined',
    });
    expect(evaluateOutboundEligibility(templateInput({ recoveryHold: true }))).toEqual({
      eligible: false,
      reason: 'restore_quarantined',
    });
  });
  test('keeps the Meta response window open through the exact 24-hour boundary', () => {
    const boundary = new Date(customerAt.getTime() + META_RESPONSE_WINDOW_MS);
    expect(evaluateOutboundEligibility(supportInput({ evaluatedAt: boundary }))).toEqual({
      eligible: true,
      reason: 'allowed',
    });
    expect(
      evaluateOutboundEligibility(supportInput({ evaluatedAt: new Date(boundary.getTime() + 1) })),
    ).toEqual({ eligible: false, reason: 'template_required' });
  });

  test.each(['messenger', 'whatsapp'] as const)(
    'uses only a qualifying customer event for the %s response window',
    (channel) => {
      expect(
        evaluateOutboundEligibility(
          supportInput({
            channel,
            evaluatedAt: new Date(customerAt.getTime() + META_RESPONSE_WINDOW_MS + 1),
          }),
        ),
      ).toEqual({ eligible: false, reason: 'template_required' });
    },
  );

  test('requires an exact latest consent grant for every marketing purpose', () => {
    expect(evaluateOutboundEligibility(templateInput())).toEqual({
      eligible: true,
      reason: 'allowed',
    });
    expect(evaluateOutboundEligibility(templateInput({ latestConsentAction: null }))).toEqual({
      eligible: false,
      reason: 'consent_missing',
    });
    expect(evaluateOutboundEligibility(templateInput({ latestConsentAction: 'revoke' }))).toEqual({
      eligible: false,
      reason: 'consent_missing',
    });
  });

  test('maps closed outbound purposes to the existing closed consent categories', () => {
    expect(consentCategoryForOutboundPurpose('marketing_education')).toBe('security_updates');
    expect(consentCategoryForOutboundPurpose('marketing_events')).toBe('product_updates');
    expect(consentCategoryForOutboundPurpose('marketing_news')).toBe('newsletter');
    expect(consentCategoryForOutboundPurpose('marketing_offers')).toBe('product_offers');
    expect(consentCategoryForOutboundPurpose('customer_support')).toBeNull();
  });

  test.each([
    ['global', { globalSuppressed: true }],
    ['scoped', { scopedSuppressed: true }],
    ['both', { globalSuppressed: true, scopedSuppressed: true }],
  ] as const)('gives %s suppression precedence over consent', (_label, override) => {
    expect(evaluateOutboundEligibility(templateInput(override))).toEqual({
      eligible: false,
      reason: 'suppressed',
    });
  });

  test('does not apply a marketing opt-out to customer support', () => {
    expect(
      evaluateOutboundEligibility(supportInput({ globalSuppressed: true, scopedSuppressed: true })),
    ).toEqual({ eligible: true, reason: 'allowed' });
  });

  test.each([
    ['inactive', { source: { ...templateInput().source, active: false } }],
    [
      'cross-account',
      {
        source: {
          ...templateInput().source,
          channelAccountId: 'PHONE_TEST_wrong_account',
        },
      },
    ],
    ['cross-category', { source: { ...templateInput().source, purpose: 'marketing_offers' } }],
    ['cross-locale', { requestedLocale: 'bn_BD' }],
    ['variable', { source: { ...templateInput().source, variableCount: 1 } }],
  ] as const)('rejects a %s fixed template', (_label, override) => {
    expect(evaluateOutboundEligibility(templateInput(override))).toEqual({
      eligible: false,
      reason: 'template_invalid',
    });
  });

  test('allows fixed templates outside the customer-response window', () => {
    expect(
      evaluateOutboundEligibility(
        templateInput({
          evaluatedAt: new Date('2026-10-15T11:00:00.000Z'),
          retentionDeadline: new Date('2026-10-16T11:00:00.000Z'),
        }),
      ),
    ).toEqual({ eligible: true, reason: 'allowed' });
  });

  test.each([
    ['policy_unavailable', { policyAvailable: false }],
    ['source_not_ready', { source: { ...supportInput().source, ready: false } }],
    ['content_erased', { source: { ...supportInput().source, contentErased: true } }],
    ['retention_expired', { retentionDeadline: evaluatedAt }],
    ['active_review_overdue', { activeClientReviewAt: evaluatedAt }],
    ['pause_active', { pauseUntil: new Date(evaluatedAt.getTime() + 1) }],
    ['echo_correlation_hold', { echoHoldUntil: new Date(evaluatedAt.getTime() + 1) }],
    ['privacy_hold', { privacyHoldOpen: true }],
    ['identity_deleted', { identityDeleted: true }],
  ] as const)('fails closed with %s', (reason, override) => {
    expect(evaluateOutboundEligibility(supportInput(override))).toEqual({
      eligible: false,
      reason,
    });
  });
});
