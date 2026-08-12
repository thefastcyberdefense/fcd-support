import type pg from 'pg';

import type {
  AuthorizedResumeInput,
  AuthorizedResumeResult,
  ReplyEligibility,
} from '../policy/policy-types.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import { insertPolicyAuditOutcome } from './postgres-policy-helpers.js';
import { withBoundedTransaction } from './postgres-transaction.js';

interface ReplyEligibilityRow {
  readonly pause_active: boolean;
}

interface ExistingResumeRow {
  readonly ai_paused_until: Date | null;
  readonly conversation_id: string;
  readonly material_matches: boolean;
}

interface ConversationRow {
  readonly id: string;
}

interface UpdatedResumeRow {
  readonly ai_paused_until: Date | null;
  readonly id: string;
}

export class PolicyRecordNotFoundError extends Error {
  public override readonly name = 'PolicyRecordNotFoundError';
}

export class PolicyIdempotencyConflictError extends Error {
  public override readonly name = 'PolicyIdempotencyConflictError';
}

function requireDecimalConversationId(conversationId: string): void {
  if (!/^\d+$/.test(conversationId)) {
    throw new TypeError('Conversation identifier must be decimal');
  }
}

function requireValidDate(value: Date, fieldName: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} must be a valid Date`);
  }
}

function requireRequestKey(requestKey: string): string {
  if (typeof requestKey !== 'string') {
    throw new TypeError('requestKey must be a string');
  }
  const normalized = requestKey.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new TypeError('requestKey must contain 1 to 128 characters');
  }
  return normalized;
}

export class PostgresTakeoverPolicy {
  public constructor(private readonly pool: pg.Pool) {}

  public async evaluateReplyEligibility(
    conversationId: string,
    evaluatedAt: Date,
  ): Promise<ReplyEligibility> {
    requireDecimalConversationId(conversationId);
    requireValidDate(evaluatedAt, 'evaluatedAt');

    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<ReplyEligibilityRow>(
        `select coalesce(ai_paused_until > $2, false) as pause_active
         from conversations
         where id = $1`,
        [conversationId, evaluatedAt],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        throw new PolicyRecordNotFoundError('Conversation not found');
      }
      const eligible = !row.pause_active;
      const reason = eligible ? 'pause_inactive' : 'pause_active';

      await insertPolicyAuditOutcome(client, {
        conversationId,
        decisionType: 'reply_eligibility',
        evaluatedAt,
        outcome: eligible ? 'allowed' : 'denied',
        reasonCode: reason,
      });

      return { eligible, reason };
    });
  }

  public async resume(
    input: AuthorizedResumeInput,
    principal: unknown,
  ): Promise<AuthorizedResumeResult> {
    requireDecimalConversationId(input.conversationId);
    requireValidDate(input.effectiveAt, 'effectiveAt');
    const requestKey = requireRequestKey(input.requestKey);
    const reviewer = requireSupportReviewer(principal);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        requestKey,
      ]);

      const existing = await client.query<ExistingResumeRow>(
        `select history.conversation_id,
                history.resulting_pause_until as ai_paused_until,
                history.conversation_id = $2::bigint
                  and history.reviewer_reference = $3
                  and history.effective_at = $4::timestamptz
                  as material_matches
         from human_pause_events as history
         where history.action = 'resume'
           and history.reviewer_request_key = $1`,
        [requestKey, input.conversationId, reviewer.reviewerRef, input.effectiveAt],
      );
      const priorResume = existing.rows[0];
      if (priorResume !== undefined) {
        if (!priorResume.material_matches) {
          throw new PolicyIdempotencyConflictError('Resume request key material conflicts');
        }
        return {
          aiPausedUntil: priorResume.ai_paused_until,
          conversationId: priorResume.conversation_id,
          status: 'duplicate',
        };
      }

      const selected = await client.query<ConversationRow>(
        `select id
         from conversations
         where id = $1
         for update`,
        [input.conversationId],
      );
      if (selected.rows[0] === undefined) {
        throw new PolicyRecordNotFoundError('Conversation not found');
      }

      await client.query(
        `update conversations
         set last_authorized_resume_at = greatest(
               coalesce(last_authorized_resume_at, $2::timestamptz),
               $2::timestamptz
             )
         where id = $1`,
        [input.conversationId, input.effectiveAt],
      );
      const updated = await client.query<UpdatedResumeRow>(
        `update conversations
         set ai_paused_until = (
               select max(source_event.occurred_at + interval '24 hours')
               from human_pause_events as pause
               join webhook_events as source_event
                 on source_event.id = pause.source_webhook_event_id
               join webhook_event_applications as application
                 on application.webhook_event_id = source_event.id
               where pause.conversation_id = conversations.id
                 and pause.action = 'pause'
                 and pause.actor_kind = 'business_echo'
                 and application.conversation_id = conversations.id
                 and application.outcome = 'business_echo_paused'
                 and source_event.occurred_at > conversations.last_authorized_resume_at
             ),
             updated_at = now(),
             row_version = row_version + 1
         where id = $1
         returning id, ai_paused_until`,
        [input.conversationId],
      );
      const resumed = updated.rows[0];
      if (resumed === undefined) {
        throw new Error('Conversation resume update returned no identifier');
      }

      await client.query(
        `insert into human_pause_events
           (conversation_id, action, effective_at, resulting_pause_until,
            actor_kind, reviewer_reference, reviewer_request_key)
         select id, 'resume', $2, ai_paused_until,
                'reviewer', $3, $4
         from conversations
         where id = $1`,
        [input.conversationId, input.effectiveAt, reviewer.reviewerRef, requestKey],
      );
      await insertPolicyAuditOutcome(client, {
        conversationId: input.conversationId,
        decisionType: 'authorized_resume',
        evaluatedAt: input.effectiveAt,
        outcome: 'applied',
        reasonCode: 'resume_applied',
      });

      return {
        aiPausedUntil: resumed.ai_paused_until,
        conversationId: resumed.id,
        status: 'applied',
      };
    });
  }
}
