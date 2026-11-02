# Phase 6 Operations Evidence

This document serves as the consolidated Task 15 evidence index for Phase 6
gate consideration. It does not constitute an aggregate P6 gate pass or server
deployment authorization. Tasks 1–15 implementation, failure tests, and runtime
dependency follow-up are complete; independent whole-phase gate review
(P6-GATE) and Task 16 server deployment/handoff remain under Codex ownership.
Keep local component checks, disposable CI runtimes, bounded historical server
records, and pending live integration distinctly categorized.

---

## 1. Current Phase 6 Checkpoint and Status

- **Task 11 COMPLETE:** Implemented and verified via bounded historical server
  drill at deployed application `67a4a4b`: private deploy, signed backup/replay,
  isolated restore, promotion/verify, compatible same-revision retained rollback/
  verify, and separate `3f22344` action audit. Current private server readiness
  was restored by separately reviewed action `d96382d` (admin Unix login HTTP
  200, private ingress 403/404/401, restored PostgreSQL control identity, zero
  operation/socket-helper actors). See `docs/reviews/2026-10-31-phase-6-task-11-closeout.md`.
- **Tasks 12–14 COMPLETE:** Hardened runtime readiness matrix, incident procedures,
  and negative ingress/topology probes verified.
- **Task 15 Implementation & Failure Coverage (PR #3):** Merged as `df8e52d`
  after independent review on tested source `7801314`. Real kernel EROFS, owning
  flock barrier/reaping, PostgreSQL catalog slot deduplication, restored outbox
  recovery hold, and fail-closed scoped volume cleanup are accepted. See
  `docs/reviews/2026-11-01-pr-3-integration.md`.
- **Task 15 Runtime Dependency Follow-up (PR #4):** Merged as `c74b6f4` on tested
  source `9f76455`. Scoped pinned overrides under `node-pg-migrate@9.0.0`
  (glob `14.0.3` and minimatch `11.0.3`) eliminated the two reported runtime
  vulnerabilities (#42 and #43). Production audit `npm audit --omit=dev` reports
  **zero vulnerabilities**. Development-only tooling advisories (11 moderate)
  remain distinct. See `docs/reviews/2026-11-01-pr-4-integration.md`.
- **Current Synchronized Main:** Clean at `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`.
- **Open Server Incident:** The guest reboot / actor-loss incident remains OPEN
  without reconstruction or SQL settlement (`docs/operations/incidents/2026-10-31-test-server-restart-and-actor-loss.md`).
  Preserved volumes and state files remain untouched.
- **P6-004/P6-005/P6-006 & P6-GATE:** Remain IN PROGRESS / BLOCKED pending Codex
  independent gate review. Task 16 server deployment follows that review.

---

## 2. Tested Source Revisions and CI Execution Record

### Verified Revisions
- PR #3 Squash Merge: `df8e52dbe59e0013ab28a5790b21c9785324b2f0` (tested source `78013148751a493a6f8859bc6d3ee9628cb954d6`)
- PR #4 Squash Merge: `c74b6f4314e17fe707ba5e3f02a183d1ebe9b9fd` (tested source `9f76455be443a527ce58725fa574e7324631fd4d`)
- Synchronized Main Tip: `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`

### Execution Counts and Skips by Lane (Source `9f76455` / `c74b6f4`)

| Lane | Result | Files | Duration | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Local Windows Full Gate | 1,952 passed / 438 platform skips / 0 failed | 131 | 238.05 s | `VITEST_MAX_WORKERS=4 npm run check` (build + test) |
| Linux CI Unit Lane | 2,020 passed / 370 lane skips | 131 | 80.11 s | Ubuntu runner, pinned UID 1000, tmpfs scratch |
| Native Operations Lane | 1,298 passed | 55 | 489.37 s | Host scripts, permissions, lifecycle, containment |
| Full PostgreSQL Lane | 621 passed / 52 lane skips | 56 | 97.78 s | Authoritative state stores, flows, migrations |
| Grants PostgreSQL Lane | 139 passed / one restore-only skip | 13 | 58.35 s | Restricted roles, bootstrap, migrator checks |
| Restore Unit Lane | 252 passed | 12 | 62.08 s | Split capabilities, readers, reconcile, proof ports |
| Two-Cluster Integration | 47 passed | 2 | 25.72 s | Real source/target PostgreSQL clusters, promotion |

*Note: Test lanes overlap and represent distinct capability scopes; counts must never be summed.*

### Hermetic Operator-Helper Suites (Reported Individually)
- Observer: **32 passed / 1 Windows SIGHUP skip** (1.228 s local; 33 passed in 0.449 s CI)
- Reboot Recovery: **11 passed / 0 skips** (0.069 s local; 0.012 s CI)
- Peer Recovery: **11 passed / 0 skips** (0.039 s local; 0.010 s CI)
- Rollback After Reboot: **6 passed / 0 skips** (0.034 s local; 0.007 s CI)
- Current Runtime Recovery: **5 passed / 0 skips** (0.271 s local; 0.157 s CI)
- Docker Projections: **6 passed / 1 skip** (`scripts/test-docker-projections.sh`)

### Production Dependency & Audit Status
- Production `npm audit --omit=dev`: **0 vulnerabilities** (clean production runtime).
- Development `npm audit`: **11 moderate advisories** (under `eslint@10.8.0` and `@typescript-eslint` dev tools, tracked separately).
- GitHub Dependabot: Alert #42 closed (runtime); Alert #43 open (development-only).

### Immutable GitHub Actions Workflow Evidence (PR #4 Head `9f76455`)
- [ci (validate)](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888931) (PASSED in 5m13s)
- [CodeQL Advanced](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888940) (PASSED in 45s)
- [PostgreSQL and native operations](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888969) (PASSED in 13m54s: `postgres` in 2m35s, `native-operations` in 13m54s)
- [Private runtime controller](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888966) (PASSED in 10m09s: `fresh` in 10m07s, `precreated` in 10m09s)

*(PR #3 workflows on head `7801314` also fully passed: [ci 41294398628](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41294398628), [CodeQL 41294398634](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41294398634), [Postgres/native 41294398684](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41294398684), [Private runtime 41294398631](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41294398631)).*

---

## 3. Historical Server Deployment and Bounded Evidence

- **Last Recorded Server Deployment:** Application `67a4a4b`.
- **Drill Execution (2026-10-31):** The real server completed deploy, signed
  backup/replay, isolated restore, promotion/verify, and compatible same-revision
  retained rollback/verify through committed action `3f22344`. The restored
  physical identity and both volumes were preserved.
- **Actor-Loss Incident:** After a subsequent guest reboot, seven older stopped
  actors were absent while volumes and state files remained. Action `d96382d`
  restored private readiness (admin HTTP 200, private ingress 403/404/401,
  restored PostgreSQL control identity). The incident remains OPEN without
  speculative reconstruction or ad-hoc SQL settlement.
- **Current Limitation:** Tested application sources `7801314` (PR #3) and `9f76455`
  (PR #4) have NOT been deployed to the test server; server deployment of these
  updates is assigned to Task 16 following P6-GATE review.

---

## 4. Failure and Authority Coverage Matrix

| Boundary | Executable Evidence | Current Limit |
| :--- | :--- | :--- |
| **PostgreSQL Authority & Worker Stop** | `tests/worker-loop.test.ts`, `tests/health-collector.test.ts`, `tests/operations-deployment-state.test.ts`, and runtime stores | Local and ephemeral CI pass; full host power outage/restart matrix is deferred P7/P8 |
| **Manifest Privacy, Timeout & Tool Isolation** | `tests/manifest-client.test.ts`, `tests/model-reply-service.test.ts`, `tests/sensitive-data.test.ts`, `tests/faq-resolver.test.ts` | Local fakes and policy pass; live Manifest recording-off attestation and model quality are deferred P7 |
| **Meta Ambiguous Outcome & Replay** | `tests/integration/postgres-outbound-flow.test.ts`, `tests/outbound-worker.test.ts`, `tests/meta-outbound-client.test.ts` | Outbound flow and eligibility tests pass; real test-device sends and live manual-echo correlation are deferred P7/P8 |
| **Private n8n Boundary & Signed Retries** | `tests/n8n-client.test.ts`, `tests/integration/postgres-notification-flow.test.ts` | Fake peer and real PostgreSQL store pass; live n8n workflow deployment is deferred P7 |
| **Health Observer & Outage Recording** | `tests/health-collector.test.ts:220`, `tests/operations-health-host.test.ts`, `tests/systemd-contract.test.ts:403` | Host observations and bounded gap recording pass; installed host timer execution remains open |
| **Encrypted Backup Full (`ENOSPC`) & Read-Only (`EROFS`)** | `tests/backup.test.ts:268-615`, `tests/backup-harness-containment.test.ts`, `scripts/test-encrypted-backup.sh` | Verified via real Linux kernel RO mount, directory mode 0500, full tmpfs (`ENOSPC`), and contained RO initializer with verified cleanup gate |
| **Ciphertext Verification & Malformed Detection** | `tests/backup.test.ts:170-195`, `tests/integration/postgres-isolated-restore.test.ts` | Bit-flipped ciphertext, truncated archives, and premature exit pass |
| **Checkpoint Drift & Sequence Verification** | `tests/deletion-checkpoint.test.ts:28-80`, `tests/integration/postgres-deletion-checkpoint.test.ts:217-272` | Manifest age, watermark epoch/sequence, HMAC signature, and completeness pass; database schema drift covered by deployment state |
| **Restored Outbox Resend Protection** | `tests/integration/postgres-outbound-flow.test.ts:844-1024`, `tests/integration/postgres-outbound-work-store.test.ts` | Seeded older-snapshot divergence (provider ledger ahead of PostgreSQL state) verified: recovery hold active, eligible control dispatches once, restored worker sends zero times |
| **Deployment Lock Concurrency & Reaping** | `tests/systemd-contract.test.ts:482-690`, `tests/process-lifecycle.test.ts`, `tests/integration/postgres-encrypted-backup.test.ts:147-485` | Nonblocking flock execution on `deployment.lock` with deterministic barrier, bounded child exit/wait deadlines, verified reaping before timeout, and catalog slot deduplication pass |
| **Admin Crash & Stale Socket Recovery** | `tests/admin-socket-recovery.test.ts`, `tests/admin-socket-recovery-script.test.ts`, `scripts/recover-admin-socket.sh` | Real Unix socket and compiled CLI pass; executed under authorized historical drill `4c51898` / `d96382d` |
| **Admin Session Revocation & CSRF** | `tests/integration/postgres-admin-identity.test.ts:333-375`, `tests/admin-app.test.ts` | Session expiration, single-session revocation, bulk revocation, and CSRF pass (TCP/socket termination not claimed) |
| **Runtime Mounts, Images, Non-Root & UID** | `tests/phase6-compose-contract.test.ts`, `tests/deployment-contract.test.ts`, `infra/compose.runtime.yml` | Strict non-root UID 1000:1000, read-only root, no Docker host ports, private network isolation pass |

---

## 5. Acceptance Mapping and Remaining Gate Work

- **AC-09 (Backup/Restore):** Real encrypted backup, isolated restore into a
  distinct target volume, split capabilities, post-restore deletion tombstone
  reapplication, promotion proof gates, and recovery hold are verified in local,
  native, and two-cluster integration suites, as well as the historical server
  drill `3f22344`. Complete deployed promotion and server-level failure recovery
  remain to be deployed under Task 16.
- **AC-18 & AC-20 (Route Isolation & Runtime Contract):** Strict Compose
  contracts, pinned Dockerfiles, non-root users (`1000:1000`), `read_only: true`,
  capability drop, resource limits, and no host ports verified. Verified zero
  production dependency vulnerabilities (`npm audit --omit=dev`). Ingress
  negatives (403/404/401) verified on historical server.
- **AC-21 & AC-25 (Manifest Privacy & Rate Limits):** Local client fakes and
  composition pass with `model: "auto"`, no tools, strict redaction, and bounded
  resource ceilings. Live Manifest recording-off attestation and real provider
  call testing are explicitly deferred to Phase 7 (P7-005).
- **AC-26 (n8n Boundary):** Signed private notification adapter and PostgreSQL
  authority during outage pass automated tests. Live private n8n workflow
  execution remains deferred to Phase 7.

Before P6-GATE approval, Codex performs independent review of this consolidated
evidence pack. Host power outage, real Meta test device sends, live provider
quality, and production-number coexistence remain in Phase 7/8 gates.
