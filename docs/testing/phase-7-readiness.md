# Phase 7 Acceptance Readiness Evidence Matrix

Date: 2026-11-03 (Asia/Dhaka)  
Author: AGY  
Branch: `codex/agy-p7-readiness`  
Base: `a39fbc387a35b5702b67a57b855c28ea0280f016` (`origin/main`)  
Context: Follows `docs/handoffs/2026-11-02-antigravity-phase-7-readiness.md` and Priority 2 of `docs/handoffs/2026-11-03-antigravity-priorities.md`.

---

## 1. Scope, Status, And Authority Boundaries

### 1.1 Authority And Non-Delegation
- This document is an evidentiary review and readiness planning matrix only.
- No tracker row, gate (`P6-GATE`, `P7-GATE`), or acceptance decision is closed by this document.
- Codex retains exclusive operational authority over the shared server, SSH execution, container runtime, live external integrations, gate approval, and production promotion.
- No SSH commands, shared-server Docker commands, DNS/tunnel modifications, Meta/Manifest API calls, account logins, or production actions occurred or are authorized by this review.

### 1.2 Historical Baseline vs. Current Runtime Reality
- Historical tasks P7-001 through P7-004 were completed in August 2026 under a narrow, recorded non-production test-asset exception at revision `207a5e6`. That historical execution does **not** establish the readiness of the current Phase 6 private runtime, nor does it authorize attaching current workers to those assets.
- Task 16 and root-timer repair closeout completed in repository source at `24e5667` (PR #8). However:
  1. A subsequent recurring-health incident occurred on the test server, holding scheduled operations (`docs/operations/incidents/2026-11-03-recurring-health-uncertainty.md`).
  2. Missing PostgreSQL column SELECT grants on the admin role broke `/questions`, `/insights`, and `/escalations` with HTTP 500 errors (addressed in draft PR #9 on branch `codex/agy-admin-dashboard-permissions`).
  3. Health transport stress and log read failure classification were verified synthetically in draft PR #10 on branch `codex/agy-p6-health-transport-stress`.
  4. Older preserved incident scopes and actor-loss records remain open on the server.
- The system remains pre-implementation for Phase 7 live execution until Codex resolves the server incident hold and accepts Phase 6 closeout.

---

## 2. Phase 7 Acceptance Evidence Matrix

| Item ID | Requirement / Gate | Existing Local / Native / CI Proof | Historical External Proof (August 2026, `207a5e6`) | Missing Current Live / Manual Proof (Phase 7 Scope) | Critical Evidence Distinctions | Dependencies & Prerequisites | Owner & Approval Boundary |
|---|---|---|---|---|---|---|---|
| **AC-01** | Meta test number verification and device delivery | `tests/meta/verify-subscription.test.ts`, `tests/meta/verify-signature.test.ts`, `tests/app.test.ts` verify challenge response and signature rejection | Callback, subscription, and signed v26 synthetic samples passed (`docs/operations/test-deployment.md`) | Delivery from real WhatsApp test-number physical device to webhook and reverse delivery to device | **Signed synthetic public probes ≠ Meta device delivery.** Synthetic curl probes prove payload parsing and signature validation; they do not prove Meta carrier/device routing or unpublished-app access permissions | Development app setup; test number active; no production number mutation | Operator + Codex / P7-005, P7-GATE |
| **AC-02** | Signature rejection | `tests/meta/verify-signature.test.ts`, `tests/app.test.ts` prove 401 on missing/mangled HMAC without touching database sink | Deployed unsigned probe returned 401 (`docs/operations/test-deployment.md`) | Verified on current Phase 6 ingress deployment | Pinned HMAC verification against raw bytes before JSON parse; sink never receives rejected payload | Current Phase 6 runtime deployed behind Cloudflare Tunnel | Codex / Regression Gate |
| **AC-03** | Duplicate / retry deduplication | `tests/integration/postgres-receipt-store.test.ts`, `tests/integration/durable-runtime.test.ts` | Deployed exact retry probe returned HTTP 200 without duplicate action (`docs/operations/test-deployment.md`) | Deployed worker duplicate rejection under live concurrency and network latency | Single logical database transaction; duplicate webhook event ID yields HTTP 200 with zero side effects | Authoritative PostgreSQL running; webhook dedup table active | Codex / Regression and P7-005 |
| **AC-04** | Stale event handling | `tests/integration/postgres-receipt-store.test.ts`, `tests/integration/postgres-conversation-event-processor.test.ts`, `tests/integration/postgres-retention-policy.test.ts` | Stale synthetic payload rejected locally; deployed stale check was simulated | Real downtime / restart followed by delayed delivery from Meta | **Local test clock ≠ real downtime.** Stale events (>5m skew) must persist minimal non-actionable receipts without triggering inference or extending retention | P6-GATE; running server time synchronization | Codex / Regression and P7-005 |
| **AC-05** | Bilingual answer quality (English / Bangla) | 35-case synthetic corpus (`tests/fixtures/phase4-evaluation.json`, `tests/phase4-evaluation.test.ts`, `docs/testing/phase-4-evaluation-review.md`) scores 100% on invariant checks | Scripted evaluation only; self-reviewed | Independent human scoring of real model responses; live threshold approval (100% safety, >=90% accuracy) | **Local mock model responses ≠ live Manifest inference.** Local fakes verify format, grounding checks, and prompt assembly; live bilingual evaluation requires real provider outputs scored by human reviewers | Manifest dedicated harness `fcd-support`; model `auto`; recording-off attestation | Project Owner + Codex / P4-GATE, P7-005 |
| **AC-06** | Human takeover & echo correlation | `tests/integration/postgres-takeover-policy.test.ts`, `tests/integration/postgres-outbound-echo-correlation.test.ts` (11 cases) | Page manual echo reached admission only | Test Page manual staff echo processed by live worker, applying 24-hour pause, blocking automated replies, and private resume | **Messenger echo ingestion ≠ applied human pause.** Ingesting an echo into the database is not proof that the running reply worker actually paused automated dispatches for that contact | Active Messenger test Page; live outbound worker | Codex + Operator / P5-GATE, P7-005 |
| **AC-07** | Opt-in / Opt-out enforcement | `tests/integration/postgres-consent-policy.test.ts`, `tests/integration/postgres-outbound-privacy-interactions.test.ts` | None (tested strictly on synthetic PostgreSQL fixtures) | Live user sends `STOP MARKETING`, verifying immediate suppression of outbound queue | Locked authorization recheck at send-time; opt-out cancels pending template intents; re-opt-in leaves them terminal | Live outbound worker; database consent schema | Codex / P5-GATE, P7-005 |
| **AC-08** | Verified deletion & tombstone creation | `tests/integration/postgres-deletion-policy.test.ts`, `tests/integration/postgres-receipt-store.test.ts` | None | Live deletion request initiated via test channel, reviewer approved, verifying local erasure and resurrection resistance | Verified identity erased; minimal suppression tombstone; subsequent webhook events do not resurrect data | Dedicated admin role with deletion approval capability | Codex + Project Owner / P3-GATE, P7-005 |
| **AC-09** | Backup, isolated restore, and rollback | `tests/integration/postgres-isolated-restore.test.ts`, `tests/deletion-checkpoint.test.ts`, Task 15 failure coverage (PR #3 `df8e52d`), PR #4 (`c74b6f4`) | Historical server drill (`67a4a4b`, `3f22344`) proved backup/restore/promote | Full-host reboot drill and live test-stack recovery | **Local process restart ≠ full-host outage.** Process exit and restart does not verify systemd auto-start, volume mount order, or dirty reboot state | Task 16 server deployment; root timer fix | Codex + Operator / P6-004, P6-GATE, P7-005 |
| **AC-10** | Model fallback & provider outage | `tests/manifest-client.test.ts`, `docs/testing/phase-4-evaluation-review.md` | None (tested strictly against local fake Manifest) | Live provider timeout, rate limit (429), or complete outage falling back to secondary provider or safe escalation | **Local fake responses ≠ live multi-provider fallback.** Local tests prove fail-closed logic and escalation generation; live drill proves actual network timeout handling and provider rotation | Manifest multi-provider configuration; fallback rules approved | Codex + Project Owner / P4-GATE, P7-005 |
| **AC-14** | Durable storage before webhook ack | `tests/integration/durable-runtime.test.ts`, `tests/runtime.test.ts` | Observed during initial deployment | Live database container paused or stopped during incoming webhook delivery | Webhook must return HTTP 503 before timeout; zero uncommitted events acknowledged with 200 | Current Phase 6 Docker Compose stack | Regression + P7-005 Outage |
| **AC-17** | Retention anchors & scheduled purging | `tests/policy/retention-policy.test.ts`, `tests/integration/postgres-retention-policy.test.ts`, `tests/integration/postgres-retention-job.test.ts` | None | Live scheduled maintenance job executing retention purge against stale test rows | Anchors strictly enforced (60d conversation, 12m interaction, 24m active client); purged content removed | Stable scheduled maintenance operations | P3-GATE, P7-005 |
| **AC-18** | Public route isolation & network ingress | `tests/deployment-contract.test.ts`, `tests/admin-socket.test.ts`, `scripts/verify-runtime.sh`, topology report (`docs/testing/2026-11-02-phase-6-local-topology.md`) | Ingress 404 on `/health` and non-webhook paths verified | Live Cloudflare Tunnel endpoint verification from public internet | Only `GET/POST /webhooks/meta` exposed; `/health` returns 404; admin runs strictly on Unix socket (`admin.sock`) | Cloudflare Tunnel configured with catch-all 404 | P6-GATE + P7-005 |
| **AC-21** | Manifest privacy, tool isolation, and recording-off | `tests/manifest-client.test.ts` enforces `fcd-support` harness, `auto` model, tool denial, and pattern redaction | None | Signed attestation confirming Manifest recording/logging is disabled; private network inspection | Models receive zero tools; sensitive data redacted before inference; Manifest runs on isolated overlay network | Manifest recording-off configuration; network inspection | P4-GATE, P6-GATE, P7-005 |
| **AC-22** | FAQ precedence & sensitive data redaction | `docs/testing/phase-4-evaluation-review.md`, `tests/fixtures/phase4-evaluation.json` | None | Live customer inquiry matching FAQ answers verbatim without calling model; inquiry with OTP/credential redacted before inference | Approved FAQ takes precedence; prohibited sensitive patterns (credit cards, passwords, OTPs) never reach model | Verified knowledge base in PostgreSQL | P4-GATE, P7-005 |
| **AC-23** | Outbox / provider exactly-once behavior | `docs/testing/phase-5-outbound-evidence.md` | None | Live test message sent through Meta Graph API once; worker crash/restart does not duplicate send | **Local provider fakes ≠ real sends.** Local fake loopback tests lease locks and retry state machines; real send verifies Graph API idempotency and message ID capture | Live Meta Graph API credentials for test assets | P5-GATE, P7-005 |
| **AC-24** | Send-time eligibility recheck | `tests/integration/postgres-outbound-intent-store.test.ts`, `tests/integration/postgres-outbound-flow.test.ts` | None | Live worker halts queued outbound dispatch if consent is revoked or human pause is activated during queue dwell | Recheck occurs in the same transaction as dispatch authorization; denial leaves zero outbound side effect | Live outbound worker | P5-GATE, P7-005 |
| **AC-25** | Rate and cost limits | Local unit and limit configuration tests | None | Synthetic traffic burst triggering per-contact and per-account rate limiting and backoff | Limits enforced before model or provider calls; aggregate alerts generated without leaking message bodies | Configured rate-limiter thresholds | P4/P5/P6 Gates, P7-005 |
| **AC-26** | n8n boundary & failure isolation | `tests/n8n-client.test.ts`, `tests/integration/postgres-notification-flow.test.ts` | None | Live n8n instance stopped while notification queue accumulates; stack remains fully operational | n8n has zero access to conversation or consent state; failure does not block core support operations | Dedicated n8n test instance or mock endpoint | P6-GATE, P7-005 |
| **AC-27** | Tunnel / server outage and recovery | Local process restart tests | None | Live test of host reboot, tunnel disconnection, and server recovery runbook | Clean recovery; pending webhook replays processed without duplicates; zero stale jobs remain uncertain | Documented operator recovery runbook | P7-005 |
| **AC-28** | Meta Graph API version & permissions | Supported-version decision records | Development app token verified in August 2026 | Verification of Graph API v26.0 compatibility and non-expired test token | Least-privilege permissions only; expired tokens refreshed via documented rotation drill | Active Meta Developer account | P7-GATE, P8-002 |
| **AC-29** | WhatsApp coexistence verification | Documented architecture boundary | None | Verification of WhatsApp Business coexistence eligibility without mutating production number | **Test number ≠ production number coexistence.** Test number proves webhook pipeline; coexistence requires specific Meta Business account eligibility check | Dedicated read-only check script | P8-003, P8-004, P8-GATE |
| **AC-31..35** | Privacy rights policy & concurrency | `tests/integration/postgres-access-export.test.ts`, `tests/integration/postgres-correction-policy.test.ts`, `tests/integration/postgres-marketing-opt-out-policy.test.ts`, `tests/integration/postgres-privacy-rights-policy.test.ts` | None | Live privacy request lifecycle initiated via test channel, approved, and verified | Strict transactional boundaries, advisory locks, content-free audit logs, zero data leakage | Authenticated admin session; verified roles | P3-GATE, P5-004, P7-005 |

---

## 3. External Integration Prerequisites

Before any live worker or test asset is connected, the following external prerequisites must be explicitly satisfied and verified:

### 3.1 Manifest Inference Engine
1. **Recording-Off Attestation**: Written confirmation that request/response body logging, prompt caching, and persistent tracing are disabled on the Manifest deployment (`recording: false`).
2. **Dedicated Harness Configuration**: Exclusive use of harness `fcd-support` requesting model `auto`.
3. **Tool Isolation**: Models receive zero tools (`tools: []`). The inference interface is restricted to pure text-in/text-out prompting.
4. **Redaction Pipeline**: Sanitization filter active before inference. Credentials, passwords, credit card patterns, OTPs, and incident details are replaced with redaction markers.
5. **Network Boundary**: Manifest reachable only over the private Docker internal bridge network (`model` overlay); zero external or host port exposure. Models remain completely disabled in Phase 6 runtime (`--mode private-disabled`).
6. **Configured Provider Fallbacks & Limits**: Approved timeout (<=5000ms), max token limits, and strict provider fallback order (Primary -> Secondary -> Safe Escalation).

### 3.2 Meta Development Platform
1. **Asset Isolation**: Restricted strictly to the development App, test WhatsApp Business number, and test Messenger Page.
2. **Production Number Guard**: The production WhatsApp number must remain untouched. No linking, unlinking, migration, or re-registration is authorized.
3. **Version Alignment**: Graph API pinned to supported version `v26.0`.
4. **Token Security**: Pinned token rotation runbook; zero credentials committed or displayed in logs.

### 3.3 Cloudflare Tunnel & Ingress
1. **Path-Restricted Ingress**: Only `GET /webhooks/meta` and `POST /webhooks/meta` mapped to the application container.
2. **Ingress Catch-All**: Pinned catch-all rule `http_status:404` for all other traffic.
3. **Private Routes**: Admin (`/admin`), PostgreSQL (5432), health internal routes, n8n, and Manifest must remain completely private with zero public tunnel ingress.

### 3.4 PostgreSQL State Store
1. **Authoritative Ownership**: PostgreSQL owns all conversation, consent, outbox, and audit state. n8n and Manifest are unprivileged clients.
2. **Admin Dashboard Grants**: Application of column-scoped SELECT grants to the `admin` role for `/questions`, `/insights`, and `/escalations` (Priority 0, PR #9).
3. **Scheduled Operations Transport**: Full resolution of the recurring health uncertainty incident and validation of health transport diagnostics (Priority 1, PR #10).

---

## 4. Test Categorization & Execution Feasibility

### 4.1 Tests Requiring Real Test Assets Or Human Actions
1. **Real Meta Device Send (AC-01)**: Requires a physical phone sending WhatsApp messages to the test number to verify carrier and Meta routing to unpublished webhooks.
2. **Messenger Staff Takeover Echo (AC-06)**: Requires human operator manually replying in Messenger Page Inbox, verifying incoming echo triggers 24h automated reply pause.
3. **Bilingual Evaluation Scoring (AC-05)**: Requires human reviewer scoring real model outputs in English and Bangla against ground truth FAQ facts.
4. **Token Rotation Drill (AC-28)**: Requires operator executing live token renewal without service interruption.

### 4.2 Tests Reusable Via Existing Automated Scripts
1. **Synthetic Deployment & Topology (AC-18)**: Reusable via `scripts/test-synthetic-runtime-deployment.sh` and `scripts/verify-runtime.sh`.
2. **Encrypted Backup & Restore (AC-09)**: Reusable via `scripts/test-encrypted-backup.sh`.
3. **Signature & Subscription Validation (AC-02, AC-11)**: Reusable via `tests/meta/verify-subscription.test.ts` and `tests/meta/verify-signature.test.ts`.
4. **Receipt Deduplication & Concurrency (AC-03, AC-35)**: Reusable via `tests/integration/postgres-receipt-store.test.ts` and `tests/integration/postgres-privacy-rights-interactions.test.ts`.

### 4.3 Tests Currently Lacking An Execution Procedure
1. **Full-Host Outage & Reboot Drill (AC-09, AC-27)**: Requires a dedicated runbook specifying dirty power-loss simulation, filesystem integrity checks, systemd container recovery order, and state synchronization.
2. **Live Multi-Provider Fallback Drill (AC-10)**: Requires a runbook for injecting real network drops or invalid API responses at the Manifest boundary to observe live fallback to secondary providers.
3. **Rate-Limit Saturation Drill (AC-25)**: Requires a traffic generation harness that simulates burst limits without exceeding external provider spending budgets.

---

## 5. Recommended Smallest Next Work Package

Do **not** implement this package now. Once Phase 6 closeout is accepted by Codex:

**Package Title**: *Phase 7 Test-Asset Preflight & Ingress Verification*
1. **Scope**:
   - Re-verify Cloudflare Tunnel ingress rules from external network ensuring catch-all 404 holds.
   - Execute read-only token and API version check for Meta test assets (`v26.0`).
   - Obtain formal written confirmation of Manifest recording-off configuration.
   - Draft the execution runbook for the physical WhatsApp test device delivery and Page echo tests.
2. **Boundaries**:
   - Zero production data or number mutations.
   - Models remain disabled until Manifest preflight passes.
   - No autonomous live runs without explicit Codex and Operator authorization.
