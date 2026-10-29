# Phase 6 observed fresh drill implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Resume the approved
> Phase 6 Task 11; this plan adds diagnostic evidence, not recovery authority.

**Status:** On hold before deployment. Read-only inspection of the `70f8e70`
proposal passed, but a later raw static-mount guard was independently shown to
refuse unchanged resources. Four generated, unexecuted local driver copies were
withdrawn. No namespace, baseline directory or server asset was created. Resume
after the adjacent post-verification correction plan and exact-source CI pass.

**Goal:** Exercise the reviewed correction on a fresh private synthetic scope
while retaining content-free evidence before promotion-job cleanup.

**Architecture:** A passive host observer reads only scoped Docker events,
identity projections and the exact protected job's closed output. Existing
public controllers retain all mutation and readiness decisions. Reuse the
existing exact-revision action drivers with a new protected baseline.

**Tech stack:** Existing Bash/Python standard-library action drivers; unchanged
strict TypeScript application and pinned Docker images. No new dependency.

**Spec:** The "Passive observation choice and implementation steps" section in
`docs/operations/phase-6-server-deployment.md` is the bounded diagnostic design.
The owner delegated routine choices; the observer approach is Codex's choice.

## Global constraints

- Preserve every older scope, journal, volume, database and stopped target.
- The `70f8e70` proposal is not admitted despite its complete CI pass. Repin the
  action and observer to the next reviewed corrected revision and require its
  complete four-workflow CI pass before deployment. Server admission remains
  the clean `6faff8b` checkout; preserve all earlier scopes.
- All traffic is synthetic/private with external execution disabled.
- The observer issues only local Docker events, inspect and logs reads. It
  receives no database or provider capability and emits no raw input values.
- Duration, buffers and record count are bounded. Actor absence, lifecycle
  exit codes and protocol stages never settle a job or grant readiness.

## Task 1: Passive observation and test-first boundary checks

- [x] Write `docs/operations/actions/2026-10-29-promotion-observer-test.py`
      before implementation. Initial stubs: 14 tests, 11 expected assertion failures.
- [x] Add journal/identity binding and read-only subprocess tests; run RED.
- [x] Implement `2026-10-29-promotion-observer.py`. Require protected output,
      actual journal/actor identity and fixed codes before following logs. No
      container action, SQL, pointer operation or journal transition is permitted.
- [x] Run pure tests on Windows and Linux, syntax and closed-output checks.
      Self-review every subprocess and write path. Record exact counts and limits.

Final observer checks: 28 passing tests/one Linux SIGHUP skip on Windows;
29 passing on Linux. A fresh action review found a signal-cleanup defect;
SIGTERM/default exit and missing reader deadlines were reproduced, then fixed.
The actual observe loop is exercised through hermetic worker subprocesses,
including complete flow, timeout, EOF, partial launch, signal cleanup and kill
fallback. No actual observer has run. Its current `70f8e70` pin must change before
admission. Its ready marker confirms launch, not a Docker subscription ACK.

## Task 2: Exact fresh deployment and staged drill

- [ ] Regenerate admitted action drivers from the existing tracked predecessors
      after the post-verification fix, using the new exact source and namespace,
      retaining their public entry points, single-use guards and complete baseline.
      Use eight new 198.19.0.0/24–198.19.7.0/24 bridges; the restore target uses
      198.19.8.0/24 only after protected preparation and actual overlap checks.
- [ ] Wait for merged-source CI; validate and commit/push the concrete records
      before any server mutation. Require clean source `6faff8b` at admission.
- [ ] Execute deploy/verify once. Require READY/no job, four healthy private
      actors and unchanged prior state before backup/replay and isolated restore.
- [ ] Start the observer and require its ready marker before one promotion
      attempt. Public verification remains authoritative. Only verified promotion
      permits the compatible retained-revision rollback stage.
- [ ] Record outcomes precisely. On refusal/uncertainty, preserve everything;
      do not replay, settle or clear state. Task 15 and P6-GATE stay open until all
      remaining required proofs and whole-phase review actually pass.
