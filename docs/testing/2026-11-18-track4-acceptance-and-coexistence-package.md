# Track 4 Acceptance Runbook Package (`T-01`–`T-11`) and Phase 8 Coexistence Decision Package (2026-11-18)

**Branch:** `codex/track3-4-approval-packages` (stacked on PR #25–#29: Track 1 + Tracks 2A/2B/2C/2D)  
**Gate Disposition:** `P1-GATE`, `P7-003` (current `v1`), `P7-004` (current `v1`), `P7-005`, `P7-GATE`, `P8-001`–`P8-005`, `P8-GATE`, `PROD-001`, and `PROD-002` remain **strictly `BLOCKED`** pending explicit owner approvals and live execution. Zero self-approval is claimed or permitted.

---

## Part 1: Phase 7 `T-01`–`T-11` Acceptance Execution Checklist & Evidence Template (`P7-005` -> `P7-GATE`)

Execute strictly sequentially on `redwan@192.168.10.40` only **after** Track 3 Packages 3A–3C are explicitly approved and passing. Record **sanitized metadata only** (UTC timestamp, `<APPROVED_40_HEX_REVISION>`, `PASS`/`FAIL`/`BLOCKED`, aggregate `db-counts`, latency bucket). Never paste tokens, passwords, MFA seeds, phone numbers, chat bodies, or raw webhook payloads.

### Prerequisites Check Before Starting `T-01`

- [ ] `P1-GATE` reviewed and approved by Project Owner ([`docs/reviews/phase-1-gate.md`](../reviews/phase-1-gate.md)).
- [ ] Package 3A deployed at `<APPROVED_40_HEX_REVISION>` (`--mode private-disabled` verified first; `--mode private-enabled` verified with `N8N_EXECUTION_ENABLED=false` for `T-03`–`T-11`).
- [ ] Package 3B public tunnel bound ONLY to `^/webhooks/meta$` -> `http://fcd-support-api:3003` with final `http_status:404`.
- [ ] Package 3C connected ONLY to Meta test WhatsApp number + Meta test Facebook Page; production assets untouched.
- [ ] Official website imported into **drafts only** via `/knowledge`, reviewed by owner, and explicitly published before FAQ evaluation.
- [ ] Separate staff accounts created via `--provision-stdin` (`administrator`, `knowledge_editor`, `knowledge_reviewer`, `support_reviewer`).

### Sequential Acceptance Matrix (`T-01` Through `T-11`)

| Step   | Acceptance Scope (`AC-*`)                                                                                               | Verification Commands & Test Procedure                                                                                                                                                                                                                                                                                                                            | Required Pass Criterion (Zero Relaxation)                                                                                                                                                                                                       | Status    | Sanitized Ref / Evidence Slot             |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------- |
| `T-01` | Tunnel isolation, `GET`/`POST /webhooks/meta` (`AC-02`, `AC-11`, `AC-12`, `AC-18`)                                      | Run `node dist/meta/webhook-probe-main.js` for `verify` (`200`), `--invalid-token` (`403`), `closed-route /health` & `/login` (`404` ingress-only), `post` `unsigned`/`invalid` (`401`), and `--allow-oversized` (`413`).                                                                                                                                         | Public tunnel exposes `/webhooks/meta` only; bad signatures and oversized bodies return `4xx` with `0` `db-counts` side effects.                                                                                                                | `BLOCKED` | `<UTC / count diff / PASS\|FAIL>`         |
| `T-02` | Private Admin UI, MFA, RBAC & all controls (`AC-16`, `AC-18`, `AC-19`)                                                  | Over `ssh -L 127.0.0.1:13004:...`, test password+MFA login, invalid Origin/CSRF rejection (`403`), RBAC boundaries across 4 roles, official website draft import + publish, `/controls` pause/resume/privacy/consent/templates, and `/policy` gateway test.                                                                                                       | Zero `500` errors, zero RBAC bypasses, zero unapproved auto-published website facts; protected gateway config edits and tests work cleanly.                                                                                                     | `BLOCKED` | `<UTC / role checks / PASS\|FAIL>`        |
| `T-03` | Messenger Test Page -> bilingual FAQ reply (`AC-01`, `AC-05`, `AC-15`, `AC-22`)                                         | Send physical/role-scoped English and Bangla queries matching approved published FAQs on the Messenger Test Page.                                                                                                                                                                                                                                                 | Direct Messenger delivery within SLO; `0` `model_call_leases` consumed (`faq` precedence); language matches customer prompt.                                                                                                                    | `BLOCKED` | `<UTC / db-counts / PASS\|FAIL>`          |
| `T-04` | WhatsApp Test Number -> bilingual FAQ reply (`AC-01`, `AC-05`, `AC-15`, `AC-22`)                                        | Send English and Bangla queries matching published FAQs from a test-role phone to the dedicated WhatsApp test number (`META_GRAPH_API_VERSION=v25.0`).                                                                                                                                                                                                            | Real device reply arrives; `0` `model_call_leases` used for approved FAQ; production WhatsApp number completely unaffected.                                                                                                                     | `BLOCKED` | `<UTC / db-counts / PASS\|FAIL>`          |
| `T-05` | Model fallback (`fcd-support`/`auto`), OCR/STT/PDF & bilingual eval (`AC-05`, `AC-10`, `AC-21`, `AC-22`)                | Send non-FAQ EN/BN text, synthetic OTP-bearing message, sample English/Bangla image/PDF/audio attachment (including visual-only/sensitive fallback cases), and external OpenAI-compatible profile positive-budget cap + fallback drill. Evaluate outputs via independent human reviewer against [`phase-4-evaluation-review.md`](./phase-4-evaluation-review.md). | Secrets redacted before inference; image/PDF/STT extracted cleanly without bypassing redaction; visual-only/sensitive attachments escalate; `0` Manifest stored bodies; independent score `>= 90%` accuracy, `100%` safety, `0` critical fails. | `BLOCKED` | `<UTC / review score / PASS\|FAIL>`       |
| `T-06` | Human takeover pause, self-echo correlation & manual resume (`AC-06`, `AC-29`)                                          | Trigger bot reply -> confirm `service_echo_correlated` does **not** set `ai_paused_until`. Then manually reply on Messenger Test Page -> confirm `24h` pause blocks AI replies -> resume from private `/controls` UI -> confirm bot resumes. (`AC-29` WhatsApp coexistence stays excluded until `P8-003`).                                                        | Only human business echoes pause AI for `24h`; queued replies respect send-time pause recheck; operator resume works cleanly from `/controls`.                                                                                                  | `BLOCKED` | `<UTC / db-counts / PASS\|FAIL>`          |
| `T-07` | Duplicate replay, 5m stale event, mixed sibling & out-of-order status (`AC-03`, `AC-04`, `AC-13`, `AC-23`)              | Replay identical webhook (`webhook-probe-main.js`), deliver `> 300s` stale payload and `> 60s` future payload, mixed batch with unsupported contact card, and out-of-order `delivered`/`read`/`sent` statuses.                                                                                                                                                    | Exact replay yields `200` and `0` duplicate drafts/sends; stale/future events do not trigger replies or move retention anchors; statuses converge monotonically.                                                                                | `BLOCKED` | `<UTC / db-counts / PASS\|FAIL>`          |
| `T-08` | Consent (`STOP MARKETING`), privacy access/correction/deletion & retention (`AC-07`, `AC-08`, `AC-17`, `AC-31`–`AC-35`) | Test `STOP MARKETING` -> confirm cross-scope campaign suppression; test private `/controls` re-opt-in with template policy; run access review (`<= 24h` in-memory disclosure), deletion approval + erasure + resurrection probe, and `retention` boundary check.                                                                                                  | Suppressed targets blocked at send-time; deletion erases live tables and tombstone prevents resurrection across subsequent events.                                                                                                              | `BLOCKED` | `<UTC / db-counts / PASS\|FAIL>`          |
| `T-09` | Rate/cost limits, positive budget enforcement & Meta error/cooldown (`AC-23`, `AC-24`, `AC-25`)                         | Trigger contact/account/global caps, positive gateway `budgetUsd` exhaustion, simulated Meta `429`/timeout failure, and pause/opt-out race during outbox dwell.                                                                                                                                                                                                   | Positive budget stops external inference accurately; `outbound_attempts` records terminal `delivery_unknown`/`definitely_rejected` without retry storms; send-time race cancels pre-I/O; `/escalations` increments cleanly.                     | `BLOCKED` | `<UTC / escalations / PASS\|FAIL>`        |
| `T-10` | Postgres outage (`503`), tunnel drop, container restart & recovery (`AC-14`, `AC-26`, `AC-27`)                          | Stop Postgres briefly while firing signed `POST /webhooks/meta`; restore Postgres, stop/restart tunnel and app containers cleanly; verify `verify-runtime.sh --mode private-enabled`.                                                                                                                                                                             | DB down returns `503` (zero fake `200` ACKs); recovery leaves `0` duplicates, `0` lost accepted receipts, and `N8N_EXECUTION_ENABLED=false` safe.                                                                                               | `BLOCKED` | `<UTC / health snapshot / PASS\|FAIL>`    |
| `T-11` | Encrypted backup, subsequent deletion, older-archive isolated restore & promotion (`AC-09`)                             | Capture encrypted backup -> execute new deletion tombstone -> export fresh deletion checkpoint -> run isolated restore of older archive -> reapply tombstones -> confirm promotion gate passes or blocks cleanly without source leak. Also run Package 3D timer alignment check.                                                                                  | Pre-deletion archive never resurrects erased customer on restore; `verify-systemd-units.sh` prints `systemd_units_aligned=true`.                                                                                                                | `BLOCKED` | `<UTC / backup & unit hash / PASS\|FAIL>` |

### `T-01`–`T-11` Sanitized Evidence Record Block (Copy & Fill at Execution)

```text
Execution Window (UTC): <START_ISO> .. <END_ISO>
Approved Source Commit: <40_HEX_REVISION>
Deployment Mode Verified: <--mode private-disabled | --mode private-enabled>
N8N Execution Enabled: false
Total Pass / Fail / Blocked: <P> / <F> / <B>
Independent Bilingual Review Score (AC-05): <ACC>% accuracy | <SAF>% safety | <CRIT> critical
Pre/Post db-counts Snapshot Diff (content-free): <SUMMARY>
Open Incidents / Dispositions: <NONE or SANITIZED_REF>
```

---

## Part 2: Phase 8 Prerequisites, Read-Only Coexistence Check, and Go/No-Go Package (`P8-001`–`P8-005` -> `P8-GATE`)

Every Phase 8 task below remains **`BLOCKED`** until **`P7-GATE`** passes cleanly in [`docs/TODO.md`](../TODO.md). Phase 8 **never** authorizes production onboarding (`PROD-001` and `PROD-002` remain separate after `P8-GATE`).

### 2A. Required Governance & Operational Closures (`P8-001`, `P8-002`, `P8-005`)

- [ ] **`P8-001` — Legal & Website Disclosure Sign-Off (Owner):** Approve public disclosure wording on website/support entrypoints covering AI assistance, external model inference (`Manifest fcd-support` / approved gateway profile), retention windows (`60` days casual, `12` months unconverted lead, relationship + `24` months active client), verified deletion & suppression tombstones, explicit marketing opt-in/opt-out, and human escalation.
- [ ] **`P8-002` — Meta App Review, Permissions & Token Ownership (Operator):** Record approved Meta permissions (`whatsapp_business_messaging`, `pages_messaging`, etc.), token custodian accounts, rotation cadence, and pinned `META_GRAPH_API_VERSION=v25.0` support window expiration date.
- [ ] **`P8-005` — Operational Ownership Matrix (Owner + Operator):** Record completed optional n8n consumer dependency audit (`N8N_EXECUTION_ENABLED=false` stays default unless separately approved), named backup & quarterly restore owner, named escalation/on-call operator for private dashboard monitoring, and manual WhatsApp/Messenger handling SLA.

### 2B. Read-Only Production WhatsApp Coexistence & Manual-Echo Eligibility Check (`P8-003` & `P8-004`)

**Target:** Production WhatsApp Business Account (WABA) and business phone number.  
**Strict Rule:** Obtain explicit read-only external-inspection approval immediately before checking the production asset. **Never** unlink, migrate, register, re-verify, subscribe, or alter webhooks on the production number during Phase 8.

1. **`P8-003` — Non-Mutating Coexistence Eligibility Verification:**
   - Perform read-only inspection via Meta Business Suite / Meta Business Manager / read-only Graph API metadata query confirming whether the exact production WhatsApp Business app registration and WABA are officially eligible for **WhatsApp Business Cloud API Coexistence** without losing phone history or business-app access.
   - Record eligibility result (`ELIGIBLE` vs `UNAVAILABLE` / unsupported region / app version prerequisite) cleanly without printing phone identifiers, WABA IDs, or access tokens into Git.
2. **`P8-004` — Manual-Reply Echo Mirroring Signal Verification:**
   - Confirm whether manual agent replies sent directly from the WhatsApp Business mobile/desktop app under Coexistence reliably deliver the expected business-reply webhook mirror/echo payload containing distinguishable business-message correlation needed by `fcd-support` to distinguish manual staff replies (`business_echo_paused` -> 24-hour AI pause) from automated service replies (`outbound_echo_correlation_holds` -> unchanged pause).
3. **Mandatory Hard-Stop and Migration Decision Boundary (`AGENTS.md` / `docs/PLAN.md`):**
   - **IF `P8-003` finds Coexistence is unavailable OR `P8-004` cannot prove reliable manual-reply webhook mirroring for the 24-hour AI pause signal:**
     - **STOP ALL PRODUCTION-NUMBER WORK IMMEDIATELY.**
     - Do **not** alter, disconnect, migrate, or re-register the production WhatsApp number.
     - Record `NO-GO (Coexistence/Manual-Echo Signal Unavailable)` in `P8-003`/`P8-004` and escalate for a separate business decision (e.g., dedicated Cloud API number or pure Meta Business Suite manual staffing without Coexistence).
   - **Rollback for `P8-003`/`P8-004`:** Because these checks are strictly read-only, zero server, tunnel, Meta subscription, or number state changes occur; stopping leaves the existing production WhatsApp Business operation completely unchanged.

### 2C. Phase 8 Gate Sign-Off Block (`P8-GATE`)

```text
Gate Item: P8-GATE (docs/TODO.md)
Prerequisites: P7-GATE=COMPLETE AND P8-001..P8-005=COMPLETE
Coexistence Eligibility (P8-003): <ELIGIBLE | UNAVAILABLE | BLOCKED>
Manual-Reply Echo Pause Signal Proven (P8-004): <PROVEN | UNPROVEN | BLOCKED>
Owner Decision: <GO TO SEPARATE PRODUCTION PLAN | NO-GO | BLOCKED>
Reviewer / Timestamp (UTC): <PROJECT_OWNER> / <UTC_ISO>
Notice: Even "GO TO SEPARATE PRODUCTION PLAN" does NOT authorize PROD-001/PROD-002 mutations without a separate reviewed production cutover and rollback package.
```
