import { inspect } from 'node:util';

import { describe, expect, test } from 'vitest';

import { loadPrivacyKeyring } from '../src/operations/privacy-keyring.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../src/policy/privacy-identity.js';

const syntheticKey = Buffer.alloc(32, 7).toString('base64url');
function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
function keyringInput() {
  return {
    activeVersion: 'synthetic-v2',
    keys: [
      { version: 'synthetic-v1', keyBase64url: Buffer.alloc(32, 3).toString('base64url') },
      { version: 'synthetic-v2', keyBase64url: syntheticKey },
    ],
  };
}

describe('mounted privacy keyring', () => {
  test('preserves rotated versions and feeds the existing deletion HMAC contract', () => {
    const keyring = requirePrivacyHmacKeyring(loadPrivacyKeyring(bytes(keyringInput())));
    const active = keyring.keys.get('synthetic-v2');
    expect(keyring.activeVersion).toBe('synthetic-v2');
    expect(keyring.keys.size).toBe(2);
    expect(active?.byteLength).toBe(32);
    if (active === undefined) throw new Error('Missing synthetic key');
    expect(
      createIdentityHmac(
        {
          channel: 'messenger',
          channelAccountId: 'synthetic_page',
          externalContactId: 'synthetic_contact',
        },
        { key: active, version: 'synthetic-v2' },
      ),
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('hides keys from object and key-map inspection/JSON', () => {
    const keyring = loadPrivacyKeyring(bytes(keyringInput()));
    for (const output of [
      JSON.stringify(keyring),
      inspect(keyring),
      JSON.stringify(keyring.keys),
      inspect(keyring.keys),
    ]) {
      expect(output).not.toContain(syntheticKey);
      expect(output).not.toContain('<Buffer');
      expect(output).toContain('REDACTED');
    }
  });

  test.each([
    {},
    { activeVersion: 'synthetic-v1', keys: [] },
    { activeVersion: 'synthetic-absent', keys: keyringInput().keys },
    { ...keyringInput(), extra: 'synthetic_rejected_field' },
    { ...keyringInput(), keys: [...keyringInput().keys, keyringInput().keys[1]] },
    {
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: 'not base64url' }],
    },
    {
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: Buffer.alloc(31).toString('base64url') }],
    },
    {
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: Buffer.alloc(33).toString('base64url') }],
    },
    {
      activeVersion: 'bad/version',
      keys: [{ version: 'bad/version', keyBase64url: syntheticKey }],
    },
    {
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: syntheticKey, extra: true }],
    },
  ])('rejects malformed/noncanonical/missing/duplicate key material %#', (input) => {
    expect(() => loadPrivacyKeyring(bytes(input))).toThrow(/^privacy_keyring_invalid$/u);
  });

  test.each([
    new Uint8Array(),
    new Uint8Array([0xff]),
    new Uint8Array(65537),
    new TextEncoder().encode('{synthetic_invalid_json'),
  ])('fails closed on invalid input bytes %#', (input) => {
    expect(() => loadPrivacyKeyring(input)).toThrow(/^privacy_keyring_invalid$/u);
  });
});
