# Phase 0 Lifecycle and Inventory Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close P0-009 through P0-016 with canonical lifecycle policy, sanitized read-only inventory evidence, synchronized readiness documentation, and no external mutations.

**Architecture:** Split the approved design into two focused records: a normative lifecycle contract under `docs/architecture/` and a dated sanitized inventory under `docs/operations/`. Synchronize the delivery plan, live tracker, and project context against those records, then run documentation, privacy, and full repository validation before one implementation commit.

**Tech Stack:** Markdown, PowerShell, ripgrep, Git, existing npm validation scripts

**Spec:** `docs/superpowers/specs/2026-08-26-phase-0-lifecycle-and-inventory-design.md`

## Global Constraints

- PostgreSQL remains authoritative for conversation, consent, lifecycle, deletion, and suppression state.
- Use UTC for stored timestamps and lifecycle calculations; operator-facing timestamps may use `Asia/Dhaka` (`UTC+06:00`).
- Lifecycle precedence is `active_client > unconverted_lead > casual_chat`.
- Casual chat retention is 60 days from the latest qualifying human-authored event.
- Unconverted lead retention is 12 calendar months from the latest qualifying lead interaction.
- Active-client support content is retained during the documented relationship and for 24 calendar months after the later documented relationship end or final paid service completion.
- Deletion uses same-channel confirmation plus human review and never asks for a password, OTP, payment credential, or other secret.
- Message-body recording must be disabled on the dedicated Manifest harness before model/customer traffic.
- Only sanitized counts, versions, permission names, readiness outcomes, and service relationships may be committed as inventory evidence.
- Do not change the Ubuntu runtime, Docker networks, Manifest settings, n8n settings, Meta assets, public DNS, Cloudflare routes, or production WhatsApp number in this plan.
- Follow `docs/SYNTHETIC_FIXTURE_POLICY.md`; do not commit identifiers, secrets, customer content, raw payloads, workflow bodies, recordings, dumps, screenshots, or environment values.

---

### Task 1: Publish the normative lifecycle contract

**Files:**
- Create: `docs/architecture/data-lifecycle.md`
- Read: `docs/superpowers/specs/2026-08-26-phase-0-lifecycle-and-inventory-design.md`

**Interfaces:**
- Consumes: the approved lifecycle, deletion, suppression, Manifest-recording, and restore design.
- Produces: the canonical policy evidence referenced by P0-009 through P0-012 and later P3-005/P3-006 implementation plans.

- [ ] **Step 1: Create the lifecycle policy file**

Write these exact normative sections:

1. authority, scope, UTC calculation, and `Asia/Dhaka` display rule;
2. lifecycle precedence and append-only reclassification audit requirements;
3. casual-chat, unconverted-lead, and active-client qualifying anchors and exact expiry calculations;
4. excluded events that cannot extend retention;
5. annual active-client review and the policy-owner role;
6. same-channel deletion confirmation, human review, prohibited secret-based verification, idempotency, and data surfaces erased;
7. HMAC suppression/tombstone fields and retention;
8. Manifest recording production no-go rule;
9. isolated restore/reapply/promote gate;
10. implementation acceptance tests required in P3 and P6.

- [ ] **Step 2: Verify every approved policy value is present**

Run:

```powershell
rg -n "60 days|12 calendar months|24 calendar months|active_client > unconverted_lead > casual_chat|Asia/Dhaka|password|OTP|identity_hmac|30 days|recording|isolated" docs/architecture/data-lifecycle.md
```

Expected: every search term appears in a normative section, and passwords/OTPs appear only in the prohibition.

- [ ] **Step 3: Check the document for forbidden evidence**

Run:

```powershell
rg -n "(EAA[A-Za-z0-9]|mnfst_[A-Za-z0-9]|META_(APP_SECRET|PAGE_ACCESS_TOKEN|WHATSAPP_ACCESS_TOKEN)=|PHONE_NUMBER_ID=|WABA_ID=|authorization: bearer|cloudflared\.token)" docs/architecture/data-lifecycle.md
```

Expected: exit code `1` with no matches.

### Task 2: Publish the sanitized preflight inventory

**Files:**
- Create: `docs/operations/preflight-inventory.md`
- Read: `docs/superpowers/specs/2026-08-26-phase-0-lifecycle-and-inventory-design.md`

**Interfaces:**
- Consumes: read-only aggregate evidence gathered on 2026-08-26.
- Produces: sanitized P0-013 through P0-016 evidence and explicit readiness dispositions without storing external identifiers or secret values.

- [ ] **Step 1: Create the inventory record**

Write four sections with status and follow-on gates:

- Manifest `6.11.0`, dedicated `fcd-support`/`auto`, connection counts, recording enabled, no request rows, no explicit fallback/limit rules, and missing application-network attachment;
- Meta development/test-asset state, approved permission names, role-scoped Messenger access, expired WhatsApp test token, and Graph `v25.0` runtime versus `v26.0` sample mismatch;
- n8n `2.35.3`, workflow and API-key aggregate counts, zero discovered `fcd-support` public-API dependencies, and keep-enabled/LAN-only disposition pending legacy-key ownership;
- Cloudflare zone/tunnel access already confirmed, exact webhook-only public route, private internal services, and no new mutation.

Include a prominent statement that inventory completion does not mean production readiness.

- [ ] **Step 2: Verify the expected sanitized facts**

Run:

```powershell
rg -n "6\.11\.0|fcd-support|auto|Eighteen|recording|no request|v25\.0|v26\.0|pages_messaging|expired|2\.35\.3|Four workflows|Three.*API keys|zero discovered|LAN-only|webhook" docs/operations/preflight-inventory.md
```

Expected: every required readiness fact is present without account identifiers, token values, provider connection identifiers, workflow names, or workflow bodies.

- [ ] **Step 3: Run the forbidden-evidence scan**

Run:

```powershell
rg -n "(EAA[A-Za-z0-9]|mnfst_[A-Za-z0-9]|[0-9]{12,}|META_(APP_SECRET|PAGE_ACCESS_TOKEN|WHATSAPP_ACCESS_TOKEN)=|PHONE_NUMBER_ID=|WABA_ID=|authorization: bearer|cloudflared\.token)" docs/operations/preflight-inventory.md
```

Expected: exit code `1` with no matches.

### Task 3: Synchronize the canonical plan, tracker, and project context

**Files:**
- Modify: `docs/PLAN.md`
- Modify: `docs/TODO.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Read: `docs/architecture/data-lifecycle.md`
- Read: `docs/operations/preflight-inventory.md`

**Interfaces:**
- Consumes: canonical lifecycle policy and sanitized inventory evidence.
- Produces: one consistent project state in which P0-009 through P0-016 are complete while downstream implementation and production-readiness gates remain explicit.

- [ ] **Step 1: Update the delivery plan**

Add the approved lifecycle details to Phase 0/Phase 3 policy language:

- exact anchor definitions and excluded events;
- lifecycle precedence and reclassification audit;
- active relationship plus 24-month post-relationship period and annual review;
- policy owner role;
- same-channel/human-reviewed deletion and minimal HMAC suppression;
- Manifest recording disabled before traffic;
- isolated restore with tombstone reapplication before serving.

Do not change the existing validation gates or authorize deployment.

- [ ] **Step 2: Close tracker rows with evidence links**

Set P0-009 through P0-015 to `COMPLETE`, preserving P0-016 as `COMPLETE`.

Use these evidence targets:

- P0-009 through P0-012: `docs/architecture/data-lifecycle.md` and the approved design spec;
- P0-013 through P0-016: `docs/operations/preflight-inventory.md` plus previously recorded exact-route evidence for P0-016.

Update Current Readiness so it states:

- lifecycle decisions are closed;
- P3-005 and P3-006 are now unblocked by Phase 0 but remain unimplemented;
- P0-017, P0-018, and P0-GATE remain open;
- inventory completion does not clear the Manifest, Meta, n8n, Phase 7, or production gates.

- [ ] **Step 3: Update project context**

Set `Last reviewed` to `2026-08-27 (Asia/Dhaka)`, record the exact lifecycle and owner decisions, update n8n to `2.35.3`, and replace the generic Phase 0 blocker with the remaining P0-017/P0-018/P0-GATE work.

Keep these blockers explicit:

- Manifest recording/private-network/fallback-limit readiness;
- Meta expired test token, development/permission status, and Graph version decision;
- n8n legacy API-key ownership;
- WhatsApp coexistence;
- deletion/restore and human-takeover acceptance tests;
- production assets remain unauthorized.

- [ ] **Step 4: Check cross-document consistency**

Run:

```powershell
rg -n "P0-00(9)|P0-01[0-6]|24 calendar months|2\.35\.3|P0-017|P0-018" docs/PLAN.md docs/TODO.md docs/PROJECT_CONTEXT.md docs/architecture/data-lifecycle.md docs/operations/preflight-inventory.md
```

Expected: P0-009 through P0-016 are complete in the tracker; the same lifecycle period and n8n version appear consistently; P0-017/P0-018 remain open.

### Task 4: Validate, review, commit, and push the closure bundle

**Files:**
- Verify: all files changed by Tasks 1 through 3

**Interfaces:**
- Consumes: the completed documentation bundle.
- Produces: one clean, validated Git commit on `main`, pushed to the private GitHub repository; no Ubuntu pull or deployment.

- [ ] **Step 1: Inspect scope and whitespace**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Expected: only the plan, lifecycle policy, inventory, canonical plan, tracker, and project-context files are changed; no whitespace errors.

- [ ] **Step 2: Run repository-wide sensitive-evidence scans**

Run targeted scans over the changed documentation for credential prefixes, environment assignments, authorization headers, long numeric identifiers, raw-payload markers, workflow bodies, screenshots, exports, and dumps.

Expected: no secret, external identifier, customer content, raw payload, workflow body, screenshot, recording, dump, or environment value was added.

- [ ] **Step 3: Run the full local validation gate**

Run:

```powershell
npm run check
```

Expected: formatting, lint, strict type checking, all local tests, and build pass.

- [ ] **Step 4: Review the exact staged diff**

Run:

```powershell
git add -- docs/superpowers/plans/2026-08-27-phase-0-lifecycle-and-inventory-closure.md docs/architecture/data-lifecycle.md docs/operations/preflight-inventory.md docs/PLAN.md docs/TODO.md docs/PROJECT_CONTEXT.md
git diff --cached --check
git diff --cached --stat
```

Expected: the staged set contains only the six listed files and no whitespace errors.

- [ ] **Step 5: Commit and push**

Run:

```powershell
git commit -m "docs: close phase 0 lifecycle and inventories"
git push origin main
```

Expected: the local `main` commit is pushed to `origin/main`. Do not pull or deploy it on Ubuntu because this bundle changes no runtime behavior.

## Plan self-review

- Spec coverage: every lifecycle, deletion, suppression, Manifest-recording,
  backup-restore, inventory, tracker, and non-mutation requirement maps to Tasks
  1 through 4.
- Placeholder scan: the plan contains no `TBD`, deferred implementation
  placeholder, or unspecified test instruction.
- Type consistency: this is a documentation-only closure; canonical names,
  lifecycle classes, periods, versions, statuses, and evidence paths are
  consistent across all tasks.
- Scope decision: the policy and inventory records are separate documents but
  remain one plan because their only implementation dependency is synchronized
  Phase 0 tracker closure; neither changes runtime software or an external
  system.

## Execution choice

The project owner requested completion in one task and then approved the design
and continued execution. Use inline execution with `superpowers:executing-plans`;
do not dispatch subagents and do not mutate external systems.
