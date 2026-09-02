import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AdminSecretBytes, AdminSecretText } from './admin-types.js';

type RandomBytesSource = (size: number) => Buffer;

export function createAdminSessionToken(
  randomSource: RandomBytesSource = randomBytes,
): AdminSecretText {
  const bytes = randomSource(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new TypeError('Admin session token source is invalid');
  }
  try {
    return new AdminSecretText(bytes.toString('base64url'));
  } finally {
    bytes.fill(0);
  }
}

export function hashAdminSessionToken(
  token: AdminSecretText,
  hmacKey: AdminSecretBytes,
  context = 'admin-session-v1',
): AdminSecretBytes {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(context)) {
    throw new TypeError('Admin token hash context is invalid');
  }
  const key = hmacKey.copy();
  if (key.length < 32) throw new TypeError('Admin token HMAC key is invalid');
  try {
    return new AdminSecretBytes(
      createHmac('sha256', key)
        .update(context, 'utf8')
        .update('\u0000')
        .update(token.reveal())
        .digest(),
    );
  } finally {
    key.fill(0);
  }
}

export function sessionHashMatches(
  token: AdminSecretText,
  hmacKey: AdminSecretBytes,
  storedHash: AdminSecretBytes,
  context = 'admin-session-v1',
): boolean {
  const candidate = hashAdminSessionToken(token, hmacKey, context).copy();
  const stored = storedHash.copy();
  try {
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  } finally {
    candidate.fill(0);
    stored.fill(0);
  }
}
