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
- No secret, archive, host-directory or Docker-socket mount in the empty probe.
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

- [ ] Add RED cases for closed abandonment fields, terminal pairing/conflicts,
      unchanged intent/source, target reservation and blocked promotion.
- [ ] Run focused unit/native filesystem cases and observe intended failures.
- [ ] Implement `restore_state_abandon` with exclusive atomic publication and
      bounded fields; accept completed/abandoned history only for distinct new
      target names. Preserve all original refusal cases.
- [ ] Run affected checks, review diff and commit/push the completed component.

## B: Empty proof and locked private command

Files: `src/operations/empty-restore-target.ts`,
`src/operations/empty-restore-target-main.ts`,
`scripts/operations-empty-restore.sh`, `scripts/abandon-empty-restore.sh`,
`scripts/operations-common.sh`, corresponding focused tests and native harness
selection.

- [ ] Add RED empty/nonempty/symlink/identity-race/privacy tests and public
      argument/preflight tests. Require zero content reads and no backend mounts.
- [ ] Implement the bounded root-identity proof and closed Linux UID-1000 CLI.
- [ ] Add the explicit action/parser/handler and host checks from the spec.
      Permit no pending job, used target, foreign actor/bind or unsafe history.
- [ ] Verify fresh and repeated resource/physical/selection facts before the
      terminal record; default output only `restore_abandoned=true` on success.
- [ ] Run code/native/Docker regression checks; self-review and commit/push.

## C: Real server recovery evidence

- [ ] Commit the exact revision, candidate-image/config preparation, empty-target
      action and preserved-resource rollback boundaries before server mutation.
- [ ] Execute only after current inventory matches; record closed proof and
      unchanged original intent/volume/source/admission fingerprints.
- [ ] Retry a distinct fresh target with current checkpoint, then validate full
      restore/promotion/retained rollback when possible. Preserve every refusal.
- [ ] Update Task 11 evidence and remaining recovery gaps; keep P6 open until
      the complete plan, interruption matrix and final whole-phase review pass.
