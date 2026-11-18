# Private Media Extraction & Pre-Inference Redaction Design (Track 2C)

## Goal

Add private attachment intake, extraction, pre-inference sensitivity redaction, and safe human-escalation routing for inbound customer attachments across WhatsApp Cloud API and Meta Messenger webhooks without calling external vision/audio models or breaking any existing privacy, retention, or least-privilege boundaries.

## Requirements & Boundaries

1. **Supported extraction paths:**
   - **PDF documents (`application/pdf` / `.pdf` / `%PDF-`):** In-process pure-JS/WASM extraction via pinned `unpdf` with bounded size (`<= 10 MiB`), page cap (`<= 20`), and English/Bangla Unicode NFKC normalization. Zero `apt`/`apt-get` system packages in release Dockerfiles.
   - **Images (`image/*`):** Private English/Bangla OCR HTTP endpoint (`PRIVATE_MEDIA_OCR_URL`) when configured. Images containing readable EN/BN text without requiring visual pixel interpretation are extracted and normalized; visual-only images (photos/diagrams/stickers or `hasVisualContent === true`) and unconfigured/low-confidence OCR route to human handling (`full visual interpretation is deferred`).
   - **Audio / voice notes (`audio/*`):** Private English/Bangla Speech-to-Text HTTP endpoint (`PRIVATE_MEDIA_STT_URL`) when configured. Low-confidence, empty, or unconfigured transcriptions route to human handling.
   - **Unsupported attachments:** `video`, `sticker`, non-PDF documents, and unknown/fallback attachment types enter the customer conversation and deterministically route to human handling (`unsupported_media`) with a bilingual escalation response (`safeResponse(language, 'human_escalation')`). Non-message webhook protocol items (`contacts`, `reaction`, `read`) remain `admission_outcome = 'unsupported'`.
2. **Pre-storage and pre-inference redaction:**
   - Every extracted attachment text is inspected through `inspectSensitiveText` _before_ persisting `extracted_text` into PostgreSQL and _before_ FAQ matching or external model inference.
   - Ambiguous, unredactable, multiple-secret, or always-blocked sensitive extractions (`sensitive_data_blocked` / `unsafe_redaction`) never persist extracted plaintext (`extracted_text = null`), never invoke external inference (`0` `model_call_leases`), and create a `support_escalation_outcomes` record plus deterministic sensitive-data response.
   - Redactable single-secret questions persist only `inspection.sanitizedText` (`[REDACTED_*]`) so raw secret values never enter `webhook_event_attachments`, `knowledge_gap_observations`, or Manifest/OpenAI-compatible payloads.
3. **Zero external model execution for unprocessable media:**
   - `ReplyDecisionService` resolves attachments during the `decide` stage. Any attachment ending in `unsupported`, `unclear`, `visual_only`, `sensitive_blocked`, or `failed` transitions directly to `safe_failure` + `support_escalation_outcomes` + outbound intent (or human escalation) and never advances to the `model` stage.
   - `PostgresReplyDraftStore.claimModelDecision` independently verifies no pending/failed/unsupported/unclear/visual/sensitive attachment exists on `webhook_event_attachments` before permitting `model_required` inference.
4. **Privilege, SSRF, deletion, and retention safety:**
   - Meta Graph media downloads enforce HTTPS, host allowlisting + DNS public-IP checks (except explicit test transports), disabled redirects (`redirect: 'error'`), bounded streaming sizes, and optional SHA-256 verification.
   - Private OCR/STT endpoints validate explicit `http:`/`https:` URLs without embedded credentials and exclude link-local metadata IPs (`169.254.169.254`).
   - `webhook_event_attachments` belongs to `groups.events`: `webhook` gets `select,insert`, `reply` gets `select,insert,update`, `maintenance` gets `select,update,delete`, `backup` gets `select`, and `admin` / `health` stay denied (`42501`).
   - Deletion erasure (`eraseLockedIdentities` and `admin_execute_deletion_erasure`) and retention purge clear `media_id`, `media_url`, `filename`, `caption`, and `extracted_text`, setting `extraction_status = 'erased'`.
