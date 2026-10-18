import { z } from 'zod';

import { loadModelConfig, restrictModelOperationalLimits } from '../model/model-config.js';
import type { ManifestLimitAttestation } from '../model/model-policy-types.js';
import { parseOutboundPolicyInput } from '../outbound/outbound-policy-input.js';

const integer = z.number().int();
const attestationSchema = z.strictObject({
  verified: z.literal(true),
  operationalLimits: z.strictObject({
    concurrentCalls: integer.min(1).max(100),
    cooldownMs: integer.min(0).max(86400000),
    globalUtcDayCalls: integer.min(1).max(100000),
    outputTokens: integer.min(1).max(4096),
    perContact15MinuteCalls: integer.min(1).max(100),
    perContact24HourCalls: integer.min(1).max(1000),
    providerAttempts: integer.min(1).max(5),
    queueCapacity: integer.min(0).max(10000),
    totalTimeoutMs: integer.min(100).max(120000),
  }),
});
const faqSchema = z
  .strictObject({
    ambiguityMargin: z.number().min(0).max(1),
    minimumSimilarity: z.number().positive().max(1),
    maximumCandidates: integer.min(2).max(100),
  })
  .refine((value) => value.ambiguityMargin < value.minimumSimilarity);
function json(value: string | undefined): unknown {
  if (value === undefined || value.length > 4096) throw new Error('invalid');
  return JSON.parse(value) as unknown;
}

export function loadReplySettings(
  environment: Readonly<Record<string, string | undefined>>,
  modelEnabled: boolean,
) {
  try {
    const revision = z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .parse(environment.OPS_GIT_REVISION);
    const schemaRevision = z
      .string()
      .regex(/^\d{6}$/u)
      .parse(environment.OPS_SCHEMA_REVISION);
    const faq = Object.freeze(faqSchema.parse(json(environment.REPLY_FAQ_POLICY_JSON)));
    const outboundBounds = Object.freeze(
      parseOutboundPolicyInput(json(environment.REPLY_OUTBOUND_BOUNDS_JSON)),
    );
    let model: ReturnType<typeof loadModelConfig> | undefined;
    let attestation: ManifestLimitAttestation | undefined;
    if (modelEnabled) {
      model = loadModelConfig(environment);
      if (model.apiKey === undefined) throw new Error('invalid');
      const parsed = attestationSchema.parse(json(environment.REPLY_MANIFEST_ATTESTATION_JSON));
      const limits = parsed.operationalLimits;
      attestation = Object.freeze({
        verified: true as const,
        operationalLimits: restrictModelOperationalLimits(limits, limits, limits),
      });
    }
    return Object.freeze({ revision, schemaRevision, faq, outboundBounds, model, attestation });
  } catch {
    throw new Error('reply_configuration_invalid');
  }
}
