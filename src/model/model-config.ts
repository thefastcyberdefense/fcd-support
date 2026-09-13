import { z } from 'zod';

import type { ModelOperationalLimits, ModelRuntimeConfig } from './model-types.js';

const privateSingleLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31)
  );
}

function isPrivateHostname(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLowerCase().replace(/^\[|\]$/gu, '');
  if (isPrivateIpv4(hostname)) return true;
  if (hostname === '::1' || /^f[cd][0-9a-f:]+$/u.test(hostname)) return true;
  return hostname !== 'localhost' && privateSingleLabel.test(hostname);
}

export function isPrivateManifestBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/v1' &&
      isPrivateHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

const requiredInteger = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .regex(/^\S{16,4096}$/u)
    .optional(),
);

const modelConfigSchema = z
  .object({
    MANIFEST_API_KEY: optionalSecret,
    MANIFEST_BASE_URL: z.string().refine(isPrivateManifestBaseUrl),
    MANIFEST_DELETION_RETENTION_APPROVED: z.literal('true'),
    MANIFEST_LIMITS_WITHIN_DEPLOYMENT_CEILINGS: z.literal('true'),
    MANIFEST_MODEL: z.literal('auto'),
    MANIFEST_PRIVATE_ROUTE_VERIFIED: z.literal('true'),
    MANIFEST_PROVIDER_ALLOWLIST_APPROVED: z.literal('true'),
    MANIFEST_RECORDING_DISABLED: z.literal('true'),
    MODEL_ARCHITECTURE_PROVIDER_CEILING: requiredInteger(1, 5),
    MODEL_APPROVED_PROVIDER_ATTEMPTS: requiredInteger(1, 5),
    MODEL_COOLDOWN_MS: requiredInteger(0, 86_400_000),
    MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES: requiredInteger(1, 100),
    MODEL_MAX_CALLS_PER_CONTACT_24_HOURS: requiredInteger(1, 1000),
    MODEL_MAX_CALLS_PER_UTC_DAY: requiredInteger(1, 100_000),
    MODEL_MAX_CONCURRENT_CALLS: requiredInteger(1, 100),
    MODEL_MAX_CONTEXT_ITEMS: requiredInteger(1, 100),
    MODEL_MAX_INPUT_CODE_POINTS: requiredInteger(100, 100_000),
    MODEL_MAX_OUTPUT_TOKENS: requiredInteger(1, 4096),
    MODEL_MAX_QUEUE_DEPTH: requiredInteger(0, 10_000),
    MODEL_MAX_RESPONSE_BYTES: requiredInteger(1024, 1_048_576),
    MODEL_TOTAL_TIMEOUT_MS: requiredInteger(100, 120_000),
  })
  .superRefine((value, context) => {
    if (value.MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES > value.MODEL_MAX_CALLS_PER_CONTACT_24_HOURS) {
      context.addIssue({
        code: 'custom',
        message: 'short window exceeds long window',
        path: ['MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES'],
      });
    }
    if (value.MODEL_MAX_CALLS_PER_CONTACT_24_HOURS > value.MODEL_MAX_CALLS_PER_UTC_DAY) {
      context.addIssue({
        code: 'custom',
        message: 'contact window exceeds global window',
        path: ['MODEL_MAX_CALLS_PER_CONTACT_24_HOURS'],
      });
    }
    if (value.MODEL_APPROVED_PROVIDER_ATTEMPTS > value.MODEL_ARCHITECTURE_PROVIDER_CEILING) {
      context.addIssue({
        code: 'custom',
        message: 'provider attempts exceed architecture ceiling',
        path: ['MODEL_APPROVED_PROVIDER_ATTEMPTS'],
      });
    }
  });

const settingOrder = [
  'MANIFEST_BASE_URL',
  'MANIFEST_API_KEY',
  'MANIFEST_MODEL',
  'MANIFEST_RECORDING_DISABLED',
  'MANIFEST_DELETION_RETENTION_APPROVED',
  'MANIFEST_PROVIDER_ALLOWLIST_APPROVED',
  'MANIFEST_LIMITS_WITHIN_DEPLOYMENT_CEILINGS',
  'MANIFEST_PRIVATE_ROUTE_VERIFIED',
  'MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES',
  'MODEL_MAX_CALLS_PER_CONTACT_24_HOURS',
  'MODEL_MAX_CALLS_PER_UTC_DAY',
  'MODEL_MAX_CONCURRENT_CALLS',
  'MODEL_MAX_QUEUE_DEPTH',
  'MODEL_TOTAL_TIMEOUT_MS',
  'MODEL_MAX_OUTPUT_TOKENS',
  'MODEL_COOLDOWN_MS',
  'MODEL_APPROVED_PROVIDER_ATTEMPTS',
  'MODEL_ARCHITECTURE_PROVIDER_CEILING',
  'MODEL_MAX_RESPONSE_BYTES',
  'MODEL_MAX_CONTEXT_ITEMS',
  'MODEL_MAX_INPUT_CODE_POINTS',
] as const;

export function loadModelConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ModelRuntimeConfig {
  const parsed = modelConfigSchema.safeParse(environment);
  if (!parsed.success) {
    const invalid = new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((value): value is string => typeof value === 'string'),
    );
    throw new Error(
      `Invalid model configuration: ${settingOrder.filter((name) => invalid.has(name)).join(', ')}`,
    );
  }
  const value = parsed.data;
  return Object.freeze({
    apiKey: value.MANIFEST_API_KEY,
    baseUrl: value.MANIFEST_BASE_URL,
    deploymentCeilings: Object.freeze({
      architectureProviderConnections: value.MODEL_ARCHITECTURE_PROVIDER_CEILING,
      concurrentCalls: value.MODEL_MAX_CONCURRENT_CALLS,
      contextItems: value.MODEL_MAX_CONTEXT_ITEMS,
      cooldownMs: value.MODEL_COOLDOWN_MS,
      globalUtcDayCalls: value.MODEL_MAX_CALLS_PER_UTC_DAY,
      inputCodePoints: value.MODEL_MAX_INPUT_CODE_POINTS,
      outputTokens: value.MODEL_MAX_OUTPUT_TOKENS,
      perContact15MinuteCalls: value.MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES,
      perContact24HourCalls: value.MODEL_MAX_CALLS_PER_CONTACT_24_HOURS,
      providerAttempts: value.MODEL_APPROVED_PROVIDER_ATTEMPTS,
      queueCapacity: value.MODEL_MAX_QUEUE_DEPTH,
      responseBytes: value.MODEL_MAX_RESPONSE_BYTES,
      totalTimeoutMs: value.MODEL_TOTAL_TIMEOUT_MS,
    }),
    model: value.MANIFEST_MODEL,
  });
}

function validateOperationalLimits(limits: ModelOperationalLimits): void {
  const maxima = [
    limits.concurrentCalls,
    limits.globalUtcDayCalls,
    limits.outputTokens,
    limits.perContact15MinuteCalls,
    limits.perContact24HourCalls,
    limits.providerAttempts,
    limits.totalTimeoutMs,
  ];
  if (
    maxima.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    !Number.isSafeInteger(limits.queueCapacity) ||
    limits.queueCapacity < 0 ||
    !Number.isSafeInteger(limits.cooldownMs) ||
    limits.cooldownMs < 0 ||
    limits.perContact15MinuteCalls > limits.perContact24HourCalls ||
    limits.perContact24HourCalls > limits.globalUtcDayCalls
  ) {
    throw new TypeError('Model operational limits are invalid');
  }
}

export function restrictModelOperationalLimits(
  policy: ModelOperationalLimits,
  deployment: ModelOperationalLimits,
  manifest: ModelOperationalLimits,
): ModelOperationalLimits {
  for (const limits of [policy, deployment, manifest]) validateOperationalLimits(limits);
  return Object.freeze({
    concurrentCalls: Math.min(
      policy.concurrentCalls,
      deployment.concurrentCalls,
      manifest.concurrentCalls,
    ),
    cooldownMs: Math.max(policy.cooldownMs, deployment.cooldownMs, manifest.cooldownMs),
    globalUtcDayCalls: Math.min(
      policy.globalUtcDayCalls,
      deployment.globalUtcDayCalls,
      manifest.globalUtcDayCalls,
    ),
    outputTokens: Math.min(policy.outputTokens, deployment.outputTokens, manifest.outputTokens),
    perContact15MinuteCalls: Math.min(
      policy.perContact15MinuteCalls,
      deployment.perContact15MinuteCalls,
      manifest.perContact15MinuteCalls,
    ),
    perContact24HourCalls: Math.min(
      policy.perContact24HourCalls,
      deployment.perContact24HourCalls,
      manifest.perContact24HourCalls,
    ),
    providerAttempts: Math.min(
      policy.providerAttempts,
      deployment.providerAttempts,
      manifest.providerAttempts,
    ),
    queueCapacity: Math.min(policy.queueCapacity, deployment.queueCapacity, manifest.queueCapacity),
    totalTimeoutMs: Math.min(
      policy.totalTimeoutMs,
      deployment.totalTimeoutMs,
      manifest.totalTimeoutMs,
    ),
  });
}
