import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import type { MetaChannel, NormalizedAttachmentKind } from '../meta/normalized-event.js';
import type { SafeResponseReason } from '../safety/safe-responses.js';
import type { SensitiveTextInspection } from '../safety/sensitive-data-types.js';

export type MediaExtractionMethod = 'ocr' | 'pdf_text' | 'stt';

export type AttachmentExtractionStatus =
  | 'erased'
  | 'extracted'
  | 'failed'
  | 'pending'
  | 'sensitive_blocked'
  | 'unclear'
  | 'unsupported'
  | 'visual_only';

export type MediaEscalationReasonCode =
  | 'media_extraction_failed'
  | 'sensitive_data_blocked'
  | 'unclear_media'
  | 'unsafe_redaction'
  | 'unsupported_media'
  | 'visual_media_deferred';

export interface ClaimedWebhookAttachment {
  readonly attachmentIndex: number;
  readonly caption: string | null;
  readonly detectedLanguage: KnowledgeLanguage | null;
  readonly extractedText: string | null;
  readonly extractionMethod: MediaExtractionMethod | null;
  readonly extractionStatus: AttachmentExtractionStatus;
  readonly filename: string | null;
  readonly id: string;
  readonly isVoice: boolean | null;
  readonly kind: NormalizedAttachmentKind;
  readonly mediaId: string | null;
  readonly mediaUrl: string | null;
  readonly mimeType: string | null;
  readonly rawType: string;
  readonly reasonCode: string | null;
  readonly sha256: string | null;
}

export type MediaExtractionOutcome =
  | {
      readonly detectedLanguage?: KnowledgeLanguage;
      readonly method: MediaExtractionMethod;
      readonly status: 'extracted';
      readonly text: string;
    }
  | {
      readonly reasonCode: string;
      readonly status: 'failed' | 'unclear' | 'unsupported' | 'visual_only';
    };

export type MediaDownloadResult =
  | {
      readonly bytes: Uint8Array;
      readonly mimeType?: string;
      readonly status: 'downloaded';
    }
  | {
      readonly reasonCode: string;
      readonly status: 'failed' | 'unsupported';
    };

export interface PersistedAttachmentOutcome {
  readonly attachmentId: string;
  readonly detectedLanguage: KnowledgeLanguage | null;
  readonly extractedText: string | null;
  readonly extractionMethod: MediaExtractionMethod | null;
  readonly extractionStatus: Exclude<AttachmentExtractionStatus, 'erased' | 'pending'>;
  readonly reasonCode: string | null;
}

export type MediaProcessResult =
  | {
      readonly attachmentOutcomes: readonly PersistedAttachmentOutcome[];
      readonly combinedText: string;
      readonly effectiveLanguage: KnowledgeLanguage;
      readonly inspection: SensitiveTextInspection;
      readonly kind: 'extracted';
    }
  | {
      readonly attachmentOutcomes: readonly PersistedAttachmentOutcome[];
      readonly effectiveLanguage: KnowledgeLanguage;
      readonly escalationReasonCode: MediaEscalationReasonCode;
      readonly kind: 'escalate';
      readonly safeResponseReason: Extract<
        SafeResponseReason,
        'human_escalation' | 'sensitive_data_blocked'
      >;
    };

export interface MediaFetchPort {
  download(
    attachment: ClaimedWebhookAttachment,
    channel: MetaChannel,
  ): Promise<MediaDownloadResult>;
}

export interface MediaExtractorPort {
  extractImageOcr(input: {
    readonly bytes: Uint8Array;
    readonly languageHint: KnowledgeLanguage;
    readonly mimeType?: string;
  }): Promise<MediaExtractionOutcome>;
  extractPdf(bytes: Uint8Array): Promise<MediaExtractionOutcome>;
  transcribeAudio(input: {
    readonly bytes: Uint8Array;
    readonly languageHint: KnowledgeLanguage;
    readonly mimeType?: string;
    readonly voice?: boolean;
  }): Promise<MediaExtractionOutcome>;
}

export interface MediaProcessorPort {
  process(input: {
    readonly attachments: readonly ClaimedWebhookAttachment[];
    readonly channel: MetaChannel;
    readonly evaluatedAt: Date;
    readonly language: KnowledgeLanguage;
    readonly messageText: string;
  }): Promise<MediaProcessResult>;
}
