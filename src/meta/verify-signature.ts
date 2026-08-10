import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyMetaSignatureInput {
  readonly appSecret: string;
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
}

const META_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

export function verifyMetaSignature({
  appSecret,
  rawBody,
  signatureHeader,
}: VerifyMetaSignatureInput): boolean {
  if (appSecret.length === 0 || signatureHeader === undefined) {
    return false;
  }

  const match = META_SIGNATURE_PATTERN.exec(signatureHeader);
  const receivedHex = match?.[1];

  if (receivedHex === undefined) {
    return false;
  }

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, 'hex');

  return received.length === expected.length && timingSafeEqual(received, expected);
}
