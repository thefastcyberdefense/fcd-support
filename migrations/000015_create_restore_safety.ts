import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table deletion_checkpoint_clock (
      singleton boolean primary key default true check (singleton),
      source_epoch uuid not null default gen_random_uuid(),
      revision bigint not null default 0 check (revision >= 0)
    );
    insert into deletion_checkpoint_clock(singleton) values (true);
    create function advance_deletion_checkpoint_clock() returns trigger language plpgsql as $$
    begin
      if TG_OP='TRUNCATE' then
        update deletion_checkpoint_clock set revision=revision+1;
        return null;
      end if;
      if (TG_OP <> 'INSERT' and OLD.category='deletion_tombstone')
        or (TG_OP <> 'DELETE' and NEW.category='deletion_tombstone') then
        update deletion_checkpoint_clock set revision=revision+1;
      end if;
      return null;
    end $$;
    create trigger deletion_checkpoint_clock_changes after insert or update or delete on privacy_suppressions
      for each row execute function advance_deletion_checkpoint_clock();
    create trigger deletion_checkpoint_clock_truncation after truncate on privacy_suppressions
      for each statement execute function advance_deletion_checkpoint_clock();
    create table deletion_checkpoints (
      checkpoint_ref text primary key check (checkpoint_ref ~ '^checkpoint_[a-f0-9]{32}$'),
      source_epoch uuid not null, sequence bigint not null check (sequence >= 0),
      source_revision text not null check (source_revision ~ '^[a-f0-9]{40}$'),
      schema_revision text not null check (schema_revision ~ '^[0-9]{6}$'),
      snapshot_at timestamptz not null, valid_until timestamptz,
      row_count integer not null check (row_count >= 0),
      required_key_versions text[] not null,
      ciphertext_bytes bigint not null check (ciphertext_bytes > 0),
      ciphertext_sha256 text not null check (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
      signature text not null check (signature ~ '^[a-f0-9]{64}$')
    );
    create table restore_checkpoint_imports (
      restore_ref text primary key check (restore_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      checkpoint_ref text not null, source_epoch uuid not null,
      sequence bigint not null check (sequence >= 0),
      row_count integer not null check (row_count >= 0),
      required_key_versions text[] not null,
      ciphertext_sha256 text not null check (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
      signature text not null check (signature ~ '^[a-f0-9]{64}$'), imported_at timestamptz not null
    );
    create table runtime_recovery_holds (
      restore_ref text primary key check (restore_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      created_at timestamptz not null, quarantined_count integer not null check (quarantined_count >= 0)
    );
    create table runtime_recovery_reviews (
      restore_ref text primary key references runtime_recovery_holds(restore_ref),
      reviewer_account_id bigint not null references admin_accounts(id),
      reviewed_at timestamptz not null,
      consent_reconciled boolean not null check (consent_reconciled),
      suppression_reconciled boolean not null check (suppression_reconciled),
      pause_reconciled boolean not null check (pause_reconciled),
      privacy_reconciled boolean not null check (privacy_reconciled),
      channel_policy_reconciled boolean not null check (channel_policy_reconciled)
    );
    create table runtime_restore_quarantine (
      source_kind text not null check (source_kind in ('webhook_event','processing_work','model_lease',
        'reply_draft','outbound_intent','notification_work','privacy_notification','support_escalation','outbound_escalation')),
      source_id bigint not null check (source_id > 0),
      restore_ref text not null references runtime_recovery_holds(restore_ref),
      reason text not null check (reason='restore_quarantined'),
      recorded_at timestamptz not null,
      primary key(source_kind,source_id)
    );
    create function guard_runtime_recovery_review() returns trigger language plpgsql as $$
    declare held_at timestamptz;
    begin
      select created_at into held_at from runtime_recovery_holds where restore_ref=NEW.restore_ref for share;
      if held_at is null or NEW.reviewed_at < held_at then
        raise exception 'recovery_review_invalid' using errcode='23514';
      end if;
      if not exists(select 1 from admin_accounts account
        join lateral (select action from admin_role_assignments assignment
          where assignment.account_id=account.id and assignment.role='administrator'
            and assignment.effective_at <= NEW.reviewed_at
          order by assignment.effective_at desc,assignment.id desc limit 1) role on role.action='assign'
        where account.id=NEW.reviewer_account_id and account.state='active') then
        raise exception 'recovery_review_forbidden' using errcode='42501';
      end if;
      return NEW;
    end $$;
    create trigger runtime_recovery_review_guard before insert on runtime_recovery_reviews
      for each row execute function guard_runtime_recovery_review();
    create function runtime_recovery_held() returns boolean language sql stable as $$
      select exists(select 1 from runtime_recovery_holds hold
        where not exists(select 1 from runtime_recovery_reviews review where review.restore_ref=hold.restore_ref))
    $$;
    create function guard_runtime_recovery_hold() returns trigger language plpgsql as $$
    begin
      if runtime_recovery_held() and NEW.state = any(TG_ARGV[0]::text[]) then
        raise exception 'runtime_recovery_hold' using errcode='55000';
      end if;
      return NEW;
    end $$;
    create trigger recovery_hold_processing before insert or update on runtime_processing_work
      for each row execute function guard_runtime_recovery_hold('{pending,leased}');
    create trigger recovery_hold_model before insert or update on model_call_leases
      for each row execute function guard_runtime_recovery_hold('{queued,active}');
    create trigger recovery_hold_draft before insert or update on support_reply_drafts
      for each row execute function guard_runtime_recovery_hold('{ready}');
    create trigger recovery_hold_intent before insert or update on outbound_intents
      for each row execute function guard_runtime_recovery_hold('{pending,leased}');
    create trigger recovery_hold_attempt before insert or update on outbound_attempts
      for each row execute function guard_runtime_recovery_hold('{authorized,dispatch_started}');
    create trigger recovery_hold_notification before insert or update on notification_delivery_work
      for each row execute function guard_runtime_recovery_hold('{pending,leased}');
    alter table outbound_intents drop constraint outbound_intents_terminal_reason_check;
    alter table outbound_intents add constraint outbound_intents_terminal_reason_check check (
      terminal_reason is null or terminal_reason in ('policy_unavailable','limit_exhausted','pause_active',
      'echo_correlation_hold','privacy_hold','identity_deleted','suppressed','consent_missing','window_closed',
      'template_required','template_invalid','content_erased','retention_expired','active_review_overdue',
      'provider_rejected','delivery_unknown','retry_exhausted','restore_quarantined'));
    create trigger deletion_checkpoints_append_only before update or delete on deletion_checkpoints
      for each row execute function reject_operations_evidence_mutation();
    create trigger restore_checkpoint_imports_append_only before update or delete on restore_checkpoint_imports
      for each row execute function reject_operations_evidence_mutation();
    create trigger runtime_recovery_holds_append_only before update or delete on runtime_recovery_holds
      for each row execute function reject_operations_evidence_mutation();
    create trigger runtime_recovery_reviews_append_only before update or delete on runtime_recovery_reviews
      for each row execute function reject_operations_evidence_mutation();
    create trigger runtime_restore_quarantine_append_only before update or delete on runtime_restore_quarantine
      for each row execute function reject_operations_evidence_mutation();
  `);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from runtime_recovery_holds) or exists(select 1 from runtime_restore_quarantine)
        or exists(select 1 from runtime_recovery_reviews) or exists(select 1 from deletion_checkpoints)
        or exists(select 1 from restore_checkpoint_imports) then
        raise exception 'P6-004 rollback blocked: recovery evidence exists' using errcode='55000';
      end if;
    end $$;
    drop trigger recovery_hold_notification on notification_delivery_work;
    drop trigger recovery_hold_attempt on outbound_attempts;
    drop trigger recovery_hold_intent on outbound_intents;
    drop trigger recovery_hold_draft on support_reply_drafts;
    drop trigger recovery_hold_model on model_call_leases;
    drop trigger recovery_hold_processing on runtime_processing_work;
    drop function guard_runtime_recovery_hold();
    drop function runtime_recovery_held();
    alter table outbound_intents drop constraint outbound_intents_terminal_reason_check;
    alter table outbound_intents add constraint outbound_intents_terminal_reason_check check (
      terminal_reason is null or terminal_reason in ('policy_unavailable','limit_exhausted','pause_active',
      'echo_correlation_hold','privacy_hold','identity_deleted','suppressed','consent_missing','window_closed',
      'template_required','template_invalid','content_erased','retention_expired','active_review_overdue',
      'provider_rejected','delivery_unknown','retry_exhausted'));
    drop table runtime_restore_quarantine, runtime_recovery_reviews, runtime_recovery_holds,
      restore_checkpoint_imports, deletion_checkpoints;
    drop function guard_runtime_recovery_review();
    drop trigger deletion_checkpoint_clock_truncation on privacy_suppressions;
    drop trigger deletion_checkpoint_clock_changes on privacy_suppressions;
    drop function advance_deletion_checkpoint_clock();
    drop table deletion_checkpoint_clock;
  `);
}
