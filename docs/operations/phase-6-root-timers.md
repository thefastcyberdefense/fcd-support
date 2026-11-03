# Finish the private test server timers

Date: 2026-11-03 (Asia/Dhaka).
Status: **COMPLETE — owner root execution and independent post-root verification passed. Do not rerun either installer.**

The corrected application `24e5667` is deployed on the existing private synthetic
project. Its database/volume identity, secrets and existing admin identity are
preserved. Actual backup, maintenance, health, SSH password/MFA, dashboards,
logout/revocation and strict post-auth preservation passed. The reviewed repair
helper ran once successfully after owner terminal authentication. All three
services passed, the timers are enabled/active, installed hashes/hardening match,
and separate public runtime/strict preservation checks passed. Task 16 is COMPLETE.
See `../reviews/2026-11-03-phase-6-task-16-closeout.md`.

## Historical successful command — do not rerun

The owner ran this once in their own terminal and authenticated sudo only
there. It is retained as execution evidence; do not rerun it or share credentials.

```powershell
ssh -t -o StrictHostKeyChecking=yes redwan@192.168.10.40 'sudo /usr/bin/python3 -I /home/redwan/fcd-support-p6-timer-upgrade-20261103/repair-timers.py'
```

The exact noninteractive `sudo -n` invocation returned password-required before
executing the helper. This is an OS authentication requirement; the scoped
action already has owner authorization and independent review.

Helper SHA256:
`80efc0052ebff2bb270c1d40e5df6a7780dd7026ebae9fe330a85863b453725f`.
It is mode 0400, UID/GID 1000, and binds accepted source
`24e56679c9c29823b210ca6991608f83de556156` plus the exact four rendered unit pins.
Review: `../reviews/2026-11-03-task-16-timer-repair.md`.
Actual server evidence: `../testing/2026-11-03-phase-6-server-24e5667.md`.

Actual final closed outcomes:

```text
task16_exact_timer_generation_repaired=true
task16_real_scheduled_services_passed=true
task16_three_timers_enabled_active=true
```

The helper accepts only the exact old installed generation, matching completed
upgrade, clean source/config/READY state, disabled timers and absent drop-ins.
It preserves old bytes/markers, atomically replaces only the changed service,
retains the sandbox, then tests backup/maintenance/health sequentially with
persistent systemd references. Only after success does it enable the three
exact timers. It never restarts Docker/the host or changes another project.

If refused/interrupted, preserve all evidence and do not rerun it. Share only
the closed refusal stage/outcome. Activation failure attempts to stop/disable
only the three timers and reports whether containment is verified; it never
stops an already dispatched service or clears/settles a journal. Failed
completion publication removes only its owned success record.

Post-command unit/service/timer inspection, public runtime verification and
strict preserved-inventory comparison all passed. The root-owned completion
record and both old/new start markers are retained. Phase 6 Task 16 is complete;
future changes use a new concrete reviewed action and current timer/source pins.

## Historical first installer refusal

The original b1e183d installer ran once and installed the four exact units.
The first real backup activation then refused with
`operations_socket_root_invalid`, exit 1, before creating a job. Maintenance
and health did not run and all timers remained disabled. The original helper,
root start marker and unit bytes are retained. **Never rerun that old installer.**

The defect required directory writes even for verification under the deliberate
`ProtectHome=read-only` sandbox. PR #8 permits only verification to read/traverse;
all mutating operations still require write access. The sandbox is unchanged.

No live provider/model/Meta/n8n/tunnel/production-number action is included.
Older uncertain scopes and original incident records stay protected. Full-host
restart and remaining current live acceptance evidence belong to later work.
