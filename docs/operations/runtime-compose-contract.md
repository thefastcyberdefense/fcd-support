# Phase 6 Local Runtime And Network Contract

## Current status: Task 8 local gate PASS

The owner approved the written private Unix-socket/SSH specification and its
revised implementation plan on 2026-10-18. Local implementation removes the
admin TCP listener, management bridge and Docker port publication. This is not
a deployment approval or a Phase 6 gate pass; Tasks 9–16 remain required.
The clean committed-source rerun at `c9a904bab4d11e926dd4285c7ccad6f2220375c9`
passes and closes Task 8 under its original implementation base.

The final realistic amended harness passes four production Compose render
validations, nine allowed and 20 denied TCP probes, no admin TCP listener,
socket-only health, UID separation, execution-profile isolation, missing external
network, extra participant, missing secret and occupied client-loopback checks.
The native Linux suite passes 17 socket and 30 secret-file tests as node; guarded PostgreSQL
admin identity/dashboard/forwarding regression passes 17 tests across three
files. Complete PostgreSQL regression passes 484/484 across 41 files. The full
Windows code gate passes 861 tests with 19 Linux-only skips across 58 files;
all skipped platform-specific cases pass in the separate 47-test Linux gate.
Formatting, lint, strict typing, build, gate authority, shell syntax and explicit
documentation formatting pass. Post-suite hygiene is zero test schemas and
advisory locks; generated topology containers/networks/volumes are removed.

### Retained failed checkpoint

The previous TCP design failed with
`network_probe_failed=ingress-probe:3004:expected-denied:actual-allowed`.
Both outbound and a tunnel-like ingress container with ordinary egress reached
the admin management-interface port despite host-loopback publication, explicit
IPv4/IPv6 NAT and disabled management ICC. Earlier internal-only fake egress
masked that path and is not valid isolation evidence. This measured local TCP
reachability, not an authentication bypass, actual Cloudflare exposure or an
Ubuntu server result. The socket amendment replaces that design; privileged
host firewall enforcement was not selected. No host firewall was changed.

## Separate files and explicit execution

| File                            | Responsibility                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `infra/compose.runtime.yml`     | PostgreSQL, webhook, socket-only admin, FAQ-only reply; profile-gated outbound and notification |
| `infra/compose.model.yml`       | Explicit model-execution overlay adding only reply's Manifest key/network                       |
| `infra/compose.operations.yml`  | Explicit migrate, backup, verify-backup, checkpoint, health and maintenance profiles            |
| `infra/compose.restore.yml`     | Separate restore project/internal network and required fresh volume name                        |
| `infra/compose.phase6-test.yml` | Synthetic fakes over runtime topology, with a real Unix listener for admin                      |

Execution flags have no enabling default. Model use requires its overlay/profile
and explicit flag; outbound/notification require their profile and explicit flag.
Normal backup never mounts a decryption identity. Verification/restore use their
separate identity and owner-checked read-only archive path. Non-archive jobs
receive no archive volume. Maintenance requires its explicit closed job, stable
run reference and scheduled time. Database login/grant bootstrap and functional
operations/restore commands remain assigned to Tasks 9–14.

`FCD_CONFIG_ROOT` contains protected non-secret common/role environment files.
Only individual required read-only secret files under `FCD_SECRET_ROOT` are
mounted into each role. Do not print real Compose renderings or runtime
environments; pipe JSON into the closed validator. Only authored synthetic
renderings/logs remain in the ignored plan workspace.

CPU, memory, PID, tmpfs, shutdown and health settings remain required protected
operator inputs. The validator compares application/operations resources with
the protected policy; PostgreSQL stays within protected bounds/host capacity.
Missing or drifting settings, secrets, networks, profiles, tags/labels and mounts
fail closed. Candidate-parent-labelled builds are not deployed clean-revision
proof.

## Admin socket and browser boundary

Admin joins only internal `admin_data` and uses
`ADMIN_LISTEN_MODE=unix` with
`ADMIN_SOCKET_PATH=/run/fcd-support-admin/admin.sock`.
Its only new writable bind is the dedicated `FCD_ADMIN_SOCKET_ROOT`, mounted at
`/run/fcd-support-admin` with `bind.create_host_path=false`. No other runtime,
operations, restore, tunnel or model role receives this directory.

The rendered contract compares the source against independently supplied
protected socket/config/secret/workspace roots. Broad, overlapping or substituted
sources fail. Actual host source/ancestor ownership, directory contents and SSH
UID mapping still require Task 11 preflight and later approved Ubuntu evidence.
A rendering alone does not establish host permissions.

The listener requires a real, non-symlink parent owned by its actual UID/GID,
mode 0700, and no existing socket-path entry. Linux umask 0177 creates the
socket mode 0600 from the outset; mode/owner/device/inode are checked. Existing
files, symlinks, live/stale sockets, malformed paths and unsupported platforms
fail without unlink or TCP fallback. Local/private test TCP constructors remain
compatible but cannot satisfy the packaged Phase 6 Compose contract.

Normal runtime stop closes its listener and database pool once. A replaced
entry returns a closed process-exit-required disposition: the dedicated CLI
terminates without Node's ordinary pathname-unlink close, preserving the
replacement. Crash-stale sockets deliberately refuse restart. Explicit,
scope-checked stale recovery is Task 11 work, not an implemented cleanup job.

The browser's configurable loopback origin/port are independent of the Unix
listener. Later deployment uses an SSH client loopback forward to the remote
socket, never a Docker host TCP publication. Password, MFA, live session/role,
signed action, origin and CSRF checks remain mandatory; SSH or socket access
does not grant reviewer authority. Local guarded tests use a synthetic
TCP-to-socket forward, not live SSH. Health uses the bounded socket-only
`/login` probe and opens no extra TCP port. Root/the designated owning host UID
remain trusted; this does not isolate a compromised host or that same UID.

## Measured network boundaries

| Role         | Networks                                                  |
| ------------ | --------------------------------------------------------- |
| Webhook      | webhook_data, external ingress                            |
| Admin        | admin_data only                                           |
| Reply        | reply_data; external model only with the explicit overlay |
| Outbound     | outbound_data, ordinary provider egress                   |
| Notification | notification_data, external notification                  |
| PostgreSQL   | Six separate internal per-role data bridges               |
| Operations   | operations_data only                                      |
| Restore      | Its separate internal restore network only                |

PostgreSQL is the only database peer on each role's data bridge. Ingress keeps
the existing fcd-support-api alias. Every runtime Docker host binding is absent.
The ingress test probe retains both private ingress and ordinary tunnel egress;
provider egress is not changed to internal-only to obtain a pass. Admin TCP
denial is measured from each relevant role and its own interface/loopback.
Kernel listener inspection permits only Docker's internal DNS loopback listener,
not an admin or other application TCP listener.

Docker membership is not a per-destination firewall. General provider egress
remains constrained separately by the existing exact-origin, redirect-denying
Meta client. Existing external ingress/model/notification networks must be
private local bridges with exactly approved peers; the validator rejects missing,
Internet-routed and over-broad participant sets. Later server inspection must
refuse a broad network rather than silently change it. No existing network was
inspected or changed in this local work.

## Local proof and limits

Run `bash scripts/test-phase6-local.sh` locally. Its generated
`fcd-support-phase6-test-*` project contains only authored synthetic data and
a guarded fcd_support_test database. All four production definitions are
rendered through the structured validator. Generic services use network-only
fakes; admin uses the newly built application candidate and the real socket
helper with a synthetic login route, not application authority or credentials.

Native Unix tests use Linux tmpfs. A separately labelled native Docker volume,
seeded non-root from the image's owner-only directory, represents the socket
directory in the Docker Desktop topology test. The real production bind form is
rendered/validated, not launched against a Windows filesystem. A positive UID
1000 probe and explicit kernel EACCES for UIDs 999/65532 establish local
permissions; wrong-owner listener startup is also rejected. This volume
substitution is not Ubuntu host-bind or live SSH proof.

Cleanup resolves exact IDs, labels, names, network attachments and volumes
before removal. Unexpected ownership/participants preserve the stack. No prune,
unrelated project, real credential, customer content, provider request, live
tunnel, SSH or server action is involved. Ignored synthetic evidence remains
until final whole-plan review. Actual Ubuntu ownership/SSH/public-route checks,
backup/restore and runtime enablement remain later gated work. Preserve the
legacy admission-only deployment until its exact replacement is authorized.
