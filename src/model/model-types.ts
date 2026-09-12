import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';

export interface ModelOperationalLimits {
  readonly concurrentCalls: number;
  readonly cooldownMs: number;
  readonly globalUtcDayCalls: number;
  readonly outputTokens: number;
  readonly perContact15MinuteCalls: number;
  readonly perContact24HourCalls: number;
  readonly providerAttempts: number;
  readonly queueCapacity: number;
  readonly totalTimeoutMs: number;
}

export interface ModelDeploymentCeilings extends ModelOperationalLimits {
  readonly architectureProviderConnections: number;
  readonly contextItems: number;
  readonly inputCodePoints: number;
  readonly responseBytes: number;
}

export interface ModelRuntimeConfig {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly deploymentCeilings: ModelDeploymentCeilings;
  readonly model: 'auto';
}

export interface ManifestKnowledgeRecord {
  readonly approvedUrls: readonly string[];
  readonly fact: string;
  readonly reference: string;
}

export type ManifestDecisionEnvelope =
  | {
      readonly answer: string;
      readonly decision: 'answer';
      readonly knowledgeReferences: readonly string[];
      readonly language: KnowledgeLanguage;
      readonly needsHumanReview: false;
      readonly reasonCode: 'published_knowledge_answer';
    }
  | {
      readonly answer: '';
      readonly decision: 'escalate';
      readonly knowledgeReferences: readonly [];
      readonly language: KnowledgeLanguage;
      readonly needsHumanReview: true;
      readonly reasonCode: 'human_review_required' | 'insufficient_published_knowledge';
    };

export type ManifestOutputRejectionReason =
  | 'action_claim'
  | 'invalid_schema'
  | 'malformed_json'
  | 'oversized_output'
  | 'sensitive_output'
  | 'unapproved_url'
  | 'unsupported_claim'
  | 'unsupported_reference'
  | 'wrong_language';

export type ManifestOutputValidationResult =
  | { readonly status: 'accepted'; readonly value: ManifestDecisionEnvelope }
  | { readonly reasonCode: ManifestOutputRejectionReason; readonly status: 'rejected' };

export interface ManifestOutputValidationContext {
  readonly knowledge: readonly ManifestKnowledgeRecord[];
  readonly maximumResponseBytes: number;
  readonly requiredLanguage: KnowledgeLanguage;
}
