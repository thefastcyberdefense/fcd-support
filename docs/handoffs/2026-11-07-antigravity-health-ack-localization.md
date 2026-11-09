# AGY: localize disposable-CI health acknowledgement loss

Date: 2026-11-07 (Asia/Dhaka).
Continue the isolated PR #10 branch, `codex/agy-p6-health-transport-stress`.
Fetch and integrate fresh main without dropping existing source or evidence.
Keep PR #10 draft. Do not merge PR #13 into it or change production controllers.

## Problem and evidence

PR #13 documentation head `14f91c4ba2e72c78e68043d1e32cc603bd5bed19`
has a fresh-runtime failure in run 42384678769, job 128439452060. Deployment,
verification, maintenance and backup pass; health refuses with
`operations_schedule_failed` and `synthetic_health_ack_diagnostic=empty`.
The precreated runtime lane passes. Earlier code head 05df7a4 had a green
runtime workflow; do not substitute that earlier result for the final head.

PR #10 head `d5fbb9b10fabb7c834f0328b5d921d3386c55a50`, runtime 42381386563,
has three promotion refusals with `samples.stability`: jobs 128429544768,
128429544783 and 128429544791. Both stress jobs complete ten health iterations;
ordinary fresh job 128429544597 passes. These are separate observations.

The shared server's uncertain health job remains preserved. Disposable CI
does not establish that server job's SQL outcome or failure cause.

## Authorized scope

Only synthetic CI harness observability, its tests and evidence documentation.
Observe the actual sourced `operations_execute_job` boundary with synthetic
external ports in tests. Do not replace the function being observed. Do not
alter acknowledgements, timeouts, retries, job journals, PostgreSQL writes,
cleanup ownership rules or production validators to make a run green.

## Checklist and acceptance criteria

- [ ] Trace the health command, Docker wait/log read, acknowledgement validation
      and actor removal sequence. Cite exact source locations and distinguish
      what is measured from what remains hypothetical.
- [ ] Add RED tests for the missing observations before changing the harness.
      Separate a nonzero log-read invocation, successful empty log read,
      successful nonempty malformed acknowledgement and canonical completed
      acknowledgement. Include synthetic stdout/stderr sentinels and valid controls.
- [ ] Add only necessary closed observations at the actual owning boundary.
      Use fixed enums and bounded 0..255 exit statuses; never publish payloads,
      hashes of payloads, arguments, IDs, paths, environment values or raw logs.
      Any actor/log-driver state probe must be read-only and confined to the
      already verified test-owned actor. Do not infer the cause from exit status.
- [ ] Keep diagnostics opt-in under `closed-v1`, descriptor 3 only. Preserve
      caller exit status and `BASH_REMATCH`; prove the real TRACE remains bound
      to the owning function and correct subshell/command boundary. Test inactive
      diagnostics, malformed inputs and publication filtering without Docker.
- [ ] Preserve immediate halt on uncertainty. Prove zero subsequent operational
      calls after refusal and no replay/clear/settlement of an uncertain scope.
      Extra observations must never become completion or retry authority.
- [ ] Run existing relevant harness, evidence, lifecycle and framing suites.
      Exercise disposable fresh and precreated CI once per new scope with the
      existing bounded ten-invocation stress setting. Do not increase retries,
      weaken validation or repeat a failed scope to seek a passing result.
- [ ] Record exact final source, workflow/job IDs, lane outcomes and closed
      observations. A hypothesis or inability to reproduce is a valid result;
      do not claim the server issue or promotion stability problem is fixed.
      Force-format Markdown, validate Phase 0, static checks and whitespace;
      commit/push draft evidence for Codex review.

Deliver a dated results file and a concise list of the remaining unknowns.
Codex retains the actual production-path fix, promotion stability investigation,
server health disposition, managed dashboard deployment and merge decisions.

No SSH, shared-server Docker/systemd, host/daemon restart, tunnel/DNS, credentials,
Meta, Manifest/model, n8n/provider, ClickUp write/message or production actions.
No removal of retained uncertain scopes or shared resources is authorized.
