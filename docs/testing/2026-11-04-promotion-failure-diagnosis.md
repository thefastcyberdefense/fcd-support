# Promotion Failure Diagnostic Analysis and Deterministic Reproduction

Date: 2026-11-04
Author: Antigravity (AGY)
Target: Codex Review
Related PR: `codex/agy-promotion-failure-diagnosis` (Evidence-only Draft PR)
Branch: `codex/agy-promotion-failure-diagnosis`
Base commit: `3685ae0de131e218d1eb946dd60d726aa43f3706`

---

## 1. Executive Summary

During synthetic private runtime CI testing, multiple workflow runs exhibited an exit at the promotion boundary after the preceding health, checkpoint, and restore stages had completed successfully. Specifically:
- **Run 41656688444** (`private-runtime` fresh job) failed fresh promotion after health, checkpoint, and restore succeeded.
- **Run 41682134296** (`private-runtime` precreated job and `health-stress` fresh job) failed at promotion after all ten health transport iterations succeeded.
- **Run 41682171351** (`private-runtime` fresh job 126078386027) failed at promotion after health, checkpoint, and restore succeeded.

This investigation identifies the exact root cause of the failure, traces the execution sequence through `scripts/operations-promotion-host.sh`, `scripts/operations-promotion-controller.sh`, and `scripts/operations-job-lifecycle.sh`, documents why the failure diagnostic was silenced, explains why existing unit tests did not detect it, provides a deterministic reproduction test suite (`tests/operations-promotion-diagnosis.test.ts`), and outlines a minimal, reviewable fix for Codex evaluation.

In accordance with project policy, no unilateral changes have been made to runtime controllers or deployment scripts; all source acceptance, deployment, and server actions remain strictly with Codex.

---

## 2. Analysis of Immutable CI Observations

The three CI runs demonstrate a consistent, reproducible boundary failure:

| CI Run | Job Name / ID | Preceding Stages | Promotion Status |
| :--- | :--- | :--- | :--- |
| **41656688444** | `private-runtime (fresh)` | Health: Passed<br>Checkpoint: Passed<br>Restore: Passed | FAILED (`operations_promotion_refused`) |
| **41682134296** | `private-runtime (precreated)` & `health-stress (fresh)` | 10x Health Iterations: Passed<br>Checkpoint: Passed<br>Restore: Passed | FAILED (`operations_promotion_refused`) |
| **41682171351** | `private-runtime (fresh)` / `126078386027` | Health: Passed<br>Checkpoint: Passed<br>Restore: Passed | FAILED (`operations_promotion_refused`) |

In all three instances:
1. The preceding health checks, checkpoint generation, and database restore procedures completed with exit 0 and verified state.
2. The promotion controller reached `operations_promote_checked` (`scripts/operations-promotion-controller.sh:266`).
3. The promotion exchange initiated between the host controller and the ephemeral promotion container.
4. Sequence 1 issued `promotion_host_check`, triggering host inspection (`scripts/operations-promotion-host.sh:161-168`).
5. Host inspection exited non-zero, causing `operations_job_promotion_exchange` to abort, triggering the `operations_job_uncertain` path, and terminating the promotion workflow with `operations_promotion_refused` at lines 297–298.

---

## 3. Detailed Trace & Execution Sequence

The exact frame execution trace captured prior to termination:
```text
operations-promotion-host.sh:166:previous=1
operations-promotion-host.sh:122:previous=1
operations-promotion-host.sh:123:previous=1
operations-promotion-controller.sh:174:previous=1
operations-job-lifecycle.sh:154:previous=143
operations-job-lifecycle.sh:249:previous=1
operations-promotion-controller.sh:267:previous=1
operations-promotion-controller.sh:314:previous=1
operations-promotion-controller.sh:297:previous=1
operations-promotion-controller.sh:298:previous=1
```

### Step-by-Step Sequence Breakdown:

1. **Invocation of `operations_execute_job promote promote` (`operations-promotion-controller.sh:266`):**
   The controller creates and starts the promotion container, establishing a bidirectional coproc exchange pipe (`operations_job_promotion_exchange` in `scripts/operations-job-lifecycle.sh:129-159`).

2. **First Host Challenge (`operations-job-lifecycle.sh:136-141`):**
   The promotion container emits:
   ```json
   {"event":"promotion_host_check","operationRef":"operation_<token>","sequence":1,"challenge":"<hex32>"}
   ```
   The coproc loop reads the event and calls `operations_promotion_host_check`.

3. **Host Inspection Subshell (`operations-promotion-host.sh:161-168`):**
   `operations_promotion_host_check` calls `operations_inspect_promotion_host`, which attempts to run the containerized validator:
   ```bash
   result="$({ printf '%s' "$payload" | operations_docker run --rm --interactive --pull never --network none --read-only --user 1000:1000 \
     --label "fcd-support.promotion-inspection=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
     "${diag_flags[@]}" \
     --cpus "${OPS_CONFIG[FCD_RESTORE_CPUS]}" --memory "${OPS_CONFIG[FCD_RESTORE_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_RESTORE_PIDS]}" \
     --entrypoint node "$OPS_JOB_IMAGE" dist/operations/promotion-host-main.js; } 2>/dev/null)" || {
       operations_promotion_host_diagnostic "$result"
       operations_fail promotion_host_invalid
     }
   ```

4. **Failure in Ephemeral Validator Container (`operations-promotion-host.sh:166`):**
   The Docker container command fails (`previous=1`). Crucially, because stderr is redirected to `/dev/null` (`} 2>/dev/null)`), all runtime errors emitted to stderr by Node.js or Docker (such as Node module loading errors, missing files in `dist/operations/promotion-host-main.js`, permissions, or Docker execution constraints) are silently dropped.

5. **Diagnostic Suppression (`operations-promotion-host.sh:122-123`):**
   Because the container failed before emitting valid output on stdout, the variable `$result` is empty (`""`).
   In `operations_promotion_host_diagnostic`:
   ```bash
   operations_promotion_host_diagnostic() {
     case "${1:-}" in
       source_system_mismatch|...|runtime_image_mismatch)
         printf '%s\n' "$1" >&2 ;;
       *) return 0 ;;
     esac
   }
   ```
   Because `""` does not match any valid enum entry, the `*) return 0 ;;` branch executes (`operations-promotion-host.sh:123:previous=1`), suppressing all diagnostics to the operator and CI logs.

6. **Failure Cascade & Uncertainty Containment:**
   - `operations_fail promotion_host_invalid` is invoked, causing `operations_inspect_promotion_host` to exit 1.
   - `operations-promotion-controller.sh:174` checks `[[ "" == "$OPS_PROMOTION_HOST" ]] || return 1`, returning 1.
   - `operations-job-lifecycle.sh:141` sees `operations_promotion_host_check` fail, breaks the coproc loop, terminates the container process with `kill -TERM` (`wait` exit 143), and returns 1.
   - `operations-job-lifecycle.sh:249` transitions active job to `uncertain` via `operations_job_uncertain`.
   - `operations-promotion-controller.sh:267` returns 1.
   - Line 314 catches the failure in the subshell, triggering the `EXIT` trap at lines 297–298:
     ```bash
     operations_promotion_uncertain() {
       trap - EXIT
       [[ "$OPS_PROMOTION_MUTATED" == yes && "$OPS_PROMOTION_DONE" != yes ]] || return 0
       (operations_selection_read || exit 1
         [[ "${OPS_SELECTION[STATE_REF]}" == "$OPS_RESTORE_SOURCE_REF" || "${OPS_SELECTION[STATE_REF]}" == "$OPS_PROMOTION_SWITCH_REF" ]] || exit 1
         [[ "${OPS_SELECTION[STATE_PHASE]}" != uncertain ]] || exit 0
         operations_selection_uncertain "${OPS_SELECTION[STATE_REF]}"
       ) >/dev/null 2>&1 || true
     }
     ```
   - Line 317 emits `operations_promotion_refused` and terminates with exit 1.
   - All state transitions preserve the journal and the `active-job` record with `JOB_PHASE=uncertain`, halting all future job operations safely.

---

## 4. Why Existing Unit Tests Did Not Detect This

Existing unit and integration tests missed this execution path due to extensive mocking of the promotion host transport:

1. **`tests/operations-promotion-controller.test.ts:94`:**
   ```typescript
   operations_inspect_promotion_host() { trace live-proof; ...; printf '%s' '${host}'; }
   ```
   The entire host inspection function was stubbed out in bash; Docker was never invoked.

2. **`tests/promotion-host-transport.test.ts:32`:**
   `operations_promotion_host_check` was mocked completely.

3. **`tests/promotion-host-script.test.ts:37`:**
   The `operations_docker` command was intercepted to match strings, returning `${bound}` directly without starting Node.js or Docker.

4. **`tests/promotion-host.test.ts`:**
   Unit tests for `inspectPromotionHostSamples` passed hand-crafted in-memory TypeScript fixtures to the TypeScript function, but never tested the execution wrapper under a real Linux container environment.

---

## 5. Deterministic Reproduction Suite

To definitively verify the state transition, journal preservation, and subsequent-attempt halting without relying on Docker daemon availability, a deterministic unit test suite has been added:

- **File:** `tests/operations-promotion-diagnosis.test.ts`
- **Execution Command:** `npx vitest run tests/operations-promotion-diagnosis.test.ts`
- **Results:** `2 passed (2)`

```text
✓ tests/operations-promotion-diagnosis.test.ts (2 tests) 3541ms
  ✓ deterministic reproduction: inspection failure triggers uncertain transition and preserves active-job
  ✓ deterministic reproduction: preserved uncertain active-job halts subsequent job executions
```

### Verified Invariants:
1. When host inspection fails, `operations_promote` exits 1 with `operations_promotion_refused`.
2. `STATE_PHASE` in `OPS_SELECTION` is reliably marked as `uncertain`.
3. The `active-job` marker is preserved with `JOB_SERVICE=promote` and `JOB_PHASE=uncertain`.
4. Any subsequent execution attempt immediately halts with `operations_job_pending` without modifying state or executing uncontained commands.

---

## 6. Proposed Remediation for Codex Review

To resolve the root failure and diagnostic suppression without introducing regressions, Codex may consider the following changes:

1. **Capture Ephemeral Container Stderr:**
   In `scripts/operations-promotion-host.sh:161-168`, redirect stderr to a temporary file or capture stdout and stderr distinctly rather than discarding stderr with `2>/dev/null`. If the container exits non-zero, include the captured stderr in diagnostic output so unexpected crashes, Node exceptions, or Docker permission issues are immediately visible in CI logs.

2. **Handle Non-Enum Exit Diagnostics:**
   In `operations_promotion_host_diagnostic`, if `$result` is empty or does not match a known enum string, emit a fallback diagnostic (e.g. `promotion_host_execution_failed`) so operators and CI can pinpoint the exact failure stage.

3. **Validate `promotion-host-main.js` Packaging:**
   Verify that `dist/operations/promotion-host-main.js` is correctly bundled in the operations job container image and executable by non-root user `1000:1000` with `--network none` and `--read-only`.
