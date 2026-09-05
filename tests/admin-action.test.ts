import { describe, expect, test } from 'vitest';
import { signAdminAction, verifyAdminAction } from '../src/admin/admin-action.js';
import { AdminSecretBytes, AdminSecretText } from '../src/admin/admin-types.js';

const key = new AdminSecretBytes(Buffer.alloc(32, 0x51));
const session = new AdminSecretText('synthetic-session-action');
const at = new Date('2026-09-05T06:00:00.000Z');
const action = {
  action: 'publish',
  reference: 'VERSION_TEST_target',
  priorVersionRef: 'VERSION_TEST_prior',
  requestKey: 'REQUEST_TEST_publication',
  effectiveAt: at.toISOString(),
  expiresAt: at.getTime() + 60000,
} as const;

describe('signed admin action', () => {
  test('preserves exact request material across retries and binds it to the session', () => {
    const token = signAdminAction(action, session, key);
    expect(verifyAdminAction(token, session, key, at)).toEqual(action);
    expect(verifyAdminAction(token, session, key, at)).toEqual(action);
    expect(
      verifyAdminAction(token, new AdminSecretText('synthetic-other-session'), key, at),
    ).toBeUndefined();
  });
  test('rejects tampering, expiry, malformed input, and wrong keys without content in errors', () => {
    const token = signAdminAction(action, session, key);
    expect(verifyAdminAction(`x${token}`, session, key, at)).toBeUndefined();
    expect(verifyAdminAction(token, session, key, new Date(action.expiresAt))).toBeUndefined();
    expect(
      verifyAdminAction(token, session, new AdminSecretBytes(Buffer.alloc(32, 0x52)), at),
    ).toBeUndefined();
    expect(verifyAdminAction('synthetic-malformed', session, key, at)).toBeUndefined();
  });
});
