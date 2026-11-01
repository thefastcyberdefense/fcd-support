# PR #3 correction review

Date: 2026-11-01 (Asia/Dhaka).
Decision: **Changes required; retain PR #3 as draft.**

Base: `2772d624c37411ebc75959407cd8416d098e732c`.
Head: `b3831b07024e5c7b7e6fde121062fce07bf2a256`.
PR: <https://github.com/thefastcyberdefense/fcd-support/pull/3>.
This review follows the initial `9a4fc61` findings and their correction plan.
No server, provider, tunnel, Meta or production action ran during this review.

## Corrections verified

- The scheduler test invokes real `operations_scheduled_main` and the actual
  `operations_preflight` lock. The competing invocation refuses before a job;
  later activation succeeds. Separate existing real PostgreSQL/CLI tests now
  assert current-slot archive counts, rather than test-written grep authority.
- A correctly owned mode-0700 read-only Docker mount produces kernel EROFS.
  Backup refusal preserves its signed synthetic baseline and has a writable
  control. Permission-admission and injected publish failures are named
  accurately, with actual parent stdout/stderr/error capture.
- The outbox test establishes a synthetic provider ledger ahead of a pending
  PostgreSQL row. One functioning provider instance supplies the separate
  unfenced control. Repeated restored-worker runs preserve the active hold and
  add no sends. This is a seeded older-snapshot state representation, not
  physical snapshot capture or `pg_restore`; existing isolated-restore tests
  remain separate evidence. Do not reopen the accepted seeded-state scope.
- The application/infra/package tree is unchanged from main. Changes remain
  confined to tests, the native test harness, CI and documentation.

## Remaining important findings

1. **The scheduler test can still leak a child and its lock.**
   `tests/systemd-contract.test.ts:583` awaits its barrier without an internal
   deadline; `:623` similarly awaits process exit. The outer Vitest timeout does
   not settle these promises or force their `finally`. A silent live child can
   therefore survive the failed test. Cleanup at `:668` waits for `exit` even
   after a failed spawn, which has no following exit event. Add internal
   rejecting deadlines, listener/timer cleanup, explicit failed-spawn handling
   and bounded termination/reaping, with real failure-path assertions.
2. **The new root initializer lacks fixture containment and cleanup proof.**
   `scripts/test-encrypted-backup.sh:149` creates the RO volume without refusing
   a preexisting name or verifying exact ownership/sole consumers before the
   root write. Its unnamed root container has the default shared bridge,
   writable root filesystem, default capabilities and unbounded resources.
   Existing cleanup addresses three different actor names and silently ignores
   volume removal failures. Refuse collisions; verify label/driver/options;
   identify and guard the exact initializer; use network none, read-only root,
   only necessary ownership capabilities, no-new-privileges and resource
   limits. Verify no consumers before removing the exact owned volume, and
   fail the gate if cleanup fails. Reuse the established contained pattern in
   `scripts/test-promotion-secret-ownership-docker.sh:13`.
3. **The evidence audit still contains false citations and guarantees.**
   Gap-map line 24 cites nonexistent `scripts/verify-tunnel-health.sh`; line 26
   cites nonexistent `tests/operations-drain.test.ts`; line 32 retains
   nonexistent `tests/webhook-signature.test.ts` and a nonexistent stale-
   signature title. Line 37 still names a nonexistent session-termination test
   and claims TCP/socket connection closure from authentication tests. Line 39
   retains a nonexistent `operations_lock` title. The checkpoint row claims
   schema/journal assertions not established by its cited unit cases. Narrow
   claims and match every file/title/assertion/lane. The results artifact must
   not mark bounded reaping or a complete citation audit done until corrected.

## Independent verification

All four final-head PR workflows are successful, independently checked through
GitHub:
[CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784120),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784131),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784129),
[private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784100).
Final-head job logs, reduced to safe counts, report:

- Native: **1,296 passed**, 55 files, 448.06 s.
- Grants PostgreSQL: **139 passed / one restore-only skip**, 13 files, 59.38 s.
- Restore units: **252 passed**, 12 files, 58.30 s.
- Two-cluster integration: **47 passed**, two files, 25.98 s.
- Full PostgreSQL: **621 passed / 52 lane skips**, 56 files, 140.63 s.

These lanes overlap and must not be summed. Passing workflows do not exercise
the silent-child or initializer-collision failure paths identified above.

Independent Windows `VITEST_MAX_WORKERS=4 npm run check` **exited 1** after
278.79 s: **1,921 passed / 435 platform skips / two failed**, 128 files.
Phase 0, formatting, lint and strict type checking passed. Build was not reached
in this local chain. The two failures were outer 5,000 ms timeouts:

- `tests/operations-controller.test.ts`: `public controller sequences verify
through the verified private primitives`.
- `tests/operations-promotion-controller.test.ts`: `lost PostgreSQL create
acknowledgement requires a complete fresh postcondition and is never replayed`.

The exact two assertions then passed without edits using one worker:
`VITEST_MAX_WORKERS=1 npx vitest run tests/operations-controller.test.ts tests/operations-promotion-controller.test.ts -t 'public controller sequences verify through|lost PostgreSQL create acknowledgement'`:
**two passed / 51 selection skips**, two files, 4.32 s. This focused rerun does
not turn the failed full gate into a pass or prove the cause of the timeouts.
Require a clean full gate on the next source and investigate any recurrence;
do not change runtime operation limits to mask test-harness timing.

The five hermetic Python suites passed individually: observer **32 passed /
one Windows SIGHUP skip** (1.494 s); reboot **11 passed** (0.102 s); peer **11
passed** (0.055 s); rollback **6 passed** (0.044 s); current runtime **5 passed**
(0.400 s). Forced formatting of both changed evidence Markdown files and
`git diff --check 2772d62..b3831b0` passed. No local native/PostgreSQL/Docker
test lane ran in this review; their results above come from exact-source CI.

A separate read-only reviewer independently confirmed the three Important
findings and accepted the seeded-snapshot/provider scope. Task 11 remains
COMPLETE; Task 15 and P6-GATE are not accepted. P6-004/005/006 remain IN PROGRESS.
The older actor-loss incident remains open. No old journal, hold or server
baseline was modified.

Next assignment:
`docs/handoffs/2026-11-01-antigravity-task-15-harness-closeout.md`.

Final independent review found no Important/Critical problem in this bounded
correction assignment. Phase 0, forced Markdown formatting, targeted secret-
pattern and diff checks pass for the documentation-only tracker update. This
does not accept PR #3 or the phase gate.
