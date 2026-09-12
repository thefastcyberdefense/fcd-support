import { z } from 'zod';

import { prepareFaqResolutionText } from '../knowledge/faq-resolver.js';
import { safeResponse } from '../safety/safe-responses.js';
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

    const inspection = this.options.inspectSensitiveText(
      claim.source.messageText,
      command.language,
    );
    let decision: PersistReplyDecisionInput;
    if (inspection.status === 'blocked') {
      decision = {
        ...command,
        kind: 'safe_failure',
        answerText: safeResponse(command.language, 'sensitive_data_blocked'),
        escalationReasonCode:
          inspection.reasonCode === 'redaction_ambiguous'
            ? 'unsafe_redaction'
            : 'sensitive_data_blocked',
      };
    } else {
      const resolution = await this.options.faqResolver.resolve({
        evaluatedAt: command.evaluatedAt,
        sanitizedText: prepareFaqResolutionText(inspection),
      });
      if (resolution.status === 'match') {
        decision = {
          ...command,
          kind: 'faq',
          answerText: resolution.answer,
          itemReference: resolution.itemReference,
          versionReference: resolution.versionReference,
        };
      } else {
        decision = {
          ...command,
          kind: 'model_required',
          gapKind: resolution.status === 'ambiguous' ? 'faq_ambiguous' : 'faq_miss',
        };
      }
    }

    return this.options.store.persistDecision(decision);
  }
}
