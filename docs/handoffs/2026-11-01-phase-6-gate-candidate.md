# Phase 6 Candidate Gate Pack and Handoff

Date: 2026-11-02 (Asia/Dhaka).
Author: Antigravity (AGY).
Worktree: `J:\DevDrive\fcd-support-agy-failure-matrix`.
Branch: `codex/agy-p6-gate-evidence`.
Base Revisions: Evaluated against `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`; review fixes merged from `4aaddbcaf19eea76935c49ed0e3f9bbfac2cac0d`.
Primary Checkout Untouched: `J:\DevDrive\fcd-support` on `main`.

Current status: **Candidate gate pack prepared for Codex review. Task 15 review, P6-004/005/006, P6-GATE, and Task 16 remain OPEN.**
This pack provides verified evidence citations, contract alignment, operator guides, and acceptance mappings. It does not declare P6-GATE passed, authorize server changes, or replace Codex's authoritative gate review.

---

## 1. Executive Summary & Provenance

This document consolidates candidate evidence for Phase 6 (Tasks 1–15 and deliverables P6-002 through P6-006) following the integration of PR #3 (`df8e52dbe59e0013ab28a5790b21c9785324b2f0`, tested source `78013148751a493a6f8859bc6d3ee9628cb954d6`) and PR #4 (`c74b6f4314e17fe707ba5e3f02a183d1ebe9b9fd`, tested source `9f76455be443a527ce58725fa574e7324631fd4d`).

### Provenance Chain

1. **Captured Base Commits:** Originally submitted against base `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`; review corrections merged from `4aaddbcaf19eea76935c49ed0e3f9bbfac2cac0d`.
2. **PR #3 Integration (`df8e52d`):** Operational failure matrix and recovery harness closeout (Task 15). Added failure assertions for read-only filesystem (`EROFS`), full storage (`ENOSPC`), corrupt ciphertexts, expired tombstones, and migration failure; added test child wait timeout guards and isolated root fixture containment.
3. **PR #4 Integration (`c74b6f4`):** Dependency follow-up. Scoped, pinned overrides under `node-pg-migrate` for `glob@14.0.3` and `minimatch@11.0.3` (resolving CVE-2026-118773 and CVE-2026-118764).
4. **Supply Chain Audit:** `npm audit --omit=dev` confirms **0 production vulnerabilities** in the accepted source tree (last recorded server deployment is historical `67a4a4b`; deploying updated dependencies to the test server is assigned to Task 16). GitHub Dependabot alert #42 is observed fixed in runtime; alert #43 remains open in development-only tooling.
5. **Primary Checkout Protection:** `J:\DevDrive\fcd-support` remains clean on `main`. All documentation edits reside in isolated branch `codex/agy-p6-gate-evidence` within `J:\DevDrive\fcd-support-agy-failure-matrix`.

---

## 2. Evidence Class Boundaries

To avoid ambiguity, candidate evidence is partitioned into four distinct classes:

- **Class A (Local & Synthetic Units/Integrations):** Authored test suites running with synthetic mocks, fakes, and isolated PostgreSQL databases (`VITEST_MAX_WORKERS=4 npm run check`). 1,952 passed, 438 platform skips across 131 files on tested source `9f76455` (AGY run 238.05s; Codex independent run 261.62s on `9f76455`; the separate PR #3 run on `7801314` took 259.95s).
- **Class B (Native Linux & PostgreSQL Lanes):** Verified on Linux runners with native capabilities (file permissions, Unix sockets, memory-backed scratch, loopback TCP forwarding). Linux unit lane: 2,020 passed / 370 skips in 80.11s; Native operations: 1,298 passed in 489.37s; Full PostgreSQL: 621 passed / 52 skips in 97.78s; Grants: 139 passed / 1 skip in 58.35s; Restore units: 252 passed in 62.08s; Two-cluster PostgreSQL restore integration: 47 passed in 25.72s. Full local topology execution on `bd3a09a` passed in 157.32s with 9 allowed / 20 denied paths (`docs/testing/2026-11-02-phase-6-local-topology.md`).
- **Class C (Bounded Historical Server Drills):** Server actions executed on the isolated test project under specific prior commits (e.g., application `67a4a4b` under committed `3f22344`; stale socket drill `4c51898` / `d96382d`). These demonstrate controller mechanics and safety guards under real Docker, but do **not** claim the live server is currently updated, healthy, or deployed at `bd3a09a` or `4aaddbc`.
- **Class D (Deferred Live Integrations):** Explicitly deferred to Phase 7 and Phase 8. Includes live Manifest recording-off attestation, real Manifest network attachment, live Meta WhatsApp/Messenger sends, full host power-loss drills, and production WhatsApp coexistence. Optional live n8n workflow connection is subject to separate authorization (P8-005).

---

## 3. Checklist: Tasks 1–15 & P6-002 Through P6-006

| Scope ID                                 | Description                                                                            | Status                          | Evidence Citations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| :--------------------------------------- | :------------------------------------------------------------------------------------- | :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tasks 1–8** / **P6-002**               | Pinned, non-root, read-only-compatible container images & Compose services             | **COMPLETE (Candidate)**        | `Dockerfile`, `infra/Dockerfile.operations`, `infra/Dockerfile.postgres`; `infra/compose.runtime.yml`, `infra/compose.operations.yml`, `infra/compose.model.yml`, `infra/compose.restore.yml`; non-root UID 1000:1000 (app/ops), UID 999:999 (postgres); `read_only: true`; `cap_drop: [ALL]`; `no-new-privileges: true`; `tests/deployment-contract.test.ts`.                                                                                                                                                                                                                                                              |
| **Tasks 1–8** / **P6-003**               | Least-privilege ingress, data, and model network attachments                           | **COMPLETE (Candidate)**        | Dedicated internal bridges (`webhook_data`, `admin_data`, `reply_data`, `outbound_data`, `notification_data`, `operations_data`) plus `ingress`, `provider_egress`, `notification`, and the separately enabled `model` overlay; no published host ports; socket-only admin (`${FCD_ADMIN_SOCKET_ROOT}/admin.sock`, container mount `/run/fcd-support-admin/admin.sock`, mode `0600`, parent mode `0700`); SSH loopback forward proof; 9 allowed / 20 denied probes in full topology execution (`docs/testing/2026-11-02-phase-6-local-topology.md`), `tests/admin-socket.test.ts` and `scripts/verify-network-contract.sh`. |
| **Tasks 9–10** / **P6-004 (part 1)**     | Encrypted backup creation, verification, retention pruning                             | **COMPLETE (Candidate)**        | `src/operations/backup.ts`; age encryption with public recipient; verification via separate private key; catalog-only role; validated operations retention settings `BACKUP_DAILY_RETENTION` (45–3650 slots) and `BACKUP_MONTHLY_RETENTION` (6–120 slots) in `common.env`; `tests/backup.test.ts`, `tests/backup-retention.test.ts`, `tests/integration/postgres-encrypted-backup.test.ts`.                                                                                                                                                                                                                                 |
| **Task 11** / **P6-004 (part 2)**        | Isolated split-capability restore, bound migration, deletion reconciliation, promotion | **COMPLETE (Candidate)**        | `scripts/restore-runtime.sh`; `scripts/promote-restore.sh`; `scripts/rollback-runtime.sh`; split capabilities (stream, migrate, reconcile); target-only bridge; signed deletion checkpoint reconciliation (`tests/deletion-checkpoint.test.ts`); two-cluster restore integration (`tests/integration/postgres-isolated-restore.test.ts` via `scripts/test-encrypted-backup.sh restore`); safe switching & rollback limits in `docs/operations/backup-and-restore.md`.                                                                                                                                                       |
| **Task 12** / **P6-004, P6-005**         | Revision-pinned host timers & scheduled maintenance                                    | **COMPLETE (Local Validation)** | `scripts/run-operation.sh`; `scripts/render-systemd-units.sh`; `infra/systemd/` (`fcd-support-operation@.service`, `fcd-support-backup.timer.in`, `fcd-support-maintenance.timer.in`, `fcd-support-health.timer.in`); `tests/systemd-contract.test.ts`; `tests/operations-scheduled-job.test.ts`; `deployment.lock` nonblocking flock, bounded current-slot catch-up, and catalog slot deduplication. Real host installation deferred to Task 16.                                                                                                                                                                           |
| **Task 13** / **P6-005**                 | Private health collection & operations dashboard                                       | **COMPLETE (Candidate)**        | `src/operations/health-collector.ts`; `src/admin/operations-html.ts`; `src/admin/operations-routes.ts`; `src/persistence/postgres-admin-operations.ts`; `tests/health-collector.test.ts`; `tests/health-main.test.ts`; `tests/admin-operations.test.ts`; `tests/integration/postgres-admin-operations.test.ts`; `tests/operations-health-host.test.ts`. Admin socket transport (`src/admin/admin-socket.ts`, `tests/admin-socket.test.ts`), MFA, session revocation, CSRF, signed actions.                                                                                                                                  |
| **Task 14** / **P6-006**                 | Authenticated private n8n notification client & queue flow                             | **COMPLETE (Candidate)**        | `src/notifications/n8n-client.ts`; `src/notifications/notification-worker.ts`; `src/operations/notification-runtime.ts`; `tests/n8n-client.test.ts`; `tests/notification-worker.test.ts`; `tests/integration/postgres-notification-flow.test.ts`; `tests/integration/postgres-notification-privacy-grants.test.ts`. HMAC verification, payload minimization, transaction-bound deletion cancellation, database authority during outage.                                                                                                                                                                                     |
| **Task 15** / **P6-004, P6-005, P6-006** | Operational failure matrix, recovery harness & gate evidence pack                      | **IN PROGRESS (Review)**        | PR #3 (`df8e52d` on tested source `7801314`): read-only root failure (`EROFS`), full storage (`ENOSPC`), corrupt ciphertext, expired tombstones, migration failure, child wait timeout protection, isolated root fixture containment. PR #4 (`c74b6f4` on tested source `9f76455`): scoped runtime dependency overrides, clean production audit. Local topology execution on `bd3a09a` (9 allowed / 20 denied in 157.32s). Review corrections and gate pack in progress.                                                                                                                                                    |
| **P6-GATE**                              | Review Phase 6 evidence                                                                | **OPEN**                        | Retained under Codex authority and project owner approval boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Task 16**                              | Phase 6 server deployment & consolidated handoff                                       | **OPEN**                        | Retained under Codex authority following P6-GATE review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 4. Candid Disclosure of Gaps & Pending Items

The following items are candidly acknowledged as outside Phase 6 local/CI completion and must remain strictly deferred or unresolved:

1. **2026-10-31 Server Reboot / Actor-Loss Incident:**
   - On the test server, a host reboot resulted in an unmanaged stopped-actor state.
   - All volumes, journals, and selection records remain preserved under uncertainty rules.
   - This incident remains open for separate review; no automated cleanup or state settlement has been performed.
2. **Phase 7 Deferred Scope (P7-005):**
   - **Live Manifest Recording-Off:** Local tests enforce tool-free `auto` requests, redaction, and timeouts against local client fakes. Live Manifest recording-off attestation requires Phase 7 inspection of the running Manifest service.
   - **Real Network Attachments:** Live attachment of the model worker to the private Manifest network remains Phase 7 test-asset work. Optional private n8n attachment requires separate authorization and is not assigned to Phase 7.
   - **External Uptime Alerts:** Dashboard and journal incident handling are implemented locally. Direct external uptime adapters remain deferred to a future separately approved version; no delivery phase is assigned. Staff must maintain manual Meta Business Suite coverage.
   - **Full Host Outage / Power-Loss Drill:** Synthetic restart idempotency passes locally, but physical host pull-plug / reboot drills remain P7.
3. **Phase 8 Deferred Scope (P8-002, P8-003, P8-004, P8-005):**
   - Meta live app review and WhatsApp coexistence checks remain strictly blocked until Phase 8. The production WhatsApp Business account remains completely untouched and isolated.
   - Optional live n8n workflow connection is subject to separate operational responsibility and authorization under P8-005.

---

## 5. Primary Evidence Documents

The following documents in the repository comprise the Phase 6 evidence pack:

- [Phase 6 Operations Evidence Index](../testing/phase-6-operations-evidence.md)
- [Phase 6 Failure Matrix Gap Map](../testing/phase-6-failure-matrix-gap-map.md)
- [Acceptance Matrix](../testing/acceptance-matrix.md)
- [Security Threat Model](../security/threat-model.md)
- [Hardened Runtime Operator Guide](../operations/hardened-runtime.md)
- [Backup and Restore Operator Guide](../operations/backup-and-restore.md)
- [Runtime Deployment Safety Guide](../operations/runtime-deployment-safety.md)
- [Outbound Worker Contract](../operations/outbound-worker.md)
- [Private Admin and Model Guide](../operations/private-admin-and-model.md)
- [Phase 6 Local Topology Execution](../testing/2026-11-02-phase-6-local-topology.md)

---

## 6. Action Items Remaining for Codex

1. **Independent Evidence Review:** Verify that all citations, SHAs, counts, and claims in this corrected evidence pack match actual repository and CI history.
2. **P6-GATE Assessment:** Evaluate whether Tasks 1–15 and P6-002 through P6-006 satisfy the exit criteria for Phase 6.
3. **Host Incident Disposition:** Formulate the resolution plan for the 2026-10-31 host reboot / actor-loss incident on the test server.
4. **Task 16 Execution:** Execute server deployment of the updated dependency source, verify runtime health, and provide final handoff to the project owner.
