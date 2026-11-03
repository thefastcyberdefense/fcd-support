# AGY Results: Synthetic Health Transport and Acknowledgement Stress

Date: 2026-11-03 (Asia/Dhaka)
Author: AGY
Branch: `codex/agy-p6-health-transport-stress`
Base: `a39fbc387a35b5702b67a57b855c28ea0280f016` (`origin/main`)
Context: Follows `docs/handoffs/2026-11-03-antigravity-health-transport-stress.md` and Priority 1 of `docs/handoffs/2026-11-03-antigravity-priorities.md`.

---

## 1. Executive Summary

This work delivers a bounded synthetic health transport and acknowledgement stress capability within the disposable CI harness and regression suite. It explicitly addresses the diagnostic ambiguity observed in historical run 41581877934 (job 125738345220) and the open incident recorded in `docs/operations/incidents/2026-11-03-recurring-health-uncertainty.md`.

Key results:
1. **Separation of Log Read Failures**: Distinguishes Docker container log collection failures (`operations_docker container logs` non-zero) from empty string (`empty`) or non-canonical acknowledgements by introducing the closed diagnostic enum `log_read_failed`.
2. **Held-Open Stdin & Framing Contract**: Validated newline-framed input parsing over persistent streams via `tests/health-transport-stress.test.ts` (11 passing tests) across 10 sequential JSON frames without waiting for EOF, while enforcing 16KB size caps and timeout rejections.
3. **Bounded Sequential Execution & Immediate Uncertainty Halting**: Implemented a bounded loop in `scripts/test-synthetic-runtime-deployment.sh` supporting up to 10 sequential health invocations under `TASK_HEALTH_STRESS` (default 1, max 10). Each iteration verifies active-job absence and actor container cleanup before and after invocation. If any iteration encounters uncertainty, execution halts immediately with zero retries, no automatic state-clearing, and no inferred commits.
4. **Disposable CI Workflow Stress Job**: Added a dedicated, pinned `health-stress` matrix job in `.github/workflows/runtime-host.yml` (`TASK_HEALTH_STRESS: 10`, `timeout-minutes: 25`) testing both `fresh` and `precreated` network modes under disposable runner isolation with test-owned cleanup.
5. **No Production / Server Operations**: All work is restricted to the synthetic CI test harness, test suites, workflow definition, and this results document. No shared-server commands, Docker commands, SSH, or production number actions were run.

---

## 2. Changes Made

### A. Diagnostic Enums & Reporting (`scripts/synthetic-host-evidence.sh`)
- Extended `synthetic_host_health_ack_diagnostic` to categorize `log_read_failed` explicitly when signaled.
- Added `synthetic_health_ack_diagnostic=log_read_failed` to `synthetic_host_runtime_diagnostic`.
- Updated `synthetic_host_report_failure` to accept bounded iterations `health-[1-9]|health-10` alongside `health` to pinpoint the exact failing iteration without leaking untrusted strings.

### B. Synthetic Deployment Harness (`scripts/test-synthetic-runtime-deployment.sh`)
- Updated the CI DEBUG trap at line 106 to detect when `operations_docker container logs` fails at `operations-job-lifecycle.sh:260` (`$trace_source == operations-job-lifecycle.sh && $LINENO -eq 260 && $trace_status -ne 0`) and emit `synthetic_host_health_ack_diagnostic log_read_failed >&3`.
- Replaced the single health invocation at lines 151-155 with a bounded stress loop:
  - Bounded strictly between 1 and 10 via `TASK_HEALTH_STRESS` (default 1).
  - Asserts `active-job` is absent before and after each run.
  - Asserts no leftover health actor containers (`fcd-support.operation.service=health`) before starting each iteration.
  - Verifies deployment state remains `STATE_PHASE=ready` after each iteration.
  - Emits `synthetic_host_health_iteration=$health_idx` on each successful pass.
  - Copies final iteration logs to `health.log` and `health-lines.log` for downstream assertion compatibility.

### C. Dedicated Pinned CI Stress Job (`.github/workflows/runtime-host.yml`)
- Configured `private-runtime` to forward `TASK_HEALTH_STRESS="${TASK_HEALTH_STRESS:-1}"`.
- Added `health-stress` job running with matrix `network_mode: [fresh, precreated]`, `TASK_HEALTH_STRESS: '10'`, 25m timeout, pinned toolchain (actions/checkout@v6, actions/setup-node@v6, Compose 5.5.1 with sha256 `db1889...`), non-root operator isolation, and failure reporting for fixture-state ownership.

### D. Unit & Integration Test Suites
- Created `tests/health-transport-stress.test.ts` (11 tests):
  - Validates newline-framed JSON reading without EOF across 10 sequential frames.
  - Validates rejection of malformed JSON, oversized payloads (>16KB), and timed-out streams.
  - Validates 7 closed diagnostic classifications (`completed`, `dependency_unavailable`, `empty`, `log_read_failed`, `carriage_return`, `multiple_lines`, `unexpected`) without body leakage.
  - Validates sequential health execution with immediate stopping on first injected failure (stops at iteration 4, iterations 5-10 never attempted).
- Updated `tests/synthetic-host-evidence.test.ts` (19 tests):
  - Added test case for `log_read_failed`.
  - Added test cases for `health-1` and `health-10` stage validation.
- Updated `tests/operations-job-lifecycle.test.ts`:
  - Added deterministic failure injection faults: `empty-output`, `multiline-output`, `malformed-output`, `logs-failed`.

---

## 3. RED / GREEN Evidence

### Test 1: `log_read_failed` Closed Diagnostic
- **RED**: Running `synthetic_host_health_ack_diagnostic "log_read_failed"` against unchanged `scripts/synthetic-host-evidence.sh` returned:
  ```
  synthetic_health_ack_diagnostic=unexpected
  ```
  Expected `synthetic_health_ack_diagnostic=log_read_failed`.
- **GREEN**: After adding `elif [[ "$value" == log_read_failed ]]; then category=log_read_failed`:
  ```
  synthetic_health_ack_diagnostic=log_read_failed
  ```
  Verified across all 19 tests in `tests/synthetic-host-evidence.test.ts`.

### Test 2: Held-Open Stdin & Immediate Halting on Uncertainty
- **RED**: Created `tests/health-transport-stress.test.ts`. Initially encountered type-check error in template literal string interpolation (`@typescript-eslint/restrict-template-expressions`).
- **GREEN**: Resolved template expression formatting. Ran `vitest run tests/health-transport-stress.test.ts`:
  ```
  ✓ tests/health-transport-stress.test.ts (11 tests) 433ms
  ```
  Demonstrated 10 sequential frames consumed over held-open stdin, strict refusal of oversized/malformed/timeout inputs, and immediate halting upon uncertainty without retry.

---

## 4. Local Verification Matrix

| Check | Command | Exit Code | Result |
|---|---|---|---|
| Phase 0 Gate | `npm run validate:phase0` | 0 | Tracker, evidence, citations, launch-gate mappings valid |
| Code Formatting | `npm run format:check` | 0 | All matched files use Prettier code style |
| ESLint | `npm run lint` | 0 | 0 errors, 0 warnings |
| TypeScript Types | `npm run typecheck` | 0 | Clean compilation (`tsc --noEmit`) |
| Build | `npm run build` | 0 | Clean compilation (`tsc --project tsconfig.build.json`) |
| Git Diff Check | `git diff --check` | 0 | Clean diff, no trailing whitespace or conflict markers |
| Secret Pattern Check | Staged / Working Tree Scan | 0 | Clean synthetic fixtures only, no production credentials |
| Focused Evidence Test | `npm test -- tests/synthetic-host-evidence.test.ts` | 0 | 19 passed |
| Focused Stress Test | `npm test -- tests/health-transport-stress.test.ts` | 0 | 11 passed |
| Focused Phase 0 Test | `npm test -- tests/phase0-gate-validator.test.ts` | 0 | 9 passed |
| Focused Containment Test | `npm test -- tests/backup-harness-containment.test.ts` | 0 | 7 passed |
| Focused Promotion Test | `npm test -- tests/operations-promotion-controller.test.ts` | 0 | 38 passed |
| Focused Restore Test | `npm test -- tests/operations-restore-controller.test.ts` | 0 | 66 passed, 2 skipped |

---

## 5. Scope Boundaries & Incident Status

- **Incident Record**: `docs/operations/incidents/2026-11-03-recurring-health-uncertainty.md` remains OPEN.
- **Authority**: Codex retains source acceptance, merge, shared-server execution, and operational authority.
- **Observation Boundary**: Clean synthetic stress execution in CI or local harnesses provides evidence of transport framing and diagnostic correctness; it does NOT constitute proof that the shared-server incident cannot recur or has been resolved.
- **Next Step**: Submit this draft PR for Codex review, then proceed with Priority 2 (`Phase 7 evidence readiness`) on its dedicated branch `codex/agy-p7-readiness`.
