# AGY: PR 19 contained health-regression corrections

Date: 2026-11-10 (Asia/Dhaka). Continue draft PR #19 in its isolated worktree.
Reviewed head: `22b437788e57769d6a038afa59a89a486424cf98`.
Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, SYNTHETIC_FIXTURE_POLICY, the original
health stdio handoff and `docs/reviews/2026-11-10-agy-followup-review.md`.
Fetch/merge fresh accepted main, recording exact provenance and preserving all
review evidence. Do not edit the primary or any other active worktree.

## Checklist and acceptance criteria

- [ ] RED: execute the actual harness ownership/cleanup functions through a
      hermetic Docker port with pre-existing name/label collisions. Prove the
      current removal defect, then prove refusal makes zero mutations to the
      collided actor, network and volumes. Include partial-create/failure paths.
- [ ] Keep an exact ledger of successfully created owned resources/immutable
      IDs. Verify expected complete identity before removal, refuse foreign or
      replaced resources, and gate on leftovers. Precreation refusal must not
      adopt same-labeled resources into cleanup. Preserve unrelated canaries.
      Avoid anonymous untracked initializer actors and label-only bulk removal.
- [ ] Native disposable CI must use actual production journal/state helpers,
      including synchronization and complete protected records. Remove durable
      evidence claims from lanes retaining mocks. For a deliberate missing ACK,
      verify actual durable uncertainty, terminate/reap the first controller,
      then start a fresh controller and prove pending refusal with zero further
      Docker calls and unchanged saved record. No resolver, replay, clearing,
      fallback or completion inference. Use existing fixture isolation/ownership
      plumbing; do not weaken production stat/config checks to admit the test.
- [ ] Compare actual DEBUG/functrace absent against the actual existing TRACE
      entry active. Verify equivalent exit/result, persisted observations and
      containment, with no diagnostics when disabled. Do not confuse the
      diagnostics environment toggle with tracing disabled. Retain log-driver
      normal/none pairing and the actual built process as positive subject.
- [ ] Replace lexical stderr publication with a fixed closed enum and bounded
      numeric metadata. Test arbitrary valid-looking tokens and authored
      sensitive sentinels through complete ERR/EXIT paths; capture privately and
      assert absence from all emitted channels, including diagnostics. No raw
      stderr, stdout, credentials, actor IDs or arguments may be published.
- [ ] Retain held-open framing, exact acknowledgement/exit/ownership predicates,
      real PostgreSQL row assertions and malformed/oversized/stalled/nonzero
      controls. Label immediate success as added regression coverage; use narrow
      test-port faults for sensitivity, not an invented historical product RED.
- [ ] Keep changes to tests, necessary synthetic harness plumbing and evidence.
      No src/, production controllers, infra/, migrations/, configuration,
      deadlines, dependency or recovery-authority change. Reap children before
      scratch removal. Disposable CI Docker scopes only; no local/shared daemon.
- [ ] Run shell syntax, focused local checks, applicable full/static/governance
      gates and exact-final-head native/PostgreSQL/runtime CI. Record immutable
      run/job links, source/image provenance, counts/skips/durations, exact owned
      cleanup and remaining gaps in the draft PR. Force-format documentation,
      check whitespace/fixtures, include rollback, and do not merge.

No SSH, shared-server Docker/systemd, daemon settings, tunnel/DNS, Meta,
Manifest, n8n, external notification, ClickUp, account, alert or production-number
operation is delegated. Codex retains deployment and incident disposition.
