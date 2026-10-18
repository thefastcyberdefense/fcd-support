import { inspect } from 'node:util';

import { z } from 'zod';

import type { PrivacyHmacKeyring } from '../policy/policy-types.js';

const redacted = '[REDACTED]';
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const schema = z.strictObject({
  activeVersion: version,
  keys: z
    .array(
      z.strictObject({
        version,
        keyBase64url: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      }),
    )
    .min(1),
});

class PrivateKeyMap extends Map<string, Buffer> {
  public constructor(entries: readonly (readonly [string, Buffer])[]) {
    super();
    for (const [key, value] of entries) Map.prototype.set.call(this, key, value);
  }
  public override set(): this {
    throw new TypeError('privacy_keyring_immutable');
  }
  public override delete(): boolean {
    throw new TypeError('privacy_keyring_immutable');
  }
  public override clear(): void {
    throw new TypeError('privacy_keyring_immutable');
  }
  public toJSON(): string {
    return redacted;
  }
  public override toString(): string {
    return redacted;
  }
  public [inspect.custom](): string {
    return redacted;
  }
}

export function loadPrivacyKeyring(bytes: Uint8Array): PrivacyHmacKeyring {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 65536) {
      throw new TypeError('invalid');
    }
    const value = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const versions = new Set(value.keys.map((key) => key.version));
    if (versions.size !== value.keys.length || !versions.has(value.activeVersion))
      throw new TypeError('invalid');
    const entries = value.keys.map((key) => {
      const decoded = Buffer.from(key.keyBase64url, 'base64url');
      if (decoded.length !== 32 || decoded.toString('base64url') !== key.keyBase64url) {
        decoded.fill(0);
        throw new TypeError('invalid');
      }
      return [key.version, decoded] as const;
    });
    return Object.freeze({
      activeVersion: value.activeVersion,
      keys: new PrivateKeyMap(entries),
      toJSON: () => redacted,
      toString: () => redacted,
      [inspect.custom]: () => redacted,
    });
  } catch {
    throw new TypeError('privacy_keyring_invalid');
  }
}
