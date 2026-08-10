export type MetaSubscriptionVerification =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false; readonly statusCode: 403 };

type MetaVerificationQuery = Readonly<Record<string, unknown>>;

export function verifyMetaSubscription(
  query: MetaVerificationQuery,
  expectedToken: string,
): MetaSubscriptionVerification {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (
    mode !== 'subscribe' ||
    typeof token !== 'string' ||
    token !== expectedToken ||
    typeof challenge !== 'string'
  ) {
    return { ok: false, statusCode: 403 };
  }

  return { ok: true, challenge };
}
