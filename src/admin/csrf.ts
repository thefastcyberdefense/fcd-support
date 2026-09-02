import { AdminSecretBytes, AdminSecretText } from './admin-types.js';
import { createAdminSessionToken, sessionHashMatches } from './session-token.js';

export function createAdminCsrfToken(): AdminSecretText {
  return createAdminSessionToken();
}

interface ValidateAdminCsrfInput {
  readonly expectedOrigin: string;
  readonly hmacKey: AdminSecretBytes;
  readonly providedToken: AdminSecretText;
  readonly requestOrigin?: string | undefined;
  readonly storedHash: AdminSecretBytes;
}

export function validateAdminCsrf(input: ValidateAdminCsrfInput): boolean {
  if (typeof input.requestOrigin !== 'string') return false;
  try {
    const expected = new URL(input.expectedOrigin);
    const provided = new URL(input.requestOrigin);
    if (
      expected.origin !== input.expectedOrigin ||
      provided.origin !== input.requestOrigin ||
      expected.origin !== provided.origin
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return sessionHashMatches(input.providedToken, input.hmacKey, input.storedHash, 'admin-csrf-v1');
}
