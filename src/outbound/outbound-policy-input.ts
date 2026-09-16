import { z } from 'zod';

import type { OutboundDeploymentBounds, OutboundPolicyValues } from './outbound-types.js';

export const OUTBOUND_LEASE_SAFETY_MARGIN_MS = 1000;

const integer = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);

const outboundPolicySchema = z
  .object({
    global1Minute: integer(1, 1_000_000),
    globalUtcDay: integer(1, 100_000_000),
    leaseMs: integer(1000, 600_000),
    maximumDefiniteRetries: integer(0, 10),
    messengerAccount1Minute: integer(1, 100_000),
    perContact15Minute: integer(1, 1000),
    perContact24Hour: integer(1, 10_000),
    providerTimeoutMs: integer(100, 300_000),
    retryBaseMs: integer(100, 86_400_000),
    retryMaximumMs: integer(100, 604_800_000),
    whatsappAccount1Minute: integer(1, 100_000),
    workerBatchSize: integer(1, 1000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.perContact15Minute > value.perContact24Hour) {
      context.addIssue({
        code: 'custom',
        message: 'short contact window exceeds long contact window',
        path: ['perContact15Minute'],
      });
    }
    if (value.global1Minute > value.globalUtcDay) {
      context.addIssue({
        code: 'custom',
        message: 'minute global window exceeds daily global window',
        path: ['global1Minute'],
      });
    }
    if (value.retryBaseMs > value.retryMaximumMs) {
      context.addIssue({
        code: 'custom',
        message: 'retry base exceeds retry maximum',
        path: ['retryBaseMs'],
      });
    }
    if (value.leaseMs <= value.providerTimeoutMs + OUTBOUND_LEASE_SAFETY_MARGIN_MS) {
      context.addIssue({
        code: 'custom',
        message: 'lease does not include the required timeout safety margin',
        path: ['leaseMs'],
      });
    }
  });

function parseValues(input: unknown, label: string): OutboundPolicyValues {
  const parsed = outboundPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError(label);
  }
  return Object.freeze(parsed.data);
}

export function parseOutboundPolicyInput(input: unknown): OutboundPolicyValues {
  return parseValues(input, 'Invalid outbound policy');
}

export function resolveOutboundBounds(
  policyInput: OutboundPolicyValues,
  deploymentInput: OutboundDeploymentBounds,
): OutboundPolicyValues {
  const policy = parseValues(policyInput, 'Invalid outbound policy');
  const deployment = parseValues(deploymentInput, 'Invalid outbound deployment bounds');
  const retryBaseMs = Math.max(policy.retryBaseMs, deployment.retryBaseMs);
  const retryMaximumMs = Math.max(retryBaseMs, policy.retryMaximumMs, deployment.retryMaximumMs);

  return Object.freeze({
    global1Minute: Math.min(policy.global1Minute, deployment.global1Minute),
    globalUtcDay: Math.min(policy.globalUtcDay, deployment.globalUtcDay),
    leaseMs: Math.min(policy.leaseMs, deployment.leaseMs),
    maximumDefiniteRetries: Math.min(
      policy.maximumDefiniteRetries,
      deployment.maximumDefiniteRetries,
    ),
    messengerAccount1Minute: Math.min(
      policy.messengerAccount1Minute,
      deployment.messengerAccount1Minute,
    ),
    perContact15Minute: Math.min(policy.perContact15Minute, deployment.perContact15Minute),
    perContact24Hour: Math.min(policy.perContact24Hour, deployment.perContact24Hour),
    providerTimeoutMs: Math.min(policy.providerTimeoutMs, deployment.providerTimeoutMs),
    retryBaseMs,
    retryMaximumMs,
    whatsappAccount1Minute: Math.min(
      policy.whatsappAccount1Minute,
      deployment.whatsappAccount1Minute,
    ),
    workerBatchSize: Math.min(policy.workerBatchSize, deployment.workerBatchSize),
  });
}
