import type pg from 'pg';

import type { ChannelIdentitySelector } from '../policy/policy-types.js';

export type PolicyAuditDecisionType =
  | 'authorized_resume'
  | 'consent_record'
  | 'event_application'
  | 'marketing_eligibility'
  | 'reply_eligibility';

export type PolicyAuditOutcome = 'allowed' | 'applied' | 'denied' | 'duplicate' | 'ignored';

export type PolicyAuditReasonCode =
  | 'business_echo_pause'
  | 'consent_duplicate'
  | 'consent_grant'
  | 'consent_latest_grant'
  | 'consent_latest_revoke'
  | 'consent_missing'
  | 'consent_revoke'
  | 'customer_message_applied'
  | 'echo_not_later_than_resume'
  | 'identity_not_found'
  | 'message_status_ignored'
  | 'pause_active'
  | 'pause_inactive'
  | 'resume_applied'
  | 'resume_duplicate';

export interface PolicyAuditInput {
  readonly channelIdentityId?: string;
  readonly conversationId?: string;
  readonly decisionType: PolicyAuditDecisionType;
  readonly evaluatedAt: Date;
  readonly outcome: PolicyAuditOutcome;
  readonly reasonCode: PolicyAuditReasonCode;
  readonly relatedWebhookEventId?: string;
}

export interface ResolvedPolicyState {
  readonly conversationId: string;
  readonly identityId: string;
}

export interface LockedConversationState {
  readonly conversationId: string;
  readonly lastAuthorizedResumeAt: Date | null;
}

interface IdentifierRow {
  readonly id: string;
}

export async function resolveChannelIdentity(
  client: pg.PoolClient,
  identity: ChannelIdentitySelector,
  occurredAt: Date,
): Promise<string> {
  await client.query(
    `select pg_advisory_xact_lock(
       hashtextextended($1 || chr(31) || $2 || chr(31) || $3, 0)
     )`,
    [identity.channel, identity.channelAccountId, identity.externalContactId],
  );

  const existingIdentity = await client.query<IdentifierRow>(
    `select id
     from channel_identities
     where channel = $1
       and channel_account_id = $2
       and external_contact_id = $3`,
    [identity.channel, identity.channelAccountId, identity.externalContactId],
  );
  let identityId = existingIdentity.rows[0]?.id;

  if (identityId === undefined) {
    const contact = await client.query<IdentifierRow>(
      `insert into contacts default values returning id`,
    );
    const contactId = contact.rows[0]?.id;
    if (contactId === undefined) {
      throw new Error('Contact insert returned no identifier');
    }

    const insertedIdentity = await client.query<IdentifierRow>(
      `insert into channel_identities
         (contact_id, channel, channel_account_id, external_contact_id,
          first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $5)
       returning id`,
      [
        contactId,
        identity.channel,
        identity.channelAccountId,
        identity.externalContactId,
        occurredAt,
      ],
    );
    identityId = insertedIdentity.rows[0]?.id;
  } else {
    await client.query(
      `update channel_identities
       set first_seen_at = least(first_seen_at, $2),
           last_seen_at = greatest(last_seen_at, $2)
       where id = $1`,
      [identityId, occurredAt],
    );
  }

  if (identityId === undefined) {
    throw new Error('Channel identity insert returned no identifier');
  }

  return identityId;
}

export async function resolveIdentityAndConversation(
  client: pg.PoolClient,
  identity: ChannelIdentitySelector,
  occurredAt: Date,
): Promise<ResolvedPolicyState> {
  const identityId = await resolveChannelIdentity(client, identity, occurredAt);

  const conversation = await client.query<IdentifierRow>(
    `insert into conversations (channel_identity_id, created_at, last_activity_at)
     values ($1, $2, $2)
     on conflict (channel_identity_id) do update
       set last_activity_at = greatest(conversations.last_activity_at, excluded.last_activity_at),
           updated_at = now(),
           row_version = conversations.row_version + 1
     returning id`,
    [identityId, occurredAt],
  );
  const conversationId = conversation.rows[0]?.id;
  if (conversationId === undefined) {
    throw new Error('Conversation resolution returned no identifier');
  }

  return { conversationId, identityId };
}

export async function lockOrCreateConversation(
  client: pg.PoolClient,
  identityId: string,
  occurredAt: Date,
): Promise<LockedConversationState> {
  const existing = await client.query<{
    readonly id: string;
    readonly last_authorized_resume_at: Date | null;
  }>(
    `select id, last_authorized_resume_at
     from conversations
     where channel_identity_id = $1
     for update`,
    [identityId],
  );
  const conversation = existing.rows[0];
  if (conversation !== undefined) {
    return {
      conversationId: conversation.id,
      lastAuthorizedResumeAt: conversation.last_authorized_resume_at,
    };
  }

  const inserted = await client.query<IdentifierRow>(
    `insert into conversations (channel_identity_id, created_at, last_activity_at)
     values ($1, $2, $2)
     returning id`,
    [identityId, occurredAt],
  );
  const conversationId = inserted.rows[0]?.id;
  if (conversationId === undefined) {
    throw new Error('Conversation insert returned no identifier');
  }

  return { conversationId, lastAuthorizedResumeAt: null };
}

export async function insertPolicyAuditOutcome(
  client: pg.PoolClient,
  input: PolicyAuditInput,
): Promise<void> {
  await client.query(
    `insert into policy_audit_outcomes
       (decision_type, outcome, reason_code, conversation_id,
        channel_identity_id, related_webhook_event_id, evaluated_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.decisionType,
      input.outcome,
      input.reasonCode,
      input.conversationId,
      input.channelIdentityId,
      input.relatedWebhookEventId,
      input.evaluatedAt,
    ],
  );
}
