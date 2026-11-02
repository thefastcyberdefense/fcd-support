# Hardened Runtime Operator Guide

Phase 6 runtime controls, split restore, private admin, and failure-matrix coverage
have been validated across local, unit, native, and PostgreSQL test lanes (PR #3
`df8e52d`, PR #4 `c74b6f4`). Command availability and component tests do not
establish a completed deployment, recovery, or production gate. The exact server
action record is `phase-6-server-deployment.md`; current limitations and validation
are in `runtime-deployment-safety.md`. Final server deployment (Task 16) and
P6-GATE review remain open under Codex authority.

## Source and protected inputs

Operate from a clean checkout of an approved full Git revision. Build the
application, operations and PostgreSQL images from that revision using the pinned
Dockerfiles. The controller checks actual image identities, revision labels,
architecture and non-root users; a mutable tag alone is insufficient.

The literal configuration file is operator-owned, mode `0600` or `0400`, under
protected ancestors. It contains only accepted `FCD_*` settings. It is parsed
as data and must never be sourced as shell code. Configuration, secrets, state,
socket source and repository roots must remain distinct. Required directories
are independently provisioned with their documented numeric ownership; a
controller refusal does not authorize widening permissions or automatic repair.

Keep service credentials in individual role-specific files. PostgreSQL remains
authoritative. Each worker and operation uses a dedicated restricted role;
bootstrap owner credentials and all role passwords never enter the application
containers. Restore keys are absent from ordinary backup creation. Models,
outbound sending and n8n remain explicitly disabled in the private deployment.

## Deployment, verification and rollback

Use these exact public interfaces with real approved parameters:

```bash
bash scripts/deploy-runtime.sh FULL_REVISION --mode private-disabled CONFIG_PATH
bash scripts/verify-runtime.sh FULL_REVISION CONFIG_PATH
bash scripts/rollback-runtime.sh FULL_RETAINED_REVISION --confirm-schema-compatible CONFIG_PATH
bash scripts/operations-drain.sh FULL_REVISION CONFIG_PATH
```

The host flock serializes operations. Durable selection, immutable volume/image
history and a separate job journal preserve uncertainty across interruption.
Fresh initialization refuses pre-existing storage or interrupted intent.
Updating an existing database verifies ownership/storage before stopping apps,
drains only verified actors using the safe drain procedure (`scripts/operations-drain.sh`),
verifies a pre-migration encrypted archive and applies forward transactional migrations.
Startup checks physical identity, schema, roles, deployment metadata, socket and
actual Docker topology.

Rollback uses retained images and the selected database only when the recorded
schema exactly matches. It does not rebuild an old revision, down-migrate or
automatically return to another volume after possible writes. Keep both volumes
and all uncertain evidence after a failure. Never edit a journal or selection
file to make a refusal disappear. Interrupted operation recovery still requires
its complete validation evidence; this guide grants no manual bypass.

For an interrupted restore whose original labelled target volume still exists
and is demonstrably empty, the private close-out is:

```bash
bash scripts/abandon-empty-restore.sh RESTORE_REF FULL_REVISION CONFIG_PATH
```

It preserves the intent and target, permanently reserves the target names and
records a content-free proof. It refuses missing or nonempty targets, pending
jobs, changed source identity, ambiguous Docker state and foreign binds. It
cannot settle an uncertain SQL job, authorize promotion or select storage. A
new restore still needs a different target and every normal restore gate. This
command has local synthetic evidence; server-specific proof is recorded
separately before it can be considered validated there.

## Private dashboard and socket recovery

Admin listens only on the owned mode-`0600` Unix socket under its independently
provisioned mode-`0700` directory (`/run/fcd-support-admin/admin.sock`). Runtime services
publish no Docker host ports. Remote administration uses the separately verified SSH
loopback-TCP-to-remote-Unix forward (e.g., forwarding `127.0.0.1:LOCAL_PORT` to
`/run/fcd-support-admin/admin.sock`). The SSH client loopback forward does not publish
or create a server Docker port. The browser port and origin must match the admin
configuration; retaining host-key checks, authentication, MFA, session checks,
CSRF and signed actions is required.

A stale or substituted socket blocks startup. Only this separate command may
remove a freshly verified stale socket belonging to the verified stopped actor:

```bash
bash scripts/recover-admin-socket.sh FULL_REVISION --confirm-admin-stopped CONFIG_PATH
```

It refuses live, uncertain, non-socket, wrong-owner and replaced entries. Do not
delete a socket manually or introduce a TCP listener to get past this check.

## Scheduling, health and manual coverage

Timers pin revision, configuration and slot, use the same operation lock and
preserve durable job identity. Scheduled catch-up is bounded strictly to the current
execution slot and deduplicated via the authoritative PostgreSQL catalog rather than
queuing or replaying missed past slots. Synthetic native tests verify timer execution
logic, but real host systemd timers are not installed merely because tests pass.
Backup verification precedes retention pruning; scheduled maintenance uses its
restricted role and current physical identity.

The private operations dashboard displays minimized health, queue, archive and
incident metadata with authenticated acknowledgements. It does not expose raw
messages, credentials, provider bodies or dumps. Health collection is independent
of n8n. The signed n8n adapter owns only notification attempts and never
conversation, escalation, consent or delivery authority.

External uptime alerts remain deferred to Phase 7. Dashboard and journal evidence
cannot notify an operator while the host is powered down. Staff must retain manual
Meta Business Suite coverage and check readiness after downtime; old events do not
become eligible for automatic replies merely because the server restarts.

## Verification boundary

Use the complete unit, PostgreSQL, native operations/restore and topology lanes,
then the concrete server and test-asset checks. Record exact revision, counts,
durations, skips and failure outcomes. Keep test fixtures authored and synthetic.
No production number, Page, public route, provider credential or live traffic
change follows from passing a local component test.
