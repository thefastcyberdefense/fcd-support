# AGY: PR 18 deadline and descendant corrections

Date: 2026-11-10 (Asia/Dhaka). Continue draft PR #18 on its isolated worktree.
Reviewed head: `e7c44a24497e8be994f1e64b4e8c61fe4ebf5bc4`.
Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, the original Windows harness handoff
and `docs/reviews/2026-11-10-agy-followup-review.md`. Fetch fresh accepted main
and merge it into this branch without losing review/handoff evidence. Record
exact base, reviewed and submitted SHAs. Do not edit primary or other worktrees.

## Checklist and acceptance criteria

- [ ] Add deterministic RED controls for both reviewed defects before changing
      the helper. Preserve the historical load trigger as unreproduced; no
      blanket claim that passing runs establish its cause.
- [ ] Bound execution, platform inspection/termination, closure, escalation and
      fixture cleanup within the unchanged 5,000 ms enclosing test deadline.
      Each phase must consume one shared absolute deadline, not restart a full
      allowance for each nested wait/helper. Include setup/drain/cleanup margin.
      Exercise default 3,500/500/500 behavior and slow termination/closure paths.
      Do not extend outer deadlines, add skips/retries or weaken assertions.
- [ ] Capture verifiable owned descendant/group identity while the root still
      exists. A successfully exited root with closed stdin/stdout/stderr must
      not bypass cleanup of its owned background descendants. Add a real
      Windows/MSYS2 closed-stdio background-child regression and a paired normal
      completion control. Explicitly reap owned actors even when assertions fail.
- [ ] Prove unrelated sibling/canary processes survive. Numeric process metadata
      only; no command lines, arguments, credentials or broad process killing.
      Account for stale/reused identities and fail closed if cleanup cannot be
      confirmed. Do not return success merely because root handles are closed.
- [ ] Keep scope to the approved tests/helpers and dated evidence. Preserve real
      owning-harness execution, archive/ownership checks, containment, lock
      release and lost-acknowledgement refusal. No src/, production scripts,
      infra/, migrations/, config, dependency or recovery-authority change.
- [ ] Run focused suites and full normal four-worker Windows gate. Record exact
      counts, durations, skips and any remaining timeout independently. Verify
      portable behavior in existing disposable Linux/native GitHub Actions.
- [ ] Run all applicable static/governance gates, force-format changed Markdown,
      check whitespace and authored fixture policy. Update the existing draft
      PR description with immutable final-head workflow links, RED/GREEN proof,
      remaining gaps and rollback. Do not merge or claim a launch gate PASS.

No local/shared-server Docker, SSH, daemon/systemd, tunnel, provider, Meta,
Manifest, n8n, ClickUp, account, alert or production-number action is delegated.
Codex retains acceptance, server incident disposition and dashboard rollout.
