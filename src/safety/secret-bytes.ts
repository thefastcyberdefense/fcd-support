import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';

const redacted = '[REDACTED]';

export class SecretBytes {
  readonly #bytes: Buffer;

  public constructor(bytes: Buffer, errorMessage = 'Secret bytes are invalid') {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new TypeError(errorMessage);
    }
    this.#bytes = Buffer.from(bytes);
  }

  public copy(): Buffer {
    return Buffer.from(this.#bytes);
  }

  public toJSON(): string {
    return redacted;
  }

  public toString(): string {
    return redacted;
  }

  public [inspect.custom](): string {
    return redacted;
  }
}

export class SecretText {
  readonly #value: string;

  public constructor(value: string, errorMessage = 'Secret text is invalid') {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(errorMessage);
    }
    this.#value = value;
  }

  public reveal(): string {
    return this.#value;
  }

  public toJSON(): string {
    return redacted;
  }

  public toString(): string {
    return redacted;
  }

  public [inspect.custom](): string {
    return redacted;
  }
}
