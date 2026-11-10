# AGY: real health process and attached stdio regression

Date: 2026-11-09 (Asia/Dhaka). Bounded Phase 6 test/harness work only.
Codex retains runtime source acceptance, PR merges, shared-server uncertainty
and dashboard deployment. Complete the independent Windows harness assignment
first, or use a separate isolated worker/worktree with no overlapping files.

## Exact starting point

Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, SYNTHETIC_FIXTURE_POLICY and the
existing handoff/review documents. Codex's current runtime candidate is
`94c03d62029a6bdc606f72fb81967af685ee8571` on draft PR #10. Verify that commit
and record Git-generated provenance. Its predecessor 58497e4 passed local gates
but all four runtime lanes failed health-1 with empty attached output. Never
reuse those failed scopes. The 94c03d6 runtime result must be reported exactly,
not assumed green from local tests.

If Codex has accepted/merged PR #10, start from freshly synchronized main and
record the merge/source relationship. Otherwise create a fresh isolated
`codex/agy-health-stdio-regression` branch directly from exact 94c03d6, and open
a stacked **draft** PR targeting `codex/agy-p6-health-transport-stress`.
Do not cherry-pick copied controller fixes into another main-based branch.
Codex will reconcile the base after accepting the parent. Primary checkout and
Codex/other AGY worktrees must remain untouched.

## Problem and authorized scope

Portable shell fixtures and unit streams do not prove the real built health
process, Docker attachment, stream closure and PostgreSQL persistence compose
correctly. Add that missing regression proof. Reuse existing synthetic native/
PostgreSQL harness containment and pinned images. Docker actions are authorized
only in a new disposable GitHub Actions fixture scope, never the shared server,
production daemon, existing uncertain scope or unrelated project. Local work
can use hermetic fake ports and static/unit checks.

Changes are limited to tests, necessary synthetic harness plumbing and dated
evidence. Do not change src/, production operations controllers/configuration,
recovery authority, quotas, test deadlines, public routes or provider clients.
If a production defect is found, report its exact boundary and an authored RED
control; Codex owns the correction. Do not paper over it in a mock.

## Checklist and acceptance criteria

- [ ] Use the actual built `dist/operations/health-main.js` and actual approved
      health-role configuration against a fresh synthetic PostgreSQL fixture.
      Do not copy/transcribe the reader or acknowledgement implementation into
      the subject under test. Record exact source and image provenance.
- [ ] Send one authored valid newline-framed host input while deliberately
      keeping the writer open through acknowledgement. Require bounded canonical
      attached stdout, verified exit 0 and actual expected persisted health
      observations. Prove no duplicate observations or sends from this fixture.
- [ ] Pair normal daemon logging with logging disabled/unavailable in separate
      fresh owned actors. Attached stdout must remain the required transport;
      no logs fallback, polling for an acknowledgement or replay is allowed.
      Keep stdout/stderr bodies private; publish only closed classifications.
- [ ] Exercise the actual CI TRACE entry with tracing active and inactive.
      Assert result/exit-state equivalence and suppression of authored sensitive
      sentinels. No false causal claim from a closed diagnostic or absent token.
- [ ] Add malformed, oversized, stalled/timeout and nonzero process controls
      with paired eligible success. Verify zero success acknowledgement and
      no unauthorized persistence; if the test includes an owning controller,
      require its durable uncertain state and refusal of re-execution without
      further Docker actions. No resolver, completion inference or state clear.
- [ ] Use deterministic barriers and existing configurable bounds; all test
      children must be reaped before scratch cleanup and before the unchanged
      outer deadline. No blanket timeout increase, skip, retry or relaxed assert.
- [ ] Refuse name/resource collisions before creation. Use exact fresh labels,
      numeric non-root ownership, read-only roots, dropped capabilities, explicit
      resource limits, scoped networks/mounts and image IDs. Verify identity
      before cleanup, fail the gate on leftovers, and preserve unrelated actors,
      volumes, networks and all historical evidence. Never use global prune.
- [ ] Demonstrate a meaningful RED control before the test/harness correction.
      If the accepted current implementation passes the new test immediately,
      label it new regression coverage and use a deliberate narrow test-port
      fault to prove sensitivity; never claim an unobserved product RED.
- [ ] Run focused local checks and the relevant disposable Linux/PostgreSQL CI
      lanes on the exact submitted head. Record counts/skips/durations and each
      distinct failing lane. A local Docker differential did not reproduce the
      old reader's attached-output loss; retain that uncertainty.
- [ ] Force-format changed Markdown, check whitespace and synthetic fixtures,
      push a draft PR and write a dated results document with immutable run/job
      links, source/image provenance, RED/GREEN evidence and remaining gaps.
      Do not mark a gate PASS or merge. Keep reporting bounded to actual proofs.

No SSH, shared-server Docker/systemd, daemon-setting, tunnel/DNS, Meta, Manifest,
n8n, notification, ClickUp, account, secret inspection or production-number
operation is delegated. If an unsupported Docker mode or privilege is needed,
stop that dependent operation and report the precise requirement; continue
independent test design/coverage work.
