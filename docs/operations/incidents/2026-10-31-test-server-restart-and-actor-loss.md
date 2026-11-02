# Test server restart and missing stopped actors

Date: 2026-10-31 (Asia/Dhaka).
Status: **OPEN for older actor loss/attribution. Readiness restored at d96382d
is historical; the 2026-11-02 read-only preflight finds admin unhealthy again.
Original preservation is not restored.**

## Post-reboot observations before scoped repair

The historical `3f22344` rollback-only execution and its separate full audit
passed on exact application `67a4a4b`. A subsequent additional check did not run
because approval review hit a usage limit. After the owner resumed many hours
later, the current kernel boot and Docker invocation no longer matched the saved
pins. No completed recovery or rollback was replayed.

Two current observations were stable. Seven previously stopped protected actors
are absent, including all three preserved older restore-target PostgreSQL
containers. No replacement protected actor was found. The seven remaining
protected actors have changed start/endpoint metadata; no other field difference
was observed in their legacy projection. Protected old state-file fingerprints
and volume metadata match; volumes remain present. This does not establish
unchanged database contents or settle any uncertain SQL job. Current old-target
restart-policy/actor checks cannot pass when those actors are absent.

The current fcd-support test stack has four pinned, read-only runtime actors
without host ports. API/reply/PostgreSQL are healthy; admin is restarting with a
stale socket and the configured inert ingress canary exists but is exited.
The checkout remains clean at tested `67a4a4b`. Immutable fresh configuration,
secret metadata, restore evidence and bundle match the successful drill.
Actual `pg_controldata` system identity matches the restored selection. API-local
namespace requests returned the expected 403/404/401. These do not prove current
private-ingress or admin readiness; no current admin HTTP 200 is claimed.

## Restart and cleanup diagnosis

The guest reports Microsoft virtualization. Prior-boot records show a clean
reboot, one logged sudo shutdown/reboot request and a logind reboot request.
The inspected prior-boot kernel records contain no observed OOM, panic,
watchdog-lockup or storage-error record. Explicit unattended automatic reboot
was not enabled; readable cron configuration showed no reboot/global-prune
command. These negative observations are bounded, not proof of absence.

Current-boot retained Docker events showed no prune or matching destroy event.
They cannot reconstruct who removed the stopped actors. No cleanup source or
operator identity is attributed. Owner clarification was requested; the owner
reaffirmed delegated decisions and explicitly required protecting other projects.
No new authorization to clear journals, replace evidence or alter another project
is inferred.

## Containment and permitted work

- Preserve every state record, baseline, image and remaining volume. Do not
  recreate/start an old uncertain target or treat missing actors as settlement.
- Keep current server mutation stopped under the refused old admission. Any new
  fcd-support-only recovery requires a concrete fresh scope/observation, review,
  committed records and explicit preservation of this incident evidence.
- Do not reboot the guest, restart/reconfigure Docker, prune globally, change
  shared infrastructure, other projects, tunnels or production assets.
- Continue independent approved local failure tests on an isolated review branch.
  Historical Task 11 closes for its bounded proof; P6-004/005/006 and P6-GATE
  remain open. Current readiness must be verified separately before later use.

## Scoped current-readiness recovery proposal

After the owner reaffirmed delegated decisions and required protecting other
projects, Codex prepared a new one-use record:
`docs/operations/actions/2026-10-31-current-runtime-recovery-67a4a4b.py`.
Read-only admission passed. The required pinned operations image remains present;
no old network was missing or replaced, and all seven missing actors were
historically exited. No old actor is reconstructed or treated as settled.

The new record preserves original evidence and records the missing set separately.
It admits the current surviving inventory only after strict restart comparison,
unchanged old files/volume metadata, remaining restart policies, actual restored
PostgreSQL identity, immutable fresh bindings and the successful historical
rollback marker. It pins the current boot/daemon. It captures digests of
unrelated containers/network metadata and global volume inventory, omitting
other projects' environment, command arguments, opaque labels and driver secrets.
These are checked throughout; no operation targets another project.

Its only mutations are exact current admin stop, unchanged public inode-bound
socket recovery, same admin start and exact same inert canary start. Configured
bounded health and unchanged public runtime verification must pass. A new private
completion marker is written only after all checks. There is no restore,
promotion, rollback, old-scope reconstruction, global prune or Docker-daemon/VM
change. Another refusal/restart/drift stops this one-use attempt.

Five pure/hermetic methods pass, including nine quarantine rejection cases,
12 runner fault cases, exact permitted actor/order checks and single-use refusal.
The initial valid quarantine case was RED before its implementation, then GREEN.
Independent scoped review found no Important/Critical issue and independently
passed all five methods/diff checks. Reviewed action SHA256:
`7c5d7e53b4445472904c1e9a15e7cfbf62818f85f41392870c83f955bb9cfa0e`.
Commit/push precedes execution. The proposal has not executed at this record.
Even a successful new audit covers the surviving/current inventory and recorded
missing set; it does not restore original preservation or resolve actor loss/SQL.

## Verified current readiness after scoped repair

The reviewed action was committed/pushed as `d96382d` before execution. It ran
once and exited 0 with `current_fcd_private_readiness_verified=true`. Its separate
`--audit` exited 0 with `current_fcd_recovery_audit_passed=true`.
Independent read-only checks then passed:

- All four pinned non-root/read-only private runtime services are healthy.
- Protected owner-only Unix admin login returns HTTP 200.
- Actual private ingress canary requests return 403 (unverified challenge),
  404 (private health route absent) and 401 (unsigned synthetic event).
- Actual PostgreSQL control identity matches the selected restored database;
  source/restored volumes remain. No restore/promotion/rollback was repeated.
- No owned operation or socket-recovery helper actor remains.
- Unrelated-project container/network metadata digests and global volume
  inventory match before/after. No command targeted another project or changed
  shared Docker-daemon/VM/tunnel configuration.
- Historical evidence and the seven-actor missing set remain unchanged.

The new audit proves preservation of the current surviving inventory during this
scoped repair. It does not restore the original actor set, attribute prior cleanup
or settle uncertain SQL. Keep this incident OPEN for that separate disposition.
Task 11's bounded closeout stands; aggregate Phase 6 gates remain unfinished.

## Later read-only observation: 2026-11-02

Fresh checks find the retained `67a4a4b` checkout clean. API/reply/PostgreSQL
are running and healthy; its admin is restarting/unhealthy (580 restarts at
the first observation). All three retained admission actors are running.
No previous completion marker is rewritten and no repair is replayed.
These observations supersede the earlier readiness statement for current use;
they do not invalidate the bounded historical execution.

The independently reviewed local P6 gate now passes after PR #5 correction and
the full local topology execution. That local result does not repair this
server or resolve missing actors. The incident remains contained: retained
volumes, journals, baselines, surviving actors and uncertain scopes are not
reconstructed, cleared or settled. Attribution is not required for unrelated
fresh isolated local validation.

Task 16 preparation prefers a fresh synthetic project, preserving the retained
stack and all unrelated projects. Any tolerance for the observed exact admin
restart cycle must be explicit and bounded to that actor; it must not permit
other state/topology changes or replace original preservation evidence. No
new server mutation has run at this checkpoint.
