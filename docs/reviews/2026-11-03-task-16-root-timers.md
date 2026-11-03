# Task 16 scoped root timer installer review

Date: 2026-11-03 (Asia/Dhaka).
Status: **Reviewed and prepared; no root installation or activation has run.**
Helper: `docs/operations/actions/2026-11-03-install-timers.py`.
SHA256: `f20831c688d22db8b7c08556334e2e67e0a4ec32c63214d9a94c0b7ca3967d94`.
Tests SHA256: `9c14a90eb8f2fe2ce157f8a90a18ffec73e2867a2bc5734c74ab612a691e0553`.
Application source: `b1e183df3e7c319483f863346925b38c4f149ba5`.

## Exact action and privilege boundary

The owner already authorized the isolated server deployment. This final step
requires actual OS root privilege; noninteractive sudo is unavailable. No
password is collected, sudo policy changed or Docker privilege used to bypass
that boundary. The owner runs the published helper in their own SSH terminal.
The model performs all preparation and read-only checks first.

The helper accepts no arguments and requires Linux UID/GID 0:0. It admits only
the exact clean selected checkout, protected deployment-completed marker,
private source generation and four embedded SHA256 pins. Before any install,
public runtime verification runs as UID/GID 1000 with initialized groups,
no-new-privileges and a bounded sanitized environment. Root never runs the
repository verifier as root.

The destination and ancestors must be real root-owned, nonwritable directories.
All four names, three concrete instances, project-specific drop-ins and timer
wants links must be absent. Under the current deployment lock it rechecks ready
state, exact project/revision, no pending job and immutable source bytes. It
creates a one-use marker, then writes only the four fixed basenames through an
anchored directory descriptor using O_EXCL/O_NOFOLLOW. No old unit is overwritten.
A write failure rolls back only this call's matching newly created inodes;
foreign files are preserved. Files become root-owned mode 0644 and are fsynced.

After syntax verification and systemd daemon-reload, all effective drop-ins are
refused and service UID/GID must be 1000. This does not restart Docker, the host
or another project. The lock is released before sequential real oneshot backup,
maintenance and health service executions. Each must report Result=success and
ExecMainStatus=0. Only then are the three exact timers enabled/started and checked
active/enabled. A root-owned completion record contains only revision/unit pins
and closed outcomes. A post-install failure preserves units/marker for review;
it never performs a blind reinstall or broad cleanup.

## Independent review and validation

Independent read-only review found **no Important or Critical finding** after
checking source, tests, templates, renderer and scheduler. It confirmed exact
writes, privilege drop, drop-in refusal, sequential service checks and partial
failure preservation. It did not execute root operations or independently
verify live metadata or previously reported tests. Those remain actual-execution
conditions; no deferred minor finding was reported.

RED/GREEN validation covers exact pins, changed/missing/extra/traversal/oversize
inputs, exclusive mode-0644 writes, collisions, symlink destination, partial
ENOSPC rollback preserving an unrelated file, protected source read, source
symlink/hardlink/mode rejection and root destination ownership. Final real-Linux
non-root scratch run: **nine tests passed**, **0.042 s**; scratch removed. Windows:
**two passed / seven Unix skips**. No systemd entrypoint ran in these tests.

Actual read-only server checks pass: all four source bytes match the embedded
pins; generation directory/files have expected private numeric ownership/modes;
destination/ancestors are root-owned and safe; target names/specific drop-ins are
absent; installed setpriv supports both flags. Public deployment/audit and actual
SSH password/MFA evidence is in `../testing/2026-11-03-phase-6-server-b1e183d.md`.

Commit/push and provision the exact mode-0400 helper before asking the owner to
run it. Root installation, real systemd resource/sandbox execution and active
calendars are not claimed until that command succeeds. No other-project,
provider, Meta, tunnel, production or old-uncertain-scope action is authorized.

## Publication and noninteractive privilege check

The reviewed helper was committed/pushed at ab3bb00 and its private server copy
is verified byte-for-byte at mode 0400, UID/GID 1000:1000. The exact sudo -n
command returned password-required (exit 1) before invoking it. No privileged
write or systemd service/timer execution is inferred. Owner terminal execution
and subsequent read-only verification remain required.
