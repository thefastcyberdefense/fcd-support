export type KnowledgeLanguage = 'bn' | 'en';

export type KnowledgeKind = 'business_fact' | 'escalation_response' | 'faq' | 'safety_response';

export type KnowledgeSourceType = 'manual_business' | 'policy' | 'support_gap' | 'website';

export interface BilingualText {
  readonly bn: string;
  readonly en: string;
}

export interface KnowledgeAliasInput {
  readonly kind: 'alias' | 'example' | 'intent';
  readonly language: KnowledgeLanguage;
  readonly phrase: string;
}

export interface KnowledgeSourceInput {
  readonly approvedUrl?: string;
  readonly createdAt: Date;
  readonly createdByReference: string;
  readonly label: string;
  readonly sourceRef: string;
  readonly sourceType: KnowledgeSourceType;
}

export interface KnowledgeProposalInput {
  readonly aliases: readonly KnowledgeAliasInput[];
  readonly answers: BilingualText;
  readonly applicability?: string;
  readonly authorReference: string;
  readonly contentSha256: string;
  readonly createdAt: Date;
  readonly itemKey: string;
  readonly kind: KnowledgeKind;
  readonly questions?: BilingualText;
  readonly replacesVersionRef?: string;
  readonly requestKey: string;
  readonly rollbackFromVersionRef?: string;
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly sourceSnapshotRef?: string;
  readonly tags: readonly string[];
  readonly versionRef: string;
}

export interface KnowledgeReviewCommand {
  readonly action: 'approve' | 'reject' | 'submit';
  readonly effectiveAt: Date;
  readonly reasonCode: string;
  readonly requestKey: string;
  readonly reviewerReference: string;
  readonly versionRef: string;
}

interface KnowledgePublicationCommandBase {
  readonly effectiveAt: Date;
  readonly itemKey: string;
  readonly reasonCode: string;
  readonly requestKey: string;
  readonly reviewerReference: string;
  readonly versionRef: string;
}

export type KnowledgePublicationCommand =
  | (KnowledgePublicationCommandBase & {
      readonly action: 'publish';
      readonly priorVersionRef?: string;
    })
  | (KnowledgePublicationCommandBase & { readonly action: 'retire' })
  | (KnowledgePublicationCommandBase & {
      readonly action: 'rollback';
      readonly priorVersionRef: string;
    });

export interface PublishedKnowledgeVersion {
  readonly answers: BilingualText;
  readonly itemKey: string;
  readonly kind: KnowledgeKind;
  readonly versionNumber: number;
  readonly versionRef: string;
}

export interface KnowledgeAliasView {
  readonly kind: KnowledgeAliasInput['kind'] | 'question';
  readonly language: KnowledgeLanguage;
  readonly normalizedPhrase: string;
  readonly phrase: string;
}

export interface KnowledgeVersionView extends Omit<KnowledgeProposalInput, 'aliases'> {
  readonly aliases: readonly KnowledgeAliasView[];
  readonly state: 'approved' | 'draft' | 'rejected' | 'submitted';
  readonly versionNumber: number;
}

export type KnowledgeSourceWriteResult =
  | { readonly sourceRef: string; readonly status: 'created' }
  | { readonly sourceRef: string; readonly status: 'duplicate' };

export type KnowledgeSnapshotWriteResult =
  | { readonly snapshotRef: string; readonly status: 'created' }
  | { readonly snapshotRef: string; readonly status: 'duplicate' };

export type KnowledgeWriteResult =
  | { readonly status: 'created'; readonly versionRef: string }
  | { readonly status: 'duplicate'; readonly versionRef: string };
