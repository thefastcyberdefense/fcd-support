# Track 2A: Gateway-Policy Extension Implementation Plan

> **For agentic workers:** Use test-driven development (`RED -> GREEN -> REFACTOR`) for every module and migration, keep commits focused inside the isolated worktree `C:\Users\redwan\.codex\worktrees\track2a-gateway-policy\fcd-support`, and run Windows + Linux `16 MiB /tmp` + PostgreSQL integration verification before opening the stacked Draft PR onto `codex/track1-combined-validation`.

**Goal:** Implement the documented gateway-policy extension (`docs/superpowers/specs/2026-11-17-gateway-policy-extension-design.md`) while keeping Manifest `fcd-support` / `model: "auto"` as the default path and maintaining all safety, redaction, FAQ precedence, and operational limit guarantees.

**Architecture:** Versioned, immutable PostgreSQL gateway configuration (`model_gateway_profiles`, append-only `model_gateway_test_events` and `model_gateway_review_events`) plus transactional UTC day/month monetary budget accounting (`model_budget_windows` + `model_call_leases`), AES-256-GCM encrypted key storage via `MODEL_GATEWAY_ENCRYPTION_KEY`, bounded non-tool OpenAI-compatible client & connection prober, `/policy` admin UI workflows, and reply-worker runtime routing.

## Global Constraints

- Manifest `fcd-support` / `model: "auto"` stays default whenever no custom gateway profile is active.
- `budget_micro_usd = 0` means unlimited monetary spend only; operational limits (`perContact15MinuteCalls`, `perContact24HourCalls`, `globalUtcDayCalls`, `concurrentCalls`, `queueCapacity`, `totalTimeoutMs`, `outputTokens`, `cooldownMs`) always remain enforced.
- `budget_micro_usd > 0` requires non-zero input or output token pricing, advisory-lock pre-call worst-case reservation, and post-call settlement with integer micro-USD arithmetic (`BigInt` ceiling division).
- Plaintext API keys are never persisted unencrypted, logged, exposed in HTML, or serialized via `JSON.stringify` / `util.inspect`.
- Schema head advances from `000016` to `000017`; update live-DB head assertions cleanly without weakening any Phase 6 contract or runtime gate.

## Review Focus

- URL SSRF & secret-free validation (`isAllowedOpenAiCompatibleBaseUrl`, `isPrivateManifestBaseUrl` preserved untouched).
- AEAD AAD binding (`fcd-support-model-gateway:${keyVersion}:${gatewayRef}`) and buffer zeroization.
- Database trigger enforcement preventing `openai_compatible` activation before connection test passes.
- Least-privilege grants (`model_gateway_profiles` excluded from unprivileged roles).
- Budget reservation vs settlement accounting across `completed`, missing-usage `completed`, `non_2xx`/`provider_exhausted`/`network_failure`, and `expired` (`queued` vs `active`) leases.

## Planned File Map

- **Create:**
  - `migrations/000017_create_model_gateway_config.ts`
  - `src/safety/secret-bytes.ts`
  - `src/model/gateway-secret.ts`
  - `src/model/gateway-types.ts`
  - `src/model/gateway-budget.ts`
  - `src/persistence/postgres-model-gateway.ts`
  - `tests/gateway-secret-and-budget.test.ts`
  - `tests/integration/postgres-model-gateway.test.ts`
- **Modify:**
  - `src/admin/admin-types.ts` (re-export `SecretBytes` / keep `AdminSecretBytes` API compatible)
  - `src/model/model-types.ts`, `src/model/model-policy-types.ts`, `src/model/model-config.ts`
  - `src/model/manifest-request.ts`, `src/model/manifest-client.ts`
  - `src/operations/secret-files.ts`, `src/operations/compose-contract.ts`
  - `src/admin/admin-config.ts`, `src/admin/admin-action.ts`, `src/admin/admin-app.ts`, `src/admin/admin-html.ts`, `src/admin/admin-runtime.ts`
  - `src/persistence/postgres-admin-dashboard.ts`, `src/persistence/postgres-model-allowance.ts`, `src/persistence/postgres-support-escalation.ts`, `src/persistence/postgres-runtime-grants.ts`
  - `src/replies/reply-types.ts`, `src/replies/model-reply-service.ts`, `src/operations/reply-runtime.ts`
  - Update `000016` live schema head references in integration/runtime fixtures and tests (`scripts/test-health-stdio-docker.sh`, `tests/helpers/runtime-host-fixture.ts`, `tests/integration/postgres-*.test.ts`, etc.)
  - Extend unit & integration tests (`tests/manifest-client.test.ts`, `tests/model-reply-service.test.ts`, `tests/admin-dashboard.test.ts`, `tests/integration/migrations.test.ts`, `tests/integration/postgres-runtime-grants.test.ts`, `tests/integration/postgres-model-allowance.test.ts`, `tests/integration/postgres-model-reply-flow.test.ts`)

## Tasks

### Task 1: Shared Secret Bytes, URL/Config Validation & Gateway AEAD Protector + Budget Math (`RED -> GREEN`)

1. Write failing unit tests in `tests/gateway-secret-and-budget.test.ts` covering:
   - `isAllowedOpenAiCompatibleBaseUrl` (accepts clean `https://`, private IPv4/ULA/single-label `http://`; rejects userinfo, query/hash, public `http://`, `localhost`, `0.0.0.0`, `169.254.169.254`, non-http/https).
   - `AesGcmGatewaySecretProtector` encrypt/decrypt round-trip, AAD binding to `gatewayRef` + `keyVersion`, tampered tag/ciphertext rejection, and `SecretBytes` redaction under `JSON.stringify` / `util.inspect`.
   - `computeMaxEstimatedCostMicroUsd`, `computeActualCallCostMicroUsd`, and `budgetWindowBounds` (`utc_day` & `utc_month` boundaries, zero budget vs positive budget integer rounding).
2. Implement `src/safety/secret-bytes.ts`, update `src/admin/admin-types.ts`, add `src/model/gateway-types.ts`, `src/model/gateway-secret.ts`, `src/model/gateway-budget.ts`, and update `src/model/model-config.ts` (`isAllowedOpenAiCompatibleBaseUrl`).
3. Verify `tests/gateway-secret-and-budget.test.ts` and `tests/model-config.test.ts` pass.

### Task 2: OpenAI-Compatible Client & Non-Tool Request Builder (`RED -> GREEN`)

1. Add failing unit tests in `tests/manifest-client.test.ts`:
   - `buildGatewayRequest(input, { model: 'gpt-4o-mini' })` keeps `messages`-only payload, `stream: false`, `WeakMap` validation context, and unchanged `buildManifestRequest` defaulting `model: 'auto'`.
   - `createOpenAiCompatibleClient` allows `https://` OpenAI-compatible URLs, extracts integer `usage.prompt_tokens` / `usage.completion_tokens`, rejects `tool_calls` / `function_call`, and includes `probeGatewayConnection` testing helper.
2. Update `src/model/model-types.ts`, `src/model/manifest-request.ts`, and `src/model/manifest-client.ts` (sharing internal bounded fetch/body-reader helper with zero code duplication).
3. Verify `tests/manifest-client.test.ts` passes.

### Task 3: PostgreSQL Migration `000017`, Runtime Grants & Secret Loader (`RED -> GREEN`)

1. Write `migrations/000017_create_model_gateway_config.ts` (`up` and fail-closed `down`), update `src/persistence/postgres-runtime-grants.ts` (`groups.model_gateway`, least-privilege table grants), update `src/persistence/postgres-support-escalation.ts` (`'budget_exceeded'`), update `src/operations/secret-files.ts` and `src/operations/compose-contract.ts` (optional `MODEL_GATEWAY_ENCRYPTION_KEY` for `admin` & `reply`).
2. Add migration & grant assertions in `tests/integration/migrations.test.ts` and `tests/integration/postgres-runtime-grants.test.ts`, plus update live schema head assertions (`000016` -> `000017`).
3. Run `migrations.test.ts`, `postgres-runtime-grants.test.ts`, and `postgres-support-escalation.test.ts` against local Docker Postgres to verify `up`, `down`, triggers, constraints, and least privilege.

### Task 4: `PostgresModelGateway` & Budget Enforcement in `PostgresModelAllowance` (`RED -> GREEN`)

1. Write failing integration & unit tests in `tests/integration/postgres-model-gateway.test.ts`, `tests/integration/postgres-model-allowance.test.ts`, and `tests/model-reply-service.test.ts`:
   - Creating `manifest_default` and encrypted `openai_compatible` drafts; rejecting invalid URLs or positive budget with zero pricing.
   - Database trigger rejecting activation of `openai_compatible` before a `'passed'` connection test.
   - Recording failed/passed connection tests and activating / auto-retiring prior active profile / retiring back to Manifest default.
   - Positive budget reservation (`reserved_micro_usd`), exact `usage` settlement, missing-usage conservative settlement, pre-send failure release, expired `queued` release vs expired `active` fail-closed settle, and `'budget_exceeded'` denial with zero upstream calls.
   - Zero budget (`budgetMicroUsd = 0`) allowing unlimited spend while strictly enforcing per-contact/global/concurrency/cooldown operational safety limits.
2. Implement `src/persistence/postgres-model-gateway.ts`, extend `src/persistence/postgres-model-allowance.ts`, `src/replies/reply-types.ts`, `src/replies/model-reply-service.ts`, and wire `src/operations/reply-runtime.ts`.
3. Verify `tests/model-reply-service.test.ts`, `tests/integration/postgres-model-gateway.test.ts`, `tests/integration/postgres-model-allowance.test.ts`, and `tests/integration/postgres-model-reply-flow.test.ts` pass.

### Task 5: Admin Config, Dashboard Service, `/policy` Gateway Routes & UI (`RED -> GREEN`)

1. Write failing tests in `tests/admin-dashboard.test.ts` (and `tests/integration/postgres-admin-dashboard.test.ts`) covering:
   - Non-administrator role rejection (`403`), administrator view of active gateway state (default Manifest `'auto'` vs custom profile, zero secret leakage).
   - Creating gateway draft, running bounded connection test (`passed` & `failed` cases), refusal to activate untested/failed profile (`400`), activating passed profile, retiring back to Manifest `'auto'` default, and append-only `admin_audit_events` recording (`model_gateway_changed`).
2. Update `src/admin/admin-config.ts`, `src/admin/admin-action.ts`, `src/admin/admin-runtime.ts`, `src/persistence/postgres-admin-dashboard.ts`, `src/admin/admin-app.ts`, and `src/admin/admin-html.ts`.
3. Update runtime schema head tests/fixtures (`000016` -> `000017`) where live DB head is validated.

### Task 6: Full Verification, Formatting & Stacked Draft PR

1. Format Markdown and TypeScript cleanly (`npx prettier --write ...`), run `npm run validate:phase0`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `node scripts/verify-security-policy.ts`.
2. Run Windows full unit/contract suite (`VITEST_MAX_WORKERS=4 npm test`), Linux `16 MiB /tmp` Docker container suite (`bash scripts/test-encrypted-backup.sh unit`), and PostgreSQL integration suite (`npm run test:integration`).
3. Update `task.md`, commit cleanly, push `codex/track2a-gateway-policy`, open Draft PR targeting `codex/track1-combined-validation`, and verify GitHub CI status.
