# Track 3 Target-Specific Action and Rollback Approval Packages (2026-11-18)

**Branch:** `codex/track3-4-approval-packages` (stacked on PR #25–#29: Track 1 + Tracks 2A/2B/2C/2D)  
**Authorization Status:** **APPROVAL REQUIRED BEFORE EXECUTION.** This package prepares exact target-specific actions, pre-checks, stop criteria, and rollback steps. No SSH session, server deployment, Cloudflare Tunnel change, Meta asset change, Manifest setting change, or systemd timer enablement has occurred from this branch.

---

## Current Observed Target Baseline

Per the unmerged `codex/retire-tests-private-v1` status record ([`docs/PLAN.md`](../PLAN.md), [`docs/TODO.md`](../TODO.md), and `docs/testing/2026-11-16-retirement-private-v1-status.md`):

- **Target Host:** `redwan@192.168.10.40` (Ubuntu Docker host; `23` unrelated containers must remain untouched).
- **Current Deployed Preview (`2026-11-16`):**
  - Source checkout: `/home/redwan/fcd-support-v1-source-c2d8225` (`c2d8225d2a096e2d4f406c35f8ab170a6dad2f80`)
  - Fixture / Compose project: `/home/redwan/fcd-support-host-test-v1-c2d8225` / `fcd-support-host-test-v1-c2d8225`
  - Mode: `--mode private-disabled` (`MODEL_EXECUTION_ENABLED=false`, `OUTBOUND_EXECUTION_ENABLED=false`, `N8N_EXECUTION_ENABLED=false`)
  - Admin forward: `ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -L 127.0.0.1:13004:/home/redwan/fcd-support-host-test-v1-c2d8225/socket/admin.sock redwan@192.168.10.40`
  - Protected initial admin file on server (do not copy into chat or Git): `/home/redwan/fcd-support-v1-admin-20261116/initial-admin.json`
  - Sampled Docker free space after deployment: `19,147 MiB` (~`18.7 GiB`, above the `12 GiB` admission floor)
  - Old systemd timers: Disabled and **not** retargeted to the `v1` preview.
  - Public callback / Meta test-asset state: Old connected `207a5e6` stack is retired; the current `c2d8225` preview has **no** public tunnel or Meta callback binding (`P7-003` and `P7-004` are effectively reopened/`BLOCKED` for the active runtime; `P1-GATE`, `P7-005`, `P7-GATE`, `P8-*`, and `PROD-*` remain `BLOCKED`).
- **Production Number & Channel Protection:** Production WhatsApp Business number, production Facebook Page, OpenClaw, and Hermes must remain completely untouched.

---

## Package 3A: Server Deployment and Multi-Role Provisioning on `redwan@192.168.10.40`

### Gate Prerequisites

- Owner sign-off on `P1-GATE` ([`docs/reviews/phase-1-gate.md`](../reviews/phase-1-gate.md)) and review/integration of stacked PRs #25–#29 into an approved 40-hex commit `<APPROVED_40_HEX_REVISION>`.
- Explicit operator approval for `redwan@192.168.10.40` deployment.

### Exact Execution Steps (Sequential — Stop Immediately on Failure)

1. **Read-only host preflight admission:**
   - Verify clean SSH batch connectivity, Docker daemon health, `23` preserved unrelated containers, zero port/bridge subnet conflicts, `>= 12 GiB` free disk space in Docker storage root and checkout path, and clean disjoint candidate checkout + fixture directory paths (mode `0700` owned by `1000:1000`).
2. **Checkout and build verified source cleanly:**
   - Clone or fetch exact `<APPROVED_40_HEX_REVISION>` into a new isolated directory (without overwriting `/home/redwan/fcd-support-v1-source-c2d8225` until cutover verification completes), verify `git rev-parse HEAD` equals `<APPROVED_40_HEX_REVISION>` and `git status --porcelain --untracked-files=all` is empty.
3. **Phase 1 deployment in `--mode private-disabled`:**
   - Prepare protected mode-`0600` runtime config `<OPS_CONF_PATH>` (including `FCD_MODEL_NETWORK` and non-secret operational settings) and mode-`0600` secret files under the disjoint `0700` secrets directory.
   - Run:
     - `./scripts/deploy-runtime.sh <APPROVED_40_HEX_REVISION> --mode private-disabled <OPS_CONF_PATH>`
     - `./scripts/verify-runtime.sh <APPROVED_40_HEX_REVISION> <OPS_CONF_PATH>`
     - `./scripts/run-db-counts.sh <APPROVED_40_HEX_REVISION> <OPS_CONF_PATH>`
4. **Loopback SSH socket verification and separate-role provisioning (`Gap G-5`):**
   - Bind SSH loopback forward to the new successor Unix socket:
     - `ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -L 127.0.0.1:13004:<SUCCESSOR_SOCKET_ROOT>/admin.sock redwan@192.168.10.40`
   - Provision dedicated `knowledge_editor`, `knowledge_reviewer`, and `support_reviewer` test accounts using stdin-only JSON via `node dist/admin/admin-bootstrap.js --provision-stdin` inside the private admin execution path, keeping generated credentials and Base32 MFA seeds strictly in owner-only `0600` host files under `0700` directories.
5. **Private operator UI & knowledge gate check (`--mode private-disabled`):**
   - Sign into the private dashboard at `http://127.0.0.1:13004/login` via password + TOTP MFA.
   - Confirm `/knowledge`, `/questions`, `/insights`, `/policy`, `/audit`, `/escalations`, `/operations`, `/controls`, and `/account` enforce RBAC separation across `administrator`, `knowledge_editor`, `knowledge_reviewer`, and `support_reviewer`.
   - Import the official website into **drafts only** from `/knowledge` -> `Import Official Website Drafts`; require explicit owner approval and publish actions before any FAQ or business fact becomes live.
   - Configure and test the protected model gateway profile (`/policy`): keep default Manifest harness `fcd-support` with `model: "auto"` active, and optionally add/test an OpenAI-compatible backup profile (`budgetUsd = 0` for unlimited spend with operational safety limits enforced, or positive `budgetUsd` with atomic spend accounting verified) without activating external traffic until Step 6 / Package 3C.
6. **Gated promotion to `--mode private-enabled` (`Gap G-4`, only for approved Phase 7 test execution):**
   - Prerequisite: Confirm Manifest `fcd-support` harness recording-off and attributable deletion verification (`AC-21`), and verify the real upstream Docker bridge `<FCD_MODEL_NETWORK>` exists and contains the Manifest service peer without exposing public host ports.
   - Keep `N8N_EXECUTION_ENABLED=false` unless separately approved.
   - Run:
     - `./scripts/deploy-runtime.sh <APPROVED_40_HEX_REVISION> --mode private-enabled <OPS_CONF_PATH>`
     - `./scripts/verify-runtime.sh <APPROVED_40_HEX_REVISION> --mode private-enabled <OPS_CONF_PATH>`
   - Verify all `5` runtime containers (`postgres`, `fcd-support-api`, `fcd-support-admin`, `fcd-support-reply`, `fcd-support-outbound`) report healthy/heartbeat OK, `provider_egress` contains only `fcd-support-outbound`, and `model` attaches `fcd-support-reply` alongside existing Manifest peers.

### Stop Criteria and Exact Rollback for Package 3A

- **Stop Immediately If:** Free Docker disk falls below `12 GiB`; any of the `23` unrelated containers changes state or network membership; schema migration readiness fails; `verify-runtime.sh` exits non-zero; `admin.sock` permissions drift from owner-only `0600`/`0700`; or Manifest message-body recording cannot be proven disabled before model worker startup.
- **Rollback Steps:**
  1. Immediately revert to disabled execution: `./scripts/deploy-runtime.sh <APPROVED_40_HEX_REVISION> --mode private-disabled <OPS_CONF_PATH>` (or `./scripts/rollback-runtime.sh <PREVIOUS_COMPATIBLE_REVISION> --confirm-schema-compatible <OPS_CONF_PATH>` when rolling back between schema-compatible revisions).
  2. Never delete active PostgreSQL data volumes or rewrite/clear uncertain operational journal markers (`deploy-runtime.sh` / `rollback-runtime.sh` fail closed when schema incompatibility or uncertain state exists).
  3. Re-verify `http://127.0.0.1:13004/login` availability or preserve stopped candidate artifacts cleanly with `23` unrelated containers untouched.

---

## Package 3B: Cloudflare Tunnel and Public Webhook Ingress Binding

### Gate Prerequisites

- Separate operator approval for public DNS / Cloudflare Tunnel routing (`P7-003` equivalent for active `v1` successor).
- Verified private ingress target in `<OPS_CONF_PATH>` and healthy `fcd-support-api:3003` in Package 3A.

### Exact Target Configuration and Execution Steps

- **Hostname:** `https://meta.fastcyberdefense.com/webhooks/meta`
- **Ingress Rules (Strict Order):**
  1. Hostname `meta.fastcyberdefense.com`, exact path matcher `^/webhooks/meta$` -> `http://fcd-support-api:3003`
  2. Final mandatory catch-all rule -> `http_status:404`
- **Forbidden Public Paths:** `/login`, `/mfa`, `/knowledge`, `/policy`, `/questions`, `/insights`, `/audit`, `/escalations`, `/operations`, `/controls`, `/account`, `/health`, PostgreSQL, n8n, Manifest, and OmniRoute must never match an ingress rule.
- **Commands (on `redwan@192.168.10.40` after approval):**
  1. Verify token file `<CLOUDFLARED_TOKEN_FILE>` (`/home/redwan/.config/fcd-support/cloudflared.token`) exists as owner-only mode `0600`.
  2. Pre-validate image/token contract if upgrading: `./scripts/start-cloudflared.sh --validate-only <APPROVED_40_HEX_REVISION> <CLOUDFLARED_TOKEN_FILE>` (or `--replace-existing` when explicitly authorized to replace the stopped rollback tunnel container).
  3. Attach `fcd-support-cloudflared` **only** to the ingress bridge network (never `data`, `admin`, `model`, or `provider_egress`).
  4. Verify public boundary using compiled synthetic probe (`Gap G-1`):
     - `node dist/meta/webhook-probe-main.js --base-url https://meta.fastcyberdefense.com --mode verify --path /webhooks/meta` -> HTTP `200` challenge match
     - `node dist/meta/webhook-probe-main.js --base-url https://meta.fastcyberdefense.com --mode verify --path /webhooks/meta --invalid-token --expected-status 403` -> HTTP `403`
     - `node dist/meta/webhook-probe-main.js --base-url https://meta.fastcyberdefense.com --mode closed-route --path /health --expected-status 404` -> HTTP `404` without application `404` header
     - `node dist/meta/webhook-probe-main.js --base-url https://meta.fastcyberdefense.com --mode closed-route --path /login --expected-status 404` -> HTTP `404`
     - `node dist/meta/webhook-probe-main.js --base-url https://meta.fastcyberdefense.com --mode post --path /webhooks/meta --signature-mode unsigned --payload-file <SYNTHETIC_SAMPLE_JSON> --expected-status 401` -> HTTP `401`

### Stop Criteria and Exact Rollback for Package 3B

- **Stop Immediately If:** `/health`, `/login`, or any non-webhook route returns `200`, `303`, or an application-tagged `404` (indicating missing catch-all isolation); `fcd-support-cloudflared` gains an interface on `data` or `model`; or unsigned `POST /webhooks/meta` returns `200`.
- **Rollback Steps:**
  1. Immediately stop the `fcd-support-cloudflared` container (`docker stop fcd-support-cloudflared`) to sever public ingress without stopping internal PostgreSQL or admin socket access.
  2. In Cloudflare Zero Trust dashboard, remove or pause the `^/webhooks/meta$` rule pointing to the test tunnel and retain the catch-all `http_status:404`.
  3. Re-verify public URL returns `404` / `530` while private runtime remains safe.

---

## Package 3C: Meta Test Assets, Token/Secret Rotation, and Manifest/Gateway Preflight

### Gate Prerequisites

- Explicit operator approval for non-production Meta test-asset wiring (`P7-004` equivalent for active `v1`).
- Package 3A (`--mode private-disabled` minimum; `--mode private-enabled` for live test-device send) and Package 3B passing cleanly.

### Exact Target Scope and Actions

1. **Test Assets Only (Zero Production Changes):**
   - Target ONLY the Meta development app, dedicated Meta WhatsApp **test number**, and dedicated Messenger **test Page**.
   - Confirm production WhatsApp Business number and production Facebook Page IDs are absent from test configuration and completely untouched.
2. **Webhook Callback Registration & Graph API Version Pinning:**
   - Callback URL: `https://meta.fastcyberdefense.com/webhooks/meta`
   - Verify token read locally by operator in private SSH session from mode-`0600` `META_VERIFY_TOKEN` secret file (`Verify and save`; client certificates off).
   - Pin outbound Graph API version `META_GRAPH_API_VERSION=v25.0`; document support window prior to outbound sends.
   - Subscribe test WhatsApp number (`messages`) and Messenger test Page (`messages`, `message_deliveries`, `message_reads`, `message_echoes`, `message_reactions`, `message_edits`, `messaging_postbacks`).
3. **Signed Public Post & Deduplication Verification (`Gap G-1` + `Gap G-3`):**
   - Run `node dist/meta/webhook-probe-main.js --base-url https://meta.fastcyberdefense.com --mode post --path /webhooks/meta --signature-mode valid --payload-file <SYNTHETIC_SAMPLE_JSON>`.
   - Re-run identical payload to confirm idempotent `200` replay with `./scripts/run-db-counts.sh <APPROVED_40_HEX_REVISION> <OPS_CONF_PATH>` showing `webhook_receipts` / `webhook_event_applications` incremented once cleanly without exposing message bodies.
4. **Secret / Verify-Token Rotation & Manifest Verification:**
   - Before live customer/model evaluation, rotate `META_VERIFY_TOKEN` and `META_APP_SECRET` if previously exposed in legacy test deployments; update mode-`0600` secret files, restart target containers cleanly, and verify old tokens return `403`/`401`.
   - Verify Manifest `fcd-support` harness (`model: "auto"`, tool-free request builder, regex redaction active) has message-body recording disabled and attributable erasure tested (`AC-21`).

### Stop Criteria and Exact Rollback for Package 3C

- **Stop Immediately If:** Any identifier or subscription matches the production WhatsApp number or production Facebook Page; OpenClaw or Hermes credentials appear in environment/logs; Manifest retains message bodies; or unredacted secrets appear in server logs or `db-counts` / health output.
- **Rollback Steps:**
  1. Unsubscribe or pause webhook delivery on the Meta development App dashboard for the test Page and test number.
  2. Clear or rotate test `META_APP_SECRET` / `META_VERIFY_TOKEN` / Meta test access tokens in mode-`0600` secret files and re-run `./scripts/deploy-runtime.sh <APPROVED_40_HEX_REVISION> --mode private-disabled <OPS_CONF_PATH>` to halt all outbound/model processing immediately.
  3. On `/policy`, ensure active model profile reverts cleanly to the default Manifest `fcd-support` (`auto`) profile with any experimental external OpenAI-compatible profile deactivated.

---

## Package 3D: Fresh `v1` Systemd Timer Rendering, Verification, and Guarded Cutover

### Gate Prerequisites

- Package 3A healthy and explicitly approved for scheduled host operation activation.
- Acceptance of fresh backup/restore readiness (`T-11`) before unattended scheduled jobs are enabled.

### Exact Execution Steps

1. **Render candidate units into disjoint owner-only staging directory:**
   - `./scripts/render-systemd-units.sh <APPROVED_40_HEX_REVISION> <OPS_CONF_PATH> <NEW_UNIT_DIR>`
2. **Verify exact unit hash, calendar syntax, mode `0600`, and zero unresolved placeholders:**
   - `./scripts/verify-systemd-units.sh <APPROVED_40_HEX_REVISION> <OPS_CONF_PATH> <NEW_UNIT_DIR>`
   - Require exact output `systemd_units_aligned=true`.
   - Confirm old legacy systemd units installed prior to 2026-11-16 remain disabled and are **not** silently reused.
3. **Dry-run single job invocations before timer activation:**
   - Test bounded `backup`, `maintenance retention`, `health`, and `db-counts` once cleanly under supervision, verifying healthy completion and zero uncertain journal entries.
4. **Root/operator installation and activation (separate privileged step):**
   - Copy reviewed `<NEW_UNIT_DIR>/fcd-support-operation@.service`, `fcd-support-backup.timer`, `fcd-support-maintenance.timer`, and `fcd-support-health.timer` into `/etc/systemd/system` cleanly, `systemctl daemon-reload`, and enable/start only after operator sign-off.

### Stop Criteria and Exact Rollback for Package 3D

- **Stop Immediately If:** `verify-systemd-units.sh` exits non-zero; any unit points to retired `/home/redwan/apps/fcd-support` or `207a5e6`/`b1e183d`/`c2d8225` stale revisions; or any scheduled run leaves an uncertain journal marker without verified settlement.
- **Rollback Steps:**
  1. Run `sudo systemctl disable --now fcd-support-backup.timer fcd-support-maintenance.timer fcd-support-health.timer`.
  2. Remove the candidate unit files from `/etc/systemd/system`, run `sudo systemctl daemon-reload`, and preserve all existing state journals, PostgreSQL data, and backups without clearing uncertain state.
