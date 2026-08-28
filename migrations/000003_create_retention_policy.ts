import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table conversation_retention_states (
      conversation_id bigint primary key references conversations(id),
      lifecycle_class text not null check (
        lifecycle_class in ('active_client', 'casual_chat', 'unconverted_lead')
      ),
      anchor_at timestamptz,
      expires_at timestamptz,
      relationship_status text check (relationship_status in ('open', 'closed')),
      relationship_started_at timestamptz,
      relationship_ended_at timestamptz,
      final_paid_service_completed_at timestamptz,
      last_active_review_at timestamptz,
      next_active_review_at timestamptz,
      content_purged_through_at timestamptz,
      updated_at timestamptz not null default now(),
      row_version bigint not null default 1 check (row_version > 0),
      check (
        (anchor_at is null and expires_at is null)
        or (anchor_at is not null and expires_at is not null and expires_at > anchor_at)
      ),
      check (
        content_purged_through_at is null
        or anchor_at is null
        or content_purged_through_at <= anchor_at
      ),
      check (
        (
          lifecycle_class in ('casual_chat', 'unconverted_lead')
          and anchor_at is not null
          and expires_at is not null
          and relationship_status is null
          and relationship_started_at is null
          and relationship_ended_at is null
          and final_paid_service_completed_at is null
          and last_active_review_at is null
          and next_active_review_at is null
        )
        or (
          lifecycle_class = 'active_client'
          and relationship_status = 'open'
          and relationship_started_at is not null
          and relationship_ended_at is null
          and final_paid_service_completed_at is null
          and anchor_at is null
          and expires_at is null
          and last_active_review_at is not null
          and next_active_review_at is not null
          and next_active_review_at > last_active_review_at
        )
        or (
          lifecycle_class = 'active_client'
          and relationship_status = 'closed'
          and relationship_started_at is not null
          and (
            relationship_ended_at is not null
            or final_paid_service_completed_at is not null
          )
          and anchor_at is not null
          and anchor_at = greatest(
            coalesce(relationship_ended_at, '-infinity'::timestamptz),
            coalesce(final_paid_service_completed_at, '-infinity'::timestamptz)
          )
          and expires_at is not null
          and last_active_review_at is not null
          and next_active_review_at is null
        )
      )
    );

    create table retention_events (
      id bigint generated always as identity primary key,
      conversation_id bigint not null references conversations(id),
      decision_type text not null check (decision_type in (
        'qualifying_event',
        'classification_change',
        'relationship_review',
        'relationship_close',
        'reclassification'
      )),
      outcome text not null check (outcome in ('applied', 'ignored')),
      reason_code text not null check (reason_code in (
        'first_customer_message',
        'casual_activity',
        'lead_interaction',
        'human_reply',
        'out_of_order_ignored',
        'higher_precedence_preserved',
        'purged_boundary_preserved',
        'active_relationship_started',
        'active_relationship_reviewed',
        'active_relationship_closed',
        'history_reclassification'
      )),
      actor_type text not null check (actor_type in (
        'system', 'support_reviewer', 'policy_owner', 'retention_job'
      )),
      source_type text not null check (source_type in (
        'customer_message', 'business_message_echo', 'reviewer_command', 'retention_job'
      )),
      previous_class text check (
        previous_class is null
        or previous_class in ('active_client', 'casual_chat', 'unconverted_lead')
      ),
      resulting_class text not null check (
        resulting_class in ('active_client', 'casual_chat', 'unconverted_lead')
      ),
      effective_at timestamptz not null,
      resulting_anchor_at timestamptz,
      resulting_expires_at timestamptz,
      relationship_started_at timestamptz,
      relationship_ended_at timestamptz,
      final_paid_service_completed_at timestamptz,
      next_active_review_at timestamptz,
      source_webhook_event_id bigint
        references webhook_event_applications(webhook_event_id),
      reviewer_reference text,
      request_key text not null unique,
      created_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128),
      check (
        (resulting_anchor_at is null and resulting_expires_at is null)
        or (
          resulting_anchor_at is not null
          and resulting_expires_at is not null
          and resulting_expires_at > resulting_anchor_at
        )
      ),
      check (
        (actor_type in ('system', 'retention_job') and reviewer_reference is null)
        or (
          actor_type in ('support_reviewer', 'policy_owner')
          and reviewer_reference is not null
          and btrim(reviewer_reference) <> ''
          and char_length(reviewer_reference) <= 128
        )
      ),
      check (
        (
          source_type in ('customer_message', 'business_message_echo')
          and source_webhook_event_id is not null
        )
        or (
          source_type in ('reviewer_command', 'retention_job')
          and source_webhook_event_id is null
        )
      )
    );

    create table retention_job_runs (
      id bigint generated always as identity primary key,
      request_key text not null unique,
      evaluated_at timestamptz not null,
      requested_limit integer not null check (requested_limit between 1 and 100),
      status text not null check (status = 'applied'),
      conversations_processed integer not null check (
        conversations_processed >= 0 and conversations_processed <= requested_limit
      ),
      messages_purged integer not null check (messages_purged >= 0),
      completed_at timestamptz not null default now(),
      check (btrim(request_key) <> '' and char_length(request_key) <= 128)
    );

    create index conversation_retention_states_due_idx
      on conversation_retention_states (expires_at, conversation_id)
      where expires_at is not null;
    create index conversation_retention_states_review_due_idx
      on conversation_retention_states (next_active_review_at, conversation_id)
      where relationship_status = 'open';
    create index retention_events_conversation_effective_idx
      on retention_events (conversation_id, effective_at, id);
    create index retention_events_source_event_idx
      on retention_events (source_webhook_event_id)
      where source_webhook_event_id is not null;

    create function reject_retention_evidence_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using
        errcode = '23514',
        message = 'retention evidence is append-only';
      return null;
    end;
    $$;

    create trigger retention_events_append_only
      before update or delete on retention_events
      for each row execute function reject_retention_evidence_mutation();
    create trigger retention_job_runs_append_only
      before update or delete on retention_job_runs
      for each row execute function reject_retention_evidence_mutation();

    create function enforce_retention_application_stability()
    returns trigger
    language plpgsql
    as $$
    begin
      if exists (
        select 1
        from retention_events
        where source_webhook_event_id = old.webhook_event_id
      ) then
        if tg_op = 'DELETE' then
          raise exception using
            errcode = '23514',
            message = 'retention source application is immutable';
        end if;
        if new.conversation_id is distinct from old.conversation_id
           or new.outcome is distinct from old.outcome then
          raise exception using
            errcode = '23514',
            message = 'retention source application is immutable';
        end if;
      end if;

      return case when tg_op = 'DELETE' then old else new end;
    end;
    $$;

    create trigger webhook_event_applications_retention_stability
      before update or delete on webhook_event_applications
      for each row execute function enforce_retention_application_stability();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger webhook_event_applications_retention_stability
      on webhook_event_applications;
    drop function enforce_retention_application_stability();
    drop table retention_job_runs;
    drop table retention_events;
    drop table conversation_retention_states;
    drop function reject_retention_evidence_mutation();
  `);
}
