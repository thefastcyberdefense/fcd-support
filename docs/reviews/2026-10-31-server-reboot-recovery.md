# Fresh server drill and post-reboot recovery action

Date: 2026-10-31 (Asia/Dhaka).
Source: `67a4a4bede6d3252dc936a6e410f4b90c1359ac3`.
Action records were committed/pushed at `7afffd5` before execution.

## Actual server results

- The new deployment passed its final verification and saved-baseline audit.
  Independent checks confirmed READY/no job, four healthy non-root/read-only
  actors, no published ports and the fresh restore target absent.
- Backup/replay verified three signed archives and unchanged authenticated
  metadata after replay. Public runtime verification and full audits passed.
- Protected synthetic restore preparation and isolated restore completed.
  The source became quiescent with one completed restore record and no job;
  the full preservation audit still matched immediately before promotion.
- Public promotion and runtime verification passed. The selected target volume
  and distinct physical identity match the saved promoted selection; both
  source/restored volumes remain. No new active job exists.
- The passive observer exited 0. Its protected file contains eight schema-valid
  records: ready, container start, challenge 1, challenge 2, command completed,
  container die, container destroy and observer finished. These are diagnostic
  observations, not independent SQL-outcome authority.
- The post-promotion preservation audit refused changed start/network metadata.
  The original drill stopped before rollback. No old job or new stage was retried.

## Direct read-only diagnosis

A host reboot occurred during the drill: the captured baseline predates current
boot and the bounded Docker journal spans two boot identities with a current
initialization. Seven of 14 protected actors have new start/endpoint metadata.
Actor identities, all other actor definitions, protected files and volumes match.
Only the default bridge identity/creation changed; custom network identities,
definitions and member identities match. Two current observations are stable.
Original admission properties pass. The reboot initiator is not established;
missing clean-shutdown/automatic-reboot messages do not establish its cause.

The fresh API, reply and PostgreSQL are healthy. The fresh admin is restarting/
unhealthy, with closed `admin_service_start_failed` output and a protected
1000:1000:0600 socket under a 0700 root that refuses connections. The application
correctly preserves the stale socket. Persisted READY is not current verification.
The original saved baseline and completed promotion evidence remain untouched.

## Separately reviewed continuation proposal

`docs/operations/actions/2026-10-31-reboot-recovery-67a4a4b.py` is a new one-use
recovery action under the owner's standing private synthetic-server authority.
It does not resume the refused original action, rerun promotion, settle a job,
change application guards or switch to an old volume.

Read-only `--inspect` passed. The strict reboot comparator permits only the
observed running-actor start/endpoint and default-bridge changes. Unknown fields,
mounts, ports, static address requests, custom network identities, membership,
stopped actors, protected files and volumes must remain exact. The cross-boot
journal is required; current boot and Docker invocation are pinned. A separate
protected current baseline is written only after admission, preserving the old.

`--recover` records a one-use intent, stops only the exact fresh admin under the
deployment lock, requires exited/non-restarting identity, invokes the unchanged
public `recover-admin-socket.sh` outside that outer lock, requires its exact
acknowledgement, then starts the same unchanged admin under the lock. No manual
unlink, permission change, container replacement or retry is allowed. Existing
public guards independently require the exact inode and refused connection.
After configured bounded health readiness, current public verify and full
preservation/binding checks must pass before recovery is marked complete.

`--rollback` is a separate one-use stage requiring that completion, unchanged
boot/daemon, current public verification, exact fresh selection/configuration/
restore record/retained bundle and no pending job. It invokes unchanged
same-revision compatible rollback once, verifies the public runtime and requires
the restored volume/physical identity plus both retained volumes. Every refusal,
lost acknowledgement, further restart or preservation drift stops continuation.
`--audit` retains full strict comparison against the separate current baseline.

The tests run only authored synthetic fixtures and temporary files. The positive
reboot case failed with the initial rejecting stub, then passed after the strict
comparator implementation. Eleven test methods pass, including gateway/prefix and
unknown-field rejections, eight runner failure subcases, exact stop/recovery/
start/verify order, missing completion acknowledgement, one-use recovery/rollback
and immutable-binding rejection after successful rollback/verify. Python syntax
and `git diff --check` pass. Independent review and committing/pushing these
concrete records are required before execution. No recovery/rollback has run yet.

Task 11/P6-004, Task 15 and P6-GATE remain open. AGY may correct its evidence map
but implementation remains dependency-gated until Codex records Task 11 complete.

Independent review found three Important omissions: gateway/prefix fields were
too broadly exempted, immutable fresh bindings were not rechecked after rollback/
audit, and old restart policies were not pinned. Nine new negative assertions
reproduced the routing/binding defects RED, then passed after correction. The
new guard keeps gateway/prefix exact, compares every immutable binding after
rollback and in audits, and separately requires all three old targets exited/
restart-disabled while pinning every protected actor policy. The legacy baseline
projection remains unchanged. Corrected read-only admission passed again.

Final scoped independent review: all three Important findings addressed; no
remaining Important/Critical finding. Reviewed action SHA256 is
`6e930af71dc755a8cab72f7ddb0ebeef2694e7fda1cb8220b7165a6f0f11a897`.
The reviewer independently passed all 11 hermetic methods and diff checks.
All four workflows for unchanged application source `67a4a4b` already pass.
The corrected action's fresh read-only admission passed before this commit.
Recovery and rollback remain unexecuted at this record's commit point.
