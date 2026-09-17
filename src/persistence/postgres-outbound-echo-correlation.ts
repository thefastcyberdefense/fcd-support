import type pg from 'pg';
import { z } from 'zod';

import { insertPolicyAuditOutcome } from './postgres-policy-helpers.js';
import { withBoundedTransaction } from './postgres-transaction.js';

interface CorrelatedEchoRow {
  readonly attempt_id: string;
  readonly hold_id: string;
  readonly occurred_at: Date;
}

interface EchoEventRow {
  readonly admission_outcome: string;
  readonly channel: string;
  readonly channel_account_id: string | null;
  readonly contact_id: string | null;
  readonly event_kind: string;
  readonly id: string;
  readonly occurred_at: Date | null;
}

interface EchoConversationRow {
  readonly event_occurred_after_authorized_resume: boolean | null;
  readonly identity_id: string;
  readonly id: string;
  readonly last_authorized_resume_at: Date | null;
}

export type MessengerBusinessEchoProcessResult =
  | { readonly status: 'correlation_pending' | 'duplicate' | 'not_processable' }
  | {
      readonly conversationId: string;
      readonly outcome: 'service_echo_correlated';
      readonly status: 'self_echo';
    }
  | {
      readonly conversationId: string;
      readonly outcome: 'business_echo_ignored_before_resume' | 'business_echo_paused';
      readonly status: 'human_pause_applied';
    };

const expirySchema = z.strictObject({
  evaluatedAt: z.instanceof(Date).refine((value) => Number.isFinite(value.getTime())),
  limit: z.number().int().min(1).max(1000),
});

export async function correlateAcceptedMessengerEcho(
  client: pg.PoolClient,
  webhookEventId: string,
  conversationId: string,
): Promise<boolean> {
  const selected = await client.query<CorrelatedEchoRow>(
    `select attempt.id as attempt_id, hold.id as hold_id, event.occurred_at
     from webhook_events as event
     join outbound_attempts as attempt
       on attempt.channel = event.channel
      and attempt.channel_account_id = event.channel_account_id
      and attempt.provider_message_id = event.external_message_id
      and attempt.state = 'provider_accepted'
     join outbound_intents as intent
       on intent.id = attempt.intent_id
      and intent.conversation_id = $2
     join outbound_echo_correlation_holds as hold
       on hold.attempt_id = attempt.id
      and hold.state = 'open'
      and event.occurred_at < hold.expires_at
     where event.id = $1
       and event.admission_outcome = 'pending'
       and event.event_kind = 'business_message_echo'
       and event.channel = 'messenger'
     for update of attempt, intent`,
    [webhookEventId, conversationId],
  );
  const correlated = selected.rows[0];
  if (correlated === undefined) return false;

  await client.query(
    `update outbound_echo_correlation_holds
     set state = 'correlated', source_webhook_event_id = $2,
         resolution_code = 'self_echo',
         resolved_at = greatest(created_at, $3)
     where id = $1 and state = 'open'`,
    [correlated.hold_id, webhookEventId, correlated.occurred_at],
  );
  await client.query(
    `insert into webhook_event_applications
       (webhook_event_id, conversation_id, outcome)
     values ($1, $2, 'service_echo_correlated')`,
    [webhookEventId, conversationId],
  );
  return true;
}

export async function processMessengerBusinessEcho(
  client: pg.PoolClient,
  webhookEventId: string,
): Promise<MessengerBusinessEchoProcessResult> {
  const selected = await client.query<EchoEventRow>(
    `select id, admission_outcome, channel, channel_account_id,
            contact_id, event_kind, occurred_at
     from webhook_events where id = $1 for update`,
    [webhookEventId],
  );
  const event = selected.rows[0];
  if (
    event?.admission_outcome !== 'pending' ||
    event.channel !== 'messenger' ||
    event.channel_account_id === null ||
    event.contact_id === null ||
    event.event_kind !== 'business_message_echo' ||
    event.occurred_at === null
  ) {
    return { status: 'not_processable' };
  }
  const existing = await client.query(
    `select 1 from webhook_event_applications where webhook_event_id = $1`,
    [event.id],
  );
  if (existing.rowCount !== 0) return { status: 'duplicate' };

  const conversation = await client.query<EchoConversationRow>(
    `select conversation.id, identity.id as identity_id,
            conversation.last_authorized_resume_at,
            event.occurred_at > conversation.last_authorized_resume_at
              as event_occurred_after_authorized_resume
     from channel_identities as identity
     join conversations as conversation on conversation.channel_identity_id = identity.id
     join webhook_events as event on event.id = $4
     where identity.channel = $1
       and identity.channel_account_id = $2
       and identity.external_contact_id = $3
     for update of conversation`,
    [event.channel, event.channel_account_id, event.contact_id, event.id],
  );
  const conversationRow = conversation.rows[0];
  if (conversationRow === undefined) return { status: 'not_processable' };
  const conversationId = conversationRow.id;
  if (await correlateAcceptedMessengerEcho(client, event.id, conversationId)) {
    return {
      conversationId,
      outcome: 'service_echo_correlated',
      status: 'self_echo',
    };
  }
  const pending = await client.query(
    `select 1
     from outbound_echo_correlation_holds as hold
     join outbound_attempts as attempt on attempt.id = hold.attempt_id
     where hold.conversation_id = $1
       and hold.state = 'open'
       and hold.expires_at > (
         select occurred_at from webhook_events where id = $2
       )
       and attempt.state = 'dispatch_started'
     for update of hold, attempt`,
    [conversationId, event.id],
  );
  if (pending.rowCount !== 0) return { status: 'correlation_pending' };

  if (
    conversationRow.last_authorized_resume_at !== null &&
    conversationRow.event_occurred_after_authorized_resume !== true
  ) {
    await client.query(
      `insert into webhook_event_applications
         (webhook_event_id, conversation_id, outcome)
       values ($1, $2, 'business_echo_ignored_before_resume')`,
      [event.id, conversationId],
    );
    await insertPolicyAuditOutcome(client, {
      channelIdentityId: conversationRow.identity_id,
      conversationId,
      decisionType: 'event_application',
      evaluatedAt: event.occurred_at,
      outcome: 'ignored',
      reasonCode: 'echo_not_later_than_resume',
      relatedWebhookEventId: event.id,
    });
    return {
      conversationId,
      outcome: 'business_echo_ignored_before_resume',
      status: 'human_pause_applied',
    };
  }

  await client.query(
    `insert into webhook_event_applications
       (webhook_event_id, conversation_id, outcome)
     values ($1, $2, 'business_echo_paused')`,
    [event.id, conversationId],
  );
  await client.query(
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
         updated_at = now(), row_version = row_version + 1
     from webhook_events as source_event
     where conversations.id = $1 and source_event.id = $2`,
    [conversationId, event.id],
  );
  await client.query(
    `insert into human_pause_events
       (conversation_id, source_webhook_event_id, action, effective_at,
        resulting_pause_until, actor_kind)
     select conversations.id, source_event.id, 'pause', source_event.occurred_at,
            conversations.ai_paused_until, 'business_echo'
     from conversations
     join webhook_events as source_event on source_event.id = $2
     where conversations.id = $1`,
    [conversationId, event.id],
  );
  await insertPolicyAuditOutcome(client, {
    channelIdentityId: conversationRow.identity_id,
    conversationId,
    decisionType: 'event_application',
    evaluatedAt: event.occurred_at,
    outcome: 'applied',
    reasonCode: 'business_echo_pause',
    relatedWebhookEventId: event.id,
  });
  return {
    conversationId,
    outcome: 'business_echo_paused',
    status: 'human_pause_applied',
  };
}

export async function resolvePendingMessengerEchoes(
  client: pg.PoolClient,
  conversationId: string,
): Promise<{ readonly paused: number; readonly selfEchoes: number }> {
  const pending = await client.query<{ readonly id: string }>(
    `select event.id
     from conversations as conversation
     join channel_identities as identity on identity.id = conversation.channel_identity_id
     join webhook_events as event
       on event.channel = identity.channel
      and event.channel_account_id = identity.channel_account_id
      and event.contact_id = identity.external_contact_id
     left join webhook_event_applications as application
       on application.webhook_event_id = event.id
     where conversation.id = $1
       and event.admission_outcome = 'pending'
       and event.event_kind = 'business_message_echo'
       and application.webhook_event_id is null
     order by event.occurred_at, event.id
     for update of event`,
    [conversationId],
  );
  let paused = 0;
  let selfEchoes = 0;
  for (const event of pending.rows) {
    const result = await processMessengerBusinessEcho(client, event.id);
    if (result.status === 'human_pause_applied') paused += 1;
    if (result.status === 'self_echo') selfEchoes += 1;
  }
  return { paused, selfEchoes };
}

export class PostgresOutboundEchoCorrelation {
  public constructor(private readonly pool: pg.Pool) {}

  public async processBusinessEcho(
    webhookEventId: string,
  ): Promise<
    | { readonly status: 'self_echo' }
    | { readonly status: 'correlation_pending' }
    | { readonly status: 'human_pause_applied' }
    | { readonly status: 'duplicate' | 'not_processable' }
  > {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await processMessengerBusinessEcho(client, webhookEventId);
      return { status: result.status };
    });
  }

  public async resolveExpiredHolds(inputValue: unknown): Promise<{
    readonly paused: number;
    readonly selfEchoes: number;
  }> {
    const input = expirySchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      const expired = await client.query<{ readonly conversation_id: string; readonly id: string }>(
        `select id, conversation_id
         from outbound_echo_correlation_holds
         where state = 'open' and expires_at <= $1
         order by expires_at, id
         for update skip locked
         limit $2`,
        [input.evaluatedAt, input.limit],
      );
      let paused = 0;
      let selfEchoes = 0;
      for (const hold of expired.rows) {
        await client.query(
          `update outbound_echo_correlation_holds
           set state = 'expired', resolution_code = 'hold_expired',
               resolved_at = greatest(created_at, $2)
           where id = $1`,
          [hold.id, input.evaluatedAt],
        );
        const resolved = await resolvePendingMessengerEchoes(client, hold.conversation_id);
        paused += resolved.paused;
        selfEchoes += resolved.selfEchoes;
      }
      return { paused, selfEchoes };
    });
  }
}
