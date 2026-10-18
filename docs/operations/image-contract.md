# Phase 6 Image Contract

Task 7 builds isolated local candidate images only. It does not replace the
existing admission-only deployment or authorize live provider traffic.

## Pinned toolchain

`infra/operations-toolchain.json` is the reviewable toolchain manifest. The
existing Node 24.18.0 Bookworm and PostgreSQL 18.4 digests are unchanged.
PostgreSQL's pinned default variant is Debian Trixie. The operations image
copies the pinned Node executable and npm 11.16.0 into that variant; unresolved
shared libraries, incompatible execution or mismatched tool versions fail
the build. No operating-system package installation occurs at startup.

Only `linux/amd64` is currently supported by the operations artifact contract.
The build rejects other architectures before fetching age. The official
[age 1.3.2 release](https://github.com/FiloSottile/age/releases/tag/v1.3.2)
Linux archive is checked against its release asset SHA256 from the
[publisher's release metadata](https://api.github.com/repos/FiloSottile/age/releases/tags/v1.3.2)
before extraction. Only `age` and `age-keygen` are installed; no identity,
recipient, database connection or other runtime credential enters a layer.
Backup and verification/restore identity mounts remain separate role concerns.

The retained Cloudflare digest executes version 2026.8.2; its descriptive tag
now names that version rather than `latest`. The digest is unchanged and no
fallback to a floating tag exists. This changes no live tunnel configuration.
Cloudflare's official [download documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
is the publisher entry point; deployment must continue using the reviewed pin.

The Docker context is default-deny, with only required build inputs allowed.
Application dependencies use `npm ci` and the exact committed lockfile.

## Storage and secret ownership

| Runtime              | UID:GID              | Required writable paths                                                                                             |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Application          | 1000:1000 (`node`)   | `/run/fcd-support`, mode 0700 tmpfs                                                                                 |
| Operations           | 1000:1000 (`node`)   | Same tmpfs; `/var/lib/fcd-support/backups`, mode 0700 named volume                                                  |
| PostgreSQL           | 999:999 (`postgres`) | `/var/lib/postgresql` and its `18/docker` data path, mode 0700 named volume; `/var/run/postgresql`, mode 0770 tmpfs |
| Tunnel image default | 65532:65532          | None                                                                                                                |

Image build layers seed named-volume directories with the correct ownership.
New Docker volumes inherit these directories. Tmpfs ownership/modes must be
explicit in runtime configuration because tmpfs hides the underlying seed.
Entrypoints reject incompatible owners, groups, modes, symlinks and unwritable
paths. They never run an ownership repair or elevate privileges. An existing
incompatible volume needs a separately reviewed operator procedure, not an
automatic recursive change.

The host must provision distinct owner-only 0600 credential files for each
actual configured runtime UID. Do not assume file-backed Compose secrets
remap host ownership. A legacy tunnel launcher may override the image UID;
its actual configured UID and mounted file owner must agree. It is not changed
or tested remotely by Task 7.

## Local verification

Run `scripts/verify-image-contract.sh` with a full 40-character candidate label.
The script builds only `fcd-support-phase6-image-test-*` tags. For an uncommitted
candidate, a parent revision label is only a local test identifier, not proof
that those bytes match that committed revision. Server deployment must build
from a clean exact approved checkout and recheck its label.

The verifier uses disconnected, read-only, capability-dropped test containers;
initializes a fresh synthetic PostgreSQL database as its non-root user; checks
closed failures of unconfigured app/admin/worker/operations commands; and
checks kernel 0600 access under each of the three UIDs. Root is used only to
provision isolated synthetic ownership fixtures. The distroless tunnel version
is executed directly; UID secret checks use a Node probe under that UID, not
a claimed shell inside the tunnel image. Temporary test volumes and containers
are removed; candidate image tags remain isolated from deployment tags.

This is not a host deployment, real secret mount, Compose topology, actual
backup/restore, live tunnel connectivity, provider, or production test.
