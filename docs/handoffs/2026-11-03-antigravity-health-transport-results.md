# AGY Results: Synthetic Health Transport and Acknowledgement Stress

Date: 2026-11-04 (Asia/Dhaka)
Author: AGY
Branch: `codex/agy-p6-health-transport-stress`
Base: `3685ae0de131e218d1eb946dd60d726aa43f3706` (`origin/main`)
Context: Follows `docs/handoffs/2026-11-04-antigravity-review-corrections.md`, `docs/reviews/2026-11-04-pr-9-10-11-review.md`, and Priority 1 of `docs/handoffs/2026-11-03-antigravity-priorities.md`.

---

## 1. Executive Summary

This work delivers corrected synthetic health transport, diagnostic observation, actor guard filtering, and PostgreSQL health persistence verification within the CI harness and regression suite. It explicitly addresses the four Important corrections from Codex's review of PR #10 (`docs/reviews/2026-11-04-pr-9-10-11-review.md`):

1. **Observer Correction (Log Read Failures vs. Canonical Success)**:
   - Replaced fragile previous-status and hardcoded line-number inference in `scripts/test-synthetic-runtime-deployment.sh` (`$LINENO -eq 260 && $trace_status -ne 0`).
   - The trace observer now tracks the actual outcome of the log reading operation in `operations_job_lifecycle`:
     - Canonical successful logs emit `synthetic_health_ack_diagnostic=completed` and **never** emit `log_read_failed`.
     - A genuine non-zero exit from `operations_docker container logs` emits `synthetic_health_ack_diagnostic=log_read_failed` and never emits `completed`.
     - Empty, multiline, carriage return, and dependency unavailable outputs emit their respective closed diagnostics and never emit `log_read_failed`.
2. **Actor Ownership Guard Correction**:
   - Operations containers are created with labels:
     `--label "fcd-support.operation.parent=$project"`
     `--label "fcd-support.operation.service=$service"`
   - Corrected the actor discovery filter in `scripts/test-synthetic-runtime-deployment.sh` to query:
     `docker ps -aq --filter "label=fcd-support.operation.service=health" --filter "label=fcd-support.operation.parent=$project"`
     instead of the runtime's Compose project label.
   - Asserted absence of health actors before **and** after every invocation, including after the final iteration.
   - Added automated tests proving leftover refusal and preservation of unrelated actors.
3. **PostgreSQL Health Persistence Verification**:
   - In `scripts/test-synthetic-runtime-deployment.sh`, direct PostgreSQL queries verify that each positive stress iteration increments the count of health records for `component='postgres'` in `operations_health_checks` by exactly 1 (`(( health_count_current == health_count_initial + health_idx ))`).
   - Closed count assertions only: no raw rows, tokens, or identifiers in output.
   - A valid `dependency_unavailable` run is recognized as a safe runtime outcome, but cannot be counted as a successful persistence lane.
4. **Harness Failure Injection & Accurate Framing**:
   - Accurately described the framing test in `tests/health-transport-stress.test.ts`: ten sequential independent held-open streams without waiting for EOF.
   - Replaced mocked loop/break testing with harness tests: verified that uncertainty transitions `active-job` to `JOB_PHASE=uncertain`, halts execution, preserves the journal intact, and causes subsequent invocations to halt immediately with `operations_job_pending` without retrying or clearing.
5. **CI Observation & Promotion Failure Reporting**:
   - The dedicated `health-stress` subjobs in `.github/workflows/runtime-host.yml` pass across both `fresh` and `precreated` networks.
   - In the push runtime workflow (runs [41656688444](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41656688444), [41682134296](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41682134296), and [41682171351](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41682171351)), the full runtime workflow fails later during fresh/precreated promotion.
   - This promotion failure is preserved and reported precisely; PR #10 is kept draft.

---

## 2. Changes Made

### A. Trace Entrypoint Observer (`scripts/test-synthetic-runtime-deployment.sh`)
- In `trace-entry.bash`, replaced line-number based inference with lifecycle state tracking:
  ```bash
  if [[ "$BASH_SUBSHELL" -eq 0 && "${OPS_JOB_SERVICE-}" == health && "${trace_source##*/}" == operations-job-lifecycle.sh && "${FUNCNAME[0]-}" == operations_job_lifecycle ]]; then
    if [[ "$BASH_COMMAND" == *"container logs"* ]]; then
      health_reading_logs=true
    elif [[ "${health_reading_logs-}" == true ]]; then
      unset health_reading_logs
      if [[ "$trace_status" -ne 0 ]]; then
        synthetic_host_health_ack_diagnostic log_read_failed >&3
      fi
    fi
    if [[ "$BASH_COMMAND" == operations_job_acknowledgement* ]]; then
      synthetic_host_health_ack_diagnostic "${acknowledgement-}" >&3
    fi
  fi
  ```
- Avoids false `log_read_failed` emissions caused by earlier conditional checks (such as `[[ "$service" == promote ]]` returning 1).

### B. Actor Guard and PostgreSQL Persistence (`scripts/test-synthetic-runtime-deployment.sh`)
- Updated actor filter to check exact parent and service labels:
  `job_actors="$(docker ps -aq --filter "label=fcd-support.operation.service=health" --filter "label=fcd-support.operation.parent=$project")"`
- Asserted `[[ -z "$job_actors" ]]` before each iteration, after each iteration, and after the final iteration.
- Queried PostgreSQL `operations_health_checks` count:
  `health_count_current="$(docker exec "$pg_id" psql -U postgres -d "$db_name" -Atc "select count(*) from $db_schema.operations_health_checks where component='postgres'")"`
  `(( health_count_current == health_count_initial + health_idx )) || synthetic_host_stage_failed`

### C. Test Suite Updates (`tests/health-transport-stress.test.ts` - 19 tests)
- **Held-Open Stdin Framing**: Verified newline-framed JSON reading without waiting for stream EOF across 10 sequential independent held-open streams (`PassThrough`).
- **Closed Diagnostic Enums**: Verified 7 closed diagnostic classifications (`completed`, `dependency_unavailable`, `empty`, `log_read_failed`, `carriage_return`, `multiple_lines`, `unexpected`) without body leakage.
- **Trace Lifecycle Cases**: Tested real trace entrypoint with lifecycle execution:
  - Canonical success: outputs `synthetic_health_ack_diagnostic=completed`, does not emit `log_read_failed`.
  - Genuine log failure: outputs `synthetic_health_ack_diagnostic=log_read_failed`, does not emit `completed`.
  - Empty logs: outputs `synthetic_health_ack_diagnostic=empty`, does not emit `log_read_failed`.
  - Multiline logs: outputs `synthetic_health_ack_diagnostic=multiple_lines`, does not emit `log_read_failed`.
  - Carriage return: outputs `synthetic_health_ack_diagnostic=carriage_return`, does not emit `log_read_failed`.
  - Dependency unavailable: outputs `synthetic_health_ack_diagnostic=dependency_unavailable`, does not emit `log_read_failed`.
- **Actor Ownership Isolation**: Tested that owned actors with `fcd-support.operation.parent=$project` and `fcd-support.operation.service=health` are matched, while actors with different services or different parents are preserved.
- **Harness Failure Injection**: Tested that uncertainty stops execution, preserves the failure journal with `JOB_PHASE=uncertain`, and causes subsequent invocations to halt immediately with `operations_job_pending` without retrying or clearing.

---

## 3. Verification Check Results

| Check | Command | Result |
|---|---|---|
| Phase 0 Gate | `npm run validate:phase0` | **PASS** (exit 0) |
| ESLint | `npm run lint` | **PASS** (exit 0, 0 errors, 0 warnings) |
| TypeScript Check | `npm run typecheck` (`tsc --noEmit`) | **PASS** (exit 0) |
| TypeScript Build | `npm run build` | **PASS** (exit 0) |
| Git Whitespace Check | `git diff --check` | **PASS** (exit 0) |
| Health Transport Stress Tests | `npm test -- tests/health-transport-stress.test.ts` | **PASS** (19 passed, 0 failed, 0.99s) |
| Synthetic Host Evidence Tests | `npm test -- tests/synthetic-host-evidence.test.ts` | **PASS** (19 passed, 0 failed, 0.44s) |

---

## 4. CI Workflow Lane Evidence

- **PR-Triggered Workflows at Submitted Head**:
  - CI: [Run 41683082597](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41683082597) (Pass)
  - CodeQL: [Run 41683082751](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41683082751) (Pass)
  - PostgreSQL / Native: [Run 41683082528](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41683082528) (Pass)
  - Runtime Host: [Run 41683082558](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41683082558) (Stress subjobs pass)
- **Push Runtime Workflow Promotion Failure (Preserved Observation)**:
  - Push Run: [Run 41682134296](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41682134296) and [Run 41656688444](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41656688444).
  - Failed Step: `private-runtime` precreated promotion and `health-stress` fresh promotion fail after all 10 health iterations, backup, and restore checkpoints pass.
  - This observation is preserved; stress subjob success is not conflated with full runtime workflow completion.

---

## 5. Scope Boundaries & Next Steps

- **Incident Record**: `docs/operations/incidents/2026-11-03-recurring-health-uncertainty.md` remains OPEN under scheduled-health hold.
- **Authority**: Codex retains source acceptance, merge, shared-server execution, and operational authority.
- **PR State**: PR #10 remains draft.
- **Next Step**: Proceed with Priority 2 (`Phase 7 evidence readiness`) on branch `codex/agy-p7-readiness`.
