import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { SecretBytes, SecretText } from '../safety/secret-bytes.js';
import type { ProtectedGatewayApiKey } from './gateway-types.js';

const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const gatewayRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const encodedKeyPattern = /^[A-Za-z0-9_-]{43}$/u;

export function decodeGatewayEncryptionKey(encoded: string): SecretBytes {
  if (!encodedKeyPattern.test(encoded)) {
    throw new TypeError('Gateway encryption key format is invalid');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 32) {
    bytes.fill(0);
    throw new TypeError('Gateway encryption key length is invalid');
  }
  try {
    return new SecretBytes(bytes, 'Gateway encryption key is invalid');
  } finally {
    bytes.fill(0);
  }
}

export class AesGcmGatewaySecretProtector {
  readonly #key: Buffer;
  public readonly keyVersion: string;

  public constructor(keyVersion: string, key: SecretBytes) {
    if (!keyVersionPattern.test(keyVersion)) {
      throw new TypeError('Gateway encryption key version is invalid');
    }
    const keyBytes = key.copy();
    if (keyBytes.length !== 32) {
      keyBytes.fill(0);
      throw new TypeError('Gateway encryption key is invalid');
    }
    this.keyVersion = keyVersion;
    this.#key = keyBytes;
  }

  public encrypt(
    apiKey: SecretText,
    gatewayRef: string,
    nonceSource: (size: number) => Buffer = randomBytes,
  ): ProtectedGatewayApiKey {
    if (!gatewayRefPattern.test(gatewayRef)) {
      throw new TypeError('Gateway profile reference is invalid');
    }
    const rawText = apiKey.reveal().trim();
    if (!/^\S{8,4096}$/u.test(rawText)) {
      throw new TypeError('Gateway API key format is invalid');
    }
    const nonce = nonceSource(12);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
      throw new TypeError('Gateway encryption nonce is invalid');
    }
    const plaintext = Buffer.from(rawText, 'utf8');
    try {
      const apiKeySha256 = createHash('sha256').update(plaintext).digest('hex');
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(
        Buffer.from(`fcd-support-model-gateway:${this.keyVersion}:${gatewayRef}`, 'utf8'),
      );
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        apiKeySha256,
        authenticationTag: new SecretBytes(cipher.getAuthTag()),
        encryptedMaterial: new SecretBytes(encrypted),
        encryptionNonce: new SecretBytes(nonce),
        keyVersion: this.keyVersion,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  public decrypt(protectedSecret: ProtectedGatewayApiKey, gatewayRef: string): SecretText {
    if (!gatewayRefPattern.test(gatewayRef) || protectedSecret.keyVersion !== this.keyVersion) {
      throw new TypeError('Protected gateway secret is invalid');
    }
    const nonce = protectedSecret.encryptionNonce.copy();
    const tag = protectedSecret.authenticationTag.copy();
    const encrypted = protectedSecret.encryptedMaterial.copy();
    let decrypted: Buffer | undefined;
    try {
      if (
        nonce.length !== 12 ||
        tag.length !== 16 ||
        encrypted.length < 8 ||
        encrypted.length > 4096
      ) {
        throw new TypeError('Protected gateway secret is invalid');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(
        Buffer.from(`fcd-support-model-gateway:${this.keyVersion}:${gatewayRef}`, 'utf8'),
      );
      decipher.setAuthTag(tag);
      decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const plaintext = decrypted.toString('utf8');
      if (!/^\S{8,4096}$/u.test(plaintext)) {
        throw new TypeError('Protected gateway secret is invalid');
      }
      return new SecretText(plaintext, 'Protected gateway secret is invalid');
    } catch {
      throw new TypeError('Protected gateway secret is invalid');
    } finally {
      nonce.fill(0);
      tag.fill(0);
      encrypted.fill(0);
      decrypted?.fill(0);
    }
  }
}
