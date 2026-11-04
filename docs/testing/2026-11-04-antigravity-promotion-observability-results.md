# Closed CI Promotion Command Boundary Observability Results

Date: 2026-11-04 (Asia/Dhaka)
Author: Antigravity (AGY)
Target: Codex Review
Related PR: Draft PR #10 (`codex/agy-p6-health-transport-stress`)
Branch: `codex/agy-p6-health-transport-stress`
Worktree: Isolated worktree `J:\DevDrive\fcd-support-agy-health-stress`
Preserved Codex Head: `cf9defb7952ef34c9c4ca3ec26c7f8a7ebdf444e`
Merged Main Head: `443d05b8a05c36ad005f77864f77c865768c8582`
Merge Commit: `a3b9b08f43c3f25368a4bbd8e03ef5099307d6ad`

---

## 1. Executive Summary and Authority Boundary

This package introduces closed, opt-in CI harness observability for the host-inspection command boundary under the promotion exchange without changing production runtime controllers, lifecycle containment, or business state.

- **PR #10 Status:** Retained strictly as **DRAFT**. Codex maintains full authority over source acceptance, runtime controllers, acknowledgement rules, merge decisions, and server deployment/disposition.
- **Zero Production Script Modifications:** Zero edits to `scripts/operations-promotion-host.sh`, `scripts/operations-promotion-controller.sh`, `scripts/operations-job-lifecycle.sh`, `src/operations/promotion-host-main.ts`, or runtime state stores.
- **Strict Scope Boundary:** Changes are restricted to:
  1. Synthetic evidence library: [`scripts/synthetic-host-evidence.sh`](../../scripts/synthetic-host-evidence.sh)
  2. Synthetic CI deployment runner: [`scripts/test-synthetic-runtime-deployment.sh`](../../scripts/test-synthetic-runtime-deployment.sh)
  3. Behavioral test suite: [`tests/synthetic-host-evidence.test.ts`](../../tests/synthetic-host-evidence.test.ts)
  4. Observability results documentation: [`docs/testing/2026-11-04-antigravity-promotion-observability-results.md`](2026-11-04-antigravity-promotion-observability-results.md)
- **Preserved Health Lanes:** The existing full recovery suite, native lifecycle checks, and both ten-iteration health transport stress lanes remain intact and functional.

---

## 2. Command Boundary and Observer Implementation

### Owning Source Context

Under the promotion exchange, the host inspection command boundary resides in [`scripts/operations-promotion-host.sh:161-168`](../../scripts/operations-promotion-host.sh#L161-L168) within `operations_inspect_promotion_host`:

```bash
result="$({ printf '%s' "$payload" | operations_docker run --entrypoint node image dist/operations/promotion-host-main.js; } 2>/dev/null)" || {
  operations_promotion_host_diagnostic "$result"
  operations_fail promotion_host_invalid
}
```

In this command substitution, stderr is redirected to `/dev/null`, and the command's exit code is evaluated by the conditional `|| { ... }`.

### Extracted Real Observer Function

In [`scripts/synthetic-host-evidence.sh`](../../scripts/synthetic-host-evidence.sh), the observer logic was extracted into `synthetic_host_promotion_cmd_diagnostic`:

```bash
synthetic_host_promotion_cmd_diagnostic() {
  local caller_status=$?
  local status="${1-}" result="${2-}" category=''
  local -a saved_rematch=()
  if [[ -v BASH_REMATCH ]]; then
    saved_rematch=("${BASH_REMATCH[@]}")
  fi

  if [[ -z "$status" || "$status" == *[!0-9]* || ( "$status" != 0 && "$status" == 0* ) || "$status" -lt 0 || "$status" -gt 255 ]]; then
    category="unobserved"
  elif [[ "$status" -eq 0 ]]; then
    category="canonical_success"
  elif [[ "$status" -eq 125 || "$status" -eq 126 || "$status" -eq 127 ]]; then
    category="unavailable_transport:$status"
  elif [[ "$result" == runtime_host_diagnostic=* ]]; then
    local allowlisted
    allowlisted="$(synthetic_host_runtime_diagnostic "$result")"
    if [[ -n "$allowlisted" ]]; then
      category="allowlisted_diagnostic"
    else
      category="unallowlisted_output:$status"
    fi
  elif [[ -z "$result" ]]; then
    category="empty_output:$status"
  else
    category="unallowlisted_output:$status"
  fi

  printf 'synthetic_promotion_cmd_diagnostic=%s\n' "$category"
  if [[ "$category" == "allowlisted_diagnostic" && -n "${allowlisted-}" ]]; then
    printf '%s\n' "$allowlisted"
  fi

  if [[ ${#saved_rematch[@]} -gt 0 ]]; then
    BASH_REMATCH=("${saved_rematch[@]}")
  else
    unset BASH_REMATCH
  fi
  return "$caller_status"
}
```

### Trace Runner Integration and Subshell Invariance

In [`scripts/test-synthetic-runtime-deployment.sh`](../../scripts/test-synthetic-runtime-deployment.sh), the runner instruments execution via a `DEBUG` trap with `set -o functrace`.

To avoid subshell pollution when observing command substitutions:
1. When entering `operations_inspect_promotion_host`, the subshell depth is recorded: `promotion_inspecting_subshell=$BASH_SUBSHELL`.
2. Inside `$( { ... ; } 2>/dev/null )`, `$BASH_SUBSHELL` increments, preventing premature trap firing on intermediate statements inside the command substitution.
3. Upon return to the parent subshell, `$BASH_SUBSHELL` matches, allowing accurate capture of the actual command substitution status (`$trace_status`) and captured output (`${result-}`).
4. Diagnostics are emitted exclusively to file descriptor 3 (`>&3`), preventing interference with caller stdout assignments.

---

## 3. Closed Diagnostic Taxonomy and Privacy Guarantees

### Allowlist Specification

The observer strictly adheres to fixed-token grammar:

| Category Pattern | Bounded Status | Description |
| :--- | :--- | :--- |
| `synthetic_promotion_cmd_diagnostic=canonical_success` | 0 | Command completed with zero exit status. |
| `synthetic_promotion_cmd_diagnostic=empty_output:<status>` | 1..255 | Command completed nonzero with empty stdout. |
| `synthetic_promotion_cmd_diagnostic=unallowlisted_output:<status>` | 1..255 | Command completed nonzero with unallowlisted stdout bytes. |
| `synthetic_promotion_cmd_diagnostic=unavailable_transport:<status>` | 125, 126, 127 | Command failed at container runtime or shell execution boundary. |
| `synthetic_promotion_cmd_diagnostic=allowlisted_diagnostic` | 1..255 | Followed by exact allowlisted `runtime_host_diagnostic=...` line. |
| `synthetic_promotion_cmd_diagnostic=unobserved` | None | Status was non-numeric, omitted, or outside bounded range `0..255`. |

### Privacy and State Invariants

- **No Sensitive Leaks:** Never emits `BASH_COMMAND`, command arguments, payloads, options, stdout/stderr bodies, environment values, or container identifiers.
- **Sentinel Suppression:** Stderr and unallowlisted stdout bodies containing sensitive sentinels are discarded and never published to descriptor 3, operator logs, or CI outputs.
- **State Preservation:** Restores `$?` (caller exit status) and `BASH_REMATCH` array so subsequent conditional statements or regular expression evaluations in the caller are unaffected.

---

## 4. Behavioral Verification (RED / GREEN Evidence)

### Test Coverage in `tests/synthetic-host-evidence.test.ts`

Three core behavioral test sets were authored:

1. **State Preservation Test:**
   - Pre-conditions: sets `$?` to 42 and populates `BASH_REMATCH`.
   - Action: calls `synthetic_host_promotion_cmd_diagnostic 0 '{"status":"ok"}'`.
   - Assertions: `$caller_status` is preserved as 42; `BASH_REMATCH` captures are preserved intact.

2. **Classification and Redaction Matrix:**
   - Parameterized test across 9 boundary cases:
     - Exit 0 with JSON -> `canonical_success`
     - Exit 1 with empty output -> `empty_output:1`
     - Exit 1 with secret sentinel -> `unallowlisted_output:1` (verifies secret string is omitted from output)
     - Exit 1 with allowlisted token -> `allowlisted_diagnostic` + pass-through
     - Exit 125 -> `unavailable_transport:125`
     - Exit 127 -> `unavailable_transport:127`
     - Empty status -> `unobserved`
     - Status 256 (out of range) -> `unobserved`
     - Non-numeric status (`invalid`) -> `unobserved`

3. **Subshell Context CI Trace Integration Test:**
   - Spawns bash executing the real `operations_inspect_promotion_host` structure with a failing mock `operations_docker` emitting stderr sentinels.
   - Evaluates `synthetic_host_report_failure`.
   - Assertions:
     - `synthetic_host_failed=promote`
     - `operations_promotion_refused`
     - `synthetic_promotion_cmd_diagnostic=empty_output:1`
     - Sensitive error sentinel (`SENSITIVE_SENTINEL_ERR`) absent from all streams.

### RED Phase (Prior to Observer Implementation)

- **Command:** `npx vitest run tests/synthetic-host-evidence.test.ts`
- **Result:** Failed with 11 errors (`synthetic_host_promotion_cmd_diagnostic: command not found`, missing diagnostic lines in trace, exit 127).

### GREEN Phase (Post Implementation)

- **Command:** `npx vitest run tests/synthetic-host-evidence.test.ts`
- **Result:** **30 passed (30)** in 3.36s (0 failures, 0 skips).

### Full Focused Suite Execution

- **Command:**
  ```bash
  npx vitest run tests/synthetic-host-evidence.test.ts tests/health-transport-stress.test.ts tests/synthetic-recovery.test.ts tests/operations-promotion-diagnosis.test.ts
  ```
- **Results:**
  - `tests/synthetic-host-evidence.test.ts`: **30 passed**
  - `tests/health-transport-stress.test.ts`: **17 passed**
  - `tests/synthetic-recovery.test.ts`: **17 passed**
  - `tests/operations-promotion-diagnosis.test.ts`: **6 passed**
  - **Total:** **70 passed (70)** across 4 files in 8.32s.

---

## 5. Preservation of Historical CI Failures and Limits

### Preserved Historical Failures

The following historical CI failures are explicitly preserved and referenced:
- **Run 41656688444:** Fresh promotion failure after health, checkpoint, and restore succeeded.
- **Run 41682134296:** Precreated and fresh health-stress promotion failure after ten health transport iterations succeeded.
- **Run 41682171351:** Fresh job `126078386027` promotion failure after health, checkpoint, and restore succeeded.
- **Run 41778860198:** PR #10 final head `cf9defb`, fresh job `126405652145` promotion failure after one health invocation, checkpoint and restore passed.

### Preserved Green Run

- **Run 41768173765:** Green across all jobs; explicitly not cited as a failure.

### Explicit Limits of Observation

Observing a nonzero exit status (such as `empty_output:1` or `unavailable_transport:127`) from `operations_docker` establishes that the host command invocation returned nonzero. It does **not** prove:
- Whether the Docker container was created or started.
- Whether the container process was terminated by an external signal or OOM killer.
- What specific internal error occurred within `dist/operations/promotion-host-main.js`.

The underlying cause of historical container refusal remains an **explicitly unresolved hypothesis**.

---

## 6. Static Quality and Validation Gates

In the isolated worktree `J:\DevDrive\fcd-support-agy-health-stress`:

1. `npm run validate:phase0`: **PASS** (Phase 0 tracker, evidence, citations, launch-gate mappings, and authority boundary valid).
2. `npm run lint`: **PASS** (ESLint exited 0 with zero warnings).
3. `npm run typecheck`: **PASS** (`tsc --noEmit` exited 0).
4. `npm run build`: **PASS** (`tsc --project tsconfig.build.json` exited 0).
5. `git diff --check`: **PASS** (zero trailing whitespaces, zero indentation errors).

---

## 7. CI Provenance and Observed Diagnostic Execution

At submitted commit `cb6985e78ecae7c0a9696cf93e8787034b7910ff` on branch `codex/agy-p6-health-transport-stress` (PR #10):

### Workflow Runs Summary

- **CI:** [Run 41848310978](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848310978) - **PASS** (lint, types, build, 1,952 passed / 438 platform skips).
- **CodeQL Advanced:** [Run 41848311038](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848311038) - **PASS** (0 alerts).
- **PostgreSQL and native operations:** [Run 41848310888](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848310888) - **PASS**:
  - `postgres` (job 126637544791): PASS (66 passed / 1 platform skip).
  - `native-operations` (job 126637545341): PASS (native permissions, bootstrap, host-operation, encrypted two-cluster restore, and promotion checks all pass).
- **Private runtime controller:** [Run 41848310893](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848310893):
  - `health-stress (fresh)` (job 126637545457): **PASS** (all 10 sequential health iterations completed cleanly).
  - `health-stress (precreated)` (job 126637545521): **PASS** (all 10 sequential health iterations completed cleanly).
  - `private-runtime (fresh)` (job 126637545578): Reproduced historical promotion failure at line 169 (`synthetic_host_failed=promote`). Captured closed diagnostic token:
    `synthetic_promotion_cmd_diagnostic=unallowlisted_output:1`
  - `private-runtime (precreated)` (job 126637545251): Reproduced historical promotion failure at line 169 (`synthetic_host_failed=promote`). Captured closed diagnostic token:
    `synthetic_promotion_cmd_diagnostic=unallowlisted_output:1`

### Analysis of Captured Diagnostic

The newly captured diagnostic token `synthetic_promotion_cmd_diagnostic=unallowlisted_output:1` establishes that:
1. The host command `operations_docker run --entrypoint node image dist/operations/promotion-host-main.js` returned integer exit status 1.
2. The stdout emitted by that invocation was non-empty and did not match the allowlisted `runtime_host_diagnostic=...` syntax.
3. The closed CI harness observer suppressed and discarded the unallowlisted stdout bytes, ensuring zero leakage of command payloads, container IDs, or error bodies.
4. Crucially, a return status of 1 with unallowlisted stdout reflects only what the host container runner observed; it does not demonstrate why the container process failed internally or whether Node.js crashed. As mandated by project governance, this outcome is presented as an observed boundary fact, not an invented root cause.
