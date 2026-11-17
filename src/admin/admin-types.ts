import { Buffer } from 'node:buffer';

import { SecretBytes, SecretText } from '../safety/secret-bytes.js';

export class AdminSecretBytes extends SecretBytes {
  public constructor(bytes: Buffer) {
    super(bytes, 'Admin secret bytes are invalid');
  }
}

export class AdminSecretText extends SecretText {
  public constructor(value: string) {
    super(value, 'Admin secret text is invalid');
  }
}
