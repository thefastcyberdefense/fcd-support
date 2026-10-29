# Phase 6 Task 11 Interruption and Recovery Gap Matrix

This document maps all Phase 6 Task 11 interruption, containment, and recovery
requirements to concrete executable test files, exact test names, evidence types,
and verified fail-closed behaviors in `fcd-support`. It evaluates the six core
resilience areas defined in the approved plan (`docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md`),
identifies authority boundaries, and explicitly records open server-level proofs.

---

## 1. Requirement and Evidence Mapping

| Area | Requirement & Boundary | Test File | Exact Test Name | Evidence Type | Status |
| --- | --- | --- | --- | --- | --- |
| **1. Lifecycle Boundaries** | Intent recorded to fsynced, non-volatile storage before container creation | `tests/operations-job-lifecycle.test.ts`<br>`tests/operations-job-state.test.ts` | `a stopped owned job is recorded before start and acknowledged only after verified removal`<br>`job intent is persisted as a protected content-free record and round-trips` | Native script + hermetic PATH fake;<br>Native unit | **Covered** |
| **1. Lifecycle Boundaries** | Container created and asserted stopped; owner, command, image verified before start | `tests/operations-job-lifecycle.test.ts` | `a stopped owned job is recorded before start and acknowledged only after verified removal`<br>`job failure %s preserves uncertainty...` (`create-before`, `create-after`, `wrong-owner`, `wrong-command`, `wrong-image`, `wrong-project`, `wrong-service`, `already-running`, `duplicate`) | Native script + hermetic PATH fake | **Covered** |
| **1. Lifecycle Boundaries** | `started` transition recorded before container start execution; lost start ack is fail-closed | `tests/operations-job-lifecycle.test.ts` | `a stopped owned job is recorded before start and acknowledged only after verified removal`<br>`job failure start-ack preserves uncertainty without a success acknowledgement or replay` | Native script + hermetic PATH fake | **Covered** |
| **1. Lifecycle Boundaries** | Strict, content-free acknowledgement parsed; unexpected output preserves uncertainty | `tests/operations-job-lifecycle.test.ts` | `job failure unsafe-output preserves uncertainty without a success acknowledgement or replay`<br>`health uses its standalone entry and interactive stdin through the complete owned-job lifecycle`<br>`already-completed maintenance slots accept only their fixed skipped acknowledgement` | Native script + hermetic PATH fake | **Covered** |
| **1. Lifecycle Boundaries** | Verified container removal required before clearing durable job journal | `tests/operations-job-lifecycle.test.ts`<br>`tests/operations-job-state.test.ts` | `a stopped owned job is recorded before start and acknowledged only after verified removal`<br>`job failure remove-ack preserves uncertainty without a success acknowledgement or replay`<br>`created started completed job state clears only after the terminal transition` | Native script + hermetic PATH fake;<br>Native unit | **Covered** |
| **2. Missing Job Actors** | Container absent before start (`create-before`) preserves uncertain state without replay | `tests/operations-job-lifecycle.test.ts` | `job failure create-before preserves uncertainty without a success acknowledgement or replay` | Native script + hermetic PATH fake | **Covered** |
| **2. Missing Job Actors** | Controller killed while job is active leaves `started` record; subsequent mutation blocked | `tests/operations-job-lifecycle.test.ts` | `a killed controller leaves the started job recorded and blocks a new mutating attempt` | Native script + hermetic PATH fake | **Covered** |
| **2. Missing Job Actors** | Uncertain job whose container actor is absent refuses re-execution, preserves journal, and does not infer exit code or replay | `tests/operations-job-lifecycle.test.ts`<br>`tests/operations-job-state.test.ts` | `job failure %s preserves uncertainty without a success acknowledgement or replay` (`wait-ack`, `job-failed`, `unsafe-output`)<br>`uncertain state survives refusal and requires an explicit recorded resolution` | Native script + hermetic PATH fake;<br>Native unit | **Covered** |
| **2. Missing Job Actors** | Authority to resolve an uncertain job or infer outcome from absent actor | *N/A (Intentionally omitted)* | *No automated resolver exists; manual/reviewed authority required* | Architecture boundary | **Open Gap (Design boundary)** |
| **3. Backend Settlement** | Operation reference formatted as `fcd-support-op:${ref}` and bound into connection string | `tests/operation-reference.test.ts` | `formats a canonical application_name for an operation reference`<br>`binds the application_name into a PostgreSQL connection URL` | TypeScript unit | **Covered** |
| **3. Backend Settlement** | Point-in-time PostgreSQL settlement under read-only transaction, advisory locks, and clean stat activity | `tests/operation-settlement.test.ts` | `settlement inspects under a read-only transaction and both mutation barriers, then destroys its connection`<br>`settlement fails closed for %s without acknowledging an operation result`<br>`settlement refuses its own reference before opening a connection` | TypeScript unit + mock PG client | **Covered** |
| **3. Backend Settlement** | Real cluster settlement verifies closed backends and released advisory locks; rejects foreign clusters | `tests/integration/postgres-operation-settlement.test.ts` | `settlement closes its actual owner backend and releases both mutation barriers`<br>`settlement refuses a lingering %s backend until its actual connection closes`<br>`settlement refuses the held %s advisory barrier without waiting or releasing its owner`<br>`settlement refuses a substituted %s identity`<br>`compiled owner inspection handles %s with closed output and without role password files` | PostgreSQL integration + real cluster | **Covered** |
| **3. Backend Settlement** | Separation of settlement observation from resolution authority: settlement proves connection closure only; never resolves or clears `active-job` | `src/operations/operation-settlement.ts`<br>`src/operations/bootstrap-main.ts`<br>`tests/operations-job-state.test.ts` | `uncertain state survives refusal and requires an explicit recorded resolution`<br>`compiled owner inspection handles %s with closed output...` | Native unit + PostgreSQL integration | **Covered** |
| **4. State Replacements & Pointers** | Pending `.next` replacement file present causes immediate refusal without mutating existing record | `tests/operations-deployment-state.test.ts`<br>`tests/operations-restore-state.test.ts` | `selection refuses %s without changing the record or permissions` (`stale-next`)<br>`read rejects %s while preserving immutable restore history` (`next`) | Native script | **Covered** |
| **4. State Replacements & Pointers** | CAS failure during state replacement preserves `.next` file and original record | `tests/operations-deployment-state.test.ts`<br>`tests/operations-restore-state.test.ts` | `selection replacement refuses a changed file and preserves the unresolved replacement`<br>`completion checks original intent CAS after metadata validation and preserves unresolved next` | Native script | **Covered** |
| **4. State Replacements & Pointers** | Missing pointer cannot be re-created over immutable used-volume history | `tests/operations-deployment-state.test.ts` | `a missing pointer cannot be re-created over the immutable used-volume history`<br>`Compose volume selection uses the protected pointer and never a stale configured fallback` | Native script | **Covered** |
| **4. State Replacements & Pointers** | Unfinished restore intent blocks concurrent or subsequent restore references | `tests/operations-restore-state.test.ts` | `unfinished intent prevents another restore reference from bypassing uncertainty` | Native script | **Covered** |
| **5. Rollback Refusal** | Rollback requires verified `ready` phase and exact schema compatibility | `tests/operations-controller.test.ts` | `public controller sequences %s through the verified private primitives` (`rollback`, `rollback-incompatible`) | Script unit | **Covered** |
| **5. Rollback Refusal** | Rollback refused during `uncertain`, `draining`, `quiescent`, or `switching` phases | `tests/operations-controller.test.ts` | `public controller sequences uncertain through the verified private primitives` | Script unit | **Covered** |
| **5. Rollback Refusal** | Refusal of old-volume fallback after writes are possible; switched volumes recorded in immutable used history | `tests/operations-deployment-state.test.ts`<br>`tests/operations-promotion-controller.test.ts` | `write exposure is recorded before startup and uncertainty cannot silently become ready`<br>`switch selects a new unused restore volume durably and preserves the previous pointer`<br>`interrupted %s promotion preserves uncertainty without old-volume fallback or job replay` | Native script | **Covered** |
| **6. Admin Sockets** | Preflight verifies deployment lock and active selection before checking admin socket or contacting Docker | `tests/operations-live-socket-preflight.test.ts` | `preflight holds the lock and loads the selected source before checking its socket or using Docker` | Script unit | **Covered** |
| **6. Admin Sockets** | Existing Unix socket entry blocks deploy, rollback, restore, promote; permitted only for verify and recover | `tests/operations-live-socket-preflight.test.ts` | `socket preflight preserves %s entry refusal or existing verify/recovery semantics`<br>`present Unix socket refuses %s source evidence without removing it` | Script unit;<br>Native script + live Unix socket | **Covered** |
| **6. Admin Sockets** | Stale socket recovered only under deployment lock after verified owner shutdown, exact device/inode check, and ECONNREFUSED | `tests/admin-socket-recovery.test.ts`<br>`tests/admin-socket-recovery-script.test.ts` | `removes only the exact owned 0600 socket after real ECONNREFUSED`<br>`an active non-HTTP listener is not mistaken for a stale socket`<br>`preserves a %s entry` (`regular`, `symlink`, `directory`)<br>`refuses a substituted socket inode without deleting either entry`<br>`recovers stopped admin socket through the deployment lock` | Native unit + live Unix socket server;<br>Native script | **Covered** |

---

## 2. In-Depth Analysis of Critical Boundaries

### 2.1 Missing Job Actors & Uncertain Phase Containment

When an operation job fails, is cancelled, or loses contact with the controller:
1. `operations_job_uncertain` transitions `active-job` to `JOB_PHASE=uncertain` via atomic rename (`mv --no-target-directory active-job-*.next active-job`).
2. If the container was verified, `operations_job_cancel_owned` attempts bounded graceful stop and removal. If the container was already terminated, killed, or pruned, it is absent from Docker.
3. Once in `JOB_PHASE=uncertain`:
   - Any subsequent call to `operations_execute_job` detects the existing `$OPS_JOB_STATE_FILE` and fails closed immediately with `operations_job_pending` before inspecting Docker, touching PostgreSQL, or parsing arguments.
   - Any attempt to clear the state via `operations_job_state_clear` fails with `operations_job_state_invalid` because `clear` permits only `completed`, `cancelled`, or `resolved`.
   - The absence of the Docker container actor is **never** used to infer that the job finished, failed cleanly, or can be re-run.
   - The system does not fall back to previous volumes, drop locks, or re-enable runtime routing.

### 2.2 Backend Settlement vs. Operation Resolution Authority

`src/operations/operation-settlement.ts` provides `inspectOperationSettlement`:
- It connects to the target database with `application_name = operationApplicationName(probeReference)`.
- Under a `begin read only` transaction with strict timeouts, it validates `system_identifier`, `current_database()`, and superuser privilege.
- It attempts non-blocking advisory transaction locks on `runtime-grants` and `deployment` barriers.
- It queries `pg_stat_activity` and `pg_prepared_xacts` to prove zero backends remain for the operation reference.
- It issues `rollback` and releases the client with `destroy = true`.

**Crucial Authority Separation:**
- Proving backend settlement (`{ status: 'settled' }`) proves **only** that no database connection or lock is currently held by that operation reference.
- It does **not** prove whether the operation's business transactions committed or rolled back.
- It does **not** grant authority to resolve `active-job`, clear the journal, or declare the runtime ready.
- Only a reviewed, authorized operational decision can transition `uncertain` to `resolved`. The codebase provides no automated resolver, intentionally preventing unsafe autonomous resolution.

### 2.3 Write-Aware Rollback Refusal

`scripts/operations-controller.sh` and `scripts/operations-deployment-state.sh` enforce:
- Rollback via `operations_rollback` requires `STATE_PHASE == ready` and exact schema/image compatibility with the retained manifest.
- When an operation switches to a restored volume (`operations_selection_switch`), the previous volume is marked in `used-$volume.record`.
- Once `STATE_WRITES_POSSIBLE=yes` is recorded (during `starting`, `ready`, or `draining`), the deployment pointer cannot be reverted to any prior volume recorded in used history.
- Any attempt to switch back to a previously used volume fails closed with `operations_deployment_state_invalid`.

### 2.4 Stale & Replaced Admin Socket Safety

`scripts/operations-admin-socket.sh` and `src/operations/admin-socket-recovery.ts` guarantee:
- Deployment preflight checks the socket root under the deployment lock and after reading the deployment selection.
- If a socket is present during `deploy`, `rollback`, `restore`, or `promote`, the operation is refused (`operations_socket_present`).
- Socket recovery (`recover-admin-socket.sh`) is permitted only when admin is confirmed stopped, the socket device and inode match expected metadata, the mode is strictly `0600`, and a real connection attempt fails with `ECONNREFUSED`.
- Active listeners, foreign owners, directories, symlinks, or substituted inodes refuse recovery without deleting any file.

---

## 3. Explicit Gap and Authority Boundary Summary

1. **Unresolved Uncertain Job Scope:**
   - In the preserved synthetic server failure (`80ea3d2`), promotion became uncertain and the job container was removed/absent.
   - **Current System Behavior:** Correctly fails closed. Re-execution is refused (`operations_job_pending`), clearing is refused (`operations_job_state_invalid`), and no fallback occurs.
   - **Open Gap:** No automated path exists to resolve an uncertain job whose actor is absent. An automated resolver would violate fail-closed safety without a human review boundary. Codex owns the synthetic server scope diagnosis.
2. **Server-Only Verification (Pending Server Drill):**
   - Deployed Linux systemd units and real host reboot survival.
   - Real SSH port-forwarding with live loopback authentication.
   - Multi-node Cloudflare tunnel webhook ingestion and real Meta API endpoints.
   - All server-only evidence remains explicitly **PENDING** until Codex schedules the next synthetic server drill.
