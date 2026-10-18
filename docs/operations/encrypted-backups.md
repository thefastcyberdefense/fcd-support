# Local Encrypted Backup Contract

## Scope

Phase 6 Task 9 implements local backup creation, structural verification,
catalog registration, scheduled-slot deduplication, and conservative pruning.
It does not implement or approve server deployment, host timer installation,
full restore, deletion-checkpoint reconciliation, or application promotion.
Those remain later tasks in the approved Phase 6 plan.

## Encryption And Secrets

`pg_dump --format=custom --no-owner --no-acl --no-password` streams directly
into the pinned age encryption binary. Only one X25519 public recipient is
accepted. Plugin and arbitrary recipient types are rejected. The backup role
cannot load a decryption identity; the existing role-secret and Compose
contracts enforce that separation.

The database URL is loaded from its protected file, not passed in command-line
arguments. Child processes receive an allowlisted environment, never the parent
environment. A generated 0600 `PGPASSFILE` exists only inside an exclusively
created 0700 work directory on verified Linux tmpfs. Both work and archive
directories must be canonical, owner-controlled, nonsymlink 0700 directories.
Cleanup removes only directories whose exclusive creation succeeded.

Every pipeline child must exit successfully. Stream failures, nonzero exits,
and the supplied timeout kill the remaining children and reject the archive.
Diagnostics and decrypted listings are drained without buffering or logging.
No plaintext dump, listing, connection string, identity, or plaintext-content
digest is written to the archive directory or evidence.

## Publication And Integrity

Each opaque `backup_<32 lowercase hex characters>` reference owns an exclusively
created directory. The ciphertext is written to `archive.partial` with exclusive
creation and mode 0600. The job syncs the file, computes its ciphertext-only
SHA-256/length, and prepares a 0600 signed `manifest.partial`.

The archive is atomically renamed to `archive.age`, followed by directory sync.
The manifest is atomically renamed to `manifest.json` last, followed by directory
and parent sync. Only a complete signed manifest plus matching ciphertext is an
eligible archive. An interrupted publication or orphan ciphertext is not eligible
and requires explicit recovery review rather than automatic adoption.

Manifest material consists only of reference, canonical UTC creation time,
archive class, Git/schema revision, ciphertext length/digest and `created` state.
HMAC-SHA-256 uses the mounted recovery key and domain
`fcd-support:backup:v1\n`; fields are serialized in the strict schema's declared
order. Signatures are compared with a constant-time operation. Missing,
symlinked, changed, corrupt, or mismatched files fail closed.

The filesystem manifest is immutable creation evidence. PostgreSQL remains
authoritative for `verified`, `restore_verified`, `failed`, and `pruned`
lifecycle state. A signed archive is created even when a pre-migration database
does not yet have Phase 6 operations tables; registration follows migration.
Missing operations tables never waive the pre-migration archive requirement.
The caller supplies source revisions; deployment preflight must confirm them.

## Verification And Retention

The separate identity-authorized command streams age decryption into
`pg_restore --list`, with listing output discarded. Wrong keys, tampering,
partial input, tool failure and timeout fail closed. This proves structural
verification only. It never marks an archive `restore_verified`; that requires
Task 11's full isolated restore and reconciliation gate.

Retention counts remain explicitly configurable with minimums of 45 daily and
6 monthly archives. Each quota requires distinct UTC calendar slots; duplicate
copies cannot replace a missing day or month. The latest archive in both
scheduled classes must be verified before pruning. The last full-restore-verified
archive is preserved even outside both windows. Pre-migration archives neither
satisfy these quotas nor get automatically pruned.

The pruning command first joins immutable catalog material with signed disk
material and validates every retained replacement, not just deletion targets.
Only the resulting closed reference list can be removed. Missing/corrupt
replacements prevent deletion. An interrupted filesystem/catalog prune fails
closed and needs explicit reconciliation; no permissive repair is performed.

Scheduled creation serializes through a PostgreSQL session advisory lock without
holding a transaction open during the dump. The catalog suppresses an existing
daily/monthly UTC slot. A complete signed archive left before a catalog-write
failure can be registered rather than duplicated. A partial, failed, ambiguous,
or missing archive stops the run. The connection is destroyed to release all
session locks. Host flock and timer integration remain Tasks 11/12, not an enabled
schedule. Restore-state promotion must coordinate with the same recovery lock.

## Private One-Shot Commands

The operations entrypoint accepts these closed forms only:

```text
node dist/operations-main.js backup daily|monthly|pre_migration <UTC_ISO_MILLISECONDS>
node dist/operations-main.js verify-backup <OPAQUE_BACKUP_REFERENCE>
node dist/operations-main.js prune-backups <UTC_ISO_MILLISECONDS>
```

UTC times require exactly three fractional-second digits; future times fail.
Commands report only closed status/reason codes and processed counts. They never
print manifests, paths, signatures, database URLs, tool diagnostics or keys.
Bare `backup` fails; startup does not create an extra backup.

Required role-specific configuration includes the existing explicit operations
bounds and resource maps, `BACKUP_ARCHIVE_DIRECTORY`,
`RECOVERY_MANIFEST_HMAC_FILE`, and `DATABASE_URL_FILE`. Creation also requires
`BACKUP_TMPFS_DIRECTORY`, `BACKUP_ENCRYPTION_RECIPIENT_FILE`,
`OPS_GIT_REVISION`, and `OPS_SCHEMA_REVISION`. Verification instead receives
`BACKUP_AGE_IDENTITY_FILE`, never the public-recipient role's credential bundle.
The archive path is the dedicated named-volume directory, not a host bind.

## Local Validation

`scripts/test-encrypted-backup.sh` builds scoped candidates from the pinned
operations toolchain, uses the guarded synthetic PostgreSQL test network, and
runs as UID 1000 with a read-only image, dropped capabilities, bounded resources,
protected tmpfs and a separately labelled archive volume. It rejects unexpected
network participants. Its cleanup is limited to its labelled containers, volume
and revision-labelled candidate images.

The ordinary integration runner intentionally lacks the operations binaries.
Its explicit encrypted-backup test skip must be paired with the separate native
gate; it is never evidence of successful encryption. Native cases include real
custom-format encryption/decryption/listing, wrong-key rejection, no identity
read during backup, bootstrap before operations tables, catalog replay and
concurrent slot suppression. Unit cases also cover independent quotas,
tampering, interrupted rename, reference collision, symlinks, readonly paths,
timeout, pipeline failures and ENOSPC cleanup.

Clean-source gate at `a627a844545a467d0ce4013c9f9fa08f102e5e89` passes:
40/40 native backup/retention tests plus 1/1 real PostgreSQL/compiled CLI test.
The full code gate passes 898 tests with 22 platform-specific skips across 60
files. Ordinary PostgreSQL regression passes 484 tests with one explicit
native-toolchain skip across 42 files; that case passes separately above.

All fixtures are authored synthetic data. A passing local gate is not a real
server, provider, production, full-restore or disaster-recovery claim.
