# Generated maintenance fixture correction

Date: 2026-11-02 (Asia/Dhaka).
Base: `14ff26aef7d81978015e0ec114766aac722aa01c`.
Correction branch: `codex/p6-maintenance-fixture`.
The exact immutable correction head and CI outcomes are recorded in its PR.

## Problem and change

The fresh server attempt at `6d0210d` stopped at retention with an uncertain
maintenance journal. Read-only inspection and source review found that the
generator emitted a comment-only maintenance.env while the CLI requires a
learning policy, learning window and outbound bounds before opening its pool.

The helper now authors those three fields explicitly for the synthetic role.
Reply and maintenance share the same outbound-bounds object. No application
default, production limit, policy cadence or execution flag changes. The
compiled CLI integration control reads the generated common/maintenance files
instead of supplying the missing inputs manually.

Disposable private-runtime CI now invokes the real owning maintenance scheduler
before backup/restore/promotion/recovery. Its four subcommands must finish with
no active job and a ready selection. Maintenance failure has a closed diagnostic
stage and blocks all later recovery steps. Existing failure/refusal checks are
preserved.

## Executed validation

These are separate overlapping lanes, not a combined coverage count.

- Producer/consumer regression: initially failed on undefined JSON, then passed.
- Closed maintenance-stage diagnostic: initially reported unknown, then passed.
- Focused fixture/evidence/recovery tests: **26 passed**, three files, 6.21 s.
- Full Windows `VITEST_MAX_WORKERS=4 npm run check`: exit **0**, **1,955 passed /
  438 platform skips**, 131 files, **262.38 s**, including Phase 0, format,
  lint, strict types and build.
- Local Docker/native `bash scripts/test-encrypted-backup.sh grants`: exit **0**,
  final `encrypted_backup_local=true`. Native units: **1,298 passed**, 55 files,
  **422.09 s**. PostgreSQL grants: **139 passed / one restore-only skip**,
  13 files, **69.52 s**. This includes the real compiled maintenance CLI using
  freshly generated configuration and its foreign-identity refusal control.
- The native harness also passed its image/mount, network-adoption, secret
  ownership, restore-subnet, empty-target and scoped-cleanup checks.

Independent read-only code review found no Important/Critical issue, conditional
on these checks and the corrected-source CI maintenance/recovery run. That CI
run is still a required integration condition, not claimed passed in advance.

## Retained failed checks

Initial static checks rejected non-null assertions, then required explicit string
narrowing; the test now uses the same bounded string parsing as the real CLI.
An intermediate full check failed nine old recovery-source extraction cases
(1,945 passed / 438 skips, 275.69 s). The harness test now locates the CI block
without assuming backup is its first statement, executes maintenance too, and
asserts a maintenance failure prevents later proof/switch/cleanup.

The first native attempt stopped at `backup_runner_build_failed` before suites
ran. An isolated build of the same runner Dockerfile then succeeded and the
full native retry passed. No cause is assigned to that initial build failure.

## Server and authority limits

This correction does not settle the server's uncertain job, repair its original
baseline, attribute the missing unrelated actor or claim a new server fix.
The `6d0210d` journal/override/database and all older uncertain scopes remain
untouched. Do not rerun its one-use action. See
`docs/operations/incidents/2026-11-02-final-deployment-maintenance.md`.

Any later server attempt requires a fresh source/project and reviewed admission
with explicit missing-set quarantine. Actual SSH/admin proof, timer rendering/
privileged installation and final Task 16 handoff remain open. No live model,
Meta, n8n, tunnel or production action is included in this fix.

## Exact-source integration accepted

PR #6 merged as `7af70cc77196813b92d8365567150153996b790a`. Its complete tree
matches reviewed `e6652496c24db30a486e08b618e74e74cf74a569` (`git diff --quiet`,
exit 0). All four PR workflows passed:

- CI: [41489228568](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41489228568).
- CodeQL: [41489228400](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41489228400).
- PostgreSQL/native: [41489228447](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41489228447).
- Private runtime: [41489228486](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41489228486).

The PostgreSQL job reports 621 passed / 52 skipped. Native operations reports
1,298 native tests, 139 grants tests / one restore-only skip, 252 encrypted
backup/restore tests and 47 isolated-restore tests. These overlapping lanes
are not summed. Both fresh and precreated private-runtime logs contain closed
success markers for real maintenance, backup, checkpoint, restore, promotion,
rollback, recovery and scoped cleanup. This closes the correction's CI condition.
A first local fetch after merge failed to connect to GitHub:443; an unchanged
standard retry succeeded. No credential or network-policy workaround was used.

The two exact labelled local diagnostic images were removed after checking
labels and zero consumers; zero matching diagnostic images remain. No global
Docker pruning or shared-server cleanup occurred.
