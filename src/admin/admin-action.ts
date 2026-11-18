import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AdminSecretBytes, AdminSecretText } from './admin-types.js';

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const actionSchema = z.strictObject({
  action: z.enum([
    'create',
    'submit',
    'approve',
    'reject',
    'publish',
    'retire',
    'rollback',
    'answer',
    'policy_create',
    'policy_submit',
    'policy_approve',
    'policy_activate',
    'policy_retire',
    'gateway_create',
    'gateway_test',
    'gateway_activate',
    'gateway_retire',
    'incident_acknowledge',
    'staff_create',
    'staff_role_assign',
    'staff_role_revoke',
    'staff_revoke_sessions',
    'staff_disable',
    'pause_apply',
    'pause_resume',
    'deletion_review',
    'deletion_execute',
    'privacy_review',
    'privacy_collect',
    'privacy_correct',
    'privacy_attest',
    'consent_record',
    'marketing_reopt_in',
    'outbound_policy_create',
    'outbound_policy_submit',
    'outbound_policy_approve',
    'outbound_policy_activate',
    'outbound_policy_retire',
    'outbound_template_create',
    'outbound_template_submit',
    'outbound_template_approve',
    'outbound_template_activate',
    'outbound_template_retire',
    'knowledge_import',
    'question_dismiss',
    'insights_aggregate',
    'insights_digest',
  ]),
  reference,
  priorVersionRef: reference.optional(),
  requestKey: reference,
  effectiveAt: z.iso.datetime(),
  expiresAt: z.number().int().positive(),
});
export type AdminAction = z.infer<typeof actionSchema>;
export type AdminActionKind = AdminAction['action'];

function signature(payload: string, session: AdminSecretText, key: AdminSecretBytes): Buffer {
  const bytes = key.copy();
  try {
    if (bytes.length < 32) throw new TypeError('Admin action key is invalid');
    return createHmac('sha256', bytes)
      .update('fcd-admin-action-v1\0')
      .update(session.reveal())
      .update('\0')
      .update(payload)
      .digest();
  } finally {
    bytes.fill(0);
  }
}

export function signAdminAction(
  input: AdminAction,
  session: AdminSecretText,
  key: AdminSecretBytes,
): string {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Admin action is invalid');
  const payload = Buffer.from(JSON.stringify(parsed.data)).toString('base64url');
  return `${payload}.${signature(payload, session, key).toString('base64url')}`;
}

export function verifyAdminAction(
  token: string,
  session: AdminSecretText,
  key: AdminSecretBytes,
  at: Date,
): AdminAction | undefined {
  if (token.length > 4096 || !Number.isFinite(at.getTime())) return undefined;
  const parts = token.split('.');
  const [payload, encodedSignature] = parts;
  if (
    parts.length !== 2 ||
    payload === undefined ||
    encodedSignature === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(payload)
  )
    return undefined;
  try {
    const received = Buffer.from(encodedSignature, 'base64url');
    const expected = signature(payload, session, key);
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return undefined;
    const input: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const parsed = actionSchema.safeParse(input);
    return parsed.success && at.getTime() < parsed.data.expiresAt ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
