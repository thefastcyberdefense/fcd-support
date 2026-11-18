# Private Media Extraction Implementation Plan (Track 2C)

## Scope

Implement Track 2C in isolated worktree `C:\Users\redwan\.codex\worktrees\track2c-private-media-extraction\fcd-support` on branch `codex/track2c-private-media-extraction` stacked on `codex/track2b-admin-controls`:

1. **Dependencies & schema (`migration 000019`):**
   - Pin `unpdf@2.2.1` in `package.json` and verify `npm audit --omit=dev --audit-level=high` + `phase6-image-contract.test.ts`.
   - Create `migrations/000019_create_private_media_extraction.ts` adding `webhook_event_attachments`, extending `support_escalation_outcomes_reason_code_check` with `unsupported_media`, `unclear_media`, `visual_media_deferred`, and `media_extraction_failed`, updating `admin_execute_deletion_erasure`, and refusing downgrade while `webhook_event_attachments` rows or Track 2C escalation rows exist.
   - Register `webhook_event_attachments` in `src/persistence/postgres-runtime-grants.ts`.
   - Update schema head assertions from `000018` (`18`) to `000019` (`19`).
2. **Webhook normalization & receipt persistence:**
   - Extend `NormalizedMediaAttachment` on `NormalizedCustomerMessage` (`src/meta/normalized-event.ts`).
   - Support WhatsApp (`image`, `document`, `audio`, `video`, `sticker`) in `src/meta/normalize-whatsapp.ts` and Messenger `message.attachments` (`image`, `audio`, `file`, `video`, `template`, `fallback`) + media-only echoes in `src/meta/normalize-messenger.ts`.
   - Persist normalized customer attachments in `PostgresReceiptStore.store` for `pending` events (`src/persistence/postgres-receipt-store.ts`).
3. **Private media modules (`src/media/*`):**
   - `media-types.ts`: shared typed contracts (`MediaExtractionOutcome`, `MediaFetcherPort`, `MediaExtractorPort`, attachment metadata & persisted outcomes).
   - `pdf-extractor.ts`: bounded in-process PDF text extraction using `unpdf`, checking `%PDF-` header, max size, max pages, and EN/BN Unicode normalization.
   - `private-service-client.ts`: bounded internal HTTP OCR (`PRIVATE_MEDIA_OCR_URL`) & STT (`PRIVATE_MEDIA_STT_URL`) adapters with confidence threshold, visual-only deferral detection, and fail-closed unconfigured behavior.
   - `media-fetcher.ts`: SSRF-safe bounded Meta Graph + CDN media downloader with SHA-256 verification.
   - `media-processor.ts`: orchestrates attachment download -> extraction -> immediate per-attachment `inspectSensitiveText` redaction -> combined sensitivity inspection and routing.
4. **Reply pipeline, deletion & retention wiring:**
   - Extend `ReplyDecisionService` (`src/replies/reply-decision-service.ts`), `reply-types.ts`, `postgres-reply-draft-store.ts`, `reply-state.ts`, `secret-files.ts`, `role-runtime.ts`, `reply-config.ts`, and `reply-runtime.ts`.
   - Extend `eraseLockedIdentities` (`src/persistence/postgres-deletion-erasure.ts`) and `PostgresRetentionJob` / `postgres-retention-policy.ts` to erase attachment identifiers and extracted text on deletion/retention expiry.
5. **Verification:**
   - Unit tests (`tests/media-extraction.test.ts`, `tests/meta/normalize-*.test.ts`, `tests/reply-decision-service.test.ts`).
   - Integration tests (`tests/integration/migrations.test.ts`, `tests/integration/postgres-runtime-grants.test.ts`, `tests/integration/postgres-media-flow.test.ts`).
   - Full Windows (`npm run check`, `verify-ui-ux-contract`, `verify-security-policy`, `npm audit`), WSL PostgreSQL 18 integration suites, and Linux Docker (`16 MiB /tmp` unit + restore + grants) verification before committing and opening Draft PR #28.
