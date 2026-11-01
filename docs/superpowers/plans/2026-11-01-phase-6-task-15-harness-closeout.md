# Phase 6 Task 15 Harness Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task by task in the existing AGY isolated branch.

**Goal:** Remove the three remaining reviewed harness/evidence defects from
PR #3 and return a reproducibly validated submission to Codex.

**Architecture:** Bound the existing test-owned child lifecycle and contain
the dedicated RO-volume initializer. Keep accepted kernel-EROFS, owning lock/
catalog and seeded older-snapshot tests; correct the evidence around them.
No application behavior, recovery authority or external integration changes.

**Tech Stack:** Strict TypeScript/Vitest, Bash, Docker, PostgreSQL and hermetic
standard-library Python tests.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md`;
`docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md`;
`docs/superpowers/plans/2026-11-01-phase-6-task-15-review-corrections.md`;
`docs/reviews/2026-11-01-pr-3-correction-review.md`.

## Global constraints

- Existing owner approval covers this local synthetic scope. Continue draft
  PR #3 on `codex/agy-p6-failure-matrix`; preserve changes, fetch/merge fresh
  main, and read AGENTS/TODO/PROJECT_CONTEXT/SYNTHETIC_FIXTURE_POLICY first.
- No SSH, server/daemon/global cleanup, other-project change, live provider/
  model/n8n/Meta call, tunnel, production, Phase 7, primary checkout edits,
  tracker/action/incident edits, main merge or gate self-approval.
- PostgreSQL remains authoritative; models receive no tools. Never print or
  commit credentials, message content, dumps or unfiltered command output.
- These are genuine harness defects: record reproduced RED, minimal GREEN and
  fresh review. Keep runtime retention/consent/limits/recovery policy unchanged.

## Review focus

- A silent child must time out inside the awaited test body and enter cleanup.
- A spawn error may never emit `exit`; cleanup must still settle.
- A preexisting RO volume or foreign consumer must prevent root mutation.
- A failed or interrupted initializer must not leave an owned root actor.
- Evidence must distinguish authentication revocation, transport and seeded
  snapshot state, and must report a failed full gate despite a focused pass.

## Task 1: Bound the test-owned child lifecycle

**Files:** Modify `tests/systemd-contract.test.ts`. If extraction is useful,
keep it in `tests/helpers/` with focused tests under `tests/`; do not add
test-only behavior to runtime classes.

- [ ] Reproduce a live child that never emits the barrier and a failed spawn
      against the current waits. Give the reproduction its own outer failsafe
      that reaps only its children, so RED itself cannot strand processes.
- [ ] Add internal rejecting deadlines to barrier and exit waits, comfortably
      inside the outer test budget. Remove listeners and timers on success,
      error, premature exit and timeout. Preserve split-chunk marker handling.
- [ ] Bound shutdown/reaping, including SIGTERM refusal and SIGKILL escalation;
      distinguish a child that never spawned from one still alive. Confirm
      stdio closure/reaping before removing exact owned scratch state. Do not
      wait forever for an exit event that can never occur.
- [ ] Exercise silent owner, premature clean/nonzero exit and spawn failure.
      Assert cleanup runs before the outer deadline, no owned process/lock
      survives, and normal owning scheduler contention/release still passes.
- [ ] Run focused tests and the real native scheduler assertion; commit the
      minimal correction with genuine RED/GREEN evidence.

## Task 2: Contain and verify the RO initializer

**Files:** Modify `scripts/test-encrypted-backup.sh`, with focused test support
under `tests/` or an extracted narrowly scoped test helper if needed. Reuse
`scripts/test-promotion-secret-ownership-docker.sh:13` as the established pattern.

- [ ] Reproduce refusal gaps for a preexisting volume, wrong ownership label/
      driver/options, foreign consumer and interrupted/failed initializer using
      synthetic Docker observations. Assert refusal before root writes; avoid
      destructive real negative fixtures belonging to unknown owners.
- [ ] Refuse existing volume/initializer names before creation. Require exact
      creation acknowledgement, label, local driver/scope, default options and
      no existing consumers before mutating the fresh volume. Inspection errors
      are failure, not proof of absence.
- [ ] Identify the exact owned initializer by guarded name/ID, label, image and
      intended volume binding. Use `--network none`, `--read-only`, root only
      for ownership initialization, dropped capabilities with only necessary
      ownership capabilities restored, no-new-privileges and bounded CPU/
      memory/PIDs. Do not mount a Docker socket or unrelated filesystem.
- [ ] Cleanup only that exact actor after success/failure/interruption. Verify
      the exact volume is owned and has no consumers before deletion. Preserve
      foreign actors/resources and propagate cleanup failure to gate exit.
- [ ] Run real RO/kernel-EROFS and writable controls, then verify zero owned
      initializer/volume leftovers. Keep unrelated inventory intact. Commit.

## Task 3: Complete the evidence audit

**Files:** Correct `docs/testing/phase-6-failure-matrix-gap-map.md` and
`docs/handoffs/2026-10-30-antigravity-phase-6-closeout-results.md`.

- [ ] Check every referenced file exists and every title/parameter/assertion/
      lane matches source. Do not stop after replacing the examples below.
- [ ] Remove nonexistent tunnel-health script and narrow that row to stale
      attestation/not-verified unit behavior; actual tunnel outage remains
      pending authorized live evidence.
- [ ] Remove nonexistent `tests/operations-drain.test.ts`; use the actual
      `tests/operations-drain-script.test.ts` only for assertions it contains.
- [ ] Stale admission: cite only the actual relevant test
      `tests/integration/postgres-receipt-store.test.ts:290`, title
      `records an inbound message older than five minutes as stale`. It proves
      stale admission/content removal, not stale-signature rejection.
- [ ] Revocation: use `tests/integration/postgres-admin-identity.test.ts:333`,
      `expires, revokes, and bulk-revokes active sessions`. Remove nonexistent
      session-termination titles, crypto-only revocation citations and claims
      that these assertions close TCP/socket connections.
- [ ] Lock conflict: use `tests/operations-scripts.test.ts`'s
      `host preflight handles %s without repairs or data mutation` with actual
      `lock-conflict` parameter and the new real scheduler test; remove the
      nonexistent `operations_lock handles conflict` title.
- [ ] Narrow checkpoint claims to actual age/watermark/signature/completeness
      cases, or add separate existing citations for schema/journal claims.
- [ ] Describe the outbox addition as seeded older-snapshot state against real
      PostgreSQL plus a fake provider, not physical snapshot capture/restore.
      Keep the same-provider control and unchanged recovery hold intact.
- [ ] Label earlier workflow evidence by its actual SHA. The earlier recorded
      `41279632399` run is `6317aff8f6e38e8ac4734eb1b8d6932e226aee9a`;
      independently verified final `b3831b0` workflows are in the linked review.
      Do not imply a prior run validated later source. Report each Python
      suite separately and keep overlapping lane counts separate.
- [ ] Preserve the failed full Windows check and its two passing focused reruns
      in the historical verification record. Require a clean full check on the
      corrected final source. If timeouts recur, identify the controlling
      deadline/load path; do not raise arbitrary global/runtime limits or hide
      failures with selection, skipped tests or retries labeled as first-pass.

## Task 4: Final validation and delivery

- [ ] Focused tests first; then `VITEST_MAX_WORKERS=4 npm run check`, forced
      formatting of changed Markdown with `--ignore-path .gitignore`, shell
      syntax, targeted secret patterns and `git diff --check`.
- [ ] Run guarded native/grants/restore/PostgreSQL and affected Docker/network
      gates sequentially, including the existing multihomed ordinary-egress
      probe. Run five hermetic Python suites individually. Keep CI permissions
      and the test-files-only helper step unchanged.
- [ ] Audit exact owned resources after success and injected failure. Record
      counts only; never prune globally or remove unknown consumers.
- [ ] Commit/push PR #3 and require all four workflows on the final source.
      Deliver the full SHA, actual commands/counts/skips/durations/links,
      RED/GREEN, cleanup and remaining limitations. Codex owns independent
      acceptance, merge, aggregate gate and Task 16; do not self-close them.

Self-review: this closes the three bounded findings without reopening accepted
snapshot/EROFS/catalog scope. No new product feature or external action is
assigned. The original whole-phase gate requirements remain in force.
