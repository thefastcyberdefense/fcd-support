import type pg from 'pg';

import type { DeliveryState, ProviderMessageStatus } from '../meta/normalized-event.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export type ApplyOutboundStatusResult =
  | { readonly deliveryState: DeliveryState; readonly status: 'applied' }
  | { readonly status: 'duplicate' | 'not_processable' | 'uncorrelated' };

interface WebhookStatusRow {
  readonly admission_outcome: string;
  readonly channel: string;
  readonly channel_account_id: string | null;
  readonly event_kind: string;
  readonly external_message_id: string | null;
  readonly id: string;
  readonly message_status: string | null;
  readonly occurred_at: Date | null;
}

interface CorrelatedAttemptRow {
  readonly attempt_id: string;
  readonly intent_created_at: Date;
  readonly intent_id: string;
  readonly intent_state: string;
  readonly intent_updated_at: Date;
}

const providerStatuses = new Set<ProviderMessageStatus>(['delivered', 'failed', 'read', 'sent']);

function isProviderStatus(value: string | null): value is ProviderMessageStatus {
  return value !== null && providerStatuses.has(value as ProviderMessageStatus);
}

function currentDeliveryState(intentState: string): DeliveryState {
  if (intentState === 'terminal_failed') return 'failed';
  if (
    intentState === 'provider_accepted' ||
    intentState === 'sent' ||
    intentState === 'delivered' ||
    intentState === 'read'
  ) {
    return intentState;
  }
  throw new Error('Correlated outbound intent has an invalid delivery state');
}

function targetDeliveryState(
  current: DeliveryState,
  incoming: ProviderMessageStatus,
): DeliveryState {
  if (incoming === 'failed') {
    return current === 'provider_accepted' || current === 'sent' ? 'failed' : current;
  }
  if (incoming === 'read') return 'read';
  if (incoming === 'delivered') return current === 'read' ? 'read' : 'delivered';
  return current === 'provider_accepted' ? 'sent' : current;
}

async function updateIntentState(
  client: pg.PoolClient,
  correlated: CorrelatedAttemptRow,
  target: DeliveryState,
  occurredAt: Date,
): Promise<void> {
  const current = currentDeliveryState(correlated.intent_state);
  if (current === target) return;

  const effectiveAt = new Date(
    Math.max(
      correlated.intent_created_at.getTime(),
      correlated.intent_updated_at.getTime(),
      occurredAt.getTime(),
    ),
  );
  if (target === 'failed') {
    await client.query(
      `update outbound_intents
       set state = 'terminal_failed', terminal_reason = 'provider_rejected',
           finished_at = $2, updated_at = $2
       where id = $1`,
      [correlated.intent_id, effectiveAt],
    );
    return;
  }
  if (target === 'sent') {
    await client.query(
      `update outbound_intents
       set state = 'sent', updated_at = $2
       where id = $1`,
      [correlated.intent_id, effectiveAt],
    );
    return;
  }
  await client.query(
    `update outbound_intents
     set state = $2, terminal_reason = null,
         finished_at = greatest(coalesce(finished_at, $3), $3),
         updated_at = $3
     where id = $1`,
    [correlated.intent_id, target, effectiveAt],
  );
}

export async function applyOutboundStatusEvent(
  client: pg.PoolClient,
  webhookEventId: string,
): Promise<ApplyOutboundStatusResult> {
  if (!/^[1-9][0-9]*$/u.test(webhookEventId)) return { status: 'not_processable' };

  const selected = await client.query<WebhookStatusRow>(
    `select id, admission_outcome, channel, channel_account_id, event_kind,
            external_message_id, message_status, occurred_at
     from webhook_events
     where id = $1
     for update`,
    [webhookEventId],
  );
  const event = selected.rows[0];
  if (
    event?.admission_outcome !== 'pending' ||
    event.event_kind !== 'message_status' ||
    (event.channel !== 'messenger' && event.channel !== 'whatsapp') ||
    event.channel_account_id === null ||
    event.external_message_id === null ||
    !isProviderStatus(event.message_status) ||
    event.occurred_at === null
  ) {
    return { status: 'not_processable' };
  }

  const application = await client.query(
    `select 1 from webhook_event_applications where webhook_event_id = $1`,
    [event.id],
  );
  if (application.rowCount !== 0) return { status: 'duplicate' };

  const correlation = await client.query<CorrelatedAttemptRow>(
    `select attempt.id as attempt_id, intent.id as intent_id,
            intent.state as intent_state, intent.created_at as intent_created_at,
            intent.updated_at as intent_updated_at
     from outbound_attempts as attempt
     join outbound_intents as intent on intent.id = attempt.intent_id
     where attempt.channel = $1
       and attempt.channel_account_id = $2
       and attempt.provider_message_id = $3
       and attempt.state = 'provider_accepted'
     for update of attempt, intent`,
    [event.channel, event.channel_account_id, event.external_message_id],
  );
  const correlated = correlation.rows[0];
  if (correlated === undefined) {
    await client.query(
      `insert into webhook_event_applications (webhook_event_id, outcome)
       values ($1, 'message_status_uncorrelated')`,
      [event.id],
    );
    return { status: 'uncorrelated' };
  }

  await client.query(
    `insert into outbound_status_events
       (webhook_event_id, intent_id, attempt_id, status, provider_occurred_at)
     values ($1, $2, $3, $4, $5)`,
    [
      event.id,
      correlated.intent_id,
      correlated.attempt_id,
      event.message_status,
      event.occurred_at,
    ],
  );
  const deliveryState = targetDeliveryState(
    currentDeliveryState(correlated.intent_state),
    event.message_status,
  );
  await updateIntentState(client, correlated, deliveryState, event.occurred_at);
  await client.query(
    `insert into webhook_event_applications (webhook_event_id, outcome)
     values ($1, 'message_status_applied')`,
    [event.id],
  );
  return { deliveryState, status: 'applied' };
}

export class PostgresOutboundStatus {
  public constructor(private readonly pool: pg.Pool) {}

  public async applyEvent(webhookEventId: string): Promise<ApplyOutboundStatusResult> {
    return withBoundedTransaction(this.pool, (client) =>
      applyOutboundStatusEvent(client, webhookEventId),
    );
  }
}
