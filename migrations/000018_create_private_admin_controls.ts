import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table admin_audit_events
      drop constraint admin_audit_events_action_check;
    alter table admin_audit_events
      add constraint admin_audit_events_action_check check (action in (
        'account_created', 'account_revoked', 'account_disabled',
        'role_assigned', 'role_revoked',
        'password_authentication_passed', 'password_authentication_failed',
        'mfa_authentication_passed', 'mfa_authentication_failed',
        'session_created', 'session_revoked',
        'knowledge_source_imported',
        'knowledge_proposal_created', 'knowledge_submitted',
        'knowledge_approved', 'knowledge_rejected',
        'knowledge_published', 'knowledge_retired', 'knowledge_rolled_back',
        'owner_question_answered', 'owner_question_dismissed',
        'customer_insights_aggregated', 'question_digest_generated',
        'model_policy_changed', 'model_gateway_changed', 'escalation_acknowledged',
        'human_pause_applied', 'human_pause_resumed',
        'privacy_request_reviewed', 'privacy_location_attested',
        'privacy_deletion_executed', 'privacy_access_collected',
        'privacy_correction_executed',
        'consent_recorded', 'marketing_reopt_in_recorded',
        'outbound_policy_changed', 'outbound_template_changed'
      ));

    alter table admin_audit_events
      drop constraint admin_audit_events_object_type_check;
    alter table admin_audit_events
      add constraint admin_audit_events_object_type_check check (object_type is null or object_type in (
        'account', 'session', 'knowledge_source', 'knowledge_version', 'knowledge_item',
        'owner_question', 'insight_run', 'question_digest',
        'model_policy', 'model_gateway', 'escalation',
        'conversation', 'privacy_request', 'consent_record',
        'outbound_policy', 'outbound_template'
      ));

    do $$
    declare
      constraint_record record;
    begin
      for constraint_record in
        select conname
        from pg_constraint
        where conrelid = 'human_pause_events'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%business_echo%'
          and pg_get_constraintdef(oid) like '%source_webhook_event_id%'
      loop
        execute format('alter table human_pause_events drop constraint %I', constraint_record.conname);
      end loop;
    end;
    $$;

    alter table human_pause_events
      add constraint human_pause_events_actor_shape_check check (
        (action = 'pause'
          and actor_kind = 'business_echo'
          and source_webhook_event_id is not null
          and resulting_pause_until is not null
          and reviewer_reference is null
          and reviewer_request_key is null)
        or (action = 'pause'
          and actor_kind = 'reviewer'
          and source_webhook_event_id is null
          and resulting_pause_until = effective_at + interval '24 hours'
          and reviewer_reference is not null
          and btrim(reviewer_reference) <> ''
          and reviewer_request_key is not null
          and btrim(reviewer_request_key) <> '')
        or (action = 'resume'
          and actor_kind = 'reviewer'
          and source_webhook_event_id is null
          and reviewer_reference is not null
          and btrim(reviewer_reference) <> ''
          and reviewer_request_key is not null
          and btrim(reviewer_request_key) <> '')
      );

    create or replace function enforce_human_pause_authority()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'pause' and new.actor_kind = 'business_echo' and not exists (
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

      if new.action = 'resume' and new.resulting_pause_until is not null and not (
        exists (
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
            and later_echo.id = (
              select current_state.id
              from human_pause_events as current_state
              where current_state.conversation_id = new.conversation_id
                and current_state.effective_at > new.effective_at
              order by current_state.effective_at desc, current_state.id desc
              limit 1
            )
        )
        or exists (
          select 1
          from human_pause_events as later_manual
          where later_manual.conversation_id = new.conversation_id
            and later_manual.action = 'pause'
            and later_manual.actor_kind = 'reviewer'
            and later_manual.effective_at > new.effective_at
            and later_manual.resulting_pause_until = new.resulting_pause_until
            and later_manual.id = (
              select current_state.id
              from human_pause_events as current_state
              where current_state.conversation_id = new.conversation_id
                and current_state.effective_at > new.effective_at
              order by current_state.effective_at desc, current_state.id desc
              limit 1
            )
        )
      ) then
        raise exception using errcode = '23514', message = 'resume pause deadline lacks a later pause';
      end if;

      return new;
    end;
    $$;

    alter table policy_audit_outcomes
      drop constraint policy_audit_outcomes_decision_type_check,
      drop constraint policy_audit_outcomes_reason_code_check;
    alter table policy_audit_outcomes
      add constraint policy_audit_outcomes_decision_type_check check (decision_type in (
        'event_application',
        'reply_eligibility',
        'authorized_pause',
        'authorized_resume',
        'consent_record',
        'marketing_eligibility'
      )),
      add constraint policy_audit_outcomes_reason_code_check check (reason_code in (
        'customer_message_applied',
        'business_echo_pause',
        'echo_not_later_than_resume',
        'message_status_ignored',
        'pause_active',
        'pause_inactive',
        'privacy_request_open',
        'manual_pause_applied',
        'manual_pause_duplicate',
        'resume_applied',
        'resume_duplicate',
        'consent_grant',
        'consent_revoke',
        'consent_duplicate',
        'consent_missing',
        'consent_latest_grant',
        'consent_latest_revoke',
        'global_marketing_opt_out',
        'identity_not_found'
      ));

    alter table contacts
      add column preferred_language text check (
        preferred_language is null or preferred_language in ('en', 'bn')
      );

    alter table privacy_access_runs
      add column bundle_sha256 text check (
        bundle_sha256 is null or bundle_sha256 ~ '^[0-9a-f]{64}$'
      );

    create view admin_pause_states_v as
    select conversation.id::text as conversation_id,
           identity.contact_id::text as contact_id,
           identity.channel,
           identity.external_contact_id,
           conversation.ai_paused_until,
           conversation.last_authorized_resume_at,
           conversation.last_activity_at,
           latest.action as last_pause_action,
           latest.actor_kind as last_pause_actor_kind,
           latest.effective_at as last_pause_effective_at
    from conversations as conversation
    join channel_identities as identity
      on identity.id = conversation.channel_identity_id
    left join lateral (
      select event.action, event.actor_kind, event.effective_at
      from human_pause_events as event
      where event.conversation_id = conversation.id
      order by event.effective_at desc, event.id desc
      limit 1
    ) as latest on true;

    create view admin_privacy_requests_v as
    select req.request_ref,
           req.request_type,
           req.state,
           req.contact_id::text as contact_id,
           req.received_at,
           req.decision_at,
           req.completed_at,
           req.decision_code,
           req.reason_code,
           req.updated_at,
           coalesce(loc.pending_count, 0)::int as pending_locations,
           coalesce(loc.total_count, 0)::int as total_locations,
           del.status as deletion_status,
           del.tombstones_created,
           acc.status as access_status,
           acc.record_count as access_record_count,
           acc.bundle_sha256 as access_bundle_sha256,
           cor.result_code as correction_result_code,
           cor.field_key as correction_field_key
    from privacy_requests as req
    left join lateral (
      select count(*) filter (where l.state in ('pending', 'failed')) as pending_count,
             count(*) as total_count
      from privacy_request_locations as l
      where l.request_id = req.id
    ) as loc on true
    left join lateral (
      select d.status, d.tombstones_created
      from privacy_deletion_runs as d
      where d.request_id = req.id
      order by d.id desc
      limit 1
    ) as del on true
    left join lateral (
      select a.status, a.record_count, a.bundle_sha256
      from privacy_access_runs as a
      where a.request_id = req.id
      order by a.id desc
      limit 1
    ) as acc on true
    left join lateral (
      select c.result_code, c.field_key
      from privacy_correction_runs as c
      where c.request_id = req.id
      order by c.id desc
      limit 1
    ) as cor on true;

    create view admin_privacy_locations_v as
    select req.request_ref,
           loc.location_code,
           loc.required,
           loc.state,
           loc.outcome_code,
           loc.reviewer_reference,
           loc.checked_at
    from privacy_request_locations as loc
    join privacy_requests as req on req.id = loc.request_id;

    create view admin_consent_identities_v as
    select identity.id::text as channel_identity_id,
           identity.contact_id::text as contact_id,
           identity.channel,
           identity.channel_account_id,
           identity.external_contact_id,
           contact.preferred_language,
           latest.category,
           latest.action as latest_action,
           latest.wording_version,
           latest.source as latest_source,
           latest.source_at
    from channel_identities as identity
    join contacts as contact on contact.id = identity.contact_id
    left join lateral (
      select distinct on (event.category)
             event.category,
             event.action,
             event.wording_version,
             event.source,
             event.source_at
      from consent_events as event
      where event.channel_identity_id = identity.id
      order by event.category, event.source_at desc, event.id desc
    ) as latest on true;

    create function admin_pause_conversation(
      p_conversation_id bigint,
      p_effective_at timestamptz,
      p_reviewer_ref text,
      p_request_key text
    )
    returns table (
      conversation_id text,
      ai_paused_until timestamptz,
      status text
    )
    language plpgsql
    as $$
    declare
      existing_row record;
      current_pause timestamptz;
      next_pause timestamptz;
      event_pause timestamptz;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      select h.conversation_id,
             h.resulting_pause_until,
             (h.conversation_id = p_conversation_id
               and h.action = 'pause'
               and h.actor_kind = 'reviewer'
               and h.reviewer_reference = p_reviewer_ref
               and h.effective_at = p_effective_at) as matches
      into existing_row
      from human_pause_events as h
      where h.reviewer_request_key = p_request_key;

      if found then
        if not coalesce(existing_row.matches, false) then
          raise exception using errcode = '23505', message = 'pause_request_conflict';
        end if;
        return query
          select existing_row.conversation_id::text, existing_row.resulting_pause_until, 'duplicate'::text;
        return;
      end if;

      select c.ai_paused_until
      into current_pause
      from conversations as c
      where c.id = p_conversation_id
      for update;

      if not found then
        raise exception using errcode = 'P0002', message = 'conversation_not_found';
      end if;

      event_pause := p_effective_at + interval '24 hours';
      next_pause := greatest(coalesce(current_pause, event_pause), event_pause);

      update conversations
      set ai_paused_until = next_pause,
          updated_at = now(),
          row_version = row_version + 1
      where id = p_conversation_id;

      insert into human_pause_events (
        conversation_id, action, effective_at, resulting_pause_until,
        actor_kind, reviewer_reference, reviewer_request_key
      ) values (
        p_conversation_id, 'pause', p_effective_at, event_pause,
        'reviewer', p_reviewer_ref, p_request_key
      );

      insert into policy_audit_outcomes (
        conversation_id, decision_type, outcome, reason_code, evaluated_at
      ) values (
        p_conversation_id, 'authorized_pause', 'applied', 'manual_pause_applied', p_effective_at
      );

      return query select p_conversation_id::text, next_pause, 'applied'::text;
    end;
    $$;

    create function admin_resume_conversation(
      p_conversation_id bigint,
      p_effective_at timestamptz,
      p_reviewer_ref text,
      p_request_key text
    )
    returns table (
      conversation_id text,
      ai_paused_until timestamptz,
      status text
    )
    language plpgsql
    as $$
    declare
      existing_row record;
      next_pause timestamptz;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      select h.conversation_id,
             h.resulting_pause_until,
             (h.conversation_id = p_conversation_id
               and h.action = 'resume'
               and h.reviewer_reference = p_reviewer_ref
               and h.effective_at = p_effective_at) as matches
      into existing_row
      from human_pause_events as h
      where h.reviewer_request_key = p_request_key;

      if found then
        if not coalesce(existing_row.matches, false) then
          raise exception using errcode = '23505', message = 'resume_request_conflict';
        end if;
        return query
          select existing_row.conversation_id::text, existing_row.resulting_pause_until, 'duplicate'::text;
        return;
      end if;

      perform 1 from conversations where id = p_conversation_id for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'conversation_not_found';
      end if;

      update conversations
      set last_authorized_resume_at = greatest(coalesce(last_authorized_resume_at, p_effective_at), p_effective_at)
      where id = p_conversation_id;

      update conversations
      set ai_paused_until = greatest(
            (
              select max(source_event.occurred_at + interval '24 hours')
              from human_pause_events as pause
              join webhook_events as source_event on source_event.id = pause.source_webhook_event_id
              join webhook_event_applications as app on app.webhook_event_id = source_event.id
              where pause.conversation_id = conversations.id
                and pause.action = 'pause'
                and pause.actor_kind = 'business_echo'
                and app.conversation_id = conversations.id
                and app.outcome = 'business_echo_paused'
                and source_event.occurred_at > conversations.last_authorized_resume_at
            ),
            (
              select max(pause.resulting_pause_until)
              from human_pause_events as pause
              where pause.conversation_id = conversations.id
                and pause.action = 'pause'
                and pause.actor_kind = 'reviewer'
                and pause.effective_at > conversations.last_authorized_resume_at
            )
          ),
          updated_at = now(),
          row_version = row_version + 1
      where id = p_conversation_id
      returning conversations.ai_paused_until into next_pause;

      insert into human_pause_events (
        conversation_id, action, effective_at, resulting_pause_until,
        actor_kind, reviewer_reference, reviewer_request_key
      ) values (
        p_conversation_id, 'resume', p_effective_at, next_pause,
        'reviewer', p_reviewer_ref, p_request_key
      );

      insert into policy_audit_outcomes (
        conversation_id, decision_type, outcome, reason_code, evaluated_at
      ) values (
        p_conversation_id, 'authorized_resume', 'applied', 'resume_applied', p_effective_at
      );

      return query select p_conversation_id::text, next_pause, 'applied'::text;
    end;
    $$;

    create function admin_review_deletion_request(
      p_request_ref text,
      p_decision text,
      p_reason_code text,
      p_decided_at timestamptz,
      p_reviewer_ref text,
      p_request_key text,
      p_verification_method text default 'known_name'
    )
    returns table (
      request_ref text,
      state text,
      status text
    )
    language plpgsql
    as $$
    declare
      req_row record;
      existing_ev record;
      next_state text;
      next_outcome text;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      if p_decision not in ('approve', 'reject') then
        raise exception using errcode = '22023', message = 'invalid_review_decision';
      end if;
      if p_verification_method not in ('explicit_confirmation', 'known_name') then
        raise exception using errcode = '22023', message = 'invalid_verification_method';
      end if;

      next_state := case when p_decision = 'approve' then 'human_review' else 'rejected' end;
      next_outcome := case when p_decision = 'approve' then 'applied' else 'rejected' end;

      select r.request_ref,
             e.resulting_state,
             (e.action = 'reviewer_decision'
               and r.request_ref = p_request_ref
               and e.resulting_state = next_state
               and e.reason_code = p_reason_code
               and e.reviewer_reference = p_reviewer_ref
               and e.effective_at = p_decided_at) as matches
      into existing_ev
      from privacy_request_events as e
      join privacy_requests as r on r.id = e.request_id
      where e.request_key = p_request_key;

      if found then
        if not coalesce(existing_ev.matches, false) then
          raise exception using errcode = '23505', message = 'deletion_review_conflict';
        end if;
        return query select existing_ev.request_ref, existing_ev.resulting_state, 'duplicate'::text;
        return;
      end if;

      select pr.id, pr.state, pr.contact_id, pr.source_webhook_event_id, pr.received_at
      into req_row
      from privacy_requests as pr
      where pr.request_ref = p_request_ref
        and pr.request_type = 'deletion'
      for update;

      if not found then
        raise exception using errcode = 'P0002', message = 'deletion_request_not_found';
      end if;
      if req_row.state <> 'awaiting_confirmation' then
        raise exception using errcode = '23505', message = 'deletion_request_state_invalid';
      end if;
      if p_decided_at < req_row.received_at then
        raise exception using errcode = '22023', message = 'decision_before_receipt';
      end if;

      update privacy_requests
      set state = next_state,
          decision_at = p_decided_at,
          reviewer_reference = p_reviewer_ref,
          decision_code = p_verification_method,
          reason_code = p_reason_code,
          updated_at = now(),
          row_version = row_version + 1
      where id = req_row.id;

      insert into privacy_request_events (
        request_id, action, outcome, reason_code, previous_state,
        resulting_state, actor_type, reviewer_reference,
        source_webhook_event_id, effective_at, request_key
      ) values (
        req_row.id, 'reviewer_decision', next_outcome, p_reason_code,
        'awaiting_confirmation', next_state, 'support_reviewer', p_reviewer_ref,
        req_row.source_webhook_event_id, p_decided_at, p_request_key
      );

      return query select p_request_ref, next_state, 'applied'::text;
    end;
    $$;

    create function admin_load_deletion_target_data(p_request_ref text)
    returns table (
      row_kind text,
      record_id text,
      channel text,
      channel_account_id text,
      external_contact_id text,
      idempotency_key text
    )
    language plpgsql
    as $$
    declare
      target_contact_id bigint;
      req_state text;
    begin
      select r.contact_id, r.state
      into target_contact_id, req_state
      from privacy_requests as r
      where r.request_ref = p_request_ref
        and r.request_type = 'deletion';

      if not found or req_state <> 'human_review' or target_contact_id is null then
        raise exception using errcode = 'P0002', message = 'deletion_targets_unavailable';
      end if;

      return query
        select 'identity'::text,
               i.id::text,
               i.channel,
               i.channel_account_id,
               i.external_contact_id,
               null::text
        from channel_identities as i
        where i.contact_id = target_contact_id
          and i.external_contact_id not like 'deleted:%'
        order by i.id;

      return query
        select 'webhook_event'::text,
               w.id::text,
               w.channel,
               null::text,
               null::text,
               w.idempotency_key
        from webhook_events as w
        where exists (
          select 1
          from channel_identities as ci
          where ci.contact_id = target_contact_id
            and ci.channel = w.channel
            and ci.channel_account_id = w.channel_account_id
            and ci.external_contact_id = w.contact_id
        )
           or w.id in (
             select wea.webhook_event_id
             from webhook_event_applications as wea
             join conversations as conv on conv.id = wea.conversation_id
             join channel_identities as ci on ci.id = conv.channel_identity_id
             where ci.contact_id = target_contact_id
           )
        order by w.id;
    end;
    $$;

    create function admin_execute_deletion_erasure(
      p_request_ref text,
      p_executed_at timestamptz,
      p_request_key text,
      p_key_version text,
      p_identity_ids bigint[],
      p_identity_hmacs text[],
      p_account_pseudonyms text[],
      p_contact_pseudonyms text[],
      p_event_ids bigint[],
      p_event_replay_keys text[]
    )
    returns table (
      request_ref text,
      conversations_processed integer,
      identities_pseudonymized integer,
      messages_cleared integer,
      tombstones_created integer,
      status text
    )
    language plpgsql
    as $$
    declare
      req_row record;
      existing_run record;
      idx integer;
      v_conversations integer := 0;
      v_identities integer := 0;
      v_messages integer := 0;
      v_tombstones integer := 0;
      v_row_count integer := 0;
      v_conv_ids bigint[];
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      select r.request_ref, d.conversations_processed, d.identities_pseudonymized,
             d.messages_cleared, d.tombstones_created,
             (r.request_ref = p_request_ref and d.executed_at = p_executed_at) as matches
      into existing_run
      from privacy_deletion_runs as d
      join privacy_requests as r on r.id = d.request_id
      where d.request_key = p_request_key;

      if found then
        if not coalesce(existing_run.matches, false) then
          raise exception using errcode = '23505', message = 'deletion_execute_conflict';
        end if;
        return query select existing_run.request_ref, existing_run.conversations_processed,
          existing_run.identities_pseudonymized, existing_run.messages_cleared,
          existing_run.tombstones_created, 'duplicate'::text;
        return;
      end if;

      select id, state, contact_id, decision_at
      into req_row
      from privacy_requests
      where privacy_requests.request_ref = p_request_ref
        and request_type = 'deletion'
      for update;

      if not found or req_row.state <> 'human_review' or req_row.contact_id is null then
        raise exception using errcode = '23505', message = 'deletion_request_not_approved';
      end if;

      select array_agg(conv.id order by conv.id)
      into v_conv_ids
      from conversations as conv
      join channel_identities as ci on ci.id = conv.channel_identity_id
      where ci.contact_id = req_row.contact_id;
      v_conversations := coalesce(cardinality(v_conv_ids), 0);

      for idx in 1 .. coalesce(cardinality(p_identity_ids), 0) loop
        insert into privacy_suppressions (
          identity_hmac, channel, category, reason_code, effective_at, key_version
        )
        select p_identity_hmacs[idx], ci.channel, 'deletion_tombstone', 'customer_deletion',
               p_executed_at, p_key_version
        from channel_identities as ci
        where ci.id = p_identity_ids[idx]
          and ci.contact_id = req_row.contact_id
        on conflict (identity_hmac, channel, category, key_version) do nothing;
        get diagnostics v_row_count = row_count;
        v_tombstones := v_tombstones + v_row_count;

        update channel_identities
        set channel_account_id = p_account_pseudonyms[idx],
            external_contact_id = p_contact_pseudonyms[idx]
        where id = p_identity_ids[idx]
          and contact_id = req_row.contact_id;
        get diagnostics v_row_count = row_count;
        v_identities := v_identities + v_row_count;
      end loop;

      for idx in 1 .. coalesce(cardinality(p_event_ids), 0) loop
        update webhook_events
        set idempotency_key = p_event_replay_keys[idx],
            channel_account_id = null,
            contact_id = null,
            external_message_id = null,
            message_text = null,
            message_status = null
        where id = p_event_ids[idx];
        get diagnostics v_row_count = row_count;
        v_messages := v_messages + v_row_count;
      end loop;

      if v_conv_ids is not null then
        update support_reply_drafts
        set state = 'erased',
            answer_text = null,
            erased_at = p_executed_at
        where conversation_id = any(v_conv_ids)
          and state = 'ready';

        update knowledge_gap_observations
        set sanitized_summary = null,
            erased_at = p_executed_at
        where conversation_id = any(v_conv_ids)
          and erased_at is null;

        update outbound_attempts
        set state = 'delivery_unknown',
            outcome_code = 'crash_after_dispatch',
            finished_at = p_executed_at
        where intent_id in (
          select id from outbound_intents
          where conversation_id = any(v_conv_ids)
            and state in ('pending', 'leased')
        ) and state = 'dispatch_started';

        update outbound_intents
        set state = 'delivery_unknown',
            next_attempt_at = null,
            lease_ref = null,
            lease_expires_at = null,
            terminal_reason = 'delivery_unknown',
            finished_at = p_executed_at,
            updated_at = p_executed_at
        where conversation_id = any(v_conv_ids)
          and state in ('pending', 'leased')
          and exists (
            select 1 from outbound_attempts as oa
            where oa.intent_id = outbound_intents.id
              and oa.state = 'delivery_unknown'
              and oa.finished_at = p_executed_at
          );

        update outbound_attempts
        set state = 'abandoned_before_dispatch',
            outcome_code = 'aborted_before_dispatch',
            finished_at = p_executed_at
        where intent_id in (
          select id from outbound_intents
          where conversation_id = any(v_conv_ids)
            and state in ('pending', 'leased')
        ) and state = 'authorized';

        update outbound_intents
        set state = 'canceled',
            next_attempt_at = null,
            lease_ref = null,
            lease_expires_at = null,
            terminal_reason = 'identity_deleted',
            finished_at = p_executed_at,
            updated_at = p_executed_at
        where conversation_id = any(v_conv_ids)
          and state in ('pending', 'leased');

        update conversations
        set ai_paused_until = null,
            last_authorized_resume_at = null,
            updated_at = now(),
            row_version = row_version + 1
        where id = any(v_conv_ids);
      end if;

      update privacy_request_locations
      set state = 'completed',
          outcome_code = 'local_erasure_complete',
          checked_at = p_executed_at
      where request_id = req_row.id
        and location_code in ('primary_postgres', 'pending_outbound');

      update privacy_requests
      set state = 'in_progress',
          contact_id = null,
          source_webhook_event_id = null,
          updated_at = now(),
          row_version = row_version + 1
      where id = req_row.id;

      insert into privacy_request_events (
        request_id, action, outcome, reason_code, previous_state,
        resulting_state, actor_type, effective_at, request_key
      ) values (
        req_row.id, 'deletion_executed', 'applied', 'local_erasure_complete',
        'human_review', 'in_progress', 'deletion_job', p_executed_at, p_request_key
      );

      insert into privacy_deletion_runs (
        request_id, request_key, executed_at, conversations_processed,
        identities_pseudonymized, messages_cleared, tombstones_created,
        status, completed_at
      ) values (
        req_row.id, p_request_key, p_executed_at, v_conversations,
        v_identities, v_messages, v_tombstones, 'applied', p_executed_at
      );

      return query select p_request_ref, v_conversations, v_identities, v_messages, v_tombstones, 'applied'::text;
    end;
    $$;

    create function admin_review_privacy_request(
      p_request_ref text,
      p_decision text,
      p_reason_code text,
      p_decided_at timestamptz,
      p_reviewer_ref text,
      p_request_key text
    )
    returns table (
      request_ref text,
      state text,
      status text
    )
    language plpgsql
    as $$
    declare
      req_row record;
      existing_ev record;
      next_state text;
      next_outcome text;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));
      if p_decision not in ('approve', 'reject') then
        raise exception using errcode = '22023', message = 'invalid_review_decision';
      end if;
      next_state := case when p_decision = 'approve' then 'in_progress' else 'rejected' end;
      next_outcome := case when p_decision = 'approve' then 'applied' else 'rejected' end;

      select r.request_ref,
             e.resulting_state,
             (e.action = 'reviewer_decision'
               and r.request_ref = p_request_ref
               and e.resulting_state = next_state
               and e.reason_code = p_reason_code
               and e.reviewer_reference = p_reviewer_ref
               and e.effective_at = p_decided_at) as matches
      into existing_ev
      from privacy_request_events as e
      join privacy_requests as r on r.id = e.request_id
      where e.request_key = p_request_key;

      if found then
        if not coalesce(existing_ev.matches, false) then
          raise exception using errcode = '23505', message = 'privacy_review_conflict';
        end if;
        return query select existing_ev.request_ref, existing_ev.resulting_state, 'duplicate'::text;
        return;
      end if;

      select pr.id, pr.state, pr.request_type, pr.received_at
      into req_row
      from privacy_requests as pr
      where pr.request_ref = p_request_ref
        and pr.request_type in ('access', 'correction')
      for update;

      if not found or req_row.state <> 'human_review' then
        raise exception using errcode = '23505', message = 'privacy_request_not_reviewable';
      end if;

      update privacy_requests
      set state = next_state,
          decision_at = p_decided_at,
          reviewer_reference = p_reviewer_ref,
          reason_code = p_reason_code,
          updated_at = now(),
          row_version = row_version + 1
      where id = req_row.id;

      insert into privacy_request_events (
        request_id, action, outcome, reason_code, previous_state,
        resulting_state, actor_type, reviewer_reference, effective_at, request_key
      ) values (
        req_row.id, 'reviewer_decision', next_outcome, p_reason_code,
        'human_review', next_state, 'support_reviewer', p_reviewer_ref, p_decided_at, p_request_key
      );

      return query select p_request_ref, next_state, 'applied'::text;
    end;
    $$;

    create function admin_attest_privacy_location(
      p_request_ref text,
      p_location_code text,
      p_state text,
      p_outcome_code text,
      p_checked_at timestamptz,
      p_reviewer_ref text,
      p_request_key text
    )
    returns table (
      request_ref text,
      location_code text,
      state text,
      request_state text,
      status text
    )
    language plpgsql
    as $$
    declare
      req_row record;
      existing_ev record;
      v_pending integer;
      v_failed integer;
      v_next_req_state text;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));
      if p_state not in ('completed', 'failed', 'not_applicable') then
        raise exception using errcode = '22023', message = 'invalid_location_state';
      end if;

      select r.request_ref, e.location_code, l.state, r.state as req_state,
             (e.action = 'location_checked'
               and r.request_ref = p_request_ref
               and e.location_code = p_location_code
               and e.reason_code = p_outcome_code
               and e.reviewer_reference = p_reviewer_ref
               and e.effective_at = p_checked_at) as matches
      into existing_ev
      from privacy_request_events as e
      join privacy_requests as r on r.id = e.request_id
      join privacy_request_locations as l on l.request_id = r.id and l.location_code = e.location_code
      where e.request_key = p_request_key;

      if found then
        if not coalesce(existing_ev.matches, false) then
          raise exception using errcode = '23505', message = 'privacy_location_conflict';
        end if;
        return query select existing_ev.request_ref, existing_ev.location_code, existing_ev.state,
          existing_ev.req_state, 'duplicate'::text;
        return;
      end if;

      select pr.id, pr.state
      into req_row
      from privacy_requests as pr
      where pr.request_ref = p_request_ref
      for update;

      if not found or req_row.state not in ('in_progress', 'partially_completed') then
        raise exception using errcode = '23505', message = 'privacy_request_not_in_progress';
      end if;

      update privacy_request_locations
      set state = p_state,
          outcome_code = p_outcome_code,
          reviewer_reference = p_reviewer_ref,
          checked_at = p_checked_at
      where request_id = req_row.id
        and privacy_request_locations.location_code = p_location_code;

      if not found then
        raise exception using errcode = 'P0002', message = 'privacy_location_not_found';
      end if;

      select count(*) filter (where l.required and l.state = 'pending')::int,
             count(*) filter (where l.required and l.state = 'failed')::int
      into v_pending, v_failed
      from privacy_request_locations as l
      where l.request_id = req_row.id;

      v_next_req_state := case
        when v_pending = 0 and v_failed = 0 then 'completed'
        when v_pending = 0 and v_failed > 0 then 'partially_completed'
        else req_row.state
      end;

      insert into privacy_request_events (
        request_id, action, outcome, reason_code, previous_state,
        resulting_state, actor_type, reviewer_reference,
        effective_at, request_key, location_code
      ) values (
        req_row.id, 'location_checked', 'applied', p_outcome_code, req_row.state,
        v_next_req_state, 'support_reviewer', p_reviewer_ref,
        p_checked_at, p_request_key, p_location_code
      );

      if v_next_req_state <> req_row.state then
        update privacy_requests
        set state = v_next_req_state,
            completed_at = case when v_next_req_state = 'completed' then p_checked_at else completed_at end,
            updated_at = now(),
            row_version = row_version + 1
        where id = req_row.id;
      end if;

      return query select p_request_ref, p_location_code, p_state, v_next_req_state, 'applied'::text;
    end;
    $$;

    create function admin_load_approved_access_export_rows(p_request_ref text)
    returns table (
      contact_id text,
      preferred_language text,
      channel text,
      external_contact_id text,
      occurred_at timestamptz,
      event_kind text,
      message_text text
    )
    language plpgsql
    as $$
    declare
      req_row record;
    begin
      select r.contact_id, r.state
      into req_row
      from privacy_requests as r
      where r.request_ref = p_request_ref
        and r.request_type = 'access';

      if not found or req_row.state not in ('in_progress', 'partially_completed', 'completed') or req_row.contact_id is null then
        raise exception using errcode = 'P0002', message = 'access_export_unavailable';
      end if;

      return query
        select req_row.contact_id::text,
               c.preferred_language,
               ci.channel,
               ci.external_contact_id,
               we.occurred_at,
               we.event_kind,
               we.message_text
        from contacts as c
        join channel_identities as ci on ci.contact_id = c.id
        left join conversations as conv on conv.channel_identity_id = ci.id
        left join webhook_event_applications as wea on wea.conversation_id = conv.id
        left join webhook_events as we on we.id = wea.webhook_event_id
        where c.id = req_row.contact_id
        order by we.occurred_at desc nulls last, we.id desc nulls last
        limit 200;
    end;
    $$;

    create function admin_record_privacy_access_run(
      p_request_ref text,
      p_collected_at timestamptz,
      p_collector_count integer,
      p_record_count integer,
      p_bundle_sha256 text,
      p_request_key text
    )
    returns table (
      request_ref text,
      record_count integer,
      bundle_sha256 text,
      status text
    )
    language plpgsql
    as $$
    declare
      req_row record;
      existing_run record;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      select r.request_ref, a.record_count, a.bundle_sha256,
             (r.request_ref = p_request_ref
               and a.collected_at = p_collected_at
               and a.bundle_sha256 = p_bundle_sha256) as matches
      into existing_run
      from privacy_access_runs as a
      join privacy_requests as r on r.id = a.request_id
      where a.request_key = p_request_key;

      if found then
        if not coalesce(existing_run.matches, false) then
          raise exception using errcode = '23505', message = 'access_run_conflict';
        end if;
        return query select existing_run.request_ref, existing_run.record_count, existing_run.bundle_sha256, 'duplicate'::text;
        return;
      end if;

      select id, state
      into req_row
      from privacy_requests
      where privacy_requests.request_ref = p_request_ref
        and request_type = 'access'
      for update;

      if not found or req_row.state not in ('in_progress', 'partially_completed') then
        raise exception using errcode = '23505', message = 'access_request_not_in_progress';
      end if;

      insert into privacy_access_runs (
        request_id, request_key, collected_at, collector_count,
        record_count, status, completed_at, bundle_sha256
      ) values (
        req_row.id, p_request_key, p_collected_at, p_collector_count,
        p_record_count, 'collected', p_collected_at, p_bundle_sha256
      );

      update privacy_request_locations
      set state = 'completed',
          outcome_code = 'access_collected',
          checked_at = p_collected_at
      where request_id = req_row.id
        and location_code = 'primary_postgres';

      insert into privacy_request_events (
        request_id, action, outcome, reason_code, previous_state,
        resulting_state, actor_type, effective_at, request_key
      ) values (
        req_row.id, 'access_collected', 'applied', 'access_collected',
        req_row.state, req_row.state, 'privacy_export_service', p_collected_at, p_request_key
      );

      return query select p_request_ref, p_record_count, p_bundle_sha256, 'applied'::text;
    end;
    $$;

    create function admin_execute_correction(
      p_request_ref text,
      p_field_key text,
      p_new_value text,
      p_executed_at timestamptz,
      p_reviewer_ref text,
      p_request_key text
    )
    returns table (
      request_ref text,
      result_code text,
      status text
    )
    language plpgsql
    as $$
    declare
      req_row record;
      existing_run record;
      v_result_code text;
      v_reason text;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      select r.request_ref, c.result_code,
             (r.request_ref = p_request_ref and c.field_key = p_field_key and c.executed_at = p_executed_at) as matches
      into existing_run
      from privacy_correction_runs as c
      join privacy_requests as r on r.id = c.request_id
      where c.request_key = p_request_key;

      if found then
        if not coalesce(existing_run.matches, false) then
          raise exception using errcode = '23505', message = 'correction_run_conflict';
        end if;
        return query select existing_run.request_ref, existing_run.result_code, 'duplicate'::text;
        return;
      end if;

      select id, state, contact_id
      into req_row
      from privacy_requests
      where privacy_requests.request_ref = p_request_ref
        and request_type = 'correction'
      for update;

      if not found or req_row.state not in ('in_progress', 'partially_completed') or req_row.contact_id is null then
        raise exception using errcode = '23505', message = 'correction_request_not_in_progress';
      end if;

      if p_field_key = 'preferred_language' and p_new_value in ('en', 'bn') then
        update contacts
        set preferred_language = p_new_value,
            updated_at = now()
        where id = req_row.contact_id;
        v_result_code := 'applied';
        v_reason := 'correction_applied';

        update privacy_request_locations
        set state = 'completed',
            outcome_code = 'correction_applied',
            reviewer_reference = p_reviewer_ref,
            checked_at = p_executed_at
        where request_id = req_row.id
          and location_code = 'primary_postgres';
      elsif p_field_key in ('created_at', 'id', 'open_request_key', 'request_ref', 'source_webhook_event_id')
         or p_field_key ~ '(?:access|api|credential|key|otp|password|payment|secret|security|token)' then
        v_result_code := 'rejected';
        v_reason := 'correction_rejected';
      else
        v_result_code := 'manual_required';
        v_reason := 'correction_manual_required';
      end if;

      insert into privacy_correction_runs (
        request_id, request_key, executed_at, field_key, result_code, completed_at
      ) values (
        req_row.id, p_request_key, p_executed_at, p_field_key, v_result_code, p_executed_at
      );

      insert into privacy_request_events (
        request_id, action, outcome, reason_code, previous_state,
        resulting_state, actor_type, reviewer_reference, effective_at, request_key
      ) values (
        req_row.id, 'correction_executed',
        case when v_result_code = 'rejected' then 'rejected' else 'applied' end,
        v_reason, req_row.state, req_row.state, 'correction_service', p_reviewer_ref,
        p_executed_at, p_request_key
      );

      return query select p_request_ref, v_result_code, 'applied'::text;
    end;
    $$;

    create function admin_record_consent_event(
      p_channel_identity_id bigint,
      p_category text,
      p_action text,
      p_wording text,
      p_wording_version text,
      p_source_at timestamptz,
      p_request_key text
    )
    returns table (
      channel_identity_id text,
      action text,
      status text
    )
    language plpgsql
    as $$
    declare
      existing_ev record;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));
      if p_action not in ('grant', 'revoke') then
        raise exception using errcode = '22023', message = 'invalid_consent_action';
      end if;

      select e.channel_identity_id, e.action,
             (e.channel_identity_id = p_channel_identity_id
               and e.category = p_category
               and e.action = p_action
               and e.wording = p_wording
               and e.wording_version = p_wording_version
               and e.source = 'reviewer_recorded'
               and e.source_at = p_source_at) as matches
      into existing_ev
      from consent_events as e
      where e.idempotency_key = p_request_key;

      if found then
        if not coalesce(existing_ev.matches, false) then
          raise exception using errcode = '23505', message = 'consent_event_conflict';
        end if;
        return query select existing_ev.channel_identity_id::text, existing_ev.action, 'duplicate'::text;
        return;
      end if;

      perform 1 from channel_identities where id = p_channel_identity_id for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'channel_identity_not_found';
      end if;

      insert into consent_events (
        channel_identity_id, category, action, wording, wording_version,
        source, source_at, idempotency_key
      ) values (
        p_channel_identity_id, p_category, p_action, p_wording, p_wording_version,
        'reviewer_recorded', p_source_at, p_request_key
      );

      insert into policy_audit_outcomes (
        channel_identity_id, decision_type, outcome, reason_code, evaluated_at
      ) values (
        p_channel_identity_id, 'consent_record', 'applied',
        case when p_action = 'grant' then 'consent_grant' else 'consent_revoke' end,
        p_source_at
      );

      return query select p_channel_identity_id::text, p_action, 'applied'::text;
    end;
    $$;

    create function admin_record_marketing_reopt_in(
      p_channel_identity_id bigint,
      p_categories text[],
      p_wording text,
      p_wording_version text,
      p_effective_at timestamptz,
      p_reviewer_ref text,
      p_verification_method text,
      p_identity_hmacs text[],
      p_key_versions text[],
      p_request_key text
    )
    returns table (
      suppressions_cleared integer,
      category_grants integer,
      status text
    )
    language plpgsql
    as $$
    declare
      existing_run record;
      v_channel text;
      v_tombstoned boolean;
      v_cleared integer := 0;
      v_grants integer := 0;
      cat text;
      v_row_count integer;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0::bigint));

      select r.suppressions_cleared_count, r.category_grants_count,
             (r.anchor_channel_identity_id = p_channel_identity_id
               and r.category_codes = p_categories
               and r.effective_at = p_effective_at
               and r.reviewer_reference = p_reviewer_ref) as matches
      into existing_run
      from privacy_marketing_reopt_in_runs as r
      where r.request_key = p_request_key;

      if found then
        if not coalesce(existing_run.matches, false) then
          raise exception using errcode = '23505', message = 'marketing_reopt_in_conflict';
        end if;
        return query select existing_run.suppressions_cleared_count,
          existing_run.category_grants_count, 'duplicate'::text;
        return;
      end if;

      select channel
      into v_channel
      from channel_identities
      where id = p_channel_identity_id
        and external_contact_id not like 'deleted:%'
      for update;

      if not found then
        raise exception using errcode = 'P0002', message = 'channel_identity_not_found';
      end if;

      select exists (
        select 1
        from privacy_suppressions as ps
        where ps.channel = v_channel
          and ps.category = 'deletion_tombstone'
          and ps.identity_hmac = any(p_identity_hmacs)
          and ps.key_version = any(p_key_versions)
      ) into v_tombstoned;

      if v_tombstoned then
        raise exception using errcode = '23514', message = 'deletion_tombstone_blocks_reopt_in';
      end if;

      foreach cat in array p_categories loop
        insert into consent_events (
          channel_identity_id, category, action, wording, wording_version,
          source, source_at, idempotency_key
        ) values (
          p_channel_identity_id, cat, 'grant', p_wording, p_wording_version,
          'reviewer_recorded', p_effective_at, p_request_key || ':' || cat
        );
        v_grants := v_grants + 1;

        delete from privacy_suppressions
        where channel = v_channel
          and identity_hmac = any(p_identity_hmacs)
          and key_version = any(p_key_versions)
          and category in ('marketing_opt_out', 'marketing_opt_out:' || cat);
        get diagnostics v_row_count = row_count;
        v_cleared := v_cleared + v_row_count;
      end loop;

      insert into privacy_marketing_reopt_in_runs (
        request_key, anchor_channel_identity_id, category_codes, effective_at,
        scope, linked_identities_count, category_grants_count,
        suppressions_cleared_count, reviewer_reference, verification_method,
        status, completed_at
      ) values (
        p_request_key, p_channel_identity_id, p_categories, p_effective_at,
        'source_identity', 1, v_grants, v_cleared,
        p_reviewer_ref, p_verification_method, 'applied', p_effective_at
      );

      return query select v_cleared, v_grants, 'applied'::text;
    end;
    $$;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1
        from admin_audit_events
        where action not in (
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
        )
        or (object_type is not null and object_type not in (
          'account', 'session', 'knowledge_version', 'knowledge_item',
          'owner_question', 'model_policy', 'model_gateway', 'escalation'
        ))
      )
      or exists (
        select 1
        from human_pause_events
        where action = 'pause' and actor_kind = 'reviewer'
      )
      or exists (
        select 1
        from policy_audit_outcomes
        where decision_type = 'authorized_pause'
           or reason_code in ('manual_pause_applied', 'manual_pause_duplicate')
      ) then
        raise exception using
          errcode = '55000',
          message = 'Track 2B rollback blocked while private admin control evidence exists';
      end if;
    end;
    $$;

    drop function admin_record_marketing_reopt_in(bigint, text[], text, text, timestamptz, text, text, text[], text[], text);
    drop function admin_record_consent_event(bigint, text, text, text, text, timestamptz, text);
    drop function admin_execute_correction(text, text, text, timestamptz, text, text);
    drop function admin_record_privacy_access_run(text, timestamptz, integer, integer, text, text);
    drop function admin_load_approved_access_export_rows(text);
    drop function admin_attest_privacy_location(text, text, text, text, timestamptz, text, text);
    drop function admin_review_privacy_request(text, text, text, timestamptz, text, text);
    drop function admin_execute_deletion_erasure(text, timestamptz, text, text, bigint[], text[], text[], text[], bigint[], text[]);
    drop function admin_load_deletion_target_data(text);
    drop function admin_review_deletion_request(text, text, text, timestamptz, text, text, text);
    drop function admin_resume_conversation(bigint, timestamptz, text, text);
    drop function admin_pause_conversation(bigint, timestamptz, text, text);

    drop view admin_consent_identities_v;
    drop view admin_privacy_locations_v;
    drop view admin_privacy_requests_v;
    drop view admin_pause_states_v;

    alter table privacy_access_runs drop column bundle_sha256;
    alter table contacts drop column preferred_language;

    alter table policy_audit_outcomes
      drop constraint policy_audit_outcomes_decision_type_check,
      drop constraint policy_audit_outcomes_reason_code_check;
    alter table policy_audit_outcomes
      add constraint policy_audit_outcomes_decision_type_check check (decision_type in (
        'event_application',
        'reply_eligibility',
        'authorized_resume',
        'consent_record',
        'marketing_eligibility'
      )),
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
        'global_marketing_opt_out',
        'identity_not_found'
      ));

    create or replace function enforce_human_pause_authority()
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
          and later_echo.id = (
            select current_state.id
            from human_pause_events as current_state
            where current_state.conversation_id = new.conversation_id
              and current_state.effective_at > new.effective_at
            order by current_state.effective_at desc, current_state.id desc
            limit 1
          )
      ) then
        raise exception using errcode = '23514', message = 'resume pause deadline lacks a later echo';
      end if;

      return new;
    end;
    $$;

    alter table human_pause_events drop constraint human_pause_events_actor_shape_check;
    alter table human_pause_events
      add constraint human_pause_events_actor_shape_check check (
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
      );

    alter table admin_audit_events
      drop constraint admin_audit_events_object_type_check;
    alter table admin_audit_events
      add constraint admin_audit_events_object_type_check check (object_type is null or object_type in (
        'account', 'session', 'knowledge_version', 'knowledge_item',
        'owner_question', 'model_policy', 'model_gateway', 'escalation'
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
  `);
}
