# Phase 6 Restore DNS Isolation

The synthetic server's source PostgreSQL container advertises both the source
and isolated-target aliases on its operations network. Its first restore-stream
job became uncertain after the source logged a PostgreSQL authentication failure.
The removed job's exact DNS result is unavailable, so this is a likely mechanism,
not proof of that individual connection. An isolated local Docker reproduction
showed the target hostname resolving to the source when both aliases exist;
with separate aliases it resolved only to the target.

The runtime PostgreSQL service must advertise the source alias, and never the
isolated-target alias, on its operations network. The isolated PostgreSQL
service must advertise the target alias, and never the source alias, on its
restore network. The rendered Compose contracts and the actual restore and
promotion host checks must enforce these boundaries. Restore may converge an
older quiescent source with conflicting aliases before any target-connected job
runs. Normal Docker-generated service/container names are not treated as the
explicit reserved aliases.

Verify the actual rendered aliases and DNS resolution on fresh, labelled local
Docker networks, including a deliberately colliding negative control. Test
missing, substituted, duplicated and conflicting aliases in the contracts and
host guards. Preserve the interrupted server restore intent, uncertain job,
override and both volumes. This correction authorizes no replay, job clearing,
production change, provider call or server mutation.
