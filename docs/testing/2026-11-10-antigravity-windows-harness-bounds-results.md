# Windows Harness Deadline Reliability and Process Reaping Results

- Date: 2026-11-10 (Asia/Dhaka)
- Author: Antigravity (AGY)
- Target: Codex Review
- Branch: `codex/agy-windows-harness-bounds`
- Worktree: Isolated worktree `J:\DevDrive\fcd-support-agy-windows-harness`
- Main Baseline Commit: `88de2eeb693c08559e57295aa6ca8d1cd27bd104`
- Handoff Reference: [`docs/handoffs/2026-11-09-antigravity-windows-harness-bounds.md`](../handoffs/2026-11-09-antigravity-windows-harness-bounds.md)

---

## 1. Executive Summary and Authority Boundary

This package completes the bounded test-harness and process-reaping fixes for the three Windows 5,000 ms timeout cases identified in the 2026-11-07 broader Windows run (`2,000` passed, `446` skipped, `3` timeouts) while strictly preserving the default **5,000 ms** Vitest timeout contract in [`vitest.config.ts`](../../vitest.config.ts) and leaving all production source, shell controllers, runtime contracts, and primary/Codex worktrees untouched.

- **Strict Scope Boundary:** Only test files, test helpers, and this dated results artifact were modified:
  1. [`tests/helpers/process-lifecycle.ts`](../../tests/helpers/process-lifecycle.ts): fixed Windows process-tree reaping (`reapChildProcess(..., { processGroup: true })`), including Git-for-Windows MSYS2 `fork()+exec()` descendants under `set -Eeuo pipefail`, and added `runBoundedCommand` (`3,500 ms` child deadline + `500 ms` + `500 ms` termination grace) with stdio drainage and guaranteed `finally` reaping.
  2. [`tests/helpers/backup-harness-fixture.ts`](../../tests/helpers/backup-harness-fixture.ts): eliminated repeated external MSYS2 binary forks (`cat`, `grep`, `awk`, `tail`, `mv`, `rm`, `/usr/bin/env`) in `createMockDocker()` in favor of bash builtins and added hermetic `SIMULATE_STALL` fault injection.
  3. [`tests/backup-harness-containment.test.ts`](../../tests/backup-harness-containment.test.ts): replaced synchronous blocking `spawnSync(..., { timeout: 10000 })` with async `runBoundedCommand` (`3,500 ms` child deadline, `500 ms` + `500 ms` grace), tracked test-owned children in `afterEach`, preserved all containment/cleanup/refusal assertions, and added stall/failed-init/interrupted-barrier reaping regressions.
  4. [`tests/operations-promotion-controller.test.ts`](../../tests/operations-promotion-controller.test.ts): replaced synchronous `spawnSync` (`timeout: 15000` / `10000`) with `runBoundedCommand` (`3,500 ms` deadline, `500 ms` + `500 ms` grace), replaced external `cat`/`touch` subshells in mock `scenario.sh`/`actor.sh` ports with bash builtins, guaranteed child reaping before scratch removal on both normal disposal and timeout/error paths, and added stall/failed-init/interrupted-barrier reaping regressions.
  5. [`tests/process-lifecycle.test.ts`](../../tests/process-lifecycle.test.ts): added deterministic Windows shell-tree stall reaping tests covering both direct `sleep` and MSYS2 `fork()+exec()` under `set -Eeuo pipefail`.
- **Zero Production Changes:** Zero edits to `src/`, `scripts/*.sh`, `infra/`, `migrations/`, `package.json`, `vitest.config.ts`, or `.github/`.
- **Zero External/Server Side Effects:** Primary `main` checkout (`J:\DevDrive\fcd-support`) remains clean at `88de2ee`. No Docker daemon, SSH, shared-server, Meta, Manifest, n8n, or ClickUp actions were performed.

---

## 2. Baseline Profiling on `main` (`88de2ee`) and Root Causes

### Pinned Toolchain Measured

- Node.js: `v24.19.0`
- npm: `11.17.0`
- Git Bash: `GNU bash, version 5.3.15(2)-release (x86_64-pc-cygwin)` (`C:/Program Files/Git/bin/bash.exe`)

### Baseline 4-Worker Profiling (Before Edits)

- `npx vitest run tests/backup-harness-containment.test.ts tests/operations-promotion-controller.test.ts --maxWorkers=4`: **45 passed / 0 failed** in `74.05s`.
  - `tests/backup-harness-containment.test.ts` total: `19,152 ms` (slowest cases: `3,270 ms` and `3,265 ms`).
  - `tests/operations-promotion-controller.test.ts` total: `73,824 ms` (`create-lost-ack`: `2,563 ms`; slowest case: `2,684 ms`).
- Single-test wall-clock runs via `Measure-Command` (`npx vitest run ... -t ...`) measured total per-invocation budget proximity:
  - `verifies that the ro initializer container uses strict containment flags`: **`4,764.6 ms`**
  - `failed initializer is removed by its exact ID before owned volume cleanup`: **`4,647.4 ms`**
  - `lost PostgreSQL create acknowledgement requires a complete fresh postcondition and is never replayed`: **`4,256.0 ms`**
- **Retained Uncertainty:** The fresh two-file 4-worker baseline passed without reproducing a timeout on this host. While the single-test wall-clock timings (`4,256.0`–`4,764.6 ms`) and fork counts establish near-zero margin under 4-worker contention, the exact historical machine-load schedule that pushed the 2026-11-07 133-file run over `5,000 ms` is not reconstructed.

### Root Causes Identified

1. **Unbounded Synchronous Child Deadlines Exceeding Test Contract:**
   `tests/backup-harness-containment.test.ts` used blocking `spawnSync(..., { timeout: 10000 })` and `tests/operations-promotion-controller.test.ts` used blocking `spawnSync` with `timeout: 15000` / `timeout: 10000` inside a **5,000 ms** Vitest test timeout (`vitest.config.ts`). Synchronous blocking prevented clean async interruption and left child deadlines longer than the enclosing test budget.
2. **Windows MSYS2 External Fork Amplification:**
   Each external MSYS2 binary invocation on Windows (`env.exe`, `cat.exe`, `grep.exe`, `awk.exe`, `tail.exe`, `touch.exe`, `mv.exe`, `rm.exe`) adds ~30–45 ms per fork (`#!/bin/bash` vs `#!/usr/bin/env bash` plus builtins saved ~45+ forks in `createMockDocker()` and ~40+ `$(cat ...)` / `touch` forks per `scenario.sh`/`actor.sh` invocation). Across 4 concurrent Vitest workers, those unnecessary forks pushed individual tests to the edge of 5,000 ms.
3. **Windows Descendant Reaping Defects (`winProcessTree` & MSYS2 `fork()+exec()`):**
   - `reapChildProcess` originally disabled process-group cleanup (`processGroup = false`) on `win32`; `child.kill('SIGTERM')` terminated only the parent `bash.exe`, leaving descendants holding stdio pipes open (`test_child_reap_unconfirmed` / pipe hangs).
   - Simply switching Windows to `taskkill /PID <pid> /T /F` still failed deterministically on scripts enabling `set -Eeuo pipefail` (such as [`scripts/operations-common.sh`](../../scripts/operations-common.sh)), because MSYS2/Cygwin `bash` executes `fork()` followed by `exec()`, creating an intermediate stub Windows process that spawns `sleep.exe` and exits immediately. That exit breaks the Win32 `ParentProcessId` chain so `taskkill /T` misses `sleep.exe`, leaving stdout/stderr open and throwing `test_child_reap_unconfirmed`.
   - Fixed in [`tests/helpers/process-lifecycle.ts`](../../tests/helpers/process-lifecycle.ts) by taking a numeric-only MSYS2 process table snapshot (`ps.exe -lW` columns `pid`, `ppid`, `pgid`, `winPid` — never inspecting command lines or unrelated process arguments), correlating root/killed `winPid` values from `taskkill`, and terminating transitive MSYS2 `ppid`/`pgid` descendants via `kill.exe` before confirming stdio closure across escalation stages (`!closed()`).

---

## 3. Deterministic RED and GREEN Verification Evidence

### Deterministic RED Controls (Captured Before Corresponding Fixes)

1. **RED 1 — Windows descendant stdio retention in `reapChildProcess`:**
   - Test: `tests/process-lifecycle.test.ts` > `reaps an owned shell process tree retaining stdio on stall within bounded deadline` (`spawn(bash, [..., '-c', 'sleep 10'])` + `reapChildProcess(..., { processGroup: true })`).
   - Pre-fix failure: **`Error: test_child_reap_unconfirmed`** (`1,237 ms`). Separately verified in Node that parent `exit` fired immediately while `close` hung `9,675 ms` until `sleep 10` exited.
2. **RED 2 — MSYS2 `fork()+exec()` under `set -Eeuo pipefail` breaking `taskkill /T`:**
   - Test: `tests/operations-promotion-controller.test.ts` > `stalled promotion child execution is bounded and reaped before fixture cleanup within 5000ms contract` (`fixture('stall', 'quiescent', 1500)`).
   - Pre-hybrid-reap failure (with `taskkill /T` alone): **`AssertionError: expected [Function] to throw error matching /Process exit timed out after 1500ms/u but got 'test_child_reap_unconfirmed'`** (`2,787 ms` in 4-worker run; `2,780 ms` isolated). OS process inspection confirmed `sleep.exe`'s Win32 `ParentProcessId` pointed to an exited Cygwin stub rather than the live `bash.exe` PID, leaving `stdout.closed === false` and `stderr.closed === false` until `sleep` completed.
3. **RED 3 — Unbounded child timeout exceeding 5,000 ms contract:**
   - Test: `tests/backup-harness-containment.test.ts` > `stalled child harness execution hits bounded deadline and reaps before fixture cleanup` (`SIMULATE_STALL: '1'`).
   - Against the original `spawnSync(..., { timeout: 10000 })`, timed out at **`10,025 ms`** (**`AssertionError: expected 10005 to be less than 4500`**), exceeding the 5,000 ms contract by >5s.

### GREEN Verification on Final Local Code

1. **Focused 6-File 4-Worker Suite (Affected Suites + Direct Helper Consumers):**
   - Command:
     `npx vitest run tests/process-lifecycle.test.ts tests/backup-harness-containment.test.ts tests/native-test-harness.test.ts tests/operations-promotion-controller.test.ts tests/health-main.test.ts tests/systemd-contract.test.ts --maxWorkers=4 --reporter=verbose`
   - Outcome: **6/6 test files passed, 149 passed, 8 Linux-only skipped (157 total), exit 0 in `70.41s`.**
   - Affected/regression durations observed in this run:
     - `verifies that the ro initializer container uses strict containment flags`: **`2,163 ms`**
     - `failed initializer is removed by its exact ID before owned volume cleanup`: **`1,997 ms`**
     - `lost PostgreSQL create acknowledgement requires a complete fresh postcondition and is never replayed`: **`2,017 ms`**
     - `stalled child harness execution hits bounded deadline and reaps before fixture cleanup`: **`1,994 ms`**
     - `failed initialization and interrupted barrier paths reap children before fixture cleanup`: **`734 ms`**
     - `stalled promotion child execution is bounded and reaped before fixture cleanup within 5000ms contract`: **`1,940 ms`**
     - `failed promotion initialization and interrupted barrier paths reap children before cleanup`: **`706 ms`**
     - `reaps an owned shell process tree retaining stdio on stall within bounded deadline`: **`710 ms`**
     - `reaps an owned shell process tree retaining stdio after fork/exec under set -Eeuo pipefail`: **`665 ms`**

2. **Full Repository 4-Worker Windows Suite:**
   - Command: `npx vitest run --maxWorkers=4`
   - Outcome: **121 test files passed, 14 Linux/PostgreSQL-only skipped (135 total); 2,218 tests passed, 461 platform-skipped (2,679 total), exit 0 in `240.46s` (`tests 577.98s`).**
   - Observed per-test timings in the full 4-worker run:
     - `tests/backup-harness-containment.test.ts` (9 tests): `16,150 ms` (`verifies that the ro initializer container uses strict containment flags`: **`2,250 ms`**; `failed initializer is removed by its exact ID before owned volume cleanup`: **`2,161 ms`**; `stalled child harness...`: **`2,035 ms`**; `failed initialization and interrupted barrier...`: **`792 ms`**).
     - `tests/operations-promotion-controller.test.ts` (40 tests): `74,011 ms` (`lost PostgreSQL create acknowledgement...`: **`1,935 ms`**; max single case `mount-order`: **`2,519 ms`**; `stalled promotion child execution...`: **`2,004 ms`**; `failed promotion initialization and interrupted barrier...`: **`826 ms`**).
     - `tests/process-lifecycle.test.ts` (14 passed, 1 Linux-only skipped): `2,645 ms` (`...on stall...`: **`720 ms`**; `...fork/exec under set -Eeuo pipefail`: **`719 ms`**).

3. **Static Quality, Policy, and Diff Gates:**
   - `npm run validate:phase0`: exit 0 (`Phase 0 tracker, evidence, citations, launch-gate mappings, and authority boundary are valid.`)
   - `npm run format:check`: exit 0
   - `npm run lint`: exit 0
   - `npm run typecheck`: exit 0
   - `npm run build`: exit 0
   - `npm audit --omit=dev --audit-level=high`: exit 0 (`found 0 vulnerabilities`)
   - `node scripts/verify-security-policy.ts`: exit 0 (`732` tracked files scanned; heuristic pattern scan only)
   - `node scripts/verify-pr-handoff.ts`: `SKIP` locally (requires `GITHUB_EVENT_PATH`; enforced on PR CI)
   - `git diff --check`: exit 0 (zero whitespace issues)

---

## 4. Remaining Unknowns and Non-Delegated Scope

- **Non-Delegated Production/Server Scopes:** No edits or runs touched production controllers, PostgreSQL/Docker daemon state, shared server health hold, dashboard rollout, tunnels, Meta, Manifest, n8n, or ClickUp.
- **2026-11-07 Machine-Load Reproduction Uncertainty:** As noted in Section 2, the pre-fix 4-worker baseline did not reproduce the historical 2026-11-07 timeout failure on its own, though per-test margin before optimization (`4,256`–`4,765 ms` isolated) and synchronous `10,000`–`15,000 ms` child timeouts explained the failure envelope.
- **Linux / Native CI Portability Check:** Pending draft PR workflow results on `codex/agy-windows-harness-bounds`. Any pre-existing or unrelated runtime/health CI failures will be reported independently without relaxing validators or replaying uncertain scopes.
