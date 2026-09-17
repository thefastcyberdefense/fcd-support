import type pg from 'pg';

import type { EventApplicationOutcome, EventProcessResult } from '../policy/policy-types.js';
import {
  insertPolicyAuditOutcome,
  lockOrCreateConversation,
  resolveChannelIdentity,
  resolveIdentityAndConversation,
} from './postgres-policy-helpers.js';
import { applyOutboundStatusEvent } from './postgres-outbound-status.js';
import { applyCustomerMessageRetention } from './postgres-retention-policy.js';
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

interface UpdatedConversationRow {
  readonly id: string;
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
        `select id, admission_outcome, channel, channel_account_id,
                contact_id, event_kind, occurred_at
         from webhook_events
         where id = $1
         for update`,
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
        `select webhook_events.id, webhook_events.admission_outcome,
                webhook_events.channel, webhook_events.channel_account_id,
                webhook_events.contact_id, webhook_events.event_kind,
                webhook_events.occurred_at
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
      const status = await applyOutboundStatusEvent(client, event.id);
      if (status.status === 'not_processable') {
        await client.query(
          `insert into webhook_event_applications (webhook_event_id, outcome)
           values ($1, 'message_status_uncorrelated')`,
          [event.id],
        );
        return {
          eventId: event.id,
          outcome: 'message_status_uncorrelated',
          status: 'applied',
        };
      }
      if (status.status === 'duplicate') {
        const duplicate = await client.query<EventApplicationRow>(
          `select conversation_id, outcome
           from webhook_event_applications
           where webhook_event_id = $1`,
          [event.id],
        );
        const duplicateApplication = duplicate.rows[0];
        if (duplicateApplication === undefined) {
          throw new InvalidPendingWebhookEventError('Duplicate message status has no application');
        }
        return existingResult(event.id, duplicateApplication);
      }
      return {
        eventId: event.id,
        outcome:
          status.status === 'applied' ? 'message_status_applied' : 'message_status_uncorrelated',
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
        event.id,
      );

      if (!conversation.eventOccurredAfterAuthorizedResume) {
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
      const updated = await client.query<UpdatedConversationRow>(
        `update conversations
         set ai_paused_until = greatest(
               coalesce(
                 conversations.ai_paused_until,
                 source_event.occurred_at + interval '24 hours'
               ),
               source_event.occurred_at + interval '24 hours'
             ),
             last_activity_at = greatest(
               conversations.last_activity_at,
               source_event.occurred_at
             ),
             updated_at = now(),
             row_version = row_version + 1
         from webhook_events as source_event
         where conversations.id = $1
           and source_event.id = $2
         returning conversations.id`,
        [conversation.conversationId, event.id],
      );
      if (updated.rows[0]?.id === undefined) {
        throw new Error('Conversation pause update returned no identifier');
      }
      await client.query(
        `insert into human_pause_events
           (conversation_id, source_webhook_event_id, action, effective_at,
            resulting_pause_until, actor_kind)
         select conversations.id, source_event.id, 'pause', source_event.occurred_at,
                conversations.ai_paused_until, 'business_echo'
         from conversations
         join webhook_events as source_event on source_event.id = $2
         where conversations.id = $1`,
        [conversation.conversationId, event.id],
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
    await applyCustomerMessageRetention(client, {
      conversationId: state.conversationId,
      occurredAt: normalized.occurredAt,
      webhookEventId: event.id,
    });
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
