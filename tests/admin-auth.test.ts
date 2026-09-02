import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'vitest';

import { AdminSecretBytes } from '../src/admin/admin-types.js';
import {
  hashAdminPassword,
  verifyAdminPassword,
  type AdminPasswordPolicy,
} from '../src/admin/password-hash.js';
import {
  AesGcmAdminSecretProtector,
  generateTotpCode,
  protectMfaSeed,
  verifyTotpCode,
  type TotpPolicy,
} from '../src/admin/mfa.js';
import {
  createAdminSessionToken,
  hashAdminSessionToken,
  sessionHashMatches,
} from '../src/admin/session-token.js';
import { createAdminCsrfToken, validateAdminCsrf } from '../src/admin/csrf.js';

const passwordPolicy = {
  algorithm: 'scrypt_v1',
  blockSize: 8,
  cost: 16_384,
  keyLength: 32,
  parallelization: 1,
  saltLength: 16,
} satisfies AdminPasswordPolicy;

const totpPolicy = {
  algorithm: 'sha1',
  digits: 6,
  periodSeconds: 30,
  verificationWindow: 1,
} satisfies TotpPolicy;

describe('admin password hashing', () => {
  test('create unique salted scrypt hashes and verify only the exact password', async () => {
    const first = await hashAdminPassword('Synthetic strong passphrase 41!', passwordPolicy);
    const second = await hashAdminPassword('Synthetic strong passphrase 41!', passwordPolicy);

    expect(first.salt.copy()).not.toEqual(second.salt.copy());
    await expect(
      verifyAdminPassword('Synthetic strong passphrase 41!', first, passwordPolicy),
    ).resolves.toEqual({ needsUpgrade: false, valid: true });
    await expect(
      verifyAdminPassword('Synthetic wrong passphrase 41!', first, passwordPolicy),
    ).resolves.toEqual({ needsUpgrade: false, valid: false });
  });

  test('reject tampered hashes and report policy upgrades after valid verification', async () => {
    const stored = await hashAdminPassword('Synthetic strong passphrase 42!', passwordPolicy);
    const tamperedBytes = stored.hash.copy();
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...stored, hash: new AdminSecretBytes(tamperedBytes) };
    const strongerPolicy = { ...passwordPolicy, cost: 32_768 } satisfies AdminPasswordPolicy;

    await expect(
      verifyAdminPassword('Synthetic strong passphrase 42!', tampered, passwordPolicy),
    ).resolves.toEqual({ needsUpgrade: false, valid: false });
    await expect(
      verifyAdminPassword('Synthetic strong passphrase 42!', stored, strongerPolicy),
    ).resolves.toEqual({ needsUpgrade: true, valid: true });
  });

  test('redact password hash material during serialization', async () => {
    const stored = await hashAdminPassword('Synthetic strong passphrase 43!', passwordPolicy);
    const serialized = JSON.stringify(stored);

    expect(serialized).not.toContain(stored.hash.copy().toString('hex'));
    expect(serialized).not.toContain(stored.salt.copy().toString('hex'));
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('admin MFA', () => {
  test('verify a current TOTP once and reject replay or an outside window', () => {
    const encryptionKey = new AdminSecretBytes(Buffer.alloc(32, 0x51));
    const seed = new AdminSecretBytes(Buffer.from('synthetic-totp-seed-material', 'utf8'));
    const protector = new AesGcmAdminSecretProtector('TEST_KEY_v1', encryptionKey);
    const protectedSeed = protectMfaSeed(seed, protector, () => Buffer.alloc(12, 0x52));
    const at = new Date('2026-09-01T12:00:00.000Z');
    const code = generateTotpCode(seed, at, totpPolicy);

    const accepted = verifyTotpCode({
      at,
      code,
      lastAcceptedCounter: null,
      policy: totpPolicy,
      protectedSeed,
      protector,
    });
    expect(accepted).toMatchObject({ valid: true });
    if (!accepted.valid) throw new Error('Synthetic current TOTP was not accepted');
    expect(
      verifyTotpCode({
        at,
        code,
        lastAcceptedCounter: accepted.counter,
        policy: totpPolicy,
        protectedSeed,
        protector,
      }),
    ).toEqual({ valid: false });
    expect(
      verifyTotpCode({
        at: new Date(at.getTime() + 90_000),
        code,
        lastAcceptedCounter: null,
        policy: totpPolicy,
        protectedSeed,
        protector,
      }),
    ).toEqual({ valid: false });
  });

  test('fail closed when encrypted MFA material is tampered or uses another key version', () => {
    const key = new AdminSecretBytes(Buffer.alloc(32, 0x61));
    const protector = new AesGcmAdminSecretProtector('TEST_KEY_v1', key);
    const protectedSeed = protectMfaSeed(
      new AdminSecretBytes(Buffer.from('synthetic-mfa-seed', 'utf8')),
      protector,
      () => Buffer.alloc(12, 0x62),
    );
    const tamperedCiphertext = protectedSeed.encryptedMaterial.copy();
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;

    expect(() =>
      protector.decrypt({
        ...protectedSeed,
        encryptedMaterial: new AdminSecretBytes(tamperedCiphertext),
      }),
    ).toThrow('Protected admin secret is invalid');
    expect(() => new AesGcmAdminSecretProtector('TEST_KEY_v2', key).decrypt(protectedSeed)).toThrow(
      'Protected admin secret is invalid',
    );
    expect(JSON.stringify(protectedSeed)).not.toContain(
      protectedSeed.encryptedMaterial.copy().toString('hex'),
    );
  });
});

describe('admin session and CSRF tokens', () => {
  test('create distinct high-entropy session tokens and compare only keyed hashes', () => {
    const key = new AdminSecretBytes(Buffer.alloc(32, 0x71));
    const first = createAdminSessionToken();
    const second = createAdminSessionToken();
    const stored = hashAdminSessionToken(first, key);

    expect(first.reveal()).not.toBe(second.reveal());
    expect(first.reveal()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionHashMatches(first, key, stored)).toBe(true);
    expect(sessionHashMatches(second, key, stored)).toBe(false);
    expect(JSON.stringify({ first, stored })).toBe('{"first":"[REDACTED]","stored":"[REDACTED]"}');
  });

  test('require an exact allowed origin and CSRF token hash', () => {
    const key = new AdminSecretBytes(Buffer.alloc(32, 0x72));
    const token = createAdminCsrfToken();
    const storedHash = hashAdminSessionToken(token, key, 'admin-csrf-v1');
    const base = {
      expectedOrigin: 'http://127.0.0.1:3004',
      hmacKey: key,
      providedToken: token,
      requestOrigin: 'http://127.0.0.1:3004',
      storedHash,
    };

    expect(validateAdminCsrf(base)).toBe(true);
    expect(validateAdminCsrf({ ...base, requestOrigin: 'https://example.invalid' })).toBe(false);
    expect(validateAdminCsrf({ ...base, providedToken: createAdminCsrfToken() })).toBe(false);
    expect(validateAdminCsrf({ ...base, requestOrigin: undefined })).toBe(false);
  });
});
