import type pg from 'pg';

import type { EventApplicationOutcome, EventProcessResult } from '../policy/policy-types.js';
import {
  insertPolicyAuditOutcome,
  lockOrCreateConversation,
  resolveChannelIdentity,
  resolveIdentityAndConversation,
} from './postgres-policy-helpers.js';
import { withBoundedTransaction } from './postgres-transaction.js';

interface WebhookEventRow {
  readonly admission_outcome: string;
  readonly channel: string;
  readonly channel_account_id: string | null;
  readonly contact_id: string | null;
  readonly event_kind: string;
  readonly id: string;
  readonly occurred_at: Date | null;
}

interface EventApplicationRow {
  readonly conversation_id: string | null;
  readonly outcome: EventApplicationOutcome;
}

interface PauseDeadlineRow {
  readonly ai_paused_until: Date;
}

export class InvalidPendingWebhookEventError extends Error {
  public override readonly name = 'InvalidPendingWebhookEventError';
}

function requireNormalizedIdentity(event: WebhookEventRow): {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly externalContactId: string;
  readonly occurredAt: Date;
} {
  if (
    (event.channel !== 'messenger' && event.channel !== 'whatsapp') ||
    event.channel_account_id === null ||
    event.contact_id === null ||
    event.occurred_at === null
  ) {
    throw new InvalidPendingWebhookEventError('Pending webhook event is not normalized');
  }

  return {
    channel: event.channel,
    channelAccountId: event.channel_account_id,
    externalContactId: event.contact_id,
    occurredAt: event.occurred_at,
  };
}

function existingResult(eventId: string, application: EventApplicationRow): EventProcessResult {
  return application.conversation_id === null
    ? {
        eventId,
        outcome: application.outcome,
        status: 'already_applied',
      }
    : {
        conversationId: application.conversation_id,
        eventId,
        outcome: application.outcome,
        status: 'already_applied',
      };
}

export class PostgresConversationEventProcessor {
  public constructor(private readonly pool: pg.Pool) {}

  public async processEvent(webhookEventId: string): Promise<EventProcessResult> {
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<WebhookEventRow>(
        `select * from webhook_events where id = $1 for update`,
        [webhookEventId],
      );
      const event = selected.rows[0];
      if (event?.admission_outcome !== 'pending') {
        return { status: 'not_processable' };
      }

      return this.processLockedEvent(client, event);
    });
  }

  public async processNext(): Promise<EventProcessResult> {
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<WebhookEventRow>(
        `select webhook_events.*
         from webhook_events
         left join webhook_event_applications
           on webhook_event_applications.webhook_event_id = webhook_events.id
         where webhook_events.admission_outcome = 'pending'
           and webhook_event_applications.webhook_event_id is null
         order by webhook_events.created_at, webhook_events.id
         for update of webhook_events skip locked
         limit 1`,
      );
      const event = selected.rows[0];
      if (event === undefined) {
        return { status: 'no_pending_event' };
      }

      return this.processLockedEvent(client, event);
    });
  }

  private async processLockedEvent(
    client: pg.PoolClient,
    event: WebhookEventRow,
  ): Promise<EventProcessResult> {
    const existing = await client.query<EventApplicationRow>(
      `select conversation_id, outcome
       from webhook_event_applications
       where webhook_event_id = $1`,
      [event.id],
    );
    const application = existing.rows[0];
    if (application !== undefined) {
      return existingResult(event.id, application);
    }

    if (event.event_kind === 'message_status') {
      const normalized = requireNormalizedIdentity(event);
      await client.query(
        `insert into webhook_event_applications (webhook_event_id, outcome)
         values ($1, 'message_status_ignored')`,
        [event.id],
      );
      await insertPolicyAuditOutcome(client, {
        decisionType: 'event_application',
        evaluatedAt: normalized.occurredAt,
        outcome: 'ignored',
        reasonCode: 'message_status_ignored',
        relatedWebhookEventId: event.id,
      });
      return {
        eventId: event.id,
        outcome: 'message_status_ignored',
        status: 'applied',
      };
    }

    if (event.event_kind === 'business_message_echo') {
      const normalized = requireNormalizedIdentity(event);
      const identityId = await resolveChannelIdentity(client, normalized, normalized.occurredAt);
      const conversation = await lockOrCreateConversation(
        client,
        identityId,
        normalized.occurredAt,
      );

      if (
        conversation.lastAuthorizedResumeAt !== null &&
        normalized.occurredAt.getTime() <= conversation.lastAuthorizedResumeAt.getTime()
      ) {
        await client.query(
          `insert into webhook_event_applications
             (webhook_event_id, conversation_id, outcome)
           values ($1, $2, 'business_echo_ignored_before_resume')`,
          [event.id, conversation.conversationId],
        );
        await insertPolicyAuditOutcome(client, {
          channelIdentityId: identityId,
          conversationId: conversation.conversationId,
          decisionType: 'event_application',
          evaluatedAt: normalized.occurredAt,
          outcome: 'ignored',
          reasonCode: 'echo_not_later_than_resume',
          relatedWebhookEventId: event.id,
        });
        return {
          conversationId: conversation.conversationId,
          eventId: event.id,
          outcome: 'business_echo_ignored_before_resume',
          status: 'applied',
        };
      }

      await client.query(
        `insert into webhook_event_applications
           (webhook_event_id, conversation_id, outcome)
         values ($1, $2, 'business_echo_paused')`,
        [event.id, conversation.conversationId],
      );
      const updated = await client.query<PauseDeadlineRow>(
        `update conversations
         set ai_paused_until = greatest(
               coalesce(ai_paused_until, $2::timestamptz + interval '24 hours'),
               $2::timestamptz + interval '24 hours'
             ),
             last_activity_at = greatest(last_activity_at, $2::timestamptz),
             updated_at = now(),
             row_version = row_version + 1
         where id = $1
         returning ai_paused_until`,
        [conversation.conversationId, normalized.occurredAt],
      );
      const pauseUntil = updated.rows[0]?.ai_paused_until;
      if (pauseUntil === undefined) {
        throw new Error('Conversation pause update returned no deadline');
      }
      await client.query(
        `insert into human_pause_events
           (conversation_id, source_webhook_event_id, action, effective_at,
            resulting_pause_until, actor_kind)
         values ($1, $2, 'pause', $3, $4, 'business_echo')`,
        [conversation.conversationId, event.id, normalized.occurredAt, pauseUntil],
      );
      await insertPolicyAuditOutcome(client, {
        channelIdentityId: identityId,
        conversationId: conversation.conversationId,
        decisionType: 'event_application',
        evaluatedAt: normalized.occurredAt,
        outcome: 'applied',
        reasonCode: 'business_echo_pause',
        relatedWebhookEventId: event.id,
      });
      return {
        conversationId: conversation.conversationId,
        eventId: event.id,
        outcome: 'business_echo_paused',
        status: 'applied',
      };
    }

    if (event.event_kind !== 'customer_message') {
      throw new InvalidPendingWebhookEventError('Pending webhook event is not normalized');
    }

    const normalized = requireNormalizedIdentity(event);
    const state = await resolveIdentityAndConversation(client, normalized, normalized.occurredAt);
    await client.query(
      `insert into webhook_event_applications
         (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'customer_message_applied')`,
      [event.id, state.conversationId],
    );
    await insertPolicyAuditOutcome(client, {
      channelIdentityId: state.identityId,
      conversationId: state.conversationId,
      decisionType: 'event_application',
      evaluatedAt: normalized.occurredAt,
      outcome: 'applied',
      reasonCode: 'customer_message_applied',
      relatedWebhookEventId: event.id,
    });

    return {
      conversationId: state.conversationId,
      eventId: event.id,
      outcome: 'customer_message_applied',
      status: 'applied',
    };
  }
}
