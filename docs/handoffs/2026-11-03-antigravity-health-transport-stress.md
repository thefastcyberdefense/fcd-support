# AGY assignment: synthetic health transport and acknowledgement stress

Owner: AGY. Codex retains source acceptance, merge, shared-server execution and
Task 16 authority. This assignment is independent of the root timer repair.

## Context and start boundary

Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, SYNTHETIC_FIXTURE_POLICY.md,
`../testing/2026-11-03-scheduled-readonly-socket.md` and the Phase 6 plan.
PR #8 fixes read-only socket verification and adds closed-only health
acknowledgement diagnostics. Source b73188e had one failed fresh CI lane in
run 41581877934, job 125738345220: deploy/verify/private HTTP/maintenance/backup
passed, then health stopped at its terminal log/acknowledgement boundary and
retained uncertainty. The precreated lane and other three workflows passed.
No cause or SQL completion has been inferred.

Use a separate worktree and branch `codex/agy-p6-health-transport-stress` from
fresh synchronized main **after Codex merges PR #8**. Until then, inspect the
published evidence and prepare the test design only. Do not edit Codex's primary
checkout, timer helpers, server or tracker. Do not replay a failed scope.

## Tasks

- [ ] Add a bounded synthetic stress option to the disposable CI harness,
      exercising actual compiled health input, Docker attach/wait/log transport,
      public scheduled-health executor and PostgreSQL persistence. Use the
      existing hardened fixture and disabled external flags; no mock success
      may substitute for the actual owning boundary.
- [ ] Run up to ten sequential health invocations only while the previous
      invocation is fully completed, its actor removed and journal absent.
      Stop immediately on uncertainty. Never clear/retry that scope, infer
      commit from container absence, or add a resolver.
- [ ] Cover both fresh and precreated disposable-runner layouts. Preserve the
      newline-framed, held-open-stdin contract. Add meaningful failure cases
      test-first for empty, malformed, multiline or unavailable terminal output
      where the actual boundary permits deterministic injection.
- [ ] Collect only closed outcome classes and counts. In particular classify
      log read failure separately from empty/noncanonical acknowledgement and
      preserve exit/terminal-observation distinctions. No body, secret, raw
      environment, database row, private identifier or unrestricted log may be
      printed, uploaded as a public artifact or committed.
- [ ] Add an independently runnable, pinned GitHub Actions stress job or
      explicit bounded stress step, with timeout and test-owned cleanup.
      Preserve existing full controller/recovery coverage and resource bounds.
- [ ] Record exact source SHA, commands, RED/GREEN evidence, immutable workflow
      links, independent lane counts and any unresolved cause in
      `2026-11-03-antigravity-health-transport-results.md`. Open a draft PR;
      do not merge or claim Phase 6/Task 16 completion.

## Scope and acceptance

Allowed: synthetic test harness, new focused tests, a scoped workflow and the
results document. Coordinate existing-harness edits only after fresh main
contains Codex's diagnostics. Do not alter application acknowledgement formats,
host job acceptance, journal/recovery rules, production Compose, timer units,
retention, privacy, exposure or provider behavior. Report a discovered runtime
bug with a failing reproduction; Codex decides and implements its correction.

Acceptance requires a real transport path, bounded execution, no automatic
replay on uncertainty, reliable zero-owned-leftover cleanup on disposable
runners, secret-safe diagnostics and green appropriate local/CI checks. Keep
historical failures and current results distinct. A non-reproduction is a
reported result, not proof that the original failure did not occur.

No SSH/shared-server commands, daemon/host restart, tunnel, live Manifest/model,
Meta, n8n workflow, production-number or other-project action is authorized.

## Following phase work

The separate approved docs-only Phase 7 readiness assignment remains
`2026-11-02-antigravity-phase-7-readiness.md`. Continue it on its own branch;
map existing P7/acceptance IDs and prerequisites without inventing new phase
items or treating live recording-off/provider/Meta checks as already passed.
