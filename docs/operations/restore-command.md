# Restricted-capability restore command

The standalone SQL driver is an internal Phase 6 primitive. The public
`restore-runtime.sh` and `promote-restore.sh` controllers remain unfinished.
Running this driver does not authorize promotion, application attachment, a
server action or external traffic. The host controller must retain its operation
lock and independently prove source quiescence and target isolation throughout.

```text
node dist/operations/restore-main.js restore RESTORE_REF BACKUP_REF CHECKPOINT_REF TARGET_METADATA_BASE64
```

The production entry point requires Linux UID/GID 1000. References use their
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
