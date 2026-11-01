# Phase 6 Task 15 Review Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task by task. Keep the existing AGY isolated branch.

**Goal:** Close the demonstrated acceptance-proof gaps in draft PR #3 before
Codex's independent Phase 6 gate review.

**Architecture:** Exercise existing backup, scheduler/preflight, PostgreSQL
catalog and restore-fence/outbox boundaries. Keep synthetic provider-side
acceptance observations separate from PostgreSQL snapshot state. No new runtime
recovery policy or external integration is assigned.

**Tech Stack:** Strict TypeScript, Vitest, PostgreSQL, Bash/flock, Docker and
standard-library Python helper tests.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md`;
`docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md`;
`docs/superpowers/plans/2026-10-31-phase-6-task-15-focused-closeout.md`;
`docs/reviews/2026-11-01-pr-3-task-15-review.md`.

## Global constraints

- Existing owner approval covers these local synthetic test corrections. Keep
  PR #3 draft on `codex/agy-p6-failure-matrix`; preserve unrelated work.
- Read fresh AGENTS, TODO, PROJECT_CONTEXT and SYNTHETIC_FIXTURE_POLICY. Fetch
  and merge latest main without rewriting history. Do not edit the primary
  checkout, its trackers, action scripts or incident evidence.
- No SSH, server/daemon changes, global prune, live provider/model/n8n/Meta call,
  tunnel, production action, main merge or gate self-approval.
- PostgreSQL remains authoritative; models receive no tools. Never print or
  commit secret values, raw messages, dumps or private command output.
- Coverage for already correct behavior is coverage-only. Actual owning-module
  repairs require a reproduced RED followed by minimal GREEN.

## Review focus

- Removed/bypassed production lock must be detectable by the scheduler test.
- Broken production catalog deduplication must not be hidden by a test ledger.
- A directory with correct 0700 ownership can still reside on a read-only mount.
- Provider acceptance can occur after the database snapshot being restored.
- A failed barrier or assertion must reap children and release owned locks.

## Task 1: Real scheduler lock and current-slot deduplication

**Files:** Modify `tests/systemd-contract.test.ts` or add
`tests/operations-scheduled-lock.test.ts`; reuse
`tests/integration/postgres-encrypted-backup.test.ts` and its guarded native
fixture as needed. Owning interfaces: `operations_scheduled_main` in
`scripts/run-operation.sh`, `operations_preflight` in
`scripts/operations-common.sh`, and `runScheduledBackup` in
`src/operations/backup-command.ts`.

- [ ] Replace the handwritten lock/grep scenario with two real owning scheduler
      activations against one exact protected synthetic scope. Keep the actual
      preflight lock intact; fake external Docker observations only where needed.
- [ ] Signal after the first owner has acquired its real lock, using a bounded
      deterministic barrier. Assert the second returns
      `operations_lock_conflict` without entering a job or changing the catalog.
- [ ] Release/reap the first process. Prove a later activation succeeds, then
      repeat the same current slot through the actual PostgreSQL owning catalog:
      one archive/catalog completion and no duplicate dump. No trace-file grep
      or literal fake `not_due` may serve as deduplication authority.
- [ ] In `finally`, terminate and await every owned child on assertion, timeout
      or early-exit failure before scoped scratch cleanup. Handle split stdout
      chunks and clean premature exit without indefinite waits.
- [ ] Run the focused native assertion and real catalog assertions. Record
      counts and honest coverage-only versus demonstrated repairs; commit.

## Task 2: Actual read-only destination and closed output

**Files:** Modify `tests/backup.test.ts` and, if necessary, the existing
`scripts/test-encrypted-backup.sh` native fixture or a narrowly scoped local test
helper. Do not change runtime directory-admission or backup publication policy.

- [ ] Retain the useful 0500 permission-admission and injected publish-error
      tests under accurate names. Retain existing native ENOSPC coverage.
- [ ] Provision a dedicated test-owned read-only mount with a preexisting valid
      authenticated archive, correct numeric ownership and mode 0700. Verify
      an actual write receives EROFS; execute `createEncryptedBackup` against
      that admitted filesystem without replacing its filesystem calls. Pair it
      with a writable mount/control under equivalent ownership and permissions.
- [ ] Assert closed `backup_failed`, no successful publication, unchanged prior
      archive/manifest and verification, and no newly owned partial ciphertext
      or temporary plaintext. Keep injected mid-publication cleanup coverage
      distinct from a mount that refuses its first write.
- [ ] Capture actual emitted output/error surfaces using authored sentinels;
      assert their absence without printing them. Inspecting process arguments
      alone is not output-capture evidence.
- [ ] Verify mounts/actors/volumes belong solely to this fixture before cleanup;
      cleanup on success and failure. Run focused Linux tests and commit.

## Task 3: Older snapshot with provider acceptance ahead of PostgreSQL

**Files:** Modify `tests/integration/postgres-outbound-flow.test.ts`; reuse
`tests/integration/restore-fixtures.ts` and real isolated-restore fixtures where
needed. Owning interfaces: `PostgresRestoreFence.quarantine`, `OutboundWorker`
and existing reviewed-recovery fixtures.

- [ ] Represent both durable accepted work and an explicit older snapshot:
      synthetic provider acceptance occurs after that snapshot, while restored
      PostgreSQL still contains a send-eligible/ambiguous inherited intent.
      Establish this divergence through assertions, not a comment about pending
      work. Use the existing real snapshot/restore boundary where required.
- [ ] Use one synthetic provider instance with a captured send count throughout.
      Repeated actual worker activations under quarantine/hold send zero times;
      query exact persisted accepted/inherited states and unchanged hold.
- [ ] Use a separate unfenced synthetic PostgreSQL fixture for the eligible
      control through that same provider. It sends once; repeated activation
      sends no second time. Re-run the restored worker before and after the
      control and prove zero added sends, unchanged exact inherited states and
      an unchanged active recovery hold. Do not lift that fixture's hold by
      seeding review records merely to make the control eligible.
- [ ] Add no provider-status lookup, blind resend, resolver, automatic hold
      clearing, forced settlement or new reconciliation policy. Run the focused
      guarded PostgreSQL test, preserve source quarantine and commit.

## Task 4: Accurate evidence and final delivery

**Files:** Correct `docs/testing/phase-6-failure-matrix-gap-map.md` and
`docs/handoffs/2026-10-30-antigravity-phase-6-closeout-results.md`.
Preserve the five-test-files-only hermetic CI step and token permissions.

- [ ] Audit every gap-map row/title/line against its actual assertion and lane.
      Mark confirmed gaps closed only after the owning-boundary proof runs.
      Keep local evidence, historical server evidence and pending live evidence
      distinct. Do not call simulated OS behavior a real filesystem result.
      In particular, replace nonexistent signature/ingest and session-closure
      citations with actual stale receipt and identity revocation assertions;
      do not claim connection closure unless an actual test establishes it.
- [ ] Generate base/head SHAs with Git. Correct false primary/base revisions,
      catalog claims and stale counts. Label earlier runs by their actual SHA;
      an application-tree match is not an exact final-source workflow result.
- [ ] Run forced Markdown formatting with `--ignore-path .gitignore`, targeted
      secret-pattern checks and `git diff --check`. Run focused checks first,
      then final `VITEST_MAX_WORKERS=4 npm run check`, guarded sequential
      native/grants/restore/PostgreSQL lanes and the real multihomed ordinary-
      egress network proof from the original Task 15 plan. Verify scoped cleanup.
- [ ] Run the five hermetic Python suites individually; report per-suite counts,
      skips and durations without claiming overlapping suites as distinct totals.
- [ ] Push the revised PR #3 and require all four workflows on its final head.
      Record actual commands, SHAs, lane counts/skips/durations/links, cleanup,
      any owning-module repair RED/GREEN and remaining limitations. Deliver to
      Codex for independent review; do not merge or mark the gate passed.

Self-review: these tasks repair the four reviewed acceptance/evidence gaps;
the original full Task 15 plan and its scope boundaries remain in force.

After Codex accepts these proofs, Codex owns aggregate Tasks 1–15/gate review
and the final Task 16 server handoff. Phase 7 planning is not assigned here.
