# AGY: PR 23 Runbook Review Corrections

Date: 2026-11-14 (Asia/Dhaka).

Keep PR #23 draft on `codex/agy-phase-7-current-runbook`, preserve its isolated
worktree, fetch fresh main and integrate Codex's review files without deleting
main evidence. Record exact base and final SHAs. Submitted docs head is
`0060fc89e23c1c23cda2983355d2fec70d7b8e07`.

Read the [original handoff](2026-11-11-antigravity-phase-7-runbook.md) and
[authoritative review](../reviews/2026-11-14-pr-22-23-review.md). Keep scope to
the two submitted Markdown deliverables and the PR description. No executable
implementation, new product feature, tracker closure or external action.

## Checklist and acceptance criteria

- [ ] Audit every purported verified command against its actual parser. Replace
      nonexistent `deploy-runtime.sh --inspect` with the Python helper provenance.
      Supply maintenance runRef/ISO parameters and correct prune/backup forms;
      distinguish the separate health entrypoint. Give complete SSH destinations
      and listener ownership/forward-failure checks. Do not execute operations to
      test syntax; use source or pure parsers only.
- [ ] State that `admin:bootstrap` creates the first administrator in an empty
      database. Treat additional accounts/role assignment as separately approved
      private provisioning/tooling prerequisites, rather than an existing role
      bootstrap feature. Do not implement or approve staff lifecycle UI.
- [ ] Replace `knowledge_versions.state='published'` with actual approved state
      plus effective append-only publication evidence. Source-check all other
      table/column/state and role/action claims, including policy activation.
- [ ] Split safe redaction from blocked inputs using existing authored fixture
      cases. A redacted unambiguous question may reach Manifest; blocked inputs
      must not. Preserve zero original sensitive content, FAQ precedence, zero
      tools, dedicated fcd-support/auto contract and safe escalation. State the
      five true Manifest attestations separately from `MANIFEST_MODEL=auto`.
- [ ] Correct restore ordering: archive containing synthetic data, subsequent
      verified deletion, newer authenticated checkpoint, older isolated restore,
      proof of erased content under all required active key versions and retained
      recovery hold/quarantined inherited work. Include zero inherited send
      expectations and precise abort/rollback authority; do not treat an archive
      already lacking the deleted content as resurrection proof.
- [ ] Add a complete AC-01–AC-36 mapping: procedure and minimum proof, current
      local regression reference, explicitly later-phase boundary, or honest
      BLOCKED tooling gap. Include actual Manifest-managed provider failover/order
      versus Meta send failures; send-time eligibility races; complete consent
      grant/revoke/missing/cross-scope behavior; retention boundaries; access
      minimization/correction; overlapping holds; privacy concurrency/timeout/
      rollback; and corpus/independent human scoring/approved bilingual threshold.
      Do not invent new thresholds, provider policy, commands or live proof.
- [ ] Keep missing tooling explicit. An enabled model/outbound profile needs a
      separately reviewed execution/verification plan: the existing private-
      disabled lifecycle validator requires false flags. Do not claim that a
      true-flags Compose overlay is already verified by that controller.
- [ ] Distinguish new-target pending-job admission from preservation of the old
      held journal. Do not imply the old scope must be replayed, cleared or settled
      before an independent successor can proceed. Date historical service and
      container-count observations; do not present them as fresh host guarantees.
- [ ] Link the primary Meta version table. Existing v25.0/v26.0 dates were verified
      correct; keep v25.0 and defer any upgrade decision. Correct the companion
      results record and PR body alongside the runbook, including claims of
      complete coverage and verification.
- [ ] Force-format both files explicitly with
      `npx prettier --write --ignore-path .gitignore <explicit files>`, then verify
      the same explicit list. Root's forced check fails both submitted files even
      though repository format:check passes. Verify every local link AND the
      semantic accuracy of its source citation, plus Phase 0, heuristic fixture/
      secret, whitespace and applicable PR-handoff checks. Do not rerun unrelated
      full Windows suites just for docs; attribute existing runs honestly.
- [ ] Submit exact final SHA, changed-file list, validation results and immutable
      final-head CI links. Leave both PRs draft, all launch gates open/blocked as
      tracked, TODO/PROJECT_CONTEXT and main untouched. Codex owns acceptance.

No SSH, Docker daemon, server/systemd, tunnel/DNS, Meta, Manifest, n8n, account,
credential or external-message action. All T-01–T-11 live steps remain unexecuted.
The required deliverable is an accurate runbook with clear blocked branches,
not implementation of its identified gaps or a new production approval.
