import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import type {
  ChannelIdentitySelector,
  PrivacyHmacKey,
  PrivacyHmacKeyring,
} from './policy-types.js';

const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const minimumKeyBytes = 32;

function encode(parts: readonly string[]): Buffer {
  return Buffer.concat(
    parts.flatMap((part) => {
      const value = Buffer.from(part, 'utf8');
      const size = Buffer.allocUnsafe(4);
      size.writeUInt32BE(value.byteLength);
      return [size, value];
    }),
  );
}

function requireKey(key: PrivacyHmacKey): void {
  if (!keyVersionPattern.test(key.version) || !Buffer.isBuffer(key.key)) {
    throw new TypeError('Privacy HMAC key is invalid');
  }
  if (key.key.byteLength < minimumKeyBytes) {
    throw new TypeError('Privacy HMAC key is too short');
  }
}

function digest(parts: readonly string[], key: PrivacyHmacKey): string {
  requireKey(key);
  return createHmac('sha256', key.key).update(encode(parts)).digest('hex');
}

export function createIdentityHmac(identity: ChannelIdentitySelector, key: PrivacyHmacKey): string {
  return digest(
    [
      'fcd-support',
      'deletion-identity',
      'v1',
      identity.channel,
      identity.channelAccountId,
      identity.externalContactId,
    ],
    key,
  );
}

export function createReplayHmac(idempotencyKey: string, key: PrivacyHmacKey): string {
  return digest(['fcd-support', 'deletion-replay', 'v1', idempotencyKey], key);
}

export function requirePrivacyHmacKeyring(input: unknown): PrivacyHmacKeyring {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Privacy HMAC keyring is invalid');
  }

  const candidate = input as { readonly activeVersion?: unknown; readonly keys?: unknown };
  if (typeof candidate.activeVersion !== 'string' || !(candidate.keys instanceof Map)) {
    throw new TypeError('Privacy HMAC keyring is invalid');
  }
  if (!keyVersionPattern.test(candidate.activeVersion)) {
    throw new TypeError('Privacy HMAC active version is invalid');
  }

  const copiedKeys = new Map<string, Buffer>();
  for (const [version, value] of candidate.keys.entries() as Iterable<[unknown, unknown]>) {
    if (typeof version !== 'string' || !Buffer.isBuffer(value)) {
      throw new TypeError('Privacy HMAC key entry is invalid');
    }
    requireKey({ key: value, version });
    copiedKeys.set(version, Buffer.from(value));
  }
  if (!copiedKeys.has(candidate.activeVersion)) {
    throw new TypeError('Privacy HMAC active key is missing');
  }

  return { activeVersion: candidate.activeVersion, keys: copiedKeys };
}
