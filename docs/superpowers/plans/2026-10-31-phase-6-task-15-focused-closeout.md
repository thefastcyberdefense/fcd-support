# Phase 6 Task 15 focused closeout plan

This narrows Task 3 of the approved 2026-10-30 recovery/failure-matrix plan.
Existing owner approval covers local synthetic implementation. Task 11 must
first be recorded COMPLETE by Codex; this document does not close that dependency.
Codex retains server execution and the independent whole-phase gate review.

## Task 1: Correct the evidence inventory

- [ ] Fetch current main in `codex/agy-p6-failure-matrix` and merge it without
      rewriting history. Keep the primary checkout untouched. Main `67a4a4b`
      is already integrated at `ac6e7c0`; read fresh TODO/context for later changes.
- [ ] Audit every gap-map citation against an actual test and its assertions.
      Separate existing coverage, unexecuted tests and server/live evidence.
      Disabled composition or FAQ bypass does not prove model-provider outage.
- [ ] Retain the actual ENOSPC test in `tests/backup.test.ts` and existing
      restore quarantine and fake timer-lock tests. Never relabel them missing.

## Task 2: Read-only backup destination failure

- [ ] Identify the owning backup API and write a test using an actual guarded
      read-only filesystem destination, with a successful writable control.
      Retain the existing Linux ENOSPC proof rather than duplicating it.
- [ ] Assert failure produces no successful catalog/manifest publication,
      preserves a previously valid authenticated archive and leaves no newly
      owned partial ciphertext or temporary plaintext. Assert the closed error
      and absence of synthetic sensitive sentinels in captured output.
- [ ] Run the new assertion before any owning-module change. If it already
      passes, record this as added coverage, not an invented RED. Any actual
      defect requires genuine RED followed by the minimal fix and GREEN.

## Task 3: Restored outbox cannot blindly resend

- [ ] Compose the existing real isolated-restore/recovery fence with the owning
      outbox worker and an injected synthetic provider. Exercise accepted work
      and the ambiguous older-snapshot case; prove the exact persisted state.
- [ ] Assert zero provider send calls while inherited work is quarantined or
      recovery-held. A same-provider successful eligible control must send once.
      Repeated worker activation must not create a resend or clear a hold.
- [ ] Derive observations from actual PostgreSQL and captured client calls.
      A snapshot predating provider acceptance is not permission to send.
      Do not add provider-status lookups, an automated recovery resolver,
      forced settlement or a new resend/reconciliation policy.
- [ ] Add only demonstrated minimal owning-module repairs with real RED/GREEN.

## Task 4: Real scheduled-operation lock concurrency

- [ ] Use two real Unix processes and the actual nonblocking flock boundary
      against one protected synthetic scope. Prove the first activation owns
      the lock and the second refuses without entering any job.
- [ ] Use a deterministic barrier rather than a guessed sleep. After release,
      prove a later eligible activation can run and a repeated current slot is
      deduplicated through the actual owning operation/catalog boundary.
- [ ] Preserve fail-closed lock conflict behavior. Do not introduce waiting
      queues, replay loops, multiple missed-slot backups or policy changes.
      The existing fake `operations_preflight` lock test remains useful but is
      not a substitute for this real concurrency assertion.

## Task 5: Verification and independent delivery

- [ ] Run focused checks, then final `VITEST_MAX_WORKERS=4 npm run check`.
      Run native/grants/restore and affected Docker/network lanes sequentially,
      including the existing multihomed ordinary-egress isolation proof.
- [ ] Verify exact ownership/sole consumers before scoped cleanup. Never prune
      globally or delete any old server scope or unknown resource.
- [ ] Force-format changed Markdown with `--ignore-path .gitignore`; run shell/
      Python syntax where affected, secret-pattern checks and `git diff --check`.
- [ ] Commit and push the isolated branch, open a draft PR, and require all four
      exact-source workflows. Report full Git-generated SHAs, actual commands,
      counts/skips/durations, immutable CI links, cleanup and unresolved evidence.
- [ ] Update the results document requested by the existing handoff. Record
      newly authored coverage separately from genuine reproduced fixes. Codex
      independently reviews the whole phase before any P6-GATE decision.

No SSH, provider/Meta/n8n/Manifest call, tunnel/public change, credential access,
production action, primary tracker edit, action-script edit or main merge is
assigned to AGY. Phase 7 remains outside this task.
