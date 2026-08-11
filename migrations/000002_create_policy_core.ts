import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table contacts (
      id bigint generated always as identity primary key,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table channel_identities (
      id bigint generated always as identity primary key,
      contact_id bigint not null references contacts(id),
      channel text not null check (channel in ('messenger', 'whatsapp')),
      channel_account_id text not null check (btrim(channel_account_id) <> ''),
      external_contact_id text not null check (btrim(external_contact_id) <> ''),
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      unique (channel, channel_account_id, external_contact_id),
      check (last_seen_at >= first_seen_at)
    );

    create table conversations (
      id bigint generated always as identity primary key,
      channel_identity_id bigint not null unique references channel_identities(id),
      ai_paused_until timestamptz,
      last_authorized_resume_at timestamptz,
      created_at timestamptz not null,
      last_activity_at timestamptz not null,
      updated_at timestamptz not null default now(),
      row_version bigint not null default 1 check (row_version > 0)
    );

    create table webhook_event_applications (
      webhook_event_id bigint primary key references webhook_events(id),
      conversation_id bigint references conversations(id),
      outcome text not null check (outcome in (
        'customer_message_applied',
        'business_echo_paused',
        'business_echo_ignored_before_resume',
        'message_status_ignored'
      )),
      applied_at timestamptz not null default now(),
      check (
        (outcome = 'message_status_ignored' and conversation_id is null)
        or (outcome <> 'message_status_ignored' and conversation_id is not null)
      )
    );

    create table human_pause_events (
      id bigint generated always as identity primary key,
      conversation_id bigint not null references conversations(id),
      source_webhook_event_id bigint unique references webhook_events(id),
      action text not null check (action in ('pause', 'resume')),
      effective_at timestamptz not null,
      resulting_pause_until timestamptz,
      actor_kind text not null check (actor_kind in ('business_echo', 'reviewer')),
      reviewer_reference text,
      reviewer_request_key text unique,
      created_at timestamptz not null default now(),
      check (
        (action = 'pause'
          and actor_kind = 'business_echo'
          and source_webhook_event_id is not null
          and resulting_pause_until is not null
          and reviewer_reference is null
          and reviewer_request_key is null)
        or (action = 'resume'
          and actor_kind = 'reviewer'
          and source_webhook_event_id is null
          and reviewer_reference is not null
          and btrim(reviewer_reference) <> ''
          and reviewer_request_key is not null
          and btrim(reviewer_request_key) <> '')
      ),
      check (resulting_pause_until is null or resulting_pause_until > effective_at)
    );

    create function enforce_human_pause_authority()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'pause' and not exists (
        select 1
        from webhook_events as source_event
        join webhook_event_applications as application
          on application.webhook_event_id = source_event.id
        where source_event.id = new.source_webhook_event_id
          and source_event.admission_outcome = 'pending'
          and source_event.event_kind = 'business_message_echo'
          and source_event.occurred_at = new.effective_at
          and application.conversation_id = new.conversation_id
          and application.outcome = 'business_echo_paused'
      ) then
        raise exception using errcode = '23514', message = 'pause lacks an authoritative echo application';
      end if;

      if new.action = 'resume' and new.resulting_pause_until is not null and not exists (
        select 1
        from human_pause_events as later_echo
        join webhook_events as source_event
          on source_event.id = later_echo.source_webhook_event_id
        join webhook_event_applications as application
          on application.webhook_event_id = source_event.id
        where later_echo.conversation_id = new.conversation_id
          and later_echo.action = 'pause'
          and later_echo.actor_kind = 'business_echo'
          and later_echo.effective_at > new.effective_at
          and later_echo.resulting_pause_until = new.resulting_pause_until
          and source_event.admission_outcome = 'pending'
          and source_event.event_kind = 'business_message_echo'
          and source_event.occurred_at = later_echo.effective_at
          and application.conversation_id = new.conversation_id
          and application.outcome = 'business_echo_paused'
      ) then
        raise exception using errcode = '23514', message = 'resume pause deadline lacks a later echo';
      end if;

      return new;
    end;
    $$;

    create trigger b_human_pause_events_authority
      before insert or update on human_pause_events
      for each row execute function enforce_human_pause_authority();

    create table consent_events (
      id bigint generated always as identity primary key,
      channel_identity_id bigint not null references channel_identities(id),
      category text not null,
      action text not null check (action in ('grant', 'revoke')),
      wording text not null,
      wording_version text not null,
      source text not null check (source in ('customer_message', 'reviewer_recorded')),
      source_at timestamptz not null,
      idempotency_key text not null unique,
      source_webhook_event_id bigint references webhook_events(id),
      created_at timestamptz not null default now(),
      check (btrim(category) <> '' and char_length(category) <= 64),
      check (btrim(wording) <> '' and char_length(wording) <= 500),
      check (btrim(wording_version) <> '' and char_length(wording_version) <= 64),
      check (btrim(idempotency_key) <> '' and char_length(idempotency_key) <= 128),
      check (
        (source = 'customer_message' and source_webhook_event_id is not null)
        or (source = 'reviewer_recorded' and source_webhook_event_id is null)
      )
    );

    create table policy_audit_outcomes (
      id bigint generated always as identity primary key,
      decision_type text not null check (decision_type in (
        'event_application',
        'reply_eligibility',
        'authorized_resume',
        'consent_record',
        'marketing_eligibility'
      )),
      outcome text not null check (outcome in ('allowed', 'denied', 'applied', 'duplicate', 'ignored')),
      reason_code text not null check (reason_code in (
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
      )),
      conversation_id bigint references conversations(id),
      channel_identity_id bigint references channel_identities(id),
      related_webhook_event_id bigint references webhook_events(id),
      evaluated_at timestamptz not null
    );

    create function enforce_pending_phase_3a_event_reference()
    returns trigger
    language plpgsql
    as $$
    declare
      event_id bigint;
    begin
      event_id := (to_jsonb(new) ->> tg_argv[0])::bigint;

      if event_id is not null and exists (
        select 1
        from webhook_events
        where id = event_id
      ) and not exists (
        select 1
        from webhook_events
        where id = event_id
          and admission_outcome = 'pending'
      ) then
        raise exception using errcode = '23514', message = 'Phase 3A state requires a pending webhook event';
      end if;

      return new;
    end;
    $$;

    create trigger a_webhook_event_applications_pending_event
      before insert or update on webhook_event_applications
      for each row execute function enforce_pending_phase_3a_event_reference('webhook_event_id');
    create trigger a_human_pause_events_pending_event
      before insert or update on human_pause_events
      for each row execute function enforce_pending_phase_3a_event_reference('source_webhook_event_id');
    create trigger a_consent_events_pending_event
      before insert or update on consent_events
      for each row execute function enforce_pending_phase_3a_event_reference('source_webhook_event_id');
    create trigger a_policy_audit_outcomes_pending_event
      before insert or update on policy_audit_outcomes
      for each row execute function enforce_pending_phase_3a_event_reference('related_webhook_event_id');

    create function enforce_human_pause_events_append_only()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using errcode = '23514', message = 'human pause events are append-only';
    end;
    $$;

    create trigger human_pause_events_append_only
      before update or delete on human_pause_events
      for each row execute function enforce_human_pause_events_append_only();

    create function enforce_authoritative_echo_application_stability()
    returns trigger
    language plpgsql
    as $$
    begin
      if exists (
        select 1
        from human_pause_events
        where source_webhook_event_id = old.webhook_event_id
      ) then
        raise exception using errcode = '23514', message = 'authoritative echo application is immutable';
      end if;

      return new;
    end;
    $$;

    create trigger webhook_event_applications_authoritative_stability
      before update or delete on webhook_event_applications
      for each row execute function enforce_authoritative_echo_application_stability();

    create function enforce_phase_3a_event_stability()
    returns trigger
    language plpgsql
    as $$
    begin
      if (
        new.admission_outcome is distinct from old.admission_outcome
        and new.admission_outcome <> 'pending'
        and exists (
          select 1 from webhook_event_applications where webhook_event_id = old.id
          union all
          select 1 from human_pause_events where source_webhook_event_id = old.id
          union all
          select 1 from consent_events where source_webhook_event_id = old.id
          union all
          select 1 from policy_audit_outcomes where related_webhook_event_id = old.id
        )
      ) or (
        (new.event_kind is distinct from old.event_kind or new.occurred_at is distinct from old.occurred_at)
        and exists (
          select 1 from human_pause_events where source_webhook_event_id = old.id
        )
      ) then
        raise exception using errcode = '23514', message = 'referenced webhook event is immutable';
      end if;

      return new;
    end;
    $$;

    create trigger webhook_events_phase_3a_stability
      before update on webhook_events
      for each row execute function enforce_phase_3a_event_stability();

    create index human_pause_events_conversation_effective_idx
      on human_pause_events (conversation_id, effective_at desc, id desc);
    create index consent_events_identity_category_latest_idx
      on consent_events (channel_identity_id, category, source_at desc, id desc);
    create index policy_audit_conversation_evaluated_idx
      on policy_audit_outcomes (conversation_id, evaluated_at desc, id desc);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger webhook_events_phase_3a_stability on webhook_events;
    drop trigger webhook_event_applications_authoritative_stability on webhook_event_applications;
    drop trigger human_pause_events_append_only on human_pause_events;
    drop trigger a_policy_audit_outcomes_pending_event on policy_audit_outcomes;
    drop trigger a_consent_events_pending_event on consent_events;
    drop trigger a_human_pause_events_pending_event on human_pause_events;
    drop trigger a_webhook_event_applications_pending_event on webhook_event_applications;
    drop trigger b_human_pause_events_authority on human_pause_events;
    drop function enforce_phase_3a_event_stability();
    drop function enforce_authoritative_echo_application_stability();
    drop function enforce_human_pause_events_append_only();
    drop function enforce_pending_phase_3a_event_reference();
    drop function enforce_human_pause_authority();
    drop table policy_audit_outcomes;
    drop table consent_events;
    drop table human_pause_events;
    drop table webhook_event_applications;
    drop table conversations;
    drop table channel_identities;
    drop table contacts;
  `);
}
