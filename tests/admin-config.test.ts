import { describe, expect, test } from 'vitest';

import { loadAdminConfig } from '../src/admin/admin-config.js';

const key = Buffer.alloc(32, 0x41).toString('base64url');

function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    ADMIN_MFA_ENCRYPTION_KEY: key,
    ADMIN_SESSION_HMAC_KEY: key,
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test',
    ...overrides,
  };
}

describe('admin configuration', () => {
  test('defaults to a loopback-only HTTP service with explicit configurable security policy', () => {
    const config = loadAdminConfig(environment());

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3004);
    expect(config.origin).toBe('http://127.0.0.1:3004');
    expect(config.secureCookie).toBe(false);
    expect(config.passwordPolicy).toEqual({
      algorithm: 'scrypt_v1',
      blockSize: 8,
      cost: 65_536,
      keyLength: 32,
      parallelization: 1,
      saltLength: 32,
    });
    expect(config.preauthenticationTtlMilliseconds).toBe(300_000);
    expect(config.sessionTtlMilliseconds).toBe(28_800_000);
    expect(config.totpPolicy).toEqual({
      algorithm: 'sha1',
      digits: 6,
      periodSeconds: 30,
      verificationWindow: 1,
    });
    expect(config.learningPolicy).toEqual({
      minimumGroupCount: 3,
      digestIntervalMilliseconds: 259_200_000,
      maximumQuestionsPerDigest: 5,
      questionCooldownMilliseconds: 604_800_000,
      maximumDigestAppearances: 2,
      maximumObservationsPerRun: 1000,
    });
    expect(config.sessionHmacKey.copy()).toHaveLength(32);
    expect(config.mfaEncryptionKey.copy()).toHaveLength(32);
  });

  test('accepts bounded policy overrides instead of hardcoding operational values', () => {
    const config = loadAdminConfig(
      environment({
        ADMIN_PASSWORD_COST: '131072',
        ADMIN_PREAUTH_TTL_MS: '420000',
        ADMIN_SESSION_TTL_MS: '14400000',
        ADMIN_TOTP_VERIFICATION_WINDOW: '0',
        LEARNING_MINIMUM_GROUP_COUNT: '4',
        LEARNING_DIGEST_INTERVAL_MS: '345600000',
        LEARNING_MAX_QUESTIONS_PER_DIGEST: '3',
        LEARNING_QUESTION_COOLDOWN_MS: '691200000',
        LEARNING_MAX_DIGEST_APPEARANCES: '4',
        LEARNING_MAX_OBSERVATIONS_PER_RUN: '2500',
      }),
    );

    expect(config.passwordPolicy.cost).toBe(131_072);
    expect(config.preauthenticationTtlMilliseconds).toBe(420_000);
    expect(config.sessionTtlMilliseconds).toBe(14_400_000);
    expect(config.totpPolicy.verificationWindow).toBe(0);
    expect(config.learningPolicy).toEqual({
      minimumGroupCount: 4,
      digestIntervalMilliseconds: 345_600_000,
      maximumQuestionsPerDigest: 3,
      questionCooldownMilliseconds: 691_200_000,
      maximumDigestAppearances: 4,
      maximumObservationsPerRun: 2500,
    });
  });

  test.each([
    [{ ADMIN_PORT: '0' }, 'ADMIN_PORT'],
    [{ ADMIN_SESSION_HMAC_KEY: 'invalid' }, 'ADMIN_SESSION_HMAC_KEY'],
    [{ ADMIN_MFA_ENCRYPTION_KEY: '' }, 'ADMIN_MFA_ENCRYPTION_KEY'],
    [{ ADMIN_ORIGIN: 'http://127.0.0.1:3004/path' }, 'ADMIN_ORIGIN'],
    [{ ADMIN_SECURE_COOKIE: 'true' }, 'ADMIN_ORIGIN'],
    [{ LEARNING_DIGEST_INTERVAL_MS: '86400000' }, 'LEARNING_DIGEST_INTERVAL_MS'],
    [
      {
        LEARNING_DIGEST_INTERVAL_MS: '604800000',
        LEARNING_QUESTION_COOLDOWN_MS: '259200000',
      },
      'LEARNING_DIGEST_INTERVAL_MS, LEARNING_QUESTION_COOLDOWN_MS',
    ],
    [{ LEARNING_MAX_QUESTIONS_PER_DIGEST: '6' }, 'LEARNING_MAX_QUESTIONS_PER_DIGEST'],
  ])('rejects invalid bounded settings without echoing values', (overrides, setting) => {
    expect(() => loadAdminConfig(environment(overrides))).toThrow(
      `Invalid admin configuration: ${setting}`,
    );
  });

  test.each(['0.0.0.0', '192.168.10.40', 'admin.internal', '::'])(
    'refuses non-loopback binding %s',
    (host) => {
      expect(() => loadAdminConfig(environment({ ADMIN_HOST: host }))).toThrow(
        'Invalid admin configuration: ADMIN_HOST',
      );
    },
  );

  test('accepts explicit IPv6 loopback with an exact matching origin', () => {
    const config = loadAdminConfig(
      environment({
        ADMIN_HOST: '::1',
        ADMIN_ORIGIN: 'http://[::1]:3004',
      }),
    );

    expect(config.host).toBe('::1');
    expect(config.origin).toBe('http://[::1]:3004');
  });

  test('refuses HTTPS until the separately designed private TLS mode exists', () => {
    expect(() => loadAdminConfig(environment({ ADMIN_ORIGIN: 'https://127.0.0.1:3004' }))).toThrow(
      'Invalid admin configuration: ADMIN_ORIGIN',
    );
  });
});
