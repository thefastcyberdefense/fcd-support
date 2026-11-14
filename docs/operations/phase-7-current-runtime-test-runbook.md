# Phase 7 Current-Runtime Operator Test Runbook

Status: **BLOCKED FROM LIVE EXECUTION** pending server storage remediation, isolated private-successor admission/deployment, and Codex/owner authorization. This runbook consolidates the approved current-runtime Phase 7 acceptance scope (`P7-005` / `P7-GATE`) from synchronized `main` (`94c95423feed20c866c9ab4a009ddde146674f57`, including accepted PR #18 merge `f6ca679` and PR #19 merge `2e24997`). It **does not** authorize SSH, shared-server execution, test-asset mutations, or production WhatsApp/Page changes, and it closes **zero** tracker rows or launch gates.

## 1. Authority, Source State, and Evidence Distinction

| Evidence category                 | Exact source / scope                                                                                                                                    | What it proves today                                                                                                                                              | What it does **not** prove                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Synchronized repository & CI      | `origin/main` at `94c9542` (`f6ca679` PR #18, `2e24997` PR #19, `5ede82c`, `ba85e77`, `94c9542`)                                                        | Contract, schema, Compose/socket isolation, admin auth/CSRF/MFA, redaction, FAQ-first, outbox/echo, and backup/restore logic under local tests and Linux CI      | Live shared-server deployment health, Windows 4-worker full parity beyond repo records, or Meta delivery |
| Historical Phase 3 live webhook   | Revision `207a5e6` (`docs/operations/test-deployment.md`): legacy `fcd-support-fcd-support-api-1`, `fcd-support-postgres-1`, `fcd-support-cloudflared`   | Public `GET/POST /webhooks/meta` verification, unsigned `401` rejection, signed `v26` synthetic retry/echo/WhatsApp webhook admission at `207a5e6`               | Current `94c9542` runtime health, private admin/worker execution, real device delivery, or pause apply |
| Held Phase 6 private server stack | Revision `24e5667` (`fcd-support-host-test-p6-b1e183d`, `docs/testing/2026-11-03-phase-6-server-24e5667.md`)                                            | Three root systemd timers active; `webhook`, `reply`, `postgres` healthy on private test project; 19 older containers retired; 23 unrelated containers preserved   | Unhealthy/restarting `admin` (`admin.sock` refuses connections); held uncertain health journal blocks ops |
| Read-only successor preflight     | Revision `5ede82c` (`docs/testing/2026-11-13-private-successor-admission.md`) via `./scripts/deploy-runtime.sh --inspect` workflow                      | Preservation checks pass without touching legacy `207a5e6` stack or 23 unrelated containers; host disk check **refused** at `resources` (`10 GiB` < `12 GiB` min) | Isolated successor is not deployed yet (`-1,609 MiB` disk deficit; `sudo vgs` password-gated)          |
| Current live Meta/Manifest P7     | `P7-005`, `P7-GATE` (`docs/TODO.md`, `docs/testing/acceptance-matrix.md`)                                                                               | Nothing executed live on current `94c9542` runtime                                                                                                                | All live test-asset webhook/model/outbound/device/admin/outage/restore rows remain **UNEXECUTED**      |

Primary governance references: [`AGENTS.md`](../../AGENTS.md), [`docs/PLAN.md`](../PLAN.md), [`docs/TODO.md`](../TODO.md), [`docs/PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md), [`docs/SYNTHETIC_FIXTURE_POLICY.md`](../SYNTHETIC_FIXTURE_POLICY.md), [`docs/testing/acceptance-matrix.md`](../testing/acceptance-matrix.md), [`docs/testing/phase-7-readiness.md`](../testing/phase-7-readiness.md), and the companion validation record [`docs/testing/2026-11-14-phase-7-current-runbook.md`](../testing/2026-11-14-phase-7-current-runbook.md).

## 2. Fail-Closed Readiness Checklist (Execute Nothing Dependent Until Satisfied)

Every row below must pass **before** running any dependent live test. If any prerequisite fails or lacks explicit Codex/project-owner sign-off, **STOP** that branch cleanly and record `BLOCKED` without synthesizing proof.

1. **Host Storage & Isolated Private Successor Deployment (Codex-owned):**
   - Server free space must reach the `12 GiB` admission floor (`2026-11-13` read-only `--inspect` at `5ede82c` observed `10 GiB` free / `1,609 MiB` short).
   - Deploy approved isolated successor (`<40-hex-rev>`) only after read-only inspection and separate Codex deployment approval (`./scripts/deploy-runtime.sh <40-hex-rev> --mode private-disabled <operations-config-file>` followed by an explicitly approved test-worker overlay).
2. **No Replay of Uncertain Health Jobs (Codex-owned):**
   - Confirm no held uncertain health job blocks operations (`operations_job_pending` caused by held Phase 6 `health` uncertainty must be dispositioned separately by Codex — **never** replay an uncertain health job or clear journal locks blindly).
3. **Connected Webhook Target Preserved & Scoped:**
   - Legacy `207a5e6` webhook containers (`fcd-support-fcd-support-api-1`, `fcd-support-postgres-1`, `fcd-support-cloudflared`) remain untouched until an explicitly approved cutover plan switches the ingress target.
   - Do **not** run `./scripts/start-cloudflared.sh --replace-existing` without separate tunnel-switch approval.
   - Public ingress exposes **only** `GET /webhooks/meta` and `POST /webhooks/meta`; private probes verify `/health`, admin socket paths, Postgres, Manifest, OmniRoute, and n8n return `404` publicly and publish zero host TCP ports (`./scripts/verify-runtime.sh <40-hex-rev> <operations-config-file>`).
4. **Healthy Private Admin Socket & Bootstrapped Operator MFA:**
   - Private `admin` container healthy; `admin.sock` exists (`${FCD_ADMIN_SOCKET_ROOT}/admin.sock`) and responds only via authenticated SSH loopback forward (`ssh -N -L 127.0.0.1:13004:<admin.sock>`).
   - Operator accounts/roles (`administrator`, `knowledge_editor`, `knowledge_reviewer`, `support_reviewer`) provisioned cleanly with scrypt passwords + Base32 TOTP MFA (`npm run admin:bootstrap` -> `node dist/admin/admin-bootstrap.js`).
5. **Approved Test-Only Meta Assets & Access Permissions:**
   - Development Meta app, Meta-hosted test WhatsApp Business number, and dedicated test Facebook Page only.
   - Production WhatsApp Business account must **never** be unlinked, migrated, re-registered, or re-subscribed.
   - Test recipients holding developer/tester roles on the Development Meta app are verified before testing device delivery (unpublished/dev Meta apps reject or drop external real-device ingress without app roles; see [`acceptance-matrix.md`](../testing/acceptance-matrix.md) `AC-01`).
   - Current test token active (`AC-28` recorded an expired historical test token; rotate privately without logging token strings).
6. **Graph API Pin Preserved (`v25.0`):**
   - Outbound REST sends remain pinned at `META_GRAPH_API_VERSION = 'v25.0'` ([`src/outbound/outbound-config.ts`](../../src/outbound/outbound-config.ts#L13), [`src/outbound/meta-outbound-client.ts`](../../src/outbound/meta-outbound-client.ts#L132)). See Section 6 for `v25.0` vs `v26.0` reconciliation.
7. **Approved Synthetic Knowledge, Policy, & Worker Toggles:**
   - Approved synthetic English & Bangla FAQ versions exist in `knowledge_versions` (`published`), plus active reviewed `model_policy_versions` (`MODEL_*` limits within [`src/model/model-config.ts`](../../src/model/model-config.ts#L58-L100) ceilings) and `outbound_policy_versions`.
   - Note that `./scripts/deploy-runtime.sh <40-hex-rev> --mode private-disabled <operations-config-file>` boots all workers with `MODEL_EXECUTION_ENABLED=false`, `OUTBOUND_EXECUTION_ENABLED=false`, `N8N_EXECUTION_ENABLED=false` ([`infra/compose.runtime.yml`](../../infra/compose.runtime.yml#L67-L270), [`scripts/operations-common.sh`](../../scripts/operations-common.sh#L162)). Model (`reply`) and `outbound` tests require an explicitly authorized private Compose test override setting `MODEL_EXECUTION_ENABLED=true` and `OUTBOUND_EXECUTION_ENABLED=true` (plus `infra/compose.model.yml` where applicable), keeping `N8N_EXECUTION_ENABLED=false` unless n8n consumer testing (`P8-005`) is explicitly scoped.
8. **Manifest Privacy, Redaction, & Key Isolation Attestation:**
   - Dedicated Manifest Harness config named `fcd-support`, requesting `MANIFEST_MODEL=auto` over private `/v1` HTTP/HTTPS (`isPrivateManifestBaseUrl`), zero tools exposed in request body, `inspectSensitiveText` active, OpenClaw and Hermes keys completely separate and unused.
   - All six Manifest config attestations verified `true`: `MANIFEST_RECORDING_DISABLED`, `MANIFEST_PRIVATE_ROUTE_VERIFIED`, `MANIFEST_DELETION_RETENTION_APPROVED`, `MANIFEST_LIMITS_WITHIN_DEPLOYMENT_CEILINGS`, `MANIFEST_PROVIDER_ALLOWLIST_APPROVED`, and `MANIFEST_MODEL=auto`.
   - Operator confirms in Manifest dashboard that prompt/response body logging/recording is **disabled** (`AC-10`, `AC-21`) before running live `decision_type='model'` prompts.

## 3. Pipeline Stage Separation Contract

Operators **must never** conflate adjacent pipeline states into one pass claim. Every end-to-end test must inspect these seven distinct stages independently:

| Stage | Boundary / Trigger                                     | Authoritative State / Column Evidence                                                                                                                                             | Non-Equivalence Rule (What this stage does **not** prove)                        |
| ----- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1     | Incoming HTTP (`GET/POST /webhooks/meta`)              | Raw-byte `X-Hub-Signature-256` HMAC verified before parse; <= 256 KiB UTF-8 JSON; HTTP `401`/`400`/`503`/`200 EVENT_RECEIVED`                                                     | HTTP `200` proves durable ingress only, **not** customer delivery or AI action   |
| 2     | Durable Receipt (`PostgresReceiptStore`)               | `webhook_receipts.payload_sha256`; `webhook_events.admission_outcome` in `'pending' \| 'stale' \| 'unsupported' \| 'suppressed'`; `idempotency_key` deduplication                  | A saved webhook row does **not** mean policy/model/outbound ran                  |
| 3     | Worker Application (`runtime_processing_work` `apply`) | `webhook_event_applications.outcome` in `'customer_message_applied' \| 'business_echo_paused' \| 'business_echo_ignored_before_resume' \| 'message_status_*' \| 'service_echo_correlated' \| 'identity_suppressed'` | Receiving a Messenger Page echo does **not** confirm `business_echo_paused` ran  |
| 4     | Reply Decision (`ReplyDecisionService`)                | `support_reply_drafts` (`decision_type`: `'faq' \| 'model' \| 'safe_failure'`, `language`: `'en' \| 'bn'`, `state`: `'ready' \| 'erased'`), or `support_escalation_outcomes`      | Generating a draft does **not** mean outbound eligibility or Meta accepted send   |
| 5     | Outbound Claim & Provider Acceptance                   | `outbound_intents.state`: `'pending' -> 'leased' -> 'provider_accepted'`; `outbound_attempts.state`: `'authorized' -> 'dispatch_started' -> 'provider_accepted' \| 'definitely_rejected' \| 'delivery_unknown' \| 'abandoned_before_dispatch'` | Provider HTTP 2xx (`provider_accepted`) does **not** prove physical phone receipt |
| 6     | Customer/Device Delivery & Status Processing           | `outbound_intents.state`: `'provider_accepted' -> 'sent' -> 'delivered' -> 'read'` or `'terminal_failed'`; monotonic `outbound_status_events`                                      | Synthetic signed webhook statuses do **not** substitute for real test-device check |
| 7     | Human-Echo Correlation & AI Takeover                   | `outbound_echo_correlation_holds` separates own service echo (`service_echo_correlated`) from manual staff echo (`business_echo_paused` -> `conversations.ai_paused_until` +24h & `human_pause_events`) | Requires positive check that `ai_paused_until` blocks later reply generation        |

## 4. Verified Command Entrypoints & Known Tooling Gaps

Only the following repository entrypoints exist on synchronized `main` (`94c9542`). Do **not** invent unimplemented scripts or HTTP routes.

### Verified Existing Entrypoints

- **Deployment, Runtime Inspection, Verify, Rollback:**
  - `./scripts/deploy-runtime.sh <40-hex-rev> --mode private-disabled <operations-config-file>`
  - `./scripts/verify-runtime.sh <40-hex-rev> <operations-config-file>`
  - `./scripts/rollback-runtime.sh <40-hex-rev> --confirm-schema-compatible <operations-config-file>`
- **Backup, Restore, Promotion, Socket & Scheduled Ops:**
  - `./scripts/run-operation.sh <backup|maintenance|health> <40-hex-rev> <operations-config-file>`
  - `./scripts/restore-runtime.sh <backup_[a-f0-9]{32}> <checkpoint_[a-f0-9]{32}> <40-hex-rev> <operations-config-file>`
  - `./scripts/promote-restore.sh <restore_[a-f0-9]{32}> <40-hex-rev> <operations-config-file>`
  - `./scripts/abandon-empty-restore.sh <restore_[a-f0-9]{32}> <40-hex-rev> <operations-config-file>`
  - `./scripts/recover-admin-socket.sh <40-hex-rev> --confirm-admin-stopped <operations-config-file>`
- **Node Worker & Operations CLIs (`package.json`, `src/worker-main.ts`, `src/operations-main.ts`):**
  - `node dist/main.js` (public webhook receiver), `node dist/admin-main.js` (private Unix socket dashboard)
  - `node dist/worker-main.js <reply|outbound|notification>`
  - `npm run admin:bootstrap` (`node dist/admin/admin-bootstrap.js` interactive TTY operator bootstrap)
  - `node dist/operations-main.js <migrate|verify-runtime|checkpoint|export-checkpoint-reference|backup|scheduled-backup|pre-migration-backup|verify-backup <ref>|prune-backups <runRef> <iso>|retention|deletion|lease_recovery|learning|health>`
- **Legacy Phase 3 Reference Scripts (retained strictly for inspecting or safely administering `207a5e6` under separate approval):**
  - `./scripts/verify-test-deployment.sh`, `./scripts/start-cloudflared.sh`

### Documented Operational Gaps (Requiring Manual Scoped Tooling / Code Outside Runbook)

1. **Gap G-1 — Signed Synthetic Webhook Probe CLI:** No CLI script in `scripts/` signs and submits synthetic Meta webhook probes. Operator uses a local ephemeral script in scratch memory computing `X-Hub-Signature-256: sha256=<hmac-sha256>` over exact raw UTF-8 JSON bytes against `https://<test-tunnel>/webhooks/meta` without logging secrets or raw payloads.
2. **Gap G-2 — AI Pause Resume & Privacy/Consent Reviewer UI/CLI:** While [`PostgresTakeoverPolicy`](../../src/persistence/postgres-conversation-event-processor.ts), `PostgresDeletionPolicy`, `PostgresPrivacyRightsPolicy`, and `PostgresMarketingOptOutPolicy` exist in TypeScript (and `node dist/operations-main.js deletion` / `retention` run background sweeps), **no HTTP Admin Dashboard route** and **no `operations-main.ts` CLI subcommand** currently exists to manually resume an AI pause, authorize/complete deletion/access/correction requests, or grant/re-opt-in consent categories interactively. Live verification of those reviewer transitions requires either separate future Admin UI/CLI implementation or approved private maintenance-container database/TypeScript invocation (not invented CLI flags).
3. **Gap G-3 — Content-Free DB Proof Wrapper:** No read-only `ops db-counts` CLI exists; run aggregate `SELECT count(*) ... GROUP BY ...` queries only from private maintenance container `psql` scope, recording only counts, enum outcomes, and synthetic correlation references (`work_ref`, `draft_ref`, `intent_ref`), never customer text or identifiers.

## 5. Ordered Current-Runtime Test Sequence (`P7-005`)

Execute sequentially from `T-01` upward. Use strictly authored synthetic inputs compliant with [`SYNTHETIC_FIXTURE_POLICY.md`](../SYNTHETIC_FIXTURE_POLICY.md). Store sanitized outcomes only (UTC timestamp, `<40-hex-rev>`, PASS/FAIL/BLOCKED, enum counts, latency bucket).

### `T-01` — Readiness, Tunnel Isolation & Unsigned / Bad-Body Rejection (`AC-11`, `AC-12`, `AC-18`)

- **Owner / Authorization:** Codex + Operator; requires approved successor `<40-hex-rev>` deployment.
- **Prerequisites:** Readiness Checklist items 1–8 satisfied; zero running `operations_job_pending` health holds.
- **Authored Synthetic Input:** Valid/invalid `GET /webhooks/meta` challenge query strings; unsigned, wrong-signature, invalid UTF-8, and `> 256 KiB` synthetic JSON payloads via `Gap G-1`; public requests to `/health` and `/knowledge`.
- **Command / Method:** `./scripts/verify-runtime.sh <40-hex-rev> <operations-config-file>` plus external HTTP probes against public tunnel ingress.
- **Expected Visible Result:** `verify-runtime.sh` exits `0`; bad challenge returns `403`; valid verification returns challenge string; missing/bad HMAC returns `401`; oversized/malformed JSON returns bounded `4xx`; `/health` and `/knowledge` return `404` on public tunnel.
- **Content-Free Proof:** Zero new rows in `webhook_receipts` / `webhook_events` for `401`/`4xx` probes; zero container host TCP ports (`compose.runtime.yml`).
- **Stop & Rollback / Manual Coverage:** Any `200` on unsigned webhook or non-`404` on `/health` stops `P7-005` immediately; keep public traffic halted or isolate ingress cleanly without affecting legacy `207a5e6` unless separately authorized; route support inquiries manually via Page/WhatsApp Business inbox.

### `T-02` — Private Admin Dashboard Login, MFA, Roles & All 7 Sidebar Modules (`AC-18`, `AC-19`, UI/A11y/Security)

- **Owner / Authorization:** Operator (`administrator`, `knowledge_editor`, `knowledge_reviewer`, `support_reviewer` test accounts provisioned via `npm run admin:bootstrap`).
- **Prerequisites:** Private `admin` healthy; loopback SSH tunnel active (`ssh -N -L 127.0.0.1:13004:<admin.sock>`); `ADMIN_ORIGIN=http://127.0.0.1:13004`.
- **Browser UI & Security Checklist (Static Script Scope Distinction):**
  - Note: [`scripts/verify-ui-ux-contract.ts`](../../scripts/verify-ui-ux-contract.ts) and [`scripts/verify-seo-contract.ts`](../../scripts/verify-seo-contract.ts) are **source-text scaffolds only** (`AGY_STRICT_UI_GATE=false`, `AGY_STRICT_SEO_GATE=false`; currently reporting 5 open UI scaffold items `UI-A11Y-001`, `UI-TOUCH-002`, `UI-THEME-003`, `UI-RESP-004`, `UI-A11Y-005` and 2 open SEO header scaffold items `SEO-ROBOTS-001`, `SEO-ROBOTS-002`). They do **not** verify rendered viewports, horizontal overflow, WCAG 2.2 AA contrast/focus, or live response headers. Live operator browser verification in this step supplies that missing proof.
  - Verify security controls across routes (`src/admin/admin-app.ts`): unauthenticated redirect to `/login`; scrypt password check -> `/mfa` Base32 TOTP check; cookies `fcd_admin_session` (`HttpOnly; SameSite=Strict`) and `fcd_admin_csrf` (`SameSite=Strict`); `cache-control: no-store`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: same-origin`, `cross-origin-resource-policy: same-origin`, strict nonce `content-security-policy`. Test rejected forged `Origin` header, mismatched `csrfToken`, missing/wrong `actionToken`, and `/logout` session invalidation.
- **All 7 Sidebar Modules (`src/admin/admin-html.ts:98-112`) — Empty State, Populated State, Role RBAC, Reviewer Actions:**
  1. **`/knowledge` (`knowledge_editor` + `knowledge_reviewer`):** All authenticated roles read `/knowledge`. Verify empty state before seeding; create synthetic bilingual FAQ (`GET /knowledge/new` -> `POST /knowledge`), verify `knowledge_editor` cannot approve/publish (`403`), `POST /knowledge/:versionRef/submit`, log in as `knowledge_reviewer` -> `POST /knowledge/:versionRef/review` (`approve` / `reject`), `GET/POST /knowledge/:versionRef/publish`, `retire`, and `rollback`.
  2. **`/questions` (`knowledge_editor` + read for authenticated):** Empty state -> trigger synthetic unanswered escalation (`T-05`) -> confirm populated question cluster appears without customer identifiers -> `knowledge_editor` submits synthetic answer (`POST /questions/:questionRef/answers`); non-editor fails RBAC (`403`).
  3. **`/insights` (any authenticated role read):** Empty state vs populated aggregated content-free topic/gap metrics after `node dist/operations-main.js learning`.
  4. **`/policy` (`administrator` only — others `403`):** Inspect active/empty `model_policy_versions`; test create -> `submit` -> `approve` -> `activate` -> `retire` via `POST /policy` and `POST /policy/:policyRef/:policyAction` with non-admin blocked (`403`).
  5. **`/escalations` (`support_reviewer` or `administrator` — editors/reviewers `403`):** Verify content-free counts grouped strictly by `reason_code` and `state` (`GET /escalations`). Confirm zero raw customer text rendered.
  6. **`/audit` (`administrator` only — others `403`):** Confirm bounded append-only `admin_audit_events` rows reflecting the preceding login, FAQ, policy, and acknowledgement actions cleanly without secrets.
  7. **`/operations` (`administrator` only — others `403`):** Verify private operations summary renders cleanly without exposing host credentials; if a seeded/test incident exists, test `POST /operations/incidents/:incidentRef/acknowledge` (`src/admin/operations-routes.ts`).
- **Desktop/Mobile Browser Check:** Inspect responsive wrapping at `>= 1280px` and `~390px` viewports, keyboard Tab navigation, visible focus states, and label contrast.
- **Stop & Rollback:** Any `500`, cross-role privilege bypass, weak cookie flags, or customer text rendering stops `T-02` and keeps `/knowledge` versions retired/rolled back.

### `T-03` — Messenger Received Message -> Eligible Bilingual FAQ Reply (`AC-01`, `AC-05`, `AC-22`)

- **Owner / Authorization:** Operator + Codex; test Facebook Page + app-role test Messenger user; `OUTBOUND_EXECUTION_ENABLED=true`.
- **Prerequisites:** `T-01` & `T-02` green; synthetic English & Bangla FAQ entries published on `/knowledge` (`knowledge_versions.state='published'`).
- **Synthetic Input:** One English synthetic inquiry and one Bangla synthetic inquiry matching published FAQ triggers, sent from test Messenger user (or signed synthetic Page webhook if device ingress blocked by app review -> record explicitly as `PARTIAL`).
- **Expected Visible Result:** Test Messenger user receives matching English / Bangla FAQ answer cleanly; zero hallucinations.
- **Content-Free Proof:** Check Stages 1-6 separately: `webhook_events.admission_outcome='pending'` -> `webhook_event_applications.outcome='customer_message_applied'` -> `support_reply_drafts.decision_type='faq'` (`language='en'|'bn'`, zero `model_call_leases` created!) -> `outbound_intents.state` advances `provider_accepted -> sent/delivered`.
- **Stop & Rollback:** If `decision_type='model'` ran on an exact FAQ match, stop and inspect FAQ normalization (`src/knowledge/faq-resolver.ts`).

### `T-04` — WhatsApp Test-Number Message -> Eligible Bilingual FAQ Reply (`AC-01`, `AC-05`, `AC-22`)

- **Owner / Authorization:** Operator + Codex; Meta-hosted WhatsApp **test number** only + test recipient number added in Meta App Dashboard.
- **Prerequisites:** `T-01`, `T-02`, `META_GRAPH_API_VERSION='v25.0'` active.
- **Synthetic Input:** Authorized test WhatsApp device sends one English synthetic FAQ question and one Bangla synthetic FAQ question to the Meta test number; repeat signed synthetic webhook delivery probe (`Gap G-1`) if verifying inbound ingress separately.
- **Expected Visible Result:** Physical test WhatsApp device receives both replies inside the 24h customer-service window.
- **Content-Free Proof:** Verify Stages 1-6 independently (`channel='whatsapp'`, `decision_type='faq'`, `outbound_attempts.state='provider_accepted'`, `outbound_status_events` progressing monotonically `sent -> delivered`).
- **Stop & Rollback:** Never switch to or touch the production WhatsApp number on failure; record exact stage where failure stopped (e.g., Stage 1 webhook missing vs Stage 5 Graph HTTP rejection).

### `T-05` — Model Fallback (`fcd-support` / `auto`), Sensitive-Data Redaction & Recording-Off Check (`AC-05`, `AC-10`, `AC-21`, `AC-22`)

- **Owner / Authorization:** Codex + Project Owner (Manifest recording-off attestation required first); `MODEL_EXECUTION_ENABLED=true`.
- **Prerequisites:** Published FAQ active; Manifest private `/v1` configured for harness `fcd-support`, `model='auto'`, `MANIFEST_RECORDING_DISABLED=true`.
- **Synthetic Input:**
  1. Unmatched synthetic product-support question in English and in Bangla (no FAQ match, non-sensitive).
  2. Prompt containing synthetic OTP/credential/payment-shaped sentinel (matching `docs/SYNTHETIC_FIXTURE_POLICY.md` invalid-example shapes).
  3. Conflicting/prompt-injection synthetic phrase trying to contradict published pricing/policy or request tool invocation.
- **Expected Visible Result:** (1) receives bounded helpful answer or safe failure (`decision_type='model'` or `'safe_failure'`); (2) & (3) return deterministic safe fallback/escalation without answering unsafe prompts or claiming tool access. Confirm Manifest dashboard shows zero stored request/response bodies.
- **Content-Free Proof:** Exactly 1 `model_call_leases` row per eligible unseen prompt; 0 `model_call_leases` for sensitive-redacted block (`support_reply_drafts.decision_type='safe_failure'`, `support_escalation_outcomes` count +1, `/escalations` shows updated aggregate count). Verify OpenClaw/Hermes accounts had zero hits.
- **Stop & Rollback:** Any raw prompt/body retained in Manifest or `model_call_leases` on FAQ/sensitive inputs immediately halts tests and disables `MODEL_EXECUTION_ENABLED`.

### `T-06` — Human Takeover Pause, Self-Echo Correlation & Manual Resume Gap (`AC-06`, `AC-29`)

- **Owner / Authorization:** Operator + Codex; Messenger Test Page first (`AC-29` WhatsApp coexistence stays **BLOCKED** until post-`P7-GATE` `P8-003/P8-004`).
- **Prerequisites:** `T-03` working cleanly.
- **Synthetic Input:**
  1. Bot replies via `T-03` -> confirm `outbound_echo_correlation_holds` suppresses AI's own Page echo (`webhook_event_applications.outcome='service_echo_correlated'`).
  2. Test Page operator posts one manual reply in Page Inbox -> send follow-up synthetic customer message within 24h -> confirm AI stays paused!
- **Expected Visible Result:** Customer gets no duplicate AI reply after staff takeover; `service_echo_correlated` does **not** falsely trigger a pause.
- **Content-Free Proof:** Step 1 records `service_echo_correlated` with unchanged `conversations.ai_paused_until`. Step 2 records `webhook_event_applications.outcome='business_echo_paused'`, 1 new `human_pause_events` row, and `conversations.ai_paused_until = echo_time + 24h`. Follow-up customer message stores receipt/application but schedules zero outbound reply while paused.
- **Gap Note & Rollback:** Mark **Gap G-2** for resume: `PostgresTakeoverPolicy` resume method exists in code only (no Admin UI button or `operations-main.ts` CLI yet); test early resume only under approved maintenance-container script or verify natural expiry in isolated test fixture.

### `T-07` — Duplicate Replay, Stale 5-Minute Boundary & Out-of-Order Status (`AC-03`, `AC-04`, `AC-13`, `AC-23`)

- **Owner / Authorization:** Codex + Operator (`Gap G-1` signed probe client).
- **Prerequisites:** `T-01`, `T-03`/`T-04` outbound baseline active; published synthetic FAQ ready.
- **Authored Synthetic Input:** Send one signed synthetic `POST /webhooks/meta` event twice identically, then identical logical event ID in mutated whitespace JSON; send synthetic event timestamped `> 300s` old (`stale`) and far-future skewed; send batch mixing unsupported media type alongside valid text; send signed WhatsApp status callbacks `delivered` before `sent`.
- **Expected Visible Result:** All signed probes return `200 EVENT_RECEIVED` (no crash or unhandled 500). Only the first valid event triggers one reply; unsupported sibling has zero side effect.
- **Content-Free Proof:** Exactly one row in `webhook_event_applications` & `outbound_intents` for duplicate replays; stale/skewed row recorded with `webhook_events.admission_outcome='stale'`; monotonic `outbound_intents.state` stays at `delivered` even when delayed `sent` webhook arrives later (`outbound_status_events` logs arrival cleanly).
- **Stop Condition & Rollback / Manual Coverage:** Duplicate replies or downgraded status stops `P7-005` immediately; disable `OUTBOUND_EXECUTION_ENABLED` via approved overlay and handle inquiries manually until deduplication/status ordering defect is resolved.

### `T-08` — Consent, `STOP MARKETING`, `REQUEST MY DATA` & `DELETE MY DATA` / Retention (`AC-07`, `AC-08`, `AC-17`, `AC-31`, `AC-33`, `AC-34`)

- **Owner / Authorization:** Project Owner + Codex (privacy workflow + `operations-main.js` sweep authorization).
- **Command / Input:**
  1. Synthetic customer sends exact `STOP MARKETING` (`src/policy/privacy-intent.ts:7`) -> verify all four marketing categories (`security_updates`, `product_updates`, `newsletter`, `product_offers` in [`src/outbound/outbound-eligibility.ts`](../../src/outbound/outbound-eligibility.ts#L71-L76)) are suppressed in `privacy_suppressions`.
  2. Synthetic customer sends exact `REQUEST MY DATA` -> verify `privacy_requests` hold blocks automated AI replies until closed.
  3. Synthetic customer sends exact `DELETE MY DATA` -> execute approved review & `node dist/operations-main.js deletion` (and verify scheduled `node dist/operations-main.js retention` behavior) -> replay signed event for deleted contact -> confirm tombstone suppression (`webhook_events.admission_outcome='suppressed'`) prevents data resurrection.
- **Gap Note (`Gap G-2`):** Interactive reviewer approval steps for deletion, access export (`REQUEST MY DATA`), typed correction (`CORRECT MY DATA`), and selective marketing re-opt-in have repository PostgreSQL store tests (`AC-31..AC-35`) but **no HTTP Admin UI or CLI command** yet — document missing operator tooling cleanly as blocked/manual-maintenance scope rather than improvising commands.
- **Content-Free Proof:** Aggregate counts only in `privacy_requests`, `privacy_suppressions`, `privacy_deletion_runs`, `retention_job_runs`, and `webhook_events` (`'suppressed'`). Zero raw export payload persisted (`privacy_access_runs` stores aggregate metrics only).

### `T-09` — Configurable Rate/Cost Bounds & Provider `429`/Outage (`AC-23`, `AC-25`)

- **Owner / Authorization:** Codex + Operator (`administrator` reviewing `/policy`).
- **Prerequisites:** Reviewed low synthetic limits active via `/policy` and `outbound_policy_versions`.
- **Authored Synthetic Input:** Send burst of synthetic test messages exceeding `MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES` (or outbound contact rate window), plus simulate provider error/cooldown window on test route.
- **Expected Visible Result:** Excess calls stop cleanly without unbounded loops; user receives bounded safe message/silence per policy; `/escalations` shows incremented aggregate escalation count; public webhook receiver stays responsive (`200`).
- **Content-Free Proof:** `model_usage_windows` / `outbound_rate_windows` enforce configured bounds; `outbound_attempts.state` records `'definitely_rejected'` / `'delivery_unknown'` cleanly without blind retry storms; zero leaks in logs.
- **Stop Condition & Rollback / Manual Coverage:** Unbounded retries or leak of provider error details halts worker execution (`MODEL_EXECUTION_ENABLED=false` / `OUTBOUND_EXECUTION_ENABLED=false`), restores prior active policy via `/policy`, and falls back to manual Page/WhatsApp inbox responses.

### `T-10` — Outage, Tunnel / Service Restart & Bounded Recovery (`AC-14`, `AC-26`, `AC-27`)

- **Owner / Authorization:** **Explicit separate Codex operational coordination required per outage step**; documentation alone never authorizes execution.
- **Prerequisites:** Healthy successor baseline (`T-01`–`T-09` passed or isolated explicitly) and verified manual inbox coverage ready before stopping any service.
- **Shared-Host Boundary:** Restart **only** the targeted private successor container (`postgres`, `webhook`, `reply`, `outbound`, or scoped test tunnel) — **NEVER** reboot host, restart Docker daemon, prune Docker networks/images, touch the `23` unrelated containers, or kill legacy `207a5e6` while active.
- **Authored Synthetic Input & Sequence:**
  1. Briefly stop private successor Postgres -> send signed synthetic probe -> verify public webhook returns `503` (never `200` before DB commit) -> restart successor Postgres -> replay signed probe -> succeeds once cleanly (`200` + single application).
  2. Briefly interrupt scoped test tunnel/app container during retry window -> restore -> replay -> confirm `webhook_receipts` / `outbound_intents` idempotency.
  3. Optional `N8N_EXECUTION_ENABLED` outage check (`AC-26`): keep DB as source of truth when n8n target is unreachable; core webhook/reply state remains intact.
- **Expected Visible Result & Content-Free Proof:** `503` without false `200`; zero duplicate `webhook_event_applications` / `outbound_intents` after replay; `operations_health_checks` returns healthy after recovery.
- **Stop Condition & Rollback / Manual Coverage:** Any `200` returned while DB stopped or duplicate send on recovery aborts gate; restore targeted container cleanly and continue manual Page/WhatsApp support coverage.

### `T-11` — Isolated Encrypted Backup, Checkpoint, Restore & Promotion Drill (`AC-09`)

- **Owner / Authorization:** Codex + Operator (`run-operation.sh` and restore scripts on private successor revision `<40-hex-rev>`).
- **Prerequisites:** `T-08` synthetic deletion tombstones present in `privacy_suppressions` / `privacy_deletion_runs`; sufficient free disk above admission floor.
- **Authored Synthetic Input & Commands:**
  1. `./scripts/run-operation.sh backup <40-hex-rev> <operations-config-file>`
  2. Confirm `operations_backups` + checkpoint reference (`node dist/operations-main.js checkpoint` / `export-checkpoint-reference`) with unexpired deletion tombstones from `T-08`.
  3. `./scripts/restore-runtime.sh <backup_[a-f0-9]{32}> <checkpoint_[a-f0-9]{32}> <40-hex-rev> <operations-config-file>`
  4. Verify isolated restore validates schema, reconciles tombstones (`restore_deletion_gates`), and blocks promotion if tombstones conflict; exercise `./scripts/promote-restore.sh` (or `./scripts/abandon-empty-restore.sh` for empty target) and verify rollback readiness via `./scripts/rollback-runtime.sh <40-hex-rev> --confirm-schema-compatible <operations-config-file>`.
- **Expected Visible Result & Content-Free Proof:** Deleted `T-08` synthetic identity remains suppressed post-restore; `operations_restore_runs` and `operations_deployments` show clean terminal status; host health remains clean with zero leaked backup volumes or orphan containers.
- **Stop Condition & Rollback / Manual Coverage:** Any un-suppressed deleted identity, uncleaned restore volume, or broken target health aborts promotion immediately; execute `./scripts/abandon-empty-restore.sh` / `./scripts/rollback-runtime.sh` without modifying source database or unrelated containers.

## 6. Version & Policy Reconciliation (`META_GRAPH_API_VERSION` `v25.0` vs `v26.0`)

| Surface                    | Exact repository behavior / version                                                                                                                            | Primary official Meta Graph lifecycle check                                                      | Current Phase 7 decision                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Outbound Graph API requests | Hard-pinned `META_GRAPH_API_VERSION = 'v25.0' as const` ([`src/outbound/outbound-config.ts`](../../src/outbound/outbound-config.ts#L13), [`src/outbound/meta-outbound-client.ts`](../../src/outbound/meta-outbound-client.ts#L132)) | Meta Graph API `v25.0` released `2026-02-18` (supported until `2028-07-29`); `v26.0` released `2026-07-29` | **Retain `'v25.0'`** verbatim for all Phase 7 outbound tests. Do **not** bump `'v25.0'` in docs or unapproved hotfixes |
| Inbound webhook payloads   | [`normalizeWhatsAppWebhook`](../../src/meta/normalize-whatsapp.ts) and [`normalizeMessengerWebhook`](../../src/meta/normalize-messenger.ts) inspect JSON shape without version-number gating | Historical `207a5e6` probe (`AC-01`, `AC-28`) tested `v26` synthetic webhook samples on app dashboard | Tolerated cleanly on inbound; historical `v26` test webhook probe does **not** authorize bumping outbound `v25.0` pin  |
| Promotion / Production cut | Explicit upgrade & permission check assigned to `P8-002` ([`docs/TODO.md`](../TODO.md))                                                                         | Version mismatch recorded previously as an open tracker blocker (`AC-28`)                        | Record active Meta app webhook subscription version alongside `'v25.0'` outbound pin during `P7-005`; defer upgrade to `P8-002` |

## 7. Shared-Host Preservation & Completion Rules

- **Explicit Non-Goals & Prohibited Actions:** Zero full-host reboots, zero `systemctl restart docker`, zero `docker system prune` / `docker network prune`, zero mutation to the `23` unrelated containers, zero changes to `docs/TODO.md` / `docs/PROJECT_CONTEXT.md` without Codex gate sign-off, zero proposal of public Trust Center (`US-105`), CRM inbox, or unapproved n8n workflows, and **zero production WhatsApp number or live Page changes**.
- **Gate Closure Rule:** `P7-005` and `P7-GATE` stay `BLOCKED` until Codex dispositions server disk capacity (`>= 12 GiB`) and the held health job, deploys an approved isolated successor `<40-hex-rev>`, completes `T-01` through `T-11` cleanly with sanitized evidence, and reviews final proof.
