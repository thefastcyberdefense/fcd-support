# Closed CI Health Acknowledgement Localization and Observer Results

- Date: 2026-11-09 (Asia/Dhaka)
- Author: Antigravity (AGY)
- Target: Codex Review
- Related PR: Draft PR #10 (`codex/agy-p6-health-transport-stress`)
- Branch: `codex/agy-p6-health-transport-stress`
- Worktree: Isolated worktree `J:\DevDrive\fcd-support-agy-health-stress`
- Main Baseline Commit: `0539a036d7174084f2190ee0954f6adf18c6204b`
- Worktree Integration Commit: `b9d45ecf0d1ff6796ac82e2a7ad3581351ea8ce9`
- Handoff Reference: [`docs/handoffs/2026-11-07-antigravity-health-ack-localization.md`](../handoffs/2026-11-07-antigravity-health-ack-localization.md)
- Disposition Reference: [`docs/reviews/2026-11-07-pr-13-direct-corrections.md`](../reviews/2026-11-07-pr-13-direct-corrections.md)

---

## 1. Executive Summary and Authority Boundary

This package completes the closed, opt-in CI harness localization for the disposable-CI health acknowledgement loss seen in PR #13 run `42384678769`, job `128439452060` (`operations_schedule_failed` with `synthetic_health_ack_diagnostic=empty`) and PR #10 run `41851012111`, job `126646993818` (iteration 9).

- **Draft PR #10 Retained:** PR #10 remains strictly in **DRAFT** state. No merge into `main` or merge of PR #13 into PR #10 is performed.
- **Zero Production Script Modifications:** Zero edits were made to production controllers, runtime logic, lifecycle containment, or database state (`src/`, `scripts/operations-job-lifecycle.sh`, `scripts/run-operation.sh`, `scripts/deploy-runtime.sh`, etc.).
- **Strict Scope Boundary:** All changes are strictly confined to the synthetic CI harness observability and test infrastructure:
  1. [`scripts/synthetic-host-evidence.sh`](../../scripts/synthetic-host-evidence.sh): enhanced `synthetic_host_health_ack_diagnostic` to preserve caller `$?` and `BASH_REMATCH`, bound exit statuses strictly to `0..255`, separate nonzero log-read failures from empty or malformed payloads, and filter published tokens in `synthetic_host_runtime_diagnostic`.
  2. [`scripts/test-synthetic-runtime-deployment.sh`](../../scripts/test-synthetic-runtime-deployment.sh): gated health TRACE diagnostics under `FCD_RUNTIME_HOST_DIAGNOSTICS=closed-v1`, tracked subshell boundaries via `$BASH_SUBSHELL`, captured bounded exit statuses on log reads, and suppressed raw output.
  3. [`tests/synthetic-host-evidence.test.ts`](../../tests/synthetic-host-evidence.test.ts): added comprehensive tests for caller status/captures preservation, status bounds `0..255`, invalid status rejection as `unobserved`, sentinel suppression, and lexical bounds validation (127 passed).
  4. [`tests/health-transport-stress.test.ts`](../../tests/health-transport-stress.test.ts): verified actual lifecycle log extraction across nonzero exit, empty output, valid completion, malformed frames, and inactive suppression (18 passed).
- **Preserved Server Hold:** The shared server's uncertain health job remains preserved. Disposable CI does not settle or establish that server job's SQL outcome or failure cause.
- **No Authority Extension:** Extra observations never serve as completion or retry authority.

---

## 2. Command Sequence and Trace Analysis (Item 1)

### Owning Source Sequence

Under scheduled execution, the health lifecycle sequence proceeds through the following verified source boundaries:

1. **Scheduler Entrypoint** ([`scripts/run-operation.sh:83-110`](../../scripts/run-operation.sh#L83-L110)):
   - `operations_scheduled_health` initializes `OPS_HEALTH_INPUT_JSON='{}'`.
   - Reads existing outage gap via `operations_health_gap_read`.
   - Appends optional host snapshot via `operations_collect_health_host`.
   - On line 97, executes the health job in a command substitution:
     ```bash
     acknowledgement="$(operations_execute_job health health)" || operations_fail operations_schedule_failed
     ```
2. **Actor Lifecycle & Verification** ([`scripts/operations-job-lifecycle.sh:229-246`](../../scripts/operations-job-lifecycle.sh#L229-L246)):
   - Verifies operations image metadata, revision label, OS (`linux`), and architecture (`amd64`).
   - Generates random 16-byte hex token, setting `OPS_JOB_REFERENCE="operation_$token"`, `OPS_JOB_PROJECT="fcd-support-operation-$token"`, and `OPS_JOB_SERVICE="health"`.
   - Creates override file `job-$token.json` and syncs job state to `active-job` with `JOB_PHASE=intent`.
   - Discovers container ID, asserts container status `created`, sets `OPS_JOB_VERIFIED=true`, and transitions state to `created`.
3. **Execution & Wait** ([`scripts/operations-job-lifecycle.sh:248-254`](../../scripts/operations-job-lifecycle.sh#L248-L254)):
   - Transitions state to `started`.
   - Starts container via `operations_job_start`.
   - Waits for container exit:
     ```bash
     wait_result="$(operations_docker container wait "$OPS_JOB_CONTAINER")" || operations_job_uncertain
     [[ "$wait_result" == 0 ]] || operations_job_uncertain
     ```
   - Asserts container status `exited`.
   - Inspects container exit state:
     ```bash
     actual_exit="$(operations_docker container inspect --format '{{.State.Status}}/{{.State.ExitCode}}' "$OPS_JOB_CONTAINER")" || operations_job_uncertain
     [[ "$actual_exit" == exited/0 ]] || operations_job_uncertain
     ```
4. **Log Read Boundary** ([`scripts/operations-job-lifecycle.sh:260`](../../scripts/operations-job-lifecycle.sh#L260)):
   - Reads container logs:
     ```bash
     acknowledgement="$(operations_docker container logs --tail 2 "$OPS_JOB_CONTAINER")" || operations_job_uncertain
     ```
5. **Acknowledgement Validation** ([`scripts/operations-job-lifecycle.sh:161-176, 262`](../../scripts/operations-job-lifecycle.sh#L161-L176)):
   - Validates acknowledgement format:
     ```bash
     operations_job_acknowledgement "$acknowledgement" || operations_job_uncertain
     ```
   - For `health/health`, requires either `{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}` or `^{"status":"completed","processed":(0|[1-9][0-9]{0,8}),"reasonCode":"ok"}$`.
   - If invalid or empty, triggers `operations_job_uncertain`.
6. **Actor Removal & Return** ([`scripts/operations-job-lifecycle.sh:263-269`](../../scripts/operations-job-lifecycle.sh#L263-L269)):
   - If valid, removes container via `operations_job_remove_exited`, removes job override file, transitions state to `completed`, clears active job, and prints `$acknowledgement`.
   - If `operations_job_uncertain` is triggered at any point, active job is marked `JOB_PHASE=uncertain`, cancellation is attempted if verified, and `operations_fail operations_job_uncertain` terminates the subshell.
   - On subshell exit, `run-operation.sh:97` catches the failure and calls `operations_fail operations_schedule_failed`.

### Measured Facts vs. Hypothetical Possibilities

| Item | Status | Source & Evidence |
| :--- | :--- | :--- |
| Container process wait & exit | **Measured** | `operations_docker container wait` returned `0`; container inspect confirmed `exited/0` on line 254. |
| Nonzero log-read command failure | **Measured (Absence)** | In run `42384678769` and run `41851012111` (health-9), `operations_docker container logs` exited `0`, not `1..255`. If it had exited nonzero, line 260 would have triggered `|| operations_job_uncertain` directly without line 262 executing, and `log_read_failed` would have been emitted. |
| Empty string capture | **Measured** | Command substitution assigned `acknowledgement=""`. Line 262 called `operations_job_acknowledgement ""` which returned `1`. TRACE trap on line 128 observed `synthetic_health_ack_diagnostic=empty`. |
| Immediate halt on refusal | **Measured** | `operations_job_uncertain` transitioned active job to `uncertain`. `run-operation.sh:97` failed with `operations_schedule_failed`. Zero subsequent commands executed. |
| Root cause of empty log output | **Hypothetical** | Whether Node.js process exited `0` before stdio buffer flushed, or dockerd/containerd log driver buffer had not flushed to disk prior to `docker logs` read in disposable GitHub runner environment. |

---

## 3. Implementation of Closed Observations (Items 2, 3, 4)

### 1. `synthetic_host_health_ack_diagnostic` ([`scripts/synthetic-host-evidence.sh:3-74`](../../scripts/synthetic-host-evidence.sh#L3-L74))

- **Caller Status & Captures Preservation:**
  ```bash
  local caller_status=$?
  local -a saved_rematch=()
  if [[ -v BASH_REMATCH ]]; then
    saved_rematch=("${BASH_REMATCH[@]}")
  fi
  # ...
  if [[ ${#saved_rematch[@]} -gt 0 ]]; then
    BASH_REMATCH=("${saved_rematch[@]}")
  else
    unset BASH_REMATCH
  fi
  return "$caller_status"
  ```
- **Strict Bounded Status Evaluation:**
  - Status must match `^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$`.
  - Non-matching status emits `synthetic_health_ack_diagnostic=unobserved`.
  - Status `1..255` emits `synthetic_health_ack_diagnostic=log_read_failed:<status>`.
  - Status `0` evaluates payload:
    - Empty (`""`): `empty`
    - Carriage return: `carriage_return`
    - Multiple lines: `multiple_lines`
    - Dependency unavailable payload: `dependency_unavailable`
    - Valid completed JSON with 0..9 digit processed count: `completed`
    - Any other payload: `unexpected`
- **Zero Leakage:** Sentinels, stderr output, tokens, and payloads are never printed.

### 2. Publication Filter Parity ([`scripts/synthetic-host-evidence.sh:116-125`](../../scripts/synthetic-host-evidence.sh#L116-L125))

`synthetic_host_runtime_diagnostic` allows:
- Fixed tokens: `empty`, `log_read_failed`, `carriage_return`, `multiple_lines`, `dependency_unavailable`, `completed`, `unexpected`, `unobserved`.
- Bounded status tokens: `log_read_failed:*` where the suffix strictly matches `^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$`.
- Any out-of-range or malformed token is rejected and dropped.

### 3. CI Harness TRACE Trap ([`scripts/test-synthetic-runtime-deployment.sh:119-131`](../../scripts/test-synthetic-runtime-deployment.sh#L119-L131))

- **Opt-In Gate:** Strictly gated under `[[ "${FCD_RUNTIME_HOST_DIAGNOSTICS:-}" == closed-v1 ]]`.
- **Function & Service Bound:** Strictly checked against `"${OPS_JOB_SERVICE-}" == health`, `"${trace_source##*/}" == operations-job-lifecycle.sh`, and `"${FUNCNAME[0]-}" == operations_execute_job`.
- **Subshell Depth Latch:** Tracks `$BASH_SUBSHELL` when entering `*"container logs"*` (`health_reading_logs_subshell=$BASH_SUBSHELL`). When returning to the parent subshell depth, captures `$trace_status` and emits `synthetic_host_health_ack_diagnostic "$trace_status" "" >&3` if nonzero.
- **Acknowledgement Observer:** Fires on `operations_job_acknowledgement*`, passing status `0` and `${acknowledgement-}` to `synthetic_host_health_ack_diagnostic 0 "${acknowledgement-}" >&3`.

---

## 4. Preservation of Uncertainty and Containment (Item 5)

- **Immediate Halt:** On acknowledgement rejection, `operations_job_uncertain` writes `JOB_PHASE=uncertain` to the active job journal and terminates immediately.
- **Zero Subsequent Calls:** Tests verify that no subsequent operational calls, database queries, or lifecycle actions occur after refusal.
- **No Replay or Settlement:** Extra observations deliver diagnostic visibility only; they carry zero completion or retry authority.

---

## 5. Local Verification Matrix (Item 6)

Execution performed in the isolated worktree `J:\DevDrive\fcd-support-agy-health-stress`:

| Check | Command | Result |
| :--- | :--- | :--- |
| Phase 0 Gate | `npm run validate:phase0` | Exit 0: tracker, evidence, citations, launch-gate mappings valid |
| Code Formatting | `npm run format:check` | Exit 0: all matched files use Prettier code style |
| Static Lint | `npm run lint` | Exit 0: clean across all project files |
| TypeScript Types | `npm run typecheck` | Exit 0: `tsc --noEmit` clean |
| TypeScript Build | `npm run build` | Exit 0: `tsc --project tsconfig.build.json` clean |
| Whitespace & Diffs | `git diff --check origin/main...HEAD` | Exit 0: zero whitespace errors, clean patch |
| Lifecycle Suite | `tests/operations-job-lifecycle.test.ts` | 31 skipped (retained Docker-isolated tests) |
| Focused Suite 1 | `tests/health-transport-stress.test.ts` | **18 passed** / 0 skipped (including nonzero status and inactive suppression) |
| Focused Suite 2 | `tests/operations-promotion-diagnosis.test.ts` | **6 passed** / 0 skipped |
| Focused Suite 3 | `tests/synthetic-recovery.test.ts` | **17 passed** / 0 skipped |
| Focused Suite 4 | `tests/synthetic-host-evidence.test.ts` | **127 passed** / 0 skipped (including status bounds, captures, sentinels) |
| **Combined Focused** | `npx vitest run ...` (4 suites) | **168 passed / 0 skipped / 0 failed**, exit 0, 16.69s |

---

## 6. Final-Head GitHub Actions Validation

Final implementation head commit: `a3c4d0a9d7409c9f0c9aa6b4b6ace1f34de44fdc`

GitHub Actions runs triggered by push to `codex/agy-p6-health-transport-stress`:

- **CI** ([Run `42554661897`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42554661897)): **PASS** (job `128957579951` `validate` passed in 4m44s).
- **CodeQL Advanced** ([Run `42554661907`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42554661907)): **PASS** (passed in 55s).
- **PostgreSQL and Native Operations** ([Run `42554661921`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42554661921)): **PASS** (job `128957580153` `postgres` passed in 3m35s; job `128957580381` `native-operations` passed in 11m29s).
- **Private Runtime Controller** ([Run `42554661939`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42554661939)):
  - `health-stress (precreated)` (ID `128957580631`): **PASS** in 10m26s (deploy, verify, maintenance, backup, all 10 health iterations, checkpoint, restore, promote, rollback, and cleanup passed).
  - `health-stress (fresh)` (ID `128957580605`): all 10 health iterations passed (`synthetic_host_health_passed=true`), checkpoint and restore passed, refused at promote with `runtime_host_diagnostic=samples.stability` (`synthetic_promotion_cmd_diagnostic=allowlisted_diagnostic`).
  - `private-runtime (fresh)` (ID `128957580563`): deploy, verify, maintenance, backup, health, checkpoint, and restore passed, refused at promote with `runtime_host_diagnostic=samples.stability`.
  - `private-runtime (precreated)` (ID `128957580286`): deploy, verify, maintenance, backup, health, checkpoint, and restore passed, refused at promote with `runtime_host_diagnostic=samples.stability`.

No occurrences of `synthetic_health_ack_diagnostic=empty` or `operations_schedule_failed` were observed across any of the four runtime lanes. The health acknowledgement loss was successfully isolated, observer status bounds were verified, and the separate promotion stability investigation remains cleanly distinguished.

---

## 7. Concise List of Remaining Unknowns (Item 7)

1. **Docker Logs Buffer Empty Output in Disposable CI:**
   - In disposable CI runners, whether container logs can be momentarily empty immediately after `docker wait` exits `0` due to asynchronous logging driver flush latency or stdio buffering.
2. **Promotion Stability Refusal (`samples.stability`):**
   - The root cause of the promotion comparison differences observed in CI run `41860854083` (jobs `126681906053`, `126681906432`) remains under Codex's runtime investigation.
3. **Shared Server Uncertain Health Job Hold:**
   - The shared server's uncertain health job remains preserved and un-cleared. Disposition authority is retained exclusively by Codex.
4. **Managed Dashboard Rollout & Merge Authority:**
   - Managed dashboard deployment and PR merge authority remain reserved to Codex.
