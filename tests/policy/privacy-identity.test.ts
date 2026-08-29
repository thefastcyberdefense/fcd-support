import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'vitest';

import {
  createIdentityHmac,
  createReplayHmac,
  requirePrivacyHmacKeyring,
} from '../../src/policy/privacy-identity.js';

const privacyKey = {
  key: Buffer.alloc(32, 0x31),
  version: 'TEST_v1',
} as const;

const identity = {
  channel: 'whatsapp',
  channelAccountId: 'synthetic-account-a',
  externalContactId: 'synthetic-contact-a',
} as const;

describe('privacy identity HMAC domains', () => {
  test('uses the canonical length-prefixed identity encoding', () => {
    expect(createIdentityHmac(identity, privacyKey)).toBe(
      'd3e9ec34b39f3cfa12fe25e0fcdf82d6bee714ff54dd47dd9d155d1736e1f8d7',
    );
  });

  test('separates channel, account, contact, and replay material', () => {
    const values = [
      createIdentityHmac(identity, privacyKey),
      createIdentityHmac({ ...identity, channel: 'messenger' }, privacyKey),
      createIdentityHmac({ ...identity, channelAccountId: 'synthetic-account-b' }, privacyKey),
      createIdentityHmac({ ...identity, externalContactId: 'synthetic-contact-b' }, privacyKey),
      createReplayHmac('synthetic-replay-key', privacyKey),
    ];

    expect(new Set(values)).toHaveLength(values.length);
    expect(values.every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(values.join(':')).not.toContain(identity.channelAccountId);
    expect(values.join(':')).not.toContain(identity.externalContactId);
    expect(values.at(-1)).toBe('effb522d3c5c39e4c4583c4976bfb86e89ed29943e5f46588a826fd0de224281');
  });
});

describe('privacy HMAC keyring validation', () => {
  test('copies a valid keyring so callers cannot replace its map entries', () => {
    const source = new Map([['TEST_v1', Buffer.alloc(32, 0x31)]]);
    const parsed = requirePrivacyHmacKeyring({ activeVersion: 'TEST_v1', keys: source });
    source.set('TEST_v1', Buffer.alloc(32, 0x32));

    expect(parsed.activeVersion).toBe('TEST_v1');
    expect(parsed.keys.get('TEST_v1')).toEqual(Buffer.alloc(32, 0x31));
  });

  test.each([
    { activeVersion: 'TEST_v1', keys: new Map() },
    { activeVersion: 'bad version', keys: new Map([['bad version', Buffer.alloc(32)]]) },
    { activeVersion: 'TEST_v1', keys: new Map([['TEST_v1', Buffer.alloc(31)]]) },
    { activeVersion: 'TEST_v1', keys: { TEST_v1: Buffer.alloc(32) } },
  ])('rejects an unusable keyring before persistence', (candidate) => {
    expect(() => requirePrivacyHmacKeyring(candidate)).toThrow();
  });
});
