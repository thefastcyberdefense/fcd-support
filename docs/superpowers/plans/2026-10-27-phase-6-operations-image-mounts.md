# Phase 6 Operations Image Mount Correction Plan

> **For agentic workers:** Use superpowers:executing-plans inline and
> superpowers:test-driven-development for this Task 11 correction.

**Goal:** Remove the unintended inherited operations-image volume without
changing the explicit mounts or trusted image/job bindings.

**Spec:** `docs/superpowers/specs/2026-10-27-phase-6-operations-image-mounts.md`.

## Steps

- [ ] Run the actual Docker image/mount regression against the existing image;
      confirm both validator and explicitly mounted job have an extra mount.
- [ ] Add a final `scratch` stage that copies the built operations filesystem
      and restores required image metadata. Keep original pinned bases and
      immutable revision/operation capability labels.
- [ ] Extend image-contract validation to permit only this explicit scratch
      release stage and to inspect actual image and container mounts. Verify
      Node, npm, age, pg_dump, pg_restore and non-root execution.
- [ ] Run affected local, native PostgreSQL/restore and complete code gates;
      record exact evidence. Commit and push, then inspect GitHub Actions.
- [ ] Record a separate exact server action before preparing a new candidate
      revision or retrying the distinct restore target. Preserve all existing
      target volumes, intents, uncertain jobs and admission services.
