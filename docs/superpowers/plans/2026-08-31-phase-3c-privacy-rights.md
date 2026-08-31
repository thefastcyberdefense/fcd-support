# Phase 3C Privacy Rights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete tracker row `P3-007` with deterministic privacy-intent intake, human-reviewed access and correction workflows, in-memory allowlisted access export, privacy holds, and immediate all-linked-identity marketing opt-out.

**Architecture:** A pure exact-command parser classifies only authoritative applied customer messages. A PostgreSQL privacy-rights service opens bounded request-ledger rows and durable content-free notification intents, while specialized access, correction, and marketing services enforce their distinct rules. PostgreSQL remains authoritative; access data exists only in the caller's memory, correction is restricted to typed registered handlers, and a versioned HMAC global suppression takes precedence over category grants.

**Tech Stack:** TypeScript 6 strict mode, Node.js 24, PostgreSQL 18, `pg` 8.22, `node-pg-migrate` 9, Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-29-phase-3c-privacy-rights-design.md`

## Global Constraints

- Implement `P3-007` only. `P3-GATE`, notification delivery, provider operations, live exports, deployment, and production actions remain separate.
- Recognize exactly `DELETE MY DATA`, `REQUEST MY DATA`, `CORRECT MY DATA`, and `STOP MARKETING` after the approved deterministic normalization. Do not use an LLM or substring matching.
- Intake must prove an applied authoritative `customer_message`; a pending, stale, unsupported, business echo, status event, or different identity cannot create privacy state.
- PostgreSQL owns request, notification, checklist, consent, suppression, and aggregate evidence. n8n and in-memory caches own none of it.
- Never commit, log, fixture, or persist an access export, raw identity, HMAC, credential, message body, requested correction, path, provider token, or free-form reviewer note.
- Access data may be returned only from an explicitly invoked private service to its in-process caller. This plan adds no HTTP route, Meta attachment, email, filesystem write, or network delivery.
- Correction accepts only a closed field key handled by a typed registered command. The production registry starts empty; there is no generic patch, column name, JSON path, SQL fragment, or free-form value API.
- Passwords, OTPs, access tokens, payment credentials, security answers, and other secrets are invalid verification evidence.
- `STOP MARKETING` affects every identity already linked to the authoritative contact, attempts no identity merge, and never blocks ordinary human or transactional support.
- A later marketing re-opt-in must atomically clear the relevant active global suppression and append explicit category grants. A reviewer note or ordinary message cannot clear it.
- Deletion behavior remains owned by the completed `PostgresDeletionPolicy`; P3-007 dispatches the exact phrase without duplicating deletion semantics.
- Tests use only blank-authored synthetic identities and the guarded randomized-schema PostgreSQL harness under `docs/SYNTHETIC_FIXTURE_POLICY.md`.
- All public error/result/evidence objects contain only internal references, closed codes, timestamps, and aggregate counts.

---

## File Structure

### Files Created

- `migrations/000005_create_privacy_rights_workflows.ts` — additive access/correction/opt-out evidence constraints and aggregate run tables.
- `migrations/000006_extend_privacy_hold_audit.ts` — closed checklist-location evidence plus the privacy-hold audit reason discovered during Task 3 execution.
- `src/policy/privacy-intent.ts` — exact deterministic intent parser.
- `src/policy/privacy-rights-command.ts` — strict schemas for access/correction review, checklist, opt-out, and re-opt-in commands.
- `src/persistence/postgres-privacy-rights-policy.ts` — authoritative intent intake, access/correction request lifecycle, holds, and checklist transitions.
- `src/persistence/postgres-marketing-opt-out-policy.ts` — all-linked global opt-out and explicit re-opt-in.
- `src/persistence/postgres-access-export.ts` — allowlisted, subject-isolated, in-memory export collector.
- `src/persistence/postgres-correction-policy.ts` — typed correction registry and reviewer-only execution.
- `tests/policy/privacy-intent.test.ts` — parser boundary tests.
- `tests/policy/privacy-rights-command.test.ts` — strict command-schema tests.
- `tests/integration/postgres-privacy-rights-policy.test.ts` — intake, request, hold, notification, checklist, and concurrency tests.
- `tests/integration/postgres-marketing-opt-out-policy.test.ts` — opt-out, precedence, and re-opt-in tests.
- `tests/integration/postgres-access-export.test.ts` — collector completeness, isolation, and non-persistence tests.
- `tests/integration/postgres-correction-policy.test.ts` — allowlist, authorization, and bounded-outcome tests.

### Files Modified

- `src/policy/policy-types.ts` — privacy-rights, export, correction, opt-out, and hold contracts.
- `src/persistence/postgres-consent-policy.ts` — global suppression precedence and atomic explicit re-opt-in entry point.
- `src/persistence/postgres-takeover-policy.ts` — unresolved privacy-request hold in automated reply eligibility.
- `src/persistence/postgres-deletion-policy.ts` — share the already-tested deletion-open primitive with deterministic intake without changing approval/execution behavior.
- `src/persistence/postgres-policy-helpers.ts` — reusable authoritative-event and subject-lock helpers.
- `tests/integration/migrations.test.ts` — migration-five/six apply/down/reapply and closed-value/append-only checks.
- `tests/integration/policy-fixtures.ts` — neutral synthetic applied-message helper wording and linked-identity setup.
- `tests/integration/postgres-consent-policy.test.ts` — suppression precedence regression cases.
- `tests/integration/postgres-takeover-policy.test.ts` — privacy-hold precedence and release cases.
- `docs/architecture/data-lifecycle.md` — implemented privacy workflows and boundaries.
- `docs/security/threat-model.md` — wrongful disclosure/correction, export leakage, identity-link confusion, and offline gaps.
- `docs/testing/acceptance-matrix.md` — separate P3-007 evidence rows.
- `docs/TODO.md` and `docs/PROJECT_CONTEXT.md` — truthful completion evidence and next-task state.

---

## Task 1: Deterministic Intent And Strict Command Contracts

**Files:**
- Create: `src/policy/privacy-intent.ts`
- Create: `src/policy/privacy-rights-command.ts`
- Modify: `src/policy/policy-types.ts`
- Create: `tests/policy/privacy-intent.test.ts`
- Create: `tests/policy/privacy-rights-command.test.ts`

- [ ] **Step 1: Write failing exact-intent parser tests**

Use table-driven tests for NFC/NFKC normalization as selected in the spec implementation, Unicode-aware lower/case folding through `toLocaleUpperCase('en-US')`, trim, collapsed whitespace, and at most one terminal `.`, `!`, or `?`. Cover all four commands, mixed case, Unicode whitespace, invalid input, extra punctuation, substring/suffix/prefix discussion, Bangla aliases, and credential-like text.

```ts
expect(parsePrivacyIntent('  request   my data?  ')).toBe('access');
expect(parsePrivacyIntent('Please REQUEST MY DATA')).toBeNull();
expect(parsePrivacyIntent('STOP MARKETING!!')).toBeNull();
```

- [ ] **Step 2: Implement the pure parser**

Export `PrivacyIntent = 'access' | 'correction' | 'deletion' | 'marketing_opt_out'` and `parsePrivacyIntent(value: unknown): PrivacyIntent | null`. Keep the command map closed and codepoint-normalize before whitespace/punctuation handling.

- [ ] **Step 3: Write failing strict command-schema tests**

Define and test schemas for:

- processing one applied event by decimal identifier and bounded request key;
- reviewing access/correction with `same_channel_context` or `known_name`, never secret-based evidence;
- checklist attestation with a closed location/outcome registry;
- executing an access collection by request reference;
- executing a typed correction by field key;
- immediate opt-out and explicit re-opt-in with bounded category arrays.

Reject unknown properties, invalid dates, empty/oversized keys, raw evidence/notes, arbitrary location names, duplicate categories, and unsafe correction field names.

- [ ] **Step 4: Implement schemas and exported contracts**

Use `z.strictObject`, closed enums, `/^\d+$/` database references, 1–128 character opaque keys/references, and `readonly` result types. Do not add a generic `value: unknown` or free-form evidence field to a persisted command.

- [ ] **Step 5: Run focused unit tests and static typing**

Run: `npm test -- tests/policy/privacy-intent.test.ts tests/policy/privacy-rights-command.test.ts`

Run: `npm run typecheck`

Expected: focused tests and strict typing PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/policy/privacy-intent.ts src/policy/privacy-rights-command.ts src/policy/policy-types.ts tests/policy/privacy-intent.test.ts tests/policy/privacy-rights-command.test.ts
git commit -m "feat: define privacy rights contracts"
```

---

## Task 2: Additive Privacy Rights Migration

**Files:**
- Create: `migrations/000005_create_privacy_rights_workflows.ts`
- Modify: `tests/integration/migrations.test.ts`

- [ ] **Step 1: Write the failing migration-five tests**

Assert the workflow tables arrive in migration five. Task 3 adds the narrow audit/checklist extension as migration six, after which the complete migration count is `6`; roll back six then five while P3-006 tables remain, and reapply both. Verify:

- `privacy_request_events` accepts only the additional access/correction/checklist actions, reasons, and actors required by this plan;
- `privacy_access_runs`, `privacy_correction_runs`, and `privacy_marketing_opt_out_runs` contain only request/internal references, closed codes, timestamps, aggregate counts, and unique request keys;
- `privacy_notification_intents` links to exactly one privacy request or marketing opt-out run, with a closed notification type and no subject data;
- all run/evidence tables reject update/delete;
- no table has JSON, bytea, message, identity, HMAC, export, path, requested-value, or free-form note columns;
- indexes support unresolved request holds and idempotency lookup.

- [ ] **Step 2: Implement migration five as a non-destructive extension**

Drop and replace only named check constraints that must widen. Add:

```sql
create table privacy_access_runs (
  id bigint generated always as identity primary key,
  request_id bigint not null references privacy_requests(id),
  request_key text not null unique,
  collected_at timestamptz not null,
  collector_count integer not null check (collector_count >= 0),
  record_count integer not null check (record_count >= 0),
  status text not null check (status = 'collected')
);
```

Create equally bounded `privacy_correction_runs` and `privacy_marketing_opt_out_runs`. The correction run stores only a closed field key and result code; the opt-out run stores linked-identity, category-revocation, suppression, and cancelled-intent counts. Make `privacy_notification_intents.request_id` nullable, add a nullable `marketing_opt_out_run_id` foreign key, widen the notification type to the closed values `operator_privacy_request` and `operator_marketing_opt_out`, and enforce that exactly one parent is present. Do not store export material, raw identifiers, HMACs, requested values, or handler errors.

- [ ] **Step 3: Add append-only and completion guards**

Reuse a migration-five-specific immutable-evidence trigger. Extend request completion rules so access/correction cannot report `completed` with unresolved required checklist rows. Ensure rollback removes only migration-five objects and restores the prior P3-006 constraints.

- [ ] **Step 4: Run the guarded migration cycle**

PowerShell:

```powershell
$env:TEST_DATABASE_URL='postgresql://fcd_support_test@127.0.0.1:55432/fcd_support_test'
$env:ALLOW_DESTRUCTIVE_DATABASE_TESTS='fcd-support-test-only'
npm run test:integration -- tests/integration/migrations.test.ts
```

Expected: apply/down/reapply, closed-value, and append-only tests PASS with no leaked schema or advisory lock.

- [ ] **Step 5: Commit Task 2**

```bash
git add migrations/000005_create_privacy_rights_workflows.ts tests/integration/migrations.test.ts
git commit -m "feat: add privacy rights workflow schema"
```

---

## Task 3: Human-Reviewed Request Intake, Holds, And Checklist

**Files:**
- Create: `migrations/000006_extend_privacy_hold_audit.ts`
- Create: `src/persistence/postgres-privacy-rights-policy.ts`
- Modify: `src/persistence/postgres-deletion-policy.ts`
- Modify: `src/persistence/postgres-policy-helpers.ts`
- Modify: `src/persistence/postgres-takeover-policy.ts`
- Modify: `tests/integration/migrations.test.ts`
- Create: `tests/integration/postgres-privacy-rights-policy.test.ts`
- Modify: `tests/integration/postgres-takeover-policy.test.ts`

- [ ] **Step 1: Write failing authoritative intake tests**

Cover exact access/correction/deletion intents from applied customer events; non-exact text; pending/stale/status/echo events; wrong identity/time; exact retry, logical retry, concurrent retry, conflicting request key, and notification insertion rollback. Assert access/correction start in `human_review`, create one content-free notification, and initialize only policy-owned checklist rows.

- [ ] **Step 2: Implement request intake and reuse deletion opening**

Add `PostgresPrivacyRightsPolicy.processAppliedEvent(input)`. It must load and lock the applied source event, parse only its message body, derive the authoritative contact/identity, and dispatch:

- deletion to the existing deletion-open primitive;
- access/correction to a shared bounded request-opening helper;
- marketing opt-out to Task 4's specialized service;
- unrecognized text to `{ status: 'not_a_privacy_intent' }`.

Extract a client-scoped deletion-open helper rather than copying P3-006 SQL. Keep public P3-006 behavior and tests unchanged.

- [ ] **Step 3: Write failing reviewer and checklist tests**

Prove only `support_reviewer` can approve/reject, attest locations, or close a request. Test same-channel/known-name verification, rejection of secret/cross-identity evidence, valid state transitions, exact duplicate, conflicting key, unresolved required location refusal, partial completion, and append-only bounded evidence.

- [ ] **Step 4: Implement serialized request transitions**

Use advisory request-key locks plus `FOR UPDATE` on the request. Reviewer approval moves access/correction `human_review -> in_progress`; reject moves to `rejected`. Checklist attestation records only closed location/outcome codes and opaque reviewer reference. Completion derives from checklist state and specialized run evidence; it never trusts a caller-provided success claim.

- [ ] **Step 5: Write failing privacy-hold eligibility tests**

Create zero, one, and multiple unresolved deletion/access/correction requests for the contact behind a conversation. Assert automated reply eligibility denies while any request is in `received`, `awaiting_confirmation`, `human_review`, or `in_progress`; terminal rejected/cancelled/completed requests release only their own hold. Human takeover pause remains independently authoritative.

- [ ] **Step 6: Implement hold precedence**

Extend `ReplyEligibility.reason` with `privacy_request_open`. In the same bounded eligibility transaction, join conversation -> channel identity -> contact and test unresolved privacy requests. Return pause denial before privacy denial when the human pause is active, then privacy denial, else `pause_inactive`. Audit only the closed reason code.

- [ ] **Step 7: Run focused integration tests**

Run the two files under the guarded environment:

```powershell
npm run test:integration -- tests/integration/postgres-privacy-rights-policy.test.ts tests/integration/postgres-takeover-policy.test.ts
```

Expected: intake, authorization, holds, checklist, rollback, retry, and concurrency cases PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add migrations/000006_extend_privacy_hold_audit.ts src/persistence/postgres-privacy-rights-policy.ts src/persistence/postgres-deletion-policy.ts src/persistence/postgres-policy-helpers.ts src/persistence/postgres-takeover-policy.ts src/policy/policy-types.ts tests/integration/migrations.test.ts tests/integration/postgres-privacy-rights-policy.test.ts tests/integration/postgres-takeover-policy.test.ts
git commit -m "feat: add reviewed privacy request intake"
```

---

## Task 4: Immediate Global Marketing Opt-Out And Explicit Re-Opt-In

**Files:**
- Create: `src/persistence/postgres-marketing-opt-out-policy.ts`
- Modify: `src/persistence/postgres-consent-policy.ts`
- Modify: `src/persistence/postgres-privacy-rights-policy.ts`
- Create: `tests/integration/postgres-marketing-opt-out-policy.test.ts`
- Modify: `tests/integration/postgres-consent-policy.test.ts`

- [ ] **Step 1: Write failing all-linked opt-out tests**

Use one contact with Messenger and WhatsApp identities. Cover zero/one/many existing marketing categories, all currently known categories, categories on only one identity, exact/concurrent retry, conflict, notification/run rollback, and no identity merge. Assert one revoke per linked identity/category, one active HMAC suppression per linked identity/key version, one aggregate run, and no raw identifier/HMAC in results or evidence.

- [ ] **Step 2: Implement atomic opt-out**

Validate the privacy keyring before connecting. Lock request key, source applied event, contact, and all linked identities in deterministic ID order. Determine the union of existing consent categories for that contact, append customer-authoritative revokes with deterministic idempotency keys, upsert/refresh active `marketing_opt_out` suppressions for the active HMAC version, cancel pending marketing intents only if the later outbox table exists, insert one aggregate run, and insert one `operator_marketing_opt_out` notification intent linked only to that run. Make the whole operation one bounded transaction.

- [ ] **Step 3: Write failing suppression-precedence tests**

Assert marketing eligibility is denied by global opt-out despite a newer/older category grant, across each retained HMAC key version and after restore-like ordering. Assert support reply eligibility is unaffected. A different contact and unlinked identity must not be suppressed.

- [ ] **Step 4: Implement eligibility precedence**

Give `PostgresConsentPolicy` the validated privacy keyring. Before latest-consent evaluation, compute HMAC candidates for every retained key and query active `marketing_opt_out` suppressions. Return `global_marketing_opt_out` on any match, audit the closed reason, and never expose the digest.

- [ ] **Step 5: Write failing explicit re-opt-in tests**

Require `support_reviewer`, explicit same-channel verification, selected linked-identity scope, and one or more closed marketing categories. Prove the command atomically expires/removes applicable global suppressions and appends category grants; rollback leaves both unchanged. Ordinary consent recording, arbitrary messages, and reviewer notes must not clear suppression.

- [ ] **Step 6: Implement atomic re-opt-in**

Add a specialized `recordExplicitReoptIn` method that locks the contact and selected linked identities, verifies request-key material, clears every matching suppression for every retained key version in scope, appends category-specific reviewer-recorded grants, and inserts bounded aggregate audit evidence. Do not weaken `recordReviewerCommand`.

- [ ] **Step 7: Run focused marketing tests**

```powershell
npm run test:integration -- tests/integration/postgres-marketing-opt-out-policy.test.ts tests/integration/postgres-consent-policy.test.ts
```

Expected: opt-out, precedence, rotation, re-opt-in, support-reply, rollback, and concurrency cases PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/persistence/postgres-marketing-opt-out-policy.ts src/persistence/postgres-consent-policy.ts src/persistence/postgres-privacy-rights-policy.ts src/policy/policy-types.ts tests/integration/postgres-marketing-opt-out-policy.test.ts tests/integration/postgres-consent-policy.test.ts
git commit -m "feat: enforce global marketing opt out"
```

---

## Task 5: In-Memory Allowlisted Access Export

**Files:**
- Create: `src/persistence/postgres-access-export.ts`
- Create: `tests/integration/postgres-access-export.test.ts`

- [ ] **Step 1: Write failing collector and isolation tests**

For an approved `access` request, assert the export manifest includes request reference, collection time, schema version, and explicit source categories. Allowlist collectors for:

- channel identities belonging to the request contact;
- conversations and lifecycle state;
- retained customer/business webhook event data governed by this app;
- consent history; and
- the subject's privacy-request/checklist state.

Create another contact plus mixed event/consent rows and prove none appear. Assert internal audit controls, HMACs, suppression rows, reviewer references, provider secrets, receipt hashes, unrelated contacts, and third-party contact-card data are excluded.

- [ ] **Step 2: Implement explicit typed collectors**

Define one typed collector per source category and a frozen production collector registry. Query only explicit columns; do not use `select *`. Collect inside one repeatable-read bounded transaction after locking/validating the approved request; the only write in that transaction is the content-free aggregate run inserted after all collectors succeed. Return the assembled object directly and never stringify, log, cache, or write it to any other destination.

```ts
export interface AccessCollector<TName extends string, TRecord> {
  readonly name: TName;
  collect(client: pg.PoolClient, contactId: string): Promise<readonly TRecord[]>;
}
```

- [ ] **Step 3: Add completeness and non-persistence tests**

Compare the frozen collector names to the policy-owned expected category registry so schema additions force an explicit collector/waiver decision. Snapshot database table row counts before/after collection except for one aggregate `privacy_access_runs` row. Spy on the safe logger boundary and serialization/filesystem adapters to prove the synthetic export is neither logged nor persisted.

- [ ] **Step 4: Record aggregate collection evidence**

After successful in-memory collection, insert only request ID, request key, collection time, collector count, record count, and `collected` status. A replay returns fresh in-memory data only when authorized but does not duplicate aggregate evidence; conflicting material fails closed.

- [ ] **Step 5: Run focused access tests**

```powershell
npm run test:integration -- tests/integration/postgres-access-export.test.ts
```

Expected: completeness, isolation, exclusions, authorization, retry, and non-persistence cases PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/persistence/postgres-access-export.ts src/policy/policy-types.ts tests/integration/postgres-access-export.test.ts
git commit -m "feat: add private access data collection"
```

---

## Task 6: Typed Correction Workflow

**Files:**
- Create: `src/persistence/postgres-correction-policy.ts`
- Create: `tests/integration/postgres-correction-policy.test.ts`

- [ ] **Step 1: Write failing registry and authorization tests**

Use a test-only synthetic field handler to prove:

- the production registry is empty by default;
- only `support_reviewer` can execute;
- the request is an approved `correction` request for the same contact;
- registered field keys invoke only their typed handler;
- unknown, immutable, security-sensitive, and provider-owned fields return closed manual/partial/rejected outcomes;
- no dynamic SQL, JSON patch, arbitrary column, or free-form correction value path exists;
- handler failure rolls back both mutation and evidence.

- [ ] **Step 2: Implement the typed registry**

Use a generic handler contract whose command type is owned by the handler, not by a generic persistence layer:

```ts
export interface CorrectionHandler<TKey extends string, TCommand> {
  readonly fieldKey: TKey;
  parse(input: unknown): TCommand;
  apply(context: CorrectionContext, command: TCommand): Promise<CorrectionOutcome>;
}
```

Construct the service with a readonly registry. Production wiring supplies an empty registry until an authoritative field owner adds a separately tested handler. Reject duplicate field keys at construction.

- [ ] **Step 3: Implement bounded workflow evidence**

Lock the request/contact, parse through the selected registered handler, execute within the same bounded transaction, and insert only request ID, field key, closed result code, timestamp, and request key. Unsupported/manual outcomes must not persist requested values or handler error text. Update the request/checklist only from the closed result.

- [ ] **Step 4: Run focused correction tests**

```powershell
npm run test:integration -- tests/integration/postgres-correction-policy.test.ts
```

Expected: typed allowlist, authorization, same-subject, rollback, replay, and no-generic-patch cases PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/persistence/postgres-correction-policy.ts src/policy/policy-types.ts tests/integration/postgres-correction-policy.test.ts
git commit -m "feat: add typed correction workflow"
```

---

## Task 7: Cross-Feature Safety And Regression Verification

**Files:**
- Modify: `tests/integration/policy-fixtures.ts`
- Modify: targeted integration tests only where regressions require explicit coverage

- [ ] **Step 1: Neutralize fixture helper wording**

Rename deletion-specific default fixture wording to privacy-policy wording while retaining only synthetic values. Add a helper for multiple identities linked to one synthetic contact.

- [ ] **Step 2: Add cross-feature failure tests**

Cover:

- deletion tombstone remains terminal even if a request row later closes;
- an access/correction hold does not alter retention deadlines or consent history;
- opt-out does not alter human takeover state;
- access collection cannot include deleted/pseudonymized material;
- overlapping access and correction holds release independently;
- transaction timeout/deadlock/retry leaves no partial request, notification, suppression, consent, correction, or aggregate evidence.

- [ ] **Step 3: Run all privacy/policy integration files**

```powershell
npm run test:integration -- tests/integration/postgres-deletion-policy.test.ts tests/integration/postgres-restore-deletion-gate.test.ts tests/integration/postgres-privacy-rights-policy.test.ts tests/integration/postgres-marketing-opt-out-policy.test.ts tests/integration/postgres-access-export.test.ts tests/integration/postgres-correction-policy.test.ts tests/integration/postgres-consent-policy.test.ts tests/integration/postgres-takeover-policy.test.ts tests/integration/postgres-retention-policy.test.ts tests/integration/postgres-retention-job.test.ts
```

Expected: all existing and new privacy/policy cases PASS.

- [ ] **Step 4: Verify database test hygiene**

Query the isolated test cluster for leaked `fcd_test_%` schemas and lingering advisory locks. Expected counts: zero.

- [ ] **Step 5: Commit Task 7**

```bash
git add tests/integration/policy-fixtures.ts tests/integration
git commit -m "test: cover privacy rights interactions"
```

---

## Task 8: Documentation, Evidence, And Full Validation

**Files:**
- Modify: `docs/architecture/data-lifecycle.md`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/testing/acceptance-matrix.md`
- Modify: `docs/TODO.md`
- Modify: `docs/PROJECT_CONTEXT.md`

- [ ] **Step 1: Document the implemented boundaries**

Record exact phrase parsing, authoritative source proof, access/correction human review, privacy holds, in-memory-only export, empty-by-default correction registry, all-linked opt-out precedence, explicit re-opt-in, manual online/offline checklist ownership, and content-free notification intent. State explicitly that no notification was delivered and no provider/offline/live/deployment action occurred.

- [ ] **Step 2: Update threat and acceptance evidence**

Add threats and mitigations for wrongful disclosure, wrong-subject correction, secrets in exports, identity-link confusion, stale/restored consent, incomplete offline search, and notification leakage. Give access, correction, opt-out, holds, retry/concurrency, and migration-cycle tests separate acceptance rows.

- [ ] **Step 3: Run privacy/scope scans**

Run tracked-source searches for credential names, raw identifiers, HMAC/export serialization, filesystem/network calls in the new services, forbidden generic patch/SQL fields, live domains, Meta/Cloudflare/n8n/Manifest calls, and production/deployment changes. Review every hit; do not treat a raw match count as evidence.

- [ ] **Step 4: Run final local gate**

Run:

```powershell
npm run check
$env:TEST_DATABASE_URL='postgresql://fcd_support_test@127.0.0.1:55432/fcd_support_test'
$env:ALLOW_DESTRUCTIVE_DATABASE_TESTS='fcd-support-test-only'
npm run test:integration
git diff --check
git status --short
```

Expected: Phase 0 validator, formatting, lint, strict type checking, all unit tests, build, the complete guarded PostgreSQL suite, and diff hygiene PASS; no leaked test schema/advisory lock; only the intentional documentation changes remain.

- [ ] **Step 5: Perform verification and focused security review**

Use `superpowers:verification-before-completion` and `codex-security:security-diff-scan` on the complete P3-007 diff. Fix and re-run relevant tests for every validated finding. Confirm results/evidence never include customer content, raw identities, HMACs, exports, correction values, paths, or credentials.

- [ ] **Step 6: Update tracker truthfully**

Mark `P3-007` complete only after all named gates pass. Keep `P3-GATE` blocked pending explicit project-owner evidence review. Do not mark any live export, provider/offline operation, notification delivery, deployment, `P6-004`, or production gate complete.

- [ ] **Step 7: Commit documentation and evidence**

```bash
git add docs/architecture/data-lifecycle.md docs/security/threat-model.md docs/testing/acceptance-matrix.md docs/TODO.md docs/PROJECT_CONTEXT.md
git commit -m "docs: record privacy rights evidence"
```

- [ ] **Step 8: Verify committed tree and push**

Re-run `npm run check` and the complete guarded integration suite from the committed tree. Confirm `main...origin/main` before push, then:

```bash
git push origin main
git status --short --branch
git rev-list --left-right --count main...origin/main
```

Expected: push succeeds, working tree is clean, and local/remote divergence is `0 0`.

---

## Self-Review Checklist

- [ ] Every persistent field is necessary, bounded, and content-free.
- [ ] Exact command parsing cannot trigger from discussion, suffix/prefix text, repeated punctuation, or non-authoritative events.
- [ ] Access/correction/deletion holds are derived from PostgreSQL and cannot be bypassed by cached workflow state.
- [ ] Access collectors use explicit columns and subject filters; the export is not persisted, logged, committed, or sent.
- [ ] Correction has no generic mutation path and the production registry contains no unowned handler.
- [ ] Global opt-out covers every already-linked identity and precedes every consent grant/key version.
- [ ] Re-opt-in is explicit, reviewed, scoped, and atomic with new category grants.
- [ ] Retry, conflict, concurrency, timeout, and rollback behavior leave one complete outcome.
- [ ] Existing deletion, retention, takeover, receipt, and consent tests remain green.
- [ ] P3-GATE remains a separate explicit project-owner review.
