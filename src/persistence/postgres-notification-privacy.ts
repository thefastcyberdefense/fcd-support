import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Cancel delivery in the caller's erasure transaction without removing evidence. */
export async function cancelDeletedSubjectNotifications(
  client: pg.PoolClient,
  conversationIds: readonly string[],
  erasedAt: Date,
): Promise<void> {
  if (conversationIds.length === 0) return;
  // Earlier restored schemas predate the delivery tables. Forward migration
  // installs them before any worker is admitted to a restored database.
  const available = await client.query<{ present: boolean }>(
    `select to_regclass('notification_delivery_work') is not null
      and to_regclass('notification_delivery_sources') is not null as present`,
  );
  if (available.rows[0]?.present !== true) return;
  const sources = await client.query<{
    source_kind: 'privacy' | 'support' | 'outbound';
    source_id: string;
    notification_type: string;
    occurred_at: Date;
    retention_deadline: Date | null;
  }>(
    `select source.* from notification_delivery_sources source where
      (source.source_kind='support' and exists(select 1 from support_escalation_outcomes escalation
        where escalation.id=source.source_id and escalation.conversation_id=any($1::bigint[])))
      or (source.source_kind='outbound' and exists(select 1 from outbound_escalation_outcomes escalation
        where escalation.id=source.source_id and escalation.conversation_id=any($1::bigint[])))
      or (source.source_kind='privacy' and exists(select 1 from privacy_notification_intents intent
        left join privacy_requests request on request.id=intent.request_id
        left join privacy_marketing_opt_out_runs opt_out on opt_out.id=intent.marketing_opt_out_run_id
        join webhook_event_applications application on application.webhook_event_id=
          coalesce(request.source_webhook_event_id,opt_out.source_webhook_event_id)
        where intent.id=source.source_id and application.conversation_id=any($1::bigint[])))
      order by source.source_kind,source.source_id`,
    [conversationIds],
  );
  for (const source of sources.rows) {
    // A terminal source row also prevents later reconciliation from recreating
    // delivery after deletion when no worker had claimed that source yet.
    const reference = `NOTIFICATION_${randomUUID()}`;
    await client.query(
      `insert into notification_delivery_work
        (work_ref,source_kind,privacy_notification_intent_id,support_escalation_id,outbound_escalation_id,
         notification_type,idempotency_key,state,reason_code,occurred_at,retention_deadline,
         next_attempt_at,attempt_count,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$1,'failed','source_unavailable',$7,$8,null,0,$9,$9)
       on conflict do nothing`,
      [
        reference,
        source.source_kind,
        source.source_kind === 'privacy' ? source.source_id : null,
        source.source_kind === 'support' ? source.source_id : null,
        source.source_kind === 'outbound' ? source.source_id : null,
        source.notification_type,
        source.occurred_at,
        source.retention_deadline ?? erasedAt,
        erasedAt,
      ],
    );
    await client.query(
      `update notification_delivery_work set state='failed',reason_code='source_unavailable',
        lease_ref=null,worker_ref=null,lease_expires_at=null,next_attempt_at=null,updated_at=$3
       where source_kind=$1 and
        coalesce(privacy_notification_intent_id,support_escalation_id,outbound_escalation_id)=$2
        and state in ('pending','leased')`,
      [source.source_kind, source.source_id, erasedAt],
    );
  }
}
