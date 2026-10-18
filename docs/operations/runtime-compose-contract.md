# Phase 6 Local Runtime And Network Contract

## Current status: topology gate FAILS

This is an incomplete Task 8 checkpoint, not deployment-ready configuration.
Four real Compose renderings pass the structured validator. The realistic
network harness deliberately fails with:

```text
network_probe_failed=ingress-probe:3004:expected-denied:actual-allowed
```

The ingress probe has both the private ingress bridge and its own ordinary
egress bridge, representing the independently managed tunnel's multihomed
shape. It reaches the admin container's management-interface port despite a
loopback host binding. An outbound egress-enabled probe independently reaches
the same port. Explicit IPv4/IPv6 NAT, loopback binding defaults and disabled
management ICC did not remove the path on the tested local Docker engine.
Host-loopback publication and reachability worked; they are not sufficient
evidence of container-to-container denial. This tests TCP reachability only,
not an authenticated-admin bypass or actual server/Cloudflare traffic.

Earlier successful tests used internal-only fake provider egress and an
ingress-only probe, masking this path. Those results are superseded, not a
passing topology gate. The final harness preserves ordinary egress topology
without making any provider call and refuses the unsafe measured state.

Owner direction received on 2026-10-18 for a focused architecture amendment:

- Selected: admin HTTP listens on an owner-only Unix socket, exposed to the
  browser through SSH forwarding. No admin container TCP port is published.
  The dashboard, loopback browser origin and existing MFA/session/CSRF rules
  remain unchanged. This needs a narrow private socket mount and changes the
  approved TCP/host-publication transport, so it is not implemented yet.
- Not selected: retain TCP but design and verify explicit host-level Docker
  firewall enforcement. This introduces privileged host rule lifecycle and
  separately approved server mutations; no such changes are authorized now.

The owner approved the written amendment in the Phase 6 specification's
Management access section. Its corresponding detailed plan revision now
awaits owner review before implementation. No socket implementation has started. The TCP
configuration and measured-boundary description below describe the failed
checkpoint only; they are not the selected target or deployment instructions.
Do not launch these draft files. Synthetic containers, networks and volumes have
been removed after validated scope checks. No live server or production service
was changed.

Task 8 supplies local packaging and network evidence, not server deployment
approval. Continue using the retained admission-only revision/images until the
exact Phase 6 server replacement is separately authorized. Do not combine a
current Phase 6 image's strict file-secret contract with the legacy inline-secret
Compose layout. The old Compose/scripts and rollback references are retained;
no legacy service or production asset is changed by these files.

## Separate files and explicit execution

| File                            | Responsibility                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `infra/compose.runtime.yml`     | PostgreSQL, webhook, private admin, FAQ-only reply; profile-gated outbound and notification |
| `infra/compose.model.yml`       | Explicit `model-execution` overlay adding only the reply worker's Manifest key/network      |
| `infra/compose.operations.yml`  | Explicitly profiled migrate, backup, verify-backup, checkpoint, health and maintenance jobs |
| `infra/compose.restore.yml`     | Separate restore project, internal network and explicitly named fresh database volume       |
| `infra/compose.phase6-test.yml` | Network-only local fakes over the actual runtime topology                                   |

No external-execution flag has an enabling default. Outbound and notification
require their profile plus an explicit valid flag; model execution additionally
requires the model overlay/profile. Base reply has no Manifest mount/network.
Normal backup has no decryption identity. Verification and restore mount their
identity separately and read archives through an owner-checked read-only path.
Non-archive jobs do not mount the backup volume.

The maintenance service currently needs an explicit command override supplying
one of the implemented closed jobs, stable run reference and scheduled UTC
timestamp. Other operations commands, actual restore, host scheduling and the
notification runtime remain assigned to Tasks 9–14; packaging their profiles is
not evidence that these later modules are implemented. Database login/grant
bootstrap is Task 11. Nothing should be launched from these files yet.

`FCD_CONFIG_ROOT` contains protected, non-secret `common.env` and role-specific
configuration files. Compose receives only individual read-only secret files
under `FCD_SECRET_ROOT`; credentials, channel identifiers and database URLs must
never be environment values or arguments. Compose's rendered JSON contains
configuration values: capture it directly into the closed validator, never print
it or include a real rendering in evidence. Only the synthetic harness retains
renderings in its ignored workspace.

CPU, memory, PID, tmpfs, shutdown and health values use required operator inputs.
The structured validator matches application/operations resource values and
shutdown grace to the protected operations policy; PostgreSQL is checked against
protected bounds and host capacity. Per-role tmpfs sizes remain customizable.
Missing values or drift fail closed. Revision labels, image tags, role mounts,
network sets, profiles, private admin origin and port bindings are checked as
structured data, not merely text patterns.

## Measured boundaries

| Role                        | Networks                                                        |
| --------------------------- | --------------------------------------------------------------- |
| Webhook (`fcd-support-api`) | `webhook_data`, external ingress                                |
| Admin                       | `admin_data`, single-member management bridge                   |
| Reply                       | `reply_data`; external model network only with explicit overlay |
| Outbound                    | `outbound_data`, provider egress                                |
| Notification                | `notification_data`, external notification network              |
| PostgreSQL                  | Six separate internal per-role data bridges                     |
| Operations jobs             | Operations data bridge only                                     |
| Restore                     | Its separate internal restore data network only                 |

PostgreSQL is the only database peer on each role's data bridge. A single shared
database bridge would also permit its application peers to reach each other.
The ingress alias remains `fcd-support-api`; the existing tunnel target does not
change. No API, PostgreSQL, worker, operation or restore host port is published.
The only runtime host binding is `127.0.0.1:<approved-port>:3004` for admin.

On the tested Docker Desktop engine, an internal-only network did not produce
a usable published host port. Admin therefore also has its own regular bridge.
The harness checks actual published bindings and makes a host-loopback HTTP
request, not just an inspection of requested configuration. Future Ubuntu
validation must repeat this check. The bridge grants ordinary egress, not public
admin ingress; the loopback bind and existing origin/session/CSRF controls remain
required. Host preflight must call `assertLoopbackPortAvailable` before creating a
new binding, except when validating its own retained running service. A real
occupied-loopback test proves refusal and probe cleanup; do not rely on Docker
port-allocation error behavior as the collision guard.

Docker network membership is not a per-destination firewall. Provider egress
allows general network egress; the existing Meta client separately pins its exact
approved origin and rejects redirects. Model/notification/ingress networks must
be private local bridges with exactly the approved participants. The exported
external-network validator rejects missing networks, Internet-routed networks
and extra participants. Inspect actual existing networks read-only during the
later approved server preflight; refuse broad networks rather than silently
joining them. No existing Manifest, n8n or Cloudflare network is changed here.
Docker describes these distinctions in its official
[networking](https://docs.docker.com/compose/how-tos/networking/) and
[port-publishing](https://docs.docker.com/engine/network/port-publishing/)
documentation.

## Local-only evidence

Run `bash scripts/test-phase6-local.sh`. It generates one uniquely scoped
`fcd-support-phase6-test-*` project, guarded `fcd_support_test` database and
synthetic non-secret configuration. All four production configurations are
rendered and validated. The test overlay preserves their network attachments
but substitutes bounded Node HTTP fakes and pinned PostgreSQL; it clears all
application credentials. These are topology tests, not full application flows,
model replies, notification delivery or an actual backup/restore.

The harness is required to prove allowed database/fake connections; API denial
to model, Meta and n8n fakes; worker denial to ingress; ingress denial to admin;
and isolated restore probe denial to the runtime. It currently FAILS the admin
denial described above and stops there. All published bindings are inspected
when preceding checks pass. Further negative checks for extra participants,
missing-secret loading and occupied host-loopback ports are implemented and
passed separately/under the earlier restricted test shape; the final realistic
run stops at the admin-isolation failure before reaching them. The absent
external-network and profile-auto-start checks pass before that failure. Docker
Desktop may materialize a missing bind path as an empty directory; the actual
secret loader still rejects it as a non-file, rather than accepting its existence.

Cleanup first resolves and validates container IDs, project labels, names,
network attachments and volume names against that exact generated project.
It then removes its own containers/volumes/networks/test image. Unexpected
ownership or participants refuse cleanup and preserve the stack for inspection.
No prune command or unrelated project operation is used. Ignored synthetic
renderings/logs remain in the plan workspace until final review cleanup.
