# Windows Four-Worker Capture and Reap Consistency

Date: 2026-11-14 (Asia/Dhaka).

Base source: `94c95423feed20c866c9ab4a009ddde146674f57` (`origin/main`, containing `5ede82c`, PR #18 merge `f6ca679`, PR #19 merge `2e24997`, and `ba85e77`).

Handoff: [2026-11-11-antigravity-windows-capture-consistency.md](../handoffs/2026-11-11-antigravity-windows-capture-consistency.md).

## Scope Summary

This change stabilizes Windows four-worker process-tree ownership capture and bounded reaping inside `tests/helpers/process-lifecycle.ts` and adds deterministic synthetic controls in `tests/process-lifecycle.test.ts` within the unchanged **5,000 ms** Vitest test timeout and **1,000 ms** shared execution/reap cleanup budget (`500 ms` term + `500 ms` kill).

No production scripts, `src/`, `infra/`, `migrations/`, `package.json`, `package-lock.json`, `vitest.config.ts`, assertion strictness, retry/skip rules, or Win32 `CreationDate`/group-anchor/canary safety invariants were relaxed or altered.

## Historical and Intermediate Failing Results (Retained)

- **Recorded `5ede82c` four-worker baseline**: **2,250 passes / 461 skips / 2 failures** (`backup-harness-containment` failed initialization/interrupted-barrier cleanup and `process-lifecycle` closed-stdio MSYS descendant cleanup, both failing closed with `test_child_reap_unconfirmed`).
- **Diagnostic four-worker reproduction after initial overlap fixes**: `tests/backup-harness-containment.test.ts > stalled child harness execution hits bounded deadline and reaps before fixture cleanup` failed intermittently with `test_child_reap_unconfirmed` at `2,538–2,574 ms` (leaving `~944–973 ms` inside the shared reap window after a `1,500 ms` execution deadline + fixture drain), producing `1` failure across intermediate full (`2254 passed | 461 skipped | 1 failed` and `2256 passed | 461 skipped | 1 failed`) and focused (`178 passed | 1 failed`) four-worker runs.
- **Standalone post-`READY` child-birth non-reproduction**: 10/10 isolated four-worker reproduction trials of `sleep 15 &` immediately after `READY` under Git for Windows `bin/bash.exe` -> `/usr/bin/bash` completed cleanly without losing descendant WinPIDs.
- **Unrelated intermediate `health-stdio-docker-harness` timeout**: One complete four-worker run after the final `process-lifecycle.ts` fix recorded **zero** `test_child_reap_unconfirmed` failures across all reap/lifecycle/containment/evidence files (`122 passed | 1 failed | 14 skipped` files, `2256 passed | 1 failed | 461 skipped` tests, `282.06s`), while `tests/health-stdio-docker-harness.test.ts > scripts/test-health-stdio-docker.sh harness controls > cleanup preserves pre-creation resources and removes only exact ledger and owned child resources while keeping canaries` exceeded its `3,500 ms` `waitForExit` cap once at `3,711 ms` (passing at `3,387 ms`, `3,514 ms`, and `3,573 ms` in three separate four-worker runs alongside neighboring fixture suites because each test invocation cold-starts multiple sequential `node.exe` mock-docker processes).

## Bounded Phase Timing Breakdown and Root Causes

Under four-worker Windows contention, external diagnostic helper invocations show the following closed latency bands (no raw host PIDs, command lines, snapshots, or secrets are included):

| Phase / Tool Call | Measured 4-Worker Latency | Role in `5ede82c` & Intermediate Failures |
| --- | --- | --- |
| MSYS2 process table (`ps.exe -lW`) | `114–187 ms` | Initial or confirmation MSYS candidate enumeration |
| Filtered WMI query (`cscript.exe`, scoped PIDs) | `290–420 ms` (up to `563 ms` under peak load) | `Win32_Process` `CreationDate` and parent/child resolution |
| Unfiltered WMI query (`cscript.exe`) | `480–580 ms` | Full-host WMI fallback when unfiltered |
| MSYS2 signal tool (`kill.exe -s KILL`) | `35–57 ms` | Terminating verified MSYS PIDs and `-<pgid>` groups |
| Stalled backup harness reap budget | `~944–977 ms` | Remaining shared budget after `1,500 ms` stall timeout |

### Localized Loss-of-Proof Mechanisms Fixed

1. **Short interrupted-barrier auto-capture truncation (`AUTO_CAPTURE_MIN_TIMEOUT_MS = 1200`)**: Background ownership capture spawned alongside `runBoundedCommand` inherited short explicit `timeoutMs` values (such as `300 ms` in interrupted-barrier tests), causing WMI capture (`~400–550 ms`) to abort before observing the root process. Setting a `1200 ms` capture floor preserves full root and wrapper observation without extending caller test timeouts.
2. **MSYS/WMI capture-window descendant race (`captureProcessTreeOwnership`)**: Descendants spawning in the MSYS2 window between the initial WMI query and MSYS snapshot (`runMsysOwnershipPass`) lacked WMI rows (`unresolvedWinPids`). Added a targeted `ops.readWmiSnapshot(remainingMs(deadlineMs), [...unresolvedWinPids])` follow-up and re-expansion pass while gating `canReuseRecentWmi` so stale capture rows are never reused when new uncaptured WinPIDs appear.
3. **Closed-root sequential inspection overrun (`inspectAndOptionallyReapWinTree`)**: When `!rootStillRunning && !canReuseRecentWmiWindow`, running MSYS (`~150 ms`) and WMI (`~400 ms`) sequentially plus kill (`~50 ms`) and confirmation MSYS (`~150 ms`) pushed total reap latency near `750–900+ ms`. Overlapping `readMsysSnapshot` and filtered `readWmiSnapshot(..., prefetchFilterPids)` via `Promise.all` saves one full MSYS round-trip.
4. **Live-root stale-prefetch double WMI penalty**: For older running trees (`rootStillRunning && !canReuseRecentWmiWindow`, common in stalled backup harness runs whose capture occurred `490–980 ms` earlier), prefetching WMI using only initial capture PIDs missed newly spawned descendants and triggered a second sequential `missingFilterPids` WMI query (`2 × ~350–400 ms`), overflowing the `~950 ms` budget. Reading MSYS first on older live roots and running one filtered WMI query covering both `ownedWinNodes` and live `candidateMsys` WinPIDs eliminates duplicate WMI queries; `allLiveCandidatesUnchanged` is strictly gated on `canReuseRecentWmiWindow`.
5. **Exited transient child blocking owned PGID signaling (`queriedWmiPidSet`)**: Under 4-worker contention during `stalled child harness execution`, short-lived MSYS children observed in `ps.exe` (`t ~ 137 ms`) exited before filtered `cscript.exe` WMI finished (`t ~ 533 ms`), yielding `liveWmi === undefined`. Previously, both verification loops added any member with `liveWmi === undefined` into `candidatePgidsWithUnownedMember`, suppressing `-<pgid>` signaling (`verifiedPgids` empty) and allowing sibling descendants spawned during the MSYS-to-WMI gap to survive `process.kill(winPid)`. Restricting `liveWmi === undefined` disqualification to unqueried WinPIDs (`!queriedWmiPidSet.has(row.winPid)`) preserves owned PGID termination whenever a queried member exited cleanly while keeping `liveWmi !== undefined` CreationDate mismatches, alien UIDs, recycled PGIDs (`liveCapturedGroups` empty), and unqueried rows fail-closed.

## Deterministic RED->GREEN Synthetic Controls

Five deterministic `_winTreeOps` unit controls in `tests/process-lifecycle.test.ts` (lines `798–1223`) pin each localized mechanism inside the unchanged `CreationDate`, `liveCapturedGroups`, and canary contracts:

| Control (`tests/process-lifecycle.test.ts`) | Verified Mechanism |
| --- | --- |
| `captures newly spawned MSYS descendants born between WMI and MSYS capture before closed-root reap` | Capture follow-up WMI query for MSYS descendants missing from initial WMI |
| `does not reuse stale recent WMI rows or poison owned PGIDs when a child spawns after capture` | Prevents stale `recentWmiRows` reuse and preserves group killing on post-capture birth |
| `overlaps closed-root MSYS and filtered WMI inspection within shared reap budget` | Proves MSYS + WMI execute concurrently within tight reap budgets when root is closed |
| `avoids duplicate sequential WMI calls when an older live root spawns a descendant before reap` | Enforces at most one filtered WMI snapshot during older live-root reap |
| `does not let an exited transient child in an owned PGID block group signaling` | Reproduces MSYS->WMI transient exit (`liveWmi === undefined`) and confirms `-<pgid>` fires |

## Validation Results (`VITEST_MAX_WORKERS=4` on Windows)

- **Focused 5-file four-worker run** (`tests/process-lifecycle.test.ts`, `tests/backup-harness-containment.test.ts`, `tests/health-stdio-regression.test.ts`, `tests/promotion-static-metadata.test.ts`, `tests/synthetic-host-evidence.test.ts`): **5 passed (5)** test files, **208 passed | 1 skipped (209)** tests (`1` POSIX-only `processGroup` test skipped on `win32`), `53.56s`.
- **8-run four-worker stress loop** across the four competing fixture/reap suites (`synthetic-host-evidence`, `promotion-static-metadata`, `health-stdio-regression`, `backup-harness-containment`): **8/8 runs passed** (`4 passed (4)` files, `179 passed (179)` tests per run; durations `51.01s–54.66s`; temporary `FCD_REAP_PROFILE=1` diagnostic removed afterwards).
- **Complete 4-worker Windows Run 1 (`npm test`)**: **Test Files 123 passed | 14 skipped (137)**, **Tests 2257 passed | 461 skipped (2718)**, **`254.33s`**, exit `0`.
- **Complete 4-worker Windows Run 2 (`npm test`)**: **Test Files 123 passed | 14 skipped (137)**, **Tests 2257 passed | 461 skipped (2718)**, **`249.29s`**, exit `0`.
- **Linux / two-worker distinction**: Two-worker and Linux CI outcomes remain labeled separately and do not replace four-worker Windows verification.

## Remaining Limitations

- Windows process-tree inspection still invokes external `ps.exe` (`~114–187 ms`) and `cscript.exe` WMI (`~290–563 ms`), leaving an inherent OS process-spawn floor within `1,000 ms` shared reap budgets when multiple unrelated workers saturate CPU simultaneously. Eliminating WMI process spawn overhead entirely would require a native Win32 Job Object or FFI implementation, which is outside this task's approved scope and would require a separate architecture/dependency review.
- Unrelated `tests/health-stdio-docker-harness.test.ts` ledger cleanup invokes many sequential `node.exe` mock-docker processes inside a `3,500 ms` `waitForExit` window (`~3,387–3,573 ms` under four workers) and remains unchanged here as out of scope.
