import type pg from 'pg';

import { calculateCasualChatExpiry } from '../policy/retention-deadline.js';

export interface AppliedCustomerRetentionInput {
  readonly conversationId: string;
  readonly occurredAt: Date;
  readonly webhookEventId: string;
}

interface RetentionStateRow {
  readonly anchor_at: Date | null;
  readonly content_purged_through_at: Date | null;
  readonly expires_at: Date | null;
  readonly lifecycle_class: string;
}

export async function applyCustomerMessageRetention(
  client: pg.PoolClient,
  input: AppliedCustomerRetentionInput,
): Promise<void> {
  const firstExpiresAt = calculateCasualChatExpiry(input.occurredAt);
  const initialized = await client.query(
    `with inserted_state as (
       insert into conversation_retention_states
         (conversation_id, lifecycle_class, anchor_at, expires_at)
       values ($1, 'casual_chat', $2, $3)
       on conflict (conversation_id) do nothing
       returning conversation_id
     )
     insert into retention_events
       (conversation_id, decision_type, outcome, reason_code, actor_type,
        source_type, previous_class, resulting_class, effective_at,
        resulting_anchor_at, resulting_expires_at, source_webhook_event_id,
        request_key)
     select inserted_state.conversation_id, 'qualifying_event', 'applied',
            'first_customer_message', 'system', 'customer_message', null,
            'casual_chat', $2, $2, $3, $4, $5
     from inserted_state
    `,
    [
      input.conversationId,
      input.occurredAt,
      firstExpiresAt,
      input.webhookEventId,
      `customer-webhook-event:${input.webhookEventId}`,
    ],
  );
  if (initialized.rowCount === 1) {
    return;
  }

  const existing = await client.query<RetentionStateRow>(
    `select lifecycle_class, anchor_at, expires_at, content_purged_through_at
     from conversation_retention_states
     where conversation_id = $1
     for update`,
    [input.conversationId],
  );
  const state = existing.rows[0];
  if (state !== undefined) {
    if (
      state.content_purged_through_at !== null &&
      input.occurredAt.getTime() <= state.content_purged_through_at.getTime()
    ) {
      await client.query(`update webhook_events set message_text = null where id = $1`, [
        input.webhookEventId,
      ]);
      await client.query(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at, source_webhook_event_id,
            request_key)
         values ($1, 'qualifying_event', 'ignored', 'purged_boundary_preserved',
                 'system', 'customer_message', $2, $2, $3, $4, $5, $6, $7)`,
        [
          input.conversationId,
          state.lifecycle_class,
          input.occurredAt,
          state.anchor_at,
          state.expires_at,
          input.webhookEventId,
          `customer-webhook-event:${input.webhookEventId}`,
        ],
      );
      return;
    }

    if (
      state.lifecycle_class === 'casual_chat' &&
      state.anchor_at !== null &&
      input.occurredAt.getTime() > state.anchor_at.getTime()
    ) {
      const expiresAt = calculateCasualChatExpiry(input.occurredAt);
      await client.query(
        `update conversation_retention_states
         set anchor_at = $2,
             expires_at = $3,
             updated_at = now(),
             row_version = row_version + 1
         where conversation_id = $1`,
        [input.conversationId, input.occurredAt, expiresAt],
      );
      await client.query(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at, source_webhook_event_id,
            request_key)
         values ($1, 'qualifying_event', 'applied', 'casual_activity',
                 'system', 'customer_message', 'casual_chat', 'casual_chat',
                 $2, $2, $3, $4, $5)`,
        [
          input.conversationId,
          input.occurredAt,
          expiresAt,
          input.webhookEventId,
          `customer-webhook-event:${input.webhookEventId}`,
        ],
      );
      return;
    }

    if (
      state.lifecycle_class === 'casual_chat' &&
      state.anchor_at !== null &&
      state.expires_at !== null
    ) {
      await client.query(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at, source_webhook_event_id,
            request_key)
         values ($1, 'qualifying_event', 'ignored', 'out_of_order_ignored',
                 'system', 'customer_message', 'casual_chat', 'casual_chat',
                 $2, $3, $4, $5, $6)`,
        [
          input.conversationId,
          input.occurredAt,
          state.anchor_at,
          state.expires_at,
          input.webhookEventId,
          `customer-webhook-event:${input.webhookEventId}`,
        ],
      );
      return;
    }

    if (state.lifecycle_class === 'unconverted_lead' || state.lifecycle_class === 'active_client') {
      await client.query(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at, source_webhook_event_id,
            request_key)
         values ($1, 'qualifying_event', 'ignored', 'higher_precedence_preserved',
                 'system', 'customer_message', $2, $2, $3, $4, $5, $6, $7)`,
        [
          input.conversationId,
          state.lifecycle_class,
          input.occurredAt,
          state.anchor_at,
          state.expires_at,
          input.webhookEventId,
          `customer-webhook-event:${input.webhookEventId}`,
        ],
      );
    }
    return;
  }
  throw new Error('Retention state disappeared during customer event application');
}
