# Phase 4 Manifest HTTP Client Evidence

Date: 2026-09-13 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 14 and locally completes
P4-004. It exercises an in-process loopback fake only. It does not read a real
key, connect to Manifest, call a model/provider, change infrastructure, or touch
Meta or production assets.

## Implemented controls

- Client construction requires a validated private `/v1` base URL, a nonblank
  bounded key, and configurable total-timeout and response-byte ceilings. The
  validated endpoint, credential, and ceilings are snapshotted against later
  caller mutation.
- `complete` accepts only process-issued requests from the sanitized request
  builder. The builder privately binds the request to the exact language and
  published facts later used for output validation, preventing a caller from
  widening the grounding context.
- Each call makes exactly one non-streaming `POST` to
  `/v1/chat/completions`, requests `model: "auto"`, includes no tool, provider,
  fallback, routing, plugin, or function field, sets redirect mode to `error`,
  and has no retry or second-host path.
- Caller abort and a configurable hard total timeout race both transport and
  response-body reads. Timeout settles even if an injected transport ignores
  its abort signal; a late result cannot become an accepted answer.
- Response bytes are bounded before JSON parsing, including declared and
  streamed length. UTF-8 and the outer completion envelope fail closed. Tool or
  function calls in the response are rejected before strict grounded-output
  validation.
- HTTP error bodies and exception details are discarded. Results and logs use
  only closed reasons: invalid request, abort, timeout, network failure,
  non-2xx, provider exhaustion, oversized body, malformed body, or invalid
  envelope. Logs never include request/response bodies, credential values, or
  provider names.
- The loopback fake rejects non-synthetic authorization values and retains only
  request structure, counts, paths, and safety booleans. It never retains an
  authorization value or request body.

## Test-first and validation evidence

- Initial focused execution failed because the client module and Manifest log
  allowlists did not exist.
- The first implementation exposed a synthetic timeout-listener race, corrected
  in the harness. Self-review then added failing-first regressions for late
  timeout, caller cancellation, tool-call responses, abort-ignoring transports,
  and caller mutation of validated options. Each failed before its control was
  implemented.
- Final focused validation: 43 tests across 4 files passed, covering the client,
  request builder, output parser, and safe logger.
- `npm run check`: Phase 0 validator, formatting, lint, strict type checking,
  build, and 450 unit tests across 36 files passed.
- Task 14 changes no schema or persistence code. The unchanged latest complete
  guarded PostgreSQL result is Task 12's 316 tests across 23 files; it was not
  rerun or represented as Task 14 execution.
- `git diff --check` and a changed-file credential-pattern scan passed before
  the checkpoint commit.

All test values are conspicuously synthetic and non-operational. No credential,
token, customer data, raw external message, response body, provider identity,
or secret value is included in this evidence.

## Remaining gates

- P4-005 must add the authoritative customizable PostgreSQL policy, usage
  counters, leases, safe escalation, and alert behavior.
- P4-006 must add the reviewed English/Bangla evaluation set and scoring.
- Recording-off, private application-network routing, approved providers and
  limits, deletion behavior, and live quality remain unverified. The checked-in
  false attestations keep model traffic disabled.
