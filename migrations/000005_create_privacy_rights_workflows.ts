import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table privacy_request_events
      drop constraint privacy_request_events_action_check,
      drop constraint privacy_request_events_reason_code_check,
      drop constraint privacy_request_events_actor_type_check;
    alter table privacy_request_events
      add constraint privacy_request_events_action_check check (action in (
        'request_received',
        'reviewer_decision',
        'deletion_executed',
        'location_checked',
        'access_collected',
        'correction_executed',
        'request_completed'
      )),
      add constraint privacy_request_events_reason_code_check check (reason_code in (
        'customer_requested',
        'customer_confirmed',
        'identity_ambiguous',
        'request_withdrawn',
        'local_erasure_complete',
        'location_complete',
        'location_not_applicable',
        'location_failed',
        'identity_verified',
        'access_collected',
        'correction_applied',
        'correction_manual_required',
        'correction_partially_completed',
        'correction_rejected',
        'request_completed'
      )),
      add constraint privacy_request_events_actor_type_check check (actor_type in (
        'customer',
        'support_reviewer',
        'deletion_job',
        'privacy_export_service',
        'correction_service',
        'privacy_workflow'
      ));

    create table privacy_access_runs (
      id bigint generated always as identity primary key,
      request_id bigint not null references privacy_requests(id),
      request_key text not null unique,
      collected_at timestamptz not null,
      collector_count integer not null check (collector_count >= 0),
      record_count integer not null check (record_count >= 0),
      status text not null check (status = 'collected'),
      completed_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (completed_at >= collected_at)
    );

    create table privacy_correction_runs (
      id bigint generated always as identity primary key,
      request_id bigint not null references privacy_requests(id),
      request_key text not null unique,
      executed_at timestamptz not null,
      field_key text not null check (
        field_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      result_code text not null check (result_code in (
        'applied',
        'manual_required',
        'partially_completed',
        'rejected'
      )),
      completed_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (completed_at >= executed_at)
    );

    create table privacy_marketing_opt_out_runs (
      id bigint generated always as identity primary key,
      source_webhook_event_id bigint references webhook_events(id) on delete set null,
      request_key text not null unique,
      effective_at timestamptz not null,
      linked_identities_count integer not null check (linked_identities_count >= 0),
      category_revocations_count integer not null check (
        category_revocations_count >= 0
      ),
      suppressions_created_count integer not null check (
        suppressions_created_count >= 0
      ),
      pending_intents_cancelled_count integer not null check (
        pending_intents_cancelled_count >= 0
      ),
      status text not null check (status = 'applied'),
      completed_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (completed_at >= effective_at)
    );

    alter table privacy_notification_intents
      drop constraint privacy_notification_intents_notification_type_check,
      alter column request_id drop not null,
      add column marketing_opt_out_run_id bigint
        references privacy_marketing_opt_out_runs(id);
    alter table privacy_notification_intents
      add constraint privacy_notification_intents_notification_type_check
        check (notification_type in (
          'operator_privacy_request',
          'operator_marketing_opt_out'
        )),
      add constraint privacy_notification_intents_parent_check check (
        (
          notification_type = 'operator_privacy_request'
          and request_id is not null
          and marketing_opt_out_run_id is null
        )
        or (
          notification_type = 'operator_marketing_opt_out'
          and request_id is null
          and marketing_opt_out_run_id is not null
        )
      );

    create index privacy_requests_contact_hold_idx
      on privacy_requests (contact_id, state, id)
      where contact_id is not null
        and state in ('received', 'awaiting_confirmation', 'human_review', 'in_progress');

    create trigger privacy_access_runs_append_only
      before update or delete on privacy_access_runs
      for each row execute function reject_deletion_safety_evidence_mutation();
    create trigger privacy_correction_runs_append_only
      before update or delete on privacy_correction_runs
      for each row execute function reject_deletion_safety_evidence_mutation();
    create trigger privacy_marketing_opt_out_runs_append_only
      before update or delete on privacy_marketing_opt_out_runs
      for each row execute function reject_deletion_safety_evidence_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index privacy_requests_contact_hold_idx;

    alter table privacy_notification_intents
      drop constraint privacy_notification_intents_parent_check,
      drop constraint privacy_notification_intents_notification_type_check,
      drop column marketing_opt_out_run_id,
      alter column request_id set not null;
    alter table privacy_notification_intents
      add constraint privacy_notification_intents_notification_type_check
        check (notification_type = 'operator_privacy_request');

    drop trigger privacy_marketing_opt_out_runs_append_only
      on privacy_marketing_opt_out_runs;
    drop trigger privacy_correction_runs_append_only
      on privacy_correction_runs;
    drop trigger privacy_access_runs_append_only
      on privacy_access_runs;
    drop table privacy_marketing_opt_out_runs;
    drop table privacy_correction_runs;
    drop table privacy_access_runs;

    alter table privacy_request_events
      drop constraint privacy_request_events_action_check,
      drop constraint privacy_request_events_reason_code_check,
      drop constraint privacy_request_events_actor_type_check;
    alter table privacy_request_events
      add constraint privacy_request_events_action_check check (action in (
        'request_received',
        'reviewer_decision',
        'deletion_executed',
        'location_checked'
      )),
      add constraint privacy_request_events_reason_code_check check (reason_code in (
        'customer_requested',
        'customer_confirmed',
        'identity_ambiguous',
        'request_withdrawn',
        'local_erasure_complete',
        'location_complete',
        'location_not_applicable',
        'location_failed'
      )),
      add constraint privacy_request_events_actor_type_check check (actor_type in (
        'customer',
        'support_reviewer',
        'deletion_job'
      ));
  `);
}
