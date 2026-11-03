# Antigravity assignment: Phase 7 evidence readiness

Date: 2026-11-02 (Asia/Dhaka).
Authority: preparation and repository review only. Codex retains Task 16, shared
server operations, external-action decisions and final phase/gate authority.
This can follow the independent topology CI assignment; use a separate branch.

## Goal

Prepare an exact, source-backed checklist for the remaining P7-005 acceptance
work. Existing P7-001 through P7-004 completion is historical, under the narrow
August test-asset exception. It does not establish readiness of the current
Phase 6 private runtime or authorize connecting its workers to those assets.
Do not invent a new phase/task number or reclassify local fakes as live evidence.

## Checklist and acceptance criteria

- [ ] Fetch fresh synchronized main, preserving local work. Use a new isolated
      branch `codex/agy-p7-readiness`; never modify the primary checkout.
- [ ] Read AGENTS, PLAN, TODO, PROJECT_CONTEXT, the fixture policy, acceptance
      matrix, threat model, preflight inventory and current Task 16/incident
      records. Follow their links to actual evidence; verify every cited path.
- [ ] Produce `docs/testing/phase-7-readiness.md`, limited to an evidence matrix:
      each current acceptance item, existing local/native/CI proof, historical
      external proof, missing current live/manual proof, dependency, owner and
      exact operational approval boundary. Use the existing AC and P7 IDs.
- [ ] Distinguish Meta test-number device delivery from signed synthetic public
      probes, Messenger echo ingestion from applied human pause, local provider
      fakes from real sends, and local process restart from full-host outage.
- [ ] Explicitly identify Manifest recording-off attestation, dedicated harness
      `fcd-support`/model `auto`, tool isolation, redaction, network attachment
      and approved configurable provider/fallback/limit policy prerequisites.
- [ ] Identify which P7 checks need real test assets or human actions, which can
      reuse existing automated scripts, and which still lack an execution
      procedure. Recommend the smallest next work package; do not implement it.
- [ ] Keep Task 16 completion, protected old uncertain scopes, open actor-loss
      incidents and privileged timer installation distinct. Do not close any
      tracker/gate row or claim owner approval.
- [ ] No SSH, browser/account login, shared Docker, external API, DNS/tunnel,
      Meta, Manifest/n8n/model/provider calls, credentials or production actions.
      No customer-derived fixture or unrestricted diagnostic artifact.
- [ ] No application, dependency, policy, runtime, tracker or incident edits.
      This assignment changes only the readiness document and a factual results
      record at `docs/handoffs/2026-11-02-antigravity-phase-7-readiness-results.md`.
- [ ] Force Markdown formatting, run `npm run validate:phase0`, `git diff --check`,
      relative-link/citation checks and a targeted secret-pattern scan. Report
      exact base/head and checks; no need to rerun expensive unchanged suites.
- [ ] Commit/push and open a separate draft PR for Codex review. Report any
      unresolved ambiguity precisely. No server or gate authority is delegated.

The topology CI assignment remains separate in
`2026-11-02-antigravity-topology-ci.md`. Keep the two branches independently
reviewable and start each from current main to include the maintenance fixture
correction accepted through PR #6.

Current base reminder (2026-11-03): start from fresh synchronized main including
accepted PR #6 and PR #7, not an earlier local checkpoint. Task 16 and its server
scope remain Codex-owned. Do not duplicate the completed maintenance/health fixes
or alter their stopped scopes while preparing your separate assignment.
