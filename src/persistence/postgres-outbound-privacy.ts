import { createHash } from 'node:crypto';

import type pg from 'pg';

export type OutboundPrivacyCancellationReason =
  'identity_deleted' | 'retention_expired' | 'suppressed' | 'restore_quarantined';

export interface OutboundPrivacyReconciliationResult {
  readonly canceled: number;
  readonly deliveryUnknown: number;
}

interface IntentRow {
  readonly conversation_id: string;
  readonly id: string;
  readonly state: string;
}

interface AttemptRow {
  readonly id: string;
  readonly intent_id: string;
  readonly state: string;
}

export async function reconcileOutboundPrivacy(
  client: pg.PoolClient,
  input: {
    readonly allowMissingTables?: boolean;
    readonly conversationIds: readonly string[];
    readonly effectiveAt: Date;
    readonly purposeCodes?: readonly string[];
    readonly reason: OutboundPrivacyCancellationReason;
    readonly templateOnly?: boolean;
  },
): Promise<OutboundPrivacyReconciliationResult> {
  if (input.conversationIds.length === 0) return { canceled: 0, deliveryUnknown: 0 };
  if (input.allowMissingTables) {
    const available = await client.query<{ readonly present: boolean }>(
      `select to_regclass('outbound_intents') is not null
          and to_regclass('outbound_attempts') is not null as present`,
    );
    if (!available.rows[0]?.present) return { canceled: 0, deliveryUnknown: 0 };
  }

  const intents = await client.query<IntentRow>(
    `select id, conversation_id, state
     from outbound_intents
     where conversation_id = any($1::bigint[])
       and ($2::text[] is null or purpose = any($2::text[]))
       and (not $3::boolean or template_version_id is not null)
       and state in ('pending', 'leased')
     order by id
     for update`,
    [input.conversationIds, input.purposeCodes ?? null, input.templateOnly ?? false],
  );
  if (intents.rows.length === 0) return { canceled: 0, deliveryUnknown: 0 };

  const intentIds = intents.rows.map(({ id }) => id);
  const attempts = await client.query<AttemptRow>(
    `select id, intent_id, state
     from outbound_attempts
     where intent_id = any($1::bigint[])
       and state in ('authorized', 'dispatch_started')
     order by id
     for update`,
    [intentIds],
  );
  const activeAttemptByIntent = new Map(
    attempts.rows.map((attempt) => [attempt.intent_id, attempt]),
  );
  let canceled = 0;
  let deliveryUnknown = 0;

  for (const intent of intents.rows) {
    const attempt = activeAttemptByIntent.get(intent.id);
    if (attempt?.state === 'dispatch_started') {
      await client.query(
        `update outbound_attempts
         set state = 'delivery_unknown', outcome_code = 'crash_after_dispatch',
             finished_at = $2
         where id = $1`,
        [attempt.id, input.effectiveAt],
      );
      await client.query(
        `update outbound_intents
         set state = 'delivery_unknown', next_attempt_at = null,
             lease_ref = null, lease_expires_at = null,
             terminal_reason = 'delivery_unknown', finished_at = $2,
             updated_at = $2
         where id = $1`,
        [intent.id, input.effectiveAt],
      );
      const digest = createHash('sha256').update(`${intent.id}:delivery_unknown`).digest('hex');
      await client.query(
        `insert into outbound_escalation_outcomes
           (escalation_ref, intent_id, conversation_id, reason_code, state,
            request_key, created_at, updated_at)
         values ($1, $2, $3, 'delivery_unknown', 'open', $4, $5, $5)
         on conflict (request_key) do nothing`,
        [
          `ESCALATION_${digest}`,
          intent.id,
          intent.conversation_id,
          `OUTBOUND_WORK_${digest}`,
          input.effectiveAt,
        ],
      );
      deliveryUnknown += 1;
      continue;
    }
    if (attempt?.state === 'authorized') {
      await client.query(
        `update outbound_attempts
         set state = 'abandoned_before_dispatch',
             outcome_code = 'aborted_before_dispatch', finished_at = $2
         where id = $1`,
        [attempt.id, input.effectiveAt],
      );
    }
    await client.query(
      `update outbound_intents
       set state = 'canceled', next_attempt_at = null,
           lease_ref = null, lease_expires_at = null,
           terminal_reason = $2, finished_at = $3, updated_at = $3
       where id = $1`,
      [intent.id, input.reason, input.effectiveAt],
    );
    canceled += 1;
  }
  return { canceled, deliveryUnknown };
}
