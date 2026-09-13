import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

export const MODEL_ESCALATION_REASON_CODES = Object.freeze([
  'model_disabled',
  'rate_limited',
  'global_limit',
  'queue_full',
  'timeout',
  'network_failure',
  'provider_failure',
  'provider_exhausted',
  'invalid_response',
  'policy_blocked',
  'database_failure',
] as const);

export type ModelEscalationReasonCode = (typeof MODEL_ESCALATION_REASON_CODES)[number];

const internalIdentifier = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const escalationInput = z.strictObject({
  conversationId: internalIdentifier,
  createdAt: z.date().refine((value) => Number.isFinite(value.getTime())),
  reasonCode: z.enum(MODEL_ESCALATION_REASON_CODES),
  requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  webhookEventId: internalIdentifier,
});

export interface SupportEscalationResult {
  readonly escalationRef: string;
  readonly reasonCode: ModelEscalationReasonCode;
  readonly status: 'applied' | 'duplicate';
}

interface EscalationRow {
  readonly conversation_id: string;
  readonly created_at: Date;
  readonly escalation_ref: string;
  readonly reason_code: ModelEscalationReasonCode;
  readonly request_key: string;
  readonly source_webhook_event_id: string;
}

function referenceFor(requestKey: string): string {
  return `ESCALATION_${createHash('sha256')
    .update(JSON.stringify(['fcd-support', 'support-escalation', requestKey]))
    .digest('hex')
    .slice(0, 48)}`;
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

export class PostgresSupportEscalation {
  public constructor(private readonly pool: TransactionSource) {}

  public async recordEscalation(inputValue: unknown): Promise<SupportEscalationResult> {
    const parsed = escalationInput.safeParse(inputValue);
    if (!parsed.success) throw new TypeError('Support escalation input is invalid');
    const input = parsed.data;

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<EscalationRow>(
        `select escalation_ref, conversation_id, source_webhook_event_id,
                reason_code, request_key, created_at
         from support_escalation_outcomes where request_key = $1 for update`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (
          row.conversation_id !== input.conversationId ||
          row.source_webhook_event_id !== input.webhookEventId ||
          row.reason_code !== input.reasonCode ||
          row.request_key !== input.requestKey ||
          !sameDate(row.created_at, input.createdAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return {
          escalationRef: row.escalation_ref,
          reasonCode: row.reason_code,
          status: 'duplicate',
        };
      }

      const source = await client.query(
        `select source.id
         from webhook_events as source
         join webhook_event_applications as application
           on application.webhook_event_id = source.id
         where source.id = $1 and application.conversation_id = $2
           and source.admission_outcome = 'pending'
           and source.event_kind = 'customer_message'
           and application.outcome = 'customer_message_applied'
           and source.occurred_at is not null and source.occurred_at <= $3
         for update of source`,
        [input.webhookEventId, input.conversationId, input.createdAt],
      );
      if (source.rowCount !== 1) {
        throw new PolicyRecordNotFoundError('Support escalation source was not found');
      }

      const escalationRef = referenceFor(input.requestKey);
      await client.query(
        `insert into support_escalation_outcomes
           (escalation_ref, conversation_id, source_webhook_event_id,
            reason_code, state, request_key, created_at, updated_at)
         values ($1,$2,$3,$4,'open',$5,$6,$6)`,
        [
          escalationRef,
          input.conversationId,
          input.webhookEventId,
          input.reasonCode,
          input.requestKey,
          input.createdAt,
        ],
      );
      return { escalationRef, reasonCode: input.reasonCode, status: 'applied' };
    });
  }
}
