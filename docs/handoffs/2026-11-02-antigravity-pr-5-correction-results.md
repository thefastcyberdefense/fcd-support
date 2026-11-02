# PR #5 Review Corrections Results

Date: 2026-11-02 (Asia/Dhaka).
Author: Antigravity (AGY).
Worktree: `J:\DevDrive\fcd-support-agy-failure-matrix`.
Branch: `codex/agy-p6-gate-evidence`.
Base Revision: `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`.
Merged Current Main: `4aaddbcaf19eea76935c49ed0e3f9bbfac2cac0d`.
Reviewed Submission Head: `d821b246bad61ae3a23f923f7a491bbc8fd1964b`.
Primary Checkout Untouched: `J:\DevDrive\fcd-support` on `main` at `4aaddbcaf19eea76935c49ed0e3f9bbfac2cac0d`.

Current status: **Corrections implemented for PR #5; PR #5 kept draft.**
All ten submitted documentation files plus this results record have been corrected in accordance with `docs/reviews/2026-11-02-pr-5-evidence-review.md` and `docs/handoffs/2026-11-02-antigravity-pr-5-review-fixes.md`. Task 15 review, aggregate P6-004/005/006, P6-GATE, and Task 16 server deployment remain OPEN.

---

## 1. Corrections Checklist and Resolution Mapping

- [x] **Correction 1: Controlled drain procedure vs standalone command**
  - Removed false standalone `bash scripts/operations-drain.sh` invocation from `docs/operations/hardened-runtime.md`. Public commands remain `deploy-runtime.sh`, `verify-runtime.sh`, and `rollback-runtime.sh`.
  - Documented that controlled drain is an internal lifecycle procedure performed by owning controllers (sourcing `scripts/operations-drain.sh`) to verify and drain only expected actors before teardown.
  - Updated `docs/operations/outbound-worker.md` to describe the internal controlled drain rather than presenting it as an operator CLI command.

- [x] **Correction 2: Real operations retention configuration keys and bounds**
  - Replaced invented `FCD_BACKUP_RETAIN_DAYS` / `FCD_BACKUP_RETAIN_MONTHS` with actual validated operations configuration inputs: `BACKUP_DAILY_RETENTION` (bounds 45–3650 slots) and `BACKUP_MONTHLY_RETENTION` (bounds 6–120 slots) in `common.env` (validated in `src/operations/operations-config.ts:46`).
  - Updated `docs/operations/backup-and-restore.md` and `docs/handoffs/2026-11-01-phase-6-gate-candidate.md`.

- [x] **Correction 3: Canonical Task 1–15 checklist mapping**
  - Rebuilt the candidate checklist in `docs/handoffs/2026-11-01-phase-6-gate-candidate.md` to reflect original plan definitions:
    - Task 12 is **Revision-pinned host timers & scheduled maintenance** (`scripts/run-operation.sh`, `scripts/render-systemd-units.sh`, `infra/systemd/`, `tests/systemd-contract.test.ts`), contributing to P6-004 and P6-005. Real host timer installation is deferred to Task 16.
    - Task 13 is **Private health collection & operations dashboard** (`src/operations/health-collector.ts`, `src/admin/operations-html.ts`, `src/admin/operations-routes.ts`, `tests/health-collector.test.ts`, `tests/admin-operations.test.ts`).
    - Task 14 is **Authenticated private n8n notification client & queue flow** (`src/notifications/n8n-client.ts`, `tests/n8n-client.test.ts`, `tests/integration/postgres-notification-flow.test.ts`).
    - Task 15 is **Operational failure matrix, recovery harness & gate evidence pack** (marked IN PROGRESS / Review).

- [x] **Correction 4: Accurate citations, assertion owners, and exact-source provenance**
  - Replaced nonexistent Dockerfile and Compose references in candidate pack with real names: `Dockerfile`, `infra/Dockerfile.operations`, `infra/Dockerfile.postgres`, `infra/compose.runtime.yml`, `infra/compose.operations.yml`, `infra/compose.model.yml`, `infra/compose.restore.yml`.
  - Replaced nonexistent `tests/operations-backup.test.ts` with real backup test files (`tests/backup.test.ts`, `tests/backup-retention.test.ts`, `tests/integration/postgres-encrypted-backup.test.ts`).
  - Replaced nonexistent `tests/operations-health.test.ts` with real health test files (`tests/health-collector.test.ts`, `tests/health-main.test.ts`, `tests/integration/postgres-health-role.test.ts`, `tests/operations-health-host.test.ts`).
  - Corrected n8n client location to `src/notifications/n8n-client.ts` (not `src/operations/`).
  - Replaced nonexistent `tests/integration/two-cluster-restore.test.ts` in AC-09, evidence index, and candidate pack with real two-cluster restore integration suite: `tests/integration/postgres-isolated-restore.test.ts` executed via `bash scripts/test-encrypted-backup.sh restore`.
  - Replaced nonexistent `tests/sensitive-data.test.ts` in evidence index with `tests/sensitive-data-gate.test.ts`.
  - Corrected PR #3 final-source workflows on head `7801314` to 41320435620 (CI), 41320435609 (CodeQL), 41320435615 (PostgreSQL/native), and 41320435605 (private runtime). Labeled earlier runs (41294398628/etc.) as older PR #3 iterations.
  - Attributed AGY's reported Windows run (238.05 s) separately from Codex's independent Windows verification (261.62 s on `9f76455`; the separate PR #3 verification on `7801314` took 259.95 s).

- [x] **Correction 5: Implemented topology, ownership, and Unix socket admin**
  - Updated `docs/operations/outbound-worker.md` to specify dedicated internal bridge `outbound_data` and ordinary NAT `provider_egress` (`infra/compose.runtime.yml:248`). Noted that worker container runs as non-root UID 1000:1000 while PostgreSQL uses UID 999:999.
  - Corrected `docs/operations/private-admin-and-model.md` to remove obsolete TCP/management-network text; packaged admin is strictly Unix-only.
  - Specified SSH loopback forward destination as the configured host socket `${FCD_ADMIN_SOCKET_ROOT}/admin.sock` (container mount `/run/fcd-support-admin/admin.sock`), retaining real SSH vs synthetic loopback forward proof distinctions in `hardened-runtime.md` and `private-admin-and-model.md`.

- [x] **Correction 6: Execution and phase boundary discipline**
  - Corrected dependency audit claim: clean audit (`npm audit --omit=dev`) applies to the accepted runtime source tree, not the currently deployed server (last recorded deployed application is historical `67a4a4b`; deploying updated dependencies to the test server is assigned to Task 16).
  - Clarified Dependabot alerts: #42 closed in runtime; #43 open in dev-only tooling.
  - In AC-09, clearly distinguished successful historical promotion (`67a4a4b`, `3f22344`), Task 16 final-source rollout, and Phase 7 full-host restart evidence.
  - Removed nonexistent P7-006 references. Clarified that live Manifest recording-off attestation, real Manifest network attachment, full-host outage/restart drills, and live Meta test-number sends are in Phase 7 (P7-005). Clarified that optional live n8n workflow connection is subject to separate operational responsibility (P8-005), not a newly invented P6 blocker.

- [x] **Correction 7: Superseded checkpoints marked historical & repository-relative links**
  - Marked superseded prerequisite notes in `docs/operations/runtime-deployment-safety.md` (lines 1181, 1240, 1274, 1303) as historical prerequisite notes while preserving original failure and passing evidence.
  - Replaced machine-specific `file:///` URLs with working repository-relative paths across all documentation.
  - Labeled base revision references as captured base `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a` with review corrections merged from `4aaddbcaf19eea76935c49ed0e3f9bbfac2cac0d`.
  - Cited Codex's completed local topology execution from `docs/testing/2026-11-02-phase-6-local-topology.md`: exact `bd3a09a`, exit 0, 157.32 seconds, 9 allowed / 20 denied paths (including multihomed ordinary-egress probe on ingress and `tunnel_egress`), zero test-owned Docker leftovers.

---

## 2. Changed Files Summary

Only the ten previously submitted documentation files plus this results record were modified:

1. `docs/operations/hardened-runtime.md`
2. `docs/operations/backup-and-restore.md`
3. `docs/operations/outbound-worker.md`
4. `docs/operations/private-admin-and-model.md`
5. `docs/operations/runtime-deployment-safety.md`
6. `docs/security/threat-model.md`
7. `docs/testing/acceptance-matrix.md`
8. `docs/testing/phase-6-operations-evidence.md`
9. `docs/testing/phase-6-failure-matrix-gap-map.md`
10. `docs/handoffs/2026-11-01-phase-6-gate-candidate.md`
11. `docs/handoffs/2026-11-02-antigravity-pr-5-correction-results.md` (new file)

Primary checkout `J:\DevDrive\fcd-support` remains untouched on `main`. Trackers, PLAN, code, tests, scripts, and server deployment state are untouched.

## 3. Codex direct correction and independent verification

AGY correction submission: `b6d3df04f23e139c9cda1b31f58c88ecd0a539f1`.
Its four workflows passed: [CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41442449627),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41442449838),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41442449465),
[private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41442449810).
Codex verified the following remaining issues and corrected them directly in
this branch, without another AGY handoff:

- [x] Attribute 261.62 seconds to the PR #4 source `9f76455`; keep PR #3
      source `7801314` and its 259.95-second run separate.
- [x] Repair all ten candidate Markdown links relative to `docs/handoffs`.
- [x] Remove residual Phase 7 promises for optional n8n or external uptime
      adapters; retain separately authorized enablement and the approved
      deferred external-adapter scope.
- [x] Correct Task 15's pending review, captured-base wording, AC-09's rollout
      versus host-restart distinction, alert scope and historical controller
      wiring versus fresh per-invocation safety requirements.
- [x] Re-run `npm run validate:phase0`, forced Prettier on all eleven changed
      documents with `--ignore-path .gitignore`, and `git diff --check`: pass.

These follow-up edits affect prose only. The complete implementation tree
still equals accepted `9f76455` and topology-tested `bd3a09a`. New automatically
triggered workflow results belong to their actual follow-up head; the links
above establish the earlier `b6d3df0` submission only. Codex records the final
accepted head, integration result and aggregate decision separately.
