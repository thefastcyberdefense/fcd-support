import { describe, expect, test } from 'vitest';

import { inspectSensitiveText } from '../src/safety/sensitive-data-gate.js';
import type {
  SensitiveDataCategory,
  SensitiveDataPolicy,
} from '../src/safety/sensitive-data-types.js';

const policy = {
  maximumInputCodePoints: 500,
} satisfies SensitiveDataPolicy;

describe('sensitive-data inference gate', () => {
  test.each<{
    category: SensitiveDataCategory;
    input: string;
    matchedValue: string;
  }>([
    {
      category: 'password',
      input: 'Password: SYNTHETIC_PASSWORD_DO_NOT_USE_41!',
      matchedValue: 'SYNTHETIC_PASSWORD_DO_NOT_USE_41!',
    },
    {
      category: 'authentication_secret',
      input: 'Client secret: SYNTHETIC_CLIENT_SECRET_DO_NOT_USE_42',
      matchedValue: 'SYNTHETIC_CLIENT_SECRET_DO_NOT_USE_42',
    },
    {
      category: 'authentication_secret',
      input: 'Authorization: Basic SYNTHETIC_BASIC_AUTH_DO_NOT_USE_42B',
      matchedValue: 'SYNTHETIC_BASIC_AUTH_DO_NOT_USE_42B',
    },
    {
      category: 'otp',
      input: 'OTP: 123456',
      matchedValue: '123456',
    },
    {
      category: 'recovery_code',
      input: 'Recovery code: SYNTHETIC-RECOVERY-43',
      matchedValue: 'SYNTHETIC-RECOVERY-43',
    },
    {
      category: 'api_key',
      input: 'API key: SYNTHETIC_API_KEY_DO_NOT_USE_44',
      matchedValue: 'SYNTHETIC_API_KEY_DO_NOT_USE_44',
    },
    {
      category: 'access_token',
      input: 'Bearer SYNTHETIC_ACCESS_TOKEN_DO_NOT_USE_45',
      matchedValue: 'SYNTHETIC_ACCESS_TOKEN_DO_NOT_USE_45',
    },
    {
      category: 'cookie',
      input: 'Cookie: support_session=SYNTHETIC_COOKIE_DO_NOT_USE_46',
      matchedValue: 'support_session=SYNTHETIC_COOKIE_DO_NOT_USE_46',
    },
    {
      category: 'session',
      input: 'Session ID: SYNTHETIC_SESSION_DO_NOT_USE_47',
      matchedValue: 'SYNTHETIC_SESSION_DO_NOT_USE_47',
    },
    {
      category: 'payment_card',
      input: 'Card number: 1234 5678 9012 3456',
      matchedValue: '1234 5678 9012 3456',
    },
    {
      category: 'payment_card',
      input: 'Synthetic request with card number 4111 1111 1111 1111',
      matchedValue: '4111 1111 1111 1111',
    },
    {
      category: 'payment_card',
      input: 'CVV: 123',
      matchedValue: '123',
    },
    {
      category: 'bank_account',
      input: 'Bank account: 000123456789',
      matchedValue: '000123456789',
    },
    {
      category: 'private_key',
      input: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_KEY_MATERIAL_DO_NOT_USE',
      matchedValue: 'SYNTHETIC_PRIVATE_KEY_MATERIAL_DO_NOT_USE',
    },
    {
      category: 'credential_file',
      input: 'Credential file: synthetic-credentials.json',
      matchedValue: 'synthetic-credentials.json',
    },
    {
      category: 'credential_file',
      input: 'I attached .env.production',
      matchedValue: '.env.production',
    },
    {
      category: 'sensitive_incident_evidence',
      input: 'Memory dump: SYNTHETIC_FORENSIC_EVIDENCE_DO_NOT_USE',
      matchedValue: 'SYNTHETIC_FORENSIC_EVIDENCE_DO_NOT_USE',
    },
  ])(
    'fail closed for $category without retaining the match',
    ({ category, input, matchedValue }) => {
      const result = inspectSensitiveText(input, 'en', policy);

      expect(result.status).toBe('blocked');
      expect(result.categories).toContain(category);
      expect(JSON.stringify(result)).not.toContain(matchedValue);
    },
  );

  test('redact one typed value only when a bounded ordinary question remains', () => {
    const value = '123456';
    const result = inspectSensitiveText(
      `How can I sign in to the synthetic portal? OTP: ${value}`,
      'en',
      policy,
    );

    expect(result).toEqual({
      status: 'redacted',
      language: 'en',
      reasonCode: 'sensitive_value_redacted',
      categories: ['otp'],
      markers: [{ category: 'otp', marker: '[REDACTED_OTP]' }],
      sanitizedText: 'How can I sign in to the synthetic portal? [REDACTED_OTP]',
    });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  test('apply the same typed redaction rule to a clear Bangla support question', () => {
    const value = '১২৩৪৫৬';
    const result = inspectSensitiveText(`আমি কীভাবে লগ ইন করব? ওটিপি: ${value}`, 'bn', policy);

    expect(result.status).toBe('redacted');
    if (result.status !== 'redacted') throw new Error('Synthetic Bangla OTP was not redacted');
    expect(result.sanitizedText).toBe('আমি কীভাবে লগ ইন করব? [REDACTED_OTP]');
    expect(JSON.stringify(result)).not.toContain(value);
  });

  test('prefer the specific OTP category over an overlapping password phrase', () => {
    const result = inspectSensitiveText(
      'How can I sign in to the synthetic portal? One-time password: 123456',
      'en',
      policy,
    );

    expect(result).toMatchObject({
      status: 'redacted',
      categories: ['otp'],
      markers: [{ category: 'otp', marker: '[REDACTED_OTP]' }],
    });
  });

  test('block an isolated secret when removal would leave an ambiguous request', () => {
    const result = inspectSensitiveText('OTP: 123456', 'en', policy);

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'redaction_ambiguous',
      categories: ['otp'],
    });
  });

  test('block multiple sensitive values even when surrounding text is a question', () => {
    const otp = '123456';
    const password = 'SYNTHETIC_PASSWORD_DO_NOT_USE_48!';
    const result = inspectSensitiveText(
      `Why can I not sign in? OTP: ${otp}; password: ${password}`,
      'en',
      policy,
    );

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'multiple_sensitive_values',
      categories: ['password', 'otp'],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(otp);
    expect(serialized).not.toContain(password);
  });

  test.each([
    'Please help me reset my password.',
    'Where is the API documentation?',
    'My synthetic order number is 123456.',
    'Why did my session expire?',
    'My card payment failed without showing a card number.',
    'আমি কীভাবে পাসওয়ার্ড রিসেট করব?',
  ])('allow a non-secret false-positive control: %s', (input) => {
    const result = inspectSensitiveText(input, input.includes('আমি') ? 'bn' : 'en', policy);

    expect(result).toMatchObject({
      status: 'safe',
      reasonCode: 'no_sensitive_data',
      categories: [],
      markers: [],
    });
  });

  test('fail closed on malformed Unicode without copying the input into the result', () => {
    const malformed = '\ud800SYNTHETIC_MALFORMED_INPUT_DO_NOT_USE';
    const result = inspectSensitiveText(malformed, 'en', policy);

    expect(result).toEqual({
      status: 'blocked',
      language: 'en',
      reasonCode: 'malformed_unicode',
      categories: [],
      markers: [],
    });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_MALFORMED_INPUT_DO_NOT_USE');
  });

  test('fail closed on excessive input using a supplied deployment limit', () => {
    const excessive = `SYNTHETIC_EXCESSIVE_INPUT_DO_NOT_USE_${'x'.repeat(80)}`;
    const result = inspectSensitiveText(excessive, 'en', { maximumInputCodePoints: 40 });

    expect(result).toEqual({
      status: 'blocked',
      language: 'en',
      reasonCode: 'excessive_input',
      categories: [],
      markers: [],
    });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_EXCESSIVE_INPUT_DO_NOT_USE');
  });

  test('recheck the supplied limit after Unicode compatibility normalization expands text', () => {
    const compatibilityLigature = '\ufb03';
    const result = inspectSensitiveText(compatibilityLigature.repeat(20), 'en', {
      maximumInputCodePoints: 40,
    });

    expect(result).toEqual({
      status: 'blocked',
      language: 'en',
      reasonCode: 'excessive_input',
      categories: [],
      markers: [],
    });
  });

  test('keep matched values out of serialized results, errors, and logger-shaped contexts', () => {
    const matchedValue = 'SYNTHETIC_API_KEY_DO_NOT_USE_49';
    const result = inspectSensitiveText(`API key: ${matchedValue}`, 'en', policy);
    const error = new Error(`sensitive_gate:${result.reasonCode}`);
    const loggerContext = {
      status: result.status,
      reasonCode: result.reasonCode,
      categories: result.categories,
      markers: result.markers,
    };

    expect(JSON.stringify(result)).not.toContain(matchedValue);
    expect(error.message).not.toContain(matchedValue);
    expect(JSON.stringify(loggerContext)).not.toContain(matchedValue);
  });
});
