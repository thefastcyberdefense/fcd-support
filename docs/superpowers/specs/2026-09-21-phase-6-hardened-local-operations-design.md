# Phase 6 Hardened Local Operations Design

Status: written specification approved by the project owner on 2026-10-04.
This document authorizes implementation planning only. Implementation, local
Docker execution, Ubuntu deployment, external-service changes, test-asset
traffic, and production actions remain subject to their recorded gates.

Date: 2026-09-21

## Purpose

Phase 6 turns the locally tested Phase 1 through Phase 5 application into a
reproducible, private, recoverable Docker deployment for the existing Ubuntu
server. It packages the webhook admission API, private admin dashboard,
asynchronous processing, model use, outbound delivery, notifications,
maintenance, backup, restore, and operational health without making Docker,
n8n, Manifest, or process memory authoritative.

The target host is the existing local Ubuntu server at `192.168.10.40`. Windows
remains the only source-authoring, commit, and push host. The server deploys
only an exact clean Git revision pulled into `/home/redwan/apps/fcd-support`.
The design preserves the continuously reachable Cloudflare Tunnel while
exposing only the exact Meta webhook routes.

## Success Criteria

Phase 6 succeeds when:

- one exact committed revision produces pinned, revision-labelled application
  and operations images;
- every long-running role has only the filesystem, secret, network, database,
  and resource access it needs;
- PostgreSQL, Manifest, n8n, admin, health, metrics, workers, and operations
  commands have no public route;
- migrations, encrypted backup, isolated restore, deletion reconciliation,
  promotion refusal, and compatible application rollback are repeatable;
- operational health and incident state is content-free, PostgreSQL-backed,
  visible in the authenticated private dashboard, and mirrored to sanitized
  host logs without depending on n8n;
- n8n receives only authenticated, idempotent, minimized notifications and
  cannot mutate authoritative application state;
- local Docker validation covers the required positive and negative network
  paths with synthetic data and local fakes; and
- the resulting runbook can deploy the approved build to the local Ubuntu
  server without touching production Meta assets or enabling customer/model
  traffic.

## Scope

Phase 6 includes:

- pinned application, operations, PostgreSQL, and Cloudflare Tunnel images;
- role-specific Compose services for the API, admin dashboard, event/reply
  worker, outbound worker, and notification worker;
- one-shot services for migrations, backup, restore, reconciliation,
  verification, and scheduled policy jobs;
- separate ingress, data, model, provider-egress, and notification network
  attachments;
- mounted-file secret loading and fail-closed configuration validation;
- non-root, read-only-compatible containers with explicit writable storage,
  capability removal, health checks, PID limits, and CPU/memory limits;
- exact-revision deployment, drain, migration, verification, and rollback
  orchestration;
- encrypted daily/monthly backups with validated configurable retention;
- isolated restore and mandatory deletion-tombstone reconciliation before
  application attachment;
- PostgreSQL-backed health, backup, deployment, and incident metadata;
- private dashboard operational views and acknowledgement controls;
- host-managed systemd timers that invoke revision-pinned one-shot containers;
  and
- authenticated, idempotent private n8n notification delivery.

## Non-goals

Phase 6 does not:

- change Cloudflare DNS, tunnel routes, or the public hostname;
- connect, unlink, migrate, register, subscribe, or otherwise alter a
  production WhatsApp number or Facebook Page;
- send a Meta message, call a live Manifest provider, or use customer data;
- disable Manifest recording or change live Manifest provider/fallback rules;
- replace or reconfigure the independently owned Manifest or n8n stacks;
- make n8n, Manifest, Docker health, a systemd timer, or the dashboard an
  authority for conversation, consent, deletion, retention, or delivery;
- add direct Telegram, SMTP, pager, or other external operational alerting;
- claim that a local server can report its own complete power or network loss;
- automate destructive database down migrations or overwrite a live database
  volume during restore;
- provide off-site disaster recovery or production promotion; or
- supersede the P7 test-asset, P8 production-readiness, or separate production
  promotion gates.

## Selected Deployment Structure

The selected structure is a layered Compose deployment.

1. A runtime Compose definition owns the FCD Support application roles and
   PostgreSQL.
2. An operations overlay or closed profiles provide one-shot migration,
   backup, restore, verification, and maintenance commands.
3. The already hardened Cloudflare Tunnel remains independently managed and
   joins only the external FCD Support ingress network.
4. Existing Manifest and n8n deployments remain independently managed. FCD
   Support joins only their approved private networks.
5. Host systemd units call repository-owned, exact-revision orchestration
   scripts. No container receives a Docker socket merely to schedule another
   container.

This structure was selected over one monolithic Compose file because
operational jobs must not start accidentally with the runtime. It was selected
over many independent Compose projects because shared revision, configuration,
network, migration, and rollback validation would otherwise drift.

## Runtime Roles

| Role                  | Responsibility                                                  | Required attachments                            | Prohibited attachments                                             |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `postgres`            | Authoritative state                                             | data, database volume                           | ingress, model, provider-egress, notification, host port           |
| `webhook-api`         | Meta verification and durable admission                         | ingress, data                                   | model, provider-egress, notification, host port                    |
| `admin`               | Authenticated dashboard and reviewed controls                   | data, loopback host binding                     | ingress, model, provider-egress, notification, public host binding |
| `reply-worker`        | Apply admitted events, FAQ/model decisions, escalation creation | data, model                                     | ingress, provider-egress, notification                             |
| `outbound-worker`     | Claim authorized outbox work and call exact Meta endpoints      | data, provider-egress                           | ingress, model, notification                                       |
| `notification-worker` | Deliver minimized notification work to private n8n              | data, notification                              | ingress, model, provider-egress                                    |
| operations jobs       | Migrate, back up, restore, reconcile, verify, retain, delete    | only the network/volume required by the command | ingress and unrelated service networks                             |

The same revision-labelled application image may supply multiple application
commands, but each command constructs only its own dependencies. A role must
fail startup if an unused credential or network is required, because that
would indicate boundary drift.

## Network Topology

### Ingress network

`fcd-support-ingress` contains only the independently managed Cloudflare
Tunnel and `webhook-api`. The tunnel routing policy continues to expose only
exact `GET /webhooks/meta` and `POST /webhooks/meta` matches with an
ingress-level `404` catch-all. The API publishes no host port.

### Data network

`fcd-support-data` is internal and contains PostgreSQL plus application roles
that need database access. PostgreSQL has no published port. Migration,
backup, and data-policy jobs join this network only for their bounded run.

### Model network

The existing approved private Manifest network is external to the FCD Support
Compose project. Only `reply-worker` joins it. The Manifest base URL uses the
verified Docker service alias, never a LAN-published address. The webhook API,
admin, outbound worker, notification worker, and operations jobs do not join
the model network.

Manifest use remains fail closed unless the dedicated `fcd-support` harness,
`model: "auto"`, no-tools request, recording-disabled attestation, deletion
and retention approval, provider allowlist, protected limits, and private route
are all verified.

### Provider-egress network

Only `outbound-worker` receives general bridge egress required for Meta HTTPS.
The application continues to build exact pinned Graph endpoints internally,
reject redirects, and reject caller-supplied hosts or paths. No inbound port is
published on this network.

### Notification network

The notification network is the approved existing private n8n network. Only
`notification-worker` joins it. The configured URL must resolve to the
approved private service and is not accepted when public, loopback-ambiguous,
credential-bearing, or outside the configured private origin contract.

### Management access

The admin dashboard binds to `127.0.0.1` on the Ubuntu host. Remote operator
access uses an SSH tunnel or a browser on the host. A later explicit decision
may add an approved private management network, but Phase 6 creates no public
admin route. Private health and metrics are dashboard data, not tunnel routes.

## Image And Container Contract

Production dependencies remain exact in `package-lock.json`. Every base image
is pinned by immutable digest. The application and operations images carry the
full Git revision label and are tagged with that full revision. Deployment
refuses a tag, label, checkout, or requested revision mismatch.

Application roles run as the existing unprivileged Node user. PostgreSQL runs
as its image's unprivileged database user. Operations images define an
unprivileged runtime user except for an image-proven initialization step that
cannot operate otherwise; any exception must be documented and contract
tested.

Every long-running container has:

- a read-only root filesystem;
- only named volumes, tmpfs paths, and narrowly scoped read-only secrets that
  its role requires;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- an explicit PID limit;
- configurable validated CPU and memory limits;
- an explicit restart policy and health check; and
- no privileged mode, Docker socket, device, host PID, host network, or broad
  host-filesystem mount.

Resource values are operator-configurable protected settings with validated
safe ranges. Missing values fail configuration validation rather than silently
enabling generous defaults.

## Configuration And Secrets

The non-secret runtime environment file contains revision, service aliases,
ports, schedules, retention counts, timeouts, resource bounds, and feature
attestations. Secret values use individual mode-`0600` files under the
protected FCD Support configuration directory and are mounted read-only into
only the role that consumes them.

The application adds one shared file-secret loader and rejects:

- missing, blank, oversized, or non-UTF-8 secret files;
- world/group-readable source files where the deployment verifier can inspect
  permissions;
- a secret supplied simultaneously by incompatible sources;
- a database URL, token, password, or key placed directly in checked-in
  Compose content; and
- secret values in validation errors, process arguments, Compose evidence,
  logs, health output, or dashboard data.

Secret classes include PostgreSQL authentication, Meta channel credentials,
Manifest key, n8n signing secret, admin session/MFA keys, privacy HMAC
keyring, Cloudflare token, and restore identity. Each role receives only its
subset. OpenClaw and Hermes keys are never accepted as aliases or fallback
inputs.

## Runtime Coordination

The webhook API is independently restartable and performs only signature
verification, normalization, and durable admission. It does not call Manifest,
Meta outbound APIs, or n8n.

The reply worker claims admitted application work from PostgreSQL, applies the
existing event and policy pipeline, resolves approved FAQ first, and uses the
private Manifest route only when permitted. The worker writes a safe draft and
content-free escalation on closed failure.

The outbound worker uses the existing leased outbox. Shutdown first stops new
claims, waits no longer than the configured provider timeout plus a bounded
grace period, then exits. Existing crash and lease rules decide whether work
returns to pending or becomes `delivery_unknown`; orchestration never blindly
requeues it.

The notification worker claims only durable notification work. Core business
transactions complete according to their existing authority rules even when
n8n is unavailable. Notification retry state remains in PostgreSQL.

Worker polling, batch size, concurrency, lease, shutdown grace, retry,
timeout, and cooldown settings are configurable and validated against the
protected ceilings or floors already established by the Phase 4 and Phase 5
policies. They are not compiled-in enabling defaults.

## Host Scheduling

Ubuntu systemd timers invoke exact-revision repository scripts for:

- frequent content-free health collection;
- daily encrypted backup and monthly retention classification;
- retention and verified-deletion maintenance;
- expired model/outbound lease reconciliation;
- proposal-only learning digest generation; and
- any other reviewed bounded maintenance command added by the implementation
  plan.

Each unit uses a fixed working directory, protected environment path, explicit
timeout, non-overlapping lock, and closed exit codes. It never embeds a secret
in the unit, command line, or journal. Each called script verifies the clean
checkout, exact deployed revision, image revision label, and expected Compose
definition before running a one-shot container.

Missed timers may run once after the host returns only when the underlying job
is idempotent and its retention/event-time rules permit it. They never treat
server downtime as permission to send stale automated replies.

## Operational Health And Dashboard

Phase 6 uses a dashboard-first operational model. It does not add a direct
Telegram, SMTP, or other external alert adapter.

PostgreSQL stores content-free operational records for:

- service/component code and closed health state;
- check time, duration bucket, bounded reason code, and consecutive failures;
- opened, acknowledged, resolved, and last-observed incident times;
- deployed application revision and schema revision;
- last successful backup, backup class, age, verification state, and encrypted
  archive reference;
- worker queue counts and oldest-age buckets;
- Manifest readiness attestations and last private-path check;
- tunnel readiness and last exact public positive/negative route check; and
- n8n notification queue and delivery outcome counts.

No health record contains customer content, external identity, provider
message ID, URL/query, payload, prompt, response, database connection string,
secret, raw exception, or arbitrary external text.

The authenticated admin dashboard presents current status, history, backup
age, migration state, aggregate backlog, and open incidents. Incident
acknowledgement requires the existing session, MFA, role, same-origin CSRF, and
signed-action protections. Acknowledgement does not change the underlying
health result.

The health collector mirrors only a fixed event code, state, and timestamp to
the host journal. If PostgreSQL is unavailable, the database-health failure is
still written to the journal; the next successful run records the bounded
outage interval in PostgreSQL. n8n is not involved in health authority or
dashboard visibility.

Complete power, host, or Internet loss cannot be reported by this local-only
version while it is offline. The dashboard shows the gap after recovery, and
staff retain manual Meta Business Suite coverage. External uptime notification
is deferred to a later approved version.

## Encrypted Backup

The backup job creates a PostgreSQL custom-format dump and streams it directly
through the pinned `age` CLI with an X25519 recipient. Backup creation uses
only the encryption recipient/public key. The decryption identity/private key
is absent from the normal runtime and backup job and is mounted only into a
separate approved verification or restore job. The operations image verifies
the pinned encryption release checksum during its build.

The encrypted archive is written to a staging name in a dedicated backup
volume, synced, and atomically renamed only after dump and encryption success.
The job then records a content-free catalog row containing an opaque backup
reference, class, creation time, source revision, schema revision, encrypted
size, ciphertext digest, and verification state. Plaintext dumps are never
written to persistent storage.

The host may copy only the encrypted archive and content-free manifest from
the named backup volume into a dedicated protected archive directory. The
container receives no host-directory mount. Off-site replication is outside
Phase 6 and remains an ownership decision for P8.

Schedule and retention values are configurable. Validation enforces the
approved minimum of 45 daily and 6 monthly archives; an operator may retain
more but cannot configure fewer without a reviewed policy change. Pruning
occurs only after a new archive is complete and verified and never removes the
only known-good archive.

Every backup run verifies the ciphertext digest and successful completion of
the dump/encryption pipeline. A separate verification job streams decryption
into `pg_restore --list`, suppresses its content-bearing output, and retains
no plaintext. A pre-migration archive must pass that separate verification
before migration begins. A full isolated restore is required quarterly and
before relying on a materially changed backup toolchain. Routine backup jobs
never acquire the restore identity.

## Deployment And Migration

The deployment workflow is:

1. Verify an exact 40-character approved revision, clean checkout, protected
   file permissions, required non-secret configuration, and expected networks.
2. Render and validate the Compose configuration without printing secret
   values.
3. Pull pinned third-party images and build revision-labelled application and
   operations images.
4. Run static image/container contract checks.
5. Drain claim-based workers while leaving webhook admission available when
   the schema compatibility contract permits it.
6. Create and verify an encrypted pre-migration backup.
7. Run the forward migration once in a one-shot container under a deployment
   advisory lock.
8. Start or replace the runtime roles without recreating authoritative volumes.
9. Verify schema/revision agreement, private health, worker readiness, network
   membership, no unintended host ports, exact public callback behavior, and
   the public negative route.
10. Record a content-free deployment outcome and retain the prior compatible
    image for rollback.

If the backup, migration, startup, or verification step fails, new workers stay
stopped and the system enters the documented safe state. The API may remain
available only when its binary and the current schema are explicitly
compatible; otherwise the safe state is a controlled outage with manual staff
coverage.

Migration files remain versioned and test up, down, and reapply behavior, but
deployment never runs an automatic down migration. A migration that cannot be
forward-compatible must declare the required outage and rollback constraints
in its implementation task and runbook.

## Rollback

Application rollback selects an already retained full-revision image only
after schema compatibility is verified. The rollback command refuses to build
an old image implicitly, change the schema, or start an image whose embedded
revision differs from the requested revision.

Database rollback is not a down migration and never overwrites the live
volume. It is an isolated restore into a new volume followed by forward
migrations, deletion reconciliation, and the same promotion gate used by any
restore. If customer or test-asset writes occurred after a database switch,
switching back to the older volume is prohibited because it could discard
authoritative events. Recovery must instead use the reviewed restore-forward
procedure.

The always-safe rollback is to stop automated workers and API processing,
preserve all volumes and images, and use manual staff coverage while evidence
is reviewed.

## Isolated Restore And Promotion Gate

Restore creates a new uniquely named PostgreSQL volume and an isolated Docker
network that has no API, worker, admin, Manifest, n8n, ingress, or provider
attachment. The restore identity is mounted only into the one-shot decrypt and
restore command.

The restore workflow:

1. Select one catalogued encrypted archive by opaque reference and verify its
   ciphertext digest.
2. Decrypt as a stream and restore into the new isolated PostgreSQL instance.
3. Validate PostgreSQL/catalog health and the recorded source schema.
4. Apply forward migrations required by the target application revision.
5. Import a complete current deletion checkpoint from the quiesced authoritative
   source, including deletions committed after the selected archive. Verify its
   completeness watermark and signature, then load every required active
   deletion-tombstone HMAC key version from mounted secrets. A checkpoint found
   only inside the selected archive is insufficient. If the current source or
   an independently preserved complete checkpoint is unavailable, promotion
   fails closed.
6. Reapply all unexpired deletion tombstones in bounded batches using the
   existing Phase 3 restore-deletion gate.
7. Run the complete lock-safe content-free scan and verify its persisted pass
   record, unchanged revision material, zero remaining matches, and complete
   checklist state.
8. Quarantine inherited model, reply, outbound, and notification work so that
   a restored pre-dispatch state cannot repeat an external effect that occurred
   after the archive. Record content-free recovery evidence and run migration,
   aggregate integrity, and application compatibility checks.
9. Record a content-free restore outcome.

Any missing key, decryption error, migration failure, incomplete scan,
remaining match, concurrent change, checklist gap, or ambiguous result fails
closed. The restored database remains isolated and cannot be attached to the
application data network.

Promotion is a separate explicit command. It reruns the final gate while the
database is isolated, stops all application roles, selects the verified new
volume in protected non-secret deployment state, starts PostgreSQL, and only
then starts compatible application roles. The previous volume is retained
unchanged until the rollback retention decision is reviewed.

Planning review on 2026-10-04 clarified the encryption-verification role and
the post-backup deletion/external-effect requirements above. They implement
the approved key-isolation, deletion, and no-blind-resend guarantees; they do
not grant new external-action authority.

## Private n8n Notification Integration

P6 adds a PostgreSQL notification outbox and append-only attempts if the
existing closed notification records cannot safely express delivery. Each item
has an internal source reference, closed notification type, idempotency key,
state, next-attempt time, attempt count, retention deadline, and timestamps.
It contains no customer text, external identity, correction value, export,
provider message ID, prompt, or arbitrary error.

The notification worker sends one bounded request to the configured private
n8n endpoint with:

- a schema version;
- the closed notification type;
- internal opaque reference;
- occurrence time;
- idempotency key; and
- an HMAC signature over the canonical bounded body and timestamp.

Redirects, public destinations, oversized responses, malformed success,
authentication failure, timeout, and transport ambiguity produce closed local
outcomes. Retries are configurable and bounded. n8n must deduplicate the
idempotency key and may notify staff, but it cannot acknowledge privacy work,
change consent, resume AI, enqueue outbound messages, resolve delivery, or
write authoritative state.

Local contract tests use a loopback fake with synthetic credentials and retain
only structure, counts, and booleans. Live n8n workflow mutation or credential
creation is not authorized by P6 implementation.

## Failure Behavior

| Failure                           | Required behavior                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PostgreSQL unavailable            | Webhook work is not falsely acknowledged; workers stop claims; host journal receives a fixed code                |
| Manifest unavailable or unsafe    | FAQ remains deterministic; model path produces the approved safe response and one escalation                     |
| Meta timeout or ambiguous result  | Existing outbox records `delivery_unknown`; no blind resend                                                      |
| n8n unavailable                   | Notification work remains durable with bounded retry; core state is unchanged                                    |
| Tunnel unavailable                | No alternate public port is opened; dashboard/history records the failure when possible; manual coverage applies |
| Migration fails                   | New revision stays stopped; database and pre-migration backup are preserved                                      |
| Backup fails                      | No partial archive becomes eligible; deployment migration does not proceed                                       |
| Restore reconciliation fails      | Restored volume remains isolated and promotion is refused                                                        |
| Health collection fails           | Fixed host-log event; bounded incident recorded after database recovery                                          |
| Worker shutdown exceeds grace     | Process exits; existing lease/unknown-delivery rules determine recovery                                          |
| Required secret/config is missing | Only the affected role fails startup with a closed reason; no value is printed                                   |

## Validation Strategy

All P6 implementation is test-first and uses synthetic fixtures, isolated
PostgreSQL databases, local HTTP fakes, and local Docker networks. No live
Manifest provider, Meta send, n8n workflow, customer data, production asset, or
external infrastructure mutation is required for P6 local completion.

### Static and unit validation

- exact dependency/base-image digests and revision labels;
- mounted-file secret parsing and value-free failures;
- role-specific configuration and rejection of unused credentials;
- health/incident state transitions and dashboard authorization;
- systemd unit and script arguments without embedded secrets;
- backup catalog, retention, pruning, and closed outcome rules;
- n8n canonical signing, idempotency, timeout, response bound, and destination
  validation; and
- logging/evidence allowlists.

### Compose and container validation

- `docker compose config` for runtime and every operations profile;
- non-root user, read-only root, capabilities, privilege, PID, CPU, memory,
  tmpfs, volumes, health checks, restart policy, and revision labels;
- no Docker socket, device, host PID, host network, or broad bind mount;
- no public host port, with admin limited to loopback;
- exact positive network reachability for each role; and
- negative probes proving every unapproved cross-network path fails.

### Migration, backup, and restore validation

- migration from empty and previous schema, reapply, failure rollback, and
  deployment-lock concurrency;
- encrypted synthetic backup, ciphertext integrity, no persistent plaintext,
  incomplete-write cleanup, and retention edge cases;
- restore into a new isolated volume with no application attachment;
- rotated tombstone keys, repeated bounded batches, concurrent-scan refusal,
  missing-key refusal, remaining-match refusal, and persisted pass evidence;
- attempted promotion before and after the deletion gate; and
- compatible image rollback plus incompatible-schema refusal.

### Failure injection

- PostgreSQL, Manifest fake, Meta fake, n8n fake, tunnel probe, and health
  collector unavailable independently;
- crashed workers, expired leases, bounded shutdown, and restart;
- full/readonly backup destination and corrupted ciphertext;
- migration/startup verification failure; and
- sanitized dashboard incidents and host-log events with no content or secret.

## Evidence And Gate Mapping

P6 evidence updates the acceptance matrix without overstating live behavior:

- AC-09: encrypted backup, isolated restore, deletion reconciliation, and
  promotion refusal;
- AC-18: final route and network isolation contract;
- AC-20: pinned build and hardened runtime contract;
- AC-21: application-side private Manifest network and tool-free readiness;
- AC-25: deployable configurable limits plus sanitized dashboard incident
  evidence; and
- AC-26: authenticated idempotent private n8n fake contract and PostgreSQL
  authority during outage.

P6-GATE requires passing formatting, lint, strict type checking, unit tests,
guarded PostgreSQL integration tests, build, Compose rendering, container
hardening inspection, network probes, migration cycles, encrypted
backup/restore, tombstone reconciliation, promotion refusal, rollback, and
failure injection. Evidence records only revisions, counts, durations, closed
codes, and pass/fail outcomes.

Live private Manifest behavior, recording changes, actual provider behavior,
Meta test sends, public outage tests, and complete host-restart evidence remain
P7 work even if the application is installed on the local Ubuntu server.

## Implementation Sequence

The detailed implementation plan will decompose this design into independently
reviewable test-first tasks in this order:

1. close shared file-secret and deployment configuration contracts;
2. add content-free operations, incident, backup, deployment, and notification
   persistence;
3. add role-specific API/admin/worker/maintenance entrypoints and graceful
   lifecycle behavior;
4. build pinned application and operations images plus layered Compose files;
5. enforce the least-privilege network and container contract;
6. implement forward deployment, drain, migration, verification, and
   compatible image rollback;
7. implement encrypted backup, configurable retention, and systemd scheduling;
8. implement isolated restore, deletion reconciliation, and promotion refusal;
9. add health collection and authenticated dashboard operational views;
10. add the private authenticated idempotent n8n notification adapter;
11. complete failure injection, full local validation, operations runbooks,
    acceptance/threat evidence, and P6-GATE review; and
12. after the required external-action boundary is satisfied, deploy the exact
    approved revision to the existing local Ubuntu server and record only
    sanitized evidence.

## Approval Boundaries

Approval of this specification permits writing the detailed P6 implementation
plan only. Approval of that plan permits P6-002 through P6-006 local,
test-first implementation under their tracker boundaries.

Neither approval by itself authorizes:

- SSH access or mutation of the Ubuntu server;
- changing the running tunnel, DNS, Manifest, n8n, or Meta configuration;
- using a real credential in tests or evidence;
- sending to the Meta test number or Page;
- calling a live Manifest provider;
- processing customer data or enabling customer/model traffic; or
- any production asset or production-number action.

The project owner's stated deployment target is the existing local Ubuntu
server. The exact deployment revision, commands, affected services, rollback,
and stop conditions must still be presented at the repository's immediate
external-action gate before the server is changed.
