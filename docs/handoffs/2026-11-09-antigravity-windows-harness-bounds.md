# AGY: repair Windows harness deadline reliability

Date: 2026-11-09 (Asia/Dhaka).
This is a bounded validation follow-up to the approved Phase 6 harness work,
not a new product phase. Codex is using the PR #10 and PR #13 worktrees; do not
edit or reuse them. Start a fresh isolated `codex/agy-windows-harness-bounds`
branch from freshly fetched main, recording its exact Git-generated revision.

## Evidence and scope

The 2026-11-07 broader Windows check recorded 2,000 passing tests, 446 skips and
three unchanged 5,000 ms timeout failures. The separate one-worker fresh-fixture
run of the affected suites plus governance passed all 77 tests in 126.85 seconds.
Neither result should be discarded or generalized into proof of a particular
machine-load cause.

Affected cases:

- `tests/backup-harness-containment.test.ts`: read-only initializer containment.
- The same file: exact-ID failed-initializer cleanup before volume removal.
- `tests/operations-promotion-controller.test.ts`: lost PostgreSQL create
  acknowledgement requiring a complete fresh postcondition without replay.

Some fixture child deadlines exceed their enclosing test deadline. Investigate
actual setup/dispatch/reaping costs and ownership before changing anything.
Changes are limited to these tests and necessary shared test helpers; do not
change production scripts, runtime contracts or application behavior.

## Checklist and acceptance criteria

- [ ] Reproduce/profile the affected tests under the pinned Windows toolchain
      with the normal four-worker setting. Record exact commands, counts and
      durations; if not reproduced, retain that uncertainty instead of inventing
      a cause. Do not inspect unrelated process arguments or credentials.
- [ ] Add deterministic RED controls for any actual deadline/reaping defect
      before fixing it. Reuse existing bounded process-lifecycle helpers where
      appropriate. Every child must be reaped before fixture cleanup, including
      failed initialization and interrupted barrier paths.
- [ ] Keep the existing 5,000 ms test contract. Child deadlines and termination
      grace must fit within it, leaving room for cleanup. Reduce unnecessary
      fixture subprocess/setup work where supported by measurements. No blanket
      timeout increase, skip, retry, `continue-on-error` or assertion removal.
- [ ] Preserve real owning-harness execution, containment flags, exact actor
      ownership, refusal behavior, archive preservation and lost-acknowledgement
      postcondition controls. Do not replace the subject under test with a copy
      or a simulation that cannot catch the original defect.
- [ ] Prove paired success/refusal controls and bounded cleanup with authored
      synthetic data. Local Docker/SSH/provider/daemon actions are not needed
      and not delegated. Any Docker-shaped test port must remain a hermetic fake.
- [ ] Run focused suites with the normal worker count and the applicable local
      quality gate. Use existing disposable Linux/native CI to check portability.
      Report remaining promotion/health failures independently; do not alter
      validators or replay uncertain scopes to make unrelated CI green.
- [ ] Force-format changed Markdown, check whitespace and synthetic-fixture
      compliance, and push a separate draft PR with exact source/run provenance,
      RED/GREEN evidence, counts, durations and remaining unknowns. Do not merge.

Deliver a dated results file. Codex retains source acceptance, current CI
promotion/health diagnosis, shared-server health disposition and dashboard rollout.
No edits to production controllers, scheduled state, recovery authority,
credentials, shared-host Docker/systemd, tunnels, Meta, Manifest, n8n, external
notifications, ClickUp records or the production number are delegated.
