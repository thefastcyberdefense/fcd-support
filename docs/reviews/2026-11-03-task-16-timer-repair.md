# Task 16: reviewed managed upgrade and exact timer repair

Date: 2026-11-03 (Asia/Dhaka).
Status: **Concrete artifacts approved; real upgrade/root execution pending.**

## Accepted application source

PR #8 merged as `24e56679c9c29823b210ca6991608f83de556156`. Its entire tree is
identical to tested `3c5959642d6ce4247d838d1b013298fbf26fe56e` (Git comparison
exit 0). Full local check: **1,968 passed / 446 platform skips**, 131 files,
253.76 s; phase-0 validation, formatting, lint, strict types and build passed.
The direct native socket-root matrix passed **68 tests**, 3.29 s.

All four exact-head workflows passed:

- [CI 41609801292](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41609801292).
- [CodeQL 41609801294](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41609801294).
- [PostgreSQL/native 41609801218](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41609801218).
- [Private runtime 41609801270](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41609801270),
  both fresh and precreated lanes.

Earlier failed heads remain in
`../testing/2026-11-03-scheduled-readonly-socket.md`. The observer capture-state
bug was reproduced test-first and corrected. The original first-head health
failure remains unattributed; do not infer its SQL result. AGY has an independent
stress assignment in `../handoffs/2026-11-03-antigravity-health-transport-stress.md`.

## Non-root managed upgrade

Artifact: `../operations/actions/2026-11-03-timer-upgrade.py`.
Reviewed SHA256:
`b24f640f8a900c1b39a7d6e83c98b646ef4c005db7d83201ed9e03ba63f5ca8f`.

The one-use action retains the current b1e183d synthetic project, physical
database/volume identity, schema, roots, secret files and synthetic admin
credential file. It checks the exact old installed units and disabled/inactive
timers, and uses the public managed deployment controller. Only the revision
and three target image pins change in protected operations.env. All three
target images carry the accepted revision. Its own lock covers checkout,
build and atomic config transition; the public controller owns its execution
lock. Final completion reacquires the lock and rechecks the exact READY
selection/config, absent pending records, source and preservation evidence.

The pre-action lifecycle qualification is documented separately in
`../operations/incidents/2026-11-03-pre-upgrade-lifecycle-window.md`. The original
baseline is preserved. Qualified comparison uses its single-read bytes and
fingerprint; the new raw baseline is used strictly during/final execution.
No historical continuity or restart cause is claimed.

The b1e183d checkout predates publication of the preservation helper. Provision
its exact existing bytes separately at
`/home/redwan/fcd-support-p6-timer-preservation-20261103.py`, mode 0400,
UID/GID 1000. SHA256 must be
`5d8434c1b9ae5406b84a6b1bf463b2991851c4334a2598b2584014138f30f6f5`.
The action verifies and executes those same in-memory bytes under a non-main
name. It never edits the old tracked source to import the library.

Independent read-only review approved the concrete action for publication,
provisioning, inspection and one execution after admission passes. It excludes
claims of actual execution and does not authorize replay after failure.

## Root continuation

Artifact: `../operations/actions/2026-11-03-timer-repair.py`.
Reviewed SHA256:
`80efc0052ebff2bb270c1d40e5df6a7780dd7026ebae9fe330a85863b453725f`.

Run only after the real non-root upgrade produces its matching completion
record and unit generation. The new service hash is
`ffcd3f695df0073e8cb34012704787667088aabbbef005499dec4a668150ee37`;
all three timer hashes are unchanged. These pins were derived read-only from
the exact old generation with only its full revision replaced. Only the
changed service file is atomically replaced; unchanged timer inodes remain.

The helper requires root UID/GID, isolated Python (`-I`), clean accepted source,
matching generation/config/READY state, exact old root-owned files, no drop-ins,
and inactive services/disabled timers. It preserves the original root start
marker and unit bytes. It compiles the exact verified installer-library bytes
without reopening operator-writable code and clears inherited environment
overrides before using the installed system D-Bus binding.

A private persistent system-bus connection holds RefUnit for each exact
backup/maintenance/health service across actual start, result and fresh
monotonic execution-time verification. References are released in finally and
the connection closed. [systemd's D-Bus interface](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html)
defines these reference methods. The non-root binding probe required interactive
authorization before taking its first reference; **root authorization and real
service execution have not yet been tested**.

Only after all three services pass are the three timers enabled/started. Any
activation/completion error attempts to stop and disable only those timers and
verifies containment, or reports it unverified. It never stops an already
dispatched service or clears/settles a journal. Failed completion publication
removes only its own success-record inode, preserving foreign replacements and
all start/history evidence. Failure requires inspection, never a blind rerun.

Independent read-only review approved the concrete root artifact for publication
and provisioning, conditional on actual upgrade success and owner-credential
execution. No actual root/D-Bus/service/timer outcome is inferred from review.

## Artifact validation and boundaries

Test-first guards cover exact four-pin config edits; malformed/duplicate input;
bounded lifecycle qualification with IP/config/volume/file/boot drift refusal;
fixed-name atomic replacement and cleanup; service pin/unpin and failure/stale
execution refusal; exact-timer containment; and post-write directory-fsync
failure with foreign-inode preservation.

Final actual Linux scratch execution: **8 upgrade tests + 9 repair tests passed**,
zero platform skips, scratch removed. These are hermetic filesystem/service-port
tests; no helper entrypoint, Docker operation or systemd start ran. Windows:
8 upgrade tests passed; 5 repair tests passed / 4 Unix skips.

Task 16 remains OPEN. No other-project command, host/daemon restart, tunnel,
Meta, live provider/model/n8n or production-number action is included. All old
uncertain scopes, original baselines and incident evidence stay protected.
