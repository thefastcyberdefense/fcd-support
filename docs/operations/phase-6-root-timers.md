# Finish the private test server timers

Date: 2026-11-03 (Asia/Dhaka).
Status: **Partial installation; backup service refused. Task 16 remains OPEN.**

## Actual owner execution and refusal

The owner executed the published sudo command once. The helper reached
`real_service_backup` and returned `timer_install_refused_stage=real_service_backup`.
Read-only inspection confirms all four exact unit files are installed, the root
start marker exists and the completion record is absent. Backup exited 1 with
the closed preflight code `operations_socket_root_invalid`; no active operations
job was created. Maintenance and health were not executed. All three timers
remain disabled. Preserve these units and the original helper/marker; **do not
rerun the command below**.

The shared socket-directory admission incorrectly requires write access even
for `verify`, which is also the scheduler's preflight mode. The actual hardened
service deliberately has `ProtectHome=read-only` and only the state root in
`ReadWritePaths`. The correction must allow read/traverse access for verification
while retaining write access for every mutating action, including socket
recovery. Do not weaken the unit sandbox or edit the deployed immutable source.
A tested source correction and separately reviewed continuation are required.

## Historical installation preparation

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
