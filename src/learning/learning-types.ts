import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';

export const gapKinds = [
  'faq_miss',
  'faq_ambiguous',
  'unsupported_model_claim',
  'human_correction',
  'escalation',
  'repeated_topic',
  'bilingual_coverage_gap',
] as const;
export type GapKind = (typeof gapKinds)[number];

// These are authored operational labels, never customer excerpts or model summaries.
export const gapSummaries: Readonly<Record<GapKind, string>> = {
  faq_miss: 'No reviewed FAQ matched.',
  faq_ambiguous: 'Reviewed FAQ candidates need disambiguation.',
  unsupported_model_claim: 'A proposed answer lacked reviewed support.',
  human_correction: 'A human correction needs knowledge review.',
  escalation: 'A support escalation needs knowledge review.',
  repeated_topic: 'A recurring support category needs review.',
  bilingual_coverage_gap: 'Reviewed bilingual coverage needs improvement.',
};

export interface GapObservationInput {
  readonly observationRef: string;
  readonly requestKey: string;
  readonly webhookEventId: string;
  readonly language: KnowledgeLanguage;
  readonly gapKind: GapKind;
  readonly candidateVersionRefs: readonly string[];
  readonly sanitizedSummary?: string | undefined;
  readonly observedAt: Date;
  readonly retentionDeadline: Date;
}
export interface InsightRunInput {
  readonly runRef: string;
  readonly requestKey: string;
  readonly windowStartedAt: Date;
  readonly windowEndedAt: Date;
}
export interface QuestionDigestInput {
  readonly digestRef: string;
  readonly requestKey: string;
}
export interface OwnerAnswerInput {
  readonly questionRef: string;
  readonly requestKey: string;
  readonly answeredAt: Date;
  readonly answerText: string;
  readonly answerBn: string;
}
export interface LearningPolicy {
  readonly minimumGroupCount: number;
  readonly digestIntervalMilliseconds: number;
  readonly maximumQuestionsPerDigest: number;
  readonly questionCooldownMilliseconds: number;
  readonly maximumDigestAppearances: number;
  readonly maximumObservationsPerRun: number;
}
