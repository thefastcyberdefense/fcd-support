# Phase 6 Server Read-Only Preflight

Collected 2026-10-26 (Asia/Dhaka) for the existing local test server
`redwan@192.168.10.40`. This is readiness evidence for the concrete Task 16
handoff, not a deployment, P6 gate pass, P7 acceptance pass or production
authorization.

The operator authorized real local-server testing while preserving production.
This collection was limited to read-only SSH, Git, version, Docker metadata,
numeric identity, filesystem capacity and directory-mode checks. No service,
container, network, file, permission, SSH configuration, host key, Meta asset,
Manifest configuration, n8n workflow or production state was changed. No
provider request, database query, log export or business-content read occurred.
The only authored artifact is this local report.

## Connection and source

Every remote command used the existing SSH trust configuration with:

```powershell
ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes redwan@192.168.10.40 '<READ_ONLY_COMMAND>'
```

Authentication succeeded without a password prompt or host-key modification.
The deployment path came from `test-deployment.md`; no broad filesystem search
was performed.

| Check | Sanitized result |
| --- | --- |
| Checkout | `/home/redwan/apps/fcd-support` |
| `git rev-parse HEAD` | `207a5e6357c1e1a7c75918793262d835574d898d` |
| `git status --porcelain=v1 --untracked-files=all` count | 0 |
| Kernel (`uname -sr`) | Linux `6.8.0-147-generic` |
| Deployment `id -u`, `id -g` | `1000:1000` |
| Docker server version | `29.7.2` |
| Docker Compose version | `5.4.0` |
| Git version | `2.43.0` |
| Windows `ssh -V` | OpenSSH for Windows `9.5p2` |
| Server `/usr/sbin/sshd -V` | OpenSSH `9.6p1`, Ubuntu package `3ubuntu13.20` |
| `systemctl --version` first line | systemd `255`, Ubuntu `255.4-1ubuntu8.18` |
| `command -v flock systemctl stat curl python3` | All present |

The remote checkout and running admission API/tunnel still match the previously
recorded August deployment. This does not establish compatibility with the
current Phase 6 source or its schema.

## Existing stack and capacity

The narrow `docker ps -a --filter name=fcd-support` projection reported six
matching containers: three running healthy services, two stopped retained
tunnel rollback containers and one stopped earlier test PostgreSQL container.
Only operational project names, image references, states and health were read.

| Running service | Image reference | Read-only root | Host port bindings |
| --- | --- | --- | --- |
| `fcd-support-fcd-support-api-1` | `fcd-support-api:207a5e6357c1e1a7c75918793262d835574d898d` | true | 0 |
| `fcd-support-cloudflared` | `fcd-support-cloudflared:207a5e6357c1e1a7c75918793262d835574d898d` | true | 0 |
| `fcd-support-postgres-1` | `postgres:18.4` | true | 0 |

API and tunnel image revision labels match the full checkout revision.
PostgreSQL has no application revision label. A fixed Docker projection read
only service name, configured user, root-filesystem mode, application revision,
port-binding count and the PostgreSQL mount at `/var/lib/postgresql`; full
inspect output and environments were never requested.

The mounted database volume is `fcd-support-postgres-data`, at
`/var/lib/postgresql`. Existing storage and retained containers/images were
preserved.

`docker network ls --filter name=fcd-support` and a narrow network-inspect
projection reported:

| Network | Driver/scope | Internal | Attached endpoint count |
| --- | --- | --- | --- |
| `fcd-support-ingress` | bridge/local | true | 2 |
| `fcd-support-data` | bridge/local | true | 2 |
| `fcd-support-test_data` | bridge/local | true | 0 |

Endpoint counts do not establish exact member identities or the complete
network boundary. No endpoint was attached/detached and no public route was
probed.

`df -Pk /home/redwan/apps/fcd-support /var/lib/docker` found both paths on the
same root filesystem: 120,115,244 KiB total, 87,577,484 KiB used,
26,811,844 KiB available (about 25.6 GiB), 77% used. A subsequent
`df -Pi /var/lib/docker` reported 5,480,829 free inodes, 29% used.
No backup-size, image-build-space or restore-space budget was established;
these figures alone do not pass the capacity gate.

## Numeric ownership and permission blocker

Read-only `docker exec ... id -u` / `id -g` checks confirmed the current API
process user maps to `1000:1000`; PostgreSQL maps to `999:999`. The configured
tunnel user is `1000:1000`. The intended admin image also requires `1000:1000`,
but no Phase 6 admin container was started or its host bind tested here.

The exact database-directory check was:

```bash
docker exec fcd-support-postgres-1 stat -c '%n|%u:%g:%a|%F' \
  /var/lib/postgresql /var/lib/postgresql/18 /var/lib/postgresql/18/docker
```

| Directory | Actual owner/mode | Phase 6 required owner/mode |
| --- | --- | --- |
| `/var/lib/postgresql` | `999:999:1777` | `999:999:700` |
| `/var/lib/postgresql/18` | `999:999:755` | `999:999:700` |
| `/var/lib/postgresql/18/docker` | `999:999:700` | `999:999:700` |

**The existing database root and major-version directory fail the hardened
Phase 6 image contract.** PGDATA itself passes this narrow mode check.
No `chmod`, `chown`, automatic repair, database copy or isolated migration was
performed. The concrete deployment handoff must resolve the first two
directories before the application outage through explicitly reviewed
permission preparation or an approved isolated-volume migration.

Host `stat` inspected only the documented protected directory/files and source
directory metadata:

| Path | Owner/mode/type |
| --- | --- |
| `/home/redwan/.config/fcd-support` | `1000:1000:700`, directory |
| `/home/redwan/.config/fcd-support/runtime.env` | `1000:1000:600`, regular file |
| `/home/redwan/.config/fcd-support/cloudflared.token` | `1000:1000:600`, regular file |
| `/home/redwan/apps/fcd-support` | `1000:1000:775`, directory |

No configuration or credential content was read. File presence/modes do not
prove required Phase 6 secret completeness, key version coverage or identity
availability. The Docker daemon socket was present; it was not mounted into a
container or used as an admin transport.

## Remaining handoff gates

- **Data scope is not established.** A test-asset name and historical synthetic
  webhook evidence do not attest that every existing pending row is synthetic
  or non-customer. No data was sampled to infer provenance. Establish trusted
  operational attestation before attaching new workers to this database, or
  keep those workers disabled. Model, outbound and n8n execution must remain
  false and their live credentials must not be injected.
- Select and verify the dedicated admin socket root, its protected ancestors,
  `0700` ownership and absence of an existing socket entry. This collection did
  not select or create a directory. Numeric account alignment is preliminary
  evidence only.
- Prove effective SSH stream-local forwarding policy and actual
  loopback-TCP-to-remote-Unix transport, then real login/origin behavior at the
  concrete authorized server gate. The version checks do not prove policy or
  forwarding. A noninteractive `sudo -n /usr/sbin/sshd -T` attempt, filtered to
  forwarding booleans, yielded no policy lines and is not a successful policy
  check. No listener, forward or SSH configuration change was made.
- Establish required protected Phase 6 configuration, restore identity,
  checkpoint/key material, archive volume, exact socket path/browser port,
  permission preparation and capacity budget without exporting their values.
- Finish the local P6 failure matrix/gate and choose a synchronized full Git
  revision. Record exact server commands, affected services, backup/verification,
  migration, worker gating, timer installation, compatibility and rollback in
  `phase-6-server-deployment.md` before mutation.
- Re-verify exact endpoint membership, immutable image identity, schema revision,
  least-privilege runtime/database state, current public exact-path/catch-all
  behavior and freshness at execution time. No SQL or public HTTP verification
  occurred in this preflight.
- Meta test-device delivery, recording-off attestation, provider quality/sends,
  n8n behavior and host outage/restart tests remain separate P7 work.

This read-only inventory closes the previously unknown existing-volume mode
question with a concrete blocker. It authorizes no repair or deployment and
does not establish customer-data or production readiness.
