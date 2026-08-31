import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create unique index privacy_marketing_opt_out_runs_source_unique
      on privacy_marketing_opt_out_runs (source_webhook_event_id)
      where source_webhook_event_id is not null;

    create table privacy_marketing_reopt_in_runs (
      id bigint generated always as identity primary key,
      request_key text not null unique,
      anchor_channel_identity_id bigint
        references channel_identities(id) on delete set null,
      category_codes text[] not null,
      effective_at timestamptz not null,
      scope text not null check (
        scope in ('source_identity', 'all_linked_identities')
      ),
      linked_identities_count integer not null check (
        linked_identities_count >= 0
      ),
      category_grants_count integer not null check (
        category_grants_count >= 0
      ),
      suppressions_cleared_count integer not null check (
        suppressions_cleared_count >= 0
      ),
      reviewer_reference text not null check (
        btrim(reviewer_reference) <> ''
        and char_length(reviewer_reference) <= 128
      ),
      verification_method text not null check (
        verification_method in ('same_channel_context', 'known_name')
      ),
      status text not null check (status = 'applied'),
      completed_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (cardinality(category_codes) between 1 and 32),
      check (category_codes <@ array[
        'newsletter',
        'product_offers',
        'product_updates',
        'security_updates'
      ]::text[]),
      check (completed_at >= effective_at)
    );

    create trigger privacy_marketing_reopt_in_runs_append_only
      before update or delete on privacy_marketing_reopt_in_runs
      for each row execute function reject_deletion_safety_evidence_mutation();

    alter table policy_audit_outcomes
      drop constraint policy_audit_outcomes_reason_code_check;
    alter table policy_audit_outcomes
      add constraint policy_audit_outcomes_reason_code_check check (reason_code in (
        'customer_message_applied',
        'business_echo_pause',
        'echo_not_later_than_resume',
        'message_status_ignored',
        'pause_active',
        'pause_inactive',
        'privacy_request_open',
        'resume_applied',
        'resume_duplicate',
        'consent_grant',
        'consent_revoke',
        'consent_duplicate',
        'consent_missing',
        'consent_latest_grant',
        'consent_latest_revoke',
        'global_marketing_opt_out',
        'identity_not_found'
      ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table policy_audit_outcomes
      drop constraint policy_audit_outcomes_reason_code_check;
    alter table policy_audit_outcomes
      add constraint policy_audit_outcomes_reason_code_check check (reason_code in (
        'customer_message_applied',
        'business_echo_pause',
        'echo_not_later_than_resume',
        'message_status_ignored',
        'pause_active',
        'pause_inactive',
        'privacy_request_open',
        'resume_applied',
        'resume_duplicate',
        'consent_grant',
        'consent_revoke',
        'consent_duplicate',
        'consent_missing',
        'consent_latest_grant',
        'consent_latest_revoke',
        'identity_not_found'
      ));

    drop trigger privacy_marketing_reopt_in_runs_append_only
      on privacy_marketing_reopt_in_runs;
    drop table privacy_marketing_reopt_in_runs;
    drop index privacy_marketing_opt_out_runs_source_unique;
  `);
}
