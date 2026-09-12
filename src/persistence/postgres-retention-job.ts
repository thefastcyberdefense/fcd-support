import type pg from 'pg';

import type { RetentionJobInput, RetentionJobResult } from '../policy/policy-types.js';
import { withBoundedTransaction } from './postgres-transaction.js';

interface ExistingRetentionJobRow {
  readonly conversations_processed: number;
  readonly material_matches: boolean;
  readonly messages_purged: number;
}

interface DueRetentionStateRow {
  readonly anchor_at: Date;
  readonly conversation_id: string;
}

export class RetentionJobIdempotencyConflictError extends Error {
  public override readonly name = 'RetentionJobIdempotencyConflictError';
}

function parseRetentionJobInput(inputValue: unknown): RetentionJobInput {
  if (typeof inputValue !== 'object' || inputValue === null) {
    throw new TypeError('Retention job input is invalid');
  }
  const input = inputValue as Partial<RetentionJobInput>;
  if (!(input.evaluatedAt instanceof Date) || !Number.isFinite(input.evaluatedAt.getTime())) {
    throw new TypeError('evaluatedAt must be a valid Date');
  }
  if (
    typeof input.limit !== 'number' ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new TypeError('limit must be an integer from 1 through 100');
  }
  if (typeof input.requestKey !== 'string') {
    throw new TypeError('requestKey must be a string');
  }
  const requestKey = input.requestKey.trim();
  if (requestKey.length < 1 || requestKey.length > 128) {
    throw new TypeError('requestKey must contain 1 through 128 characters');
  }
  return {
    evaluatedAt: new Date(input.evaluatedAt.getTime()),
    limit: input.limit,
    requestKey,
  };
}

export class PostgresRetentionJob {
  public constructor(private readonly pool: pg.Pool) {}

  public async runExpiredContentBatch(inputValue: RetentionJobInput): Promise<RetentionJobResult> {
    const input = parseRetentionJobInput(inputValue);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);

      const existing = await client.query<ExistingRetentionJobRow>(
        `select run.conversations_processed,
                run.messages_purged,
                run.evaluated_at = $2::timestamptz
                  and run.requested_limit = $3::integer as material_matches
         from retention_job_runs as run
         where run.request_key = $1`,
        [input.requestKey, input.evaluatedAt, input.limit],
      );
      const previous = existing.rows[0];
      if (previous !== undefined) {
        if (!previous.material_matches) {
          throw new RetentionJobIdempotencyConflictError(
            'Retention job request key material conflicts',
          );
        }
        return {
          conversationsProcessed: previous.conversations_processed,
          messagesPurged: previous.messages_purged,
          status: 'duplicate',
        };
      }

      const selected = await client.query<DueRetentionStateRow>(
        `select conversation_id, anchor_at
         from conversation_retention_states
         where expires_at <= $1
           and anchor_at is not null
           and (content_purged_through_at is null or anchor_at > content_purged_through_at)
         order by expires_at, conversation_id
         for update skip locked
         limit $2`,
        [input.evaluatedAt, input.limit],
      );

      let messagesPurged = 0;
      for (const state of selected.rows) {
        const cleared = await client.query(
          `update webhook_events as source
           set message_text = null
           from webhook_event_applications as application
           where application.webhook_event_id = source.id
             and application.conversation_id = $1
             and source.occurred_at <= $2
             and source.message_text is not null`,
          [state.conversation_id, state.anchor_at],
        );
        messagesPurged += cleared.rowCount ?? 0;

        await client.query(
          `update support_reply_drafts
           set answer_text = null, state = 'erased', erased_at = $2
           where conversation_id = $1 and state = 'ready'`,
          [state.conversation_id, input.evaluatedAt],
        );
        await client.query(
          `update knowledge_gap_observations
           set sanitized_summary = null, erased_at = $2
           where conversation_id = $1 and erased_at is null`,
          [state.conversation_id, input.evaluatedAt],
        );

        await client.query(
          `update conversation_retention_states
           set content_purged_through_at = $2,
               updated_at = now(),
               row_version = row_version + 1
           where conversation_id = $1`,
          [state.conversation_id, state.anchor_at],
        );
      }

      const conversationsProcessed = selected.rows.length;
      await client.query(
        `insert into retention_job_runs
           (request_key, evaluated_at, requested_limit, status,
            conversations_processed, messages_purged)
         values ($1, $2, $3, 'applied', $4, $5)`,
        [input.requestKey, input.evaluatedAt, input.limit, conversationsProcessed, messagesPurged],
      );

      return {
        conversationsProcessed,
        messagesPurged,
        status: 'applied',
      };
    });
  }
}
