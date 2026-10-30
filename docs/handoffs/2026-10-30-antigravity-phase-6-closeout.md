# Antigravity next assignment: finish Phase 6 recovery, then matrix gaps

The owner explicitly asked Codex to select the next work package and share
implementation with AGY. Continue the approved Phase 6 sequence. Phase 7 waits
for P6-GATE; no new product architecture or live-service action is assigned.

## Read first

- `docs/reviews/2026-10-30-pr-2-review.md`
- `docs/superpowers/plans/2026-10-30-phase-6-recovery-and-failure-matrix-closeout.md`
- AGENTS, PLAN, current TODO/context and SYNTHETIC_FIXTURE_POLICY.

These new documents are on `origin/main`. If absent from your review branch,
read them with `git show origin/main:PATH` after fetching; do not check out or
modify the primary checkout to obtain them. Also read TODO and PROJECT_CONTEXT
from fresh `origin/main` even when older copies exist in your review branch.
Local prompt location:
`J:\DevDrive\fcd-support\docs\handoffs\2026-10-30-antigravity-phase-6-closeout.md`.

## Exact starting state

- Existing branch: `codex/agy-p6-ci-runtime-tests`.
- Existing clean worktree: `J:\DevDrive\fcd-support-agy-runtime-tests`.
- Required corrected ancestor: `c185c7d572b0b2ab6c91fa94a7c9f83dc630717b`.
- [PR #2](https://github.com/thefastcyberdefense/fcd-support/pull/2) remains
  **draft and unmerged**. Codex has returned bounded local/CI ownership to AGY.
- Latest [private-runtime run](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41000936811)
  fails in both fresh/precreated modes. Deploy through isolated restore passes;
  the interactive promotion job and selection become uncertain, before the later
  static stop/remove guard is reached. Exact internal cause is still unknown.
- General CI, CodeQL and PostgreSQL/native pass at this source. Full Windows
  check: 1,907 passed/433 skips/128 files, 251.04 s. Exact CI counts and limits
  are in the independent review; do not add overlapping lane totals.

Do not redo Codex's corrections: scheduled checkpoint admission, actual restore
record path, full-record mount sorting, explicit CI-only freshness profile,
closed stage reporting outside redirection, exact owned cleanup, or real UTF-8
observer tests. Add regressions only for genuinely missing behavior.

## Execution checklist

- [ ] Fetch, verify the clean isolated branch and full SHAs; fast-forward only.
      Read the linked plan and existing approved specifications.
- [ ] Execute plan Task 1 first. Diagnose the actual promotion exchange failure;
      minimally preserve bounded trusted transport-stage evidence if necessary.
      No timeout guess, blind retry, journal clearing or proof bypass.
- [ ] Add a genuine RED regression, implement the demonstrated minimal fix,
      and obtain actual complete public recovery/rollback/cleanup success in
      **both** existing ephemeral CI modes. Preserve all privacy/isolation guards.
- [ ] Push a separate validated Priority 0 checkpoint to PR #2 and report its
      exact SHA/workflows. Freeze that branch for Codex review; do not merge it.
- [ ] Create a second isolated branch/worktree `codex/agy-p6-failure-matrix`
      for plan Task 2's coverage map. While Task 11 remains incomplete, perform
      inventory/documentation only. Codex owns server proof and dependency closure.
- [ ] Only after Codex records Task 11 COMPLETE, merge current main into that
      second branch and execute Task 3's confirmed missing tests/minimal repairs.
      Open a separate draft PR. Do not expand into Phase 7 or self-approve P6-GATE.
- [ ] Write `docs/handoffs/2026-10-30-antigravity-phase-6-closeout-results.md`
      with checkboxes, Git-generated full SHAs, exact commands/counts/skips,
      durations, immutable CI links, genuine RED/GREEN, cleanup and remaining gaps.

## Required verification

Run focused tests first, then freeze each delivered checkpoint:

```text
VITEST_MAX_WORKERS=4 npm run check
python -B docs/operations/actions/2026-10-29-promotion-observer-test.py
bash scripts/test-docker-projections.sh
FCD_SYNTHETIC_TEST_PROJECT=fcd-support-test-agy-closeout bash scripts/test-encrypted-backup.sh grants
FCD_SYNTHETIC_TEST_PROJECT=fcd-support-test-agy-closeout bash scripts/test-encrypted-backup.sh restore
```

Use the appropriate shell's environment syntax on Windows. Run Docker/native/
PostgreSQL lanes sequentially. The grants/restore harness leaves its dedicated
Compose PostgreSQL service: independently verify the exact project, labels,
sole actor/volume/network consumers, then remove only that owned test project.
Never prune globally or delete an unknown resource. Run affected shell/Python
syntax checks and `git diff --check`. Force-format changed Markdown through
`npx prettier --check --ignore-path .gitignore EXACT_FILES` because default
formatting ignores docs. Record platform skips honestly. New exact-source CI
must pass all four workflows; a focused test or marker is not a full gate.

Check `redwan-cse` as the intended routine GitHub account before authorized
branch/PR writes. No owner credentials, protection bypass, force push, main push
or merge. Do not send messages to other chats or external people.

## Ownership and acceptance

Codex retains primary TODO/context, acceptance/threat/gate decisions, all
`docs/operations/actions/**`, the server runbook, SSH, deployment, concrete
repinning and independent gate review. AGY may not deploy or mutate any old
uncertain scope. All `6faff8b` and earlier journals/databases/volumes remain
preserved; their SQL outcome cannot be inferred.

The Priority 0 result is accepted only after real public controllers prove
verified backup, fresh checkpoint, completed isolated restore, distinct promoted
physical identity, READY/no active job, compatible retained rollback preserving
that identity, both volumes retained until success-only cleanup, and zero exact
owned Docker leftovers. No fallback or settlement shortcut is acceptable.

The matrix result is accepted only when every approved requirement maps to an
actual existing proof or a runnable confirmed gap test with honest execution
scope and cleanup. Live n8n/Manifest/Meta, host reboot and production evidence
remain at their later gates. No repeated routine approval is needed within this
package; a new authority boundary must be reported to Codex.
