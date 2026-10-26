# Restricted-capability restore command

## Approved split-job implementation

The owner approved the split-job capability boundary on 2026-10-26. The host
commands now load the protected restore/promotion controllers and live proof
ports. Their full failure-matrix and deployment gates remain separate from
component test passes. Every invocation requires the checked clean revision,
protected configuration, local daemon and held deployment lock.

```text
scripts/restore-runtime.sh BACKUP_REF CHECKPOINT_REF FULL_REVISION CONFIG_PATH
scripts/promote-restore.sh RESTORE_REF FULL_REVISION CONFIG_PATH
```

The controller creates a fresh labelled volume and internal bridge before
starting only the isolated PostgreSQL service. One-shot jobs have separate
operation projects and join the explicitly created target bridge as an external
Compose network; this does not make that bridge publicly reachable.

| Job | Database credentials | Network access |
| --- | --- | --- |
| Stream restore | Metadata-only source archive reader and distinct target owner | Source operations and isolated target bridges |
| Prepare/converge grants | Target owner and dedicated bootstrap password files | Target bridge only |
| Forward migration | Restricted target migrator | Target bridge only |
| Reconcile current deletions | Source checkpoint reader and target owner | Source operations and target bridges |
| Final promotion | Source checkpoint reader and target owner | Source operations and target bridges |

Only stream/reconciliation/promotion receive the necessary archive verification,
decryption and deletion material. A job with source reachability receives no
bootstrap password set or migrator credential. The archive-reader role cannot
read business tables or mutate the catalog. All external execution flags remain
false. Operational deadlines and batch limits remain explicit configuration.

Restore intent precedes resource mutations; completion retains that intent and
records descriptive target metadata. Promotion exports a fresh deletion checkpoint
and performs two bounded, replay-resistant stdio exchanges while the job retains
its source SQL freeze. Actual source, target, job, mount and network facts must
still match. No historical record alone authorizes attachment.

The host records the switching state before removing only the exact verified
PostgreSQL actors. Both volumes remain preserved. The replacement PostgreSQL
must pass fresh host and physical-identity checks before private application
startup. Ambiguous results retain uncertainty and journals; there is no automatic
replay or old-volume fallback. A selected restored database uses its distinct
owner URI for future bootstrap operations rather than the old source owner URI.

## Historical combined-driver fixture

The combined driver below is retained for internal regression fixtures only.
Production Compose does not invoke it or mount its combined capability set.
It must not be used as an alternative to the approved split-job controllers.
Its historical interface and validation details are recorded here for those tests.

```text
node dist/operations/restore-main.js restore RESTORE_REF BACKUP_REF CHECKPOINT_REF TARGET_METADATA_BASE64
```

The historical driver requires Linux UID/GID 1000. References use their
closed `restore_`, `backup_` and `checkpoint_` prefixes followed by 32 lowercase
hexadecimal characters. The target argument is canonical padded base64 of strict
UTF-8 JSON, at most 4 KiB decoded, with fields in this order:

```text
projectName, volumeName, volumeCreatedAt, networkId, postgresImageId,
runtimeImageId, systemIdentifier, databaseName, schema, gitRevision, schemaRevision
```

This metadata describes the independently inspected target. It is not a
historical verification token or promotion authority. Both clusters must have
the same logical database name and different physical system identifiers.
Unknown fields, alternate serialization, BOMs and substituted scope refuse.

## Protected configuration

Set `NODE_ENV=production` and all three execution flags to `false`. Supply
`OPS_OPERATION_REFERENCE`, `OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER`,
`OPS_SOURCE_DATABASE_NAME`, `OPS_DATABASE_ROLE_PREFIX`, `OPS_DATABASE_SCHEMA`,
`OPS_GIT_REVISION` and `OPS_SCHEMA_REVISION`. Revision, schema and database scope
must match the target metadata.

The source and target use distinct, fixed Docker service aliases:
`RESTORE_SOURCE_SERVICE_ALIAS=fcd-support-source-postgres` and
`RESTORE_TARGET_SERVICE_ALIAS=fcd-support-restore-postgres`. The eventual host
controller must provision those aliases on the approved private networks; the
generic `postgres` alias is ambiguous on a job connected to both clusters.

The following settings contain paths to separate mounted files, never values:

- `RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE`
- `RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE`
- `RESTORE_TARGET_OWNER_DATABASE_URL_FILE`
- `RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE`
- `PRIVACY_HMAC_KEYRING_FILE`
- `RECOVERY_MANIFEST_HMAC_FILE`
- `BACKUP_AGE_IDENTITY_FILE`

Source credentials must use the dedicated checkpoint and backup principals.
Their sessions are read-only. The isolated target owner is `postgres`; schema
migration uses the dedicated nonsuperuser migrator. Every managed connection is
operation-reference bound, and checks on the owning connections enforce physical
target identity. Runtime roles never receive the owner or restore credentials.

`RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY` identifies the protected directory of
`bootstrap-ROLE-password` files for the ten runtime roles and migrator. Mount
that directory, credentials, key material, archive and checkpoint directories
read-only. `BACKUP_ARCHIVE_DIRECTORY` and `CHECKPOINT_ARCHIVE_DIRECTORY` must be
separate from the writable private `BACKUP_TMPFS_DIRECTORY`. Plaintext SQL dumps
are not written to these directories.

## Configurable limits and completion

All limits below are required canonical positive decimal integers:

| Setting                        |               Maximum |
| ------------------------------ | --------------------: |
| `OPS_MAX_CALL_MS`              |               300,000 |
| `CHECKPOINT_MAX_AGE_MS`        |        31,536,000,000 |
| `CHECKPOINT_MAX_ROWS`          |         2,147,483,647 |
| `CHECKPOINT_MAX_PAYLOAD_BYTES` | 9,007,199,254,740,991 |
| `RESTORE_BATCH_LIMIT`          |                 1,000 |
| `RESTORE_MAX_BATCHES`          |             1,000,000 |

The driver streams the authenticated archive into the distinct empty target,
prepares ownership, runs restricted forward migration, converges grants and
reapplies the current signed deletion checkpoint. Inherited work remains
quarantined and the separate recovery hold remains in place. Unrelated rows and
source content are preserved.

Success is exactly a completed, one-count, `ok` acknowledgement after all four
managed pools close. Configuration, restore, reconciliation or uncertain closure
fail with `restore_command_failed` and no completed acknowledgement. A success
does not clear a host journal or mark the target ready for applications. Fresh
host verification, checkpoint/final-gate refresh, controlled volume switching and
recovery-policy review remain separate controller responsibilities.
