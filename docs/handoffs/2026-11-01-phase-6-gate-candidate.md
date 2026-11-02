# Phase 6 Candidate Gate Pack and Handoff

Date: 2026-11-02 (Asia/Dhaka).
Author: Antigravity (AGY).
Worktree: `J:\DevDrive\fcd-support-agy-failure-matrix`.
Branch: `codex/agy-p6-gate-evidence`.
Base Revision: `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`.
Primary Checkout Untouched: `J:\DevDrive\fcd-support` on `main` at `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`.

Current status: **Candidate gate pack prepared for Codex review. P6-GATE and Task 16 remain OPEN.**
This pack provides verified evidence citations, contract alignment, operator guides, and acceptance mappings. It does not declare P6-GATE passed, authorize server changes, or replace Codex's authoritative gate review.

---

## 1. Executive Summary & Provenance

This document consolidates candidate evidence for Phase 6 (Tasks 1–15 and deliverables P6-002 through P6-006) following the integration of PR #3 (`df8e52dbe59e0013ab28a5790b21c9785324b2f0`, tested source `78013148751a493a6f8859bc6d3ee9628cb954d6`) and PR #4 (`c74b6f4314e17fe707ba5e3f02a183d1ebe9b9fd`, tested source `9f76455be443a527ce58725fa574e7324631fd4d`).

### Provenance Chain

1. **Base Commit:** `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a` (clean, synchronized with `origin/main`).
2. **PR #3 Integration (`df8e52d`):** Operational failure matrix and recovery harness closeout (Task 15). Added failure assertions for read-only filesystem, corrupt ciphertexts, expired tombstones, and migration failure; added test child wait timeout guards and isolated root fixture containment.
3. **PR #4 Integration (`c74b6f4`):** Dependency follow-up. Scoped, pinned overrides under `node-pg-migrate` for `glob@14.0.3` and `minimatch@11.0.3` (resolving CVE-2026-118773 and CVE-2026-118764).
4. **Supply Chain Audit:** `npm audit --omit=dev` confirms **0 production vulnerabilities** in the deployed runtime tree. Retained development advisories (11 moderate under `eslint@10.8.0` / `@typescript-eslint`) are confined to build tooling.
5. **Primary Checkout Protection:** `J:\DevDrive\fcd-support` remains clean on `main` at `bd3a09a`. All documentation edits reside in isolated branch `codex/agy-p6-gate-evidence` within `J:\DevDrive\fcd-support-agy-failure-matrix`.

---

## 2. Evidence Class Boundaries

To avoid ambiguity, candidate evidence is partitioned into four distinct classes:

- **Class A (Local & Synthetic Units/Integrations):** Authored test suites running with synthetic mocks, fakes, and isolated PostgreSQL databases (`VITEST_MAX_WORKERS=4 npm run check`). 1,952 passed, 438 platform skips across 131 files on tested source `9f76455`.
- **Class B (Native Linux & PostgreSQL Lanes):** Verified on Linux runners with native capabilities (file permissions, Unix sockets, memory-backed scratch, loopback TCP forwarding). Linux unit lane: 2,020 passed / 370 skips in 80.11s; Native operations: 1,298 passed in 489.37s; Full PostgreSQL: 621 passed / 52 skips in 97.78s; Grants: 139 passed / 1 skip in 58.35s; Restore units: 252 passed in 62.08s; Two-cluster PostgreSQL: 47 passed in 25.72s.
- **Class C (Bounded Historical Server Drills):** Server actions executed on the isolated test project under specific prior commits (e.g., application `67a4a4b` under committed `3f22344`; stale socket drill `4c51898` / `d96382d`). These demonstrate controller mechanics and safety guards under real Docker, but do **not** claim the live server is currently updated, healthy, or deployed at `bd3a09a`.
- **Class D (Deferred Live Integrations):** Explicitly deferred to Phase 7 and Phase 8. Includes live Manifest recording-off attestation, real Manifest network attachment, live n8n workflow deployment, live Meta WhatsApp/Messenger sends, external uptime alert delivery, full host power-loss drills, and production WhatsApp coexistence.

---

## 3. Checklist: Tasks 1–15 & P6-002 Through P6-006

| Scope ID | Description | Status | Evidence Citations |
| :--- | :--- | :--- | :--- |
| **Tasks 1–8** / **P6-002** | Pinned, non-root, read-only-compatible container images & Compose services | **COMPLETE (Candidate)** | Dockerfiles (`app.Dockerfile`, `operations.Dockerfile`, `postgres.Dockerfile`); `docker-compose.yml`; UID 1000:1000; `read_only: true`; `cap_drop: [ALL]`; `no-new-privileges: true`; `tests/deployment-contract.test.ts`. |
| **Tasks 1–8** / **P6-003** | Least-privilege ingress, data, and model network attachments | **COMPLETE (Candidate)** | `docker-compose.yml`; 8 dedicated bridges; no published host ports; socket-only admin (`/run/fcd-support-admin/admin.sock`, mode `0600`, parent mode `0700`); SSH loopback forward proof; 9 allowed / 20 denied probes in `tests/admin-socket.test.ts` and `scripts/verify-network-contract.sh`. |
| **Tasks 9–10** / **P6-004 (part 1)** | Encrypted backup creation, verification, retention pruning | **COMPLETE (Candidate)** | `src/operations/backup.ts`; age encryption with public recipient; verification via separate private key; catalog-only role; configurable retention (`FCD_BACKUP_RETAIN_DAYS`, `FCD_BACKUP_RETAIN_MONTHS`); `tests/operations-backup.test.ts`. |
| **Task 11** / **P6-004 (part 2)** | Isolated split-capability restore, bound migration, deletion reconciliation, promotion | **COMPLETE (Candidate)** | `scripts/restore-runtime.sh`; `scripts/promote-restore.sh`; split capabilities (stream, migrate, reconcile); target-only bridge; signed deletion checkpoint reconciliation (`tests/deletion-checkpoint.test.ts`); two-cluster integration (`tests/integration/two-cluster-restore.test.ts`); safe switching & rollback limits in `docs/operations/backup-and-restore.md`. |
| **Task 12** / **P6-005 (part 1)** | Private admin dashboard & authenticated socket transport | **COMPLETE (Candidate)** | `src/admin/admin-socket.ts`; `src/admin/admin-runtime.ts`; MFA, session revocation, CSRF, signed actions; `tests/admin-socket.test.ts`; `tests/integration/postgres-admin-socket.test.ts`. |
| **Task 13** / **P6-005 (part 2)** | Private health checks, host metadata, privacy-safe incident handling | **COMPLETE (Candidate)** | `src/operations/health-collector.ts`; minimized health and incident metadata; n8n independence; external alerts deferred; `tests/operations-health.test.ts`. |
| **Task 14** / **P6-006** | Authenticated private n8n notification client & queue flow | **COMPLETE (Candidate)** | `src/operations/n8n-client.ts`; HMAC verification; notification queue flow; transaction-bound deletion cancellation; database authority; `tests/n8n-client.test.ts`; `tests/integration/postgres-notification-flow.test.ts`. |
| **Task 15** / **P6-004 (part 3)** | Operational failure matrix, recovery harness closeout & dependency follow-up | **COMPLETE (Candidate)** | PR #3 (`df8e52d`): read-only root failure, corrupt ciphertext, expired tombstones, migration failure, child wait timeout protection, isolated root fixture containment. PR #4 (`c74b6f4`): scoped `glob@14.0.3` and `minimatch@11.0.3` runtime overrides; clean production audit. |
| **P6-GATE** | Review Phase 6 evidence | **OPEN** | Retained under Codex authority and project owner approval boundary. |
| **Task 16** | Phase 6 server deployment & consolidated handoff | **OPEN** | Retained under Codex authority following P6-GATE review. |

---

## 4. Candid Disclosure of Gaps & Pending Items

The following items are candidly acknowledged as outside Phase 6 local/CI completion and must remain strictly deferred or unresolved:

1. **2026-10-31 Server Reboot / Actor-Loss Incident:**
   - On the test server, a host reboot resulted in an unmanaged stopped-actor state.
   - All volumes, journals, and selection records remain preserved under uncertainty rules.
   - This incident remains open for separate review; no automated cleanup or state settlement has been performed.
2. **Phase 7 Deferred Scope (P7-005):**
   - **Live Manifest Recording-Off:** Local tests enforce tool-free `auto` requests, redaction, and timeouts against local client fakes. Live Manifest recording-off attestation requires Phase 7 inspection of the running Manifest service.
   - **Real Network Attachments:** Live attachment of the model worker to the private Manifest network and attachment to private n8n services remain deferred to Phase 7.
   - **External Uptime Alerts:** Dashboard and journal incident handling are implemented locally, but external uptime alerting (e.g., paging operators when host is off) is deferred to Phase 7. Staff must maintain manual Meta Business Suite coverage.
   - **Full Host Outage / Power-Loss Drill:** Synthetic restart idempotency passes locally, but physical host pull-plug / reboot drills remain P7.
3. **Phase 8 Deferred Scope (P8-002, P8-003, P8-004):**
   - Meta live app review and WhatsApp coexistence checks remain strictly blocked until Phase 8. The production WhatsApp Business account remains completely untouched and isolated.

---

## 5. Primary Evidence Documents

The following documents in the repository comprise the Phase 6 evidence pack:

- [Phase 6 Operations Evidence Index](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/testing/phase-6-operations-evidence.md)
- [Phase 6 Failure Matrix Gap Map](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/testing/phase-6-failure-matrix-gap-map.md)
- [Acceptance Matrix](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/testing/acceptance-matrix.md)
- [Security Threat Model](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/security/threat-model.md)
- [Hardened Runtime Operator Guide](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/operations/hardened-runtime.md)
- [Backup and Restore Operator Guide](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/operations/backup-and-restore.md)
- [Runtime Deployment Safety Guide](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/operations/runtime-deployment-safety.md)
- [Outbound Worker Contract](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/operations/outbound-worker.md)
- [Private Admin and Model Guide](file:///j:/DevDrive/fcd-support-agy-failure-matrix/docs/operations/private-admin-and-model.md)

---

## 6. Action Items Remaining for Codex

1. **Independent Evidence Review:** Verify that all citations, SHAs, counts, and claims in this evidence pack match actual repository and CI history.
2. **P6-GATE Assessment:** Evaluate whether Tasks 1–15 and P6-002 through P6-006 satisfy the exit criteria for Phase 6.
3. **Host Incident Disposition:** Formulate the resolution plan for the 2026-10-31 host reboot / actor-loss incident on the test server.
4. **Task 16 Execution:** Execute server deployment, verify runtime health, and provide final handoff to the project owner.
