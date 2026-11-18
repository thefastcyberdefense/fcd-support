# Track 2D: Private Operator Tooling, Enabled Runtime Mode, and `v1` Timer Alignment

Date: 2026-11-18  
Branch: `codex/track2d-operator-tooling` (stacked on `codex/track2c-private-media-extraction` / PR #28)

## Scope

Implement the remaining operator tooling and runtime controller gaps (`Gap G-1`, `Gap G-3`, `Gap G-4`, `Gap G-5`, and `v1` systemd timer alignment) without merging PRs, mutating live server hosts, creating public tunnels, touching production Meta assets, or enabling external provider calls in CI.

## Design

### 1. Signed Synthetic Webhook Probe CLI (`Gap G-1`)

- Add `src/meta/webhook-probe.ts` and `src/meta/webhook-probe-main.ts`.
- Provide pure `signMetaWebhookPayload(rawBody, appSecret)` producing `sha256=<hex>` over exact UTF-8 payload bytes using HMAC-SHA256.
- Provide `runMetaWebhookProbe(...)` supporting three explicit modes:
  - `verify`: `GET <baseUrl><path>?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` using `META_VERIFY_TOKEN` / `META_VERIFY_TOKEN_FILE` (or `--invalid-token` for negative `403` verification).
  - `post`: `POST <baseUrl><path>` with raw bytes from `--payload-file` or stdin (`<= 256 KiB` default; explicit `--allow-oversized` opt-in for `413`/`4xx` tests) and `x-hub-signature-256` controlled by `--signature-mode valid|invalid|unsigned`.
  - `closed-route`: `GET <baseUrl><path>` (for example `/health` or `/knowledge`) verifying `404` status isolation.
- Enforce `redirect: 'error'` and bounded timeout; never accept secrets via CLI flags and never emit secrets, signature values, verify tokens, or raw payloads in output.

### 2. Read-Only Content-Free `db-counts` CLI (`Gap G-3`)

- Add `src/operations/db-counts.ts` exporting `collectDbCounts(pool)` and Zod `dbCountsReportSchema` / `dbCountsOutputSchema`.
- Execute all aggregate `SELECT count(*)::int` / `GROUP BY` queries inside a `BEGIN READ ONLY` transaction under the least-privilege `maintenance` PostgreSQL role (`createMaintenancePool`), covering pipeline state and version tables (`webhook_receipts`, `webhook_events`, `webhook_event_attachments`, `webhook_event_applications`, `runtime_processing_work`, `support_reply_drafts`, `support_escalation_outcomes`, `knowledge_gap_observations`, `model_call_leases`, `outbound_intents`, `outbound_attempts`, `privacy_requests`, `privacy_suppressions`, `human_pause_events`, `knowledge_versions`, `knowledge_publication_events`, `model_policy_versions`, `outbound_policy_versions`, `operations_deployments`).
- Validate every count as a non-negative integer and every group key against closed lowercase enum tokens before output; restrict `maintenance` away from `admin_accounts` / `model_gateway_profiles` grants unchanged.
- Expose `node dist/operations-main.js db-counts` in `src/operations-main.ts` and allow `maintenance db-counts` in `scripts/operations-job-lifecycle.sh` with a strict content-free acknowledgement pattern.

### 3. Non-Interactive Multi-Role CLI Provisioning (`Gap G-5`)

- Add `src/admin/admin-provision.ts` exporting `provisionAdminAccounts`, `parseAdminProvisionInput`, and `runAdminProvisionFromStdin`.
- Preserve `runAdminBootstrap` interactive masked TTY behavior in `src/admin/admin-bootstrap.ts` when invoked without `--provision-stdin`; add `--provision-stdin` CLI mode for non-interactive JSON provisioning via stdin (`<= 64 KiB`).
- When `admin_accounts` is empty, require the first account to hold `administrator` and create it via `{ kind: 'initial_bootstrap' }`, using its resulting `accountRef` for any subsequent accounts in the batch.
- When `admin_accounts` is non-empty (such as `private-v1` post-bootstrap hosts), require explicit `actorAccountRef` or `actorLoginName` identifying an active `administrator`, create each target account with `{ kind: 'administrator', actorAccountRef }`, and assign its role (`administrator | knowledge_editor | knowledge_reviewer | support_reviewer`) via `assignRole` with idempotent `requestKey` handling.
- Wrap and zero all `AdminSecretText` / `AdminSecretBytes` buffers in `finally` and print only `{ status, accounts: [{ accountRef, role, accountStatus, roleStatus }] }`.

### 4. Opt-In `--mode private-enabled` Controller and Verifier (`Gap G-4`)

- Preserve `private-disabled` as the strict default across `operations_compose`, `verify-runtime.sh`, `rollback-runtime.sh`, `operations-startup.sh`, `operations-runtime-host.sh`, `compose-contract.ts`, and `runtime-host.ts`.
- Extend argument parsing in `scripts/operations-common.sh` to accept `--mode private-enabled` on `deploy`, `verify`, and `rollback` (preserving existing 2-arg `verify` and 3-arg `rollback` forms as `private-disabled`).
- Add `FCD_MODEL_NETWORK` validation in `operations_config_field` and require it in `private-enabled` mode.
- In `operations_compose runtime` when `OPS_RUNTIME_MODE=private-enabled`:
  - Layer `infra/compose.runtime.yml` and `infra/compose.model.yml`.
  - Pass `MODEL_EXECUTION_ENABLED=true`, `OUTBOUND_EXECUTION_ENABLED=true`, and `N8N_EXECUTION_ENABLED=false` (keeping `n8n` and notification adapters disabled unless separately approved, and keeping all `operations`/`restore` containers `false/false/false`).
- In `scripts/operations-startup.sh`: start `fcd-support-api`, `fcd-support-admin`, `fcd-support-reply`, and `fcd-support-outbound` with `--profile model-execution --profile outbound-execution` when `OPS_RUNTIME_MODE=private-enabled`.
- In `scripts/operations-runtime-host.sh`, `src/operations/compose-contract.ts`, `src/operations/runtime-host-main.ts`, and `src/operations/runtime-host.ts`:
  - Support `mode: 'private-disabled' | 'private-enabled'` cleanly (passed via optional trailing `--mode` flag to `runtime-host-main.js`).
  - Enforce 5 active containers (`postgres`, `fcd-support-api`, `fcd-support-admin`, `fcd-support-reply`, `fcd-support-outbound`), per-service execution flags (`reply`: `MODEL_EXECUTION_ENABLED=true`; `outbound`: `OUTBOUND_EXECUTION_ENABLED=true`; `postgres`/`api`/`admin`: all `false`), `outboundHeartbeat` readiness probe, `provider_egress` non-internal bridge with exact `[outbound]` membership, and external `model` bridge verification confirming `reply` membership without reclassifying or rejecting pre-existing Manifest peers.
- Extend `scripts/operations-health-host.sh` to include `outbound` health/heartbeat in `HostHealthSnapshot.services` when `fcd-support-outbound` exists while keeping `private-disabled` 3-service snapshots unchanged.

### 5. `v1` Systemd Timer Alignment

- Harden `scripts/render-systemd-units.sh` to reject whitespace or systemd `%` specifiers in path substitutions (`@ROOT@`, `@CONFIG@`, `@STATE_ROOT@`), enforce `OPS_CONFIG[FCD_SUPPORT_REVISION] == OPS_REVISION`, and verify zero unexpanded `@...@` tokens remain in emitted unit files.
- Add `scripts/verify-systemd-units.sh` as a read-only rendered-unit verification helper (no `systemctl` calls and no automatic host unit mutation or re-enablement) checking exact byte-for-byte alignment with `operations_timers_emit`, mode `0600` non-symlink files, and optional detection of retired path drift in a separate host unit snapshot directory.
- Extend `tests/helpers/runtime-host-fixture.ts` with a `private-enabled` fixture profile carrying `config/model.env`, `secrets/reply/manifest-key`, `secrets/outbound/*`, `FCD_MODEL_NETWORK`, and literal `FCD_*_CALENDAR` / `FCD_TIMER_*` settings without breaking existing `standard` / `ci-recovery` fixtures.
