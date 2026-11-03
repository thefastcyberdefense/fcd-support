# Scheduled verification under the read-only host sandbox

Date: 2026-11-03 (Asia/Dhaka).
Scope: Task 16 actual systemd backup preflight failure on application b1e183d.

## Failure and correction

The owner ran the reviewed root installer once. Its four exact units were
installed and systemd reloaded. The first real backup activation then exited 1
with `operations_socket_root_invalid`, before creating an operations job.
Maintenance and health were not executed; all three timers remain disabled.
The original start marker, helper and installed generation remain preserved.

`operations_scheduled_main` uses the shared `verify` preflight mode. The socket
root check required directory write access for every action. This contradicts
the intentional host unit sandbox: `ProtectHome=read-only`, with only the state
root writable. Verification only needs read/traverse/connect access.

The correction exempts only `verify` from the write predicate. UID/GID 1000,
read/traverse access, canonical path, exact 0700 ownership/mode, protected
ancestors and disjoint-root checks remain. Deploy, rollback, restore, promotion,
socket recovery and internal lifecycle actions still require writes. The unit
sandbox is unchanged.

## Executed regression evidence

The new native test uses the existing test-owned Docker read-only volume with
UID/GID 1000 and mode 0700. A direct write must receive kernel `EROFS`; the shell
must see readable/executable but not writable. It runs the real
`operations_socket_root` without replacing its filesystem predicates.

- RED before the source correction: **1 failed / 65 passed**, exit 1, 3.27 s.
  Only the read-only verification case failed, with the expected closed code.
- Initial GREEN: **66 passed**, exit 0, 2.67 s.
- Final expanded matrix: **68 passed**, exit 0, 3.29 s, including internal
  private-startup and database-convergence. All mutating actions refuse the
  read-only root and accept the equivalent writable control; directory listings
  remain unchanged. Command:
  `bash scripts/test-encrypted-backup.sh state tests/operations-scripts.test.ts`.
- The first full Windows gate stopped at a forbidden test-only non-null
  assertion. It was removed. Corrected `VITEST_MAX_WORKERS=4 npm run check`:
  **1,961 passed / 446 platform skips**, 131 files, 258.29 s; phase-0 validation,
  formatting, lint, strict type checking and build all exited 0. The eight new
  mount-specific cases skip on Windows and passed separately on native Linux.

## Retained first-head CI failure

On source `b73188e`, CI, CodeQL and PostgreSQL/native operations passed. Private
runtime run 41581877934 passed its precreated lane, including recovery/cleanup,
but the fresh disposable lane stopped at health after deploy, verification,
private HTTP, maintenance and backup passed. The owning journal remained
uncertain. Closed trace reached the final log/acknowledgement boundary after
terminal checks; it did not expose the acknowledgement body or establish its
failure class. Do not claim this lane passed or infer its SQL outcome.

Synthetic-only diagnostics now classify health acknowledgements as empty,
completed, dependency_unavailable, carriage_return, multiple_lines or unexpected.
Only these fixed enums enter failure reporting; no body or arbitrary value is
published. Test-first RED: six new classifier cases failed before implementation.
Affected suites then passed **47 tests / 59 platform skips**, 2.61 s; lint and
type checking exited 0. These diagnostics do not alter runtime job acceptance,
clear uncertainty or retry a failed journal. New exact-head CI remains required.

Read-only server reinspection confirms the backup failure, absent active job,
preserved start marker, absent completion record, all three timers disabled and
inactive, no service drop-ins, and zero container bind sources under private
temporary directories. This inspection does not run a service or infer SQL
completion. Independent review found no actionable defect in the correction.

## Remaining execution

Deploy a reviewed fixed revision through the public managed controller while
preserving the existing synthetic project, database identity, configuration
roots, secrets and admin identity. Build all three revision-labelled images;
change only the target revision and image pins in protected operations config.
Retain the prior config and original failed-installation evidence.

A new reviewed root continuation must accept only the exact installed old
generation and inactive/disabled timer state, then install the exact new
generation, run actual backup/maintenance/health and enable the three timers
only after success. Do not replay the original installer, manually edit deployed
source, weaken the sandbox, or change another project. Task 16 remains OPEN.
