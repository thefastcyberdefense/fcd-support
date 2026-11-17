# Gateway-Policy Extension Design (Track 2A)

## Purpose

Extend the Phase 4 model-policy and runtime gateway boundary so administrators can manage protected OpenAI-compatible gateway profiles (endpoint base URL, model identifier, encrypted API key, connection testing, explicit activation, and monetary spending budget) in PostgreSQL and the private admin dashboard while preserving the dedicated Manifest Harness `fcd-support` with `model: "auto"` as the unconfigured and default path.

This document records the gateway-policy extension design before implementation.

## Core Invariants Preserved

1. **Default Gateway**: When no custom gateway profile has been explicitly activated (or after an active custom profile is retired back to default), all model-reply calls continue through the dedicated Manifest Harness (`MANIFEST_BASE_URL`, `MANIFEST_API_KEY`, `model: "auto"`).
2. **Deterministic FAQ Precedence**: Approved bilingual FAQ and business-fact matching in `ReplyDecisionService` executes before any model lease or gateway dispatch.
3. **No Tools & Strict Redaction**: Requests to Manifest and any active OpenAI-compatible endpoint never include `tools`, `tool_calls`, `functions`, or `function_call`, and responses carrying `tool_calls` or `function_call` are rejected. Every customer prompt and supplied knowledge fact still passes `inspectSensitiveText` and `prepareManifestText` before request construction.
4. **Structured Output Validation**: All model responses—whether from `manifest_default` or an `openai_compatible` profile—pass `parseManifestOutput` (strict envelope JSON schema, script/language lock, approved HTTPS URL whitelist, reference/claim verification, byte limit).
5. **Operational Safety Limits Always Enforced**: Setting `budget_micro_usd = 0` means unlimited monetary spend only; per-contact rolling windows (15-minute and 24-hour), global UTC-day call cap, concurrent active leases, queue capacity, per-contact cooldown, total timeout, output token cap, context item limit, input code-point cap, and response byte cap remain strictly enforced against the intersection of active `model_policy_versions`, deployment ceilings, and `manifestAttestation`.

## Data Model (`migrations/000017_create_model_gateway_config.ts`)

1. **`model_gateway_profiles`** (immutable profile revisions):
   - `gateway_ref`, strictly monotonic `version_number`, unique idempotent `request_key`.
   - `gateway_kind`: `'manifest_default' | 'openai_compatible'`.
   - `display_label` (1..80 safe characters; never secret material).
   - `endpoint_base_url`: `null` for `manifest_default`; validated URL (`https:` for public hosts, `http:` or `https:` for RFC1918/ULA/private single-label hosts; no userinfo, query, fragment, loopback metadata, or `0.0.0.0`) for `openai_compatible`.
   - `model_name`: `'auto'` for `manifest_default`; non-empty safe identifier (`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`) for `openai_compatible`.
   - Protected key storage (`null` for `manifest_default`; mandatory AES-256-GCM ciphertext fields for `openai_compatible`): `key_version`, `encrypted_api_key`, `encryption_nonce` (12 bytes), `authentication_tag` (16 bytes), and non-secret `api_key_sha256` digest.
   - Budget and pricing configuration (all integer micro-USD, where `1 USD = 1_000_000 micro_usd`):
     - `budget_micro_usd` (`0` = unlimited monetary spend; `> 0` = capped spend per window).
     - `budget_window_kind`: `'utc_day' | 'utc_month'`.
     - `input_cost_per_million_micro_usd`, `output_cost_per_million_micro_usd`.
     - Constraint: if `budget_micro_usd > 0`, at least one of `input_cost_per_million_micro_usd` or `output_cost_per_million_micro_usd` must be `> 0`.
   - Lifecycle state `'draft' | 'active' | 'retired'`, plus latest test columns (`last_test_status`: `'untested' | 'passed' | 'failed'`, `last_tested_at`, `last_test_reason_code`, `last_test_http_status`).
   - Partial unique index guarantees at most one `active` gateway profile at a time.
   - Database trigger prevents direct `UPDATE` of config/key/budget fields or deletion; config changes create a new immutable `draft` revision requiring a fresh connection test before activation.

2. **`model_gateway_test_events`** (append-only):
   - Records every administrator-initiated connection probe (`passed` | `failed`, normalized `reason_code`, nullable `http_status`, `latency_ms`, `tested_at`). Never stores request/response bodies or credentials.
   - Database trigger synchronizes `last_test_*` onto the target `model_gateway_profiles` row.

3. **`model_gateway_review_events`** (append-only):
   - Actions `'activate' | 'retire'`.
   - Trigger under `pg_advisory_xact_lock(7100417)` enforces fail-closed activation: `openai_compatible` cannot transition to `'active'` unless `last_test_status = 'passed'`. Activating any profile automatically retires the previously active profile in the same atomic transaction.

4. **`model_budget_windows` & `model_call_leases` Ledger**:
   - Tracks `reserved_micro_usd`, `spent_micro_usd`, `input_tokens_total`, and `output_tokens_total` per `(gateway_profile_id, window_kind, window_started_at)`.
   - `model_call_leases` gains nullable `gateway_profile_id`, `budget_window_kind`, `budget_window_started_at`, `reserved_micro_usd`, `settled_micro_usd`, `prompt_tokens`, `completion_tokens`, and permits `outcome_code = 'budget_exceeded'`.
   - `support_escalation_outcomes` permits `reason_code = 'budget_exceeded'`.
   - `admin_audit_events` permits `action = 'model_gateway_changed'` and `object_type = 'model_gateway'`.

## Encryption & Key Handling

- Protected API keys use `AesGcmGatewaySecretProtector` (AES-256-GCM with AAD `fcd-support-model-gateway:${keyVersion}:${gatewayRef}`, random 12-byte nonces, zeroized plaintext buffers in `finally`).
- Key material comes from optional role-scoped `MODEL_GATEWAY_ENCRYPTION_KEY` (and `MODEL_GATEWAY_KEY_VERSION`, default `'gateway-v1'`) on `admin` and `reply` roles (`MODEL_GATEWAY_ENCRYPTION_KEY_FILE` in production, forbidden on all other runtime roles).
- If `MODEL_GATEWAY_ENCRYPTION_KEY` is absent, existing Manifest default deployments continue operating normally; creating, testing, activating, or calling an `openai_compatible` gateway fails closed (`gateway_encryption_key_unconfigured`).
- Plaintext API keys are never returned from persistence readers, rendered into HTML views, written to audit tables, or logged.

## Connection Testing Protocol

1. Administrator initiates `POST /policy/gateway/:gatewayRef/test` with CSRF and signed action token.
2. Service validates target URL (SSRF-safe private/HTTPS check), decrypts key for `openai_compatible` profiles (or reads runtime Manifest env if testing `manifest_default`), and dispatches one bounded `POST ${endpointBaseUrl}/chat/completions` probe with `model`, `stream: false`, `max_tokens: 16`, `redirect: 'error'`, timeout cap, and response byte cap—without any tools or customer data.
3. Accepts HTTP `200` only when JSON decodes cleanly with `choices[0].message.role === 'assistant'`, string `content`, `finish_reason` in `['stop', 'length']`, and no `tool_calls` or `function_call`.
4. Persists content-free `model_gateway_test_events` and displays exact result and error code on `/policy`.

## Positive Budget Accounting & Enforcement

1. When active gateway `budget_micro_usd > 0`, `acquireLease` runs under `pg_advisory_xact_lock(7100416)` after expiring stale leases and validating operational safety limits:
   - Computes worst-case cost reservation from bounded request size:
     `estimatedMaxInputTokens = max(1, requestInputCodePoints * 2)`
     `reservedMicroUsd = ceilDiv(estimatedMaxInputTokens * inputCostPerMillionMicroUsd + maxOutputTokens * outputCostPerMillionMicroUsd, 1_000_000)`.
   - Checks `spent_micro_usd + reserved_micro_usd + requestReservation <= budget_micro_usd` inside the UTC day/month window row.
   - If insufficient remaining budget, inserts a denied lease with `outcome_code = 'budget_exceeded'`, makes zero upstream HTTP requests, and `ModelReplyService` records a safe response (`limit_exhausted`) + `'budget_exceeded'` escalation (subject to Phase 3 policy).
2. In `completeLease`:
   - Upstream HTTP completions returning integer `usage.prompt_tokens` and `usage.completion_tokens` settle exact cost (`ceilDiv(promptTokens * inputRate + completionTokens * outputRate, 1_000_000)`) and release unused reservation.
   - Completed responses omitting `usage` or post-dispatch ambiguous outcomes (`timeout`, `oversized_body`, `malformed_body`, `invalid_envelope`) settle conservatively at `reserved_micro_usd` so missing telemetry cannot bypass a positive budget.
   - Pre-dispatch or rejected-before-completion errors (`invalid_request`, `aborted`, `network_failure`, `non_2xx`, `provider_exhausted`) release `reserved_micro_usd` (`settled_micro_usd = 0`).
3. In `expireInTransaction`:
   - Expired `queued` leases (`activated_at is null`) release `reserved_micro_usd` (`0` spent).
   - Expired `active` leases (`activated_at is not null`) conservatively convert `reserved_micro_usd` into `spent_micro_usd` (`settled_micro_usd = reserved_micro_usd`) so worker crashes cannot bypass monetary caps.

## Admin UI Extensions (`/policy`)

- Extends `/policy` (`administrator` role required, CSP/CSRF/signed `AdminAction` enforced):
  - Shows active gateway summary (Manifest default `'auto'` vs active custom profile, budget mode/remaining spend, last connection test status) — never printing encrypted blobs or secret substrings.
  - Provides **Create gateway profile draft** form (kind `openai_compatible` or `manifest_default`, display label, endpoint URL, model ID, write-only API key input, budget USD/micro-USD, window `'utc_day' | 'utc_month'`, input/output cost per 1M tokens) plus **Edit as new draft** prefill link (re-entering API key required).
  - Row actions: `Test connection`, `Activate` (enabled/permitted only after latest test passed for `openai_compatible`), and `Retire` (returns active profile to Manifest `fcd-support` / `auto` default).

## Database Grants (`src/persistence/postgres-runtime-grants.ts`)

- `admin`: `select, insert` on `model_gateway_profiles`, `model_gateway_test_events`, `model_gateway_review_events`; `select` on `model_budget_windows`.
- `reply`: `select` on `model_gateway_profiles` (active runtime resolution), `model_budget_windows`, plus `insert, update` on `model_budget_windows` and existing `model_call_leases`.
- `backup`: `select` on all new tables; `webhook`, `outbound`, `notification`, `health`, `maintenance`, `checkpoint`, `verify_backup`, `archive_reader`: no access to encrypted gateway key columns (`model_gateway_profiles` excluded from `maintenance` general table select alongside `groups.admin`, while exposing `model_budget_windows` retention cleanup to `maintenance`).
