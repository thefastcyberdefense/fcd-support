# Health acknowledgement transport correction

Date: 2026-11-09 (Asia/Dhaka). Base: `fe3a66b9e411bb4e16815172809c6996875cfbac`.
This is a bounded correction to the approved Phase 6 operation lifecycle.
No shared-server or live-provider action is included.

## Observed defect and selected correction

Disposable PR runtime run 42632398538, fresh health-stress job 129211729484,
passed its first health operation, then refused health-2 with an empty
acknowledgement and `operations_schedule_failed`. The existing lifecycle
already attaches to the health actor, but discarded attached stdout and later
read daemon logs as the acknowledgement channel. The empty-log cause remains
unproven; this correction removes that channel dependency.

Retain output from the existing, single `docker container start --attach
--interactive` invocation. Docker documents attached stdout/stderr and
interactive stdin in its [start reference](https://docs.docker.com/reference/cli/docker/container/start/).
Capture only a bounded frame; accept it only after successful attached start,
Docker wait 0, exact owned actor exited/0 and the existing canonical validator.
Non-health operations retain their prior log-reading behavior.

The private acknowledgement protocol has a 4,096-byte cap. A Bash read rejects
NUL and a full 4,097-byte read before command substitution can remove NUL or
trailing newlines. A sentinel retains trailing newlines until the size check;
only then are trailing LF delimiters removed. Carriage return, extra content,
empty, malformed, oversized or nonzero transport refuses through the existing
uncertainty/cancel path. The Docker command's existing configured timeout
bounds attached execution. There is no log fallback, retry, replay, state
clearing or inference of operational completion.

The diagnostic is opt-in under `closed-v1`: only the fixed prefix
`synthetic_health_attach_diagnostic=nonzero:` and decimal codes 1..255 can be
published. Raw output and arguments remain suppressed. Existing acknowledgement
classifications remain available at the actual validation boundary.

## Verification

- RED: four attached-channel controls failed before retaining attached output.
  A later NUL regression also failed (invalid wire frame incorrectly accepted);
  the bounded NUL-aware read fixes that control.
- Portable focused suites: 184 passed / 0 skipped across health transport,
  synthetic evidence, promotion diagnosis and synthetic recovery, 17.78 seconds.
  These fixtures prove successor suppression and observable containment, not
  PostgreSQL settlement or real durable-journal persistence.
- A real local Docker proof used a fresh, exactly labeled, non-root, networkless,
  read-only actor with log driver `none`. Attached canonical acknowledgement and
  wait 0 succeeded while daemon logs were unavailable. The actor had no mounts
  or implicit volumes and its exact identity was verified before removal.
  This proves transport independence, not application SQL completion.
- The first native invocation failed because edited shell worktree files had
  CRLF. Safe LF normalization preserved their exact normalized Git blob contents.
  A second invocation passed 33 tests and failed four old fixtures that injected
  health faults exclusively into the daemon-log channel. Those fixtures now
  inject the same refusal cases into the attached channel; assertions remain.
  A third invocation passed all 37 native lifecycle tests in 29.14 seconds.
  Final native verification including the NUL control passed all 38 tests /
  0 skips in 33.47 seconds. The existing state harness used a fresh labeled
  networkless local Docker scope and verified its owned cleanup. Source/scripts
  were read-only binds of this worktree; this was not an immutable release image.
- Independent read-only review found no important actionable lifecycle issue.
- Final local `VITEST_MAX_WORKERS=2 npm run check` exits 0: Phase 0, formatting,
  lint, strict typecheck, unit tests and build pass. Vitest reports **2,141 passed /
  461 platform skips** across 134 files in **277.86 seconds**, with no failures.
  Forced formatting of this dated Markdown and `git diff --check` also pass.
  Subsequent immutable CI provenance is recorded in the main review; no
  historical failure is erased by a later success.

The shared-server uncertain-health journal and absent actor remain untouched.
This change neither proves that incident's cause nor grants settlement authority.
Promotion stability remains a separate issue: fe3a66b push runtime job
129211696113 identified `samples.stability.before_after.job.healthy`; its
values and transition cause were not captured.
