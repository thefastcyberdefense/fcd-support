# Track 2D Implementation Plan: Operator Tooling, `--mode private-enabled`, and `v1` Timer Alignment

> Execute test-first in `codex/track2d-operator-tooling` worktree. Keep all existing `private-disabled` contracts and container hardening intact.

## Tasks

1. **Gap G-1: Signed Synthetic Webhook Probe CLI**
   - Add failing unit tests in `tests/meta/webhook-probe.test.ts` covering GET challenge validation (`200` / `403`), POST raw-byte HMAC signing (`valid`, `invalid`, `unsigned`), oversized rejection, closed route `/health` `404`, and zero secret/payload leakage in output.
   - Implement `src/meta/webhook-probe.ts` and `src/meta/webhook-probe-main.ts`.
   - Verify targeted Vitest suite green.

2. **Gap G-3: Read-Only Content-Free `db-counts` CLI**
   - Add failing schema/leakage unit tests in `tests/operations-db-counts.test.ts` and non-superuser PG integration test in `tests/integration/postgres-db-counts.test.ts`.
   - Implement `src/operations/db-counts.ts`, wire `db-counts` into `src/operations-main.ts`, and add bounded `maintenance/db-counts` support in `scripts/operations-job-lifecycle.sh`.
   - Verify unit and PG integration tests green.

3. **Gap G-5: Non-Interactive Multi-Role CLI Provisioning**
   - Add failing tests in `tests/admin-provision.test.ts` and `tests/integration/postgres-admin-provision.test.ts` covering empty-DB batch provisioning (`administrator` + `knowledge_editor` + `knowledge_reviewer` + `support_reviewer`), non-empty DB provisioning using existing admin `actorAccountRef` / `actorLoginName`, idempotent replay, unauthorized actor denial, and secret-free output.
   - Implement `src/admin/admin-provision.ts` and wire `--provision-stdin` in `src/admin/admin-bootstrap.ts` while leaving interactive masked TTY `runAdminBootstrap` unchanged.
   - Verify unit and PG integration tests green.

4. **Gap G-4: `--mode private-enabled` Support Across Runtime Scripts and Verifiers**
   - Add failing tests in `tests/operations-compose-environment.test.ts`, `tests/operations-controller.test.ts`, `tests/operations-startup-script.test.ts`, `tests/operations-health-host.test.ts`, `tests/runtime-host-script.test.ts`, `tests/runtime-host-fixture.test.ts`, and `tests/phase6-compose-contract.test.ts`.
   - Implement `--mode private-enabled` in `scripts/operations-common.sh`, `scripts/operations-startup.sh`, `scripts/operations-runtime-host.sh`, `scripts/operations-health-host.sh`, `src/operations/compose-contract.ts`, `src/operations/runtime-host-main.ts`, `src/operations/runtime-host.ts`, and `tests/helpers/runtime-host-fixture.ts`.
   - Verify all runtime/compose/script Vitest suites pass on Windows and Linux.

5. **`v1` Systemd Timer Alignment**
   - Add failing alignment/rejection tests in `tests/systemd-contract.test.ts`.
   - Harden `scripts/render-systemd-units.sh` and add read-only `scripts/verify-systemd-units.sh` (without invoking `systemctl` or enabling/modifying `/etc/systemd/system`).
   - Run `tests/systemd-contract.test.ts` and Linux container checks.

6. **Full Verification & Stacked Draft PR #29**
   - Format docs with `npx prettier --write --ignore-path .gitignore`, run `validate:phase0`, `format:check`, `lint`, `typecheck`, `build`, `VITEST_MAX_WORKERS=2 npm test`, `verify-ui-ux-contract`, `verify-security-policy`, `npm audit --omit=dev --audit-level=high`, WSL PG 18 integration suite, and Linux `16 MiB /tmp` Docker `unit`, `restore`, `grants` lanes.
   - Verify PR body via `scripts/verify-pr-handoff.ts` and open Draft PR #29 targeting `codex/track2c-private-media-extraction`.
