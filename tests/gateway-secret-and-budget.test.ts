import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
  budgetWindowBounds,
  computeActualCallCostMicroUsd,
  computeMaxEstimatedCostMicroUsd,
  formatMicroUsd,
  parseUsdToMicroUsd,
} from '../src/model/gateway-budget.js';
import {
  AesGcmGatewaySecretProtector,
  decodeGatewayEncryptionKey,
} from '../src/model/gateway-secret.js';
import { isAllowedOpenAiCompatibleBaseUrl } from '../src/model/model-config.js';
import { SecretBytes, SecretText } from '../src/safety/secret-bytes.js';

describe('gateway URL validation, secret protection, and budget accounting', () => {
  test('allows HTTPS public endpoints and private HTTP endpoints while rejecting SSRF targets', () => {
    expect(isAllowedOpenAiCompatibleBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isAllowedOpenAiCompatibleBaseUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(isAllowedOpenAiCompatibleBaseUrl('https://gateway.example.test:8443/v1/')).toBe(true);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://omniroute:20128/v1')).toBe(true);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://192.168.10.40:2099/v1')).toBe(true);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://10.0.0.15:8080/openai/v1')).toBe(true);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://127.0.0.1:4000/v1')).toBe(true);

    expect(isAllowedOpenAiCompatibleBaseUrl('http://api.openai.com/v1')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('https://user:pass@api.openai.com/v1')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('https://api.openai.com/v1?x=1')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('https://api.openai.com/v1#frag')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://localhost:8080/v1')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://0.0.0.0:8080/v1')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('https://169.254.169.254/v1')).toBe(false);
    expect(isAllowedOpenAiCompatibleBaseUrl('ftp://gateway.example.test/v1')).toBe(false);
  });

  test('encrypts and decrypts OpenAI-compatible keys with AAD bound to gateway reference and version', () => {
    const encodedKey = Buffer.alloc(32, 0x37).toString('base64url');
    const protector = new AesGcmGatewaySecretProtector(
      'gateway-v1',
      decodeGatewayEncryptionKey(encodedKey),
    );
    const plaintext = new SecretText('synthetic_openai_compatible_test_key_001');
    const sealed = protector.encrypt(plaintext, 'GATEWAY_synthetic_001');

    expect(sealed.keyVersion).toBe('gateway-v1');
    expect(sealed.encryptedMaterial).toBeInstanceOf(SecretBytes);
    expect(sealed.authenticationTag.copy().byteLength).toBe(16);
    expect(sealed.encryptionNonce.copy().byteLength).toBe(12);
    expect(sealed.apiKeySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify({ plaintext, sealed })).not.toContain('synthetic_openai_compatible');
    expect(inspect({ plaintext, sealed })).not.toContain('synthetic_openai_compatible');

    const restored = protector.decrypt(sealed, 'GATEWAY_synthetic_001');
    expect(restored.reveal()).toBe('synthetic_openai_compatible_test_key_001');

    expect(() => protector.decrypt(sealed, 'GATEWAY_synthetic_other')).toThrow(
      'Protected gateway secret is invalid',
    );
    const tampered = {
      ...sealed,
      authenticationTag: new SecretBytes(Buffer.alloc(16, 0xff)),
    };
    expect(() => protector.decrypt(tampered, 'GATEWAY_synthetic_001')).toThrow(
      'Protected gateway secret is invalid',
    );
  });

  test('computes deterministic micro-USD ceilings, actual call spend, and UTC windows', () => {
    expect(parseUsdToMicroUsd('0')).toBe(0);
    expect(parseUsdToMicroUsd('0.00')).toBe(0);
    expect(parseUsdToMicroUsd('12.50')).toBe(12_500_000);
    expect(parseUsdToMicroUsd('0.000001')).toBe(1);
    expect(() => parseUsdToMicroUsd('-1')).toThrow();
    expect(() => parseUsdToMicroUsd('1.1234567')).toThrow();
    expect(formatMicroUsd(12_500_000)).toBe('12.500000');

    expect(
      computeMaxEstimatedCostMicroUsd({
        inputCodePoints: 500,
        maxOutputTokens: 400,
        inputCostPerMillionMicroUsd: 150_000,
        outputCostPerMillionMicroUsd: 600_000,
      }),
    ).toBe(390);

    expect(
      computeMaxEstimatedCostMicroUsd({
        inputCodePoints: 1,
        maxOutputTokens: 1,
        inputCostPerMillionMicroUsd: 1,
        outputCostPerMillionMicroUsd: 0,
      }),
    ).toBe(1);

    expect(
      computeActualCallCostMicroUsd({
        promptTokens: 1000,
        completionTokens: 250,
        inputCostPerMillionMicroUsd: 150_000,
        outputCostPerMillionMicroUsd: 600_000,
      }),
    ).toBe(300);

    const instant = new Date('2030-03-15T14:22:10.500Z');
    expect(budgetWindowBounds('utc_day', instant)).toEqual({
      windowStartedAt: new Date('2030-03-15T00:00:00.000Z'),
      windowEndedAt: new Date('2030-03-16T00:00:00.000Z'),
    });
    expect(budgetWindowBounds('utc_month', instant)).toEqual({
      windowStartedAt: new Date('2030-03-01T00:00:00.000Z'),
      windowEndedAt: new Date('2030-04-01T00:00:00.000Z'),
    });
  });
});
