# Phase 6 Promotion Host Contract

The fresh synthetic restore succeeded, but its promotion job and selection
became uncertain. The original job container was removed, so its precise
failure point is unavailable. A read-only check found a separate, deterministic
blocker: the promotion host guard requires every secret file to be owned by
`1000:1000`, while the source and target PostgreSQL password files on the
synthetic host are owned by `999:999`, as required for the PostgreSQL process.
The original guard rejects the actual metadata. This does not prove the lost
job reached that guard.

The rendered promotion job also supplies
`CHECKPOINT_ARCHIVE_DIRECTORY=/var/lib/fcd-support/backups`, while the host
validator requires an extra `checkpoints` subdirectory. The preserved job
override does not alter that setting. This is a second independent blocker if
the host snapshot reaches the validator; the lost job's exact failure point is
still unknown.

The guard must require `999:999` for the two fixed PostgreSQL password paths
and `1000:1000` for the five fixed operations-secret paths. Keep the existing
regular-file, canonical-path, protected-ancestor, single-link and mode `0400`
or `0600` checks. Inspect metadata only; never read or emit secret values.
Do not loosen ownership for either role or change existing fixture files. The
host validator must accept the checkpoint root supplied by the restore Compose
contract and reject a substituted path.

Verify the exact function against the preserved server metadata read-only, and
use a fresh labelled Docker volume to test real UID/GID ownership, safe modes
and rejection of incorrect ownership, broad modes, hardlinks and symlinks. A
regression must compare the validator with the actual Compose checkpoint path.
The existing uncertain promotion and selection remain untouched. This correction
does not settle the old job, prove its outcome, authorize a retry or complete
the Phase 6 gate.
