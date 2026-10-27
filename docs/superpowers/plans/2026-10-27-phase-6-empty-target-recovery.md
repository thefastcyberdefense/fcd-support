# Phase 6 Empty Target Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this Task 11 addendum inline. Steps use checkbox syntax for tracking.

**Goal:** Explicitly close a provably empty interrupted target without deleting
evidence or weakening the unresolved-intent guard.

**Architecture:** Add a terminal descriptive record and a narrow private host
controller. A networkless metadata probe proves emptiness; source selection,
jobs, target provenance and resources are independently checked under the
existing lock. A later restore uses different target names and normal gates.

**Tech Stack:** Strict TypeScript, Bash, PostgreSQL identity metadata, existing
pinned Docker images, Vitest and native filesystem/Docker checks.

**Spec:** `docs/superpowers/specs/2026-10-27-phase-6-empty-target-recovery.md`.

## Global Constraints

- Preserve every intent, selected volume, target resource and unresolved job.
- No business SQL, provider call, new public route or production asset change.
- The probe's only bind is the exact inspected target data directory, read-only;
  no secret, archive, other host directory or Docker-socket mount is permitted.
- Default generic failures and closed metadata only; no filenames or contents.
- Keep Task 11's original BASE and main execution ledger; no P6 completion claim.

## Review Focus

- A target once selected cannot be abandoned, even if later empty.
- A foreign bind or lost Docker response cannot be interpreted as absence.
- Conflicting/partial terminal records cannot authorize a new attempt.
- Recovery code may be newer than the source but cannot substitute its identity.
- Empty-target closure cannot settle a SQL job or authorize promotion/reuse.

## A: Immutable terminal history

Files: `scripts/operations-restore-state.sh`,
`tests/operations-restore-state.test.ts`.

- [x] Add RED cases for closed abandonment fields, terminal pairing/conflicts,
      unchanged intent/source, target reservation and blocked promotion.
- [x] Run focused unit/native filesystem cases and observe intended failures.
- [x] Implement `restore_state_abandon` with exclusive atomic publication and
      bounded fields; accept completed/abandoned history only for distinct new
      target names. Preserve all original refusal cases.
- [x] Run affected checks, review diff and commit/push the completed component.

Component A evidence: 8 portable RED cases, then 33 passing/34 native skips;
native RED confirmed the missing abandonment function, then all 67 cases passed
(42.14 seconds). The complete code gate passed 1,743 tests/382 platform skips
across 117 files (200.73 seconds), including format, lint, types and build.
An unnecessary test-string escape was corrected after the first lint refusal.
This is an internal state primitive; the public command and host proof are not
yet available and no server state was changed by this component.

## B: Empty proof and locked private command

Files: `src/operations/empty-restore-target.ts`,
`src/operations/empty-restore-target-main.ts`,
`scripts/operations-empty-restore.sh`, `scripts/abandon-empty-restore.sh`,
`scripts/operations-common.sh`, corresponding focused tests and native harness
selection.

- [x] Add RED empty/nonempty/symlink/identity-race/privacy tests and public
      argument/preflight tests. Require zero content reads and no backend mounts.
- [x] Implement the bounded root-identity proof and closed Linux UID-1000 CLI.
- [x] Add the explicit action/parser/handler and host checks from the spec.
      Permit no pending job, used target, foreign actor/bind or unsafe history.
- [x] Verify fresh and repeated resource/physical/selection facts before the
      terminal record; default output only `restore_abandoned=true` on success.
- [x] Run code/native/Docker regression checks; self-review and commit/push.

Final local component evidence: 33 native host cases (75.01 seconds), 69
native restore-state cases (51.11 seconds), and the real Docker confinement,
nonempty-target, missing-bind and synthetic-cleanup checks passed. The full code
gate passed 1,756 tests with 423 platform skips across 122 files (202.10 seconds).
The earlier broader native gate passed 1,180 units and 139 PostgreSQL cases
with one restore-only skip before the final stricter checks. The real server
close-out and Task 11 completion remain open.

Probe checkpoint: the filesystem-only helper and fixed-argument UID-1000 CLI
pass 15 native Linux cases, including empty/nonempty roots, symlinks, a root
replacement and no content reads. The portable suite passes five cases with
ten Linux-only skips. The complete code gate passed 1,748 tests/392 platform
skips across 118 files (201.69 seconds). The independent CI trace test now
closes child stdin, matching the real deployment invocation; its three focused
cases pass on both Windows and Linux. The host command and Docker confinement
still require implementation and verification. On the test server, the Docker
volume mountpoint cannot be resolved by the unprivileged operator; the host
proof must treat that as an unresolved boundary, never as a safe absence.

Host inspection ruling: the daemon's canonical, protected Docker root and the
default local volume's exact `volumes/<name>/_data` path establish the target
location without operator access to Docker's private metadata directories.
Every other bind must resolve successfully and remain disjoint. Docker daemon
and root-controlled storage are trusted; unknown roots, paths or binds refuse.
The exact target data directory is the probe's sole read-only bind. A real local
Docker check proved a missing named volume is implicitly created, while a
missing bind source is refused at container creation; both synthetic scopes
were cleaned. This avoids implicit recreation if the target disappears.

Image ruling: the operations image inherits a declared PostgreSQL volume;
actual Docker inspection found an extra anonymous mount. The private probe
must use the immutable application image and explicitly reject any declared
image volume. The earlier three failed fixture actors were removed, but their
possible anonymous volumes are preserved because ownership cannot be proved
after those actors were removed. No server volume was involved. Future fixture
cleanup removes anonymous volumes only while attached to an identified actor.

Absent-target ruling: a missing target is not proof of a never-used target.
Completed jobs are removed from the active journal, so absence cannot rule out
prior use and later removal. The command must refuse absent targets until a
separate durable history can prove their lifecycle. The current server target
still exists and can be checked for emptiness.

Orphan ruling: an operation override left without an active journal or any
stopped/running operation actor for the source project is ambiguous evidence.
Both block abandonment. Resource listings are repeated immediately before the
terminal record so a newly appearing operation actor also refuses.

## C: Real server recovery evidence

- [x] Commit the exact revision, candidate-image/config preparation, empty-target
      action and preserved-resource rollback boundaries before server mutation.
- [x] Execute only after current inventory matches; record closed proof and
      unchanged original intent/volume/source/admission fingerprints.
- [ ] Retry a distinct fresh target with current checkpoint, then validate full
      restore/promotion/retained rollback when possible. Preserve every refusal.
- [ ] Update Task 11 evidence and remaining recovery gaps; keep P6 open until
      the complete plan, interruption matrix and final whole-phase review pass.
