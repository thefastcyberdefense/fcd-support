# Pre-upgrade observation of other-project container lifecycle changes

Date: 2026-11-03 (Asia/Dhaka).
Scope: read-only Task 16 admission. No deployment or timer repair has run.

The original b1e183d preservation baseline no longer matches five other-project
actors' lifecycle metadata. All five physical IDs still exist; no actor was
added or lost. Current starts fall between 03:47:24 and 03:47:36 UTC on November 3.
Four actors were and remain running; one was and remains exited. Their health
values are unchanged (two healthy, three without health checks). Restart deltas
are -1 for one actor and 0 for the other four. Recorded changes are start time,
network endpoint ID/MAC and that one counter reset.

After isolating only those fields, every recorded configuration, IP, mount,
network membership, network ID/creation, volume, saved state file, host boot pin
and Docker invocation pin matches. A second raw observation is stable under
the existing comparator and its previously reviewed legacy-admin exception.
The available Docker event buffer contains only six exec events for these
actors; it does not establish the cause or operator of the earlier changes.
No cause, successful execution or historical continuity is inferred.

The existing single healthy +1 restart qualifier correctly refused this
different observation. The original baseline and all older uncertain journals,
data and incident records remain unchanged. No command targeted another
project, restarted Docker/the host, or settled SQL from an absent actor.

## Proposed bounded admission

Under the owner's standing authority to progress the isolated test deployment
while protecting other projects, the new upgrade action proposes one explicit
pre-action observation window, 03:47:20–03:47:40 UTC. It requires exactly the
five same-ID non-FCD/non-synthetic actors, unchanged state/health with the exact
observed distribution, exact counter deltas, and no changed static fields
beyond start/endpoint metadata. Every configuration/IP, volume, file, membership
and host/daemon pin must still match the old baseline. Added/lost actors,
changed FCD actors, different state/health, later restarts or other drift refuse.

The action must capture a fresh **raw** baseline before mutation, retain a
separate private qualification record anchored to the immutable original
baseline fingerprint, and compare that raw baseline again before and after its
own work. The qualification is never used during deployment or final audit.
It records an observed difference; it does not rewrite the original history
or modify another project. Independent review and actual admission remain
required before execution.

Tests use authored 2030 dates and synthetic actors only. Four new tests first
failed before implementation; all eight configuration/window tests now pass
on Windows. They cover additional/lost actors, configuration/IP/volume/file/
boot drift, different time/counter/health/state, FCD ownership and fixture actors.
Actual combined Linux validation and execution are recorded separately.
