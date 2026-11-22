import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  computeActualCallCostMicroUsd,
  computeMaxEstimatedCostMicroUsd,
} from '../model/gateway-budget.js';
import type { ResolvedRuntimeGateway } from '../model/gateway-types.js';
import {
  createOpenAiCompatibleClient,
  type ManifestClient,
  type ManifestClientFailureReason,
} from '../model/manifest-client.js';
import { parseManifestOutput } from '../model/manifest-output.js';
import {
  buildGatewayRequest,
  buildManifestRequest,
  prepareManifestText,
  type ManifestRequestLimits,
} from '../model/manifest-request.js';
import type { ManifestLimitAttestation } from '../model/model-policy-types.js';
import type { ManifestKnowledgeRecord, ModelDeploymentCeilings } from '../model/model-types.js';
import type {
  ModelAllowancePort,
  ModelGatewayPort,
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
  readonly gateway?: ModelGatewayPort;
  readonly gatewayClientFactory?: (
    gateway: Extract<ResolvedRuntimeGateway, { readonly gatewayKind: 'openai_compatible' }>,
    maximumResponseBytes: number,
    totalTimeoutMs: number,
  ) => ManifestClient;
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
  readonly leaseOutcome: Exclude<ManifestClientFailureReason, 'truncated_completion'>;
  readonly response: SafeResponseReason;
} {
  switch (reason) {
    case 'timeout':
      return { escalation: 'timeout', leaseOutcome: 'timeout', response: 'provider_unavailable' };
    case 'network_failure':
      return {
        escalation: 'network_failure',
        leaseOutcome: 'network_failure',
        response: 'provider_unavailable',
      };
    case 'provider_exhausted':
      return {
        escalation: 'provider_exhausted',
        leaseOutcome: 'provider_exhausted',
        response: 'limit_exhausted',
      };
    case 'non_2xx':
      return {
        escalation: 'provider_failure',
        leaseOutcome: 'non_2xx',
        response: 'provider_unavailable',
      };
    case 'truncated_completion':
      // Preserve schema 000019 model_call_leases_outcome_code_check compatibility while ManifestClient/logs record truncation distinctly.
      return {
        escalation: 'invalid_response',
        leaseOutcome: 'malformed_body',
        response: 'validation_failed',
      };
    default:
      return {
        escalation: 'invalid_response',
        leaseOutcome: reason,
        response: 'validation_failed',
      };
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
  if (
    reason === 'rate_limited' ||
    reason === 'global_limit' ||
    reason === 'budget_exceeded' ||
    reason === 'queue_full'
  ) {
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

    let gateway: ResolvedRuntimeGateway | undefined;
    if (this.options.gateway !== undefined) {
      try {
        gateway = await this.options.gateway.resolveRuntimeGateway();
      } catch {
        return this.safeFailure(command, 'model_disabled', 'provider_unavailable');
      }
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
      const requestInput = {
        currentRequest: prepareManifestText(currentInspection),
        language: command.language,
        limits: requestLimits,
        publishedKnowledge: preparedKnowledge(
          knowledge,
          command.language,
          this.options.deployment.inputCodePoints,
        ),
        recentContext: [],
      };
      request =
        gateway?.gatewayKind === 'openai_compatible'
          ? buildGatewayRequest(requestInput, { model: gateway.modelName })
          : buildManifestRequest(requestInput);
    } catch {
      return this.safeFailure(command, 'invalid_response', 'validation_failed');
    }

    const requestCodePoints =
      Array.from(request.messages[0].content).length +
      Array.from(request.messages[1].content).length;
    const budgetInput =
      gateway?.gatewayProfileId === undefined
        ? undefined
        : {
            budgetMicroUsd: gateway.budgetMicroUsd,
            budgetWindowKind: gateway.budgetWindowKind,
            estimatedMaxCostMicroUsd: computeMaxEstimatedCostMicroUsd({
              inputCodePoints: requestCodePoints,
              inputCostPerMillionMicroUsd: gateway.inputCostPerMillionMicroUsd,
              maxOutputTokens: policy.limits.outputTokens,
              outputCostPerMillionMicroUsd: gateway.outputCostPerMillionMicroUsd,
            }),
            gatewayProfileId: gateway.gatewayProfileId,
          };

    const callKey = createModelLogicalCallKey(command.webhookEventId);
    const allowance = await this.options.allowance.acquireModelAllowance({
      ...(budgetInput === undefined ? {} : { budget: budgetInput }),
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

    let client: ManifestClient;
    try {
      client =
        gateway?.gatewayKind === 'openai_compatible'
          ? (
              this.options.gatewayClientFactory ??
              ((target, maxBytes, timeoutMs) =>
                createOpenAiCompatibleClient({
                  apiKey: target.apiKey.reveal(),
                  baseUrl: target.endpointBaseUrl,
                  maximumResponseBytes: maxBytes,
                  totalTimeoutMs: timeoutMs,
                }))
            )(gateway, this.options.deployment.responseBytes, policy.limits.totalTimeoutMs)
          : this.options.manifest;
    } catch {
      const persisted = await this.safeFailure(command, 'model_disabled', 'provider_unavailable');
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : 'invalid_request',
      });
      return persisted;
    }

    const manifestResult = await client.complete({
      logicalRequestId: callKey,
      request,
    });
    if (manifestResult.status === 'failed') {
      const mapped = failureReason(manifestResult.reasonCode);
      const persisted = await this.safeFailure(command, mapped.escalation, mapped.response);
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : mapped.leaseOutcome,
      });
      return persisted;
    }

    const usageInput =
      manifestResult.usage === undefined
        ? undefined
        : {
            actualCostMicroUsd: computeActualCallCostMicroUsd({
              completionTokens: manifestResult.usage.completionTokens,
              inputCostPerMillionMicroUsd: gateway?.inputCostPerMillionMicroUsd ?? 0,
              outputCostPerMillionMicroUsd: gateway?.outputCostPerMillionMicroUsd ?? 0,
              promptTokens: manifestResult.usage.promptTokens,
            }),
            completionTokens: manifestResult.usage.completionTokens,
            promptTokens: manifestResult.usage.promptTokens,
          };

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
        ...(usageInput === undefined ? {} : { usage: usageInput }),
      });
      return persisted;
    }
    if (validation.value.decision === 'escalate') {
      const persisted = await this.safeFailure(command, 'invalid_response', 'human_escalation');
      await this.options.allowance.completeLease({
        completedAt: this.now(),
        logicalCallKey: callKey,
        outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : 'completed',
        ...(usageInput === undefined ? {} : { usage: usageInput }),
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
        ...(usageInput === undefined ? {} : { usage: usageInput }),
      });
      return fallback;
    }
    await this.options.allowance.completeLease({
      completedAt: this.now(),
      logicalCallKey: callKey,
      outcomeCode: persisted.status === 'policy_blocked' ? 'guard_blocked' : 'completed',
      ...(usageInput === undefined ? {} : { usage: usageInput }),
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
