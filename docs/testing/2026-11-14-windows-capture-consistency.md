# Windows Process-Tree Capture Consistency Evidence (2026-11-14)

- **Branch / PR:** `codex/agy-windows-capture-consistency` (Draft PR #22, base `origin/main` @ `c2d8225`)
- **Strict Scope (3 files vs `origin/main`):**
  - [`tests/helpers/process-lifecycle.ts`](../../tests/helpers/process-lifecycle.ts)
  - [`tests/process-lifecycle.test.ts`](../../tests/process-lifecycle.test.ts)
  - [`docs/testing/2026-11-14-windows-capture-consistency.md`](./2026-11-14-windows-capture-consistency.md)

## Round-2 Defects Resolved

1. **Missed newly spawned native child inside recent-capture window & closed-root orphan success:**
   - Removed the `< 250 ms` skip over live filtered WMI child expansion in [`inspectAndOptionallyReapWinTree`](../../tests/helpers/process-lifecycle.ts#L1160-L1834) so newly spawned native children under live captured parents are discovered immediately, and enforced fail-closed orphan detection via [`hasOwnedOrUnverifiedDescendantInWmi`](../../tests/helpers/process-lifecycle.ts#L1129-L1158) before returning clean exit ([call sites](../../tests/helpers/process-lifecycle.ts#L1214), [verification](../../tests/helpers/process-lifecycle.ts#L1747)).
   - Regression coverage (`fakeOps`): [`discovers and kills native children born immediately after recent capture (< 250 ms) and rejects closed-root unverified orphans`](../../tests/process-lifecycle.test.ts#L1322).
2. **Stale frontier / prefetch WMI adoption after parent PID reuse (`CreationDate` mismatch):**
   - Added [`mergeWmiSnapshotRows`](../../tests/helpers/process-lifecycle.ts#L557-L591) conflict invalidation at every capture and frontier merge site ([`captureProcessTreeOwnership`](../../tests/helpers/process-lifecycle.ts#L788), [`captureProcessTreeOwnership` follow-up](../../tests/helpers/process-lifecycle.ts#L925), [`inspectAndOptionallyReapWinTree`](../../tests/helpers/process-lifecycle.ts#L1291)) so changed `creationUs` evicts stale cached ancestry and blocks unrelated process adoption/signaling.
   - Regression coverage (`fakeOps`): [`invalidates stale WMI rows and never adopts or signals unrelated processes when a parent PID recycles during frontier or prefetch`](../../tests/process-lifecycle.test.ts#L1468).
3. **Short-budget auto-capture observer bounding (Round 1 + hardening):**
   - Scoped auto-capture initial WMI scan via [`_initialFilterRootPid`](../../tests/helpers/process-lifecycle.ts#L59) ([callers](../../tests/helpers/process-lifecycle.ts#L126), [filter setup](../../tests/helpers/process-lifecycle.ts#L676), [bounded follow-up](../../tests/helpers/process-lifecycle.ts#L897)) and tracked synchronous promise completion in [`settledCapturePromises`](../../tests/helpers/process-lifecycle.ts#L106) ([settle points](../../tests/helpers/process-lifecycle.ts#L970-L979), [reap check](../../tests/helpers/process-lifecycle.ts#L1943)) without altering `waitForExit`.
   - Regression coverage (`fakeOps`): [`bounds auto-capture observer lifecycle inside short custom caller budgets`](../../tests/process-lifecycle.test.ts#L1244).
4. **Retained Round-1 guarantees:** Coherent post-WMI MSYS confirmation ([`sameMsysIdentity`](../../tests/helpers/process-lifecycle.ts#L592)), multi-hop native frontier reaping ([`expandOwnedWinNodes`](../../tests/helpers/process-lifecycle.ts#L529)), fail-closed ancestor checks ([`tests/process-lifecycle.test.ts`](../../tests/process-lifecycle.test.ts#L1002-L1243)), and real Windows MSYS2 background-tree / canary checks ([`tests/process-lifecycle.test.ts`](../../tests/process-lifecycle.test.ts#L405-L536)).

## Historical Failures & `/tmp:size=16m` Investigation (`1fa4877`)

- **Round 1 (`f7e0b6f`):** Rejected in Codex review for the two P1 ownership/recent-capture regressions above.
- **Round 2 (`1fa4877`):** Fixed both P1 cases locally (solo 4-worker Windows `npm test` passed `2265 passed | 461 skipped (2726)` in `250.92s`) and passed `16/18` Linux CI checks (including `tests/process-lifecycle.test.ts`: `38 tests | 4 skipped`). Only the two Linux `validate` runs (`43688890082`, `43688896239`) failed in `tests/phase0-gate-validator.test.ts` with `ENOSPC` inside `createFixture()`.
- **Root cause (`ENOSPC`):** [`scripts/test-encrypted-backup.sh`](../../scripts/test-encrypted-backup.sh#L270-L277) mounts `/tmp` as `size=16m` (`--cpus 1`, `TMPDIR=/tmp`). `createFixture()` copies `docs`, `AGENTS.md`, `README.md`, `migrations`, `scripts`, `src`, and `tests` (`714` files, `9.0898 MiB` 4K+dirs at `1fa4877` vs passing `9.0859 MiB` on PR #23 `46c0e6d` and `9.0547 MiB` on `f7e0b6f`) alongside `node-compile-cache`. Auditing all 63 preceding test files showed zero `/tmp` test leaks.
- **Scope-preserving mitigation:** Deduplicated shared fake-child and `WinTreeTestOps` test builders in `tests/process-lifecycle.test.ts` (`70,153` -> `55,553` bytes without altering any test assertion or `tests/helpers/process-lifecycle.ts`) and compacted this report so `createFixture()` 4K+dirs footprint stays below passing baseline PRs (`<= 9.06 MiB`).

## Verification Ledger (Current Head vs Historical)

| Check / Scope                                                                                                                                                                     | Outcome                               | Notes                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/backup-harness-containment.test.ts tests/operations-promotion-controller.test.ts tests/process-lifecycle.test.ts tests/health-stdio-docker-harness.test.ts` | **PASS** (`4 passed`)                 | `97 passed \| 1 skipped (98)` in `77.48s`; `process-lifecycle.test.ts`: `38 passed \| 1 skipped` (`12.87s`) |
| `$env:VITEST_MAX_WORKERS='4'; npm test` (solo Windows)                                                                                                                            | **PASS** (`123 passed \| 14 skipped`) | `2265 passed \| 461 skipped (2726)` in `255.11s`; zero lingering shell/cscript processes                    |
| Static & security gates (`validate:phase0`, `format:check`, `lint`, `typecheck`, `build`, `npm audit`, `verify-security-policy.ts`, UI/SEO audit scaffolds)                       | **PASS**                              | Verified on final file tree before commit (see PR #22 check summary for immutable CI URLs)                  |

## Remaining Limitations & Non-Proven Claims

- **Fake-signal Win32 tests vs live kernel scheduling:** Round-2 ownership race tests inject deterministic snapshots via `_winTreeOps` and `EventEmitter` children; live Windows PID-reuse races inside native `ps.exe`/`cscript.exe` timing windows cannot be deterministically forced in unit tests.
- **Native observer budget floor:** Cold `cscript.exe` (`win32-process-snapshot.vbs`) startup on Windows typically takes ~1–3s, so very short custom timeouts (`< 500 ms`) still rely on bounded abort and fail closed if descendants remain unverified.
- **Linux `validate` combined-PR headroom:** Because `PR #22` + `PR #23` together add ~`130+ KiB` of docs/tests while `tests/phase0-gate-validator.test.ts` copies the whole tree into `size=16m` `/tmp`, a separate follow-up on `main` should scope `createFixture()` to referenced files or enlarge `unit` `/tmp`.
- **Clean boundaries:** Primary checkout (`J:\DevDrive\fcd-support`), `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`, and live server state remain untouched.
