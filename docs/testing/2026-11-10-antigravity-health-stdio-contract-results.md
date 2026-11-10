# Health Process and Attached Stdio Regression Results

Date: 2026-11-10 (Asia/Dhaka)
Task: [`docs/handoffs/2026-11-09-antigravity-health-stdio-contract.md`](../handoffs/2026-11-09-antigravity-health-stdio-contract.md)
Status: Draft PR regression suite verified locally; disposable Linux/PostgreSQL/Docker CI verification pending push.

## Provenance

- **Repository base (`main`):** `88de2eeb693c08559e57295aa6ca8d1cd27bd104` (verified ancestor contains PR #10 merge `d4cfdddb63d98d76de13f47c697327eb9d43fbf5`, source `f108b026d8ef0a6c96e5e12eee083d53588a396a`, health implementation reference `4b38c94b943bf30d6cec3a188c84b6926f842198` via `git merge-base --is-ancestor`).
- **Branch:** `codex/agy-health-stdio-regression` in isolated worktree `J:\DevDrive\fcd-support-agy-health-stdio`.
- **Operations & Database Images (`linux/amd64`):**
  - Operations build base (`infra/Dockerfile.operations`): `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` and `postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636`.
  - Disposable PostgreSQL fixture (`scripts/test-health-stdio-docker.sh`): `postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636` on an `--internal` labeled network (`fcd-support.health-stdio-test=<scope>`).
- **Subject under test:** Built `dist/operations/health-main.js` (`runHealthCommand`, `readHealthInput`), `dist/operations/bootstrap-main.js`, `dist/operations-main.js`, `scripts/operations-job-lifecycle.sh` (`operations_execute_job`, `operations_job_health_exchange`, `operations_job_acknowledgement`, `operations_job_uncertain`), `infra/compose.operations.yml`, and the extracted `TRACE` entry from `scripts/test-synthetic-runtime-deployment.sh`. Zero source files in `src/`, production scripts, `infra/`, `vitest.config.ts`, or runtime configurations were modified.

## Added Regression Coverage and Narrow Fault Sensitivity

Because this branch starts from accepted `main` (`88de2ee`, containing `d4cfddd`), valid built-process stdio consumption passed immediately upon first execution and is classified honestly as **new regression coverage** rather than a previously failing product defect:

1. **Built process stdio and fault suite (`tests/health-stdio-regression.test.ts`):**
   - **Built `dist/operations/health-main.js` with kept-open writer:** Sends authored newline-framed `hostSnapshot` + `availability` over `pipe` against an instant-reset loopback TCP port (`net.createServer((s) => s.destroy())`) while keeping `child.stdin` open (`child.stdin.writableEnded === false`) through canonical stdout (`{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}`) and natural exit `0` (`304 ms` in standalone run).
   - **Fault controls on real built `health-main.js`:** `malformed-json-eof`, `malformed-json-open-timeout` (`OPS_MAX_CALL_MS=200`), `oversized-frame` (`16,385` bytes), `stalled-silent-stdin` (`OPS_MAX_CALL_MS=200`), and `invalid-schema-revision` (`bad_rev`) all exit `1`, emit zero stdout acknowledgement, log only `{"event":"operations_health","component":"postgres","state":"unknown",...}` on `stderr`, suppress DB credentials and `hostSecretMarker`, and reap owned children before temp cleanup (`231–431 ms`).
   - **Owning lifecycle (`operations_execute_job`) + extracted CI `TRACE`:** Exercises normal daemon logging vs unavailable logs (`container logs` failing), `FCD_RUNTIME_HOST_DIAGNOSTICS=closed-v1` active vs inactive equivalence with sentinel suppression, **narrow test-port fault sensitivity** dropping attached stdout (`synthetic_health_ack_diagnostic=empty`, `synthetic_health_daemon_diagnostic=completed`, exit `1`, `JOB_PHASE=uncertain`, retry refused `operations_job_pending` with zero `container/start` retries), and four fault controls (`malformed`, `oversized` 16,384-byte arg + trailing `\n` = 16,385 bytes, `stalled`, `nonzero-config`) verifying `"state":"unknown"` on stderr, `JOB_PHASE=uncertain`, and replay refusal.
2. **Real PostgreSQL integration regression (`tests/integration/postgres-health-stdio.test.ts`, gated on `RUN_ENCRYPTED_BACKUP_TESTS=synthetic-operations-toolchain-only`):**
   - Provisions an isolated PostgreSQL schema + `configureRuntimeGrants` least-privilege `<prefix>_health` role (`0600` secret file).
   - Spawns real `dist/operations/health-main.js` with kept-open stdin, verifies canonical `{"status":"completed","processed":11,"reasonCode":"ok"}` while `child.stdin.writableEnded === false`, verifies natural exit `0`, verifies exact `+11` rows inserted into `operations_health_checks` (`postgres` and `webhook` both `healthy/ok`), verifies `outbound_intents = 0`, and verifies all 5 fault classes exit `1` with zero stdout ack and zero added DB rows.
   - Guarded identically to `tests/integration/postgres-deployment-cli.test.ts` so the `postgres` CI job (which does not build `/app/dist` in `compose.test.yml`) skips cleanly while `native-operations` executes it inside `$RUNNER`.
3. **Disposable Docker + Compose + PostgreSQL native harness proof (`scripts/test-health-stdio-docker.sh`, wired into `grants` mode of `scripts/test-encrypted-backup.sh`):**
   - Verifies `$OPS` image revision/`linux/amd64`/`node` user/zero implicit image volumes, asserts absence of owned names/labels before creation, creates an `--internal` network and explicit labeled `postgres` and `backups` volumes (zero anonymous volumes), boots pinned `postgres:18.4` with generated `synthetic_pg_owner_*` password auth (no `trust`), chowns leaf secret files to `1000:1000` `0600`, executes real `operations_execute_job` for `bootstrap prepare`, `migrate`, `bootstrap converge`, and `health health` against `infra/compose.operations.yml`, compares `json-file` vs `logging: { driver: "none" }`, tests CI `TRACE` active vs inactive, exercises the narrow attached-stdout drop fault (`json-file` vs `none`), and exercises real container `malformed`, `oversized`, `stalled`, and `nonzero-config` faults verifying PostgreSQL row counts (`+11` on valid runs, `+0` on all faults), `JOB_PHASE=uncertain`, repeat refusal `operations_job_pending` with zero Docker retry calls, and fail-closed `EXIT` cleanup.

## Local Verification (Windows 4-Worker & Static Gates)

Executed on `J:\DevDrive\fcd-support-agy-health-stdio` (Node `v24.19.0`, npm `11.17.0`, Git Bash):

- `npm ci --ignore-scripts` and `npm run build` — exited `0`.
- `bash -n scripts/test-health-stdio-docker.sh scripts/test-encrypted-backup.sh` — exited `0`.
- `npx vitest run tests/health-stdio-regression.test.ts --reporter=verbose` — **1 file passed, 13 passed (13)** in `16.79s` (direct process tests `231–431 ms`; lifecycle tests `1,907–2,397 ms`, all under `5,000 ms`).
- `npx vitest run tests/health-stdio-regression.test.ts tests/integration/postgres-health-stdio.test.ts tests/backup-cleanup-regression.test.ts tests/health-transport-stress.test.ts tests/health-main.test.ts tests/operations-health-host.test.ts tests/operations-job-lifecycle.test.ts --maxWorkers=4 --reporter=verbose` — **6 files passed, 1 skipped (7); 113 passed, 38 skipped (151)** in `17.41s` (`postgres-health-stdio.test.ts` and `operations-job-lifecycle.test.ts` guarded outside `RUN_ENCRYPTED_BACKUP_TESTS=synthetic-operations-toolchain-only`).
- `npm run validate:phase0`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `node scripts/verify-security-policy.ts` (`735` tracked files), `git diff --cached --check` — all exited `0`.

## Remaining Gaps and Retained Uncertainties

- **Disposable Linux/PostgreSQL/Docker CI execution:** Pending Draft PR CI completion (`native-operations` in `.github/workflows/postgres.yml`, `ci`, `CodeQL Advanced`, `agy quality and security gate`). Immutable run/job URLs will be attached once CI completes.
- **Historical attached-output uncertainty:** As noted in `docs/handoffs/2026-11-09-antigravity-health-stdio-contract.md`, a local Docker differential did not reproduce the old reader's attached-output loss; that historical uncertainty and shared-server uncertain jobs remain unresolved and outside this task's scope.
