# Health transport stress results and Codex final correction

Date: 2026-11-04 (Asia/Dhaka).
Branch: `codex/agy-p6-health-transport-stress`.
Base: `3685ae0de131e218d1eb946dd60d726aa43f3706`.
AGY submission: `eaf8312433b73f9af76eece2403acac2532fe9da`.

## Final behavior and meaningful regression coverage

Codex corrected the observer to recognize the actual operations_execute_job
function under the scheduler's command substitution. The previous guard named
a nonexistent function and required subshell depth zero, disconnecting it from
the real path. No lifecycle acceptance, retry or recovery rule changed.

The regression now extracts the actual TRACE block and invokes the actual
source-defined lifecycle under command substitution, retaining the real
acknowledgement validator. Only external process/state ports are synthetic.
Seven diagnostic cases failed before the observer correction; all 17 tests in
the final stress file then passed. Successful reads never emit log_read_failed;
genuine failed reads are distinguished from empty, malformed, multiline,
carriage-return and dependency-unavailable output. Framing uses ten independent
held-open streams; it does not claim multiple frames on one persistent stream.

Actor checks select exact operation parent and health-service labels before
and after every invocation, including the final iteration. Each positive
iteration must increment the PostgreSQL component health-record count by one;
accepted dependency-unavailable outcomes cannot stand in for persistence proof.

The source-extracted orchestration tests in synthetic-recovery.test.ts exercise
the actual stress loop. They prove that an uncertain second invocation retains
its record and prevents all later invocations/checkpoint/recovery, owned actors
before/after a call cause refusal, and absent persistence causes refusal. The
ten-iteration positive control reaches the fixture's intentional checkpoint
refusal; it does not claim a successful full recovery from that test.

Four additional native tests execute the real health lifecycle with empty,
malformed, multiline and unavailable logs. Each retains the real uncertain
journal, and a subsequent attempt changes neither that record nor the Docker
trace. The earlier hand-written lifecycle/filter/pending-guard simulations have
been removed from the stress file.

## Independent checks

- Focused Windows command: `npx vitest run tests/health-transport-stress.test.ts tests/synthetic-recovery.test.ts tests/synthetic-host-evidence.test.ts`:
  **52 passed**, three files, 8.10 seconds.
- Native command: `bash scripts/test-encrypted-backup.sh state tests/operations-job-lifecycle.test.ts`:
  **31 passed**, 25.59 seconds, operations_state_local=true. Owned scratch/resources
  were cleaned by the established harness.
- Two earlier ad hoc native-runner attempts failed before meaningful lifecycle
  execution: the first lacked the scripts mount (31 failures); the second used
  tmpfs, which the persistent-filesystem preflight correctly refused (30 failures,
  1 pass). Neither changed application rules. The established native harness
  supplies the required filesystem and all 31 tests pass there.
- The complete source gate and final correction-head CI are recorded by Codex's
  integration review when complete; they are not claimed from the focused counts.

## Immutable CI and observation boundaries

AGY's submitted eaf8312 has four green workflows:
[CI 41768173885](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41768173885),
[CodeQL 41768173829](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41768173829),
[PostgreSQL/native 41768173755](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41768173755),
[runtime 41768173765](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41768173765).
Both ten-iteration stress lanes and both full runtime lanes pass at that submitted
head. Those runs precede Codex's final observer/test correction and do not replace
its final-source verification.

Retain the earlier promotion failures in runs 41656688444, 41682134296 and
41682171351, including job 126078386027. Some failed only after all ten health
iterations completed. Neither a later green run nor a simulated failure proves
the historical promotion root cause or resolves the current shared-server health
incident. No SSH, shared-server Docker, live provider, account, tunnel, production
or uncertain-record mutation occurred in this source review/correction.
