import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table webhook_events
      drop constraint webhook_events_outcome_allowed,
      drop constraint if exists webhook_events_suppressed_shape;
    alter table webhook_events
      add constraint webhook_events_outcome_allowed
        check (admission_outcome in ('pending', 'stale', 'unsupported', 'suppressed')),
      add constraint webhook_events_suppressed_shape
        check (
          admission_outcome <> 'suppressed'
          or (
            channel in ('messenger', 'whatsapp')
            and channel_account_id is null
            and contact_id is null
            and external_message_id is null
            and message_text is null
            and message_status is null
            and reason_code = 'deletion_tombstone'
            and idempotency_key
              ~ '^privacy:[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[0-9a-f]{64}$'
          )
        );

    alter table webhook_event_applications
      drop constraint webhook_event_applications_outcome_check,
      drop constraint webhook_event_applications_check;
    alter table webhook_event_applications
      add constraint webhook_event_applications_outcome_check
        check (outcome in (
          'customer_message_applied',
          'business_echo_paused',
          'business_echo_ignored_before_resume',
          'message_status_ignored',
          'identity_suppressed'
        )),
      add constraint webhook_event_applications_check
        check (
          (
            outcome in ('message_status_ignored', 'identity_suppressed')
            and conversation_id is null
          )
          or (
            outcome not in ('message_status_ignored', 'identity_suppressed')
            and conversation_id is not null
          )
        );

    create table privacy_requests (
      id bigint generated always as identity primary key,
      request_ref text not null unique,
      request_type text not null check (
        request_type in ('deletion', 'access', 'correction')
      ),
      state text not null check (state in (
        'received',
        'awaiting_confirmation',
        'human_review',
        'in_progress',
        'completed',
        'partially_completed',
        'rejected',
        'cancelled'
      )),
      contact_id bigint references contacts(id) on delete set null,
      source_webhook_event_id bigint references webhook_events(id) on delete set null,
      received_at timestamptz not null,
      target_at timestamptz,
      decision_at timestamptz,
      completed_at timestamptz,
      reviewer_reference text,
      decision_code text,
      reason_code text,
      open_request_key text not null unique,
      updated_at timestamptz not null default now(),
      row_version bigint not null default 1 check (row_version > 0),
      check (btrim(request_ref) <> '' and char_length(request_ref) <= 128),
      check (btrim(open_request_key) <> '' and char_length(open_request_key) <= 128),
      check (
        reviewer_reference is null
        or (btrim(reviewer_reference) <> '' and char_length(reviewer_reference) <= 128)
      ),
      check (
        decision_code is null
        or (btrim(decision_code) <> '' and char_length(decision_code) <= 64)
      ),
      check (
        reason_code is null
        or (btrim(reason_code) <> '' and char_length(reason_code) <= 64)
      ),
      check (target_at is null or target_at >= received_at),
      check (decision_at is null or decision_at >= received_at),
      check (completed_at is null or completed_at >= received_at)
    );

    create table privacy_request_locations (
      request_id bigint not null references privacy_requests(id),
      location_code text not null check (location_code in (
        'primary_postgres',
        'manifest_recordings',
        'meta_provider',
        'pending_outbound',
        'operator_exports',
        'offline_archives',
        'backup_tombstone_gate'
      )),
      required boolean not null,
      state text not null check (state in (
        'pending',
        'completed',
        'not_applicable',
        'failed'
      )),
      outcome_code text,
      reviewer_reference text,
      checked_at timestamptz,
      primary key (request_id, location_code),
      check (
        outcome_code is null
        or (btrim(outcome_code) <> '' and char_length(outcome_code) <= 64)
      ),
      check (
        reviewer_reference is null
        or (btrim(reviewer_reference) <> '' and char_length(reviewer_reference) <= 128)
      )
    );

    create table privacy_suppressions (
      id bigint generated always as identity primary key,
      identity_hmac text not null check (identity_hmac ~ '^[0-9a-f]{64}$'),
      channel text not null check (channel in ('messenger', 'whatsapp')),
      category text not null check (
        category in ('marketing_opt_out', 'deletion_tombstone')
      ),
      reason_code text not null check (
        reason_code in ('customer_deletion', 'customer_opt_out')
      ),
      effective_at timestamptz not null,
      key_version text not null,
      expires_at timestamptz,
      unique (identity_hmac, channel, category, key_version),
      check (
        btrim(key_version) <> ''
        and char_length(key_version) <= 64
        and key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      ),
      check (expires_at is null or expires_at > effective_at)
    );

    create table privacy_request_events (
      id bigint generated always as identity primary key,
      request_id bigint not null references privacy_requests(id),
      action text not null check (action in (
        'request_received',
        'reviewer_decision',
        'deletion_executed',
        'location_checked'
      )),
      outcome text not null check (outcome in ('applied', 'rejected')),
      reason_code text not null check (reason_code in (
        'customer_requested',
        'customer_confirmed',
        'identity_ambiguous',
        'request_withdrawn',
        'local_erasure_complete',
        'location_complete',
        'location_not_applicable',
        'location_failed'
      )),
      previous_state text,
      resulting_state text not null,
      actor_type text not null check (actor_type in (
        'customer',
        'support_reviewer',
        'deletion_job'
      )),
      reviewer_reference text,
      source_webhook_event_id bigint references webhook_events(id) on delete set null,
      effective_at timestamptz not null,
      request_key text not null unique,
      created_at timestamptz not null default now(),
      check (
        previous_state is null
        or previous_state in (
          'received',
          'awaiting_confirmation',
          'human_review',
          'in_progress',
          'completed',
          'partially_completed',
          'rejected',
          'cancelled'
        )
      ),
      check (resulting_state in (
        'received',
        'awaiting_confirmation',
        'human_review',
        'in_progress',
        'completed',
        'partially_completed',
        'rejected',
        'cancelled'
      )),
      check (
        reviewer_reference is null
        or (btrim(reviewer_reference) <> '' and char_length(reviewer_reference) <= 128)
      ),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128)
    );

    create table privacy_notification_intents (
      id bigint generated always as identity primary key,
      request_id bigint not null references privacy_requests(id),
      notification_type text not null check (
        notification_type = 'operator_privacy_request'
      ),
      state text not null check (state in ('pending', 'delivered', 'failed')),
      attempt_count integer not null default 0 check (attempt_count >= 0),
      idempotency_key text not null unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (
        btrim(idempotency_key) <> ''
        and char_length(idempotency_key) <= 128
      )
    );

    create table privacy_deletion_runs (
      id bigint generated always as identity primary key,
      request_id bigint not null references privacy_requests(id),
      request_key text not null unique,
      executed_at timestamptz not null,
      conversations_processed integer not null check (conversations_processed >= 0),
      identities_pseudonymized integer not null check (identities_pseudonymized >= 0),
      messages_cleared integer not null check (messages_cleared >= 0),
      tombstones_created integer not null check (tombstones_created >= 0),
      status text not null check (status = 'applied'),
      completed_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (completed_at >= executed_at)
    );

    create table restore_deletion_gates (
      id bigint generated always as identity primary key,
      gate_ref text not null,
      request_key text not null unique,
      action text not null check (action in ('reapply_batch', 'finalize')),
      status text not null check (status in ('applied', 'failed', 'passed')),
      evaluated_at timestamptz not null,
      git_revision text not null check (git_revision ~ '^[0-9a-f]{40}$'),
      required_key_versions text[] not null,
      identities_processed integer not null check (identities_processed >= 0),
      remaining_matches integer not null check (remaining_matches >= 0),
      completed_at timestamptz not null default now(),
      check (btrim(gate_ref) <> '' and char_length(gate_ref) <= 128),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (cardinality(required_key_versions) > 0),
      check (
        status <> 'passed'
        or (action = 'finalize' and remaining_matches = 0)
      ),
      check (completed_at >= evaluated_at)
    );

    create index privacy_requests_state_received_idx
      on privacy_requests (state, received_at, id);
    create index privacy_request_events_request_effective_idx
      on privacy_request_events (request_id, effective_at, id);
    create index privacy_notification_intents_pending_idx
      on privacy_notification_intents (created_at, id)
      where state in ('pending', 'failed');
    create index privacy_suppressions_lookup_idx
      on privacy_suppressions (identity_hmac, channel, key_version);
    create unique index restore_deletion_gates_passed_finalize_unique
      on restore_deletion_gates (gate_ref)
      where action = 'finalize' and status = 'passed';

    create function reject_deletion_safety_evidence_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using
        errcode = '23514',
        message = 'deletion safety evidence is append-only';
      return null;
    end;
    $$;

    create trigger privacy_request_events_append_only
      before update or delete on privacy_request_events
      for each row execute function reject_deletion_safety_evidence_mutation();
    create trigger privacy_deletion_runs_append_only
      before update or delete on privacy_deletion_runs
      for each row execute function reject_deletion_safety_evidence_mutation();
    create trigger restore_deletion_gates_append_only
      before update or delete on restore_deletion_gates
      for each row execute function reject_deletion_safety_evidence_mutation();

    create function enforce_privacy_request_completion()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.state = 'completed' and exists (
        select 1
        from privacy_request_locations
        where request_id = new.id
          and required
          and state in ('pending', 'failed')
      ) then
        raise exception using
          errcode = '23514',
          message = 'privacy request has unresolved required locations';
      end if;

      return new;
    end;
    $$;

    create trigger privacy_requests_completion_guard
      before insert or update on privacy_requests
      for each row execute function enforce_privacy_request_completion();

    create function enforce_completed_request_location()
    returns trigger
    language plpgsql
    as $$
    declare
      request_state text;
    begin
      select state
      into request_state
      from privacy_requests
      where id = new.request_id
      for update;

      if request_state = 'completed'
         and new.required
         and new.state in ('pending', 'failed') then
        raise exception using
          errcode = '23514',
          message = 'completed privacy request cannot gain an unresolved required location';
      end if;

      return new;
    end;
    $$;

    create trigger privacy_request_locations_completion_guard
      before insert or update on privacy_request_locations
      for each row execute function enforce_completed_request_location();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger privacy_request_locations_completion_guard
      on privacy_request_locations;
    drop trigger privacy_requests_completion_guard on privacy_requests;
    drop trigger restore_deletion_gates_append_only on restore_deletion_gates;
    drop trigger privacy_deletion_runs_append_only on privacy_deletion_runs;
    drop trigger privacy_request_events_append_only on privacy_request_events;
    drop function enforce_completed_request_location();
    drop function enforce_privacy_request_completion();
    drop function reject_deletion_safety_evidence_mutation();

    drop table restore_deletion_gates;
    drop table privacy_deletion_runs;
    drop table privacy_notification_intents;
    drop table privacy_request_events;
    drop table privacy_suppressions;
    drop table privacy_request_locations;
    drop table privacy_requests;

    -- The event/application outcome widenings are intentionally non-destructive
    -- on rollback. Restoring the old checks would require deleting privacy-safe
    -- suppressed events or immutable identity_suppressed evidence.
  `);
}
