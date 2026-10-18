import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table runtime_processing_work (
      id bigint generated always as identity primary key,
      work_ref text not null unique check (work_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      webhook_event_id bigint not null unique references webhook_events(id),
      stage text not null check (stage in ('apply','decide','model','enqueue')),
      state text not null check (state in ('pending','leased','completed','blocked','failed','quarantined')),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      lease_ref text, worker_ref text, lease_expires_at timestamptz,
      finished_lease_ref text, finished_at timestamptz,
      check ((state='leased' and lease_ref is not null and worker_ref is not null and lease_expires_at is not null)
        or (state<>'leased' and lease_ref is null and worker_ref is null and lease_expires_at is null)),
      check ((state in ('completed','blocked','failed') and finished_lease_ref is not null and finished_at is not null)
        or (state in ('pending','leased','quarantined') and finished_lease_ref is null and finished_at is null))
    );
    create index runtime_processing_pending_idx on runtime_processing_work(state,created_at,id);
    create table notification_delivery_work (
      id bigint generated always as identity primary key,
      work_ref text not null unique check (work_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      source_kind text not null check (source_kind in ('privacy','support','outbound')),
      privacy_notification_intent_id bigint unique references privacy_notification_intents(id),
      support_escalation_id bigint unique references support_escalation_outcomes(id),
      outbound_escalation_id bigint unique references outbound_escalation_outcomes(id),
      notification_type text not null check (notification_type in ('operator_privacy_request',
        'operator_marketing_opt_out','operator_support_escalation','operator_outbound_escalation')),
      idempotency_key text not null unique,
      state text not null check (state in ('pending','leased','delivered','failed','quarantined')),
      reason_code text check (reason_code in ('ok','timeout','transport_failure','invalid_response',
        'authentication_failed','destination_rejected','retry_exhausted','source_unavailable','retention_expired')),
      occurred_at timestamptz not null,
      retention_deadline timestamptz not null,
      next_attempt_at timestamptz,
      attempt_count integer not null check (attempt_count between 0 and 100),
      lease_ref text, worker_ref text, lease_expires_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      check (num_nonnulls(privacy_notification_intent_id,support_escalation_id,outbound_escalation_id)=1),
      check ((source_kind='privacy' and privacy_notification_intent_id is not null
              and notification_type in ('operator_privacy_request','operator_marketing_opt_out'))
        or (source_kind='support' and support_escalation_id is not null and notification_type='operator_support_escalation')
        or (source_kind='outbound' and outbound_escalation_id is not null and notification_type='operator_outbound_escalation')),
      check ((state='leased' and lease_ref is not null and worker_ref is not null and lease_expires_at is not null)
        or (state<>'leased' and lease_ref is null and worker_ref is null and lease_expires_at is null)),
      check ((state='pending' and next_attempt_at is not null) or (state<>'pending' and next_attempt_at is null))
    );
    create index notification_delivery_pending_idx on notification_delivery_work(state,next_attempt_at,id);
    create table notification_delivery_attempts (
      id bigint generated always as identity primary key,
      work_id bigint not null references notification_delivery_work(id),
      attempt_number integer not null check (attempt_number between 1 and 100),
      lease_ref text not null unique,
      completed_at timestamptz not null,
      status text not null check (status in ('accepted','retryable','terminal_failed')),
      reason_code text not null check (reason_code in ('ok','timeout','transport_failure','invalid_response',
        'authentication_failed','destination_rejected','retry_exhausted')),
      unique(work_id,attempt_number),
      check ((status='accepted' and reason_code='ok') or (status<>'accepted' and reason_code<>'ok'))
    );
    create trigger notification_delivery_attempts_append_only before update or delete on notification_delivery_attempts
      for each row execute function reject_operations_evidence_mutation();
    create view notification_delivery_sources as
      select 'privacy'::text as source_kind, intent.id as source_id, intent.notification_type,
        intent.created_at as occurred_at, coalesce(retention.expires_at,retention.next_active_review_at) as retention_deadline
      from privacy_notification_intents intent
      left join privacy_requests request on request.id=intent.request_id
      left join privacy_marketing_opt_out_runs opt_out on opt_out.id=intent.marketing_opt_out_run_id
      left join webhook_event_applications application
        on application.webhook_event_id=coalesce(request.source_webhook_event_id,opt_out.source_webhook_event_id)
      left join conversation_retention_states retention on retention.conversation_id=application.conversation_id
      where intent.state in ('pending','failed')
      union all
      select 'support', escalation.id, 'operator_support_escalation', escalation.created_at,
        coalesce(retention.expires_at,retention.next_active_review_at)
      from support_escalation_outcomes escalation
      left join conversation_retention_states retention on retention.conversation_id=escalation.conversation_id
      where escalation.state='open'
      union all
      select 'outbound', escalation.id, 'operator_outbound_escalation', escalation.created_at,
        coalesce(retention.expires_at,retention.next_active_review_at)
      from outbound_escalation_outcomes escalation
      left join conversation_retention_states retention on retention.conversation_id=escalation.conversation_id
      where escalation.state='open';
  `);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql(`do $$ begin
      if exists(select 1 from runtime_processing_work) or exists(select 1 from notification_delivery_work)
        or exists(select 1 from notification_delivery_attempts) then
        raise exception 'P6-002 rollback blocked: runtime work exists' using errcode='55000';
      end if;
    end $$;
    drop view notification_delivery_sources;
    drop table notification_delivery_attempts, notification_delivery_work, runtime_processing_work;
  `);
}
