import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { AdminSecretBytes } from './admin-types.js';

export interface ProtectedMfaSeed {
  readonly authenticationTag: AdminSecretBytes;
  readonly encryptedMaterial: AdminSecretBytes;
  readonly encryptionNonce: AdminSecretBytes;
  readonly keyVersion: string;
}

export interface AdminSecretProtector {
  readonly decrypt: (protectedMaterial: ProtectedMfaSeed) => AdminSecretBytes;
  readonly encrypt: (
    material: AdminSecretBytes,
    nonceSource?: (size: number) => Buffer,
  ) => ProtectedMfaSeed;
}

export interface TotpPolicy {
  readonly algorithm: 'sha1';
  readonly digits: number;
  readonly periodSeconds: number;
  readonly verificationWindow: number;
}

interface VerifyTotpInput {
  readonly at: Date;
  readonly code: string;
  readonly lastAcceptedCounter: number | null;
  readonly policy: TotpPolicy;
  readonly protectedSeed: ProtectedMfaSeed;
  readonly protector: AdminSecretProtector;
}

export type TotpVerification =
  { readonly counter: number; readonly valid: true } | { readonly valid: false };

function requireKeyVersion(keyVersion: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(keyVersion)) {
    throw new TypeError('Admin secret protector key version is invalid');
  }
}

function requireTotpPolicy(policy: TotpPolicy): void {
  if (
    !Number.isInteger(policy.digits) ||
    policy.digits < 6 ||
    policy.digits > 8 ||
    !Number.isInteger(policy.periodSeconds) ||
    policy.periodSeconds < 15 ||
    policy.periodSeconds > 120 ||
    !Number.isInteger(policy.verificationWindow) ||
    policy.verificationWindow < 0 ||
    policy.verificationWindow > 2
  ) {
    throw new TypeError('TOTP policy is invalid');
  }
}

function requireDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('TOTP time is invalid');
  }
}

function counterAt(at: Date, periodSeconds: number): number {
  return Math.floor(at.getTime() / 1000 / periodSeconds);
}

function codeForCounter(seed: AdminSecretBytes, counter: number, policy: TotpPolicy): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const seedBytes = seed.copy();
  try {
    const digest = createHmac(policy.algorithm, seedBytes).update(counterBytes).digest();
    const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
    const binary =
      (((digest[offset] ?? 0) & 0x7f) << 24) |
      ((digest[offset + 1] ?? 0) << 16) |
      ((digest[offset + 2] ?? 0) << 8) |
      (digest[offset + 3] ?? 0);
    return String(binary % 10 ** policy.digits).padStart(policy.digits, '0');
  } finally {
    seedBytes.fill(0);
    counterBytes.fill(0);
  }
}

export class AesGcmAdminSecretProtector implements AdminSecretProtector {
  readonly #key: Buffer;

  public constructor(
    private readonly keyVersion: string,
    key: AdminSecretBytes,
  ) {
    requireKeyVersion(keyVersion);
    const keyBytes = key.copy();
    if (keyBytes.length !== 32) throw new TypeError('Admin secret protector key is invalid');
    this.#key = keyBytes;
  }

  public encrypt(
    material: AdminSecretBytes,
    nonceSource: (size: number) => Buffer = randomBytes,
  ): ProtectedMfaSeed {
    const nonce = nonceSource(12);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
      throw new TypeError('Admin secret protector nonce is invalid');
    }
    const plaintext = material.copy();
    try {
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(Buffer.from(`fcd-support-admin-mfa:${this.keyVersion}`, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        authenticationTag: new AdminSecretBytes(cipher.getAuthTag()),
        encryptedMaterial: new AdminSecretBytes(encrypted),
        encryptionNonce: new AdminSecretBytes(nonce),
        keyVersion: this.keyVersion,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  public decrypt(protectedMaterial: ProtectedMfaSeed): AdminSecretBytes {
    if (protectedMaterial.keyVersion !== this.keyVersion) {
      throw new TypeError('Protected admin secret is invalid');
    }
    const nonce = protectedMaterial.encryptionNonce.copy();
    const tag = protectedMaterial.authenticationTag.copy();
    const encrypted = protectedMaterial.encryptedMaterial.copy();
    try {
      if (nonce.length !== 12 || tag.length !== 16 || encrypted.length === 0) {
        throw new TypeError('Protected admin secret is invalid');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(Buffer.from(`fcd-support-admin-mfa:${this.keyVersion}`, 'utf8'));
      decipher.setAuthTag(tag);
      return new AdminSecretBytes(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    } catch {
      throw new TypeError('Protected admin secret is invalid');
    } finally {
      nonce.fill(0);
      tag.fill(0);
      encrypted.fill(0);
    }
  }
}

export function protectMfaSeed(
  seed: AdminSecretBytes,
  protector: AdminSecretProtector,
  nonceSource?: (size: number) => Buffer,
): ProtectedMfaSeed {
  return protector.encrypt(seed, nonceSource);
}

export function generateTotpCode(seed: AdminSecretBytes, at: Date, policy: TotpPolicy): string {
  requireDate(at);
  requireTotpPolicy(policy);
  return codeForCounter(seed, counterAt(at, policy.periodSeconds), policy);
}

export function verifyTotpCode(input: VerifyTotpInput): TotpVerification {
  requireDate(input.at);
  requireTotpPolicy(input.policy);
  if (!new RegExp(`^[0-9]{${String(input.policy.digits)}}$`).test(input.code)) {
    return { valid: false };
  }
  const currentCounter = counterAt(input.at, input.policy.periodSeconds);
  const supplied = Buffer.from(input.code, 'ascii');
  const seed = input.protector.decrypt(input.protectedSeed);
  try {
    for (
      let offset = -input.policy.verificationWindow;
      offset <= input.policy.verificationWindow;
      offset += 1
    ) {
      const candidateCounter = currentCounter + offset;
      if (candidateCounter < 0 || candidateCounter <= (input.lastAcceptedCounter ?? -1)) continue;
      const expected = Buffer.from(codeForCounter(seed, candidateCounter, input.policy), 'ascii');
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
        return { counter: candidateCounter, valid: true };
      }
    }
    return { valid: false };
  } finally {
    supplied.fill(0);
  }
}
