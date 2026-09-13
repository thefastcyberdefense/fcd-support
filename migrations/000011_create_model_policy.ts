import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table model_policy_versions (
      id bigint generated always as identity primary key,
      policy_ref text not null unique check (
        policy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      version_number integer not null unique check (version_number > 0),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      state text not null check (state in (
        'draft', 'submitted', 'approved', 'active', 'retired'
      )),
      per_contact_15_minute_calls integer not null check (
        per_contact_15_minute_calls between 1 and 100
      ),
      per_contact_24_hour_calls integer not null check (
        per_contact_24_hour_calls between 1 and 1000
      ),
      global_utc_day_calls integer not null check (
        global_utc_day_calls between 1 and 100000
      ),
      concurrent_calls integer not null check (concurrent_calls between 1 and 100),
      queue_capacity integer not null check (queue_capacity between 0 and 10000),
      total_timeout_ms integer not null check (total_timeout_ms between 100 and 120000),
      output_tokens integer not null check (output_tokens between 1 and 4096),
      cooldown_ms integer not null check (cooldown_ms between 0 and 86400000),
      faq_minimum_similarity numeric(6,5) not null check (
        faq_minimum_similarity > 0 and faq_minimum_similarity <= 1
      ),
      faq_ambiguity_margin numeric(6,5) not null check (
        faq_ambiguity_margin >= 0 and faq_ambiguity_margin < faq_minimum_similarity
      ),
      maximum_faq_candidates integer not null check (
        maximum_faq_candidates between 2 and 100
      ),
      approved_provider_attempts integer not null check (
        approved_provider_attempts between 1 and 5
      ),
      architecture_provider_ceiling integer not null check (
        architecture_provider_ceiling between 1 and 5
      ),
      created_by_account_id bigint not null references admin_accounts(id),
      approved_by_account_id bigint references admin_accounts(id),
      created_at timestamptz not null,
      submitted_at timestamptz,
      approved_at timestamptz,
      activated_at timestamptz,
      retired_at timestamptz,
      check (per_contact_15_minute_calls <= per_contact_24_hour_calls),
      check (per_contact_24_hour_calls <= global_utc_day_calls),
      check (approved_provider_attempts <= architecture_provider_ceiling),
      check (
        (state = 'draft'
          and submitted_at is null and approved_at is null
          and approved_by_account_id is null
          and activated_at is null and retired_at is null)
        or (state = 'submitted'
          and submitted_at is not null and approved_at is null
          and approved_by_account_id is null
          and activated_at is null and retired_at is null)
        or (state = 'approved'
          and submitted_at is not null and approved_at is not null
          and approved_by_account_id is not null
          and activated_at is null and retired_at is null)
        or (state = 'active'
          and submitted_at is not null and approved_at is not null
          and approved_by_account_id is not null
          and activated_at is not null and retired_at is null)
        or (state = 'retired'
          and submitted_at is not null and approved_at is not null
          and approved_by_account_id is not null
          and activated_at is not null and retired_at is not null)
      ),
      check (submitted_at is null or submitted_at >= created_at),
      check (approved_at is null or approved_at >= submitted_at),
      check (activated_at is null or activated_at >= approved_at),
      check (retired_at is null or retired_at >= activated_at)
    );

    create unique index model_policy_versions_one_active_idx
      on model_policy_versions ((state))
      where state = 'active';
    create index model_policy_versions_state_version_idx
      on model_policy_versions (state, version_number desc, id desc);

    create table model_policy_review_events (
      id bigint generated always as identity primary key,
      policy_version_id bigint not null references model_policy_versions(id),
      action text not null check (action in ('submit', 'approve', 'activate', 'retire')),
      reviewer_account_id bigint not null references admin_accounts(id),
      reason_code text not null check (
        reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      effective_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create index model_policy_review_events_policy_time_idx
      on model_policy_review_events (policy_version_id, effective_at, id);

    create table model_usage_windows (
      id bigint generated always as identity primary key,
      policy_version_id bigint not null references model_policy_versions(id),
      window_kind text not null check (window_kind in (
        'contact_15_minute', 'contact_24_hour', 'global_utc_day'
      )),
      contact_scope_key text check (
        contact_scope_key is null or contact_scope_key ~ '^[0-9a-f]{64}$'
      ),
      window_started_at timestamptz not null,
      window_ended_at timestamptz not null,
      call_count integer not null check (call_count between 0 and 1000000000),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique nulls not distinct (window_kind, contact_scope_key, window_started_at),
      check (window_ended_at > window_started_at),
      check (expires_at >= window_ended_at),
      check (updated_at >= created_at),
      check (
        (window_kind = 'contact_15_minute'
          and contact_scope_key is not null
          and window_ended_at = window_started_at + interval '15 minutes')
        or (window_kind = 'contact_24_hour'
          and contact_scope_key is not null
          and window_ended_at = window_started_at + interval '24 hours')
        or (window_kind = 'global_utc_day'
          and contact_scope_key is null
          and window_started_at = date_trunc('day', window_started_at at time zone 'UTC') at time zone 'UTC'
          and window_ended_at = window_started_at + interval '24 hours')
      )
    );

    create index model_usage_windows_expiry_idx
      on model_usage_windows (expires_at, id);
    create index model_usage_windows_policy_kind_idx
      on model_usage_windows (policy_version_id, window_kind, window_started_at);

    create table model_call_leases (
      id bigint generated always as identity primary key,
      logical_call_key text not null unique check (
        btrim(logical_call_key) <> '' and char_length(logical_call_key) <= 128
      ),
      source_webhook_event_id bigint not null unique references webhook_events(id),
      conversation_id bigint not null references conversations(id),
      policy_version_id bigint not null references model_policy_versions(id),
      state text not null check (state in (
        'queued', 'active', 'completed', 'failed', 'expired'
      )),
      outcome_code text check (outcome_code is null or outcome_code in (
        'completed', 'invalid_request', 'aborted', 'timeout',
        'network_failure', 'non_2xx', 'provider_exhausted',
        'oversized_body', 'malformed_body', 'invalid_envelope',
        'rate_limited', 'global_limit', 'queue_full', 'cooldown',
        'policy_disabled', 'guard_blocked', 'lease_expired', 'database_failure'
      )),
      lease_expires_at timestamptz not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      activated_at timestamptz,
      finished_at timestamptz,
      check (lease_expires_at > created_at),
      check (updated_at >= created_at),
      check (
        (state = 'queued'
          and activated_at is null and finished_at is null and outcome_code is null)
        or (state = 'active'
          and activated_at is not null and finished_at is null and outcome_code is null)
        or (state = 'completed'
          and activated_at is not null and finished_at is not null
          and outcome_code = 'completed')
        or (state = 'failed'
          and finished_at is not null and outcome_code is not null
          and outcome_code not in ('completed', 'lease_expired'))
        or (state = 'expired'
          and finished_at is not null and outcome_code = 'lease_expired')
      ),
      check (activated_at is null or activated_at >= created_at),
      check (finished_at is null or finished_at >= created_at)
    );

    create index model_call_leases_state_expiry_idx
      on model_call_leases (state, lease_expires_at, id);
    create index model_call_leases_conversation_created_idx
      on model_call_leases (conversation_id, created_at desc, id desc);

    create function enforce_model_policy_version_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Model policy versions are immutable';
      end if;

      if old.policy_ref is distinct from new.policy_ref
         or old.version_number is distinct from new.version_number
         or old.request_key is distinct from new.request_key
         or old.per_contact_15_minute_calls is distinct from new.per_contact_15_minute_calls
         or old.per_contact_24_hour_calls is distinct from new.per_contact_24_hour_calls
         or old.global_utc_day_calls is distinct from new.global_utc_day_calls
         or old.concurrent_calls is distinct from new.concurrent_calls
         or old.queue_capacity is distinct from new.queue_capacity
         or old.total_timeout_ms is distinct from new.total_timeout_ms
         or old.output_tokens is distinct from new.output_tokens
         or old.cooldown_ms is distinct from new.cooldown_ms
         or old.faq_minimum_similarity is distinct from new.faq_minimum_similarity
         or old.faq_ambiguity_margin is distinct from new.faq_ambiguity_margin
         or old.maximum_faq_candidates is distinct from new.maximum_faq_candidates
         or old.approved_provider_attempts is distinct from new.approved_provider_attempts
         or old.architecture_provider_ceiling is distinct from new.architecture_provider_ceiling
         or old.created_by_account_id is distinct from new.created_by_account_id
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Model policy values are immutable';
      end if;

      if pg_trigger_depth() < 2 and (
        old.state is distinct from new.state
        or old.approved_by_account_id is distinct from new.approved_by_account_id
        or old.submitted_at is distinct from new.submitted_at
        or old.approved_at is distinct from new.approved_at
        or old.activated_at is distinct from new.activated_at
        or old.retired_at is distinct from new.retired_at
      ) then
        raise exception using errcode = '23514', message = 'Model policy state changes require a review event';
      end if;
      return new;
    end;
    $$;

    create trigger model_policy_versions_mutation
      before update or delete on model_policy_versions
      for each row execute function enforce_model_policy_version_mutation();

    create function apply_model_policy_review_event()
    returns trigger
    language plpgsql
    as $$
    declare
      current_policy model_policy_versions%rowtype;
    begin
      if new.action in ('activate', 'retire') then
        perform pg_advisory_xact_lock(7100415);
      end if;

      select * into current_policy
      from model_policy_versions
      where id = new.policy_version_id
      for update;

      if new.action = 'submit' and current_policy.state = 'draft'
         and new.effective_at >= current_policy.created_at then
        update model_policy_versions
        set state = 'submitted', submitted_at = new.effective_at
        where id = new.policy_version_id;
      elsif new.action = 'approve' and current_policy.state = 'submitted'
         and new.effective_at >= current_policy.submitted_at then
        update model_policy_versions
        set state = 'approved', approved_by_account_id = new.reviewer_account_id,
            approved_at = new.effective_at
        where id = new.policy_version_id;
      elsif new.action = 'activate' and current_policy.state = 'approved'
         and new.effective_at >= current_policy.approved_at then
        update model_policy_versions
        set state = 'active', activated_at = new.effective_at
        where id = new.policy_version_id;
      elsif new.action = 'retire' and current_policy.state = 'active'
         and new.effective_at >= current_policy.activated_at then
        update model_policy_versions
        set state = 'retired', retired_at = new.effective_at
        where id = new.policy_version_id;
      else
        raise exception using errcode = '23514', message = 'Invalid model policy review transition';
      end if;
      return new;
    end;
    $$;

    create trigger model_policy_review_events_apply
      before insert on model_policy_review_events
      for each row execute function apply_model_policy_review_event();

    create function reject_model_policy_review_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using errcode = '23514', message = 'Model policy review history is append-only';
      return null;
    end;
    $$;

    create trigger model_policy_review_events_append_only
      before update or delete on model_policy_review_events
      for each row execute function reject_model_policy_review_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from model_policy_versions)
         or exists (select 1 from model_policy_review_events)
         or exists (select 1 from model_usage_windows)
         or exists (select 1 from model_call_leases) then
        raise exception using
          errcode = '55000',
          message = 'P4-005 rollback blocked: preserve model policy and allowance evidence before schema downgrade';
      end if;
    end;
    $$;

    drop trigger model_policy_review_events_append_only on model_policy_review_events;
    drop trigger model_policy_review_events_apply on model_policy_review_events;
    drop trigger model_policy_versions_mutation on model_policy_versions;
    drop function reject_model_policy_review_mutation();
    drop function apply_model_policy_review_event();
    drop function enforce_model_policy_version_mutation();
    drop table model_call_leases;
    drop table model_usage_windows;
    drop table model_policy_review_events;
    drop table model_policy_versions;
  `);
}
