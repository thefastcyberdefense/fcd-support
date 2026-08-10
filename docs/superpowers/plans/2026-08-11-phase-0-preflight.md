# Phase 0 Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the local technical, security, channel, lifecycle, and acceptance decisions needed to authorize the Phase 1 webhook-security implementation plan without touching external accounts or production assets.

**Architecture:** Phase 0 produces small, reviewable decision records rather than application code. Stable decisions live in `docs/decisions`, cross-cutting security and test rules live in focused reference documents, and `docs/TODO.md` remains the status/evidence index. External inventories are represented by sanitized checklists and stay unexecuted until their exact read-only access is approved.

**Tech Stack:** Markdown, Git, PowerShell validation, Node.js 24 LTS release metadata, npm registry package metadata, Meta official Postman collections, Cloudflare documentation, PostgreSQL version policy, and Manifest documentation.

## Global Constraints

- Do not scaffold application code before `P0-GATE` passes and the Phase 1 implementation plan is approved.
- Do not access or change public DNS, Cloudflare tunnels, server state, Meta assets, production permissions, live customer data, or the production WhatsApp number.
- Never record tokens, keys, passwords, account or phone identifiers, raw payloads, customer text, dumps, recordings, or tunnel credentials.
- OpenClaw and Hermes remain outside the support path; models receive no tools.
- Missing or blank marketing consent always means ineligible and is not configurable.
- Use synthetic examples only. Examples must use obviously fake identifiers and non-customer text.
- Preserve the 60-day casual-chat, 12-month unconverted-lead, and 24-hour human-pause requirements exactly.
- Commit each independently reviewable decision group.

## File Responsibility Map

- `docs/decisions/0001-runtime-and-toolchain.md`: exact supported runtime, dependency, package-manager, database, and development-tool versions.
- `docs/security/test-data-and-logging-policy.md`: fixture generation, forbidden fields, safe evidence, and logging allowlist rules.
- `docs/architecture/webhook-admission.md`: trust-boundary order, response matrix, event time, and channel-specific idempotency rules.
- `docs/architecture/channel-behavior.md`: separate WhatsApp and Messenger envelopes, echo behavior, status behavior, and pause mapping.
- `docs/policies/data-lifecycle.md`: lifecycle anchors, classification, consent, deletion, suppression, recording, and restore behavior.
- `docs/security/threat-model.md`: assets, trust boundaries, threats, mitigations, and validation mapping.
- `docs/testing/acceptance-matrix.md`: required local, integration, external-test, and production-readiness evidence.
- `docs/operations/preflight-inventory.md`: sanitized read-only inventory procedure and blank result checklists for later approved use.
- `docs/TODO.md`: task status and evidence links only; detailed requirements stay in the focused documents above.

---

### Task 1: Record The Runtime And Toolchain Decision

**Files:**
- Create: `docs/decisions/0001-runtime-and-toolchain.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: Node.js, Fastify, Vitest, PostgreSQL, and npm registry primary-source metadata reviewed on 2026-08-11.
- Produces: exact version inputs for the future `package.json`, lockfile, CI, and container definitions.

- [ ] **Step 1: Record the local runtime constraint**

Run:

```powershell
node --version
npm --version
docker --version
```

Expected: commands are unavailable on the normal `PATH`. Record that Codex provides Node `24.14.0`, while Docker is not locally available. Do not install anything in this step.

- [ ] **Step 2: Write the exact decision**

Create the decision record with these selections and rationale:

```markdown
# ADR-0001: Runtime And Toolchain

Status: Accepted
Date: 2026-08-11

## Decision

- Production Node.js: `24.18.0` (Active LTS line; exact production image digest is selected in Phase 6).
- Minimum development Node.js: `24.17.0`; reject older versions because `24.17.0` contains relevant security fixes.
- Package manager: npm `11.16.0`, with an exact `package-lock.json` and `npm ci` in CI/containers.
- TypeScript: `6.0.3`, selected instead of `7.0.2` because typescript-eslint `8.65.0` supports TypeScript `<6.1.0` and warns on TypeScript 7.
- HTTP framework: Fastify `5.10.0`, using a route-scoped Buffer content parser rather than a raw-body plugin.
- Schema validation: Zod `4.4.3` for configuration and untrusted webhook-envelope validation.
- Tests: Vitest `4.1.10` plus matching `@vitest/coverage-v8` `4.1.10`.
- Lint: ESLint `10.8.0` and typescript-eslint `8.65.0` with flat config.
- Format: Prettier `3.9.6`, run separately from ESLint.
- PostgreSQL client: `pg` `8.22.0` with parameterized SQL and explicit transactions.
- Migrations: `node-pg-migrate` `9.0.0`.
- PostgreSQL server: `18.4`; pin its image digest in Phase 6.

## Consequences

- Phase 1 requires a verified Node.js `24.17.0` or newer runtime before dependency installation or tests.
- The bundled Node.js `24.14.0` may edit files but may not be used as passing test evidence.
- Phase 2 Docker integration tests cannot run on this Windows workspace until Docker is provided; they may later run on an approved local Docker environment or the non-production Ubuntu test server.
- Dependencies are exact-pinned and changed only through reviewed upgrades with lockfile diffs and tests.
```

- [ ] **Step 3: Add primary references**

Add direct links for the Node LTS schedule and `24.17.0` security release, Fastify v5 docs, typescript-eslint dependency range, Vitest stable package, PostgreSQL version policy, and each npm package version page.

- [ ] **Step 4: Update tracker evidence**

Set `P0-003` to `COMPLETE` and link its evidence to `docs/decisions/0001-runtime-and-toolchain.md`. Do not change any other row.

- [ ] **Step 5: Validate and commit**

Run:

```powershell
git diff --check
rg -n "TBD|fill in details|implement later" docs/decisions/0001-runtime-and-toolchain.md
```

Expected: `git diff --check` is clean and the placeholder search has no output.

Commit:

```powershell
git add docs/decisions/0001-runtime-and-toolchain.md docs/TODO.md
git commit -m "docs: select support service toolchain"
```

### Task 2: Define Synthetic Test Data And Safe Logging

**Files:**
- Create: `docs/security/test-data-and-logging-policy.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: repository security boundaries and the selected test stack.
- Produces: fixture and evidence rules consumed by every test plan and the Phase 1 logger design.

- [ ] **Step 1: Write the prohibited-data rules**

The policy must prohibit real phone/PSID/account IDs, access tokens, app secrets, verification tokens, authorization headers, raw customer messages, raw webhook bodies, model prompts/responses, database dumps, and recordings in Git, tests, logs, snapshots, screenshots, and evidence.

- [ ] **Step 2: Define the allowed synthetic format**

Use these exact conventions:

```text
WhatsApp sender: 15550000001
WhatsApp message ID: wamid.TEST_<case>
Messenger PSID: PSID_TEST_<case>
Page/WABA/phone IDs: PAGE_TEST, WABA_TEST, PHONE_TEST
Customer message: "Synthetic support question <case>"
Secret inputs in tests: test_app_secret / test_verify_token
```

Fixtures must be minimal, hand-authored, and tagged with `"fixture_origin": "synthetic"` when the schema permits. Never copy a dashboard payload and redact it after the fact.

- [ ] **Step 3: Define the production log allowlist**

Allow only timestamp, level, stable internal correlation ID, normalized event kind, channel, processing outcome, duration, retry count, error code/class, and aggregate counts. Hashing an external identifier is not automatically safe; persistent correlation requires a separately approved keyed pseudonym.

- [ ] **Step 4: Define negative tests**

Require tests that inspect captured logs and prove absence of raw body, message text, external identifiers, signatures, authorization values, application secrets, model prompts, and database URLs.

- [ ] **Step 5: Update tracker, validate, and commit**

Set `P0-004` to `COMPLETE` with the policy link.

Run:

```powershell
git diff --check
rg -n -i "real customer|copy.*payload|log.*raw body" docs/security/test-data-and-logging-policy.md
```

Review every match to ensure it is a prohibition, then commit:

```powershell
git add docs/security/test-data-and-logging-policy.md docs/TODO.md
git commit -m "docs: define synthetic data and logging policy"
```

### Task 3: Define Webhook Admission And Idempotency

**Files:**
- Create: `docs/architecture/webhook-admission.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: Meta signature/acknowledgement behavior and the plan's raw-body-before-parse contract.
- Produces: exact Phase 1 HTTP outcomes and Phase 2 persistence/idempotency contracts.

- [ ] **Step 1: Write the admission order and limits**

Use this exact order and initial limit:

```text
route/method -> Content-Type application/json -> encoded body <= 256 KiB -> raw Buffer
-> X-Hub-Signature-256 syntax -> HMAC-SHA256 constant-time comparison
-> JSON parse -> envelope schema -> channel normalization -> durable sink
-> acknowledgement -> asynchronous processing
```

The 256 KiB limit is an initial application limit for text/status webhooks. Unsupported oversize payloads return `413` and are not parsed, logged, or persisted. Revisit the limit only with sanitized evidence of a valid required Meta event that exceeds it.

- [ ] **Step 2: Write the HTTP response matrix**

Record these exact outcomes:

| Condition | HTTP | Persist | Side effect | Retry intent |
|---|---:|---|---|---|
| Valid GET verification | `200` challenge text | No | No | Complete |
| Invalid GET mode/token/challenge | `403` | No | No | Do not authorize |
| Unknown public route or wrong method | `404` | No | No | Hide surface |
| Missing/invalid signature | `401` | No | No | Reject untrusted source |
| Wrong content type or malformed JSON/envelope | `400` | No | No | Reject invalid input |
| Body over limit | `413` | No | No | Reject before parse |
| Valid accepted new event | `200` | Yes | Async only | Complete |
| Valid exact duplicate | `200` | Existing receipt only | No | Stop retry |
| Valid stale/unsupported event | `200` | Minimal outcome per policy | No | Stop retry |
| Database unavailable before durable receipt | `503` | No | No | Permit retry |

Phase 1 uses an injected sink and tests the mapped result. Phase 2 makes durable outcomes authoritative.

- [ ] **Step 3: Define event time and idempotency**

Use per-item keys rather than a whole-delivery key:

```text
WhatsApp inbound/echo message: whatsapp:message:<messages[].id>
WhatsApp status: whatsapp:status:<statuses[].id>:<status>:<timestamp>
Messenger message/echo: messenger:message:<page_id>:<message.mid>
Messenger delivery/read without stable item ID: messenger:<kind>:<page_id>:<sender_or_recipient>:<event_timestamp>:<canonical_subset_sha256>
```

Never include raw message text in an idempotency key. Canonical fallback hashes include only documented identifiers, event kind, and timestamp. Store `received_at` separately from provider `occurred_at`.

- [ ] **Step 4: Define staleness and order rules**

Inbound customer messages and business echoes older than five minutes at first receipt are stale for automated side effects and receive `200` after minimal outcome recording. Delivery/read/status events are not dropped solely for age; they update state monotonically by provider event time and state precedence. Clock skew tolerance is 60 seconds into the future; farther-future events are quarantined as unsupported with no reply.

- [ ] **Step 5: Update tracker, validate, and commit**

Set `P0-005` and `P0-006` to `COMPLETE`, linking the document.

Run:

```powershell
git diff --check
rg -n "256 KiB|constant-time|503|whatsapp:message|messenger:message|five minutes" docs/architecture/webhook-admission.md
```

Expected: every required contract is found. Commit:

```powershell
git add docs/architecture/webhook-admission.md docs/TODO.md
git commit -m "docs: define webhook admission contract"
```

### Task 4: Define Separate Channel Behavior

**Files:**
- Create: `docs/architecture/channel-behavior.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: Meta Messenger/WhatsApp envelope references and webhook admission outputs.
- Produces: normalized event names and human-pause semantics consumed by Phase 1 and Phase 3.

- [ ] **Step 1: Define the normalized events**

Use this closed initial union:

```typescript
type NormalizedMetaEvent =
  | { kind: 'customer_message'; channel: 'whatsapp' | 'messenger'; externalMessageId: string; occurredAt: Date }
  | { kind: 'business_message_echo'; channel: 'whatsapp' | 'messenger'; externalMessageId: string; occurredAt: Date }
  | { kind: 'message_status'; channel: 'whatsapp' | 'messenger'; externalMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; occurredAt: Date }
  | { kind: 'unsupported'; channel: 'whatsapp' | 'messenger' | 'unknown'; reasonCode: string; occurredAt?: Date };
```

This is a design interface only in Phase 0; do not create source code yet.

- [ ] **Step 2: Define Messenger mapping**

Document `object: "page"`, `entry[].messaging[]`, inbound `message` events, `message.is_echo`/`message_echoes` business events, message IDs, status-like delivery/read events, batch flattening, and loop prevention. Any business echo pauses the matching conversation for 24 hours unless it is proven to be the service's already-correlated outbound echo; the correlated echo updates delivery metadata but does not extend the pause.

- [ ] **Step 3: Define WhatsApp mapping**

Document `object: "whatsapp_business_account"`, `entry[].changes[]`, `field: "messages"`, inbound `value.messages[]`, and `value.statuses[]`. Treat coexistence/manual-app `smb_message_echoes` as an unproven optional mapping: implement only from official or captured synthetic test-number contract evidence in Phase 7. Standard test-number behavior must not be represented as proof of production coexistence.

- [ ] **Step 4: Define batch and unsupported behavior**

Every array item normalizes independently. One unsupported item does not discard valid siblings. Unknown objects/fields/types normalize to `unsupported`, never call a model, never enqueue a reply, and generate only privacy-safe aggregate evidence.

- [ ] **Step 5: Update tracker, validate, and commit**

Set `P0-007` and `P0-008` to `COMPLETE`, linking the channel document.

Run:

```powershell
git diff --check
rg -n "message_echoes|smb_message_echoes|unproven|24 hours|valid siblings" docs/architecture/channel-behavior.md
```

Commit:

```powershell
git add docs/architecture/channel-behavior.md docs/TODO.md
git commit -m "docs: separate Meta channel behavior"
```

### Task 5: Draft The Data Lifecycle Decision

**Files:**
- Create: `docs/policies/data-lifecycle.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: fixed retention/consent requirements and backup/Manifest constraints.
- Produces: proposed defaults plus a short, explicit project-owner decision list for `P0-009` through `P0-012`.

- [ ] **Step 1: Record fixed invariants**

Write that casual message content expires 60 days after `occurred_at`; an unconverted lead expires 12 calendar months after its most recent qualifying lead interaction; blank consent is ineligible; a revocation applies immediately; marketing consent does not extend support-content retention; and legal hold is unavailable until separately designed and approved.

- [ ] **Step 2: Define classification and deletion mechanics**

Propose classification precedence `active_client > unconverted_lead > casual_chat`, with auditable transition time. Deletion is same-channel requested, human-reviewed, idempotent, and covers live records plus applicable Manifest recordings. Backups remain immutable; a keyed, content-free deletion tombstone is reapplied after restore before service and retained until the newest backup that could contain deleted content has expired plus 30 days.

- [ ] **Step 3: Define the minimal suppression proposal**

Propose a keyed HMAC of channel plus external identity, channel, consent category, suppression reason, effective time, and key version—no raw external identifier or message content. Opt-out suppression remains until an explicit verified opt-in; deletion-only tombstones follow the backup-expiry rule.

- [ ] **Step 4: Isolate owner decisions**

End the document with exactly these approval items:

1. Accept or revise the 60-day and 12-calendar-month lifecycle anchors.
2. Name the active-client retention period and responsible legal/business owner.
3. Accept or revise same-channel request plus human review for deletion verification.
4. Accept or revise the keyed-HMAC suppression fields and retention.
5. Require Manifest raw-body recording to be disabled, or define its maximum retention if disabling is unavailable.

Do not mark `P0-009` through `P0-012` complete until the project owner answers these items.

Map the answers explicitly: `P0-009` covers lifecycle anchors, `P0-010` covers active-client retention ownership, `P0-011` covers deletion verification and suppression, and `P0-012` covers Manifest recordings and restored backups.

- [ ] **Step 5: Validate and commit the proposal**

Run:

```powershell
git diff --check
rg -n "60 days|12 calendar months|active-client|same-channel|keyed HMAC|Manifest" docs/policies/data-lifecycle.md
```

Commit:

```powershell
git add docs/policies/data-lifecycle.md
git commit -m "docs: propose data lifecycle policy"
```

### Task 6: Create The Threat Model

**Files:**
- Create: `docs/security/threat-model.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: admission, channel, logging, lifecycle, network, backup, and model boundaries.
- Produces: threat-to-mitigation-to-test mappings for the acceptance matrix.

- [ ] **Step 1: Draw the trust boundaries in text**

Document these boundaries: Internet/Cloudflare, cloudflared/API, raw webhook/admitted event, API/PostgreSQL, API/Manifest, API/Meta Graph, API/private n8n, backup storage/restore, and LAN reviewer interface.

- [ ] **Step 2: Add the required threats**

Cover forged signatures, body parser mutation, oversized bodies, replay/concurrency, stale retry storms, malformed batch smuggling, event-order rollback, echo loops, pause races, consent confusion, deletion resurrection, log/fixture leakage, prompt injection, provider data leakage, SSRF/tool use, secret exposure, public-route expansion, database/network exposure, dependency compromise, backup theft, and unauthorized production-number mutation.

- [ ] **Step 3: Map each threat to controls and evidence**

Every row must include asset, attacker/cause, impact, preventive control, detection, automated/manual evidence, phase, and residual risk. Tool-free models, FAQ precedence, raw-body HMAC, PostgreSQL uniqueness, outbox re-checks, private networks, encrypted backups, and approval gates must each appear.

- [ ] **Step 4: Update tracker, validate, and commit**

Set `P0-017` to `COMPLETE` and link the threat model.

Run:

```powershell
git diff --check
rg -n "forged signature|replay|echo loop|deletion resurrection|prompt injection|production-number" docs/security/threat-model.md
```

Commit:

```powershell
git add docs/security/threat-model.md docs/TODO.md
git commit -m "docs: add support service threat model"
```

### Task 7: Create The Acceptance Matrix

**Files:**
- Create: `docs/testing/acceptance-matrix.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: every validation gate in `AGENTS.md`, the delivery plan, and the threat model.
- Produces: stable acceptance IDs referenced by phase-specific tests and sanitized reports.

- [ ] **Step 1: Define evidence classes**

Use `UNIT`, `INTEGRATION`, `CONTAINER`, `TEST_ASSET`, `MANUAL_REVIEW`, and `RESTORE_DRILL`. Each case includes ID, phase, preconditions, stimulus, expected outcome, evidence class, privacy rule, and owner.

- [ ] **Step 2: Add security and reliability cases**

Include valid/invalid verification; valid, missing, malformed, wrong-length, altered-byte, and Unicode signatures; payload limit; malformed JSON; unknown route/method/object; multi-item batch; duplicate serial/concurrent/restart; database failure; stale inbound; future timestamp; out-of-order status; worker crash; and provider/tunnel/host outage.

- [ ] **Step 3: Add policy and quality cases**

Include Messenger echo pause, correlated bot echo non-pause, WhatsApp coexistence echo gate, 24-hour expiry/resume/race, blank/grant/revoke consent, category/channel mismatch, 60-day/12-month boundaries, verified/repeated deletion, suppression, restore re-deletion, FAQ precedence, English/Bangla quality, incident escalation, redaction, tool-free request, Manifest fallback, and no OpenClaw/Hermes fallback.

- [ ] **Step 4: Add phase and production gates**

Map every case to the earliest phase that can prove it. Mark Meta test-number, Messenger Page, tunnel, server, and production-readiness cases as unavailable before their approval boundary. Passing `TEST_ASSET` cases must never imply production authorization.

- [ ] **Step 5: Update tracker, validate, and commit**

Set `P0-018` to `COMPLETE` only after every `AGENTS.md` gate has an acceptance ID.

Run:

```powershell
git diff --check
rg -n "signature rejection|duplicate|stale|bilingual|human takeover|opt-out|deletion|backup restore|model fallback" docs/testing/acceptance-matrix.md
```

Commit:

```powershell
git add docs/testing/acceptance-matrix.md docs/TODO.md
git commit -m "docs: define acceptance evidence matrix"
```

### Task 8: Create Sanitized External Inventory Checklists

**Files:**
- Create: `docs/operations/preflight-inventory.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `P0-013` through `P0-016` completion rules.
- Produces: safe procedures that an approved operator can run later without recording secrets or identifiers.

- [ ] **Step 1: Write the recording rules**

Allow only `YES`, `NO`, version, enabled/disabled, bounded counts, and sanitized connectivity outcomes. Prohibit endpoints containing credentials, account IDs, phone IDs/numbers, Page IDs, tokens, provider names tied to secrets, workflow payloads, tunnel IDs, and screenshots.

- [ ] **Step 2: Add four checklists**

Create separate Manifest, Meta test assets, n8n dependency, and Cloudflare access sections. Each section lists the minimum read-only checks, the exact mutation that is prohibited, evidence format, and downstream tracker row. Meta explicitly prohibits opening or editing the production-number onboarding flow.

- [ ] **Step 3: Keep external rows pending**

Do not perform the inventories or change `P0-013` through `P0-016` status. These checks require explicit read-only access and may be deferred to the phase that consumes them if they do not alter Phase 1 design.

- [ ] **Step 4: Validate and commit**

Run:

```powershell
git diff --check
rg -n "YES|NO|prohibited|P0-013|P0-014|P0-015|P0-016" docs/operations/preflight-inventory.md
```

Commit:

```powershell
git add docs/operations/preflight-inventory.md
git commit -m "docs: add sanitized preflight checklists"
```

### Task 9: Review The Phase 0 Gate

**Files:**
- Modify: `docs/TODO.md`
- Modify if needed: focused Phase 0 documents listed above

**Interfaces:**
- Consumes: completed local Phase 0 evidence, explicit owner decisions, and deferred external inventory rationale.
- Produces: a decision whether Phase 1 implementation planning may begin.

- [ ] **Step 1: Run consistency checks**

Run:

```powershell
git diff --check
rg -n -i "TBD|fill in details|implement later" docs
rg -n "MARKETING_BLANK_IS_OPT_IN|UNCONVERTED_LEAD_RETENTION_DAYS" .
git status --short --branch
```

Expected: no placeholder or unsafe legacy setting, and only intentional tracker changes remain.

- [ ] **Step 2: Check required evidence**

Confirm `P0-003` through `P0-012`, `P0-017`, and `P0-018` are complete or explicitly deferred with a documented reason that cannot affect Phase 1. `P0-013` through `P0-016` may remain pending because Phase 1 is external-service-free.

- [ ] **Step 3: Request the project-owner gate decision**

Present only unresolved policy decisions and the Phase 1 readiness result. Do not ask for external-account approval in the same decision.

- [ ] **Step 4: Record and commit the gate**

If approved, set `P0-GATE` to `COMPLETE` and `P1-001` to `IN PROGRESS`. If not approved, leave `P0-GATE` blocked and record the exact missing evidence without secrets.

Commit:

```powershell
git add docs/TODO.md
git commit -m "docs: record Phase 0 gate decision"
```

## Plan Self-Review

- Every Phase 0 tracker row has a task or an explicit later approval boundary.
- Exact tool versions are compatible: TypeScript `6.0.3` is within typescript-eslint's `<6.1.0` support range.
- The local Node `24.14.0` mismatch is visible and cannot become passing evidence.
- HTTP outcomes distinguish untrusted/invalid requests, accepted duplicates/stale events, and unavailable durable storage.
- WhatsApp coexistence is test-gated and not inferred from Messenger behavior.
- Lifecycle tasks isolate business/legal decisions rather than inventing them.
- External checklists do not authorize or execute external access.
- No task modifies the production number, DNS, tunnel, server, Meta permissions, or live data.
