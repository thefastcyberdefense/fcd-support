import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table webhook_receipts (
      id bigint generated always as identity primary key,
      payload_sha256 text not null,
      received_at timestamptz not null default now(),
      event_count integer not null,
      constraint webhook_receipts_payload_sha256_format
        check (payload_sha256 ~ '^[0-9a-f]{64}$'),
      constraint webhook_receipts_event_count_nonnegative
        check (event_count >= 0),
      constraint webhook_receipts_payload_sha256_unique
        unique (payload_sha256)
    );

    create table webhook_events (
      id bigint generated always as identity primary key,
      receipt_id bigint not null references webhook_receipts(id) on delete cascade,
      idempotency_key text not null,
      channel text not null,
      event_kind text not null,
      channel_account_id text,
      contact_id text,
      external_message_id text,
      occurred_at timestamptz,
      message_text text,
      message_status text,
      reason_code text,
      admission_outcome text not null,
      created_at timestamptz not null default now(),
      constraint webhook_events_idempotency_key_unique
        unique (idempotency_key),
      constraint webhook_events_channel_allowed
        check (channel in ('messenger', 'unknown', 'whatsapp')),
      constraint webhook_events_kind_allowed
        check (event_kind in ('business_message_echo', 'customer_message', 'message_status', 'unsupported')),
      constraint webhook_events_status_allowed
        check (message_status is null or message_status in ('delivered', 'failed', 'read', 'sent')),
      constraint webhook_events_outcome_allowed
        check (admission_outcome in ('pending', 'stale', 'unsupported'))
    );

    create index webhook_events_receipt_id_idx on webhook_events (receipt_id);
    create index webhook_events_pending_created_at_idx
      on webhook_events (created_at, id)
      where admission_outcome = 'pending';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table webhook_events;
    drop table webhook_receipts;
  `);
}
