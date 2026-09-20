import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import { createReplayHmac } from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import { reconcileOutboundPrivacy } from './postgres-outbound-privacy.js';

export interface LockedDeletionIdentity {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channel_account_id: string;
  readonly external_contact_id: string;
  readonly id: string;
}

export interface LocalIdentityErasureResult {
  readonly conversationsProcessed: number;
  readonly identitiesPseudonymized: number;
  readonly messagesCleared: number;
}

interface SubjectEventRow {
  readonly had_message: boolean;
  readonly id: string;
  readonly idempotency_key: string;
}

export async function eraseLockedIdentities(
  client: pg.PoolClient,
  keyring: PrivacyHmacKeyring,
  identities: readonly LockedDeletionIdentity[],
  erasedAt: Date,
): Promise<LocalIdentityErasureResult> {
  if (identities.length === 0) {
    return { conversationsProcessed: 0, identitiesPseudonymized: 0, messagesCleared: 0 };
  }
  const activeKey = keyring.keys.get(keyring.activeVersion);
  if (activeKey === undefined) throw new Error('Active privacy key is missing');
  const identityIds = identities.map((identity) => identity.id);
  const conversations = await client.query<{ readonly id: string }>(
    `select id
     from conversations
     where channel_identity_id = any($1::bigint[])
     order by id
     for update`,
    [identityIds],
  );
  const conversationIds = conversations.rows.map((conversation) => conversation.id);
  await reconcileOutboundPrivacy(client, {
    allowMissingTables: true,
    conversationIds,
    effectiveAt: erasedAt,
    reason: 'identity_deleted',
  });
  await client.query(
    `update support_reply_drafts
     set answer_text = null, state = 'erased', erased_at = $2
     where conversation_id = any($1::bigint[]) and state = 'ready'`,
    [conversationIds, erasedAt],
  );
  await client.query(
    `update knowledge_gap_observations
     set sanitized_summary = null, erased_at = $2
     where conversation_id = any($1::bigint[]) and erased_at is null`,
    [conversationIds, erasedAt],
  );
  const subjectEvents = await client.query<SubjectEventRow>(
    `with matched_events as (
       select application.webhook_event_id as id
       from webhook_event_applications as application
       join conversations as conversation on conversation.id = application.conversation_id
       where conversation.channel_identity_id = any($1::bigint[])
       union
       select event.id
       from webhook_events as event
       join unnest($2::text[], $3::text[], $4::text[])
         as identity(channel, channel_account_id, external_contact_id)
         on identity.channel = event.channel
        and identity.channel_account_id = event.channel_account_id
        and identity.external_contact_id = event.contact_id
     )
     select event.id, event.idempotency_key,
            event.message_text is not null as had_message
     from webhook_events as event
     join matched_events on matched_events.id = event.id
     order by event.id
     for update of event`,
    [
      identityIds,
      identities.map((identity) => identity.channel),
      identities.map((identity) => identity.channel_account_id),
      identities.map((identity) => identity.external_contact_id),
    ],
  );
  let messagesCleared = 0;
  for (const event of subjectEvents.rows) {
    if (event.had_message) messagesCleared += 1;
    await client.query(
      `update webhook_events
       set idempotency_key = $2,
           channel_account_id = null,
           contact_id = null,
           external_message_id = null,
           message_text = null,
           message_status = null
       where id = $1`,
      [
        event.id,
        `privacy:${keyring.activeVersion}:${createReplayHmac(event.idempotency_key, {
          key: activeKey,
          version: keyring.activeVersion,
        })}`,
      ],
    );
  }
  await client.query(
    `update conversations
     set ai_paused_until = null,
         last_authorized_resume_at = null,
         updated_at = now(),
         row_version = row_version + 1
     where id = any($1::bigint[])`,
    [conversationIds],
  );
  for (const identity of identities) {
    await client.query(
      `update channel_identities
       set channel_account_id = $2,
           external_contact_id = $3
       where id = $1`,
      [identity.id, `deleted:${randomUUID()}`, `deleted:${randomUUID()}`],
    );
  }
  return {
    conversationsProcessed: conversations.rows.length,
    identitiesPseudonymized: identities.length,
    messagesCleared,
  };
}
