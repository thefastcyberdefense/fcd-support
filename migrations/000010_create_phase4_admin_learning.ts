import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table admin_accounts (
      id bigint generated always as identity primary key,
      account_ref text not null unique check (
        account_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      login_name text not null unique check (
        login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      ),
      password_algorithm text not null check (password_algorithm = 'scrypt_v1'),
      password_cost integer not null check (password_cost between 16384 and 1048576),
      password_block_size integer not null check (password_block_size between 8 and 32),
      password_parallelization integer not null check (password_parallelization between 1 and 16),
      password_key_length integer not null check (password_key_length between 32 and 64),
      password_salt bytea not null check (octet_length(password_salt) between 16 and 64),
      password_hash bytea not null check (octet_length(password_hash) between 32 and 64),
      state text not null check (state in ('active', 'revoked')),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      password_changed_at timestamptz not null,
      revoked_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (updated_at >= created_at and password_changed_at >= created_at),
      check (
        (state = 'active' and revoked_at is null)
        or (state = 'revoked' and revoked_at is not null and revoked_at >= created_at)
      )
    );

    create table admin_role_assignments (
      id bigint generated always as identity primary key,
      account_id bigint not null references admin_accounts(id),
      role text not null check (role in (
        'knowledge_editor', 'knowledge_reviewer', 'support_reviewer', 'administrator'
      )),
      action text not null check (action in ('assign', 'revoke')),
      actor_account_id bigint not null references admin_accounts(id),
      effective_at timestamptz not null,
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null default now()
    );

    create index admin_role_assignments_account_role_idx
      on admin_role_assignments (account_id, role, effective_at desc, id desc);

    create table admin_mfa_credentials (
      id bigint generated always as identity primary key,
      account_id bigint not null unique references admin_accounts(id),
      algorithm text not null check (algorithm = 'totp_sha1_v1'),
      key_version text not null check (
        key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
      ),
      encrypted_material bytea not null check (octet_length(encrypted_material) between 16 and 512),
      encryption_nonce bytea not null check (octet_length(encryption_nonce) = 12),
      authentication_tag bytea not null check (octet_length(authentication_tag) = 16),
      last_accepted_counter bigint check (last_accepted_counter is null or last_accepted_counter >= 0),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      revoked_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (updated_at >= created_at),
      check (revoked_at is null or revoked_at >= created_at)
    );

    create table admin_sessions (
      id bigint generated always as identity primary key,
      account_id bigint not null references admin_accounts(id),
      session_hash bytea not null unique check (octet_length(session_hash) = 32),
      csrf_hash bytea not null check (octet_length(csrf_hash) = 32),
      state text not null check (state in ('preauth', 'active', 'revoked', 'expired')),
      created_at timestamptz not null,
      expires_at timestamptz not null,
      last_seen_at timestamptz not null,
      authenticated_at timestamptz,
      revoked_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (expires_at > created_at),
      check (last_seen_at >= created_at and last_seen_at <= expires_at),
      check (
        (state = 'preauth' and authenticated_at is null and revoked_at is null)
        or (state = 'active' and authenticated_at is not null and revoked_at is null)
        or (state in ('revoked', 'expired') and revoked_at is not null)
      )
    );

    create index admin_sessions_account_state_expiry_idx
      on admin_sessions (account_id, state, expires_at);

    create table admin_audit_events (
      id bigint generated always as identity primary key,
      actor_account_id bigint references admin_accounts(id),
      action text not null check (action in (
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
      )),
      result text not null check (result in ('applied', 'denied', 'duplicate', 'failed')),
      object_type text check (object_type is null or object_type in (
        'account', 'session', 'knowledge_version', 'knowledge_item',
        'owner_question', 'model_policy', 'escalation'
      )),
      object_ref text check (
        object_ref is null
        or (object_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      ),
      reason_code text not null check (
        reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      request_key text check (
        request_key is null
        or (btrim(request_key) <> '' and char_length(request_key) <= 128)
      ),
      effective_at timestamptz not null,
      created_at timestamptz not null default now(),
      check ((object_type is null) = (object_ref is null))
    );

    create unique index admin_audit_events_request_key_unique
      on admin_audit_events (request_key)
      where request_key is not null;

    create table knowledge_gap_observations (
      id bigint generated always as identity primary key,
      observation_ref text not null unique check (
        observation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      source_webhook_event_id bigint not null unique references webhook_events(id),
      conversation_id bigint not null references conversations(id),
      language text not null check (language in ('en', 'bn')),
      gap_kind text not null check (gap_kind in (
        'faq_miss', 'faq_ambiguous', 'unsupported_model_claim',
        'human_correction', 'escalation', 'repeated_topic',
        'bilingual_coverage_gap'
      )),
      sanitized_summary text check (
        sanitized_summary is null
        or (btrim(sanitized_summary) <> '' and char_length(sanitized_summary) <= 1000)
      ),
      retention_deadline timestamptz not null,
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      erased_at timestamptz,
      check (retention_deadline >= created_at),
      check (erased_at is null or (erased_at >= created_at and sanitized_summary is null))
    );

    create index knowledge_gap_observations_conversation_retention_idx
      on knowledge_gap_observations (conversation_id, retention_deadline, id);

    create table knowledge_gap_candidates (
      id bigint generated always as identity primary key,
      observation_id bigint not null references knowledge_gap_observations(id),
      knowledge_version_id bigint not null references knowledge_versions(id),
      candidate_rank smallint not null check (candidate_rank between 1 and 8),
      similarity_score numeric(6,5) check (
        similarity_score is null or similarity_score between 0 and 1
      ),
      unique (observation_id, candidate_rank),
      unique (observation_id, knowledge_version_id)
    );

    create table customer_insight_runs (
      id bigint generated always as identity primary key,
      run_ref text not null unique check (
        run_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      window_started_at timestamptz not null,
      window_ended_at timestamptz not null,
      minimum_group_count integer not null check (minimum_group_count between 2 and 1000),
      state text not null check (state in ('completed', 'invalidated')),
      source_observation_count integer not null check (source_observation_count >= 0),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      invalidated_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (window_ended_at > window_started_at),
      check (
        (state = 'completed' and invalidated_at is null)
        or (state = 'invalidated' and invalidated_at is not null and invalidated_at >= created_at)
      )
    );

    create table customer_insight_entries (
      id bigint generated always as identity primary key,
      insight_ref text not null unique check (
        insight_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      run_id bigint not null references customer_insight_runs(id),
      topic_code text not null check (topic_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      category_code text not null check (category_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      language text check (language is null or language in ('en', 'bn')),
      occurrence_count integer not null check (occurrence_count > 0),
      sanitized_summary text check (
        sanitized_summary is null
        or (btrim(sanitized_summary) <> '' and char_length(sanitized_summary) <= 1000)
      ),
      retention_deadline timestamptz not null,
      created_at timestamptz not null,
      erased_at timestamptz,
      unique nulls not distinct (run_id, topic_code, category_code, language),
      check (retention_deadline >= created_at),
      check (erased_at is null or (erased_at >= created_at and sanitized_summary is null))
    );

    create table owner_questions (
      id bigint generated always as identity primary key,
      question_ref text not null unique check (
        question_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      question_en text not null check (
        btrim(question_en) <> '' and char_length(question_en) <= 1000
      ),
      question_bn text check (
        question_bn is null
        or (btrim(question_bn) <> '' and char_length(question_bn) <= 1000)
      ),
      priority text not null check (priority in ('low', 'normal', 'high')),
      state text not null check (state in ('open', 'answered', 'dismissed')),
      next_eligible_digest_at timestamptz not null,
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      answered_at timestamptz,
      dismissed_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (updated_at >= created_at and next_eligible_digest_at >= created_at),
      check (
        (state = 'open' and answered_at is null and dismissed_at is null)
        or (state = 'answered' and answered_at is not null and dismissed_at is null)
        or (state = 'dismissed' and dismissed_at is not null and answered_at is null)
      )
    );

    create index owner_questions_digest_queue_idx
      on owner_questions (state, next_eligible_digest_at, priority, created_at, id);

    create table owner_question_insights (
      question_id bigint not null references owner_questions(id),
      insight_id bigint not null references customer_insight_entries(id),
      primary key (question_id, insight_id)
    );

    create table owner_question_answers (
      id bigint generated always as identity primary key,
      question_id bigint not null unique references owner_questions(id),
      answer_text text not null check (
        btrim(answer_text) <> '' and char_length(answer_text) <= 4000
      ),
      reviewer_account_id bigint not null references admin_accounts(id),
      proposal_version_id bigint not null references knowledge_versions(id),
      answered_at timestamptz not null,
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null default now()
    );

    create table owner_question_digests (
      id bigint generated always as identity primary key,
      digest_ref text not null unique check (
        digest_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      state text not null check (state in ('ready', 'acknowledged')),
      period_started_at timestamptz not null,
      period_ended_at timestamptz not null,
      question_count smallint not null check (question_count between 1 and 5),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      acknowledged_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (period_ended_at > period_started_at),
      check (
        (state = 'ready' and acknowledged_at is null)
        or (state = 'acknowledged' and acknowledged_at is not null)
      )
    );

    create unique index owner_question_digests_period_unique
      on owner_question_digests (period_started_at, period_ended_at);

    create table owner_question_digest_entries (
      digest_id bigint not null references owner_question_digests(id),
      question_id bigint not null references owner_questions(id),
      position smallint not null check (position between 1 and 5),
      primary key (digest_id, question_id),
      unique (digest_id, position)
    );

    create table support_reply_drafts (
      id bigint generated always as identity primary key,
      draft_ref text not null unique check (
        draft_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      source_webhook_event_id bigint not null unique references webhook_events(id),
      conversation_id bigint not null references conversations(id),
      decision_type text not null check (decision_type in ('faq', 'model', 'safe_failure')),
      language text not null check (language in ('en', 'bn')),
      answer_text text,
      knowledge_version_id bigint references knowledge_versions(id),
      state text not null check (state in ('ready', 'erased')),
      retention_deadline timestamptz not null,
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      erased_at timestamptz,
      check (
        (state = 'ready'
          and answer_text is not null
          and btrim(answer_text) <> ''
          and char_length(answer_text) <= 4000
          and erased_at is null)
        or (state = 'erased' and answer_text is null and erased_at is not null)
      ),
      check (
        (decision_type = 'faq' and knowledge_version_id is not null)
        or decision_type <> 'faq'
      ),
      check (retention_deadline >= created_at),
      check (erased_at is null or erased_at >= created_at)
    );

    create index support_reply_drafts_conversation_retention_idx
      on support_reply_drafts (conversation_id, retention_deadline, id);

    create table support_reply_draft_knowledge (
      draft_id bigint not null references support_reply_drafts(id),
      knowledge_version_id bigint not null references knowledge_versions(id),
      reference_kind text not null check (reference_kind in ('faq_answer', 'model_fact')),
      primary key (draft_id, knowledge_version_id)
    );

    create table support_escalation_outcomes (
      id bigint generated always as identity primary key,
      escalation_ref text not null unique check (
        escalation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      conversation_id bigint references conversations(id),
      source_webhook_event_id bigint references webhook_events(id),
      reply_draft_id bigint references support_reply_drafts(id),
      reason_code text not null check (reason_code in (
        'sensitive_data_blocked', 'unsafe_redaction', 'faq_ambiguous',
        'model_disabled', 'rate_limited', 'global_limit', 'queue_full',
        'timeout', 'network_failure', 'provider_failure', 'provider_exhausted',
        'invalid_response', 'unsupported_claim', 'wrong_language',
        'policy_blocked', 'database_failure'
      )),
      state text not null check (state in ('open', 'acknowledged', 'resolved')),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      acknowledged_at timestamptz,
      resolved_at timestamptz,
      row_version bigint not null default 1 check (row_version > 0),
      check (updated_at >= created_at),
      check (
        (state = 'open' and acknowledged_at is null and resolved_at is null)
        or (state = 'acknowledged' and acknowledged_at is not null and resolved_at is null)
        or (state = 'resolved' and resolved_at is not null)
      ),
      check (
        conversation_id is not null
        or source_webhook_event_id is not null
        or reply_draft_id is not null
      )
    );

    create index support_escalation_outcomes_state_created_idx
      on support_escalation_outcomes (state, created_at, id);

    create function reject_phase4_append_only_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using errcode = '23514', message = 'Phase 4 evidence is append-only';
      return null;
    end;
    $$;

    create trigger admin_role_assignments_append_only
      before update or delete on admin_role_assignments
      for each row execute function reject_phase4_append_only_mutation();
    create trigger admin_audit_events_append_only
      before update or delete on admin_audit_events
      for each row execute function reject_phase4_append_only_mutation();
    create trigger knowledge_gap_candidates_append_only
      before update or delete on knowledge_gap_candidates
      for each row execute function reject_phase4_append_only_mutation();
    create trigger owner_question_insights_append_only
      before update or delete on owner_question_insights
      for each row execute function reject_phase4_append_only_mutation();
    create trigger owner_question_answers_append_only
      before update or delete on owner_question_answers
      for each row execute function reject_phase4_append_only_mutation();
    create trigger owner_question_digest_entries_append_only
      before update or delete on owner_question_digest_entries
      for each row execute function reject_phase4_append_only_mutation();
    create trigger support_reply_draft_knowledge_append_only
      before update or delete on support_reply_draft_knowledge
      for each row execute function reject_phase4_append_only_mutation();

    create function enforce_phase4_customer_event_authority()
    returns trigger
    language plpgsql
    as $$
    begin
      if not exists (
        select 1
        from webhook_events as event
        join webhook_event_applications as application
          on application.webhook_event_id = event.id
        where event.id = new.source_webhook_event_id
          and event.event_kind = 'customer_message'
          and event.admission_outcome = 'pending'
          and application.outcome = 'customer_message_applied'
          and application.conversation_id = new.conversation_id
      ) then
        raise exception using errcode = '23514', message = 'Phase 4 customer-derived state lacks an applied event';
      end if;
      return new;
    end;
    $$;

    create trigger knowledge_gap_observations_event_authority
      before insert or update on knowledge_gap_observations
      for each row execute function enforce_phase4_customer_event_authority();
    create trigger support_reply_drafts_event_authority
      before insert or update on support_reply_drafts
      for each row execute function enforce_phase4_customer_event_authority();

    create function enforce_knowledge_gap_erasure()
    returns trigger
    language plpgsql
    as $$
    begin
      if old.observation_ref is distinct from new.observation_ref
         or old.source_webhook_event_id is distinct from new.source_webhook_event_id
         or old.conversation_id is distinct from new.conversation_id
         or old.language is distinct from new.language
         or old.gap_kind is distinct from new.gap_kind
         or old.retention_deadline is distinct from new.retention_deadline
         or old.request_key is distinct from new.request_key
         or old.created_at is distinct from new.created_at
         or (old.sanitized_summary is null and new.sanitized_summary is not null)
         or (old.erased_at is not null and new.erased_at is distinct from old.erased_at) then
        raise exception using errcode = '23514', message = 'Knowledge gap evidence is immutable except erasure';
      end if;
      return new;
    end;
    $$;

    create trigger knowledge_gap_observations_erasure_only
      before update or delete on knowledge_gap_observations
      for each row execute function enforce_knowledge_gap_erasure();

    create function enforce_insight_entry_erasure()
    returns trigger
    language plpgsql
    as $$
    begin
      if old.insight_ref is distinct from new.insight_ref
         or old.run_id is distinct from new.run_id
         or old.topic_code is distinct from new.topic_code
         or old.category_code is distinct from new.category_code
         or old.language is distinct from new.language
         or old.occurrence_count is distinct from new.occurrence_count
         or old.retention_deadline is distinct from new.retention_deadline
         or old.created_at is distinct from new.created_at
         or (old.sanitized_summary is null and new.sanitized_summary is not null)
         or (old.erased_at is not null and new.erased_at is distinct from old.erased_at) then
        raise exception using errcode = '23514', message = 'Insight evidence is immutable except erasure';
      end if;
      return new;
    end;
    $$;

    create trigger customer_insight_entries_erasure_only
      before update or delete on customer_insight_entries
      for each row execute function enforce_insight_entry_erasure();

    create function enforce_reply_draft_erasure()
    returns trigger
    language plpgsql
    as $$
    begin
      if old.draft_ref is distinct from new.draft_ref
         or old.source_webhook_event_id is distinct from new.source_webhook_event_id
         or old.conversation_id is distinct from new.conversation_id
         or old.decision_type is distinct from new.decision_type
         or old.language is distinct from new.language
         or old.knowledge_version_id is distinct from new.knowledge_version_id
         or old.retention_deadline is distinct from new.retention_deadline
         or old.request_key is distinct from new.request_key
         or old.created_at is distinct from new.created_at
         or (old.state = 'erased' and new.state is distinct from old.state)
         or (old.state = 'ready' and new.state not in ('ready', 'erased'))
         or (old.state = 'erased' and new.answer_text is not null)
         or (old.erased_at is not null and new.erased_at is distinct from old.erased_at) then
        raise exception using errcode = '23514', message = 'Reply draft is immutable except erasure';
      end if;
      return new;
    end;
    $$;

    create trigger support_reply_drafts_erasure_only
      before update or delete on support_reply_drafts
      for each row execute function enforce_reply_draft_erasure();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from admin_accounts)
         or exists (select 1 from admin_audit_events)
         or exists (select 1 from knowledge_gap_observations)
         or exists (select 1 from customer_insight_runs)
         or exists (select 1 from owner_questions)
         or exists (select 1 from owner_question_digests)
         or exists (select 1 from support_reply_drafts)
         or exists (select 1 from support_escalation_outcomes) then
        raise exception using
          errcode = '55000',
          message = 'P4-002 rollback blocked: preserve admin, learning, draft, and escalation evidence before schema downgrade';
      end if;
    end;
    $$;

    drop trigger support_reply_drafts_erasure_only on support_reply_drafts;
    drop trigger customer_insight_entries_erasure_only on customer_insight_entries;
    drop trigger knowledge_gap_observations_erasure_only on knowledge_gap_observations;
    drop trigger support_reply_drafts_event_authority on support_reply_drafts;
    drop trigger knowledge_gap_observations_event_authority on knowledge_gap_observations;
    drop trigger owner_question_digest_entries_append_only on owner_question_digest_entries;
    drop trigger support_reply_draft_knowledge_append_only on support_reply_draft_knowledge;
    drop trigger owner_question_answers_append_only on owner_question_answers;
    drop trigger owner_question_insights_append_only on owner_question_insights;
    drop trigger knowledge_gap_candidates_append_only on knowledge_gap_candidates;
    drop trigger admin_audit_events_append_only on admin_audit_events;
    drop trigger admin_role_assignments_append_only on admin_role_assignments;
    drop function enforce_reply_draft_erasure();
    drop function enforce_insight_entry_erasure();
    drop function enforce_knowledge_gap_erasure();
    drop function enforce_phase4_customer_event_authority();
    drop function reject_phase4_append_only_mutation();
    drop table support_escalation_outcomes;
    drop table support_reply_draft_knowledge;
    drop table support_reply_drafts;
    drop table owner_question_digest_entries;
    drop table owner_question_digests;
    drop table owner_question_answers;
    drop table owner_question_insights;
    drop table owner_questions;
    drop table customer_insight_entries;
    drop table customer_insight_runs;
    drop table knowledge_gap_candidates;
    drop table knowledge_gap_observations;
    drop table admin_audit_events;
    drop table admin_sessions;
    drop table admin_mfa_credentials;
    drop table admin_role_assignments;
    drop table admin_accounts;
  `);
}
