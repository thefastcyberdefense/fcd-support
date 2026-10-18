import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table operations_health_checks (
      id bigint generated always as identity primary key,
      component text not null check (component in (
        'webhook','postgres','reply','outbound','notification','manifest',
        'n8n','tunnel','backup','migration','deletion_checkpoint'
      )),
      state text not null check (state in ('healthy','degraded','unavailable','disabled','unknown')),
      reason_code text not null check (reason_code in (
        'ok','timeout','dependency_unavailable','not_verified','disabled',
        'stale','configuration_invalid','collection_failed'
      )),
      checked_at timestamptz not null,
      duration_milliseconds integer not null check (duration_milliseconds between 0 and 300000),
      unique (component, checked_at)
    );
    create table operations_incidents (
      id bigint generated always as identity primary key,
      incident_ref text not null unique check (incident_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      component text not null check (component in (
        'webhook','postgres','reply','outbound','notification','manifest',
        'n8n','tunnel','backup','migration','deletion_checkpoint'
      )),
      opened_at timestamptz not null,
      last_observed_at timestamptz not null check (last_observed_at >= opened_at),
      consecutive_failures integer not null check (consecutive_failures > 0),
      acknowledged_at timestamptz check (acknowledged_at >= opened_at),
      acknowledged_by_account_id bigint references admin_accounts(id),
      resolved_at timestamptz check (resolved_at >= last_observed_at),
      check ((acknowledged_at is null) = (acknowledged_by_account_id is null))
    );
    create unique index operations_open_incident_component_idx
      on operations_incidents(component) where resolved_at is null;
    create index operations_health_latest_idx on operations_health_checks(component, checked_at desc);
    create table operations_incident_events (
      id bigint generated always as identity primary key,
      incident_id bigint not null references operations_incidents(id),
      action text not null check (action in ('opened','observed','acknowledged','resolved')),
      health_check_id bigint references operations_health_checks(id),
      actor_account_id bigint references admin_accounts(id),
      request_key text unique check (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      effective_at timestamptz not null,
      check ((action = 'acknowledged' and actor_account_id is not null
              and request_key is not null and health_check_id is null)
          or (action <> 'acknowledged' and actor_account_id is null
              and request_key is null and health_check_id is not null)),
      unique(health_check_id)
    );
    create table operations_backups (
      id bigint generated always as identity primary key,
      backup_ref text not null unique check (backup_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      class text not null check (class in ('daily','monthly','pre_migration')),
      created_at timestamptz not null,
      git_revision text not null check (git_revision ~ '^[a-f0-9]{40}$'),
      schema_revision text not null check (schema_revision ~ '^[0-9]{6}$'),
      ciphertext_bytes bigint not null check (ciphertext_bytes between 1 and 9007199254740991),
      ciphertext_sha256 text not null check (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
      state text not null check (state in ('created','verified','restore_verified','pruned','failed'))
    );
    create table operations_backup_events (
      id bigint generated always as identity primary key,
      backup_id bigint not null references operations_backups(id),
      state text not null check (state in ('created','verified','restore_verified','pruned','failed')),
      recorded_at timestamptz not null,
      unique(backup_id, state)
    );
    create table operations_deployments (
      id bigint generated always as identity primary key,
      git_revision text not null check (git_revision ~ '^[a-f0-9]{40}$'),
      schema_revision text not null check (schema_revision ~ '^[0-9]{6}$'),
      recorded_at timestamptz not null,
      status text not null check (status in ('started','succeeded','failed','rolled_back')),
      unique(git_revision, recorded_at)
    );
    create table operations_restore_runs (
      id bigint generated always as identity primary key,
      restore_ref text not null check (restore_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      backup_ref text not null check (backup_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      checkpoint_ref text check (checkpoint_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
      git_revision text not null check (git_revision ~ '^[a-f0-9]{40}$'),
      schema_revision text not null check (schema_revision ~ '^[0-9]{6}$'),
      state text not null check (state in ('isolated','reconciled','passed','failed')),
      recorded_at timestamptz not null,
      unique(restore_ref, state),
      check (state not in ('reconciled','passed') or checkpoint_ref is not null)
    );
    create function reject_operations_evidence_mutation() returns trigger language plpgsql as $$
    begin raise exception 'Operations evidence is append-only' using errcode = '55000'; end $$;
    create trigger operations_health_append_only before update or delete on operations_health_checks
      for each row execute function reject_operations_evidence_mutation();
    create trigger operations_incident_events_append_only before update or delete on operations_incident_events
      for each row execute function reject_operations_evidence_mutation();
    create trigger operations_backup_events_append_only before update or delete on operations_backup_events
      for each row execute function reject_operations_evidence_mutation();
    create trigger operations_deployments_append_only before update or delete on operations_deployments
      for each row execute function reject_operations_evidence_mutation();
    create trigger operations_restore_runs_append_only before update or delete on operations_restore_runs
      for each row execute function reject_operations_evidence_mutation();
    create function guard_operations_backup_material() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then raise exception 'Backup history is retained' using errcode = '55000'; end if;
      if (new.backup_ref, new.class, new.created_at, new.git_revision, new.schema_revision,
          new.ciphertext_bytes, new.ciphertext_sha256) is distinct from
         (old.backup_ref, old.class, old.created_at, old.git_revision, old.schema_revision,
          old.ciphertext_bytes, old.ciphertext_sha256) then
        raise exception 'Backup material is immutable' using errcode = '55000';
      end if;
      return new;
    end $$;
    create trigger operations_backup_material_guard before update or delete on operations_backups
      for each row execute function guard_operations_backup_material();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from operations_health_checks)
        or exists(select 1 from operations_incidents)
        or exists(select 1 from operations_incident_events)
        or exists(select 1 from operations_backups)
        or exists(select 1 from operations_backup_events)
        or exists(select 1 from operations_deployments)
        or exists(select 1 from operations_restore_runs) then
        raise exception 'P6-002 rollback blocked: operations evidence exists' using errcode = '55000';
      end if;
    end $$;
    drop table operations_restore_runs, operations_deployments, operations_backup_events,
      operations_backups, operations_incident_events, operations_incidents, operations_health_checks;
    drop function guard_operations_backup_material();
    drop function reject_operations_evidence_mutation();
  `);
}
