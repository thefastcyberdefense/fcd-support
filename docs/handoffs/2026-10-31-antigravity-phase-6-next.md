# Antigravity: precise Phase 6 failure-matrix closeout

Read `docs/superpowers/plans/2026-10-31-phase-6-task-15-focused-closeout.md` and
fresh main's AGENTS, TODO, PROJECT_CONTEXT and SYNTHETIC_FIXTURE_POLICY first.
This supersedes the previous list of three broadly described missing tests.

PR #2 is merged as `67a4a4bede6d3252dc936a6e410f4b90c1359ac3`. Codex synchronized
your clean `codex/agy-p6-failure-matrix` branch at
`ac6e7c07fd7362b947ff0da6575b95be0d79a52c`; its application tree equals reviewed
main and only your gap-map document differs. The runtime branch is historical;
continue in `J:\DevDrive\fcd-support-agy-failure-matrix`.

**Entry gate is satisfied:** Codex recorded Task 11 COMPLETE for the bounded
successful source/drill in `docs/reviews/2026-10-31-phase-6-task-11-closeout.md`.
Fetch/merge the latest main before implementation. Tasks 12–14's local contracts
are included in the passing exact-source gates; audit their citations during
Task 15. P6-004 is still IN PROGRESS because its mapping includes Task 15; do
not require its aggregate completion first. A later host incident is
open and does not block these isolated local tests. Do not touch that host.

Start now in the existing clean isolated matrix worktree after verifying its
state. If it has your uncommitted work, preserve it and report before attempting
an integration. No force push or primary-checkout changes. The existing owner
approval covers this scope; no new routine owner approval is required.

## Checklist and acceptance

- [ ] Correct gap-map citations and distinguish actual assertions from planned
      tests and pending server/live evidence. FAQ bypass is not provider outage.
- [ ] Add real EROFS/read-only destination coverage with a writable success
      control, no false archive publication, existing valid archive preservation
      and exact new-partial cleanup. Existing native ENOSPC test already exists.
- [ ] Prove actual restored outbox/recovery-held work makes zero provider sends,
      including a snapshot that can predate acceptance. Use real PostgreSQL and
      a captured fake-client call count, plus an eligible send-once control.
      No provider lookup/resend resolver or journal/hold clearing.
- [ ] Prove real Unix flock non-overlap with deterministic two-process barriers:
      second activation refuses, later activation can run after release and the
      current slot remains deduplicated. Preserve existing nonblocking policy.
- [ ] Genuine defects require RED then minimal GREEN; already-correct behavior
      is coverage-only and must not receive fabricated RED claims.
- [ ] Check whether CI executes the five hermetic operator-helper test files.
      If missing, add an explicit read-only CI step for those test files only
      (observer, reboot recovery, peer recovery, rollback-only and current
      runtime recovery). Never execute their action drivers or SSH/Docker flags.
      Preserve workflow token permissions and existing lanes. Report per-file
      counts/platform skips; overlapping suites are not distinct-test totals.
- [ ] Run all verification and scoped cleanup from the linked plan. Deliver a
      separate draft PR with full SHAs and all four exact-source workflows.
- [ ] Write `docs/handoffs/2026-10-30-antigravity-phase-6-closeout-results.md`
      with exact commands, counts/skips/durations, RED/GREEN or coverage-only,
      CI links, cleanup, remaining gaps and a completed checklist.

Codex owns server runs, tracker/context/action files, integration and independent
P6-GATE review. Keep every old uncertain scope intact. No SSH, live provider,
external service, tunnel, Meta, production or Phase 7 work is assigned.
