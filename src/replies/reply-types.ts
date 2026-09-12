import type { FaqResolution, PreparedFaqResolutionText } from '../knowledge/faq-resolver.js';
import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import type { SensitiveTextInspection } from '../safety/sensitive-data-types.js';

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
      readonly decisionType: 'faq' | 'safe_failure';
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
