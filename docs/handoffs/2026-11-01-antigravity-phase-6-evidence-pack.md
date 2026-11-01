# Antigravity next assignment: Phase 6 final evidence pack

Sequence update: first complete the dependency follow-up in
`docs/handoffs/2026-11-01-antigravity-dependency-followup.md`. Prepare this final
pack after Codex accepts that fix or a documented disposition, so its evidence
describes the reviewed dependency chain.

Start after Codex merges PR #3. Fetch synchronized main, preserve local work and
create `codex/agy-p6-gate-evidence` from that main in the existing isolated AGY
worktree. Read fresh AGENTS, TODO, PROJECT_CONTEXT, SYNTHETIC_FIXTURE_POLICY,
the PR #3 integration review and:

`docs/superpowers/plans/2026-11-01-phase-6-final-evidence-pack.md`.

This is Task 15's remaining documentation closeout under existing approval,
not Phase 7 implementation. Do not wait for P6-GATE to pass before preparing
its evidence. Use the linked plan's exact file scope and acceptance criteria.

- [ ] Current evidence index with verified citations, full Git-generated SHAs,
      exact-source lane counts/skips/durations/links and cleanup; historical
      failures and overlapping counts labeled accurately.
- [ ] Current operator guides for protected inputs, safe stop/drain, timers,
      backup/verification/restore/checkpoints, holds, rollback and Unix admin.
- [ ] AC-09/18/20/21/25/26 and threat-model consistency; keep live recording-off,
      providers/Meta/n8n/full-host checks explicitly pending their later gates.
- [ ] Candidate checklist for Tasks 1–15/P6-002 through P6-006, genuine gaps and
      exact remaining Codex gate/Task 16 work, without claiming gate approval.
- [ ] Documentation validation, separate draft PR and concise results with full
      verified provenance. Do not rerun infrastructure for prose-only changes.

No source/tests/scripts, primary checkout/trackers/PLAN, action/incident/server
records or final gate-decision edits. No SSH, Docker mutation, other-project,
live provider, tunnel, Meta, production or recovery-policy action. Codex owns
merge, aggregate approval and the final server handoff. No new routine owner
approval is required for this assignment.
