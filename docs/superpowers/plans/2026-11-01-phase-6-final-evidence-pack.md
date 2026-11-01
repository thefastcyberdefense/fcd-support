# Phase 6 Final Evidence Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> task by task in an isolated branch. This assignment is documentation only.

**Goal:** Complete Task 15's remaining operator-guide and acceptance-evidence
consolidation so Codex can make the independent P6-GATE decision.

**Architecture:** Reconcile existing code, exact-source checks and bounded
historical server records into one current evidence index. Keep historical
failures, unresolved actor-loss evidence and pending live integration explicit.
Codex retains trackers, the gate decision and the final Task 16 server handoff.

**Tech Stack:** Markdown, Git-generated provenance, repository validation and
read-only source/test inspection; no new runtime implementation.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md`;
`docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md`, Task 15
Steps 4–6 and Task 16; current `docs/TODO.md` and `docs/PROJECT_CONTEXT.md`.

## Global constraints

- Start only after PR #3 is merged. Fetch main and verify its actual merged
  source and current integration review; do not rely on an abbreviated handoff
  SHA. P6-GATE completion is not an entry dependency for its evidence pack.
- Complete the separately assigned runtime-dependency follow-up or obtain
  Codex's documented disposition before freezing the final source/counts.
- Create `codex/agy-p6-gate-evidence` from synchronized main in the existing AGY
  isolated worktree, preserving any changes. Do not rewrite history or reuse
  the merged PR #3 as an open delivery branch.
- Existing owner approval covers this documentation closeout. No SSH, server,
  Docker/daemon mutation, live provider/model/n8n/Meta, public/tunnel, production
  action, Phase 7 implementation or credentials/customer-data access.
- Do not edit the primary checkout, TODO, PROJECT_CONTEXT, PLAN, action scripts,
  incident records, `phase-6-server-deployment.md` or `phase-6-gate.md`. Codex
  owns their status and action decisions. Do not mark any aggregate gate passed.
- Preserve PostgreSQL authority, tool-free models, FAQ precedence/redaction,
  private Unix admin transport and disabled live execution boundaries.

## Review focus

- A passing test definition is not execution evidence; cite actual lane/revision.
- Unit fakes, real local Docker/PostgreSQL, historical server and pending live
  checks are different evidence classes and must stay distinguishable.
- Counts overlap across lanes; never sum them as distinct test coverage.
- Reboot/actor-loss and uncertain operations stay unresolved; absent actors do
  not authorize SQL settlement, replay, baseline replacement or reconstruction.
- Source-equal deployment evidence is bounded historical evidence, not a fresh
  claim that the server or external integration is healthy now.

## Task 1: Reconcile the current evidence index

**Files:** Modify `docs/testing/phase-6-operations-evidence.md` and, only where
needed for consistency, `docs/testing/phase-6-failure-matrix-gap-map.md`.

- [ ] Read the merged PR #3 integration review, Task 11 closeout, Tasks 12–14
      readiness matrix, failure map and actor-loss incident. Verify every new
      file/title/line/workflow link against the actual source/record.
- [ ] Put current status first. Label the older deployment failures and count
      baselines as historical instead of leaving them as current blockers.
- [ ] Record Git-generated full base/head SHAs, exact commands/lane outcomes,
      counts/skips/durations, immutable workflow links and cleanup evidence.
      Preserve initial failures and later passing reruns distinctly.
- [ ] Map every Task 15 failure area to actual assertions and execution. State
      seeded older-snapshot/provider coverage accurately; keep physical restore
      evidence in its separate real two-cluster/drill record.
- [ ] Keep live Manifest recording-off/provider quality, live n8n, Meta sends,
      full host outage/restart and production checks pending their later gates.

## Task 2: Refresh the operator guides

**Files:** Modify `docs/operations/hardened-runtime.md`,
`docs/operations/backup-and-restore.md`,
`docs/operations/runtime-deployment-safety.md`,
`docs/operations/outbound-worker.md` and
`docs/operations/private-admin-and-model.md` as needed.

- [ ] Match documented commands/inputs to actual owning entrypoints. Describe
      protected literal configuration, numeric file ownership, per-role secret
      mounts, private-key separation and safe stop/worker drain.
- [ ] Explain revision-pinned timers, bounded current-slot catch-up and durable
      PostgreSQL deduplication; do not imply missed-slot replay queues or that
      real host timers were installed merely because native tests passed.
- [ ] Document authenticated backup verification, configurable source-defined
      retention settings, quarterly restore, fresh checkpoint/tombstone gates,
      isolated promotion, recovery hold and compatible rollback limits.
- [ ] Explain socket-only admin, owner-only parent, actual SSH-forward proof
      limits, explicit guarded stale recovery and no runtime TCP publication.
      A client loopback browser forward does not create a server Docker port.
- [ ] Explain private dashboard/journal incident handling and n8n independence.
      External uptime adapters remain deferred; claim no offline notification.
- [ ] Replace stale "not implemented" statements with verified implementation
      scope, while retaining open host-incident and live-integration limitations.

## Task 3: Acceptance and threat-model consistency

**Files:** Modify `docs/testing/acceptance-matrix.md` and
`docs/security/threat-model.md` only for established Phase 6 controls/evidence.

- [ ] Map AC-09 backup/restore, AC-18 route isolation, AC-20 runtime contract,
      AC-21 Manifest privacy/tool isolation, AC-25 limits and AC-26 n8n boundary
      to actual local/fake/native/PostgreSQL/historical server results.
- [ ] Preserve partial/pending status where an acceptance item also needs live
      evidence. Local tool-isolation tests do not prove Manifest recording is
      disabled, and fake n8n tests do not prove an installed live workflow.
- [ ] Update the obsolete Task 11 stale-socket recovery statement using actual
      implementation and separately authorized historical action evidence.
      Preserve the threat model's distinction from a security audit and the
      trusted-host-UID assumption. Propose no new security policy.

## Task 4: Candidate gate pack and delivery

**File:** Create `docs/handoffs/2026-11-01-phase-6-gate-candidate.md`.

- [ ] Provide a checklist for Tasks 1–15 and P6-002 through P6-006, linking each
      required deliverable to its actual evidence. Identify any genuine missing
      requirement candidly; do not invent tests or broaden deferrals to close it.
- [ ] List exactly what remains for Codex's independent gate and Task 16
      consolidated handoff, including the open host incident. Do not write a
      PASS/owner-approval decision or invent server execution.
- [ ] Run `npm run validate:phase0`, forced Markdown formatting on every changed
      document with `--ignore-path .gitignore`, path/citation audit, targeted
      secret-pattern checks and `git diff --check`. Do not repeat runtime or
      infrastructure tests for prose-only changes. Report existing CI by its
      actual source; check automatically triggered workflows before delivery.
- [ ] Commit/push only the listed documentation, open a separate draft PR and
      return full Git-generated SHAs, changed paths, validation results, linked
      workflows, unresolved items and this completed checklist. No main merge.

Self-review: this closes the original plan's documentation/evidence work after
the failure tests. It adds no feature, infrastructure action, policy change or
approval loop. Codex retains the final whole-phase decision and server work.
