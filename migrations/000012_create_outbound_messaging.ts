import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
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
          'message_status_applied',
          'message_status_uncorrelated',
          'identity_suppressed'
        )),
      add constraint webhook_event_applications_check
        check (
          (
            outcome in (
              'message_status_ignored', 'message_status_applied',
              'message_status_uncorrelated', 'identity_suppressed'
            )
            and conversation_id is null
          )
          or (
            outcome not in (
              'message_status_ignored', 'message_status_applied',
              'message_status_uncorrelated', 'identity_suppressed'
            )
            and conversation_id is not null
          )
        );

    create table outbound_policy_versions (
      id bigint generated always as identity primary key,
      policy_ref text not null unique check (
        policy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      version_number integer not null unique check (version_number > 0),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      per_contact_15_minute integer not null check (
        per_contact_15_minute between 1 and 1000
      ),
      per_contact_24_hour integer not null check (
        per_contact_24_hour between 1 and 10000
      ),
      whatsapp_account_1_minute integer not null check (
        whatsapp_account_1_minute between 1 and 100000
      ),
      messenger_account_1_minute integer not null check (
        messenger_account_1_minute between 1 and 100000
      ),
      global_1_minute integer not null check (
        global_1_minute between 1 and 1000000
      ),
      global_utc_day integer not null check (
        global_utc_day between 1 and 100000000
      ),
      worker_batch_size integer not null check (
        worker_batch_size between 1 and 1000
      ),
      lease_ms integer not null check (lease_ms between 1000 and 600000),
      provider_timeout_ms integer not null check (
        provider_timeout_ms between 100 and 300000
      ),
      maximum_definite_retries integer not null check (
        maximum_definite_retries between 0 and 10
      ),
      retry_base_ms integer not null check (
        retry_base_ms between 100 and 86400000
      ),
      retry_maximum_ms integer not null check (
        retry_maximum_ms between 100 and 604800000
      ),
      state text not null check (state in (
        'draft', 'submitted', 'approved', 'active', 'retired'
      )),
      created_by_account_id bigint not null references admin_accounts(id),
      approved_by_account_id bigint references admin_accounts(id),
      created_at timestamptz not null,
      submitted_at timestamptz,
      decided_at timestamptz,
      activated_at timestamptz,
      retired_at timestamptz,
      check (per_contact_15_minute <= per_contact_24_hour),
      check (global_1_minute <= global_utc_day),
      check (provider_timeout_ms < lease_ms),
      check (retry_base_ms <= retry_maximum_ms),
      check (
        (state = 'draft'
          and submitted_at is null and decided_at is null
          and approved_by_account_id is null
          and activated_at is null and retired_at is null)
        or (state = 'submitted'
          and submitted_at is not null and decided_at is null
          and approved_by_account_id is null
          and activated_at is null and retired_at is null)
        or (state = 'approved'
          and submitted_at is not null and decided_at is not null
          and approved_by_account_id is not null
          and activated_at is null and retired_at is null)
        or (state = 'active'
          and submitted_at is not null and decided_at is not null
          and approved_by_account_id is not null
          and activated_at is not null and retired_at is null)
        or (state = 'retired'
          and submitted_at is not null and decided_at is not null
          and approved_by_account_id is not null
          and activated_at is not null and retired_at is not null)
      ),
      check (submitted_at is null or submitted_at >= created_at),
      check (decided_at is null or decided_at >= submitted_at),
      check (activated_at is null or activated_at >= decided_at),
      check (retired_at is null or retired_at >= activated_at)
    );

    create unique index outbound_policy_versions_one_active_idx
      on outbound_policy_versions ((state))
      where state = 'active';
    create index outbound_policy_versions_state_version_idx
      on outbound_policy_versions (state, version_number desc, id desc);

    create table outbound_policy_review_events (
      id bigint generated always as identity primary key,
      policy_version_id bigint not null references outbound_policy_versions(id),
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

    create index outbound_policy_review_events_policy_time_idx
      on outbound_policy_review_events (policy_version_id, effective_at, id);

    create table outbound_template_versions (
      id bigint generated always as identity primary key,
      template_ref text not null check (
        template_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      version_number integer not null check (version_number > 0),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      channel text not null check (channel = 'whatsapp'),
      channel_account_id text not null check (
        btrim(channel_account_id) <> '' and char_length(channel_account_id) <= 255
      ),
      provider_template_id text not null check (
        btrim(provider_template_id) <> '' and char_length(provider_template_id) <= 255
      ),
      template_name text not null check (
        template_name ~ '^[a-z0-9_]+$' and char_length(template_name) <= 512
      ),
      locale text not null check (locale in ('bn_BD', 'en_US')),
      category text not null check (category in (
        'customer_support', 'marketing_education', 'marketing_events',
        'marketing_news', 'marketing_offers'
      )),
      variable_count smallint not null check (variable_count = 0),
      content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
      state text not null check (state in (
        'draft', 'submitted', 'approved', 'active', 'retired'
      )),
      created_by_account_id bigint not null references admin_accounts(id),
      approved_by_account_id bigint references admin_accounts(id),
      created_at timestamptz not null,
      submitted_at timestamptz,
      decided_at timestamptz,
      activated_at timestamptz,
      retired_at timestamptz,
      unique (template_ref, version_number),
      check (
        (state = 'draft'
          and submitted_at is null and decided_at is null
          and approved_by_account_id is null
          and activated_at is null and retired_at is null)
        or (state = 'submitted'
          and submitted_at is not null and decided_at is null
          and approved_by_account_id is null
          and activated_at is null and retired_at is null)
        or (state = 'approved'
          and submitted_at is not null and decided_at is not null
          and approved_by_account_id is not null
          and activated_at is null and retired_at is null)
        or (state = 'active'
          and submitted_at is not null and decided_at is not null
          and approved_by_account_id is not null
          and activated_at is not null and retired_at is null)
        or (state = 'retired'
          and submitted_at is not null and decided_at is not null
          and approved_by_account_id is not null
          and activated_at is not null and retired_at is not null)
      ),
      check (submitted_at is null or submitted_at >= created_at),
      check (decided_at is null or decided_at >= submitted_at),
      check (activated_at is null or activated_at >= decided_at),
      check (retired_at is null or retired_at >= activated_at)
    );

    create unique index outbound_template_versions_one_active_scope_idx
      on outbound_template_versions (template_ref, channel, channel_account_id)
      where state = 'active';
    create index outbound_template_versions_scope_state_idx
      on outbound_template_versions (
        channel, channel_account_id, category, locale, state, id
      );

    create table outbound_template_review_events (
      id bigint generated always as identity primary key,
      template_version_id bigint not null references outbound_template_versions(id),
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

    create index outbound_template_review_events_template_time_idx
      on outbound_template_review_events (template_version_id, effective_at, id);

    create table outbound_intents (
      id bigint generated always as identity primary key,
      intent_ref text not null unique check (
        intent_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      reply_draft_id bigint unique references support_reply_drafts(id),
      template_version_id bigint references outbound_template_versions(id),
      conversation_id bigint not null references conversations(id),
      channel_identity_id bigint not null references channel_identities(id),
      policy_version_id bigint not null references outbound_policy_versions(id),
      channel text not null check (channel in ('messenger', 'whatsapp')),
      channel_account_id text not null check (
        btrim(channel_account_id) <> '' and char_length(channel_account_id) <= 255
      ),
      purpose text not null check (purpose in (
        'customer_support', 'marketing_education', 'marketing_events',
        'marketing_news', 'marketing_offers'
      )),
      message_kind text not null check (
        message_kind in ('support_text', 'fixed_template')
      ),
      state text not null check (state in (
        'pending', 'leased', 'provider_accepted', 'sent', 'delivered', 'read',
        'delivery_unknown', 'terminal_failed', 'canceled'
      )),
      attempt_count integer not null default 0 check (attempt_count >= 0),
      next_attempt_at timestamptz,
      lease_ref text check (
        lease_ref is null
        or lease_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      lease_expires_at timestamptz,
      retention_deadline timestamptz not null,
      terminal_reason text check (terminal_reason is null or terminal_reason in (
        'policy_unavailable', 'limit_exhausted', 'pause_active',
        'echo_correlation_hold', 'privacy_hold', 'identity_deleted',
        'suppressed', 'consent_missing', 'window_closed', 'template_required',
        'template_invalid', 'content_erased', 'retention_expired',
        'active_review_overdue', 'provider_rejected', 'delivery_unknown',
        'retry_exhausted'
      )),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      finished_at timestamptz,
      check (
        (reply_draft_id is not null and template_version_id is null
          and purpose = 'customer_support' and message_kind = 'support_text')
        or (reply_draft_id is null and template_version_id is not null
          and channel = 'whatsapp' and message_kind = 'fixed_template')
      ),
      check (retention_deadline >= created_at),
      check (updated_at >= created_at),
      check (finished_at is null or finished_at >= created_at),
      check (
        (state = 'pending'
          and next_attempt_at is not null
          and lease_ref is null and lease_expires_at is null
          and terminal_reason is null and finished_at is null)
        or (state = 'leased'
          and next_attempt_at is null
          and lease_ref is not null and lease_expires_at is not null
          and terminal_reason is null and finished_at is null)
        or (state in ('provider_accepted', 'sent')
          and attempt_count > 0
          and next_attempt_at is null
          and lease_ref is null and lease_expires_at is null
          and terminal_reason is null and finished_at is null)
        or (state in ('delivered', 'read')
          and attempt_count > 0
          and next_attempt_at is null
          and lease_ref is null and lease_expires_at is null
          and terminal_reason is null and finished_at is not null)
        or (state in ('delivery_unknown', 'terminal_failed', 'canceled')
          and next_attempt_at is null
          and lease_ref is null and lease_expires_at is null
          and terminal_reason is not null and finished_at is not null)
      ),
      check (lease_expires_at is null or lease_expires_at > updated_at)
    );

    create index outbound_intents_claim_idx
      on outbound_intents (next_attempt_at, id)
      where state = 'pending';
    create index outbound_intents_conversation_state_idx
      on outbound_intents (conversation_id, state, created_at desc, id desc);

    create table outbound_attempts (
      id bigint generated always as identity primary key,
      intent_id bigint not null references outbound_intents(id),
      attempt_number integer not null check (attempt_number > 0),
      attempt_ref text not null unique check (
        attempt_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      policy_version_id bigint not null references outbound_policy_versions(id),
      rate_reservation_ref text not null unique check (
        rate_reservation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      channel text not null check (channel in ('messenger', 'whatsapp')),
      channel_account_id text not null check (
        btrim(channel_account_id) <> '' and char_length(channel_account_id) <= 255
      ),
      state text not null check (state in (
        'authorized', 'dispatch_started', 'provider_accepted',
        'definitely_rejected', 'delivery_unknown', 'abandoned_before_dispatch'
      )),
      provider_message_id text check (
        provider_message_id is null
        or (btrim(provider_message_id) <> '' and char_length(provider_message_id) <= 512)
      ),
      outcome_code text check (outcome_code is null or outcome_code in (
        'provider_accepted', 'rate_limited', 'provider_rejected', 'timeout',
        'network_failure', 'invalid_response', 'oversized_response', 'redirect',
        'crash_after_dispatch', 'aborted_before_dispatch'
      )),
      retry_after timestamptz,
      authorized_at timestamptz not null,
      dispatch_started_at timestamptz,
      provider_accepted_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      unique (intent_id, attempt_number),
      check (
        (state = 'authorized'
          and dispatch_started_at is null and provider_message_id is null
          and provider_accepted_at is null and finished_at is null
          and outcome_code is null and retry_after is null)
        or (state = 'dispatch_started'
          and dispatch_started_at is not null and provider_message_id is null
          and provider_accepted_at is null and finished_at is null
          and outcome_code is null and retry_after is null)
        or (state = 'provider_accepted'
          and dispatch_started_at is not null and provider_message_id is not null
          and provider_accepted_at is not null and finished_at is not null
          and outcome_code = 'provider_accepted' and retry_after is null)
        or (state = 'definitely_rejected'
          and dispatch_started_at is not null and provider_message_id is null
          and provider_accepted_at is null and finished_at is not null
          and outcome_code in ('rate_limited', 'provider_rejected'))
        or (state = 'delivery_unknown'
          and dispatch_started_at is not null and provider_message_id is null
          and provider_accepted_at is null and finished_at is not null
          and outcome_code in (
            'timeout', 'network_failure', 'invalid_response',
            'oversized_response', 'redirect', 'crash_after_dispatch'
          ) and retry_after is null)
        or (state = 'abandoned_before_dispatch'
          and dispatch_started_at is null and provider_message_id is null
          and provider_accepted_at is null and finished_at is not null
          and outcome_code = 'aborted_before_dispatch' and retry_after is null)
      ),
      check (dispatch_started_at is null or dispatch_started_at >= authorized_at),
      check (provider_accepted_at is null or provider_accepted_at >= dispatch_started_at),
      check (finished_at is null or finished_at >= authorized_at)
    );

    create unique index outbound_attempts_provider_message_unique_idx
      on outbound_attempts (channel, channel_account_id, provider_message_id)
      where provider_message_id is not null;
    create index outbound_attempts_intent_state_idx
      on outbound_attempts (intent_id, state, attempt_number desc);

    create table outbound_rate_windows (
      id bigint generated always as identity primary key,
      policy_version_id bigint not null references outbound_policy_versions(id),
      window_kind text not null check (window_kind in (
        'contact_15_minute', 'contact_24_hour', 'whatsapp_account_1_minute',
        'messenger_account_1_minute', 'global_1_minute', 'global_utc_day'
      )),
      scope_key text check (
        scope_key is null
        or (btrim(scope_key) <> '' and char_length(scope_key) <= 255)
      ),
      window_started_at timestamptz not null,
      window_ended_at timestamptz not null,
      reservation_count integer not null check (
        reservation_count between 0 and 1000000000
      ),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique nulls not distinct (window_kind, scope_key, window_started_at),
      check (window_ended_at > window_started_at),
      check (expires_at >= window_ended_at),
      check (updated_at >= created_at),
      check (
        (window_kind = 'contact_15_minute'
          and scope_key is not null
          and window_ended_at = window_started_at + interval '15 minutes')
        or (window_kind = 'contact_24_hour'
          and scope_key is not null
          and window_ended_at = window_started_at + interval '24 hours')
        or (window_kind in (
            'whatsapp_account_1_minute', 'messenger_account_1_minute'
          )
          and scope_key is not null
          and window_ended_at = window_started_at + interval '1 minute')
        or (window_kind = 'global_1_minute'
          and scope_key is null
          and window_ended_at = window_started_at + interval '1 minute')
        or (window_kind = 'global_utc_day'
          and scope_key is null
          and window_started_at =
            date_trunc('day', window_started_at at time zone 'UTC') at time zone 'UTC'
          and window_ended_at = window_started_at + interval '24 hours')
      )
    );

    create index outbound_rate_windows_expiry_idx
      on outbound_rate_windows (expires_at, id);

    create table outbound_status_events (
      id bigint generated always as identity primary key,
      webhook_event_id bigint not null unique references webhook_events(id),
      intent_id bigint not null references outbound_intents(id),
      attempt_id bigint not null references outbound_attempts(id),
      status text not null check (status in ('sent', 'delivered', 'read', 'failed')),
      provider_occurred_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create index outbound_status_events_attempt_time_idx
      on outbound_status_events (attempt_id, provider_occurred_at, id);

    create table outbound_echo_correlation_holds (
      id bigint generated always as identity primary key,
      hold_ref text not null unique check (
        hold_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      conversation_id bigint not null references conversations(id),
      attempt_id bigint not null unique references outbound_attempts(id),
      source_webhook_event_id bigint unique references webhook_events(id),
      state text not null check (state in ('open', 'correlated', 'expired')),
      resolution_code text check (
        resolution_code is null or resolution_code in ('self_echo', 'hold_expired')
      ),
      created_at timestamptz not null,
      expires_at timestamptz not null,
      resolved_at timestamptz,
      check (expires_at > created_at),
      check (
        (state = 'open'
          and source_webhook_event_id is null
          and resolution_code is null and resolved_at is null)
        or (state = 'correlated'
          and source_webhook_event_id is not null
          and resolution_code = 'self_echo' and resolved_at is not null)
        or (state = 'expired'
          and source_webhook_event_id is null
          and resolution_code = 'hold_expired' and resolved_at is not null)
      ),
      check (resolved_at is null or resolved_at >= created_at)
    );

    create unique index outbound_echo_holds_one_open_conversation_idx
      on outbound_echo_correlation_holds (conversation_id)
      where state = 'open';
    create index outbound_echo_holds_expiry_idx
      on outbound_echo_correlation_holds (expires_at, id)
      where state = 'open';

    create table outbound_escalation_outcomes (
      id bigint generated always as identity primary key,
      escalation_ref text not null unique check (
        escalation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      intent_id bigint references outbound_intents(id),
      conversation_id bigint not null references conversations(id),
      reason_code text not null check (reason_code in (
        'policy_unavailable', 'limit_exhausted', 'pause_active',
        'privacy_hold', 'identity_deleted', 'suppressed', 'consent_missing',
        'window_closed', 'template_required', 'template_invalid',
        'content_erased', 'retention_expired', 'active_review_overdue',
        'provider_rejected', 'delivery_unknown', 'retry_exhausted'
      )),
      state text not null check (state in ('open', 'acknowledged', 'resolved')),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      acknowledged_at timestamptz,
      resolved_at timestamptz,
      check (updated_at >= created_at),
      check (
        (state = 'open' and acknowledged_at is null and resolved_at is null)
        or (state = 'acknowledged'
          and acknowledged_at is not null and resolved_at is null)
        or (state = 'resolved' and resolved_at is not null)
      )
    );

    create index outbound_escalation_outcomes_state_created_idx
      on outbound_escalation_outcomes (state, created_at, id);

    create function reject_outbound_append_only_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using errcode = '23514', message = 'Outbound evidence is append-only';
      return null;
    end;
    $$;

    create function enforce_outbound_policy_version_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Outbound policy versions are immutable';
      end if;
      if old.policy_ref is distinct from new.policy_ref
         or old.version_number is distinct from new.version_number
         or old.request_key is distinct from new.request_key
         or old.per_contact_15_minute is distinct from new.per_contact_15_minute
         or old.per_contact_24_hour is distinct from new.per_contact_24_hour
         or old.whatsapp_account_1_minute is distinct from new.whatsapp_account_1_minute
         or old.messenger_account_1_minute is distinct from new.messenger_account_1_minute
         or old.global_1_minute is distinct from new.global_1_minute
         or old.global_utc_day is distinct from new.global_utc_day
         or old.worker_batch_size is distinct from new.worker_batch_size
         or old.lease_ms is distinct from new.lease_ms
         or old.provider_timeout_ms is distinct from new.provider_timeout_ms
         or old.maximum_definite_retries is distinct from new.maximum_definite_retries
         or old.retry_base_ms is distinct from new.retry_base_ms
         or old.retry_maximum_ms is distinct from new.retry_maximum_ms
         or old.created_by_account_id is distinct from new.created_by_account_id
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Outbound policy values are immutable';
      end if;
      if pg_trigger_depth() < 2 and (
        old.state is distinct from new.state
        or old.approved_by_account_id is distinct from new.approved_by_account_id
        or old.submitted_at is distinct from new.submitted_at
        or old.decided_at is distinct from new.decided_at
        or old.activated_at is distinct from new.activated_at
        or old.retired_at is distinct from new.retired_at
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound policy state changes require a review event';
      end if;
      return new;
    end;
    $$;

    create function apply_outbound_policy_review_event()
    returns trigger
    language plpgsql
    as $$
    declare
      current_policy outbound_policy_versions%rowtype;
    begin
      if new.action in ('activate', 'retire') then
        perform pg_advisory_xact_lock(7100512);
      end if;
      select * into current_policy
      from outbound_policy_versions
      where id = new.policy_version_id
      for update;

      if new.action = 'submit' and current_policy.state = 'draft'
         and new.effective_at >= current_policy.created_at then
        update outbound_policy_versions
        set state = 'submitted', submitted_at = new.effective_at
        where id = new.policy_version_id;
      elsif new.action = 'approve' and current_policy.state = 'submitted'
         and new.effective_at >= current_policy.submitted_at then
        update outbound_policy_versions
        set state = 'approved', approved_by_account_id = new.reviewer_account_id,
            decided_at = new.effective_at
        where id = new.policy_version_id;
      elsif new.action = 'activate' and current_policy.state = 'approved'
         and new.effective_at >= current_policy.decided_at then
        update outbound_policy_versions
        set state = 'active', activated_at = new.effective_at
        where id = new.policy_version_id;
      elsif new.action = 'retire' and current_policy.state = 'active'
         and new.effective_at >= current_policy.activated_at then
        update outbound_policy_versions
        set state = 'retired', retired_at = new.effective_at
        where id = new.policy_version_id;
      else
        raise exception using errcode = '23514',
          message = 'Invalid outbound policy review transition';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_template_version_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Outbound template versions are immutable';
      end if;
      if old.template_ref is distinct from new.template_ref
         or old.version_number is distinct from new.version_number
         or old.request_key is distinct from new.request_key
         or old.channel is distinct from new.channel
         or old.channel_account_id is distinct from new.channel_account_id
         or old.provider_template_id is distinct from new.provider_template_id
         or old.template_name is distinct from new.template_name
         or old.locale is distinct from new.locale
         or old.category is distinct from new.category
         or old.variable_count is distinct from new.variable_count
         or old.content_sha256 is distinct from new.content_sha256
         or old.created_by_account_id is distinct from new.created_by_account_id
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Outbound template values are immutable';
      end if;
      if pg_trigger_depth() < 2 and (
        old.state is distinct from new.state
        or old.approved_by_account_id is distinct from new.approved_by_account_id
        or old.submitted_at is distinct from new.submitted_at
        or old.decided_at is distinct from new.decided_at
        or old.activated_at is distinct from new.activated_at
        or old.retired_at is distinct from new.retired_at
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound template state changes require a review event';
      end if;
      return new;
    end;
    $$;

    create function apply_outbound_template_review_event()
    returns trigger
    language plpgsql
    as $$
    declare
      current_template outbound_template_versions%rowtype;
    begin
      if new.action in ('activate', 'retire') then
        perform pg_advisory_xact_lock(7100513);
      end if;
      select * into current_template
      from outbound_template_versions
      where id = new.template_version_id
      for update;

      if new.action = 'submit' and current_template.state = 'draft'
         and new.effective_at >= current_template.created_at then
        update outbound_template_versions
        set state = 'submitted', submitted_at = new.effective_at
        where id = new.template_version_id;
      elsif new.action = 'approve' and current_template.state = 'submitted'
         and new.effective_at >= current_template.submitted_at then
        update outbound_template_versions
        set state = 'approved', approved_by_account_id = new.reviewer_account_id,
            decided_at = new.effective_at
        where id = new.template_version_id;
      elsif new.action = 'activate' and current_template.state = 'approved'
         and new.effective_at >= current_template.decided_at then
        update outbound_template_versions
        set state = 'active', activated_at = new.effective_at
        where id = new.template_version_id;
      elsif new.action = 'retire' and current_template.state = 'active'
         and new.effective_at >= current_template.activated_at then
        update outbound_template_versions
        set state = 'retired', retired_at = new.effective_at
        where id = new.template_version_id;
      else
        raise exception using errcode = '23514',
          message = 'Invalid outbound template review transition';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_intent_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Outbound intents cannot be deleted';
      end if;
      if old.intent_ref is distinct from new.intent_ref
         or old.request_key is distinct from new.request_key
         or old.reply_draft_id is distinct from new.reply_draft_id
         or old.template_version_id is distinct from new.template_version_id
         or old.conversation_id is distinct from new.conversation_id
         or old.channel_identity_id is distinct from new.channel_identity_id
         or old.policy_version_id is distinct from new.policy_version_id
         or old.channel is distinct from new.channel
         or old.channel_account_id is distinct from new.channel_account_id
         or old.purpose is distinct from new.purpose
         or old.message_kind is distinct from new.message_kind
         or old.retention_deadline is distinct from new.retention_deadline
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Outbound intent authority is immutable';
      end if;
      if old.state is distinct from new.state and not (
        (old.state = 'pending' and new.state in (
          'leased', 'canceled', 'terminal_failed'
        ))
        or (old.state = 'leased' and new.state in (
          'pending', 'provider_accepted', 'delivery_unknown',
          'terminal_failed', 'canceled'
        ))
        or (old.state = 'provider_accepted' and new.state in (
          'sent', 'delivered', 'read', 'terminal_failed'
        ))
        or (old.state = 'sent' and new.state in (
          'delivered', 'read', 'terminal_failed'
        ))
        or (old.state = 'delivered' and new.state = 'read')
        or (old.state = 'terminal_failed' and new.state in ('delivered', 'read'))
      ) then
        raise exception using errcode = '23514', message = 'Invalid outbound intent transition';
      end if;
      if old.state = new.state and old.state in (
        'delivered', 'read', 'delivery_unknown', 'terminal_failed', 'canceled'
      ) then
        raise exception using errcode = '23514',
          message = 'Terminal outbound intents are immutable';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_intent_authority()
    returns trigger
    language plpgsql
    as $$
    begin
      if not exists (
        select 1
        from conversations as conversation
        join channel_identities as identity
          on identity.id = conversation.channel_identity_id
        where conversation.id = new.conversation_id
          and identity.id = new.channel_identity_id
          and identity.channel = new.channel
          and identity.channel_account_id = new.channel_account_id
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound intent channel authority does not match its conversation';
      end if;

      if new.reply_draft_id is not null and not exists (
        select 1
        from support_reply_drafts as draft
        where draft.id = new.reply_draft_id
          and draft.conversation_id = new.conversation_id
          and draft.state = 'ready'
          and draft.erased_at is null
          and draft.retention_deadline >= new.created_at
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound intent reply draft is not authoritative';
      end if;

      if new.template_version_id is not null and not exists (
        select 1
        from outbound_template_versions as template
        where template.id = new.template_version_id
          and template.channel = new.channel
          and template.channel_account_id = new.channel_account_id
          and template.category = new.purpose
          and template.variable_count = 0
          and template.state = 'active'
          and template.activated_at <= new.created_at
          and template.retired_at is null
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound intent template is not active for its scope';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_attempt_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Outbound attempts cannot be deleted';
      end if;
      if old.intent_id is distinct from new.intent_id
         or old.attempt_number is distinct from new.attempt_number
         or old.attempt_ref is distinct from new.attempt_ref
         or old.policy_version_id is distinct from new.policy_version_id
         or old.rate_reservation_ref is distinct from new.rate_reservation_ref
         or old.channel is distinct from new.channel
         or old.channel_account_id is distinct from new.channel_account_id
         or old.authorized_at is distinct from new.authorized_at
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Outbound attempt authority is immutable';
      end if;
      if old.state = new.state then
        raise exception using errcode = '23514',
          message = 'Outbound attempt updates require a state transition';
      end if;
      if old.state is distinct from new.state and not (
        (old.state = 'authorized'
          and new.state in ('dispatch_started', 'abandoned_before_dispatch'))
        or (old.state = 'dispatch_started'
          and new.state in (
            'provider_accepted', 'definitely_rejected', 'delivery_unknown'
          ))
      ) then
        raise exception using errcode = '23514', message = 'Invalid outbound attempt transition';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_status_authority()
    returns trigger
    language plpgsql
    as $$
    begin
      if not exists (
        select 1
        from webhook_events as event
        join outbound_attempts as attempt on attempt.id = new.attempt_id
        join outbound_intents as intent
          on intent.id = new.intent_id and intent.id = attempt.intent_id
        where event.id = new.webhook_event_id
          and event.admission_outcome = 'pending'
          and event.event_kind = 'message_status'
          and event.message_status = new.status
          and event.channel = attempt.channel
          and event.channel_account_id = attempt.channel_account_id
          and event.external_message_id = attempt.provider_message_id
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound status lacks authoritative correlation';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_echo_hold_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Outbound echo holds cannot be deleted';
      end if;
      if old.hold_ref is distinct from new.hold_ref
         or old.conversation_id is distinct from new.conversation_id
         or old.attempt_id is distinct from new.attempt_id
         or old.created_at is distinct from new.created_at
         or old.expires_at is distinct from new.expires_at then
        raise exception using errcode = '23514', message = 'Outbound echo hold authority is immutable';
      end if;
      if old.state is distinct from new.state and not (
        old.state = 'open' and new.state in ('correlated', 'expired')
      ) then
        raise exception using errcode = '23514', message = 'Invalid outbound echo hold transition';
      end if;
      if old.state = new.state then
        raise exception using errcode = '23514',
          message = 'Outbound echo hold updates require a state transition';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_echo_correlation()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.state = 'open' and not exists (
        select 1
        from outbound_attempts as attempt
        join outbound_intents as intent
          on intent.id = attempt.intent_id
        where attempt.id = new.attempt_id
          and attempt.state = 'dispatch_started'
          and intent.conversation_id = new.conversation_id
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound echo hold requires an in-flight dispatch';
      end if;
      if new.state = 'correlated' and not exists (
        select 1
        from webhook_events as event
        join outbound_attempts as attempt on attempt.id = new.attempt_id
        join outbound_intents as intent
          on intent.id = attempt.intent_id
          and intent.conversation_id = new.conversation_id
        where event.id = new.source_webhook_event_id
          and event.admission_outcome = 'pending'
          and event.event_kind = 'business_message_echo'
          and event.channel = attempt.channel
          and event.channel_account_id = attempt.channel_account_id
          and event.external_message_id = attempt.provider_message_id
      ) then
        raise exception using errcode = '23514',
          message = 'Outbound echo hold lacks exact provider correlation';
      end if;
      return new;
    end;
    $$;

    create function enforce_outbound_escalation_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Outbound escalations cannot be deleted';
      end if;
      if old.escalation_ref is distinct from new.escalation_ref
         or old.intent_id is distinct from new.intent_id
         or old.conversation_id is distinct from new.conversation_id
         or old.reason_code is distinct from new.reason_code
         or old.request_key is distinct from new.request_key
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Outbound escalation authority is immutable';
      end if;
      if old.state is distinct from new.state and not (
        (old.state = 'open' and new.state in ('acknowledged', 'resolved'))
        or (old.state = 'acknowledged' and new.state = 'resolved')
      ) then
        raise exception using errcode = '23514', message = 'Invalid outbound escalation transition';
      end if;
      if old.state = new.state then
        raise exception using errcode = '23514',
          message = 'Outbound escalation updates require a state transition';
      end if;
      return new;
    end;
    $$;

    create trigger outbound_policy_versions_mutation
      before update or delete on outbound_policy_versions
      for each row execute function enforce_outbound_policy_version_mutation();
    create trigger outbound_policy_review_events_apply
      before insert on outbound_policy_review_events
      for each row execute function apply_outbound_policy_review_event();
    create trigger outbound_policy_review_events_append_only
      before update or delete on outbound_policy_review_events
      for each row execute function reject_outbound_append_only_mutation();

    create trigger outbound_template_versions_mutation
      before update or delete on outbound_template_versions
      for each row execute function enforce_outbound_template_version_mutation();
    create trigger outbound_template_review_events_apply
      before insert on outbound_template_review_events
      for each row execute function apply_outbound_template_review_event();
    create trigger outbound_template_review_events_append_only
      before update or delete on outbound_template_review_events
      for each row execute function reject_outbound_append_only_mutation();

    create trigger outbound_intents_mutation
      before update or delete on outbound_intents
      for each row execute function enforce_outbound_intent_mutation();
    create trigger a_outbound_intents_authority
      before insert on outbound_intents
      for each row execute function enforce_outbound_intent_authority();
    create trigger outbound_attempts_mutation
      before update or delete on outbound_attempts
      for each row execute function enforce_outbound_attempt_mutation();
    create trigger a_outbound_status_events_authority
      before insert on outbound_status_events
      for each row execute function enforce_outbound_status_authority();
    create trigger b_outbound_status_events_append_only
      before update or delete on outbound_status_events
      for each row execute function reject_outbound_append_only_mutation();
    create trigger a_outbound_echo_holds_correlation
      before insert or update on outbound_echo_correlation_holds
      for each row execute function enforce_outbound_echo_correlation();
    create trigger b_outbound_echo_holds_mutation
      before update or delete on outbound_echo_correlation_holds
      for each row execute function enforce_outbound_echo_hold_mutation();
    create trigger outbound_escalation_outcomes_mutation
      before update or delete on outbound_escalation_outcomes
      for each row execute function enforce_outbound_escalation_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from outbound_policy_versions)
         or exists (select 1 from outbound_policy_review_events)
         or exists (select 1 from outbound_template_versions)
         or exists (select 1 from outbound_template_review_events)
         or exists (select 1 from outbound_intents)
         or exists (select 1 from outbound_attempts)
         or exists (select 1 from outbound_rate_windows)
         or exists (select 1 from outbound_status_events)
         or exists (select 1 from outbound_echo_correlation_holds)
         or exists (select 1 from outbound_escalation_outcomes)
         or exists (
           select 1 from webhook_event_applications
           where outcome in ('message_status_applied', 'message_status_uncorrelated')
         ) then
        raise exception using
          errcode = '55000',
          message = 'P5-001 rollback blocked: preserve outbound authority and evidence before schema downgrade';
      end if;
    end;
    $$;

    drop trigger outbound_escalation_outcomes_mutation on outbound_escalation_outcomes;
    drop trigger b_outbound_echo_holds_mutation on outbound_echo_correlation_holds;
    drop trigger a_outbound_echo_holds_correlation on outbound_echo_correlation_holds;
    drop trigger b_outbound_status_events_append_only on outbound_status_events;
    drop trigger a_outbound_status_events_authority on outbound_status_events;
    drop trigger outbound_attempts_mutation on outbound_attempts;
    drop trigger a_outbound_intents_authority on outbound_intents;
    drop trigger outbound_intents_mutation on outbound_intents;
    drop trigger outbound_template_review_events_append_only on outbound_template_review_events;
    drop trigger outbound_template_review_events_apply on outbound_template_review_events;
    drop trigger outbound_template_versions_mutation on outbound_template_versions;
    drop trigger outbound_policy_review_events_append_only on outbound_policy_review_events;
    drop trigger outbound_policy_review_events_apply on outbound_policy_review_events;
    drop trigger outbound_policy_versions_mutation on outbound_policy_versions;

    drop function enforce_outbound_escalation_mutation();
    drop function enforce_outbound_echo_correlation();
    drop function enforce_outbound_echo_hold_mutation();
    drop function enforce_outbound_status_authority();
    drop function enforce_outbound_attempt_mutation();
    drop function enforce_outbound_intent_authority();
    drop function enforce_outbound_intent_mutation();
    drop function apply_outbound_template_review_event();
    drop function enforce_outbound_template_version_mutation();
    drop function apply_outbound_policy_review_event();
    drop function enforce_outbound_policy_version_mutation();
    drop function reject_outbound_append_only_mutation();

    drop table outbound_escalation_outcomes;
    drop table outbound_echo_correlation_holds;
    drop table outbound_status_events;
    drop table outbound_rate_windows;
    drop table outbound_attempts;
    drop table outbound_intents;
    drop table outbound_template_review_events;
    drop table outbound_template_versions;
    drop table outbound_policy_review_events;
    drop table outbound_policy_versions;

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
  `);
}
