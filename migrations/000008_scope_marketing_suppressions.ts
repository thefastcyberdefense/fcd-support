import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table privacy_suppressions
      drop constraint privacy_suppressions_category_check;
    alter table privacy_suppressions
      add constraint privacy_suppressions_category_check check (category in (
        'deletion_tombstone',
        'marketing_opt_out',
        'marketing_opt_out:newsletter',
        'marketing_opt_out:product_offers',
        'marketing_opt_out:product_updates',
        'marketing_opt_out:security_updates'
      ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from privacy_access_runs)
         or exists (select 1 from privacy_correction_runs)
         or exists (select 1 from privacy_marketing_opt_out_runs)
         or exists (select 1 from privacy_marketing_reopt_in_runs)
         or exists (
           select 1
           from privacy_notification_intents
           where notification_type = 'operator_marketing_opt_out'
         )
         or exists (
           select 1
           from policy_audit_outcomes
           where reason_code in ('global_marketing_opt_out', 'privacy_request_open')
         )
         or exists (
           select 1
           from privacy_request_events
           where location_code is not null
              or action in ('access_collected', 'correction_executed', 'request_completed')
              or reason_code in (
                'identity_verified',
                'access_collected',
                'correction_applied',
                'correction_manual_required',
                'correction_partially_completed',
                'correction_rejected',
                'request_completed'
              )
              or actor_type in (
                'privacy_export_service',
                'correction_service',
                'privacy_workflow'
              )
         )
         or exists (
           select 1
           from privacy_suppressions
           where category like 'marketing_opt_out:%'
         ) then
        raise exception using
          errcode = '55000',
          message = 'P3-007 rollback blocked: resolve and preserve privacy-rights evidence before schema downgrade';
      end if;
    end;
    $$;

    alter table privacy_suppressions
      drop constraint privacy_suppressions_category_check;
    alter table privacy_suppressions
      add constraint privacy_suppressions_category_check check (
        category in ('marketing_opt_out', 'deletion_tombstone')
      );
  `);
}
