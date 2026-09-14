import type { FaqResolution, PreparedFaqResolutionText } from '../knowledge/faq-resolver.js';
import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import type { SensitiveTextInspection } from '../safety/sensitive-data-types.js';
import type { ManifestClientFailureReason } from '../model/manifest-client.js';
import type {
  EffectiveModelPolicy,
  ManifestLimitAttestation,
} from '../model/model-policy-types.js';
import type { ManifestKnowledgeRecord, ModelDeploymentCeilings } from '../model/model-types.js';
import type { ModelEscalationReasonCode } from '../persistence/postgres-support-escalation.js';
import type { SafeResponseReason } from '../safety/safe-responses.js';

export interface ReplyDecisionInput {
  readonly evaluatedAt: Date;
  readonly language: KnowledgeLanguage;
  readonly requestKey: string;
  readonly webhookEventId: string;
}

export type ReplyPolicyBlockReason =
  | 'content_purged'
  | 'identity_deleted'
  | 'pause_active'
  | 'privacy_request_open'
  | 'retention_expired';

export interface ClaimedReplySource {
  readonly conversationId: string;
  readonly messageText: string;
  readonly occurredAt: Date;
  readonly webhookEventId: string;
}

export type ExistingReplyDecision =
  | {
      readonly decisionType: 'faq' | 'model' | 'safe_failure';
      readonly draftRef: string;
      readonly nextAction: 'none';
      readonly status: 'duplicate';
    }
  | {
      readonly decisionType: 'model_required';
      readonly nextAction: 'model_required';
      readonly observationRef: string;
      readonly status: 'duplicate';
    };

export type ReplyDecisionClaim =
  | ExistingReplyDecision
  | { readonly source: ClaimedReplySource; readonly status: 'claimed' }
  | { readonly reasonCode: ReplyPolicyBlockReason; readonly status: 'policy_blocked' }
  | { readonly status: 'not_processable' };

type PersistReplyDecisionBase = ReplyDecisionInput;

export type PersistReplyDecisionInput =
  | (PersistReplyDecisionBase & {
      readonly answerText: string;
      readonly escalationReasonCode: 'sensitive_data_blocked' | 'unsafe_redaction';
      readonly kind: 'safe_failure';
    })
  | (PersistReplyDecisionBase & {
      readonly answerText: string;
      readonly itemReference: string;
      readonly kind: 'faq';
      readonly versionReference: string;
    })
  | (PersistReplyDecisionBase & {
      readonly gapKind: 'faq_ambiguous' | 'faq_miss';
      readonly kind: 'model_required';
    });

export type PersistReplyDecisionResult =
  | ExistingReplyDecision
  | {
      readonly decisionType: 'faq' | 'safe_failure';
      readonly draftRef: string;
      readonly nextAction: 'none';
      readonly status: 'created';
    }
  | {
      readonly decisionType: 'model_required';
      readonly nextAction: 'model_required';
      readonly observationRef: string;
      readonly status: 'created';
    }
  | { readonly reasonCode: ReplyPolicyBlockReason; readonly status: 'policy_blocked' };

export type ReplyDecisionResult =
  PersistReplyDecisionResult | { readonly status: 'not_processable' };

export interface ReplyDecisionStore {
  claimDecision(input: ReplyDecisionInput): Promise<ReplyDecisionClaim>;
  persistDecision(input: PersistReplyDecisionInput): Promise<PersistReplyDecisionResult>;
}

export type PersistModelDecisionInput =
  | (ReplyDecisionInput & {
      readonly answerText: string;
      readonly kind: 'model';
      readonly knowledgeReferences: readonly string[];
    })
  | (ReplyDecisionInput & {
      readonly answerText: string;
      readonly escalationReasonCode: ModelEscalationReasonCode;
      readonly kind: 'safe_failure';
      readonly responseReason: SafeResponseReason;
    });

export type ModelReplyDecisionResult =
  | {
      readonly decisionType: 'faq' | 'model' | 'safe_failure';
      readonly draftRef: string;
      readonly nextAction: 'none';
      readonly status: 'created' | 'duplicate';
    }
  | { readonly reasonCode: ReplyPolicyBlockReason; readonly status: 'policy_blocked' }
  | { readonly status: 'in_progress' | 'knowledge_changed' | 'not_processable' };

export type ModelReplyClaim =
  | {
      readonly decisionType: 'faq' | 'model' | 'safe_failure';
      readonly draftRef: string;
      readonly nextAction: 'none';
      readonly status: 'duplicate';
    }
  | { readonly source: ClaimedReplySource; readonly status: 'claimed' }
  | { readonly reasonCode: ReplyPolicyBlockReason; readonly status: 'policy_blocked' }
  | { readonly status: 'not_processable' };

export interface ModelReplyStore {
  claimModelDecision(input: ReplyDecisionInput): Promise<ModelReplyClaim>;
  loadPublishedKnowledge(input: {
    readonly evaluatedAt: Date;
    readonly language: KnowledgeLanguage;
    readonly maximumItems: number;
  }): Promise<readonly ManifestKnowledgeRecord[]>;
  persistModelDecision(input: PersistModelDecisionInput): Promise<ModelReplyDecisionResult>;
}

export interface ModelPolicyPort {
  resolveEffectivePolicy(
    evaluatedAt: Date,
    deployment: ModelDeploymentCeilings,
    manifest: ManifestLimitAttestation | undefined,
  ): Promise<EffectiveModelPolicy>;
}

export interface ModelAllowancePort {
  acquireModelAllowance(input: {
    readonly conversationId: string;
    readonly effectivePolicy: Extract<EffectiveModelPolicy, { readonly status: 'enabled' }>;
    readonly evaluatedAt: Date;
    readonly logicalCallKey: string;
    readonly webhookEventId: string;
  }): Promise<
    | { readonly leaseState: 'active' | 'queued'; readonly status: 'acquired' }
    | {
        readonly leaseState: 'active' | 'completed' | 'expired' | 'failed' | 'queued';
        readonly status: 'duplicate';
      }
    | {
        readonly reasonCode:
          'cooldown' | 'global_limit' | 'policy_disabled' | 'queue_full' | 'rate_limited';
        readonly status: 'denied';
      }
  >;
  activateLease(input: {
    readonly activatedAt: Date;
    readonly effectivePolicy: Extract<EffectiveModelPolicy, { readonly status: 'enabled' }>;
    readonly logicalCallKey: string;
  }): Promise<{ readonly status: 'activated' | 'duplicate' | 'policy_disabled' | 'queued' }>;
  completeLease(input: {
    readonly completedAt: Date;
    readonly logicalCallKey: string;
    readonly outcomeCode:
      ManifestClientFailureReason | 'completed' | 'database_failure' | 'guard_blocked';
  }): Promise<{ readonly status: 'applied' | 'duplicate' }>;
}

export interface FaqResolutionPort {
  resolve(input: {
    readonly evaluatedAt: Date;
    readonly sanitizedText: PreparedFaqResolutionText;
  }): Promise<FaqResolution>;
}

export type SensitiveTextInspectionPort = (
  input: string,
  language: KnowledgeLanguage,
) => SensitiveTextInspection;
