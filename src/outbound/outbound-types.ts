import { inspect } from 'node:util';

export const OUTBOUND_CHANNELS = ['messenger', 'whatsapp'] as const;
export const OUTBOUND_LANGUAGES = ['bn', 'en'] as const;
export const OUTBOUND_PURPOSES = [
  'customer_support',
  'marketing_education',
  'marketing_events',
  'marketing_news',
  'marketing_offers',
] as const;
export const OUTBOUND_MESSAGE_KINDS = ['fixed_template', 'support_text'] as const;
export const OUTBOUND_INTENT_STATES = [
  'pending',
  'leased',
  'provider_accepted',
  'sent',
  'delivered',
  'read',
  'delivery_unknown',
  'terminal_failed',
  'canceled',
] as const;
export const OUTBOUND_ATTEMPT_STATES = [
  'authorized',
  'dispatch_started',
  'provider_accepted',
  'definitely_rejected',
  'delivery_unknown',
  'abandoned_before_dispatch',
] as const;
export const OUTBOUND_PROVIDER_RESULT_STATUSES = [
  'accepted',
  'definitely_rejected',
  'delivery_unknown',
  'aborted_before_dispatch',
] as const;

export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];
export type OutboundLanguage = (typeof OUTBOUND_LANGUAGES)[number];
export type OutboundPurpose = (typeof OUTBOUND_PURPOSES)[number];
export type OutboundMessageKind = (typeof OUTBOUND_MESSAGE_KINDS)[number];
export type OutboundIntentState = (typeof OUTBOUND_INTENT_STATES)[number];
export type OutboundAttemptState = (typeof OUTBOUND_ATTEMPT_STATES)[number];
export type OutboundRestoreReason = 'restore_quarantined';

export interface OutboundPolicyValues {
  readonly perContact15Minute: number;
  readonly perContact24Hour: number;
  readonly whatsappAccount1Minute: number;
  readonly messengerAccount1Minute: number;
  readonly global1Minute: number;
  readonly globalUtcDay: number;
  readonly workerBatchSize: number;
  readonly leaseMs: number;
  readonly providerTimeoutMs: number;
  readonly maximumDefiniteRetries: number;
  readonly retryBaseMs: number;
  readonly retryMaximumMs: number;
}

export type OutboundDeploymentBounds = OutboundPolicyValues;

export type OutboundProviderResult =
  | { readonly status: 'accepted'; readonly providerMessageId: string }
  | {
      readonly status: 'definitely_rejected';
      readonly reasonCode: 'rate_limited' | 'provider_rejected';
      readonly retryAfter: Date | undefined;
    }
  | {
      readonly status: 'delivery_unknown';
      readonly reasonCode:
        'timeout' | 'network_failure' | 'invalid_response' | 'oversized_response' | 'redirect';
    }
  | { readonly status: 'aborted_before_dispatch' };

const redacted = '[REDACTED]';

export class OutboundCredential {
  readonly #value: string;

  public constructor(value: string) {
    if (typeof value !== 'string' || !/^\S{16,4096}$/u.test(value)) {
      throw new TypeError('Outbound credential is invalid');
    }
    this.#value = value;
  }

  public reveal(): string {
    return this.#value;
  }

  public toJSON(): string {
    return redacted;
  }

  public toString(): string {
    return redacted;
  }

  public [inspect.custom](): string {
    return redacted;
  }
}

export interface OutboundProviderAccountConfig {
  readonly accountId: string;
  readonly credential: OutboundCredential;
}

export interface OutboundConfigSnapshot {
  readonly allowLoopbackFake: boolean;
  readonly deploymentBounds: OutboundDeploymentBounds;
  readonly maximumResponseBytes: number;
  readonly messengerConfigured: boolean;
  readonly whatsappConfigured: boolean;
}

export interface OutboundProviderConfig {
  readonly allowLoopbackFake: boolean;
  readonly baseUrl: string;
  readonly deploymentBounds: OutboundDeploymentBounds;
  readonly graphApiVersion: 'v25.0';
  readonly maximumResponseBytes: number;
  readonly messenger: OutboundProviderAccountConfig;
  readonly redirectPolicy: 'error';
  readonly whatsapp: OutboundProviderAccountConfig;
  readonly toJSON: () => OutboundConfigSnapshot;
  readonly [inspect.custom]: () => OutboundConfigSnapshot;
}

export interface OutboundPolicyMutationResult {
  readonly policyRef: string;
  readonly status: 'applied' | 'duplicate';
}

export type EffectiveOutboundPolicy =
  | { readonly status: 'disabled'; readonly reasonCode: 'no_active_policy' }
  | {
      readonly status: 'enabled';
      readonly policyRef: string;
      readonly policyVersionId: string;
      readonly values: OutboundPolicyValues;
    };

export interface OutboundTemplateMutationResult {
  readonly status: 'applied' | 'duplicate';
  readonly templateRef: string;
  readonly versionNumber: number;
}

export type EffectiveFixedTemplate =
  | { readonly status: 'disabled'; readonly reasonCode: 'no_active_template' }
  | {
      readonly status: 'enabled';
      readonly category: OutboundPurpose;
      readonly channel: 'whatsapp';
      readonly channelAccountId: string;
      readonly contentSha256: string;
      readonly locale: 'bn_BD' | 'en_US';
      readonly providerTemplateId: string;
      readonly templateName: string;
      readonly templateRef: string;
      readonly templateVersionId: string;
      readonly variableCount: 0;
      readonly versionNumber: number;
    };
