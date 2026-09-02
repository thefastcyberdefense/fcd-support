import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';

const redacted = '[REDACTED]';

export class AdminSecretBytes {
  readonly #bytes: Buffer;

  public constructor(bytes: Buffer) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new TypeError('Admin secret bytes are invalid');
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

export class AdminSecretText {
  readonly #value: string;

  public constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Admin secret text is invalid');
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
