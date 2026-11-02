# Antigravity assignment: correct PR #5 evidence and operator instructions

Date: 2026-11-02 (Asia/Dhaka).
Existing approval covers these corrections. Start now; no new design or owner
approval is required. Codex remains responsible for aggregate review and server
actions. Keep PR #5 draft until Codex accepts the corrected result.

## Entry and scope

- [ ] Read `docs/reviews/2026-11-02-pr-5-evidence-review.md`, current AGENTS,
      TODO, PROJECT_CONTEXT and SYNTHETIC_FIXTURE_POLICY.
- [ ] Preserve the isolated worktree and continue
      `codex/agy-p6-gate-evidence`. Fetch/merge current main without rewriting
      history; record full Git-generated base/submission/correction SHAs.
      Original reviewed submission is
      `d821b246bad61ae3a23f923f7a491bbc8fd1964b`.
- [ ] Change only the ten documentation paths already submitted in PR #5,
      plus a results record at
      `docs/handoffs/2026-11-02-antigravity-pr-5-correction-results.md`.
      Do not edit primary checkout, trackers, PLAN, incident/server/action
      records or Codex review/gate decisions. No source, tests, scripts,
      dependencies or infrastructure changes.

## Correction checklist and acceptance criteria

- [ ] Remove the false standalone drain command. Explain the existing owning
      controllers' drain procedure; no invented interface or direct sourcing of
      internal functions. Every example must match actual argument parsing.
- [ ] Use actual `BACKUP_DAILY_RETENTION` / `BACKUP_MONTHLY_RETENTION` inputs,
      their configuration scope and validated retained-slot bounds. No new
      configuration keys, aliases or changed retention policy.
- [ ] Rebuild the checklist from the approved original Task 1–15 mapping.
      Task 12 is timers/maintenance and contributes to P6-004/P6-005. Include
      owning source/test/evidence for every deliverable. Mark remaining review
      and gate work pending, rather than declaring Task 15 complete in advance.
- [ ] Audit every changed/new citation against actual file contents, not just
      existence. Replace nonexistent paths, Dockerfile/Compose names and wrong
      assertion owners. Cite real two-cluster tests by their executed lane.
- [ ] Correct PR #3 final-source workflow IDs to the integration review's
      41320435620/41320435609/41320435615/41320435605. Preserve older runs as
      older-source evidence. Attribute each local count/duration to its actual
      reporting actor and source. Never sum overlapping lanes.
- [ ] Match actual runtime/overlay topology, per-role UID and outbound egress.
      Packaged admin is socket-only. Forward SSH to the configured host socket
      path, distinguish it from the container path, and retain real SSH versus
      synthetic-forward proof limits.
- [ ] Correct deployed-versus-tested dependency claims and alert scopes.
      Preserve historical successful promotion, Task 16's final-source rollout
      and Phase 7 full-host/live-provider checks as distinct obligations.
      Remove nonexistent P7-006 and unapproved promises for live n8n or external
      uptime delivery. Optional integration enablement remains separately
      authorized; it is not a newly invented P6 blocker or P7 deliverable.
- [ ] Mark superseded unfinished-controller/status sections historical without
      deleting failures. Preserve each subsequent passing result and the open
      actor-loss incident; make no SQL settlement or server-readiness inference.
- [ ] Replace local `file:///` links with working repository-relative links.
      Label synchronized-main references as the captured base, not a timeless
      claim that main still has that revision.
- [ ] Cite Codex's completed topology execution from
      `docs/testing/2026-11-02-phase-6-local-topology.md`: exact `bd3a09a`,
      exit 0, 157.32 seconds, 9 allowed/20 denied, ordinary-egress multihomed
      probe and zero scoped leftovers. Do not present it as an AGY run or a
      server deployment. This assignment authorizes no Docker/SSH/live testing.

## Validation and delivery

- [ ] Run `npm run validate:phase0` and `git diff --check`.
- [ ] Force Prettier on **every changed document** with
      `npx prettier --check --ignore-path .gitignore <explicit files>`.
      The submitted candidate, acceptance matrix and evidence index failed
      this command; normal `npm run format:check` did not establish their style.
- [ ] Audit repository-relative links, file/line/assertion citations and full
      commit objects. Run targeted secret-pattern checks without displaying
      sensitive matches. Keep only authored synthetic or sanitized evidence.
- [ ] Report each required correction with a checkbox and exact changed paths,
      validation commands/results and any unresolved condition. Do not rerun
      runtime suites merely for prose changes; distinguish newly triggered
      workflows from historical source evidence.
- [ ] Commit/push the corrections to existing PR #5. Return full correction
      head and check all four workflows on that exact head. No merge or
      P6-GATE approval; Codex independently verifies the corrections.

No SSH, shared-server/Docker mutation, live Manifest/provider/n8n/Meta/tunnel,
production, old-scope recovery or other-project action is authorized here.
