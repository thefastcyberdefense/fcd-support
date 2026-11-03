# Finish the private test server timers

Date: 2026-11-03 (Asia/Dhaka).
Status: **Root step pending. Do not call Task 16 complete yet.**

The final-source private deployment, operations, separate audits and actual SSH
password/MFA/dashboard/origin/CSRF/logout proof passed. The last server step is
installing/testing the four rendered systemd units. Owner authorization already
covers this scoped action; the remaining constraint is OS privilege. sudo -n
is unavailable. Enter any sudo password only in your own SSH terminal.

The reviewed helper is committed/pushed and provisioned at:

`/home/redwan/fcd-support-p6-final-b1e183d/install-timers.py`

Helper SHA256:
`f20831c688d22db8b7c08556334e2e67e0a4ec32c63214d9a94c0b7ca3967d94`.
It is owner-only mode 0400 and binds exact application source
`b1e183df3e7c319483f863346925b38c4f149ba5` plus the four existing unit hashes.
Review: `../reviews/2026-11-03-task-16-root-timers.md`.

Provisioning/hash and owner mode 1000:1000:0400 are verified. The exact
noninteractive sudo attempt returned password-required before executing the
helper. Run once from your own terminal:

```powershell
ssh -t -o StrictHostKeyChecking=yes redwan@192.168.10.40 'sudo /usr/bin/python3 /home/redwan/fcd-support-p6-final-b1e183d/install-timers.py'
```

The helper refuses stale source, changed generation, collisions, pending jobs,
unsafe ownership or inherited drop-ins. It writes only the four exact new unit
files, reloads systemd, runs the three private services sequentially as UID/GID
1000, then enables only backup/maintenance/health timers. It does not restart
Docker, the host or other projects and keeps external execution flags false.

Expected final closed outputs are:

```text
task16_exact_timer_units_installed=true
task16_real_scheduled_services_passed=true
task16_three_timers_enabled_active=true
```

If refused or interrupted, preserve the marker/units and stop. Do not rerun it,
overwrite units or paste private logs/credentials. Share only the closed stage
and outcome. Codex then performs read-only unit/service/runtime verification,
records actual evidence, updates Task 16 and commits/pushes the final handoff.
Until then installation, root sandbox execution and timer activation remain
unproven. Earlier uncertain scopes and original incident records stay protected.
