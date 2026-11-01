# Phase 6 Task 15 Closeout Results

Date: 2026-11-01 (Asia/Dhaka).
Author: Antigravity (AGY).
Worktree: `J:\DevDrive\fcd-support-agy-failure-matrix`.
Branch: `codex/agy-p6-failure-matrix`.
PR: <https://github.com/thefastcyberdefense/fcd-support/pull/3> (Draft).
Base Revision: `2772d624c37411ebc75959407cd8416d098e732c`.
Merged Latest Main: `0a37a63d91ea1d07c3be053075677dca7e387062`.
Primary Checkout Untouched: `J:\DevDrive\fcd-support` on `main` at `0a37a63d91ea1d07c3be053075677dca7e387062`.

---

## 1. Executive Summary & Deliverables

All assigned Phase 6 Task 15 review corrections and harness closeout items have been implemented and verified in strict accordance with `docs/reviews/2026-11-01-pr-3-correction-review.md`, `docs/handoffs/2026-11-01-antigravity-task-15-harness-closeout.md`, and `docs/superpowers/plans/2026-11-01-phase-6-task-15-harness-closeout.md`:

1. **Internally Bounded Child Lifecycle & Reaping (Task 1):**
   - Implemented bounded process lifecycle helpers in [`tests/helpers/process-lifecycle.ts`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/tests/helpers/process-lifecycle.ts) and verified via 10 cross-platform unit tests in [`tests/process-lifecycle.test.ts`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/tests/process-lifecycle.test.ts).
   - `waitForBarrier`: awaits deterministic barrier with internal rejecting deadline comfortably within Vitest's outer budget; removes all listeners and timers on resolve, reject, error, premature exit, or timeout; preserves split-chunk marker handling.
   - `waitForExit`: awaits process exit with internal rejecting deadline, clearing timers and listeners on completion.
   - `reapChildProcess` / `reapChildProcesses`: bounds shutdown/reaping; detects never-spawned children (`pid === undefined`) and avoids hanging on exit; sends SIGTERM; escalates to SIGKILL if SIGTERM is ignored; confirms stdio closure and reaping before scratch directory removal.
   - Integrated into [`tests/systemd-contract.test.ts`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/tests/systemd-contract.test.ts): verified that silent owner child times out internally and enters `finally` reaping, releases the flock, and enables subsequent scheduler activation; verified graceful handling of premature exit and failed spawn without stranding locks or processes.
   - Preserved accepted real `operations_scheduled_main` and `operations_preflight` locking against `deployment.lock`, plus PostgreSQL catalog slot deduplication in [`tests/integration/postgres-encrypted-backup.test.ts`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/tests/integration/postgres-encrypted-backup.test.ts).

2. **Contained RO Volume Initializer & Verified Cleanup Gate (Task 2):**
   - Reused the contained pattern from `scripts/test-promotion-secret-ownership-docker.sh` in [`scripts/test-encrypted-backup.sh`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/scripts/test-encrypted-backup.sh).
   - Refuses preexisting volume name collisions (`backup_volume_collision`, `ro_backup_volume_collision`) and initializer container collisions (`ro_initializer_collision`) before creating fixtures.
   - Validates creation acknowledgement, exact ownership label (`fcd-support.backup-test=$SCOPE`), local driver/scope, and verifies zero existing consumers (`docker ps --all --filter "volume=..."`) before writing.
   - Identified and contained the exact initializer container (`RO_INITIALIZER="$SCOPE-ro-initializer"`): runs with `--network none`, `--read-only` root, `--user 0:0`, dropped capabilities with only necessary ownership capabilities (`CHOWN`, `FOWNER`, `DAC_OVERRIDE`), `--security-opt no-new-privileges`, CPU/memory/PID bounds (`--cpus 0.25 --memory 128m --pids-limit 32`), and mounts no Docker socket or unrelated host path.
   - Updated `cleanup()` to verify exact volume ownership and zero remaining consumers before removal; uses `trap 'result=$?; cleanup || result=1; exit "$result"' EXIT` so cleanup failures or leftover consumers propagate and fail the gate.
   - Verified via 6 focused containment tests in [`tests/backup-harness-containment.test.ts`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/tests/backup-harness-containment.test.ts).

3. **Seeded Older-Snapshot State Representation (Task 3 - Accepted Scope):**
   - Maintained accepted seeded older-snapshot divergence in [`tests/integration/postgres-outbound-flow.test.ts`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/tests/integration/postgres-outbound-flow.test.ts): external provider acceptance ledger ahead of PostgreSQL state row (`pending` in DB, `accepted` in provider ledger).
   - Applied `PostgresRestoreFence.quarantine` on restored fixture: recovery hold active (`runtime_recovery_held() == true`), intent marked `canceled` (`restore_quarantined`).
   - Single synthetic provider instance captures send count across held and eligible-control runs; separate unfenced synthetic PostgreSQL database fixture dispatches once; repeated restored worker runs make zero sends; recovery hold preserved and never lifted.
   - Explicitly documented as seeded older-snapshot state representation, distinguishing it from physical snapshot capture or `pg_restore` (which are tested separately in `tests/integration/postgres-isolated-restore.test.ts`).

4. **Accurate Evidence & Citations Audit (Task 3):**
   - Audited every row, file path, test title, and assertion in [`docs/testing/phase-6-failure-matrix-gap-map.md`](file:///J:/DevDrive/fcd-support-agy-failure-matrix/docs/testing/phase-6-failure-matrix-gap-map.md):
     - Removed nonexistent `scripts/verify-tunnel-health.sh`; narrowed row to unit-level stale host attestation behavior in `tests/health-collector.test.ts#L220`.
     - Replaced nonexistent `tests/operations-drain.test.ts` with actual `tests/operations-drain-script.test.ts`.
     - Replaced nonexistent `tests/webhook-signature.test.ts` with actual `tests/integration/postgres-receipt-store.test.ts:290` (`records an inbound message older than five minutes as stale`).
     - Corrected admin identity revocation to `tests/integration/postgres-admin-identity.test.ts:333` (`expires, revokes, and bulk-revokes active sessions`); removed claims that these database tests close TCP/socket connections.
     - Replaced nonexistent `operations_lock` title with `tests/operations-scripts.test.ts#L236` (`host preflight handles %s without repairs or data mutation` with `lock-conflict`) and `tests/systemd-contract.test.ts#L482-L690`.
     - Narrowed checkpoint claims to verified manifest age, watermark epoch/sequence, signature HMAC, and completeness verification (`tests/deletion-checkpoint.test.ts#L28-L80`, `tests/integration/postgres-deletion-checkpoint.test.ts#L217-L272`).
     - Aligned provenance metadata: base `2772d624c37411ebc75959407cd8416d098e732c`, merged latest main `0a37a63d91ea1d07c3be053075677dca7e387062`.

---

## 2. Completed Checklist

- [x] Fetch, merge latest `main` (`0a37a63`), and preserve clean primary checkout `J:\DevDrive\fcd-support`.
- [x] Internally bounded barrier/exit waits and process reaping in `tests/systemd-contract.test.ts` and `tests/helpers/process-lifecycle.ts`.
- [x] Exercise silent owner, premature exit, and failed spawn; verify cleanup before Vitest outer deadline and release of flock.
- [x] Fresh owned RO volume admission, collision refusal, contained exact root initializer, and verified cleanup gate in `scripts/test-encrypted-backup.sh`.
- [x] Audit every gap-map citation, file, and title; remove nonexistent files/titles and unsupported transport claims.
- [x] Document historical failed Windows full check and its two passing focused reruns; require clean full gate on corrected source.
- [x] Label earlier workflow evidence by exact commit SHA; keep overlapping lane counts separate; report Python suites individually.
- [x] Verify forced Prettier formatting (`--ignore-path .gitignore`), ESLint strict rules, TypeScript build, and hermetic Python suites.
- [x] Push updated PR #3 and verify all four workflows on its final head.

---

## 3. Local Verification Commands and Results

### Historical Windows Verification Record on Reviewed Head `b3831b0`

During review of commit `b3831b0`, Windows full check (`VITEST_MAX_WORKERS=4 npm run check`) exited 1 after 278.79s: **1,921 passed / 435 platform skips / 2 failed** (128 files).
The two failures were outer 5,000ms timeouts under concurrent worker load:

1. `tests/operations-controller.test.ts`: `public controller sequences verify through the verified private primitives`
2. `tests/operations-promotion-controller.test.ts`: `lost PostgreSQL create acknowledgement requires a complete fresh postcondition and is never replayed`

In an unedited single-worker focused rerun (`VITEST_MAX_WORKERS=1 npx vitest run ...`), both assertions passed cleanly (**2 passed / 51 selection skips**, 4.32s). As noted by Codex, this focused rerun does not turn a failed full gate into a pass. The historical record is preserved here, and the full gate is re-verified on the corrected head.

### Verification Results on Corrected Head

| Command                                                                         | Suite / Target                                  | Result                                             | Duration | Notes                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | -------- | ------------------------------------------------ |
| `npm run validate:phase0`                                                       | Phase 0 gate validation                         | **PASSED** (code 0)                                | ~1.5s    | Trackers, evidence, and authority boundary valid |
| `npm run format:check`                                                          | Prettier code style                             | **PASSED** (code 0)                                | ~6.5s    | All matched files use Prettier style             |
| `npm run lint`                                                                  | ESLint strict rules                             | **PASSED** (code 0)                                | ~25.0s   | Zero errors, zero warnings                       |
| `npm run typecheck`                                                             | TypeScript (`tsc --noEmit`)                     | **PASSED** (code 0)                                | ~10.0s   | Zero type errors                                 |
| `npm run build`                                                                 | TypeScript build (`tsc -p tsconfig.build.json`) | **PASSED** (code 0)                                | ~9.5s    | Build output updated cleanly                     |
| `npm audit --omit=dev --audit-level=high`                                       | Production dependency audit                     | **PASSED** (code 0)                                | ~2.5s    | Zero high/critical vulnerabilities               |
| `VITEST_MAX_WORKERS=4 npm run check`                                            | Full local gate (validate, lint, test, build)   | **1,939 passed / 437 platform skips / 0 timeouts** | 254.60s  | 116 passed files, 14 integration skips (130)     |
| `npx vitest run tests/process-lifecycle.test.ts tests/systemd-contract.test.ts` | Bounded child lifecycle & scheduler contract    | **71 passed / 7 platform skips**                   | 10.45s   | 2 test files, 10 helper unit tests               |
| `npx vitest run tests/backup-harness-containment.test.ts`                       | RO backup harness containment & cleanup         | **6 passed**                                       | 12.87s   | 1 test file, strict flags & cleanup gate         |
| `python -B docs/operations/actions/2026-10-29-promotion-observer-test.py`       | Promotion observer                              | **32 passed / 1 platform skip** (Windows symlink)  | 1.163s   | Hermetic stdlib tests                            |
| `python -B docs/operations/actions/2026-10-31-reboot-recovery-test.py`          | Reboot recovery helper                          | **11 passed / 0 skips**                            | 0.071s   | Hermetic stdlib tests                            |
| `python -B docs/operations/actions/2026-10-31-peer-recovery-test.py`            | Peer recovery helper                            | **11 passed / 0 skips**                            | 0.041s   | Hermetic stdlib tests                            |
| `python -B docs/operations/actions/2026-10-31-rollback-after-reboot-test.py`    | Rollback helper                                 | **6 passed / 0 skips**                             | 0.034s   | Hermetic stdlib tests                            |
| `python -B docs/operations/actions/2026-10-31-current-runtime-recovery-test.py` | Current runtime recovery helper                 | **5 passed / 0 skips**                             | 0.265s   | Hermetic stdlib tests                            |
| `bash scripts/test-docker-projections.sh`                                       | Docker projection canonicalizer                 | **PASSED** (code 0)                                | ~8.0s    | All 6 projection tests passed                    |

### Hermetic Python Suites Breakdown

Each Python suite is executed independently and reported individually:

- Observer: **32 passed / 1 Windows symlink skip** (1.163s)
- Reboot: **11 passed / 0 skips** (0.071s)
- Peer: **11 passed / 0 skips** (0.041s)
- Rollback: **6 passed / 0 skips** (0.034s)
- Current Runtime: **5 passed / 0 skips** (0.265s)

Overlapping counts across different suites must not be summed as independent coverage.

### Prior PR #3 Workflow Runs by Commit SHA

- **Commit `6317aff8f6e38e8ac4734eb1b8d6932e226aee9a`:**
  - `PostgreSQL and native operations`: Run [`41279632399`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41279632399) passed in 11m5s.
  - `ci`: Run [`41279632419`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41279632419) passed in 4m35s.
  - `CodeQL Advanced`: Run [`41279632463`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41279632463) passed in 1m27s.
  - `Private runtime controller`: Run [`41279632446`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41279632446) passed in 7m29s.

- **Commit `b3831b07024e5c7b7e6fde121062fce07bf2a256`:**
  - `ci`: Run [`41280784120`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784120) passed in 5m22s.
  - `CodeQL Advanced`: Run [`41280784131`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784131) passed in 1m53s.
  - `PostgreSQL and native operations`: Run [`41280784129`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784129) passed in 16m22s.
    - Native: 1,296 passed, 55 files (448.06s).
    - Grants PG: 139 passed / 1 restore-only skip, 13 files (59.38s).
    - Restore units: 252 passed, 12 files (58.30s).
    - Two-cluster: 47 passed, 2 files (25.98s).
    - Full PG: 621 passed / 52 lane skips, 56 files (140.63s).
  - `Private runtime controller`: Run [`41280784100`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41280784100) passed in 19m37s.

- **Final Head Workflow Runs (Commit `fd60612401f808796855146c2d1b8e40f8078044`):**
  - `ci`: Run [`41293350626`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41293350626) passed in 3m59s (`validate` in 3m59s: static validation, build, dependency audit, unit tests with pinned UID and memory-backed scratch, Docker metadata projections, hermetic operator-helpers).
  - `CodeQL Advanced`: Run [`41293350632`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41293350632) passed in 1m0s (`Analyze (actions)` in 38s, `Analyze (javascript-typescript)` in 1m0s).
  - `PostgreSQL and native operations`: Run [`41293350623`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41293350623) passed in 11m37s (`postgres` in 2m59s, `native-operations` in 11m37s: grants, two-cluster restore, promotion, synthetic cleanup).
  - `Private runtime controller`: Run [`41293350625`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41293350625) passed in 9m18s (`private-runtime (fresh)` in 9m13s, `private-runtime (precreated)` in 9m18s: pinned compose 5.5.1, non-root user 1000:1000, private controller lifecycle).

---

## 4. Scoped Cleanup Verification

- Exact owned test containers (`$RO_INITIALIZER`, `$SCOPE-unit`, etc.) reaped and removed.
- Exact owned test volumes (`$RO_VOLUME`, `$VOLUME`, `$RESTORE_VOLUME`) checked for zero consumers and removed.
- Zero leftover files or orphan scratch directories.
- Preserved historical server state, uncertain scopes (`6faff8b` and earlier), and actor-loss incident evidence untouched.
- Primary checkout `J:\DevDrive\fcd-support` on `main` at `0a37a63d91ea1d07c3be053075677dca7e387062` remains completely untouched.

---

## 5. Remaining Scopes & Next Actions for Codex

1. **Independent P6-GATE Review:**
   - Codex retains authoritative review of the failure matrix coverage and final Phase 6 gate decision.
   - Task 11 is COMPLETE; Task 15 and P6-GATE remain pending Codex acceptance.
   - P6-004, P6-005, and P6-006 remain IN PROGRESS until final sign-off.
2. **Server Deployment & Incidents:**
   - Live test server restart and actor-loss incident remains open under Codex ownership.
   - All server-side actions, SSH, and production migrations remain excluded from AGY scope.
