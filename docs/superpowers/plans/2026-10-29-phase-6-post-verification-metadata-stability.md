# Phase 6 post-verification metadata stability implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Prevent mount-order-only refusals in the later stop/remove proof.

**Architecture:** Retain each fresh atomic complete static observation. Compare
its ordered header exactly and canonicalize only full raw mount-record order
through the existing trusted host port. No new operation authority.

**Tech stack:** Existing Bash/Docker, strict TypeScript tests and pinned images.

**Spec:** docs/superpowers/specs/2026-10-29-phase-6-post-verification-metadata-stability.md

## Task 1: Atomic comparison correction

- [ ] Read the spec, capture/proof/removal paths and existing native fixtures.
- [ ] Add deterministic RED reorder cases between capture, running and exited
      proofs. Assert distinct actual observations and unchanged action guards.
- [ ] Cover every full raw mount field, Mode/Driver, duplicate/count changes,
      unknown added fields and ordered command/entrypoint/header metadata.
- [ ] Implement the smallest complete-record canonical comparison. Preserve one
      fresh inspect per existing observation. No dropped fields, unique-sort,
      removed recheck, new resolver or widened capability.
- [ ] Run focused native cases; expect GREEN. A pre-existing passing case is
      coverage, not a fabricated failing-before-code result.

## Task 2: Actual projection and validated delivery

- [ ] Test production comparison against actual owned Docker projection using
      deliberate complete-record permutation and meaningful refusal controls.
- [ ] Run affected syntax/static checks, VITEST_MAX_WORKERS=4 full check and
      relevant sequential native/PostgreSQL lanes; verify owned cleanup.
- [ ] Commit/push a review branch/draft PR with Git-generated full SHAs, exact
      commands/counts/skips, RED/GREEN evidence and CI links. No merge or SSH action.
- [ ] Codex reviews/integrates accepted work and requires exact-source CI, then
      repins the unexecuted action/observer before any fresh server mutation.
