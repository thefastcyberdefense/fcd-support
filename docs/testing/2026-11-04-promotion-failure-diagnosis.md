# Promotion Failure Diagnostic Analysis and Boundary Verification

Date: 2026-11-04 (Asia/Dhaka)
Author: Antigravity (AGY)
Target: Codex Review
Related PR: Draft PR #12 (`codex/agy-promotion-failure-diagnosis`)
Branch: `codex/agy-promotion-failure-diagnosis`
Base commit: `a14551dca9a0e4da0b7bb033501ecaef1b4855b6`

---

## 1. Executive Summary and Scope Boundary

During synthetic private runtime CI testing, multiple workflow runs exhibited an exit at the promotion boundary after the preceding health, checkpoint, and restore stages had completed successfully. Specifically:

- **Run 41656688444** (`private-runtime` fresh job) failed fresh promotion after health, checkpoint, and restore succeeded.
- **Run 41682134296** (`private-runtime` precreated job and `health-stress` fresh job) failed at promotion after all ten health transport iterations succeeded.
- **Run 41682171351** (`private-runtime` fresh job `126078386027`) failed at promotion after health, checkpoint, and restore succeeded.
- **Run 41778860198** (PR #10 final correction head `cf9defb`, `private-runtime (fresh)` job `126405652145`) failed promotion after one health invocation, checkpoint and restore passed. Both ten-iteration stress lanes and private-runtime precreated passed. The earlier run 41768173765 was green and is not a failed observation.

This evidence-only package:

1. Clearly separates **observed failure facts** from **untested hypotheses**.
2. Documents the **diagnostic suppression mechanism** by accurately citing the immutable implementation of `operations_promotion_host_diagnostic` in `scripts/operations-promotion-host.sh` and `src/operations/promotion-host-main.ts`.
3. Explicitly records that the validator's underlying internal refusal reason remains **historically unresolved**.
4. Exercises the actual promotion host wrapper (`operations_inspect_promotion_host`) with a synthetic transport dependency, verifying that raw stderr is suppressed, unallowlisted stdout is dropped, allowlisted closed diagnostics are delivered to descriptor 3 under `closed-v1`, and sensitive sentinels never leak.
5. Accurately labels controller simulation versus real lifecycle containment, proving that an existing `active-job` file refuses subsequent job execution via production code in `scripts/operations-job-lifecycle.sh:211`.
6. Proposes only closed, allowlisted diagnostic categories and counts, adhering strictly to the synthetic fixture and evidence policy.

In accordance with project governance, no changes have been made to runtime controllers, acknowledgement rules, or server states. All source acceptance, merge decisions, and server operations remain with Codex.

---

## 2. Observed Failure Facts vs. Untested Hypotheses

### Observed Failure Facts (Immutable CI Observations)

Across runs 41656688444, 41682134296, 41682171351 (job 126078386027), and 41778860198 (job 126405652145):

1. **Preceding Stages Succeeded:** Preceding health checks, checkpoint generation, and database restore procedures completed with exit code 0 and verified state.
2. **Failure Point:** In `scripts/operations-promotion-controller.sh:266`, `operations_promote_checked` invoked `operations_execute_job promote`.
3. **Execution Frame Trace:**
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
4. **Non-Zero Host Inspection Command:** In `scripts/operations-promotion-host.sh:161-168`, the host inspection command/subshell returned nonzero. That boundary does not distinguish Docker client failure, container startup failure or an internal validator refusal; the previous-status frame alone cannot prove a container-internal exit.
5. **Discarded Stderr:** Stderr from the container execution was redirected to `/dev/null` (`} 2>/dev/null)` at line 165.
6. **No Diagnostic Emitted:** No diagnostic line was output to CI or operator logs.
7. **Fail-Closed Containment:** `operations_job_lifecycle.sh:141` terminated the promotion container with `kill -TERM` (`wait` exit 143). `operations_execute_job` transitioned the active job to `uncertain` (`scripts/operations-job-lifecycle.sh:249`). Subshell exit 1 at line 314 triggered the `EXIT` trap `operations_promotion_uncertain` (`scripts/operations-promotion-controller.sh:297-298`), marking `STATE_PHASE=uncertain`, preserving the durable journal and `active-job` file, and emitting `operations_promotion_refused` (exit 1).

### Untested Hypotheses (Historically Unresolved)

Previous-status lines and shell exit codes cannot prove what occurred inside the container before exit. Specifically:

- Whether Node.js failed to load `dist/operations/promotion-host-main.js` due to image packaging, entrypoint path, or module resolution is an **untested hypothesis**.
- Whether file permissions, non-root user `1000:1000` constraints, or missing Linux capabilities caused the failure is an **untested hypothesis**.
- Whether Docker daemon constraints (e.g. CPU/memory/pids limits) triggered container termination is an **untested hypothesis**.
- Whether the input JSON payload exceeded buffer limits or failed JSON parsing is an **untested hypothesis**.

**Conclusion:** The exact internal failure cause of the historical validator remains an explicitly unresolved result.

---

## 3. Diagnostic Suppression Mechanism

Analysis of the immutable source code demonstrates why no diagnostic was visible in CI:

### Implementation in `scripts/operations-promotion-host.sh`

```bash
# Optional diagnostics are one exact closed line, never validator payloads or logs.
operations_promotion_host_diagnostic() {
  [[ "${FCD_RUNTIME_HOST_DIAGNOSTICS:-}" == closed-v1 && "$#" == 1 && ${#1} -le 128 ]] || return 0
  case "$1" in
    runtime_host_diagnostic=arguments|runtime_host_diagnostic=input|runtime_host_diagnostic=validation|runtime_host_diagnostic=samples) ;;
    runtime_host_diagnostic=samples.*)
      case "${1#runtime_host_diagnostic=samples.}" in
        capAdd|capDrop|securityOpt|groupAdd|volumesFrom|extraHosts|sysctls|nanoCpus|memory|pidsLimit|stopTimeout|environmentNames|mounts|tmpfs|service|healthy|user|restartPolicy|command|entrypoint|volume|id|systemIdentifier|project|revision|imageId|reference|projectActors|users|name|createdAt|logicalName|networks|hostBinds|stability|target) ;;
        *) return 0 ;;
      esac ;;
    *) return 0 ;;
  esac
  { printf '%s\n' "$1" >&3; } 2>/dev/null || true
}
```

### Suppression Factors:

1. **Opt-in Gate:** If `FCD_RUNTIME_HOST_DIAGNOSTICS` is not set to `closed-v1` in the runner environment, line 123 returns 0 immediately without taking action.
2. **Dedicated Descriptor (FD 3):** Line 133 directs output to file descriptor 3 (`>&3`), not stderr (`>&2`). If the calling context has not opened descriptor 3, `{ printf ... >&3; } 2>/dev/null || true` silently swallows the output.
3. **Strict Allowlist:** If `$result` contains arbitrary error text, an unallowlisted token, or is empty (`""`), it falls through to line 131 (`*) return 0 ;;`), emitting nothing.
4. **Container Stderr Discard:** In line 165:
   ```bash
   result="$({ printf '%s' "$payload" | operations_docker run ... ; } 2>/dev/null)" || {
     operations_promotion_host_diagnostic "$result"
     operations_fail promotion_host_invalid
   }
   ```
   Stderr is explicitly discarded by `2>/dev/null`. If the container process writes error details to stderr, those bytes never reach `$result` and never reach operator or CI logs.

---

## 4. Boundary Verification Suite

A comprehensive unit test suite has been added to [`tests/operations-promotion-diagnosis.test.ts`](../../tests/operations-promotion-diagnosis.test.ts).

### Test Coverage Breakdown:

| Test Name                                                                                                                              | Boundary Exercised                                                                  | Owning Source                                        | Behavioral Verification                                                                                                                                        |
| :------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- | :--------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host inspection wrapper: unhandled validator exit discards raw stderr and unallowlisted stdout without leaking sentinels`             | Real `operations_inspect_promotion_host` wrapper with synthetic `operations_docker` | `scripts/operations-promotion-host.sh:136-175`       | Proves raw stderr discarded (`2>/dev/null`); unallowlisted stdout dropped; sensitive sentinels never leak; command fails closed with `promotion_host_invalid`. |
| `host inspection wrapper: allowlisted closed diagnostic is delivered to descriptor 3 under closed-v1 without leaking stderr sentinels` | Real `operations_inspect_promotion_host` wrapper with synthetic `operations_docker` | `scripts/operations-promotion-host.sh:122-134`       | Proves allowlisted token (`runtime_host_diagnostic=samples.memory`) reaches descriptor 3; zero stderr sentinels leak.                                          |
| `host inspection wrapper: closed diagnostics are suppressed when closed-v1 is inactive`                                                | Real `operations_inspect_promotion_host` wrapper with synthetic `operations_docker` | `scripts/operations-promotion-host.sh:123`           | Proves descriptor 3 remains empty when `FCD_RUNTIME_HOST_DIAGNOSTICS` is unset.                                                                                |
| `host inspection wrapper: unallowlisted diagnostic string on stdout is dropped by closed filter`                                       | Real `operations_inspect_promotion_host` wrapper with synthetic `operations_docker` | `scripts/operations-promotion-host.sh:128-131`       | Proves unallowlisted tokens are rejected by the case statement and descriptor 3 remains empty.                                                                 |
| `controller simulation: unhandled job execution failure triggers EXIT trap operations_promotion_uncertain and updates selection state` | Controller failure cascade simulation                                               | `scripts/operations-promotion-controller.sh:297-318` | Proves controller EXIT trap triggers `operations_promotion_uncertain`, updates `OPS_SELECTION` to `uncertain`, and exits with `operations_promotion_refused`.  |
| `lifecycle containment: real operations_execute_job refuses execution when active-job is preserved`                                    | Production lifecycle check                                                          | `scripts/operations-job-lifecycle.sh:210-212`        | Proves production code line 211 detects existing `active-job` and immediately halts with `operations_job_pending` without starting any container.              |

### Execution Command and Results:

- **Command:** `npx vitest run tests/operations-promotion-diagnosis.test.ts`
- **Results:** **6 passed (6)** in 3.90s.
- **Skips:** 0.

---

## 5. Proposed Closed Allowlisted Diagnostics for Codex Evaluation

In strict adherence to `docs/SYNTHETIC_FIXTURE_POLICY.md` and repository security rules:

- **Never publish unrestricted raw stderr:** Raw stderr must not be forwarded to operator outputs or CI logs, as unvetted processes could emit sensitive environment data, stack traces, or customer payloads.
- **Proposed Closed Observability Enhancements (Descriptor 3 only):**
  If Codex determines that container exit visibility should be expanded under `FCD_RUNTIME_HOST_DIAGNOSTICS=closed-v1`, only closed, fixed-enum tokens should be considered:
  - `runtime_host_diagnostic=container_exit_nonzero` (with bounded integer exit code in 1..255)
  - `runtime_host_diagnostic=container_spawn_failed`
  - `runtime_host_diagnostic=container_timeout`
  - `runtime_host_diagnostic=container_output_empty`
  - `runtime_host_diagnostic=container_output_unallowlisted`

No runtime controllers or production acknowledgement rules have been modified in this branch.

## Codex acceptance provenance

Submitted source/test head: `818c4930acfd37c7977bd7ff69e6a13c81ccdf5f`.
This final correction changes documentation metadata and evidence wording only;
it changes no runtime controller or test behavior. New tests characterize
existing behavior rather than implement a runtime fix, so no fabricated RED
claim is made for them. The historical validator cause remains unresolved.

All four submitted-head workflows passed:
[CI 41785038664](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038664),
[CodeQL 41785038690](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038690),
[PostgreSQL/native 41785038453](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038453),
[runtime 41785038666](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038666).
The final publication head, local checks and any new CI outcomes are recorded
in Codex's acceptance review; these links are not relabeled as another source.
