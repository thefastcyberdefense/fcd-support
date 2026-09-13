import type { FaqResolutionPolicy } from '../knowledge/faq-resolver.js';
import type { ModelOperationalLimits } from './model-types.js';

export interface ModelPolicyValues extends Omit<ModelOperationalLimits, 'providerAttempts'> {
  readonly approvedProviderAttempts: number;
  readonly architectureProviderCeiling: number;
  readonly faqAmbiguityMargin: number;
  readonly faqMinimumSimilarity: number;
  readonly maximumFaqCandidates: number;
}

export interface ModelPolicyCreateInput {
  readonly createdAt: Date;
  readonly createdByAccountRef: string;
  readonly policyRef: string;
  readonly requestKey: string;
  readonly values: ModelPolicyValues;
}

export type ModelPolicyTransitionAction = 'activate' | 'approve' | 'retire' | 'submit';

export interface ModelPolicyTransitionInput {
  readonly action: ModelPolicyTransitionAction;
  readonly effectiveAt: Date;
  readonly policyRef: string;
  readonly reasonCode: string;
  readonly requestKey: string;
  readonly reviewerAccountRef: string;
}

export type ModelPolicyState = 'active' | 'approved' | 'draft' | 'retired' | 'submitted';

export interface ModelPolicyVersionView extends ModelPolicyCreateInput {
  readonly activatedAt?: Date;
  readonly approvedAt?: Date;
  readonly approvedByAccountRef?: string;
  readonly retiredAt?: Date;
  readonly state: ModelPolicyState;
  readonly submittedAt?: Date;
  readonly versionNumber: number;
}

export interface ManifestLimitAttestation {
  readonly operationalLimits: ModelOperationalLimits;
  readonly verified: true;
}

export type EffectiveModelPolicy =
  | {
      readonly reasonCode: 'manifest_limits_unverified' | 'no_active_policy';
      readonly status: 'disabled';
    }
  | {
      readonly faq: FaqResolutionPolicy;
      readonly limits: ModelOperationalLimits;
      readonly policyRef: string;
      readonly policyVersionId: string;
      readonly status: 'enabled';
    };

export interface ModelPolicyWriteResult {
  readonly policyRef: string;
  readonly status: 'applied' | 'duplicate';
}
