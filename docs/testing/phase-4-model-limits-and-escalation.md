# Phase 4 Model Limits And Escalation Evidence

Date: 2026-09-13

## Scope

This checkpoint implements P4-005 Task 16 using local code, synthetic fixtures,
and isolated PostgreSQL databases. It did not call Manifest or any model
provider, change Manifest configuration, connect a Docker network, deploy the
application, use live customer data, or touch Meta or production assets.

## Implemented controls

- Model-policy inputs contain every operational and FAQ value explicitly. The
  parser, database, and private dashboard provide no values that silently
  enable inference.
- Administrator-only commands create immutable drafts and append exact,
  idempotent submit, approve, activate, and retire evidence. Effective policy
  resolution uses event time and enables inference only when exactly one
  policy is effective and a verified Manifest limit attestation is present.
- Operational limits are the field-by-field stricter intersection of reviewed
  PostgreSQL policy, protected deployment ceilings, and verified Manifest
  limits. Cooldown uses the longest of the three sources.
- Allowance acquisition accepts only a process-issued effective policy and an
  authoritative applied customer event. It derives a namespaced SHA-256 scope
  from the internal contact identifier; callers cannot supply a contact hash,
  raw channel identity, prompt, provider, or response.
- One PostgreSQL advisory-lock transaction enforces rolling 15-minute and
  rolling 24-hour contact limits, the aligned global UTC-day limit, cooldown,
  concurrency, queue capacity, usage increments, source/logical-call
  idempotency, and lease creation. Exact replays do not increment counters.
- Active and queued leases have bounded expiry. Activation checks capacity and
  policy effectiveness again; completion and expiry use closed terminal states.
- Escalations are source-bound, content-free, and exactly idempotent across all
  P4-005 persisted categories. The existing aggregate escalation dashboard
  shows counts without customer messages or provider details.
- The private model-policy page requires the administrator role, same-origin
  CSRF validation, a live session, and a session-bound signed action. Every
  configurable value is entered explicitly. Successful non-duplicate changes
  append a content-free `model_policy_changed` audit event.

## Test-first evidence

- Parser, policy, allowance, and escalation tests first failed because their
  modules did not exist.
- Focused development found and corrected synthetic receipt-key reuse and an
  invalid synthetic limit relationship before behavior was accepted.
- Self-review found an aligned contact-day implementation inconsistent with
  the approved rolling policy. A cross-UTC-midnight regression was added and
  the contact counters were changed to rolling cohorts.
- A concurrent six-call synthetic contact burst proves the reviewed three-call
  limit is serialized without overshoot.
- Focused final results: 37/37 unit tests across three files and 23/23 guarded
  PostgreSQL tests across four files.

## Full validation

- `npm run check`: PASS — Phase 0 validator, formatting, lint, strict type
  checking, 461 tests across 37 files, and build.
- `npm run test:integration` through `infra/compose.test.yml`: PASS — 335
  guarded PostgreSQL tests across 26 files.
- `git diff --check`: PASS. The flattened 21-file changed/untracked scan found
  zero credential-pattern matches and zero candidate non-synthetic external
  identity fixtures.
- The suites use isolated synthetic databases and content-minimized fixtures.

## Remaining boundary

Task 16 does not connect the reply-decision flow to Manifest. Task 17 must
compose FAQ/model/safe-failure decisions, recheck Phase 3 guards before draft
storage, map client/allowance failures into one safe draft and escalation, and
run the reviewed bilingual synthetic evaluation. Recording-off, private Docker
routing, provider allowlists/limits, and real-provider behavior remain
unverified external blockers. The model path therefore remains disabled for
customer traffic.
