# Promotion readiness and preserved health stdin

Date: 2026-11-09 (Asia/Dhaka). Base:
`58497e48250e712528d3d54d767ba4480cf4b659`.
This is corrective work within the approved Phase 6 lifecycle. There are no
shared-server, provider, daemon-setting, tunnel or account changes.

## Evidence and bounded correction

The finite stability observer on fe3a66b located the changed Boolean at
`samples.stability.before_after.job.healthy` in push runtime run 42632385517,
job 129211696113. The token does not expose values or establish the direction
or cause. The promotion job inherits an asynchronous periodic Node healthcheck
from the restore job. Startup changing to healthy during inspection is a
plausible mechanism, not a proven historical cause.

Before each actual host-inspection sample pair, require readiness of the exact
owned running promotion actor. Each observation is one Docker inspect projection
containing its complete existing lifecycle identity, image/revision, operation
reference, parent/service, command hash, running/paused/restarting/dead state,
project/service labels, health state and exact command. Only `starting` may
wait; `healthy` proceeds. Unhealthy, absent, malformed, foreign, failed or timed
out observations refuse. Revalidate the protected journal/selection/context
after readiness and before snapshots. Complete before/after equality and both
PostgreSQL terminal comparisons remain unchanged. No refused pair is resampled.

The observation budget is the smaller of the existing configurable readiness
and Docker-command timeouts. Each inspect gets only the remaining budget,
checked again after return. Existing termination grace and the live Node
handshake/attached Docker deadlines remain in force; readiness cannot authorize
an expired challenge or extend those enclosing timers. Configuration mutation
is confined to the readiness subshell. The short polling cadence is internal;
no configurable operator limit or provider policy is replaced by a constant.

PR runtime run 42641308111 on 58497e4 then refused all four lanes at health-1
with empty attached acknowledgements. This is fresh evidence against claiming
the attached-capture patch alone resolves runtime reliability. No failed scope
was replayed. All four actors remained governed by existing uncertainty rules.

The framed health reader currently destroys stdin when returning early from its
default async iterator. Preserve that transport through a valid frame using
[`readable.iterator({ destroyOnReturn: false })`](https://nodejs.org/docs/latest-v24.x/api/stream.html#readableiteratoroptions),
pause further consumption, and unreference only actual process stdin so idle
input does not prevent natural process exit. Failed parsing, oversize input and
timeout still destroy the input. The existing size limit and frame validation
remain. This is a transport-contract correction, not a proven empty-log or
shared-server root cause.

## Verification and limitations

- Seven initial readiness controls failed before the gate existed. Additional
  controls prove zero snapshots on refusal, exactly two after readiness, shrinking
  timeout values and refusal after journal changes. A separate validator control
  continues to reject changes to `job.healthy` between snapshots.
- The first synthetic starting-state fixture used an unrealistically tiny real
  clock budget and refused on Windows overhead. It now advances its authored
  clock deterministically under a larger synthetic configuration while checking
  the unchanged outer test deadline and decreasing remaining budgets.
- Independent review caught an existing TRACE fixture missing the new health
  inspection/configuration ports. Updating that fixture preserves its original
  actual-wrapper assertions rather than bypassing readiness.
- The new frame-preservation control failed before the reader correction. A real
  child with stdin held open first failed natural exit with pause alone; adding
  unref passes both transport preservation and natural exit. Children use bounded
  barrier/exit waits and confirmed reaping within the enclosing test deadline.
- A local Docker differential did **not** reproduce attached-output loss with
  the old reader; the exactly owned proof actor was removed. Stdin destruction
  therefore remains a hypothesis for the CI symptom. A separate corrected-reader
  proof used the actual transpiled function in a fresh, non-root, read-only,
  networkless, resource-limited actor with log driver `none`: attached canonical
  output and wait 0 passed, daemon logs were unavailable, and exact cleanup passed.
  This proves transport independence, not application PostgreSQL settlement.
- Eight focused suites pass **319 tests / 0 skips** in **27.26 seconds**. Lint,
  strict typecheck and build pass. The preceding in-development broader run
  retained six failures (five stale TRACE fixture ports and the then-unfixed
  natural-exit control); it is not a passing final gate.
- Final native promotion-wrapper check: **26 passed / 0 skips**, 1.16 seconds,
  through the existing networkless state harness; owned cleanup passed. A prior
  unsupported multi-file state invocation refused `backup_test_mode_invalid`
  before resource creation; the harness allowlist was not changed.
- Independent read-only review found no important actionable issue in the final
  readiness and input changes.
- Final `VITEST_MAX_WORKERS=2 npm run check` exits 0: Phase 0, formatting, lint,
  strict typecheck, build and **2,152 passed / 461 platform skips** across 134
  files in **284.57 seconds**. Forced Markdown formatting and whitespace checks
  also pass. Subsequent immutable CI outcomes are recorded in the main review.

No server journal is settled, cleared or replayed by this work. The deployed
health hold and managed dashboard upgrade remain separate Codex-owned work.
