# Antigravity assignment: automate the full Phase 6 topology gate

Date: 2026-11-02 (Asia/Dhaka).
Authority: existing approval for automated synthetic testing and GitHub Actions.
This adds repeatable validation for implemented controls; it changes no product
architecture, public exposure or live integration policy. Codex owns Task 16
and every shared-server action. This assignment can proceed independently.
This automation follow-up does not reopen completed local validation or become
a prerequisite for Task 16.

## Goal and implementation choice

Run the existing `scripts/test-phase6-local.sh` on a disposable Linux GitHub
runner for future changes. The local execution on `bd3a09a` passed 9 allowed /
20 denied paths, but the current four workflows do not run that complete
multihomed ordinary-egress matrix.

Use a separate workflow/job with isolated setup and cleanup. This keeps its
Docker resources and clear result distinct from native recovery jobs. Adding
it to the existing native job would share setup but lengthen an already long
lane; leaving it manual would retain the automation gap. The separate job is
the selected approach under delegated routine implementation authority.

## Scope and boundaries

- [ ] Fetch fresh synchronized main after PR #5 integration; preserve any local
      work. Start `codex/agy-p6-topology-ci` in an isolated AGY worktree. Do not
      reuse or push the integrated PR #5 branch.
- [ ] Read AGENTS, current trackers/context, fixture policy, the original Phase
      6 plan Task 15, and `docs/testing/2026-11-02-phase-6-local-topology.md`.
- [ ] Add `.github/workflows/phase6-topology.yml`. Reuse the repository's
      immutable action/image pins, Node line, locked installation and existing
      native integration-image setup; do not invent a new dependency policy.
- [ ] Change the existing topology harness or fixture only if an actual Linux
      CI failure demonstrates a defect. Such changes are limited to
      `scripts/test-phase6-local.sh`, `scripts/test-phase6-admin-socket.sh`,
      `tests/helpers/phase6-network-fixture.ts` and directly relevant tests.
      Reproduce behavior defects test-first and report RED/GREEN evidence.
- [ ] Do not edit runtime/application policy, source authorization, production
      dependencies, primary checkout/trackers, server/action/incident records,
      final gate decisions or Task 16 files. No SSH, shared Docker daemon,
      server, tunnel, Meta, provider, n8n or production actions.

## Acceptance criteria

- [ ] Use disposable GitHub-hosted Linux runners, least-privilege repository
      permissions, bounded job timeout, no live secrets and no retained
      credentials. Report exact tested head, platform and setup.
- [ ] Run the unchanged owning harness end to end with the required local
      integration fixture image available. Handle real numeric file ownership
      and protected inputs using the existing native setup; never widen
      permissions or omit a refusal check just to make CI green.
- [ ] Prove four Compose contracts, no external-profile autostart, missing
      network rejection, native admin socket/UID separation, no admin TCP
      listener, **9 allowed / 20 denied** paths, unexpected-participant and
      missing-secret refusals, conflicting-bind rejection and final topology
      completion. Keep the ordinary NAT egress/multihomed probe intact.
- [ ] Cleanup runs on failure as well as success and is scoped to the test's
      fresh project/label/names. Verify zero test-owned containers, bridges,
      volumes and scoped application images. No global prune or indiscriminate
      kill/delete command. Preserve a failed gate if cleanup cannot be proven.
- [ ] Do not upload fixture environments, secrets, private keys, full rendered
      Compose, raw Docker metadata or unrestricted logs. Keep failure evidence
      to closed reason codes, stage, revision, counts and durations.
- [ ] Verify the new workflow on its actual pull-request head and check the
      existing four workflows separately. One successful matrix run is enough
      absent a new change/failure; do not keep rerunning expensive suites.

## Delivery

- [ ] Run appropriate formatting, `npm run validate:phase0`, diff checks and
      targeted secret-pattern checks; use forced Markdown formatting for the
      results document. Check the changed-file list and full Git provenance.
- [ ] Create `docs/handoffs/2026-11-02-antigravity-topology-ci-results.md` with
      this completed checklist, exact base/head, changed paths, commands,
      actual workflow links/outcomes, test counts/durations, cleanup result
      and any remaining issue. Distinguish local proof from new CI execution.
- [ ] Commit/push and open a separate draft PR. Codex reviews/merges; no gate
      approval or server work is delegated. If a blocker cannot be resolved
      within this scope, return the smallest reproducible failure and evidence
      for Codex to fix directly.

Current base reminder (2026-11-03): start from fresh synchronized main including
accepted PR #6 and PR #7, not an earlier local checkpoint. Task 16 and its server
scope remain Codex-owned. Do not duplicate the completed maintenance/health fixes
or alter their stopped scopes while preparing your separate assignment.
