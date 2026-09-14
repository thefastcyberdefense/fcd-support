import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ManifestClient, ManifestClientFailureReason } from '../model/manifest-client.js';
import { parseManifestOutput } from '../model/manifest-output.js';
import {
  buildManifestRequest,
  prepareManifestText,
  type ManifestRequestLimits,
} from '../model/manifest-request.js';
import type { ManifestLimitAttestation } from '../model/model-policy-types.js';
import type { ManifestKnowledgeRecord, ModelDeploymentCeilings } from '../model/model-types.js';
import type {
  ModelAllowancePort,
  ModelPolicyPort,
  ModelReplyDecisionResult,
  ModelReplyStore,
} from './reply-types.js';
import { inspectSensitiveText } from '../safety/sensitive-data-gate.js';
import { safeResponse, type SafeResponseReason } from '../safety/safe-responses.js';
import type { ModelEscalationReasonCode } from '../persistence/postgres-support-escalation.js';

const inputSchema = z.strictObject({
  evaluatedAt: z.date().refine((value) => Number.isFinite(value.getTime())),
  language: z.enum(['en', 'bn']),
  requestKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  webhookEventId: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/u)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
});

export interface ModelReplyServiceOptions {
  readonly allowance: ModelAllowancePort;
  readonly deployment: ModelDeploymentCeilings;
  readonly manifest: ManifestClient;
  readonly manifestAttestation: ManifestLimitAttestation | undefined;
  readonly now?: () => Date;
  readonly policy: ModelPolicyPort;
  readonly store: ModelReplyStore;
}

export function createModelLogicalCallKey(webhookEventId: string): string {
  return `MODEL_${createHash('sha256')
    .update(JSON.stringify(['fcd-support', 'model-reply', webhookEventId]))
    .digest('hex')
    .slice(0, 48)}`;
}

function failureReason(reason: ManifestClientFailureReason): {
  readonly escalation: ModelEscalationReasonCode;
  readonly response: SafeResponseReason;
} {
  switch (reason) {
    case 'timeout':
      return { escalation: 'timeout', response: 'provider_unavailable' };
    case 'network_failure':
      return { escalation: 'network_failure', response: 'provider_unavailable' };
    case 'provider_exhausted':
      return { escalation: 'provider_exhausted', response: 'limit_exhausted' };
    case 'non_2xx':
      return { escalation: 'provider_failure', response: 'provider_unavailable' };
    default:
      return { escalation: 'invalid_response', response: 'validation_failed' };
  }
}

function invalidEnvelopeReason(reason: string): ModelEscalationReasonCode {
  if (reason === 'unsupported_claim' || reason === 'unsupported_reference') {
    return 'unsupported_claim';
  }
  if (reason === 'wrong_language') return 'wrong_language';
  return 'invalid_response';
}

function denialReason(reason: string): ModelEscalationReasonCode {
  if (reason === 'rate_limited' || reason === 'global_limit' || reason === 'queue_full') {
    return reason;
  }
  return 'model_disabled';
}

function preparedKnowledge(
  records: readonly ManifestKnowledgeRecord[],
  language: 'bn' | 'en',
  maximumInputCodePoints: number,
) {
  return records.map((record) => ({
    approvedUrls: record.approvedUrls,
    fact: prepareManifestText(
      inspectSensitiveText(record.fact, language, { maximumInputCodePoints }),
    ),
    reference: record.reference,
  }));
}

export class ModelReplyService {
  private readonly now: () => Date;

  public constructor(private readonly options: ModelReplyServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async decide(input: unknown): Promise<ModelReplyDecisionResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new TypeError('Model reply input is invalid');
    const command = parsed.data;
    const claim = await this.options.store.claimModelDecision(command);
    if (claim.status !== 'claimed') return claim;
    const currentInspection = inspectSensitiveText(claim.source.messageText, command.language, {
      maximumInputCodePoints: this.options.deployment.inputCodePoints,
    });
    if (currentInspection.status === 'blocked') {
      return this.safeFailure(
        command,
        currentInspection.reasonCode === 'redaction_ambiguous'
          ? 'unsafe_redaction'
          : 'sensitive_data_blocked',
        'sensitive_data_blocked',
      );
    }

    const policy = await this.options.policy.resolveEffectivePolicy(
      command.evaluatedAt,
      this.options.deployment,
      this.options.manifestAttestation,
    );
    if (policy.status === 'disabled') {
      return this.safeFailure(command, 'model_disabled', 'provider_unavailable');
    }

    const knowledge = await this.options.store.loadPublishedKnowledge({
      evaluatedAt: command.evaluatedAt,
      language: command.language,
      maximumItems: this.options.deployment.contextItems,
    });
    let request;
    try {
      const requestLimits: ManifestRequestLimits = {
        maximumContextItems: this.options.deployment.contextItems,
        maximumInputCodePoints: this.options.deployment.inputCodePoints,
        maximumOutputTokens: policy.limits.outputTokens,
      };
      request = buildManifestRequest({
        currentRequest: prepareManifestText(currentInspection),
        language: command.language,
        limits: requestLimits,
        publishedKnowledge: preparedKnowledge(
          knowledge,
          command.language,
          this.options.deployment.inputCodePoints,
        ),
        recentContext: [],
      });
    } catch {
      return this.safeFailure(command, 'invalid_response', 'validation_failed');
    }

    const callKey = createModelLogicalCallKey(command.webhookEventId);
    const allowance = await this.options.allowance.acquireModelAllowance({
      conversationId: claim.source.conversationId,
      effectivePolicy: policy,
      evaluatedAt: command.evaluatedAt,
      logicalCallKey: callKey,
      webhookEventId: command.webhookEventId,
    });
    if (allowance.status === 'denied') {
      return this.safeFailure(command, denialReason(allowance.reasonCode), 'limit_exhausted');
    }
    if (allowance.status === 'duplicate' && allowance.leaseState !== 'queued') {
      if (allowance.leaseState === 'active') return { status: 'in_progress' };
      return this.safeFailure(command, 'database_failure', 'provider_unavailable');
    }
    if (allowance.leaseState === 'queued') {
      const activation = await this.options.allowance.activateLease({
        activatedAt: this.now(),
        effectivePolicy: policy,
        logicalCallKey: callKey,
      });
      if (activation.status === 'queued') return { status: 'in_progress' };
      if (activation.status === 'duplicate') return { status: 'in_progress' };
      if (activation.status === 'policy_disabled') {
        return this.safeFailure(command, 'model_disabled', 'provider_unavailable');
      }
    }

    const manifestResult = await this.options.manifest.complete({
      logicalRequestId: callKey,
      request,
    });
    if (manifestResult.status === 'failed') {
      const mapped = failureReason(manifestResult.reasonCode);
      const persisted = await this.safeFailure(command, mapped.escalation, mapped.response);
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode:
          persisted.status === 'policy_blocked' ? 'guard_blocked' : manifestResult.reasonCode,
      });
      return persisted;
    }

    const validation = parseManifestOutput(JSON.stringify(manifestResult.value), {
      knowledge,
      maximumResponseBytes: this.options.deployment.responseBytes,
      requiredLanguage: command.language,
    });
    if (validation.status === 'rejected') {
      const persisted = await this.safeFailure(
        command,
        invalidEnvelopeReason(validation.reasonCode),
        'validation_failed',
      );
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : 'invalid_envelope',
      });
      return persisted;
    }
    if (validation.value.decision === 'escalate') {
      const persisted = await this.safeFailure(command, 'invalid_response', 'human_escalation');
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : 'completed',
      });
      return persisted;
    }

    const persisted = await this.options.store.persistModelDecision({
      ...command,
      evaluatedAt: this.now(),
      answerText: validation.value.answer,
      kind: 'model',
      knowledgeReferences: validation.value.knowledgeReferences,
    });
    if (persisted.status === 'knowledge_changed') {
      const fallback = await this.safeFailure(command, 'invalid_response', 'validation_failed');
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode: fallback.status === 'policy_blocked' ? 'guard_blocked' : 'invalid_envelope',
      });
      return fallback;
    }
    await this.options.allowance.completeLease({
      completedAt: this.now(),
      logicalCallKey: callKey,
      outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : 'completed',
    });
    return persisted;
  }

  private safeFailure(
    command: z.infer<typeof inputSchema>,
    escalationReasonCode: ModelEscalationReasonCode,
    responseReason: SafeResponseReason,
  ): Promise<ModelReplyDecisionResult> {
    return this.options.store.persistModelDecision({
      ...command,
      evaluatedAt: this.now(),
      answerText: safeResponse(command.language, responseReason),
      escalationReasonCode,
      kind: 'safe_failure',
      responseReason,
    });
  }
}
