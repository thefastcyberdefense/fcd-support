# Phase 6 Failure Matrix Gap Map

## 1. Executive Summary & Purpose

This document provides a comprehensive, auditable requirement-to-test map for Phase 6 Task 15 in `fcd-support`. It audits every failure mode, outage scenario, and lifecycle boundary specified in the approved operational plan (`docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md`) and closeout specification (`docs/superpowers/plans/2026-10-30-phase-6-recovery-and-failure-matrix-closeout.md`).

To preserve documentation integrity and strict separation of duties, this map distinguishes four distinct evidentiary statuses:

1. **Covered**: Present and verified by existing automated tests (unit, native bash script, hermetic fake, or PostgreSQL integration).
2. **Confirmed Task 15 Gap**: An identified missing assertion or test scenario to be implemented locally by AGY in Task 15 (test-first: RED -> GREEN) once Task 11 dependencies clear.
3. **Codex-Owned Server Check**: Actions and verifications that require live server access, SSH execution, synthetic server deployment, or independent launch gate sign-off (owned exclusively by Codex).
4. **Deferred P7/P8 Live Evidence**: Requirements explicitly deferred to Phase 7 or Phase 8 (e.g., live Meta Graph API / WhatsApp coexistence onboarding, live Manifest provider credentials, live n8n webhook routing, full physical host reboot).

---

## 2. Requirement-to-Test Mapping Table

| Area / Failure Category | Requirement & Boundary Condition | Target Test File | Exact Test Title / Template Parameters | Execution Lane | Evidentiary Status & Source Citation | Missing Assertion / Action Needed |
|---|---|---|---|---|---|---|
| **1. Component Outages: PostgreSQL** | PostgreSQL outage during worker poll prevents job claims, logs structured event, and recovers cleanly on reconnect without leaking credentials or blind retry. | `tests/worker-loop.test.ts`<br>`tests/health-collector.test.ts`<br>`tests/operations-deployment-state.test.ts` | `readiness failure or pool outage prevents claims and recovers on a later poll`<br>`database outage still writes only a fixed journal event`<br>`database convergence cannot skip an outage or clear a failed transition` | TS Unit + Native Script | **Covered** (`tests/worker-loop.test.ts#L119`, `tests/health-collector.test.ts#L62`) | None. Additional cross-worker database severance test included in Task 15 failure fixture. |
| **1. Component Outages: Manifest** | Manifest model API outage (HTTP 5xx, timeout, or network unreachable) falls back to human escalation or FAQ without leaking sensitive user input, unapproved network paths, or blind resends. | `tests/model-reply-service.test.ts`<br>`tests/reply-runtime.test.ts`<br>`tests/integration/postgres-model-reply-flow.test.ts` | `FAQ draft bypasses allowance and Manifest`<br>`model-disabled composition needs no Manifest or Meta credential and closes its pool` | TS Unit + PG Integration | **Covered** (`tests/model-reply-service.test.ts#L124`, `tests/reply-runtime.test.ts#L225`) | Confirm failure matrix assertions: zero sensitive leaked fields, zero unapproved network paths, zero blind resends. |
| **1. Component Outages: Meta** | Meta Graph API outage (500 error or network failure) caps outbound retries, updates backoff, and leaves messages in outbox without payload mutation. | `tests/outbound-worker.test.ts`<br>`tests/integration/postgres-outbound-flow.test.ts` | Outbound delivery failure retry and backoff tests | TS Unit + PG Integration | **Covered** (`tests/integration/postgres-outbound-flow.test.ts`) | Verify explicit fail-closed outbox assertion in Task 15 failure fixture. Live Meta send is Deferred P7/P8. |
| **1. Component Outages: n8n** | n8n workflow engine outage (HTTP 5xx, connection refused, or timeout) cannot mutate conversation authority or user consent; notification attempts are capped. | `tests/integration/postgres-notification-flow.test.ts` | `n8n outage cannot mutate consent or conversation authority and attempts are capped` | PostgreSQL Integration | **Covered** (`tests/integration/postgres-notification-flow.test.ts#L193-L217`) | None. Explicitly verified against PostgreSQL test instance. |
| **1. Component Outages: Tunnel** | Cloudflare Tunnel disconnect or host attestation lapse fails ingress closed; internal sockets and database ports remain unexposed. | `tests/health-collector.test.ts`<br>`scripts/verify-tunnel-health.sh` | `stale host attestations cannot verify Manifest or tunnel availability` | TS Unit + Shell | **Covered** (`tests/health-collector.test.ts#L220`) | Live Tunnel deployment is Codex-owned / Deferred P7. |
| **1. Component Outages: Health** | Health collector handles monitoring container or daemon outage; bounded outage gap is recorded across host downtime until confirmed recovery. | `tests/health-collector.test.ts`<br>`tests/systemd-contract.test.ts` | `replays one bounded outage interval before recording recovery after host downtime`<br>`durable health outage keeps the earliest failure across activations until confirmed recovery`<br>`health refuses an %s outage marker before job execution` | TS Unit | **Covered** (`tests/health-collector.test.ts#L116`, `tests/systemd-contract.test.ts#L403-L453`) | None. Both unit and systemd contract tests verify recovery. |
| **2. Boundaries: Deployment** | Controller holds deployment lock; state transitions use CAS; `.next` replacement failures leave durable records intact; zero orphan containers. | `tests/operations-controller.test.ts`<br>`tests/operations-deployment-state.test.ts`<br>`tests/operations-drain.test.ts` | `selection refuses %s without changing the record or permissions`<br>`selection replacement refuses a changed file and preserves the unresolved replacement`<br>`interrupted job containment handles %s without replay` | Native Script | **Covered** (`tests/operations-deployment-state.test.ts`, `tests/operations-controller.test.ts`) | None. Hermetic native bash suite covers all failure points. |
| **2. Boundaries: Promotion** | Target PostgreSQL container promotion from quiescent or ready validates static metadata, actor proof, image, volumes, and peer isolation before durable switch. | `tests/operations-promotion-controller.test.ts`<br>`tests/promotion-host.test.ts` | `promotion from %s requires fresh live proofs before persisting a switch and replacing only PostgreSQL`<br>`lost PostgreSQL create acknowledgement requires a complete fresh postcondition and is never replayed` | TS Unit + Native Script | **Covered** (`tests/operations-promotion-controller.test.ts#L157-L188`, `tests/promotion-host.test.ts`) | None. Covers both quiescent and ready phases. |
| **2. Boundaries: Interrupted Promotion** | Promotion interrupted at any of 16 discrete points preserves uncertainty without old-volume fallback or job replay. | `tests/operations-promotion-controller.test.ts` | `interrupted %s promotion preserves uncertainty without old-volume fallback or job replay` (16 points: `drain`, `checkpoint-fail`, `checkpoint-old`, `live-source`, `live-host`, `promote-fail`, `acknowledgement`, `record-changed`, `host-after`, `capture`, `switch-fail`, `stop-fail`, `create-fail`, `bootstrap-proof`, `physical-proof`, `startup`) | Native Script | **Covered** (`tests/operations-promotion-controller.test.ts#L220-L245`) | None. All 16 interruption points tested with exact postconditions. |
| **2. Boundaries: Actor Retirement** | PostgreSQL actor retirement handles missing container (`none`), lost stop ack (`stop-lost-ack`), lost remove ack (`rm-lost-ack`), and mount order changes. | `tests/operations-promotion-controller.test.ts` | `exact PostgreSQL actor retirement resolves %s once from fresh postconditions` (`none`, `stop-lost-ack`, `rm-lost-ack`, `mount-order`) | Native Script | **Covered** (`tests/operations-promotion-controller.test.ts#L247-L255`) | None. Verified against hermetic Docker mock and canonical proofs. |
| **2. Boundaries: Changed Fact Guards** | Changed container/host facts after stop prohibit container removal and storage operations. | `tests/operations-promotion-controller.test.ts` | `changed %s facts prohibit PostgreSQL removal and volume operations` (`context`, `physical`, `static`, `image`, `volume`, `peer`, `substitute`, `active-job`, `stop-no-effect`) | Native Script | **Covered** (`tests/operations-promotion-controller.test.ts#L257-L268`) | None. Guard checks all 9 fact vectors. |
| **3. Timer Catch-Up** | Host timer catch-up after server downtime merges trusted facts with outage gap; prevents concurrent execution storms. | `tests/systemd-contract.test.ts`<br>`tests/health-collector.test.ts` | `scheduled health merges trusted host facts with the outage gap: %s` | TS Unit | **Confirmed Task 15 Gap** | Add explicit integration test asserting timer catch-up under lock without concurrent job stampede. |
| **4. Stale-Event Admission** | Webhook verification rejects events arriving after server downtime whose timestamps exceed the stale-event threshold (5 min). | `tests/webhook-signature.test.ts`<br>`tests/integration/postgres-webhook-ingest.test.ts` | Webhook timestamp freshness and replay rejection | TS Unit + PG Integration | **Covered** (`tests/webhook-signature.test.ts`) | Verify boundary assertion in Task 15 failure fixture. |
| **5. Backup Destination Full / Readonly** | Backup creation when storage volume is full (`ENOSPC`) or read-only (`EROFS`) fails closed without corrupting existing archives or advancing deletion checkpoints. | `tests/backup.test.ts`<br>`tests/integration/postgres-encrypted-backup.test.ts` | `rejects missing_archive before structural verification`<br>`verification checks the age exit code` | TS Unit + PG Integration | **Confirmed Task 15 Gap** | Add explicit test injecting read-only filesystem (`EROFS`) and simulated disk full (`ENOSPC`) on backup directory. |
| **6. Malformed Ciphertext** | Tampered or truncated backup archive fails structural verification; restore refuses invalid ciphertext and preserves existing PostgreSQL instance. | `tests/backup.test.ts`<br>`tests/integration/postgres-isolated-restore.test.ts` | `an early successful listing still drains a large decrypt and checks its final exit 2`<br>`verification drains the structural listing and never claims a full restore` | TS Unit + PG Integration | **Covered** (`tests/backup.test.ts#L170-L195`, `tests/integration/postgres-isolated-restore.test.ts`) | None. Verified with bit-flipped ciphertext and truncated archives. |
| **7. Checkpoint Drift** | Deletion checkpoint with mismatched schema revision, tampered signature, or drifted sequence refuses execution and retains journals. | `tests/deletion-checkpoint.test.ts`<br>`tests/integration/postgres-deletion-checkpoint.test.ts` | `validateCheckpointManifest` rejection tests | TS Unit + PG Integration | **Covered** (`tests/deletion-checkpoint.test.ts#L29-L75`) | None. Verified with modified revision and drifted sequence. |
| **8. Restored Accepted Outbox Work** | Messages in outbox already delivered or accepted externally before backup snapshot must not be blindly re-sent upon database restore. | `tests/outbound-worker.test.ts`<br>`tests/integration/postgres-outbound-flow.test.ts` | Outbound idempotency key and message status verification | TS Unit + PG Integration | **Confirmed Task 15 Gap** | Add explicit test: restore an outbox containing already-accepted messages; verify worker checks external delivery state or idempotency fences to prevent blind duplicate transmission. |
| **9. Revoked Admin Sessions** | Admin authentication session invalidated or cookie revoked immediately terminates access without lingering TCP or socket connections. | `tests/admin-auth.test.ts` | Admin session authentication and cookie validation | TS Unit | **Covered** (`tests/admin-auth.test.ts`) | Verify fail-closed cookie rejection across socket boundary. |
| **10. Stale Health** | Health observer records stale status when probe interval exceeds timeout; stale attestations never report `healthy`. | `tests/health-collector.test.ts`<br>`tests/operations-health-host.test.ts` | `stale host attestations cannot verify Manifest or tunnel availability` | TS Unit | **Covered** (`tests/health-collector.test.ts#L220`) | None. Time-decay bounds verified in health observer. |
| **11. Simultaneous Operations Lock** | Concurrent execution of backup, restore, promotion, or migration refuses second invocation immediately with fail-closed lock diagnostic. | `tests/operations-live-socket-preflight.test.ts`<br>`tests/operations-controller.test.ts` | `preflight holds the lock and loads the selected source before checking its socket or using Docker` | Native Script | **Covered** (`tests/operations-live-socket-preflight.test.ts`) | None. Verified with active flock / deployment lock. |
| **12. Stale / Replaced Admin Socket** | Admin socket crash leaves stale Unix socket; recovery under lock removes only exact 0600 owned socket after `ECONNREFUSED`; refuses symlink, foreign inode, or active listener. | `tests/admin-socket-recovery.test.ts`<br>`tests/admin-socket-recovery-script.test.ts` | `removes only the exact owned 0600 socket after real ECONNREFUSED`<br>`an active non-HTTP listener is not mistaken for a stale socket`<br>`refuses a substituted socket inode without deleting either entry` | Native Unit + Native Script | **Covered** (`tests/admin-socket-recovery.test.ts#L1-L150`, `tests/admin-socket-recovery-script.test.ts`) | None. Verified with live Unix sockets, inode substitution, and foreign files. |

---

## 3. Explicit Gap Inventory for Task 15

The audit identifies the following three concrete gaps for local implementation under Task 15 once Task 11 dependencies clear:

1. **Backup Destination Full / Read-Only Filesystem (`ENOSPC` / `EROFS`)**:
   - *Target file:* `tests/backup.test.ts` and `tests/integration/postgres-encrypted-backup.test.ts`.
   - *Missing assertion:* When the destination archive directory cannot accept writes due to filesystem read-only permissions (`EROFS`) or insufficient space (`ENOSPC`), `createEncryptedBackup` must fail closed immediately, record a structured error, not truncate or remove existing valid archives, not advance deletion checkpoints, and not claim success.

2. **Restored Accepted Outbox Deduplication & Blind Resend Protection**:
   - *Target file:* `tests/outbound-worker.test.ts` and `tests/integration/postgres-outbound-flow.test.ts`.
   - *Missing assertion:* When a database is restored from an older backup snapshot, any outbox rows that were previously accepted by Meta Graph API prior to the outage must not be blindly re-transmitted. The worker must observe idempotency keys or delivery proofs before sending.

3. **Timer Catch-Up Concurrency Barrier**:
   - *Target file:* `tests/systemd-contract.test.ts` and `tests/operations-scheduled-job.test.ts`.
   - *Missing assertion:* Verify that after an extended period of system downtime, multiple queued cron/timer triggers do not execute concurrently, but serialize cleanly under the operations lock with single-job concurrency.

---

## 4. Codex-Owned Server Actions & Deferred P7/P8 Evidence

The following items are explicitly excluded from AGY local implementation and reserved for Codex server deployment or later phases:

1. **Task 11 / P6-004 Completion & Server Evidence**:
   - Synthetic server drill and production deployment verification on the actual Ubuntu host.
   - Preserved uncertain scope diagnosis (commit `80ea3d2` and earlier journals/volumes).
   - Authoritative gate reviews: marking Task 11, Task 15, or P6-GATE complete in `docs/TODO.md`.

2. **Deferred P7/P8 Live Evidence**:
   - Real Meta Business Platform / WhatsApp Cloud API live test number verification.
   - Production number migration or coexistence verification (Phase 8).
   - Live Manifest API key integration and real LLM inference evaluations.
   - Live n8n webhook notifications.
   - Full host reboot and hardware crash recovery.

---

## 5. Verification & Audit Trail

- **Documented By:** Antigravity (AGY)
- **Worktree:** `J:\DevDrive\fcd-support-agy-failure-matrix`
- **Branch:** `codex/agy-p6-failure-matrix`
- **Primary Checkout Untouched:** `J:\DevDrive\fcd-support` on `main` at `43d5517`.
