# Track 1 Combined Validation & Windows Stability Record (2026-11-16)

- **Branch:** `codex/track1-combined-validation` (based on `origin/main` @ `c2d8225d2a096e2d4f406c35f8ab170a6dad2f80`)
- **Integration Order:**
  1. [`codex/agy-phase0-validator-headroom`](../testing/2026-11-15-phase0-validator-fixture-headroom.md) (Draft PR #24 @ `b162279dc0a13f1d19fe4c89a7cb432f3389c97d` — ancestor symlink/junction containment, directory-dependency refusal, `settleAllOrThrow`, and `716,800`-byte bounded Phase 0 validator fixtures integrated **first** so no combined commit hits `/tmp:size=16m` `ENOSPC`)
  2. [`origin/codex/agy-windows-capture-consistency`](../testing/2026-11-14-windows-capture-consistency.md) (Draft PR #22 @ `cc5c723a774f2f291985c9bbd3a043b91343acc6`)
  3. [`origin/codex/agy-phase-7-current-runbook`](../testing/2026-11-14-phase-7-current-runbook.md) (Draft PR #23 @ `46c0e6dc6e3827764e7c2992fab23535506c33a7`)
  4. Track 1 Windows reliability fixes, build-before-test `check` ordering, and [`docs/reviews/phase-1-gate.md`](../reviews/phase-1-gate.md) evidence submission

## Combined Windows Failures Diagnosed & Resolved (RED -> GREEN)

Running the initial combined candidate (`b162279` + `cc5c723` + `46c0e6d`) on Windows under four workers (`$env:VITEST_MAX_WORKERS='4'; npm test` after `npm run build`) reproduced two failures and exposed tight multi-worker Windows headroom margins:

1. **Emergency root termination missing when reap deadline expires (`tests/helpers/process-lifecycle.ts`, `tests/process-lifecycle.test.ts`):**
   - **Symptom & leak:** In `reapChildProcess()`, when a live captured child (`observedRoot: true`) exhausted `overallDeadline` inside the WMI/MSYS inspection loop before `inspectAndOptionallyReapWinTree()` reached descendant signaling, line `2026` threw `'test_child_reap_unconfirmed'` without invoking non-blocking `signal('SIGKILL')` (unlike lines `1988` and `2014`). Solo reproduction on `SIMULATE_STALL=1` (`1500ms` wait + `1000ms` reap budget) rejected with `test_child_reap_unconfirmed` at `2517ms` and left the `sleep 10` subshell holding stdio until natural `10s` expiry.
   - **RED -> GREEN fix:** Added a deterministic fake-ops regression test in [`tests/process-lifecycle.test.ts`](../../tests/process-lifecycle.test.ts) confirming `child.kill('SIGKILL')` fires before `'test_child_reap_unconfirmed'` rejects (`expected [] to deeply equal ['SIGKILL']` on RED -> passed GREEN), and guarded the loop exit in [`tests/helpers/process-lifecycle.ts`](../../tests/helpers/process-lifecycle.ts) with `if (!closed()) { signal('SIGKILL'); }` while keeping fail-closed `test_child_reap_unconfirmed` semantics and tight `fakeOps` budget assertions untouched.

2. **Starved MSYS2/WMI Windows deadlines in harness suites (`tests/backup-harness-containment.test.ts`, `tests/health-stdio-docker-harness.test.ts`, `tests/operations-promotion-controller.test.ts`, `tests/health-stdio-regression.test.ts`):**
   - **Root causes observed:**
     - `tests/backup-harness-containment.test.ts` (`SIMULATE_STALL=1`) and multi-worker tests ran MSYS2 `bash.exe` + fake `docker` subprocesses in `2.5–4.1s` (exceeding `CHILD_DEADLINE_MS = 3500` in contended runs at `3556–4064ms`) while `CHILD_TERM_GRACE_MS = 500` + `CHILD_KILL_GRACE_MS = 500` (`1000ms` total) starved `cscript.exe` WMI (`~287–535ms+`) + `ps.exe` (`~94ms+`) + `kill.exe` + confirmation under multi-worker load (`2530ms` / `2533ms` `test_child_reap_unconfirmed`).
     - `tests/health-stdio-docker-harness.test.ts` (`cleanup preserves pre-creation resources...`) runs ~25 sequential `bash -> node fake-docker.mjs` invocations in `fullLedgerRes`, timing out `timeoutMs = 3500` at `3749–3926ms`.
     - `tests/operations-promotion-controller.test.ts` (`3171ms` max test vs `3500ms`) and `tests/health-stdio-regression.test.ts` (`4573ms` max vs `4000ms` in `runBoundedBash` / `3500ms` execution cap) shared the same `win32` MSYS2/WMI tight headroom.
   - **Resolution (`win32`-scoped):** Adjusted Windows-only (`process.platform === 'win32'`) deadlines (`CHILD_DEADLINE_MS = 7500`, `1200ms` / `1200ms` reap grace, `2000ms` stall / `< 5000ms` cap vs `sleep 10`, `< 3500ms` barrier reap in `backup-harness-containment.test.ts` and `operations-promotion-controller.test.ts`; `10000ms` harness / `1200ms` reap in `health-stdio-docker-harness.test.ts`; `7000ms` / `8000ms` execution and `1200ms` reap in `health-stdio-regression.test.ts`) while leaving every Linux/POSIX limit untouched.

3. **`npm run check` build-before-test ordering (`package.json`):**
   - [`package.json`](../../package.json) previously executed `npm test && npm run build`, failing 14 compiled-entrypoint tests (`tests/empty-restore-target.test.ts` and `tests/health-stdio-regression.test.ts`) whenever `npm run check` ran on a clean worktree without an existing `dist/`. Reordered `"check"` to execute `npm run build && npm test` (matching CI).

## Verification Scope on Final Combined Tree

- **Linux container with unchanged `16 MiB /tmp` (`bash scripts/test-encrypted-backup.sh unit`):** Exercises all Linux/Unix unit suites (`126 passed | 11 skipped (137)` test files), including native POSIX `phase0-gate-validator.test.ts` (`15 passed (15)`).
- **Windows four-worker full check (`$env:VITEST_MAX_WORKERS='4'; npm run check`):** Executes `validate:phase0`, `format:check`, `lint`, `typecheck`, `build`, and full Vitest suite (`123 passed | 14 skipped (137)` files).
- **Policy, contract, dependency audit, and CI Python suites:** `node scripts/verify-security-policy.ts`, `node scripts/verify-ui-ux-contract.ts`, `node scripts/verify-seo-contract.ts`, `npm audit --omit=dev --audit-level=high`, explicit `npx prettier --ignore-path .gitignore --check` on Track 1 Docs, and all 7 hermetic Python unit suites (`python -B docs/operations/actions/...`).
- **PostgreSQL integration checks (`tests/integration/`):** Verified via CI (`PostgreSQL and native operations` workflow) and/or Docker Compose (`infra/compose.test.yml`).

## Related Unmerged State & Preserved Boundaries

- **Separate unmerged server retirement & private v1 status branch (`origin/codex/retire-tests-private-v1` @ `29cdf51`):** Not merged into this PR so PR #22/#23/#24 + `P1-GATE` remain cleanly reviewable without conflicts on `docs/TODO.md` / `docs/PROJECT_CONTEXT.md`; `docs/testing/2026-11-16-retirement-private-v1-status.md` remains the authoritative server deployment baseline (`P7-003`/`P7-004` returned to `BLOCKED`, `P7-005`/`P7-GATE`/`P8-*` `BLOCKED`).
- **Open Dependabot PRs (`#14`, `#16`, `#17`, `#21`) & advisory Dependabot #44 (moderate dev/default-branch alert):** Tracked separately; `npm audit --omit=dev --audit-level=high` reports `0` high/critical production vulnerabilities.
- **No external or server mutations:** Zero SSH connections, container restarts, Cloudflare tunnel changes, Meta webhook changes, or production WhatsApp number actions occurred.
