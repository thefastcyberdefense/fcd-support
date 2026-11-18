import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import type { SensitiveTextInspectionPort } from '../replies/reply-types.js';
import type {
  ClaimedWebhookAttachment,
  MediaEscalationReasonCode,
  MediaExtractorPort,
  MediaFetchPort,
  MediaProcessResult,
  MediaProcessorPort,
  PersistedAttachmentOutcome,
} from './media-types.js';
import { detectExtractedLanguage, hasPdfMagicHeader } from './pdf-extractor.js';

function isPdfAttachment(
  attachment: ClaimedWebhookAttachment,
  bytes: Uint8Array,
  mimeType?: string,
): boolean {
  const mime = (mimeType ?? attachment.mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return true;
  if ((attachment.filename ?? '').toLowerCase().endsWith('.pdf')) return true;
  if ((attachment.mediaUrl ?? '').toLowerCase().split('?')[0]?.endsWith('.pdf') === true) {
    return true;
  }
  return hasPdfMagicHeader(bytes);
}

function pickEscalation(
  outcomes: readonly PersistedAttachmentOutcome[],
  blockReasonCode: 'sensitive_data_blocked' | 'unsafe_redaction' | undefined,
): {
  readonly escalationReasonCode: MediaEscalationReasonCode;
  readonly safeResponseReason: 'human_escalation' | 'sensitive_data_blocked';
} {
  if (blockReasonCode !== undefined) {
    return {
      escalationReasonCode: blockReasonCode,
      safeResponseReason: 'sensitive_data_blocked',
    };
  }
  if (outcomes.some((item) => item.extractionStatus === 'sensitive_blocked')) {
    const blocked = outcomes.find((item) => item.extractionStatus === 'sensitive_blocked');
    return {
      escalationReasonCode:
        blocked?.reasonCode === 'redaction_ambiguous'
          ? 'unsafe_redaction'
          : 'sensitive_data_blocked',
      safeResponseReason: 'sensitive_data_blocked',
    };
  }
  if (outcomes.some((item) => item.extractionStatus === 'unsupported')) {
    return { escalationReasonCode: 'unsupported_media', safeResponseReason: 'human_escalation' };
  }
  if (outcomes.some((item) => item.extractionStatus === 'visual_only')) {
    return {
      escalationReasonCode: 'visual_media_deferred',
      safeResponseReason: 'human_escalation',
    };
  }
  if (outcomes.some((item) => item.extractionStatus === 'failed')) {
    return {
      escalationReasonCode: 'media_extraction_failed',
      safeResponseReason: 'human_escalation',
    };
  }
  return { escalationReasonCode: 'unclear_media', safeResponseReason: 'human_escalation' };
}

export interface PrivateMediaProcessorOptions {
  readonly extractor: MediaExtractorPort;
  readonly fetcher: MediaFetchPort;
  readonly inspectSensitiveText: SensitiveTextInspectionPort;
}

export class PrivateMediaProcessor implements MediaProcessorPort {
  public constructor(private readonly options: PrivateMediaProcessorOptions) {}

  public async process(input: {
    readonly attachments: readonly ClaimedWebhookAttachment[];
    readonly channel: 'messenger' | 'whatsapp';
    readonly evaluatedAt: Date;
    readonly language: KnowledgeLanguage;
    readonly messageText: string;
  }): Promise<MediaProcessResult> {
    const outcomes: PersistedAttachmentOutcome[] = [];
    const extractedParts: string[] = [];
    const baseText = input.messageText.trim();
    const baseHasBangla = baseText.length > 0 && /[\u0980-\u09FF]/u.test(baseText);
    let detectedLanguage: KnowledgeLanguage = baseHasBangla ? 'bn' : input.language;
    let redactedAttachmentSecrets = 0;

    for (const attachment of input.attachments) {
      if (attachment.kind === 'unsupported') {
        outcomes.push({
          attachmentId: attachment.id,
          extractionStatus: 'unsupported',
          extractedText: null,
          extractionMethod: null,
          detectedLanguage: null,
          reasonCode: `unsupported_attachment:${attachment.rawType}`,
        });
        continue;
      }

      const downloaded = await this.options.fetcher.download(attachment, input.channel);
      if (downloaded.status !== 'downloaded') {
        outcomes.push({
          attachmentId: attachment.id,
          extractionStatus: downloaded.status,
          extractedText: null,
          extractionMethod: null,
          detectedLanguage: null,
          reasonCode: downloaded.reasonCode,
        });
        continue;
      }

      let extracted;
      if (attachment.kind === 'document') {
        if (!isPdfAttachment(attachment, downloaded.bytes, downloaded.mimeType)) {
          outcomes.push({
            attachmentId: attachment.id,
            extractionStatus: 'unsupported',
            extractedText: null,
            extractionMethod: null,
            detectedLanguage: null,
            reasonCode: 'unsupported_document_type',
          });
          continue;
        }
        extracted = await this.options.extractor.extractPdf(downloaded.bytes);
      } else if (attachment.kind === 'image') {
        extracted = await this.options.extractor.extractImageOcr({
          bytes: downloaded.bytes,
          languageHint: detectedLanguage,
          ...(downloaded.mimeType === undefined ? {} : { mimeType: downloaded.mimeType }),
        });
      } else {
        extracted = await this.options.extractor.transcribeAudio({
          bytes: downloaded.bytes,
          languageHint: detectedLanguage,
          ...(downloaded.mimeType === undefined ? {} : { mimeType: downloaded.mimeType }),
          ...(attachment.isVoice === null ? {} : { voice: attachment.isVoice }),
        });
      }

      if (extracted.status !== 'extracted') {
        outcomes.push({
          attachmentId: attachment.id,
          extractionStatus: extracted.status,
          extractedText: null,
          extractionMethod: null,
          detectedLanguage: null,
          reasonCode: extracted.reasonCode,
        });
        continue;
      }

      const itemLanguage =
        extracted.detectedLanguage ?? detectExtractedLanguage(extracted.text, detectedLanguage);
      if (!baseHasBangla && baseText.length === 0 && itemLanguage === 'bn') {
        detectedLanguage = 'bn';
      }

      const inspected = this.options.inspectSensitiveText(extracted.text, itemLanguage);
      if (inspected.status === 'blocked') {
        outcomes.push({
          attachmentId: attachment.id,
          extractionStatus: 'sensitive_blocked',
          extractedText: null,
          extractionMethod: extracted.method,
          detectedLanguage: itemLanguage,
          reasonCode: inspected.reasonCode,
        });
        continue;
      }
      if (inspected.status === 'redacted') {
        redactedAttachmentSecrets += 1;
      }

      outcomes.push({
        attachmentId: attachment.id,
        extractionStatus: 'extracted',
        extractedText: inspected.sanitizedText,
        extractionMethod: extracted.method,
        detectedLanguage: itemLanguage,
        reasonCode: inspected.status === 'redacted' ? 'sensitive_value_redacted' : null,
      });
      extractedParts.push(inspected.sanitizedText);
    }

    if (outcomes.some((item) => item.extractionStatus !== 'extracted')) {
      const escalation = pickEscalation(outcomes, undefined);
      return {
        kind: 'escalate',
        effectiveLanguage: detectedLanguage,
        attachmentOutcomes: outcomes,
        ...escalation,
      };
    }

    const baseInspection =
      baseText.length > 0
        ? this.options.inspectSensitiveText(baseText, detectedLanguage)
        : undefined;
    if (baseInspection?.status === 'blocked') {
      const reasonCode =
        baseInspection.reasonCode === 'redaction_ambiguous'
          ? 'unsafe_redaction'
          : 'sensitive_data_blocked';
      return {
        kind: 'escalate',
        effectiveLanguage: detectedLanguage,
        attachmentOutcomes: outcomes,
        ...pickEscalation(outcomes, reasonCode),
      };
    }
    const baseSafeText = baseInspection === undefined ? '' : baseInspection.sanitizedText;
    const totalRedactedCount = redactedAttachmentSecrets + (baseInspection?.categories.length ?? 0);
    if (totalRedactedCount > 1) {
      return {
        kind: 'escalate',
        effectiveLanguage: detectedLanguage,
        attachmentOutcomes: outcomes,
        ...pickEscalation(outcomes, 'sensitive_data_blocked'),
      };
    }

    const combinedRaw = [baseSafeText, ...extractedParts]
      .filter((part) => part.length > 0)
      .join(' ');
    const finalInspection = this.options.inspectSensitiveText(combinedRaw, detectedLanguage);
    if (finalInspection.status === 'blocked') {
      const reasonCode =
        finalInspection.reasonCode === 'redaction_ambiguous'
          ? 'unsafe_redaction'
          : 'sensitive_data_blocked';
      return {
        kind: 'escalate',
        effectiveLanguage: detectedLanguage,
        attachmentOutcomes: outcomes,
        ...pickEscalation(outcomes, reasonCode),
      };
    }

    return {
      kind: 'extracted',
      combinedText: finalInspection.sanitizedText,
      effectiveLanguage: detectedLanguage,
      inspection: finalInspection,
      attachmentOutcomes: outcomes,
    };
  }
}
