# Test server restart and missing stopped actors

Date: 2026-10-31 (Asia/Dhaka).
Status: **OPEN — current preservation/readiness refuses; no old-scope repair.**

## Confirmed observations

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
