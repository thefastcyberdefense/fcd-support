import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table model_gateway_profiles (
      id bigint generated always as identity primary key,
      gateway_ref text not null unique check (
        gateway_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      version_number integer not null unique check (version_number > 0),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      gateway_kind text not null check (
        gateway_kind in ('manifest_default', 'openai_compatible')
      ),
      display_label text not null check (
        btrim(display_label) <> '' and char_length(display_label) <= 80
      ),
      endpoint_base_url text check (
        endpoint_base_url is null
        or (btrim(endpoint_base_url) <> '' and char_length(endpoint_base_url) <= 512)
      ),
      model_name text not null check (
        model_name ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      ),
      key_version text check (
        key_version is null or key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
      ),
      encrypted_api_key bytea check (
        encrypted_api_key is null or octet_length(encrypted_api_key) between 8 and 4096
      ),
      encryption_nonce bytea check (
        encryption_nonce is null or octet_length(encryption_nonce) = 12
      ),
      authentication_tag bytea check (
        authentication_tag is null or octet_length(authentication_tag) = 16
      ),
      api_key_sha256 text check (
        api_key_sha256 is null or api_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      budget_micro_usd bigint not null check (
        budget_micro_usd between 0 and 1000000000000
      ),
      budget_window_kind text not null check (
        budget_window_kind in ('utc_day', 'utc_month')
      ),
      input_cost_per_million_micro_usd bigint not null check (
        input_cost_per_million_micro_usd between 0 and 100000000000
      ),
      output_cost_per_million_micro_usd bigint not null check (
        output_cost_per_million_micro_usd between 0 and 100000000000
      ),
      state text not null check (state in ('draft', 'active', 'retired')),
      last_test_status text not null default 'untested' check (
        last_test_status in ('untested', 'passed', 'failed')
      ),
      last_tested_at timestamptz,
      last_test_reason_code text check (
        last_test_reason_code is null or last_test_reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      last_test_http_status integer check (
        last_test_http_status is null or last_test_http_status between 100 and 599
      ),
      created_by_account_id bigint not null references admin_accounts(id),
      activated_by_account_id bigint references admin_accounts(id),
      created_at timestamptz not null,
      activated_at timestamptz,
      retired_at timestamptz,
      check (
        (gateway_kind = 'manifest_default'
          and endpoint_base_url is null
          and model_name = 'auto'
          and key_version is null
          and encrypted_api_key is null
          and encryption_nonce is null
          and authentication_tag is null
          and api_key_sha256 is null)
        or (gateway_kind = 'openai_compatible'
          and endpoint_base_url is not null
          and key_version is not null
          and encrypted_api_key is not null
          and encryption_nonce is not null
          and authentication_tag is not null
          and api_key_sha256 is not null)
      ),
      check (
        budget_micro_usd = 0
        or input_cost_per_million_micro_usd > 0
        or output_cost_per_million_micro_usd > 0
      ),
      check (
        (state = 'draft' and activated_at is null and activated_by_account_id is null and retired_at is null)
        or (state = 'active' and activated_at is not null and activated_by_account_id is not null and retired_at is null)
        or (state = 'retired' and activated_at is not null and activated_by_account_id is not null and retired_at is not null)
      ),
      check (activated_at is null or activated_at >= created_at),
      check (retired_at is null or retired_at >= activated_at),
      check (last_tested_at is null or last_tested_at >= created_at),
      check (
        (last_test_status = 'untested' and last_tested_at is null and last_test_reason_code is null and last_test_http_status is null)
        or (last_test_status in ('passed', 'failed') and last_tested_at is not null and last_test_reason_code is not null)
      )
    );

    create unique index model_gateway_profiles_one_active_idx
      on model_gateway_profiles ((state))
      where state = 'active';
    create index model_gateway_profiles_state_version_idx
      on model_gateway_profiles (state, version_number desc, id desc);

    create table model_gateway_test_events (
      id bigint generated always as identity primary key,
      gateway_profile_id bigint not null references model_gateway_profiles(id),
      tester_account_id bigint not null references admin_accounts(id),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      result text not null check (result in ('passed', 'failed')),
      reason_code text not null check (
        reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      http_status integer check (http_status is null or http_status between 100 and 599),
      latency_ms integer not null check (latency_ms between 0 and 120000),
      tested_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create index model_gateway_test_events_profile_time_idx
      on model_gateway_test_events (gateway_profile_id, tested_at desc, id desc);

    create table model_gateway_review_events (
      id bigint generated always as identity primary key,
      gateway_profile_id bigint not null references model_gateway_profiles(id),
      action text not null check (action in ('activate', 'retire')),
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

    create index model_gateway_review_events_profile_time_idx
      on model_gateway_review_events (gateway_profile_id, effective_at, id);

    create table model_budget_windows (
      id bigint generated always as identity primary key,
      gateway_profile_id bigint not null references model_gateway_profiles(id),
      window_kind text not null check (window_kind in ('utc_day', 'utc_month')),
      window_started_at timestamptz not null,
      window_ended_at timestamptz not null,
      reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
      spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
      input_tokens_total bigint not null default 0 check (input_tokens_total >= 0),
      output_tokens_total bigint not null default 0 check (output_tokens_total >= 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (gateway_profile_id, window_kind, window_started_at),
      check (window_ended_at > window_started_at),
      check (updated_at >= created_at),
      check (
        (window_kind = 'utc_day'
          and window_started_at = date_trunc('day', window_started_at at time zone 'UTC') at time zone 'UTC'
          and window_ended_at = ((window_started_at at time zone 'UTC') + interval '1 day') at time zone 'UTC')
        or (window_kind = 'utc_month'
          and window_started_at = date_trunc('month', window_started_at at time zone 'UTC') at time zone 'UTC'
          and window_ended_at = ((window_started_at at time zone 'UTC') + interval '1 month') at time zone 'UTC')
      )
    );

    create index model_budget_windows_ended_idx
      on model_budget_windows (window_ended_at, id);

    alter table model_call_leases
      add column gateway_profile_id bigint references model_gateway_profiles(id),
      add column budget_window_kind text check (
        budget_window_kind is null or budget_window_kind in ('utc_day', 'utc_month')
      ),
      add column budget_window_started_at timestamptz,
      add column reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
      add column settled_micro_usd bigint not null default 0 check (settled_micro_usd >= 0),
      add column prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
      add column completion_tokens integer not null default 0 check (completion_tokens >= 0);

    alter table model_call_leases
      drop constraint model_call_leases_outcome_code_check;
    alter table model_call_leases
      add constraint model_call_leases_outcome_code_check check (outcome_code is null or outcome_code in (
        'completed', 'invalid_request', 'aborted', 'timeout',
        'network_failure', 'non_2xx', 'provider_exhausted',
        'oversized_body', 'malformed_body', 'invalid_envelope',
        'rate_limited', 'global_limit', 'queue_full', 'cooldown',
        'policy_disabled', 'guard_blocked', 'lease_expired', 'database_failure',
        'budget_exceeded'
      ));

    alter table support_escalation_outcomes
      drop constraint support_escalation_outcomes_reason_code_check;
    alter table support_escalation_outcomes
      add constraint support_escalation_outcomes_reason_code_check check (reason_code in (
        'sensitive_data_blocked', 'unsafe_redaction', 'faq_ambiguous',
        'model_disabled', 'rate_limited', 'global_limit', 'queue_full',
        'timeout', 'network_failure', 'provider_failure', 'provider_exhausted',
        'invalid_response', 'unsupported_claim', 'wrong_language',
        'policy_blocked', 'database_failure', 'budget_exceeded'
      ));

    alter table admin_audit_events
      drop constraint admin_audit_events_action_check;
    alter table admin_audit_events
      add constraint admin_audit_events_action_check check (action in (
        'account_created', 'account_revoked',
        'role_assigned', 'role_revoked',
        'password_authentication_passed', 'password_authentication_failed',
        'mfa_authentication_passed', 'mfa_authentication_failed',
        'session_created', 'session_revoked',
        'knowledge_proposal_created', 'knowledge_submitted',
        'knowledge_approved', 'knowledge_rejected',
        'knowledge_published', 'knowledge_retired', 'knowledge_rolled_back',
        'owner_question_answered', 'model_policy_changed',
        'model_gateway_changed', 'escalation_acknowledged'
      ));

    alter table admin_audit_events
      drop constraint admin_audit_events_object_type_check;
    alter table admin_audit_events
      add constraint admin_audit_events_object_type_check check (object_type is null or object_type in (
        'account', 'session', 'knowledge_version', 'knowledge_item',
        'owner_question', 'model_policy', 'model_gateway', 'escalation'
      ));

    create function enforce_model_gateway_profile_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Model gateway profiles are immutable';
      end if;

      if old.gateway_ref is distinct from new.gateway_ref
         or old.version_number is distinct from new.version_number
         or old.request_key is distinct from new.request_key
         or old.gateway_kind is distinct from new.gateway_kind
         or old.display_label is distinct from new.display_label
         or old.endpoint_base_url is distinct from new.endpoint_base_url
         or old.model_name is distinct from new.model_name
         or old.key_version is distinct from new.key_version
         or old.encrypted_api_key is distinct from new.encrypted_api_key
         or old.encryption_nonce is distinct from new.encryption_nonce
         or old.authentication_tag is distinct from new.authentication_tag
         or old.api_key_sha256 is distinct from new.api_key_sha256
         or old.budget_micro_usd is distinct from new.budget_micro_usd
         or old.budget_window_kind is distinct from new.budget_window_kind
         or old.input_cost_per_million_micro_usd is distinct from new.input_cost_per_million_micro_usd
         or old.output_cost_per_million_micro_usd is distinct from new.output_cost_per_million_micro_usd
         or old.created_by_account_id is distinct from new.created_by_account_id
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Model gateway configuration fields are immutable';
      end if;

      if pg_trigger_depth() < 2 and (
        old.state is distinct from new.state
        or old.last_test_status is distinct from new.last_test_status
        or old.last_tested_at is distinct from new.last_tested_at
        or old.last_test_reason_code is distinct from new.last_test_reason_code
        or old.last_test_http_status is distinct from new.last_test_http_status
        or old.activated_by_account_id is distinct from new.activated_by_account_id
        or old.activated_at is distinct from new.activated_at
        or old.retired_at is distinct from new.retired_at
      ) then
        raise exception using errcode = '23514', message = 'Model gateway state changes require test or review events';
      end if;
      return new;
    end;
    $$;

    create trigger model_gateway_profiles_mutation
      before update or delete on model_gateway_profiles
      for each row execute function enforce_model_gateway_profile_mutation();

    create function apply_model_gateway_test_event()
    returns trigger
    language plpgsql
    as $$
    declare
      target_profile model_gateway_profiles%rowtype;
    begin
      perform pg_advisory_xact_lock(7100417);
      select * into target_profile
      from model_gateway_profiles
      where id = new.gateway_profile_id
      for update;

      if not found or new.tested_at < target_profile.created_at then
        raise exception using errcode = '23514', message = 'Invalid model gateway test event';
      end if;

      if target_profile.last_tested_at is null or new.tested_at >= target_profile.last_tested_at then
        update model_gateway_profiles
        set last_test_status = new.result,
            last_tested_at = new.tested_at,
            last_test_reason_code = new.reason_code,
            last_test_http_status = new.http_status
        where id = new.gateway_profile_id;
      end if;
      return new;
    end;
    $$;

    create trigger model_gateway_test_events_apply
      before insert on model_gateway_test_events
      for each row execute function apply_model_gateway_test_event();

    create function apply_model_gateway_review_event()
    returns trigger
    language plpgsql
    as $$
    declare
      current_profile model_gateway_profiles%rowtype;
    begin
      perform pg_advisory_xact_lock(7100417);

      select * into current_profile
      from model_gateway_profiles
      where id = new.gateway_profile_id
      for update;

      if new.action = 'activate'
         and current_profile.state = 'draft'
         and new.effective_at >= current_profile.created_at
         and (current_profile.gateway_kind = 'manifest_default' or current_profile.last_test_status = 'passed') then
        update model_gateway_profiles
        set state = 'retired',
            retired_at = greatest(activated_at, new.effective_at)
        where state = 'active' and id <> new.gateway_profile_id;

        update model_gateway_profiles
        set state = 'active',
            activated_by_account_id = new.reviewer_account_id,
            activated_at = new.effective_at
        where id = new.gateway_profile_id;
      elsif new.action = 'retire'
         and current_profile.state = 'active'
         and new.effective_at >= current_profile.activated_at then
        update model_gateway_profiles
        set state = 'retired',
            retired_at = new.effective_at
        where id = new.gateway_profile_id;
      else
        raise exception using errcode = '23514', message = 'Invalid model gateway activation or retirement transition';
      end if;
      return new;
    end;
    $$;

    create trigger model_gateway_review_events_apply
      before insert on model_gateway_review_events
      for each row execute function apply_model_gateway_review_event();

    create function reject_model_gateway_event_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using errcode = '23514', message = 'Model gateway history is append-only';
      return null;
    end;
    $$;

    create trigger model_gateway_test_events_append_only
      before update or delete on model_gateway_test_events
      for each row execute function reject_model_gateway_event_mutation();
    create trigger model_gateway_review_events_append_only
      before update or delete on model_gateway_review_events
      for each row execute function reject_model_gateway_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from model_gateway_profiles)
         or exists (select 1 from model_gateway_test_events)
         or exists (select 1 from model_gateway_review_events)
         or exists (select 1 from model_budget_windows)
         or exists (select 1 from model_call_leases where outcome_code = 'budget_exceeded' or gateway_profile_id is not null)
         or exists (select 1 from support_escalation_outcomes where reason_code = 'budget_exceeded')
         or exists (select 1 from admin_audit_events where action = 'model_gateway_changed' or object_type = 'model_gateway') then
        raise exception using
          errcode = '55000',
          message = 'Track 2A rollback blocked: preserve gateway configuration and budget ledger evidence before schema downgrade';
      end if;
    end;
    $$;

    drop trigger model_gateway_review_events_append_only on model_gateway_review_events;
    drop trigger model_gateway_test_events_append_only on model_gateway_test_events;
    drop trigger model_gateway_review_events_apply on model_gateway_review_events;
    drop trigger model_gateway_test_events_apply on model_gateway_test_events;
    drop trigger model_gateway_profiles_mutation on model_gateway_profiles;
    drop function reject_model_gateway_event_mutation();
    drop function apply_model_gateway_review_event();
    drop function apply_model_gateway_test_event();
    drop function enforce_model_gateway_profile_mutation();

    alter table admin_audit_events
      drop constraint admin_audit_events_object_type_check;
    alter table admin_audit_events
      add constraint admin_audit_events_object_type_check check (object_type is null or object_type in (
        'account', 'session', 'knowledge_version', 'knowledge_item',
        'owner_question', 'model_policy', 'escalation'
      ));

    alter table admin_audit_events
      drop constraint admin_audit_events_action_check;
    alter table admin_audit_events
      add constraint admin_audit_events_action_check check (action in (
        'account_created', 'account_revoked',
        'role_assigned', 'role_revoked',
        'password_authentication_passed', 'password_authentication_failed',
        'mfa_authentication_passed', 'mfa_authentication_failed',
        'session_created', 'session_revoked',
        'knowledge_proposal_created', 'knowledge_submitted',
        'knowledge_approved', 'knowledge_rejected',
        'knowledge_published', 'knowledge_retired', 'knowledge_rolled_back',
        'owner_question_answered', 'model_policy_changed',
        'escalation_acknowledged'
      ));

    alter table support_escalation_outcomes
      drop constraint support_escalation_outcomes_reason_code_check;
    alter table support_escalation_outcomes
      add constraint support_escalation_outcomes_reason_code_check check (reason_code in (
        'sensitive_data_blocked', 'unsafe_redaction', 'faq_ambiguous',
        'model_disabled', 'rate_limited', 'global_limit', 'queue_full',
        'timeout', 'network_failure', 'provider_failure', 'provider_exhausted',
        'invalid_response', 'unsupported_claim', 'wrong_language',
        'policy_blocked', 'database_failure'
      ));

    alter table model_call_leases
      drop constraint model_call_leases_outcome_code_check;
    alter table model_call_leases
      add constraint model_call_leases_outcome_code_check check (outcome_code is null or outcome_code in (
        'completed', 'invalid_request', 'aborted', 'timeout',
        'network_failure', 'non_2xx', 'provider_exhausted',
        'oversized_body', 'malformed_body', 'invalid_envelope',
        'rate_limited', 'global_limit', 'queue_full', 'cooldown',
        'policy_disabled', 'guard_blocked', 'lease_expired', 'database_failure'
      ));

    alter table model_call_leases
      drop column completion_tokens,
      drop column prompt_tokens,
      drop column settled_micro_usd,
      drop column reserved_micro_usd,
      drop column budget_window_started_at,
      drop column budget_window_kind,
      drop column gateway_profile_id;

    drop table model_budget_windows;
    drop table model_gateway_review_events;
    drop table model_gateway_test_events;
    drop table model_gateway_profiles;
  `);
}
