# AGY: PR 22 Ownership Review Corrections

Date: 2026-11-14 (Asia/Dhaka).

Keep PR #22 draft on `codex/agy-windows-capture-consistency`. Start with a clean
worktree and freshly fetched main; integrate the Codex review/evidence commit
without deleting main's files. Record base and every final source SHA. Preserve
all other worktrees. Submitted source under review is
`fc5bfd8ccb1129bd3dc8fad8c867d9a2be7a4399`.

Read AGENTS, the [original handoff](2026-11-11-antigravity-windows-capture-consistency.md),
and [independent review](../reviews/2026-11-14-pr-22-23-review.md). The frozen
[review probe](../reviews/2026-11-14-pr-22-ownership-probe.md) reproduces two
base/head regressions using authored identities and exclusively fake signals.
Its successful exit reproduces the submitted bug; it does not test a future fix.

## Checklist and acceptance criteria

- [ ] First convert both demonstrated cases into deterministic failing tests
      against the actual helper: unresolved MSYS child's WinPID recycled to an
      unrelated identity during capture follow-up; and native child/grandchild
      born after capture, absent from MSYS, under an older still-live root.
      Record observed RED before changing implementation.
- [ ] Do not join later WMI CreationDate values to stale MSYS ancestry/group
      proof. Establish coherent refreshed identity/ancestry/live captured anchor
      evidence, or fail closed. A root-alive check alone is insufficient for a
      recycled child. Assert the unrelated identity is neither adopted nor
      signaled, including root exit during the async observation and a live-root
      child-recycle variant.
- [ ] Restore complete recursive native descendant discovery and confirmation
      within the same deadline, or reject unconfirmed cleanup. Cover multiple
      native generations, mixed MSYS/native trees and a deadline reached before
      the discovery frontier closes. Never report resolved with an owned
      surviving grandchild; do not kill ancestors before collecting necessary
      descendant proof. Reconcile the existing single-WMI optimization test with
      complete coverage rather than blindly suppressing necessary observations.
- [ ] Preserve CreationDate checks, live captured group anchors, UID checks,
      unrelated canaries, exact deadline propagation and failed-assertion cleanup.
      No new skip/retry, timeout growth, broad group adoption or global kill.
      If retaining the 1,200 ms capture floor, prove its observer lifecycle stays
      inside the caller's complete budget, including shorter custom budgets;
      do not claim the ordinary outer deadline was extended by the old code.
- [ ] Keep changes to necessary tests/helpers and dated evidence. No production
      code/scripts/infra/migrations/dependency/config changes, native FFI/Job
      Objects, SSH, Docker daemon, server, account, provider or alert actions.
      Return a design proposal if a new mechanism is necessary.
- [ ] Run focused ownership/containment/stdio suites, one complete ordinary
      four-worker Windows gate and exact final-head Linux CI. Preserve earlier
      failures and the submitted 2,257-test passing root run as historical proof
      that green suites alone missed these bugs. Attribute every run to its SHA;
      no claim of universal reliability from a few successful runs.
- [ ] Force-format the dated report explicitly using Prettier with
      `--ignore-path .gitignore <explicit Markdown files>`, then run static,
      fixture/governance/whitespace checks. Update the PR description with real
      RED/GREEN evidence, immutable CI links, limitations and rollback.
- [ ] Return exact final head, changed files, regression outcomes, full test
      counts/skips/durations and CI status. Leave main, TODO/PROJECT_CONTEXT,
      server and both PR merge decisions with Codex. Do not merge.

A clean correction prevents unrelated signaling and false tree-exit confirmation;
performance improvements alone are not acceptance. No live shared-host failure
is to be reproduced or resolved under this assignment.
