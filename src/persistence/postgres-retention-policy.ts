import type pg from 'pg';

import {
  parseActiveRelationshipCloseInput,
  parseActiveRelationshipReviewInput,
  parseActiveRelationshipStartInput,
  parseQualifyingRetentionEventInput,
  parseRetentionReclassificationInput,
} from '../policy/retention-command.js';
import {
  addUtcCalendarMonths,
  calculateCasualChatExpiry,
  calculateClosedActiveClientDeadline,
} from '../policy/retention-deadline.js';
import { requirePolicyOwner, requireSupportReviewer } from '../policy/reviewer-principal.js';
import { withBoundedTransaction } from './postgres-transaction.js';

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

export type RetentionMutationResult =
  | { readonly status: 'applied'; readonly retentionEventId: string }
  | { readonly status: 'duplicate'; readonly retentionEventId: string }
  | { readonly status: 'ignored'; readonly retentionEventId: string };

interface ExistingRetentionMutationRow {
  readonly id: string;
  readonly material_matches: boolean;
}

interface QualifyingSourceRow {
  readonly event_kind: 'business_message_echo' | 'customer_message';
  readonly occurred_at: Date;
}

interface LockedRetentionStateRow extends RetentionStateRow {
  readonly conversation_id: string;
}

interface ActiveRetentionStateRow extends LockedRetentionStateRow {
  readonly final_paid_service_completed_at: Date | null;
  readonly last_active_review_at: Date | null;
  readonly next_active_review_at: Date | null;
  readonly relationship_ended_at: Date | null;
  readonly relationship_started_at: Date | null;
  readonly relationship_status: 'closed' | 'open' | null;
}
interface InsertedRetentionEventRow {
  readonly id: string;
}

export class RetentionSourceAuthorityError extends Error {
  public override readonly name = 'RetentionSourceAuthorityError';
}

export class RetentionIdempotencyConflictError extends Error {
  public override readonly name = 'RetentionIdempotencyConflictError';
}

export class RetentionConversationNotFoundError extends Error {
  public override readonly name = 'RetentionConversationNotFoundError';
}

export class RetentionLifecycleStateError extends Error {
  public override readonly name = 'RetentionLifecycleStateError';
}

export class RetentionNoReclassificationHistoryError extends Error {
  public override readonly name = 'RetentionNoReclassificationHistoryError';
}

function sourceTypeForEvent(
  eventKind: QualifyingSourceRow['event_kind'],
): 'business_message_echo' | 'customer_message' {
  return eventKind;
}

function appliedReasonForEvent(
  eventKind: QualifyingSourceRow['event_kind'],
): 'human_reply' | 'lead_interaction' {
  return eventKind === 'business_message_echo' ? 'human_reply' : 'lead_interaction';
}

export class PostgresRetentionPolicy {
  public constructor(private readonly pool: pg.Pool) {}

  public async recordQualifyingEvent(
    inputValue: unknown,
    principal: unknown,
  ): Promise<RetentionMutationResult> {
    const input = parseQualifyingRetentionEventInput(inputValue);
    const reviewer = requireSupportReviewer(principal);
    if (input.targetClass !== 'unconverted_lead') {
      throw new TypeError('Reviewer qualifying events may only establish unconverted leads');
    }

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);

      const existing = await client.query<ExistingRetentionMutationRow>(
        `select history.id,
                history.conversation_id = $2::bigint
                  and history.source_webhook_event_id = $3::bigint
                  and history.actor_type = 'support_reviewer'
                  and history.reviewer_reference = $4
                  and history.source_type in ('customer_message', 'business_message_echo')
                  as material_matches
         from retention_events as history
         where history.request_key = $1`,
        [input.requestKey, input.conversationId, input.sourceWebhookEventId, reviewer.reviewerRef],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (!prior.material_matches) {
          throw new RetentionIdempotencyConflictError('Retention request key material conflicts');
        }
        return { retentionEventId: prior.id, status: 'duplicate' };
      }

      const conversation = await client.query<{ readonly id: string }>(
        `select id from conversations where id = $1 for update`,
        [input.conversationId],
      );
      if (conversation.rows[0] === undefined) {
        throw new RetentionConversationNotFoundError('Conversation not found');
      }

      const selectedState = await client.query<LockedRetentionStateRow>(
        `select conversation_id, lifecycle_class, anchor_at, expires_at,
                content_purged_through_at
         from conversation_retention_states
         where conversation_id = $1
         for update`,
        [input.conversationId],
      );
      const state = selectedState.rows[0];

      const source = await client.query<QualifyingSourceRow>(
        `select source_event.event_kind, source_event.occurred_at
         from webhook_events as source_event
         join webhook_event_applications as application
           on application.webhook_event_id = source_event.id
         where source_event.id = $1
           and source_event.admission_outcome = 'pending'
           and source_event.occurred_at is not null
           and application.conversation_id = $2
           and (
             (
               source_event.event_kind = 'customer_message'
               and application.outcome = 'customer_message_applied'
               and exists (
                 select 1
                 from retention_events as customer_history
                 where customer_history.source_webhook_event_id = source_event.id
                   and customer_history.conversation_id = application.conversation_id
                   and customer_history.source_type = 'customer_message'
                   and customer_history.effective_at = source_event.occurred_at
               )
             )
             or (
               source_event.event_kind = 'business_message_echo'
               and application.outcome = 'business_echo_paused'
               and exists (
                 select 1
                 from human_pause_events as pause_history
                 where pause_history.source_webhook_event_id = source_event.id
                   and pause_history.conversation_id = application.conversation_id
                   and pause_history.action = 'pause'
                   and pause_history.actor_kind = 'business_echo'
                   and pause_history.effective_at = source_event.occurred_at
               )
             )
           )
         for share of source_event, application`,
        [input.sourceWebhookEventId, input.conversationId],
      );
      const authoritativeSource = source.rows[0];
      if (authoritativeSource === undefined) {
        throw new RetentionSourceAuthorityError(
          'Retention source lacks an authoritative event application',
        );
      }

      const sourceType = sourceTypeForEvent(authoritativeSource.event_kind);
      const sourceAt = authoritativeSource.occurred_at;
      const expiresAt = addUtcCalendarMonths(sourceAt, 12);
      let outcome: 'applied' | 'ignored';
      let reasonCode:
        | 'higher_precedence_preserved'
        | 'human_reply'
        | 'lead_interaction'
        | 'out_of_order_ignored'
        | 'purged_boundary_preserved';
      let resultingAnchorAt: Date | null;
      let resultingExpiresAt: Date | null;
      let previousClass: RetentionStateRow['lifecycle_class'] | null;

      let resultingClass: RetentionStateRow['lifecycle_class'];
      if (state === undefined) {
        await client.query(
          `insert into conversation_retention_states
             (conversation_id, lifecycle_class, anchor_at, expires_at)
           values ($1, 'unconverted_lead', $2, $3)`,
          [input.conversationId, sourceAt, expiresAt],
        );
        outcome = 'applied';
        reasonCode = appliedReasonForEvent(authoritativeSource.event_kind);
        resultingAnchorAt = sourceAt;
        resultingExpiresAt = expiresAt;
        previousClass = null;
        resultingClass = 'unconverted_lead';
      } else if (
        state.content_purged_through_at !== null &&
        sourceAt.getTime() <= state.content_purged_through_at.getTime()
      ) {
        outcome = 'ignored';
        reasonCode = 'purged_boundary_preserved';
        resultingAnchorAt = state.anchor_at;
        resultingExpiresAt = state.expires_at;
        previousClass = state.lifecycle_class;
        resultingClass = state.lifecycle_class;
      } else if (state.lifecycle_class === 'active_client') {
        resultingClass = state.lifecycle_class;
        outcome = 'ignored';
        reasonCode = 'higher_precedence_preserved';
        resultingAnchorAt = state.anchor_at;
        resultingExpiresAt = state.expires_at;
        previousClass = state.lifecycle_class;
      } else if (
        state.lifecycle_class === 'unconverted_lead' &&
        state.anchor_at !== null &&
        sourceAt.getTime() <= state.anchor_at.getTime()
      ) {
        outcome = 'ignored';
        reasonCode = 'out_of_order_ignored';
        resultingAnchorAt = state.anchor_at;
        resultingExpiresAt = state.expires_at;
        previousClass = state.lifecycle_class;
        resultingClass = state.lifecycle_class;
      } else {
        resultingClass = 'unconverted_lead';
        await client.query(
          `update conversation_retention_states
           set lifecycle_class = 'unconverted_lead',
               anchor_at = $2,
               expires_at = $3,
               updated_at = now(),
               row_version = row_version + 1
           where conversation_id = $1`,
          [input.conversationId, sourceAt, expiresAt],
        );
        outcome = 'applied';
        reasonCode = appliedReasonForEvent(authoritativeSource.event_kind);
        resultingAnchorAt = sourceAt;
        resultingExpiresAt = expiresAt;
        previousClass = state.lifecycle_class;
      }

      const inserted = await client.query<InsertedRetentionEventRow>(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at, source_webhook_event_id,
            reviewer_reference, request_key)
         values ($1, 'classification_change', $2, $3, 'support_reviewer',
                 $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id`,
        [
          input.conversationId,
          outcome,
          reasonCode,
          sourceType,
          previousClass,
          resultingClass,
          sourceAt,
          resultingAnchorAt,
          resultingExpiresAt,
          input.sourceWebhookEventId,
          reviewer.reviewerRef,
          input.requestKey,
        ],
      );
      const retentionEventId = inserted.rows[0]?.id;
      if (retentionEventId === undefined) {
        throw new Error('Retention event insert returned no identifier');
      }
      return { retentionEventId, status: outcome };
    });
  }

  private async lockRetentionState(
    client: pg.PoolClient,
    conversationId: string,
  ): Promise<ActiveRetentionStateRow> {
    const conversation = await client.query<{ readonly id: string }>(
      `select id from conversations where id = $1 for update`,
      [conversationId],
    );
    if (conversation.rows[0] === undefined) {
      throw new RetentionConversationNotFoundError('Conversation not found');
    }
    const selected = await client.query<ActiveRetentionStateRow>(
      `select conversation_id, lifecycle_class, anchor_at, expires_at,
              content_purged_through_at, relationship_status,
              relationship_started_at, relationship_ended_at,
              final_paid_service_completed_at, last_active_review_at,
              next_active_review_at
       from conversation_retention_states
       where conversation_id = $1
       for update`,
      [conversationId],
    );
    const state = selected.rows[0];
    if (state === undefined) {
      throw new RetentionLifecycleStateError('Conversation has no retention state');
    }
    return state;
  }

  public async startActiveRelationship(
    inputValue: unknown,
    principal: unknown,
  ): Promise<RetentionMutationResult> {
    const input = parseActiveRelationshipStartInput(inputValue);
    const owner = requirePolicyOwner(principal);
    if (input.relationshipStartedAt.getTime() > input.effectiveAt.getTime()) {
      throw new TypeError('Relationship start cannot be later than its effective review');
    }
    const nextReviewAt = addUtcCalendarMonths(input.effectiveAt, 12);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<ExistingRetentionMutationRow>(
        `select history.id,
                history.conversation_id = $2::bigint
                  and history.decision_type = 'classification_change'
                  and history.reason_code = 'active_relationship_started'
                  and history.actor_type = 'policy_owner'
                  and history.source_type = 'reviewer_command'
                  and history.effective_at = $3::timestamptz
                  and history.relationship_started_at = $4::timestamptz
                  and history.reviewer_reference = $5
                  as material_matches
         from retention_events as history
         where history.request_key = $1`,
        [
          input.requestKey,
          input.conversationId,
          input.effectiveAt,
          input.relationshipStartedAt,
          owner.reviewerRef,
        ],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (!prior.material_matches) {
          throw new RetentionIdempotencyConflictError('Retention request key material conflicts');
        }
        return { retentionEventId: prior.id, status: 'duplicate' };
      }

      const state = await this.lockRetentionState(client, input.conversationId);
      if (state.lifecycle_class === 'active_client') {
        throw new RetentionLifecycleStateError('Active relationship is already established');
      }
      await client.query(
        `update conversation_retention_states
         set lifecycle_class = 'active_client',
             anchor_at = null,
             expires_at = null,
             relationship_status = 'open',
             relationship_started_at = $2,
             relationship_ended_at = null,
             final_paid_service_completed_at = null,
             last_active_review_at = $3,
             next_active_review_at = $4,
             updated_at = now(),
             row_version = row_version + 1
         where conversation_id = $1`,
        [input.conversationId, input.relationshipStartedAt, input.effectiveAt, nextReviewAt],
      );
      const inserted = await client.query<InsertedRetentionEventRow>(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            relationship_started_at, next_active_review_at,
            reviewer_reference, request_key)
         values ($1, 'classification_change', 'applied',
                 'active_relationship_started', 'policy_owner',
                 'reviewer_command', $2, 'active_client', $3, $4, $5, $6, $7)
         returning id`,
        [
          input.conversationId,
          state.lifecycle_class,
          input.effectiveAt,
          input.relationshipStartedAt,
          nextReviewAt,
          owner.reviewerRef,
          input.requestKey,
        ],
      );
      const retentionEventId = inserted.rows[0]?.id;
      if (retentionEventId === undefined) {
        throw new Error('Active relationship start returned no retention event');
      }
      return { retentionEventId, status: 'applied' };
    });
  }

  public async reviewActiveRelationship(
    inputValue: unknown,
    principal: unknown,
  ): Promise<RetentionMutationResult> {
    const input = parseActiveRelationshipReviewInput(inputValue);
    const owner = requirePolicyOwner(principal);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<ExistingRetentionMutationRow>(
        `select history.id,
                history.conversation_id = $2::bigint
                  and history.decision_type = 'relationship_review'
                  and history.actor_type = 'policy_owner'
                  and history.source_type = 'reviewer_command'
                  and history.effective_at = $3::timestamptz
                  and history.reviewer_reference = $4
                  as material_matches
         from retention_events as history
         where history.request_key = $1`,
        [input.requestKey, input.conversationId, input.reviewedAt, owner.reviewerRef],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (!prior.material_matches) {
          throw new RetentionIdempotencyConflictError('Retention request key material conflicts');
        }
        return { retentionEventId: prior.id, status: 'duplicate' };
      }

      const state = await this.lockRetentionState(client, input.conversationId);
      if (
        state.lifecycle_class !== 'active_client' ||
        state.relationship_status !== 'open' ||
        state.relationship_started_at === null ||
        state.last_active_review_at === null ||
        state.next_active_review_at === null
      ) {
        throw new RetentionLifecycleStateError('Active relationship is not open');
      }
      const advances = input.reviewedAt.getTime() > state.last_active_review_at.getTime();
      const nextReviewAt = advances
        ? addUtcCalendarMonths(input.reviewedAt, 12)
        : state.next_active_review_at;
      if (advances) {
        await client.query(
          `update conversation_retention_states
           set last_active_review_at = $2,
               next_active_review_at = $3,
               updated_at = now(),
               row_version = row_version + 1
           where conversation_id = $1`,
          [input.conversationId, input.reviewedAt, nextReviewAt],
        );
      }
      const inserted = await client.query<InsertedRetentionEventRow>(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            relationship_started_at, next_active_review_at,
            reviewer_reference, request_key)
         values ($1, 'relationship_review', $2, $3, 'policy_owner',
                 'reviewer_command', 'active_client', 'active_client',
                 $4, $5, $6, $7, $8)
         returning id`,
        [
          input.conversationId,
          advances ? 'applied' : 'ignored',
          advances ? 'active_relationship_reviewed' : 'out_of_order_ignored',
          input.reviewedAt,
          state.relationship_started_at,
          nextReviewAt,
          owner.reviewerRef,
          input.requestKey,
        ],
      );
      const retentionEventId = inserted.rows[0]?.id;
      if (retentionEventId === undefined) {
        throw new Error('Active relationship review returned no retention event');
      }
      return { retentionEventId, status: advances ? 'applied' : 'ignored' };
    });
  }

  public async closeActiveRelationship(
    inputValue: unknown,
    principal: unknown,
  ): Promise<RetentionMutationResult> {
    const input = parseActiveRelationshipCloseInput(inputValue);
    const owner = requirePolicyOwner(principal);
    const closed = calculateClosedActiveClientDeadline(input);
    if (closed.anchorAt.getTime() > input.effectiveAt.getTime()) {
      throw new TypeError('Active relationship close anchor cannot be later than effectiveAt');
    }

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<ExistingRetentionMutationRow>(
        `select history.id,
                history.conversation_id = $2::bigint
                  and history.decision_type = 'relationship_close'
                  and history.reason_code = 'active_relationship_closed'
                  and history.actor_type = 'policy_owner'
                  and history.source_type = 'reviewer_command'
                  and history.effective_at = $3::timestamptz
                  and history.relationship_ended_at is not distinct from $4::timestamptz
                  and history.final_paid_service_completed_at is not distinct from $5::timestamptz
                  and history.reviewer_reference = $6
                  as material_matches
         from retention_events as history
         where history.request_key = $1`,
        [
          input.requestKey,
          input.conversationId,
          input.effectiveAt,
          input.relationshipEndedAt ?? null,
          input.finalPaidServiceCompletedAt ?? null,
          owner.reviewerRef,
        ],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (!prior.material_matches) {
          throw new RetentionIdempotencyConflictError('Retention request key material conflicts');
        }
        return { retentionEventId: prior.id, status: 'duplicate' };
      }

      const state = await this.lockRetentionState(client, input.conversationId);
      if (
        state.lifecycle_class !== 'active_client' ||
        state.relationship_status !== 'open' ||
        state.relationship_started_at === null ||
        state.last_active_review_at === null
      ) {
        throw new RetentionLifecycleStateError('Active relationship is not open');
      }
      await client.query(
        `update conversation_retention_states
         set anchor_at = $2,
             expires_at = $3,
             relationship_status = 'closed',
             relationship_ended_at = $4,
             final_paid_service_completed_at = $5,
             next_active_review_at = null,
             updated_at = now(),
             row_version = row_version + 1
         where conversation_id = $1`,
        [
          input.conversationId,
          closed.anchorAt,
          closed.expiresAt,
          input.relationshipEndedAt ?? null,
          input.finalPaidServiceCompletedAt ?? null,
        ],
      );
      const inserted = await client.query<InsertedRetentionEventRow>(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at,
            relationship_started_at, relationship_ended_at,
            final_paid_service_completed_at, reviewer_reference, request_key)
         values ($1, 'relationship_close', 'applied',
                 'active_relationship_closed', 'policy_owner',
                 'reviewer_command', 'active_client', 'active_client',
                 $2, $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          input.conversationId,
          input.effectiveAt,
          closed.anchorAt,
          closed.expiresAt,
          state.relationship_started_at,
          input.relationshipEndedAt ?? null,
          input.finalPaidServiceCompletedAt ?? null,
          owner.reviewerRef,
          input.requestKey,
        ],
      );
      const retentionEventId = inserted.rows[0]?.id;
      if (retentionEventId === undefined) {
        throw new Error('Active relationship close returned no retention event');
      }
      return { retentionEventId, status: 'applied' };
    });
  }

  public async reclassifyFromHistory(
    inputValue: unknown,
    principal: unknown,
  ): Promise<RetentionMutationResult> {
    const input = parseRetentionReclassificationInput(inputValue);
    const owner = requirePolicyOwner(principal);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<ExistingRetentionMutationRow>(
        `select history.id,
                history.conversation_id = $2::bigint
                  and history.decision_type = 'reclassification'
                  and history.reason_code = 'history_reclassification'
                  and history.actor_type = 'policy_owner'
                  and history.source_type = 'reviewer_command'
                  and history.resulting_class = $3
                  and history.effective_at = $4::timestamptz
                  and history.reviewer_reference = $5
                  as material_matches
         from retention_events as history
         where history.request_key = $1`,
        [
          input.requestKey,
          input.conversationId,
          input.targetClass,
          input.effectiveAt,
          owner.reviewerRef,
        ],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (!prior.material_matches) {
          throw new RetentionIdempotencyConflictError('Retention request key material conflicts');
        }
        return { retentionEventId: prior.id, status: 'duplicate' };
      }

      const state = await this.lockRetentionState(client, input.conversationId);
      if (state.lifecycle_class !== 'active_client') {
        throw new RetentionLifecycleStateError(
          'History reclassification requires an active-client state',
        );
      }
      const candidate = await client.query<{ readonly anchor_at: Date }>(
        `select history.effective_at as anchor_at
         from retention_events as history
         where history.conversation_id = $1
           and history.outcome = 'applied'
           and history.resulting_class = $2
           and history.source_webhook_event_id is not null
           and history.source_type in ('customer_message', 'business_message_echo')
           and (
             $3::timestamptz is null
             or history.effective_at > $3::timestamptz
           )
           and (
             (
               $2 = 'casual_chat'
               and history.decision_type = 'qualifying_event'
               and history.reason_code in ('first_customer_message', 'casual_activity')
             )
             or (
               $2 = 'unconverted_lead'
               and history.decision_type = 'classification_change'
               and history.reason_code in ('lead_interaction', 'human_reply')
             )
           )
         order by history.effective_at desc, history.id desc
         limit 1`,
        [input.conversationId, input.targetClass, state.content_purged_through_at],
      );
      const qualifying = candidate.rows[0];
      if (qualifying === undefined) {
        throw new RetentionNoReclassificationHistoryError(
          'No qualifying history exists after the purged content boundary',
        );
      }
      const expiresAt =
        input.targetClass === 'casual_chat'
          ? calculateCasualChatExpiry(qualifying.anchor_at)
          : addUtcCalendarMonths(qualifying.anchor_at, 12);
      await client.query(
        `update conversation_retention_states
         set lifecycle_class = $2,
             anchor_at = $3,
             expires_at = $4,
             relationship_status = null,
             relationship_started_at = null,
             relationship_ended_at = null,
             final_paid_service_completed_at = null,
             last_active_review_at = null,
             next_active_review_at = null,
             updated_at = now(),
             row_version = row_version + 1
         where conversation_id = $1`,
        [input.conversationId, input.targetClass, qualifying.anchor_at, expiresAt],
      );
      const inserted = await client.query<InsertedRetentionEventRow>(
        `insert into retention_events
           (conversation_id, decision_type, outcome, reason_code, actor_type,
            source_type, previous_class, resulting_class, effective_at,
            resulting_anchor_at, resulting_expires_at,
            reviewer_reference, request_key)
         values ($1, 'reclassification', 'applied', 'history_reclassification',
                 'policy_owner', 'reviewer_command', 'active_client', $2,
                 $3, $4, $5, $6, $7)
         returning id`,
        [
          input.conversationId,
          input.targetClass,
          input.effectiveAt,
          qualifying.anchor_at,
          expiresAt,
          owner.reviewerRef,
          input.requestKey,
        ],
      );
      const retentionEventId = inserted.rows[0]?.id;
      if (retentionEventId === undefined) {
        throw new Error('History reclassification returned no retention event');
      }
      return { retentionEventId, status: 'applied' };
    });
  }
}
