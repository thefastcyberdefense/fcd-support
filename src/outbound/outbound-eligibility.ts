import type { MarketingCategory } from '../policy/policy-types.js';
import type { OutboundChannel, OutboundPurpose } from './outbound-types.js';

export const META_RESPONSE_WINDOW_MS = 86_400_000;

export type OutboundEligibilityReason =
  | 'allowed'
  | 'policy_unavailable'
  | 'source_not_ready'
  | 'content_erased'
  | 'retention_expired'
  | 'active_review_overdue'
  | 'pause_active'
  | 'echo_correlation_hold'
  | 'privacy_hold'
  | 'identity_deleted'
  | 'suppressed'
  | 'consent_missing'
  | 'window_closed'
  | 'template_required'
  | 'template_invalid';

interface EligibilitySourceBase {
  readonly contentErased: boolean;
  readonly ready: boolean;
}

export interface SupportTextEligibilitySource extends EligibilitySourceBase {
  readonly kind: 'support_text';
}

export interface FixedTemplateEligibilitySource extends EligibilitySourceBase {
  readonly active: boolean;
  readonly channel: 'whatsapp';
  readonly channelAccountId: string;
  readonly kind: 'fixed_template';
  readonly locale: 'bn_BD' | 'en_US';
  readonly purpose: OutboundPurpose;
  readonly variableCount: number;
}

export interface OutboundEligibilityInput {
  readonly activeClientReviewAt: Date | null;
  readonly channel: OutboundChannel;
  readonly channelAccountId: string;
  readonly echoHoldUntil: Date | null;
  readonly evaluatedAt: Date;
  readonly globalSuppressed: boolean;
  readonly identityDeleted: boolean;
  readonly latestConsentAction: 'grant' | 'revoke' | null;
  readonly lastCustomerMessageAt: Date | null;
  readonly pauseUntil: Date | null;
  readonly policyAvailable: boolean;
  readonly privacyHoldOpen: boolean;
  readonly purpose: OutboundPurpose;
  readonly requestedLocale: 'bn_BD' | 'en_US';
  readonly retentionDeadline: Date;
  readonly scopedSuppressed: boolean;
  readonly source: FixedTemplateEligibilitySource | SupportTextEligibilitySource;
}

export type OutboundEligibility =
  | { readonly eligible: true; readonly reason: 'allowed' }
  | {
      readonly eligible: false;
      readonly reason: Exclude<OutboundEligibilityReason, 'allowed'>;
    };

const consentCategoryByPurpose = Object.freeze({
  marketing_education: 'security_updates',
  marketing_events: 'product_updates',
  marketing_news: 'newsletter',
  marketing_offers: 'product_offers',
} satisfies Record<Exclude<OutboundPurpose, 'customer_support'>, MarketingCategory>);

export function consentCategoryForOutboundPurpose(
  purpose: OutboundPurpose,
): MarketingCategory | null {
  return purpose === 'customer_support' ? null : consentCategoryByPurpose[purpose];
}

function requireDate(value: Date | null, fieldName: string): void {
  if (value !== null && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
    throw new TypeError(`${fieldName} must be a valid Date or null`);
  }
}

function denied(reason: Exclude<OutboundEligibilityReason, 'allowed'>): OutboundEligibility {
  return { eligible: false, reason };
}

export function evaluateOutboundEligibility(input: OutboundEligibilityInput): OutboundEligibility {
  requireDate(input.evaluatedAt, 'evaluatedAt');
  requireDate(input.retentionDeadline, 'retentionDeadline');
  requireDate(input.activeClientReviewAt, 'activeClientReviewAt');
  requireDate(input.echoHoldUntil, 'echoHoldUntil');
  requireDate(input.lastCustomerMessageAt, 'lastCustomerMessageAt');
  requireDate(input.pauseUntil, 'pauseUntil');

  const evaluatedMilliseconds = input.evaluatedAt.getTime();
  if (!input.policyAvailable) return denied('policy_unavailable');
  if (!input.source.ready) return denied('source_not_ready');
  if (input.source.contentErased) return denied('content_erased');
  if (
    input.activeClientReviewAt !== null &&
    input.activeClientReviewAt.getTime() <= evaluatedMilliseconds
  ) {
    return denied('active_review_overdue');
  }
  if (input.retentionDeadline.getTime() <= evaluatedMilliseconds) {
    return denied('retention_expired');
  }
  if (input.pauseUntil !== null && input.pauseUntil.getTime() > evaluatedMilliseconds) {
    return denied('pause_active');
  }
  if (input.echoHoldUntil !== null && input.echoHoldUntil.getTime() > evaluatedMilliseconds) {
    return denied('echo_correlation_hold');
  }
  if (input.privacyHoldOpen) return denied('privacy_hold');
  if (input.identityDeleted) return denied('identity_deleted');

  const consentCategory = consentCategoryForOutboundPurpose(input.purpose);
  if (consentCategory !== null && (input.globalSuppressed || input.scopedSuppressed)) {
    return denied('suppressed');
  }
  if (consentCategory !== null && input.latestConsentAction !== 'grant') {
    return denied('consent_missing');
  }

  if (input.source.kind === 'support_text') {
    if (input.purpose !== 'customer_support') return denied('template_required');
    if (input.lastCustomerMessageAt === null) return denied('template_required');
    const age = evaluatedMilliseconds - input.lastCustomerMessageAt.getTime();
    if (age < 0 || age > META_RESPONSE_WINDOW_MS) return denied('template_required');
    return { eligible: true, reason: 'allowed' };
  }

  if (
    input.channel !== 'whatsapp' ||
    !input.source.active ||
    input.source.channelAccountId !== input.channelAccountId ||
    input.source.purpose !== input.purpose ||
    input.source.locale !== input.requestedLocale ||
    input.source.variableCount !== 0
  ) {
    return denied('template_invalid');
  }
  return { eligible: true, reason: 'allowed' };
}
