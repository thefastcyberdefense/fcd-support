import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table webhook_event_attachments (
      id bigint generated always as identity primary key,
      webhook_event_id bigint not null references webhook_events(id) on delete cascade,
      attachment_index integer not null,
      attachment_kind text not null,
      raw_type text not null,
      media_id text,
      media_url text,
      mime_type text,
      filename text,
      caption text,
      sha256 text,
      is_voice boolean,
      extraction_status text not null default 'pending',
      extracted_text text,
      extraction_method text,
      detected_language text,
      reason_code text,
      erased_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint webhook_event_attachments_index_range
        check (attachment_index >= 0 and attachment_index < 20),
      constraint webhook_event_attachments_kind_allowed
        check (attachment_kind in ('audio', 'document', 'image', 'unsupported')),
      constraint webhook_event_attachments_status_allowed
        check (extraction_status in (
          'pending', 'extracted', 'unclear', 'unsupported',
          'sensitive_blocked', 'visual_only', 'failed', 'erased'
        )),
      constraint webhook_event_attachments_method_allowed
        check (extraction_method is null or extraction_method in ('pdf_text', 'ocr', 'stt')),
      constraint webhook_event_attachments_language_allowed
        check (detected_language is null or detected_language in ('en', 'bn')),
      constraint webhook_event_attachments_event_index_unique
        unique (webhook_event_id, attachment_index)
    );

    create index webhook_event_attachments_event_idx
      on webhook_event_attachments (webhook_event_id, attachment_index);

    create function erase_webhook_event_attachments_on_purge()
    returns trigger
    language plpgsql
    as $$
    begin
      if (new.idempotency_key like 'privacy:%' and new.idempotency_key is distinct from old.idempotency_key)
         or (old.message_text is not null and new.message_text is null) then
        update webhook_event_attachments
        set media_id = null,
            media_url = null,
            filename = null,
            caption = null,
            sha256 = null,
            extracted_text = null,
            extraction_status = 'erased',
            erased_at = coalesce(erased_at, now()),
            updated_at = now()
        where webhook_event_id = new.id
          and extraction_status <> 'erased';
      end if;
      return new;
    end;
    $$;

    create trigger webhook_events_erase_attachments_trg
      after update of idempotency_key, message_text on webhook_events
      for each row
      execute function erase_webhook_event_attachments_on_purge();

    alter table support_escalation_outcomes
      drop constraint support_escalation_outcomes_reason_code_check;
    alter table support_escalation_outcomes
      add constraint support_escalation_outcomes_reason_code_check check (reason_code in (
        'sensitive_data_blocked', 'unsafe_redaction', 'faq_ambiguous',
        'model_disabled', 'rate_limited', 'global_limit', 'queue_full',
        'timeout', 'network_failure', 'provider_failure', 'provider_exhausted',
        'invalid_response', 'unsupported_claim', 'wrong_language',
        'policy_blocked', 'database_failure', 'budget_exceeded',
        'unsupported_media', 'unclear_media', 'visual_media_deferred',
        'media_extraction_failed'
      ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from webhook_event_attachments)
         or exists (
           select 1 from support_escalation_outcomes
           where reason_code in (
             'unsupported_media', 'unclear_media',
             'visual_media_deferred', 'media_extraction_failed'
           )
         ) then
        raise exception using
          errcode = '55000',
          message = 'Track 2C rollback blocked: preserve webhook_event_attachments and media escalation evidence before schema downgrade';
      end if;
    end;
    $$;

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

    drop trigger webhook_events_erase_attachments_trg on webhook_events;
    drop function erase_webhook_event_attachments_on_purge();
    drop table webhook_event_attachments;
  `);
}
