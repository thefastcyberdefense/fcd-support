import { z } from 'zod';

import { prepareFaqResolutionText } from '../knowledge/faq-resolver.js';
import type { MediaProcessorPort, PersistedAttachmentOutcome } from '../media/media-types.js';
import { safeResponse } from '../safety/safe-responses.js';
import type { SensitiveTextInspection } from '../safety/sensitive-data-types.js';
import type {
  FaqResolutionPort,
  PersistReplyDecisionInput,
  ReplyDecisionInput,
  ReplyDecisionResult,
  ReplyDecisionStore,
  SensitiveTextInspectionPort,
} from './reply-types.js';

const inputSchema = z.strictObject({
  evaluatedAt: z.instanceof(Date).refine((value) => Number.isFinite(value.getTime())),
  language: z.enum(['en', 'bn']),
  requestKey: z.string().trim().min(1).max(128),
  webhookEventId: z
    .string()
    .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n),
});

export interface ReplyDecisionServiceOptions {
  readonly faqResolver: FaqResolutionPort;
  readonly inspectSensitiveText: SensitiveTextInspectionPort;
  readonly mediaProcessor?: MediaProcessorPort;
  readonly store: ReplyDecisionStore;
}

function parseInput(input: unknown): ReplyDecisionInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Reply decision input is invalid');
  return parsed.data;
}

export class ReplyDecisionService {
  public constructor(private readonly options: ReplyDecisionServiceOptions) {}

  public async decide(input: unknown): Promise<ReplyDecisionResult> {
    const command = parseInput(input);
    const claim = await this.options.store.claimDecision(command);
    if (claim.status !== 'claimed') return claim;

    const attachments = claim.source.attachments;
    let effectiveLanguage = command.language;
    let inspection: SensitiveTextInspection;
    let attachmentOutcomes: readonly PersistedAttachmentOutcome[] | undefined;

    if (attachments !== undefined && attachments.length > 0) {
      if (this.options.mediaProcessor === undefined) {
        return this.options.store.persistDecision({
          ...command,
          kind: 'safe_failure',
          answerText: safeResponse(command.language, 'human_escalation'),
          escalationReasonCode: 'media_extraction_failed',
        });
      }
      const mediaResult = await this.options.mediaProcessor.process({
        attachments,
        channel: claim.source.channel ?? 'whatsapp',
        evaluatedAt: command.evaluatedAt,
        language: command.language,
        messageText: claim.source.messageText,
      });
      effectiveLanguage = mediaResult.effectiveLanguage;
      attachmentOutcomes = mediaResult.attachmentOutcomes;
      if (mediaResult.kind === 'escalate') {
        return this.options.store.persistDecision({
          ...command,
          language: effectiveLanguage,
          kind: 'safe_failure',
          answerText: safeResponse(effectiveLanguage, mediaResult.safeResponseReason),
          escalationReasonCode: mediaResult.escalationReasonCode,
          attachmentOutcomes,
        });
      }
      inspection = mediaResult.inspection;
    } else {
      inspection = this.options.inspectSensitiveText(claim.source.messageText, command.language);
    }

    let decision: PersistReplyDecisionInput;
    if (inspection.status === 'blocked') {
      decision = {
        ...command,
        language: effectiveLanguage,
        kind: 'safe_failure',
        answerText: safeResponse(effectiveLanguage, 'sensitive_data_blocked'),
        escalationReasonCode:
          inspection.reasonCode === 'redaction_ambiguous'
            ? 'unsafe_redaction'
            : 'sensitive_data_blocked',
        ...(attachmentOutcomes === undefined ? {} : { attachmentOutcomes }),
      };
    } else {
      const resolution = await this.options.faqResolver.resolve({
        evaluatedAt: command.evaluatedAt,
        sanitizedText: prepareFaqResolutionText(inspection),
      });
      if (resolution.status === 'match') {
        decision = {
          ...command,
          language: effectiveLanguage,
          kind: 'faq',
          answerText: resolution.answer,
          itemReference: resolution.itemReference,
          versionReference: resolution.versionReference,
          ...(attachmentOutcomes === undefined ? {} : { attachmentOutcomes }),
        };
      } else {
        decision = {
          ...command,
          language: effectiveLanguage,
          kind: 'model_required',
          gapKind: resolution.status === 'ambiguous' ? 'faq_ambiguous' : 'faq_miss',
          ...(attachmentOutcomes === undefined ? {} : { attachmentOutcomes }),
        };
      }
    }

    return this.options.store.persistDecision(decision);
  }
}
