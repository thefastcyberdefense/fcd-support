# PR #12 corrected promotion evidence acceptance

Date: 2026-11-04 (Asia/Dhaka).
Status: **ACCEPTED AND MERGED as 81bd77035024916ee3b73076391f7155e3dff528.**
Base: `a14551dca9a0e4da0b7bb033501ecaef1b4855b6`.
Corrected AGY source/test head: `818c4930acfd37c7977bd7ff69e6a13c81ccdf5f`.
Codex documentation correction: `a32ff7b5de973926850ebc26d024dd0754b4af34`.

## Accepted scope

The tests invoke the actual operations_inspect_promotion_host wrapper with
synthetic external transport, retaining argument/configuration checks, payload
assembly and output filtering. They verify raw stderr and unallowlisted stdout
remain suppressed, allowlisted closed-v1 diagnostics reach descriptor 3, and
sensitive sentinels do not leak. The controller case is accurately described
as a simulation. The pending-job case invokes the real operations_execute_job
guard with a temporary state-root adapter; it does not replace the refusal
with a test-written check.

The document distinguishes observed host-command failure, the diagnostic
suppression mechanism and untested internal hypotheses. It does not claim the
historical validator cause is established. Proposed diagnostics remain closed
and allowlisted. Runtime controllers, acknowledgement/recovery rules and
business state are unchanged.

Codex corrected the invented full base SHA and the falsely failed run citation.
Run 41768173765 was green. The later failed observation is run 41778860198,
private-runtime fresh job 126405652145, after one health invocation, checkpoint
and restore passed; its other runtime/stress lanes passed. The command's
nonzero boundary is not proof of a container-internal exit. A remaining portable
test link is corrected in the final main documentation update.

## Independent verification

- `VITEST_MAX_WORKERS=4 npm run check` on the final publication tree: **1,974
  passed / 446 platform skips**, 132 files, 265.92 seconds. Phase 0, formatting,
  lint, strict type checking and build all exited 0.
- `npx vitest run tests/operations-promotion-diagnosis.test.ts tests/operations-promotion-controller.test.ts tests/promotion-host-script.test.ts tests/promotion-host-transport.test.ts`:
  **71 passed**, four files, 80.63 seconds; includes all six new cases.
- Explicit Markdown formatting, Git whitespace, provenance, reference and
  targeted secret-pattern checks are separate from the default formatter.
- Git comparison verifies that a32ff7b changes only the diagnosis document;
  source, scripts, tests, dependencies, workflow and infrastructure trees match
  the submitted source/test head. No fabricated RED claim is made for these
  characterization tests, which verify existing behavior without a runtime fix.

## CI provenance and integration boundary

All four workflows passed at submitted source/test head 818c493:
[CI 41785038664](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038664),
[CodeQL 41785038690](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038690),
[PostgreSQL/native 41785038453](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038453),
[runtime 41785038666](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41785038666).

Final publication-head workflows:
[CI 41791554708](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41791554708),
[CodeQL 41791554902](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41791554902),
[PostgreSQL/native 41791554937](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41791554937),
[runtime 41791554933](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41791554933).
All four final publication-head workflows PASS. The full GitHub rollup was
verified CLEAN with 13 successful checks, zero pending and zero failed, including
both push and pull-request native jobs, before the successful merge. Earlier
merge requests were refused while checks remained pending; no check was
bypassed. The squash merge is 81bd77035024916ee3b73076391f7155e3dff528;
after synchronization, its source/test/configuration trees match the reviewed
publication head. The final main update corrects only a portable document link
and records acceptance/next work.

## Operational outcome and next work

Acceptance is limited to evidence and tests. It does not fix the historical
promotion failure, merge held PR #10, settle the server health job, deploy
dashboard grants or pass Phase 7. No SSH, server/container mutation, model or
provider call, account action or production asset change occurred in this review.

Next bounded AGY task:
`../handoffs/2026-11-04-antigravity-promotion-observability.md`. It adds closed
observations to the existing synthetic CI harness while preserving Codex's
runtime-controller and server authority. A new failure must retain uncertainty;
no inference of SQL completion or blind retry is authorized.
