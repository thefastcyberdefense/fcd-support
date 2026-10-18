import { createHash } from 'node:crypto';

import type { PostgresConversationEventProcessor } from '../persistence/postgres-conversation-event-processor.js';
import type { PostgresOutboundIntentStore } from '../persistence/postgres-outbound-intent-store.js';
import type {
  PostgresProcessingWork,
  ProcessingClaim,
} from '../persistence/postgres-processing-work.js';
import type { PostgresReplyDraftStore } from '../persistence/postgres-reply-draft-store.js';
import type { ModelReplyService } from '../replies/model-reply-service.js';
import type { ReplyDecisionService } from '../replies/reply-decision-service.js';
import { safeResponse } from '../safety/safe-responses.js';

export interface ReplyPipelineState {
  loadLanguage(eventId: string): Promise<'bn' | 'en' | undefined>;
  applyIntake(eventId: string, requestKey: string): Promise<'handled' | 'ordinary'>;
  hasIntent(draftRef: string): Promise<boolean>;
}
export interface ReplyPipelinePorts {
  readonly processor: Pick<PostgresConversationEventProcessor, 'processEvent'>;
  readonly decision: Pick<ReplyDecisionService, 'decide'>;
  readonly model: Pick<ModelReplyService, 'decide'> | undefined;
  readonly drafts: Pick<PostgresReplyDraftStore, 'persistModelDecision'>;
  readonly intent: Pick<PostgresOutboundIntentStore, 'createSupportIntent'>;
  readonly work: Pick<PostgresProcessingWork, 'advance' | 'finish'>;
  readonly state: ReplyPipelineState;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}
export function replyEventKey(eventId: string): string {
  return `REPLY_${createHash('sha256').update(`fcd-support:reply:${eventId}`).digest('hex').slice(0, 48)}`;
}

export async function runReplyStage(
  claim: ProcessingClaim,
  dependencies: ReplyPipelinePorts,
): Promise<'advanced' | 'completed' | 'blocked'> {
  function checkAbort(): void {
    if (dependencies.signal?.aborted) throw new Error('reply_stage_aborted');
  }
  async function advance(stage: ProcessingClaim['stage']): Promise<'advanced'> {
    checkAbort();
    await dependencies.work.advance({
      workRef: claim.workRef,
      leaseRef: claim.leaseRef,
      stage,
      evaluatedAt: dependencies.now(),
    });
    return 'advanced';
  }
  async function finish(outcome: 'completed' | 'blocked'): Promise<typeof outcome> {
    checkAbort();
    await dependencies.work.finish({
      workRef: claim.workRef,
      leaseRef: claim.leaseRef,
      outcome,
      evaluatedAt: dependencies.now(),
    });
    return outcome;
  }
  checkAbort();
  if (claim.stage === 'apply') {
    const applied = await dependencies.processor.processEvent(claim.webhookEventId);
    if (applied.status === 'correlation_pending') throw new Error('reply_stage_retry');
    if (applied.status === 'not_processable' || applied.status === 'no_pending_event')
      return finish('blocked');
    return applied.outcome === 'customer_message_applied' ? advance('decide') : finish('completed');
  }
  const requestKey = replyEventKey(claim.webhookEventId);
  if (claim.stage === 'decide') {
    // Intake must also run here: reconciliation can resume after event application committed.
    if (
      (await dependencies.state.applyIntake(claim.webhookEventId, `INTAKE_${requestKey}`)) ===
      'handled'
    )
      return finish('blocked');
  }
  checkAbort();
  const language = await dependencies.state.loadLanguage(claim.webhookEventId);
  if (language === undefined) return finish('blocked');
  checkAbort();
  const command = {
    webhookEventId: claim.webhookEventId,
    language,
    requestKey,
    evaluatedAt: dependencies.now(),
  };
  if (claim.stage === 'model') {
    const result =
      dependencies.model === undefined
        ? await dependencies.drafts.persistModelDecision({
            ...command,
            kind: 'safe_failure',
            answerText: safeResponse(language, 'provider_unavailable'),
            escalationReasonCode: 'model_disabled',
            responseReason: 'provider_unavailable',
          })
        : await dependencies.model.decide(command);
    if (result.status === 'in_progress' || result.status === 'knowledge_changed')
      throw new Error('reply_stage_retry');
    return 'draftRef' in result ? advance('enqueue') : finish('blocked');
  }
  const decision = await dependencies.decision.decide(command);
  if (decision.status === 'not_processable' || decision.status === 'policy_blocked')
    return finish('blocked');
  if (claim.stage === 'decide')
    return advance(decision.nextAction === 'model_required' ? 'model' : 'enqueue');
  if (!('draftRef' in decision)) return finish('blocked');
  checkAbort();
  if (!(await dependencies.state.hasIntent(decision.draftRef))) {
    checkAbort();
    const intent = await dependencies.intent.createSupportIntent({
      draftRef: decision.draftRef,
      requestKey: `ENQUEUE_${requestKey}`,
      evaluatedAt: dependencies.now(),
    });
    if (intent.status === 'denied') return finish('blocked');
  }
  return finish('completed');
}
