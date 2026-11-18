# Track 2B Design: Private Admin Operator Controls, Website Draft Importer, Workflow Completion & UI/UX Contract

**Date:** 2026-11-17  
**Branch / Target PR:** `codex/track2b-admin-controls` (stacked on `codex/track2a-gateway-policy`, Draft PR #26)  
**Scope Authority:** Track 2B (following Track 2A gateway-policy extension and ahead of Track 2C media extraction and Track 2D operator CLI tooling).

## 1. Purpose and Boundaries

This specification designs the remaining private operator controls inside `fcd-support-admin` (the Unix-socket-bound private dashboard behind `admin-app.ts`), while preserving every security invariant of `fcd-support`:

1. **Private Operator Controls Required in Track 2B:**
   - **Staff Accounts (`/accounts`, `administrator` only):** Create individual operator accounts (`accountRef`, `loginName`, initial passphrase, role selection across `knowledge_editor`, `knowledge_reviewer`, `support_reviewer`, `administrator`), issue a fresh CSPRNG 20-byte TOTP secret with one-time display (`base32` + `otpauth://` URI — never persisted in plaintext or logged), assign/revoke roles, revoke active sessions, and disable accounts while blocking last-administrator self-lockout/removal.
   - **Human Takeover Pause / Resume (`/pause`, `support_reviewer` or `administrator`):** View metadata-only conversation pause status (no message transcripts, no inbox composer), manually apply an audited 24-hour human pause for a conversation, and perform audited `resume` with database-enforced precedence across both `business_echo` and `reviewer` pauses.
   - **Privacy, Deletion, Access & Correction Review (`/privacy`, `support_reviewer`):** View bounded privacy requests (`deletion`, `access`, `correction`) and their location statuses (`primary_postgres`, `manifest_recordings`, `meta_provider`, `pending_outbound`, `operator_exports`, `offline_archives`, `backup_tombstone_gate`), approve or reject `deletion` / `access` / `correction` requests, confirm and execute `deletion` local erasure & suppression tombstones (when `PRIVACY_HMAC_KEYRING` is configured), collect redacted `access` export bundles (`inspectSensitiveText` + SHA-256 digest stored on `privacy_access_runs`), execute safe reviewed `correction` updates (`preferred_language` `en | bn` on `contacts` or closed `manual_required` / `rejected` outcomes), and attest external locations to drive terminal `completed` / `partially_completed` convergence.
   - **Consent, Re-opt-in & Outbound Policy / Fixed Templates (`/consent`, `support_reviewer` for consent/re-opt-in; `administrator` for outbound policy & fixed WhatsApp templates):** Record reviewed category consent (`grant` / `revoke`) and explicit selective marketing re-opt-in (clearing marketing suppressions while strictly preserving `deletion_tombstone` blocks), plus full lifecycle forms for `outbound_policy_versions` and `outbound_template_versions` (`create`, `submit`, `approve`, `activate`, `retire`).
   - **Official Website Draft-Only Importer (`/knowledge/import`, `knowledge_editor`):** SSRF-safe bounded HTTPS fetch of an official URL (or explicit pasted official text), persist `knowledge_sources` (`sourceType: 'website'`) and `knowledge_source_snapshots` (`fetchOutcome: 'retrieved'`) without fabricating translations or business facts, extract candidate bilingual QA/facts when present (or pre-fill captured snapshot text for bilingual completion), and insert proposals strictly in `state = 'draft'` (`knowledge_versions`) requiring owner/reviewer submit -> approve -> publish.
   - **Workflow Completion (`/knowledge`, `/questions`, `/insights`, `/policy`, `/escalations`, `/audit`, `/operations`):**
     - `/knowledge/:versionRef`: add replacement draft creation (`createReplacementProposal`), aliases/tags editor support, and clearer approved/draft/submitted/rejected status transitions.
     - `/questions`: add explicit `dismiss` (`POST /questions/:questionRef/dismiss`) alongside `answer` (`POST /questions/:questionRef/answer`).
     - `/insights`: add explicit real-data aggregation run (`POST /insights/aggregate`) and question digest generation (`POST /insights/digest`) derived strictly from non-expired, privacy-eligible `knowledge_gap_observations` — never fabricated metrics.
   - **UI/UX Source Contract (`scripts/verify-ui-ux-contract.ts`, `AGY_STRICT_UI_GATE=true`):**
     - `UI-A11Y-001`: Skip link (`skip-link`) targeting `#main-content` across rendered pages.
     - `UI-TOUCH-002`: Minimum `44px` interactive control height (`.button`, `.field input`, select/textarea).
     - `UI-THEME-003`: Complete `@media (prefers-color-scheme: dark)` CSS tokens.
     - `UI-RESP-004`: Responsive table cards with `data-label="..."` on every `<td>` in both `src/admin/admin-html.ts` and `src/admin/operations-html.ts`.
     - `UI-A11Y-005`: Login, MFA, and safe error banners rendered with `role="alert"`.

2. **Explicitly Deferred Out of Scope:**
   - Custom unified customer conversation inbox or reply composer (staff reply natively inside WhatsApp Business / Meta Business Suite).
   - Public Support & Trust Center (`US-105`), marketing campaigns UI, CRM automation, direct external notification adapters (`US-106`), or full visual interpretation.

## 2. Database Least-Privilege & Migration `000018` Design

To preserve all negative privilege assertions in `tests/integration/postgres-admin-dashboard-grants.test.ts` (forbidding `${prefix}_admin` from raw `SELECT *` or direct `INSERT/UPDATE/DELETE` on `webhook_receipts`, `webhook_events`, `support_escalation_outcomes`, `privacy_requests`, `channel_identities`, and `conversations`), Track 2B introduces metadata-only views (`knownViews` in `src/persistence/postgres-runtime-grants.ts`) and closed-body `SECURITY DEFINER` PostgreSQL functions owned by `${prefix}_migrator` (`set search_path = pg_catalog, <schema>, pg_temp`) with `EXECUTE` granted exclusively to `${prefix}_admin`:

1. **Migration `migrations/000018_create_private_admin_controls.ts`:**
   - Extend `admin_audit_events_action_check` and `admin_audit_events_object_type_check` for account disable, pause/resume, privacy review/erasure/export/correction/attestation, consent/re-opt-in, outbound policy/template, website import, question dismissal, and insights/digest actions.
   - Update `human_pause_events` constraint and `enforce_human_pause_authority()` trigger to allow `actor_kind = 'reviewer'` on `action = 'pause'` (`source_webhook_event_id is null`, `resulting_pause_until = effective_at + interval '24 hours'`, non-empty `reviewer_reference` and `reviewer_request_key`), while keeping `business_echo` pause validation intact.
   - Add `contacts.preferred_language text check (preferred_language is null or preferred_language in ('en', 'bn'))`.
   - Add `privacy_access_runs.bundle_sha256 text check (bundle_sha256 is null or bundle_sha256 ~ '^[0-9a-f]{64}$')`.
   - Create metadata-only views: `admin_pause_states_v`, `admin_privacy_requests_v`, `admin_privacy_locations_v`, `admin_consent_identities_v`.
   - Create closed-body `SECURITY DEFINER` routines:
     - `admin_pause_conversation(...)` and `admin_resume_conversation(...)`
     - `admin_review_deletion_request(...)`, `admin_load_deletion_target_identities(...)`, `admin_execute_deletion_erasure(...)`
     - `admin_review_privacy_request(...)`, `admin_attest_privacy_location(...)`
     - `admin_load_approved_access_export_rows(...)`, `admin_record_privacy_access_run(...)`
     - `admin_execute_correction(...)`
     - `admin_record_consent_event(...)`, `admin_record_marketing_reopt_in(...)`

2. **Optional `PRIVACY_HMAC_KEYRING` Secret Wiring for `admin`:**
   - Add `'PRIVACY_HMAC_KEYRING'` as an optional secret for `'admin'` in `src/operations/secret-files.ts` and `src/operations/compose-contract.ts`, plus `AdminConfig.privacyKeyring` in `src/admin/admin-config.ts` and `AdminRuntime`.
   - Keep `infra/compose.runtime.yml`'s required `fcd-support-admin` secrets intact so existing Compose contracts stay valid; when `PRIVACY_HMAC_KEYRING` is unset, read/review/UI workflows continue cleanly while HMAC-dependent execution (`Execute Deletion`, `Record Consent`, `Re-opt-in`) fails closed with a safe `400` configuration notice.

## 3. Website Draft-Only Importer Design (`src/knowledge/website-import.ts`)

- Validate `url` strictly as `https://` without userinfo, port smuggling (or non-default unsafe ports), loopback, link-local (`169.254.*`), RFC1918, ULA (`fc00::/7`), `0.0.0.0`, `localhost`, or single-label hostnames (`resolveAndValidatePublicHost` reusing `isPublicHttpsUrl` checks, skipping external DNS lookup when custom `websiteFetch` test double is injected cleanly or validating literal IPs directly).
- Reject redirects cleanly (`redirect: 'error'`), enforce strict timeout (`10_000 ms`) and response byte ceiling (`512 KiB`), strip `<script>`/`<style>`/tags cleanly into normalized plain text.
- Extract bilingual QA pairs ONLY if explicitly present in paired EN/BN sections without synthesizing or translating text; otherwise surface captured clean excerpt in `knowledge_source_snapshots` and allow an editor to populate/verify EN + BN fields manually into a `'draft'` proposal linked via `sourceSnapshotRef`.

## 4. Verification Plan

- Strictly follow `test-driven-development`: add failing unit & PostgreSQL integration tests before implementing each module.
- Verify on Windows (`npm run check`, `AGY_STRICT_UI_GATE=true node scripts/verify-ui-ux-contract.ts`, `node scripts/verify-security-policy.ts`, `npm audit --omit=dev --audit-level=high`), WSL PostgreSQL 18 integration tests (including untouched `postgres-admin-dashboard-grants.test.ts` + new `postgres-admin-controls.test.ts`), and Linux `16 MiB /tmp` (`bash scripts/test-encrypted-backup.sh unit`).
