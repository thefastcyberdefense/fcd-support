# Closed CI Promotion Command Boundary Observability Results

Date: 2026-11-04 (Asia/Dhaka)
Author: Antigravity (AGY)
Target: Codex Review
Related PR: Draft PR #10 (`codex/agy-p6-health-transport-stress`)
Branch: `codex/agy-p6-health-transport-stress`
Worktree: Isolated worktree `J:\DevDrive\fcd-support-agy-health-stress`
Preserved Codex Head: `cf9defb8f08a3ad6052267f5161eb616d18ab718`
Previous Main Merge Head: `443d05b94dcffcafa17dea98fe6b6443fb5d8006`
Previous Merge Commit: `a3b9b085956b5f287cafecfc4fa3cf18612ec280`
Observer Implementation Head: `cb6985e80a6c1c3cb2bd7bf75caa7cff414586a2`
Submitted Documentation Head: `101f684a46f14fb488a29f77c83051044f4269e0`
Codex Review Head on Main: `ab6036aff5c5b3211df1655c450780957b5e9f83`
Worktree Branch Merge Commit: `d4505e96c4adb6086a2ca36a45d0576bde9e6eaa`

---

## 1. Executive Summary and Authority Boundary

This package implements corrected closed, opt-in CI harness observability for the host-inspection command boundary under the promotion exchange without modifying production runtime controllers, lifecycle containment, or database state.

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
  local status="${1-}" result="${2-}" expected="${3-}" category=''
  local -a saved_rematch=()
  if [[ -v BASH_REMATCH ]]; then
    saved_rematch=("${BASH_REMATCH[@]}")
  fi

  if [[ ! "$status" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
    category="unobserved"
  elif [[ "$status" -eq 0 ]]; then
    if [[ -z "$result" ]]; then
      category="empty_output:0"
    elif [[ -n "$expected" && "$result" == "$expected" ]]; then
      category="canonical_success"
    else
      category="unallowlisted_output:0"
    fi
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

To avoid subshell pollution and misclassification:
1. Gated under `FCD_RUNTIME_HOST_DIAGNOSTICS=closed-v1`: the observer only records when the closed diagnostic gate is active.
2. When entering `operations_inspect_promotion_host`, the subshell depth is recorded: `promotion_inspecting_subshell=$BASH_SUBSHELL`.
3. Inside `$( { ... ; } 2>/dev/null )`, `$BASH_SUBSHELL` increments, preventing premature trap firing on intermediate statements inside the command substitution.
4. Upon return to the parent subshell, `$BASH_SUBSHELL` matches, allowing accurate capture of the actual command substitution status (`$trace_status`), captured output (`${result-}`), and expected bound (`${bound-}`).
5. Diagnostics are emitted exclusively to file descriptor 3 (`>&3`), preventing interference with caller stdout assignments.

---

## 3. Closed Diagnostic Taxonomy and Precision Corrections

### Producer-Consumer Allowlist Parity

Production `operations_promotion_host_diagnostic` in `scripts/operations-promotion-host.sh` accepts 36 fixed fields under `samples.*`:
`capAdd`, `capDrop`, `securityOpt`, `groupAdd`, `volumesFrom`, `extraHosts`, `sysctls`, `nanoCpus`, `memory`, `pidsLimit`, `stopTimeout`, `environmentNames`, `mounts`, `tmpfs`, `service`, `healthy`, `user`, `restartPolicy`, `command`, `entrypoint`, `volume`, `id`, `systemIdentifier`, `project`, `revision`, `imageId`, `reference`, `projectActors`, `users`, `name`, `createdAt`, `logicalName`, `networks`, `hostBinds`, `stability`, `target`.

The generic synthetic publication filter in `scripts/synthetic-host-evidence.sh` previously omitted five accepted fields:
- `samples.systemIdentifier`
- `samples.reference`
- `samples.projectActors`
- `samples.stability`
- `samples.target`

As established in Codex review, this omission caused any valid production diagnostic containing those fields to be misclassified as `unallowlisted_output:1`. The generic consumer allowlist has now been aligned to include all 36 accepted fields.

### Neutral Classification of Observed Facts

- **Zero-Exit Neutrality:** An exit code of 0 is no longer mislabeled as `canonical_success` on empty or arbitrary output. It is strictly compared against `${expected-}` (`canonical_success`), or classified neutrally as `empty_output:0` or `unallowlisted_output:0`.
- **Exit Status Neutrality:** Statuses 125, 126, and 127 are classified neutrally by observed output (`empty_output:<status>` or `unallowlisted_output:<status>`) rather than asserting an unmeasured transport cause (`unavailable_transport:<status>`).
- **Safe Historical Parsing:** `synthetic_host_runtime_diagnostic` retains backwards compatibility for historical `unavailable_transport:*` tokens from earlier test evidence.

### Lexical Integer Bounding

Bash evaluates integers as signed 64-bit values (`int64_t`). Large decimal strings such as `18446744073709551616` ($2^{64}$) wrap to 0 under arithmetic comparison (`(( 18446744073709551616 == 0 ))`).

Both `synthetic_host_promotion_cmd_diagnostic` and `synthetic_host_runtime_diagnostic` now enforce lexical limits before any arithmetic:
```bash
[[ "$status" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]
```
This guarantees:
1. Only canonical decimal strings with no leading zeros (except single `0`) are accepted.
2. Huge decimals, negatives, decimals with periods, spaces, or non-digits are classified as `unobserved` and rejected by the validator.
3. Values above 255 (e.g. 256, 300, 999) are rejected.
4. Exact boundary controls `0` and `255` are verified.

---

## 4. Behavioral Verification (RED / GREEN Evidence)

### Test Coverage in `tests/synthetic-host-evidence.test.ts`

1. **Producer Parity Suite:** Tests all 36 production `samples.*` fields against `synthetic_host_runtime_diagnostic` and `synthetic_host_promotion_cmd_diagnostic`, specifically verifying that `systemIdentifier`, `reference`, `projectActors`, `stability`, and `target` are exposed unchanged.
2. **Lexical Status Bounding Suite:** Tests huge decimals (`18446744073709551616`), leading zeros (`00`, `01`, `007`), negative numbers (`-1`, `-42`), nondecimals (`''`, `'invalid'`, `' 1'`, `'1 '`, `'1.0'`, `'1a'`), and out-of-range values (`256`, `300`, `999`) across both entrypoints. Verifies boundary controls `0`, `1`, `42`, `255`.
3. **Neutral Zero-Exit and Non-Zero Classification Suite:** Verifies `canonical_success` when output matches expected bound, `empty_output:0` and `unallowlisted_output:0` on zero exit, neutral `empty_output:125` / `empty_output:127`, and secret sentinel omission.
4. **Actual Owning Source Fixture Suite:** Sources the real `operations_inspect_promotion_host` from `scripts/operations-promotion-host.sh` with synthetic external ports and the extracted real TRACE runner from `scripts/test-synthetic-runtime-deployment.sh`. Verifies:
   - Success with matching bound -> `canonical_success`
   - Nonzero with allowlisted diagnostic (`samples.reference`) -> `allowlisted_diagnostic` + line
   - Nonzero with empty output -> `empty_output:1`
   - Nonzero with unallowlisted output -> `unallowlisted_output:1` without sentinel leaks
   - Transport failure (exit 127) -> `empty_output:127`
   - Closed diagnostics suppressed when `closed-v1` is inactive.

### RED Phase (Prior to Correction)

- **Command:** `npx vitest run tests/synthetic-host-evidence.test.ts`
- **Result:** **18 failed | 82 passed (100 total)** in 13.17s.
  - Parity failed on the 5 omitted fields (`systemIdentifier`, `reference`, `projectActors`, `stability`, `target`).
  - Huge decimal `18446744073709551616` wrapped to canonical success.
  - Zero-exit empty/unexpected output was mislabeled.
  - Status 125/127 was mislabeled as transport failure.
  - Real fixture tests failed on unaligned expectations.

### GREEN Phase (Post Correction)

- **Command:** `npx vitest run tests/synthetic-host-evidence.test.ts`
- **Result:** **100 passed (100)** in 12.77s (0 failures, 0 skips).

### Full Focused Suite Execution

- **Command:**
  ```bash
  npx vitest run tests/synthetic-host-evidence.test.ts tests/health-transport-stress.test.ts tests/synthetic-recovery.test.ts tests/operations-promotion-diagnosis.test.ts
  ```
- **Results:**
  - `tests/synthetic-host-evidence.test.ts`: **100 passed**
  - `tests/health-transport-stress.test.ts`: **17 passed**
  - `tests/synthetic-recovery.test.ts`: **17 passed**
  - `tests/operations-promotion-diagnosis.test.ts`: **6 passed**
  - **Total:** **140 passed (140)** across 4 files in 13.40s.

---

## 5. CI Provenance and Multi-Run Evidence

### Implementation Head Runs (Commit `cb6985e80a6c1c3cb2bd7bf75caa7cff414586a2`)

- **CI:** [Run 41848310978](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848310978) - **PASS**
- **CodeQL Advanced:** [Run 41848311038](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848311038) - **PASS**
- **PostgreSQL and Native Operations:** [Run 41848310888](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848310888) - **PASS**
- **Private Runtime Controller:** [Run 41848310893](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41848310893):
  - `health-stress (fresh)` (job 126637545457): **PASS** (10 sequential iterations).
  - `health-stress (precreated)` (job 126637545521): **PASS** (10 sequential iterations).
  - `private-runtime (fresh)` (job 126637545578): reproduced promotion refusal (`synthetic_host_failed=promote`), emitted `unallowlisted_output:1`.
  - `private-runtime (precreated)` (job 126637545251): reproduced promotion refusal (`synthetic_host_failed=promote`), emitted `unallowlisted_output:1`.

### Final Publication Head Runs (Commit `101f684a46f14fb488a29f77c83051044f4269e0`)

- **CI:** [Run 41851012880](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012880) - **PASS**
- **CodeQL Advanced:** [Run 41851012231](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012231) - **PASS**
- **PostgreSQL and Native Operations:** [Run 41851012484](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012484) - **PASS**
- **Private Runtime Controller:** [Run 41851012111](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012111) - **FAIL**:
  - `private-runtime (fresh)` (job 126646994126): health, checkpoint, and restore pass; promotion refuses with uncertain job/selection and `unallowlisted_output:1`.
  - `health-stress (fresh)` (job 126646993818): eight health iterations pass; iteration 9 refuses with uncertain health job, ready selection, and empty acknowledgement.
  - `health-stress (precreated)` (job 126646994093): all ten health iterations pass; promotion refuses with uncertain job/selection and `unallowlisted_output:1`.
  - `private-runtime (precreated)`: passed.

### Separation of Observations and Uncertainty Preservation

1. **Health-9 Empty Acknowledgement:** Run 41851012111 job 126646993818 recorded an empty acknowledgement on health iteration 9. This disposable CI failure is preserved as an observed fact distinct from the promotion failures and earlier passing stress runs. It does not prove the cause of the held server health job.
2. **Promotion Unallowlisted Output:** In light of the producer-consumer allowlist correction, earlier `unallowlisted_output:1` observations in runs 41848310893 and 41851012111 may have resulted from the narrower filter rejecting one of the five accepted production fields (`samples.systemIdentifier`, `samples.reference`, `samples.projectActors`, `samples.stability`, `samples.target`).
3. **No Inference or Replay:** No failed CI scope was retried, cleared, or treated as evidence of SQL completion.

---

## 6. Static Quality and Validation Gates

In the isolated worktree `J:\DevDrive\fcd-support-agy-health-stress`:

1. `npm run validate:phase0`: **PASS** (Phase 0 tracker, evidence, citations, launch-gate mappings, and authority boundary valid).
2. `npm run lint`: **PASS** (ESLint exited 0 with zero warnings).
3. `npm run typecheck`: **PASS** (`tsc --noEmit` exited 0).
4. `npm run build`: **PASS** (`tsc --project tsconfig.build.json` exited 0).
5. `git diff --check`: **PASS** (zero trailing whitespaces, zero indentation errors).
