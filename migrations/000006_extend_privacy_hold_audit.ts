import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table privacy_request_events
      add column location_code text,
      add constraint privacy_request_events_location_code_check check (
        location_code is null
        or location_code in (
          'primary_postgres',
          'manifest_recordings',
          'meta_provider',
          'pending_outbound',
          'operator_exports',
          'offline_archives',
          'backup_tombstone_gate'
        )
      ),
      add constraint privacy_request_events_location_shape_check check (
        (action = 'location_checked' and location_code is not null)
        or (action <> 'location_checked' and location_code is null)
      );

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

    alter table privacy_request_events
      drop constraint privacy_request_events_location_shape_check,
      drop constraint privacy_request_events_location_code_check,
      drop column location_code;
  `);
}
