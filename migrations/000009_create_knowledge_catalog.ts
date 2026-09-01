import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create extension if not exists pg_trgm with schema public;

    create table knowledge_sources (
      id bigint generated always as identity primary key,
      source_ref text not null unique check (
        source_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      source_type text not null check (source_type in (
        'manual_business', 'website', 'policy', 'support_gap'
      )),
      label text not null check (
        btrim(label) <> '' and char_length(label) <= 200
      ),
      approved_url text check (
        approved_url is null
        or (approved_url ~ '^https://[^[:space:]]+$' and char_length(approved_url) <= 2048)
      ),
      active boolean not null default true,
      created_by_reference text not null check (
        btrim(created_by_reference) <> ''
        and char_length(created_by_reference) <= 128
      ),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      check (
        (source_type = 'website' and approved_url is not null)
        or (source_type <> 'website' and approved_url is null)
      ),
      check (updated_at >= created_at)
    );

    create table knowledge_source_snapshots (
      id bigint generated always as identity primary key,
      snapshot_ref text not null unique check (
        snapshot_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      source_id bigint not null references knowledge_sources(id),
      fetch_outcome text not null check (fetch_outcome in (
        'retrieved', 'not_modified', 'failed'
      )),
      fetched_at timestamptz not null,
      source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
      content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
      proposed_public_content text check (
        proposed_public_content is null
        or (btrim(proposed_public_content) <> ''
          and char_length(proposed_public_content) <= 12000)
      ),
      created_by_reference text not null check (
        btrim(created_by_reference) <> ''
        and char_length(created_by_reference) <= 128
      ),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null default now(),
      check (
        (fetch_outcome = 'retrieved'
          and source_sha256 is not null
          and content_sha256 is not null
          and proposed_public_content is not null)
        or (fetch_outcome = 'not_modified'
          and source_sha256 is not null
          and content_sha256 is null
          and proposed_public_content is null)
        or (fetch_outcome = 'failed'
          and source_sha256 is null
          and content_sha256 is null
          and proposed_public_content is null)
      )
    );

    create index knowledge_source_snapshots_source_time_idx
      on knowledge_source_snapshots (source_id, fetched_at desc, id desc);

    create table knowledge_items (
      id bigint generated always as identity primary key,
      item_key text not null unique check (
        item_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      ),
      kind text not null check (kind in (
        'faq', 'business_fact', 'safety_response', 'escalation_response'
      )),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      check (updated_at >= created_at)
    );

    create table knowledge_versions (
      id bigint generated always as identity primary key,
      version_ref text not null unique check (
        version_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
      item_id bigint not null references knowledge_items(id),
      version_number integer not null check (version_number > 0),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      state text not null check (state in (
        'draft', 'submitted', 'approved', 'rejected'
      )),
      question_en text check (
        question_en is null
        or (btrim(question_en) <> '' and char_length(question_en) <= 1000)
      ),
      answer_en text check (
        answer_en is null
        or (btrim(answer_en) <> '' and char_length(answer_en) <= 4000)
      ),
      question_bn text check (
        question_bn is null
        or (btrim(question_bn) <> '' and char_length(question_bn) <= 1000)
      ),
      answer_bn text check (
        answer_bn is null
        or (btrim(answer_bn) <> '' and char_length(answer_bn) <= 4000)
      ),
      applicability text check (
        applicability is null
        or (btrim(applicability) <> '' and char_length(applicability) <= 1000)
      ),
      source_id bigint not null references knowledge_sources(id),
      source_snapshot_id bigint references knowledge_source_snapshots(id),
      source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
      content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
      author_reference text not null check (
        btrim(author_reference) <> '' and char_length(author_reference) <= 128
      ),
      replaces_version_id bigint references knowledge_versions(id),
      rollback_from_version_id bigint references knowledge_versions(id),
      created_at timestamptz not null,
      submitted_at timestamptz,
      decided_at timestamptz,
      unique (item_id, version_number),
      check (replaces_version_id is null or replaces_version_id <> id),
      check (rollback_from_version_id is null or rollback_from_version_id <> id),
      check (
        (state = 'draft' and submitted_at is null and decided_at is null)
        or (state = 'submitted' and submitted_at is not null and decided_at is null)
        or (state in ('approved', 'rejected')
          and submitted_at is not null
          and decided_at is not null
          and decided_at >= submitted_at)
      )
    );

    create index knowledge_versions_item_state_idx
      on knowledge_versions (item_id, state, version_number desc);

    create table knowledge_aliases (
      id bigint generated always as identity primary key,
      version_id bigint not null references knowledge_versions(id),
      language text not null check (language in ('en', 'bn')),
      alias_kind text not null check (alias_kind in (
        'question', 'alias', 'intent', 'example'
      )),
      phrase text not null check (
        btrim(phrase) <> '' and char_length(phrase) <= 1000
      ),
      normalized_phrase text not null check (
        btrim(normalized_phrase) <> ''
        and char_length(normalized_phrase) <= 1000
      ),
      created_at timestamptz not null default now(),
      unique (version_id, language, alias_kind, normalized_phrase)
    );

    create index knowledge_aliases_normalized_exact_idx
      on knowledge_aliases (language, normalized_phrase, version_id);
    create index knowledge_aliases_normalized_trgm_idx
      on knowledge_aliases
      using gin (normalized_phrase public.gin_trgm_ops);

    create table knowledge_tags (
      id bigint generated always as identity primary key,
      version_id bigint not null references knowledge_versions(id),
      tag text not null check (tag ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      unique (version_id, tag)
    );

    create table knowledge_review_events (
      id bigint generated always as identity primary key,
      version_id bigint not null references knowledge_versions(id),
      action text not null check (action in ('submit', 'approve', 'reject')),
      reviewer_reference text not null check (
        btrim(reviewer_reference) <> ''
        and char_length(reviewer_reference) <= 128
      ),
      reason_code text not null check (
        reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      effective_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create index knowledge_review_events_version_time_idx
      on knowledge_review_events (version_id, effective_at, id);

    create table knowledge_publication_events (
      id bigint generated always as identity primary key,
      item_id bigint not null references knowledge_items(id),
      version_id bigint not null references knowledge_versions(id),
      action text not null check (action in ('publish', 'retire', 'rollback')),
      prior_version_id bigint references knowledge_versions(id),
      reviewer_reference text not null check (
        btrim(reviewer_reference) <> ''
        and char_length(reviewer_reference) <= 128
      ),
      reason_code text not null check (
        reason_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      ),
      effective_at timestamptz not null,
      request_key text not null unique check (
        btrim(request_key) <> '' and char_length(request_key) <= 128
      ),
      created_at timestamptz not null default now(),
      check (
        (action = 'publish' and prior_version_id is null)
        or (action in ('retire', 'rollback') and prior_version_id is not null)
      ),
      check (prior_version_id is null or prior_version_id <> version_id)
    );

    create index knowledge_publication_events_item_effective_idx
      on knowledge_publication_events (item_id, effective_at, id);

    create function enforce_knowledge_version_shape()
    returns trigger
    language plpgsql
    as $$
    declare
      item_kind text;
      snapshot_source_id bigint;
    begin
      select kind into item_kind
      from knowledge_items
      where id = new.item_id;

      if item_kind = 'faq' and (
        new.question_en is null or new.answer_en is null
        or new.question_bn is null or new.answer_bn is null
      ) then
        raise exception using errcode = '23514', message = 'FAQ versions require bilingual questions and answers';
      end if;

      if item_kind in ('business_fact', 'safety_response', 'escalation_response')
         and (new.answer_en is null or new.answer_bn is null) then
        raise exception using errcode = '23514', message = 'Customer-facing knowledge requires bilingual answers';
      end if;

      if new.source_snapshot_id is not null then
        select source_id into snapshot_source_id
        from knowledge_source_snapshots
        where id = new.source_snapshot_id;
        if snapshot_source_id is distinct from new.source_id then
          raise exception using errcode = '23514', message = 'Knowledge snapshot source mismatch';
        end if;
      end if;

      if new.replaces_version_id is not null and not exists (
        select 1 from knowledge_versions
        where id = new.replaces_version_id and item_id = new.item_id
      ) then
        raise exception using errcode = '23514', message = 'Replacement version belongs to another item';
      end if;

      if new.rollback_from_version_id is not null and not exists (
        select 1 from knowledge_versions
        where id = new.rollback_from_version_id and item_id = new.item_id
      ) then
        raise exception using errcode = '23514', message = 'Rollback version belongs to another item';
      end if;

      return new;
    end;
    $$;

    create trigger knowledge_versions_shape
      before insert or update on knowledge_versions
      for each row execute function enforce_knowledge_version_shape();

    create function enforce_knowledge_version_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        if old.state <> 'draft' then
          raise exception using errcode = '23514', message = 'Submitted knowledge history is immutable';
        end if;
        return old;
      end if;

      if old.item_id is distinct from new.item_id
         or old.version_ref is distinct from new.version_ref
         or old.version_number is distinct from new.version_number
         or old.request_key is distinct from new.request_key
         or old.source_id is distinct from new.source_id
         or old.source_snapshot_id is distinct from new.source_snapshot_id
         or old.source_sha256 is distinct from new.source_sha256
         or old.content_sha256 is distinct from new.content_sha256
         or old.author_reference is distinct from new.author_reference
         or old.replaces_version_id is distinct from new.replaces_version_id
         or old.rollback_from_version_id is distinct from new.rollback_from_version_id
         or old.created_at is distinct from new.created_at then
        raise exception using errcode = '23514', message = 'Knowledge version identity and provenance are immutable';
      end if;

      if old.state <> 'draft' and (
        old.question_en is distinct from new.question_en
        or old.answer_en is distinct from new.answer_en
        or old.question_bn is distinct from new.question_bn
        or old.answer_bn is distinct from new.answer_bn
        or old.applicability is distinct from new.applicability
      ) then
        raise exception using errcode = '23514', message = 'Submitted knowledge content is immutable';
      end if;

      if old.state is distinct from new.state and pg_trigger_depth() < 2 then
        raise exception using errcode = '23514', message = 'Knowledge state changes require a review event';
      end if;

      return new;
    end;
    $$;

    create trigger knowledge_versions_mutation
      before update or delete on knowledge_versions
      for each row execute function enforce_knowledge_version_mutation();

    create function enforce_knowledge_child_mutation()
    returns trigger
    language plpgsql
    as $$
    declare
      parent_version_id bigint;
      parent_state text;
    begin
      parent_version_id := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
      select state into parent_state from knowledge_versions where id = parent_version_id;
      if parent_state <> 'draft' then
        raise exception using errcode = '23514', message = 'Submitted knowledge children are immutable';
      end if;
      return case when tg_op = 'DELETE' then old else new end;
    end;
    $$;

    create trigger knowledge_aliases_mutation
      before insert or update or delete on knowledge_aliases
      for each row execute function enforce_knowledge_child_mutation();
    create trigger knowledge_tags_mutation
      before insert or update or delete on knowledge_tags
      for each row execute function enforce_knowledge_child_mutation();

    create function apply_knowledge_review_event()
    returns trigger
    language plpgsql
    as $$
    declare
      current_state text;
    begin
      select state into current_state
      from knowledge_versions
      where id = new.version_id
      for update;

      if new.action = 'submit' and current_state = 'draft' then
        update knowledge_versions
        set state = 'submitted', submitted_at = new.effective_at
        where id = new.version_id;
      elsif new.action = 'approve' and current_state = 'submitted' then
        update knowledge_versions
        set state = 'approved', decided_at = new.effective_at
        where id = new.version_id;
      elsif new.action = 'reject' and current_state = 'submitted' then
        update knowledge_versions
        set state = 'rejected', decided_at = new.effective_at
        where id = new.version_id;
      else
        raise exception using errcode = '23514', message = 'Invalid knowledge review transition';
      end if;

      return new;
    end;
    $$;

    create trigger knowledge_review_events_apply
      before insert on knowledge_review_events
      for each row execute function apply_knowledge_review_event();

    create function enforce_knowledge_publication_event()
    returns trigger
    language plpgsql
    as $$
    declare
      version_item_id bigint;
      version_state text;
      prior_item_id bigint;
    begin
      perform pg_advisory_xact_lock(new.item_id);
      select item_id, state into version_item_id, version_state
      from knowledge_versions
      where id = new.version_id;

      if version_item_id is distinct from new.item_id or version_state <> 'approved' then
        raise exception using errcode = '23514', message = 'Publication requires an approved version of the same item';
      end if;

      if new.prior_version_id is not null then
        select item_id into prior_item_id
        from knowledge_versions
        where id = new.prior_version_id;
        if prior_item_id is distinct from new.item_id then
          raise exception using errcode = '23514', message = 'Prior publication version belongs to another item';
        end if;
      end if;

      return new;
    end;
    $$;

    create trigger knowledge_publication_events_validate
      before insert on knowledge_publication_events
      for each row execute function enforce_knowledge_publication_event();

    create function reject_knowledge_history_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using errcode = '23514', message = 'Knowledge history is append-only';
      return null;
    end;
    $$;

    create trigger knowledge_review_events_append_only
      before update or delete on knowledge_review_events
      for each row execute function reject_knowledge_history_mutation();
    create trigger knowledge_publication_events_append_only
      before update or delete on knowledge_publication_events
      for each row execute function reject_knowledge_history_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from knowledge_sources)
         or exists (select 1 from knowledge_items)
         or exists (select 1 from knowledge_review_events)
         or exists (select 1 from knowledge_publication_events) then
        raise exception using
          errcode = '55000',
          message = 'P4-002 rollback blocked: preserve reviewed knowledge evidence before schema downgrade';
      end if;
    end;
    $$;

    drop trigger knowledge_publication_events_append_only on knowledge_publication_events;
    drop trigger knowledge_review_events_append_only on knowledge_review_events;
    drop trigger knowledge_publication_events_validate on knowledge_publication_events;
    drop trigger knowledge_review_events_apply on knowledge_review_events;
    drop trigger knowledge_tags_mutation on knowledge_tags;
    drop trigger knowledge_aliases_mutation on knowledge_aliases;
    drop trigger knowledge_versions_mutation on knowledge_versions;
    drop trigger knowledge_versions_shape on knowledge_versions;
    drop function reject_knowledge_history_mutation();
    drop function enforce_knowledge_publication_event();
    drop function apply_knowledge_review_event();
    drop function enforce_knowledge_child_mutation();
    drop function enforce_knowledge_version_mutation();
    drop function enforce_knowledge_version_shape();
    drop table knowledge_publication_events;
    drop table knowledge_review_events;
    drop table knowledge_tags;
    drop table knowledge_aliases;
    drop table knowledge_versions;
    drop table knowledge_items;
    drop table knowledge_source_snapshots;
    drop table knowledge_sources;
  `);
}
