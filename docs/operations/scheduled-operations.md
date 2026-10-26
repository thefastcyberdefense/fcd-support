# Revision-pinned scheduled operations

Task 12 adds local host scheduler primitives. Rendering a unit generation does
not install or enable it. Actual Ubuntu installation, server execution, external
provider actions and production launch remain separately gated. All model,
outbound and n8n execution flags remain false.

`scripts/run-operation.sh JOB FULL_REVISION CONFIG_PATH` accepts only `backup`,
`maintenance` and `health`. Every invocation uses the protected literal host
configuration, exact clean checkout, local Unix Docker endpoint and shared
deployment lock. Its `verify` preflight mode permits the current live admin
socket; its stricter selection hook requires the exact revision and schema in
the `ready`, writes-possible deployment state. It refuses old checkouts, retained
image substitution, pending or uncertain jobs, lock conflicts and every outage
phase before starting a job. Timers cannot overlap deployment, migration or
restore. Docker images must already exist and match retained immutable IDs.

The host service runs as UID/GID 1000 with a read-only host filesystem except
the protected state root, bounded CPU/memory/tasks/runtime, no automatic restart
and journal output. This dedicated operator deliberately has local Docker
authority. No daemon socket or host administrative authority enters an
application or operations container. Units carry protected references and
non-secret resource settings only; mounted role secrets stay in the existing
Compose/secret-file contract.

## Literal scheduler configuration

The existing owner-only host configuration additionally requires these fields
for rendering a complete generation. Values are literal, unquoted data, with
one `NAME=value` per line. No shell expansion is performed.

| Field                                | Accepted value                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `FCD_BACKUP_CALENDAR`                | systemd calendar literal, 1–128 bytes                                          |
| `FCD_MAINTENANCE_CALENDAR`           | systemd calendar literal, 1–128 bytes                                          |
| `FCD_HEALTH_CALENDAR`                | systemd calendar literal, 1–128 bytes                                          |
| `FCD_MAINTENANCE_SLOT_SECONDS`       | integer 1–86400                                                                |
| `FCD_TIMER_TIMEOUT_SECONDS`          | integer 1–86400                                                                |
| `FCD_TIMER_MEMORY_MIB`               | integer 32–16777216                                                            |
| `FCD_TIMER_TASKS_MAX`                | integer 16–16777216                                                            |
| `FCD_TIMER_CPUS`                     | existing positive CPU literal: up to three integer and three fractional digits |
| `FCD_TIMER_ACCURACY_SECONDS`         | integer 1–3600                                                                 |
| `FCD_TIMER_RANDOMIZED_DELAY_SECONDS` | integer 0–3600                                                                 |

Calendar literals allow ASCII letters, digits, spaces and `*,:./+_~-` only.
Leading dashes, controls, newlines, percent specifiers, quotes, backslashes and
shell syntax are refused. The renderer passes each entire calendar as one
argument to `systemd-analyze calendar --`. Validation does not execute the value.
The calendars and slot interval are explicit operator settings; this work does
not change lifecycle retention or learning policy defaults.

Synthetic example additions, to be reviewed against the approved operating
schedule before use:

```text
FCD_BACKUP_CALENDAR=*-*-* 02:00:00 UTC
FCD_MAINTENANCE_CALENDAR=*-*-* *:00/5:00 UTC
FCD_HEALTH_CALENDAR=*-*-* *:*:00 UTC
FCD_MAINTENANCE_SLOT_SECONDS=300
FCD_TIMER_TIMEOUT_SECONDS=900
FCD_TIMER_MEMORY_MIB=256
FCD_TIMER_TASKS_MAX=128
FCD_TIMER_CPUS=1
FCD_TIMER_ACCURACY_SECONDS=1
FCD_TIMER_RANDOMIZED_DELAY_SECONDS=0
```

`scripts/render-systemd-units.sh FULL_REVISION CONFIG_PATH DESTINATION` uses the
same preflight and requires a new destination under a protected UID/GID-1000,
mode-0700 directory outside Git, configuration, secret, state and socket roots.
It creates mode-0600 files in an exclusive staging directory, checks the complete
generation with `systemd-analyze verify`, synchronizes it and publishes it without
overwriting an existing destination. It writes no unit output before validating
all scheduler fields and calendars. It never invokes `systemctl`.

## Catch-up and acknowledgement rules

Backup and maintenance timers use `Persistent=true`; health uses
`Persistent=false`. There is no startup backup or loop over missed intervals.
Each backup activation requests the current UTC daily slot and current UTC
calendar-month slot once. PostgreSQL owns slot completion. Creating or revisiting
a completed slot returns the same opaque archive reference. Both exact archives
must pass separate verification before retention pruning runs. Verification or
job failure stops the sequence. Daily/monthly retention remains 45/6 under the
existing policy.

Maintenance floors the current UTC time to `FCD_MAINTENANCE_SLOT_SECONDS` and
passes that slot boundary plus a stable `scheduled:JOB:EPOCH` reference to
retention, deletion, lease recovery and learning, in that order. Durable run
records make a repeated slot idempotent. Learning uses complete bounded windows;
no missed-slot replay loop extends work after host downtime. PostgreSQL remains
authoritative for retention, consent, deletion and conversation state.

Every job follows the existing stopped-create, verified ownership/image/command,
journal-before-start, wait, exit check, bounded-log acknowledgement, removal and
absence-check lifecycle. The executor returns a success acknowledgement only
after cleanup and durable journal completion. It accepts closed canonical result
shapes: fixed completed counts, permitted zero-count `skipped/not_due` results
for backup/maintenance, and opaque backup references for the reference-returning
backup commands. Arbitrary diagnostics never count as success. Timeouts,
configuration failures, failed pool closure or lost acknowledgements preserve
uncertainty and require reconciliation; activation does not silently replay them.

## Health during PostgreSQL outages

Health executes `node dist/operations/health-main.js health`, with health-only
`stdin_open: true`. The host pipes at most 16 KiB of content-free JSON through
`docker container start --attach --interactive`, then performs the same wait,
exit, log acknowledgement and removal checks. No stdin JSON enters command
arguments, environment variables or the durable job journal. No admin listener,
admin credential, Docker socket or provider client is acquired by health.

After its pools close, a handled PostgreSQL outage returns exit zero and exactly
`{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}`.
Only the health job accepts that outcome. Normal completion is the same canonical
shape with `reasonCode: "ok"` and a bounded processed count. Fixed journal events
use only event/component/state/time. Configuration, close and timeout failures
do not produce a completed acknowledgement.

The protected `health-outage` state file retains the earliest observed outage
time and latest failed observation across host invocations. A later health run
receives that bounded gap over stdin. Repeated outages preserve the earliest
time; only a confirmed healthy PostgreSQL completion clears the marker after
recovery is recorded. Invalid or interrupted marker files fail closed. The
collector bounds gap replay and records sanitized incident transitions in
PostgreSQL after recovery. Neither the marker nor a journal entry authorizes
deployment or promotion.

Before the health job, the host collects a strict metadata snapshot through
`operations-health-host.sh`. It resolves the exact API/admin/reply actors and
configured tunnel actor, samples their running/health/revision/start identity
before and after bounded local API, socket and heartbeat probes, and rechecks
application actor IDs. It performs no SQL job, provider request or external public
check. Only validated state/time fields enter the health stdin object alongside
any outage gap. Missing, malformed, foreign or changed host evidence omits the
snapshot; PostgreSQL availability collection still runs and unverified components
remain unknown. Manifest attestation and public-route evidence remain
`not_verified` until separately approved checks supply them. Raw inspect data,
environment values and heartbeat content do not leave the host collector.

Portable contracts cover literal configuration, arguments, state/revision/image
refusal, slot references, stop-on-failure, exact acknowledgements and health stdin.
The separate Linux lane covers protected filesystem publication, actual
`systemd-analyze` validation and the complete journaled job transport using
synthetic fakes. No installed host timer or server evidence is claimed here.
