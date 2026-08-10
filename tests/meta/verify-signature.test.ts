import { describe, expect, test } from 'vitest';

import { verifyMetaSignature } from '../../src/meta/verify-signature.js';

describe('verifyMetaSignature', () => {
  test('accepts the published HMAC-SHA256 test vector', () => {
    const result = verifyMetaSignature({
      appSecret: "It's a Secret to Everybody",
      rawBody: Buffer.from('Hello, World!', 'utf8'),
      signatureHeader: 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    });

    expect(result).toBe(true);
  });

  test('accepts a signature computed from the unmodified Unicode bytes', () => {
    const result = verifyMetaSignature({
      appSecret: 'test_app_secret',
      rawBody: Buffer.from('{"message":"বাংলা"}', 'utf8'),
      signatureHeader: 'sha256=7926138d3808f8a77e0133d28b24f7a8e540960b45b4bb49a788f4349e073480',
    });

    expect(result).toBe(true);
  });

  test('rejects an altered body', () => {
    const result = verifyMetaSignature({
      appSecret: "It's a Secret to Everybody",
      rawBody: Buffer.from('Hello, World?', 'utf8'),
      signatureHeader: 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    });

    expect(result).toBe(false);
  });

  test.each([
    { name: 'missing header', signatureHeader: undefined },
    { name: 'wrong algorithm', signatureHeader: `sha1=${'a'.repeat(40)}` },
    { name: 'non-hex digest', signatureHeader: `sha256=${'z'.repeat(64)}` },
    { name: 'short digest', signatureHeader: `sha256=${'a'.repeat(62)}` },
    { name: 'long digest', signatureHeader: `sha256=${'a'.repeat(66)}` },
  ])('rejects a $name without throwing', ({ signatureHeader }) => {
    const call = () =>
      verifyMetaSignature({
        appSecret: 'test_app_secret',
        rawBody: Buffer.from('{}', 'utf8'),
        signatureHeader,
      });

    expect(call).not.toThrow();
    expect(call()).toBe(false);
  });
});
