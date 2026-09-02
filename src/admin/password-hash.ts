import { Buffer } from 'node:buffer';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { AdminSecretBytes } from './admin-types.js';

export interface AdminPasswordPolicy {
  readonly algorithm: 'scrypt_v1';
  readonly blockSize: number;
  readonly cost: number;
  readonly keyLength: number;
  readonly parallelization: number;
  readonly saltLength: number;
}

export interface AdminPasswordHash {
  readonly algorithm: 'scrypt_v1';
  readonly blockSize: number;
  readonly cost: number;
  readonly hash: AdminSecretBytes;
  readonly keyLength: number;
  readonly parallelization: number;
  readonly salt: AdminSecretBytes;
}

export interface AdminPasswordVerification {
  readonly needsUpgrade: boolean;
  readonly valid: boolean;
}

type RandomBytesSource = (size: number) => Buffer;

function requirePolicy(policy: AdminPasswordPolicy): void {
  const costIsPowerOfTwo = policy.cost > 1 && (policy.cost & (policy.cost - 1)) === 0;
  if (
    !costIsPowerOfTwo ||
    policy.cost < 16_384 ||
    policy.cost > 262_144 ||
    !Number.isInteger(policy.blockSize) ||
    policy.blockSize < 8 ||
    policy.blockSize > 16 ||
    !Number.isInteger(policy.parallelization) ||
    policy.parallelization < 1 ||
    policy.parallelization > 4 ||
    !Number.isInteger(policy.keyLength) ||
    policy.keyLength < 32 ||
    policy.keyLength > 64 ||
    !Number.isInteger(policy.saltLength) ||
    policy.saltLength < 16 ||
    policy.saltLength > 64
  ) {
    throw new TypeError('Admin password policy is invalid');
  }
}

function requirePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) {
    throw new TypeError('Admin password is invalid');
  }
}

function derivePassword(
  password: string,
  salt: Buffer,
  policy: Pick<AdminPasswordPolicy, 'blockSize' | 'cost' | 'keyLength' | 'parallelization'>,
): Promise<Buffer> {
  const maxmem = 128 * policy.cost * policy.blockSize + 128 * policy.blockSize + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      policy.keyLength,
      {
        N: policy.cost,
        maxmem,
        p: policy.parallelization,
        r: policy.blockSize,
      },
      (error, derivedKey) => {
        if (error === null) resolve(Buffer.from(derivedKey));
        else reject(error);
      },
    );
  });
}

export async function hashAdminPassword(
  password: string,
  policy: AdminPasswordPolicy,
  randomSource: RandomBytesSource = randomBytes,
): Promise<AdminPasswordHash> {
  requirePassword(password);
  requirePolicy(policy);
  const salt = randomSource(policy.saltLength);
  if (!Buffer.isBuffer(salt) || salt.length !== policy.saltLength) {
    throw new TypeError('Admin password salt source is invalid');
  }
  const hash = await derivePassword(password, salt, policy);
  const result = {
    algorithm: policy.algorithm,
    blockSize: policy.blockSize,
    cost: policy.cost,
    hash: new AdminSecretBytes(hash),
    keyLength: policy.keyLength,
    parallelization: policy.parallelization,
    salt: new AdminSecretBytes(salt),
  };
  hash.fill(0);
  salt.fill(0);
  return result;
}

export async function verifyAdminPassword(
  password: string,
  stored: AdminPasswordHash,
  currentPolicy: AdminPasswordPolicy,
): Promise<AdminPasswordVerification> {
  requirePassword(password);
  requirePolicy(currentPolicy);
  const storedPolicy = {
    algorithm: stored.algorithm,
    blockSize: stored.blockSize,
    cost: stored.cost,
    keyLength: stored.keyLength,
    parallelization: stored.parallelization,
    saltLength: stored.salt.copy().length,
  } satisfies AdminPasswordPolicy;
  requirePolicy(storedPolicy);
  const salt = stored.salt.copy();
  const expected = stored.hash.copy();
  try {
    const candidate = await derivePassword(password, salt, storedPolicy);
    const valid = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    candidate.fill(0);
    return {
      needsUpgrade:
        valid &&
        (stored.cost < currentPolicy.cost ||
          stored.blockSize < currentPolicy.blockSize ||
          stored.parallelization < currentPolicy.parallelization ||
          stored.keyLength < currentPolicy.keyLength ||
          salt.length < currentPolicy.saltLength),
      valid,
    };
  } finally {
    salt.fill(0);
    expected.fill(0);
  }
}
