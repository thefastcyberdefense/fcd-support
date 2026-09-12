import { describe, expect, test } from 'vitest';

import { loadModelConfig, restrictModelOperationalLimits } from '../src/model/model-config.js';
import type { ModelOperationalLimits } from '../src/model/model-types.js';

const validEnvironment = Object.freeze({
  MANIFEST_API_KEY: '',
  MANIFEST_BASE_URL: 'http://manifest:2099/v1',
  MANIFEST_DELETION_RETENTION_APPROVED: 'true',
  MANIFEST_LIMITS_WITHIN_DEPLOYMENT_CEILINGS: 'true',
  MANIFEST_MODEL: 'auto',
  MANIFEST_PRIVATE_ROUTE_VERIFIED: 'true',
  MANIFEST_PROVIDER_ALLOWLIST_APPROVED: 'true',
  MANIFEST_RECORDING_DISABLED: 'true',
  MODEL_ARCHITECTURE_PROVIDER_CEILING: '5',
  MODEL_APPROVED_PROVIDER_ATTEMPTS: '3',
  MODEL_COOLDOWN_MS: '300000',
  MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES: '3',
  MODEL_MAX_CALLS_PER_CONTACT_24_HOURS: '10',
  MODEL_MAX_CALLS_PER_UTC_DAY: '300',
  MODEL_MAX_CONCURRENT_CALLS: '4',
  MODEL_MAX_CONTEXT_ITEMS: '8',
  MODEL_MAX_INPUT_CODE_POINTS: '4000',
  MODEL_MAX_OUTPUT_TOKENS: '600',
  MODEL_MAX_QUEUE_DEPTH: '25',
  MODEL_MAX_RESPONSE_BYTES: '65536',
  MODEL_TOTAL_TIMEOUT_MS: '20000',
});

const attestationNames = [
  'MANIFEST_DELETION_RETENTION_APPROVED',
  'MANIFEST_LIMITS_WITHIN_DEPLOYMENT_CEILINGS',
  'MANIFEST_PRIVATE_ROUTE_VERIFIED',
  'MANIFEST_PROVIDER_ALLOWLIST_APPROVED',
  'MANIFEST_RECORDING_DISABLED',
] as const;

const ceilingNames = [
  'MODEL_ARCHITECTURE_PROVIDER_CEILING',
  'MODEL_APPROVED_PROVIDER_ATTEMPTS',
  'MODEL_COOLDOWN_MS',
  'MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES',
  'MODEL_MAX_CALLS_PER_CONTACT_24_HOURS',
  'MODEL_MAX_CALLS_PER_UTC_DAY',
  'MODEL_MAX_CONCURRENT_CALLS',
  'MODEL_MAX_CONTEXT_ITEMS',
  'MODEL_MAX_INPUT_CODE_POINTS',
  'MODEL_MAX_OUTPUT_TOKENS',
  'MODEL_MAX_QUEUE_DEPTH',
  'MODEL_MAX_RESPONSE_BYTES',
  'MODEL_TOTAL_TIMEOUT_MS',
] as const;

describe('fail-closed model configuration', () => {
  test('loads the private fcd-support auto contract without requiring a local-development key', () => {
    expect(loadModelConfig(validEnvironment)).toEqual({
      apiKey: undefined,
      baseUrl: 'http://manifest:2099/v1',
      deploymentCeilings: {
        architectureProviderConnections: 5,
        concurrentCalls: 4,
        cooldownMs: 300000,
        globalUtcDayCalls: 300,
        inputCodePoints: 4000,
        outputTokens: 600,
        perContact15MinuteCalls: 3,
        perContact24HourCalls: 10,
        providerAttempts: 3,
        queueCapacity: 25,
        responseBytes: 65536,
        totalTimeoutMs: 20000,
        contextItems: 8,
      },
      model: 'auto',
    });
  });

  test('accepts a nonblank secret without placing it in an error or attestation field', () => {
    const syntheticValue = 'SYNTHETIC_MANIFEST_CREDENTIAL_NOT_OPERATIONAL';
    const result = loadModelConfig({ ...validEnvironment, MANIFEST_API_KEY: syntheticValue });

    expect(result.apiKey).toHaveLength(syntheticValue.length);
    expect(JSON.stringify(result.deploymentCeilings)).not.toContain(syntheticValue);
  });

  test.each(attestationNames)('requires %s to be explicitly true', (name) => {
    expect(() => loadModelConfig({ ...validEnvironment, [name]: 'false' })).toThrow(name);
    const missing = Object.fromEntries(
      Object.entries(validEnvironment).filter(([setting]) => setting !== name),
    );
    expect(() => loadModelConfig(missing)).toThrow(name);
  });

  test.each(ceilingNames)('requires deployment ceiling %s', (name) => {
    const missing = Object.fromEntries(
      Object.entries(validEnvironment).filter(([setting]) => setting !== name),
    );
    expect(() => loadModelConfig(missing)).toThrow(name);
  });

  test('requires exact model auto', () => {
    for (const invalid of ['AUTO', ' auto ', 'synthetic-model']) {
      expect(() => loadModelConfig({ ...validEnvironment, MANIFEST_MODEL: invalid })).toThrow(
        'MANIFEST_MODEL',
      );
    }
  });

  test.each([
    'https://manifest.example.invalid/v1',
    'http://169.254.169.254/v1',
    'http://0.0.0.0:2099/v1',
    'http://synthetic:credential@manifest:2099/v1',
    'http://manifest:2099/v1?provider=synthetic',
    'http://manifest:2099/other',
  ])('rejects public, metadata, listener, credential, query, or wrong-path URL %s', (url) => {
    expect(() => loadModelConfig({ ...validEnvironment, MANIFEST_BASE_URL: url })).toThrow(
      'MANIFEST_BASE_URL',
    );
  });

  test('accepts loopback and RFC1918 addresses for later local/private contract tests', () => {
    for (const baseUrl of ['http://127.0.0.1:2099/v1', 'https://10.20.30.40/v1']) {
      expect(loadModelConfig({ ...validEnvironment, MANIFEST_BASE_URL: baseUrl }).baseUrl).toBe(
        baseUrl,
      );
    }
  });

  test('rejects inconsistent or unsafe ceiling material', () => {
    const cases = [
      { MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES: '11' },
      { MODEL_MAX_CALLS_PER_CONTACT_24_HOURS: '301' },
      { MODEL_APPROVED_PROVIDER_ATTEMPTS: '6' },
      { MODEL_ARCHITECTURE_PROVIDER_CEILING: '6' },
      { MODEL_TOTAL_TIMEOUT_MS: '0' },
      { MODEL_MAX_RESPONSE_BYTES: 'not-a-number' },
    ];
    for (const changed of cases) {
      expect(() => loadModelConfig({ ...validEnvironment, ...changed })).toThrow(
        'Invalid model configuration',
      );
    }
  });

  test('reports setting names without leaking invalid values', () => {
    const invalidValue = 'SYNTHETIC_INVALID_CONFIGURATION_VALUE_NOT_OPERATIONAL';
    let error: unknown;
    try {
      loadModelConfig({ ...validEnvironment, MODEL_TOTAL_TIMEOUT_MS: invalidValue });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('MODEL_TOTAL_TIMEOUT_MS');
    expect(String(error)).not.toContain(invalidValue);
  });

  test('uses the stricter maximum from all sources and the stricter longer cooldown', () => {
    const policy: ModelOperationalLimits = {
      concurrentCalls: 8,
      cooldownMs: 1000,
      globalUtcDayCalls: 500,
      outputTokens: 700,
      perContact15MinuteCalls: 4,
      perContact24HourCalls: 20,
      providerAttempts: 4,
      queueCapacity: 30,
      totalTimeoutMs: 30000,
    };
    const deployment: ModelOperationalLimits = {
      concurrentCalls: 4,
      cooldownMs: 5000,
      globalUtcDayCalls: 300,
      outputTokens: 600,
      perContact15MinuteCalls: 3,
      perContact24HourCalls: 10,
      providerAttempts: 3,
      queueCapacity: 25,
      totalTimeoutMs: 20000,
    };
    const manifest: ModelOperationalLimits = {
      concurrentCalls: 6,
      cooldownMs: 3000,
      globalUtcDayCalls: 250,
      outputTokens: 800,
      perContact15MinuteCalls: 2,
      perContact24HourCalls: 12,
      providerAttempts: 2,
      queueCapacity: 50,
      totalTimeoutMs: 15000,
    };

    expect(restrictModelOperationalLimits(policy, deployment, manifest)).toEqual({
      concurrentCalls: 4,
      cooldownMs: 5000,
      globalUtcDayCalls: 250,
      outputTokens: 600,
      perContact15MinuteCalls: 2,
      perContact24HourCalls: 10,
      providerAttempts: 2,
      queueCapacity: 25,
      totalTimeoutMs: 15000,
    });
  });
});
