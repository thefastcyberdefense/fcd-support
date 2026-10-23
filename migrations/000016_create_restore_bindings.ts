import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table operations_restore_bindings (
      restore_ref text primary key references runtime_recovery_holds(restore_ref)
        check (restore_ref ~ '^restore_[a-f0-9]{32}$'),
      restore_run_id bigint not null unique references operations_restore_runs(id),
      backup_ref text not null check (backup_ref ~ '^backup_[a-f0-9]{32}$'),
      checkpoint_ref text not null check (checkpoint_ref ~ '^checkpoint_[a-f0-9]{32}$'),
      git_revision text not null check (git_revision ~ '^[a-f0-9]{40}$'),
      schema_revision text not null check (schema_revision ~ '^[0-9]{6}$'),
      target_identity jsonb not null check (jsonb_typeof(target_identity)='object'),
      target_identity_sha256 text not null check (target_identity_sha256 ~ '^[a-f0-9]{64}$'),
      source_system_identifier text not null check (source_system_identifier ~ '^[1-9][0-9]{0,19}$'),
      source_epoch uuid not null,
      source_sequence bigint not null check (source_sequence >= 0),
      checkpoint_ciphertext_sha256 text not null check (checkpoint_ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
      checkpoint_signature text not null check (checkpoint_signature ~ '^[a-f0-9]{64}$'),
      required_key_versions text[] not null check (cardinality(required_key_versions)>0),
      final_gate_id bigint not null unique references restore_deletion_gates(id),
      recorded_at timestamptz not null
    );
    create trigger operations_restore_bindings_append_only
      before update or delete on operations_restore_bindings
      for each row execute function reject_operations_evidence_mutation();
    create function guard_operations_restore_binding_truncate() returns trigger language plpgsql as $$
    declare populated boolean;
    begin
      -- TRUNCATE already holds ACCESS EXCLUSIVE. Only a fresh READ COMMITTED
      -- lookup may establish emptiness; an older transaction snapshot may not.
      if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'Restore binding truncation blocked' using errcode='55000';
      end if;
      execute pg_catalog.format('select exists(select 1 from %I.%I)',TG_TABLE_SCHEMA,TG_TABLE_NAME) into populated;
      if populated then
        raise exception 'Restore bindings are append-only' using errcode='55000';
      end if;
      return null;
    end $$;
    create trigger operations_restore_bindings_no_truncate
      before truncate on operations_restore_bindings
      for each statement execute function guard_operations_restore_binding_truncate();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table operations_restore_bindings in access exclusive mode;
    do $$ begin
      if pg_catalog.current_setting('transaction_isolation') <> 'read committed'
        or exists(select 1 from operations_restore_bindings) then
        raise exception 'P6-004 rollback blocked: restore bindings exist' using errcode='55000';
      end if;
    end $$;
    drop table operations_restore_bindings;
    drop function guard_operations_restore_binding_truncate();
  `);
}
