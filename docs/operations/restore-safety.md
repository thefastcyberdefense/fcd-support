# Deletion Checkpoints And Restored-Work Safety

## Scope And Remaining Gate

Phase 6 Task 10 adds current deletion-checkpoint transfer and inherited-work
quarantine primitives. It does not perform a full database restore, attach an
application to a restored volume, install host jobs, deploy to Ubuntu, or enable
provider/model/n8n execution. Task 11 must compose and prove the isolated restore
and promotion controller before any such recovery workflow is considered usable.

## Current Deletion Authority

Migration 000015 adds a durable source epoch and monotonic deletion revision.
Insert/update/delete of a deletion tombstone advances the revision; truncation
also advances it. Ordinary marketing-only suppression changes do not masquerade
as a deletion change. An archive's copied tombstones or copied clock are not
evidence of the current authoritative source.

Export freezes `privacy_suppressions` with a PostgreSQL SHARE table lock before
reading its clock and exact unexpired tombstones. The operation uses READ
COMMITTED under this freeze, not a repeatable-read snapshot established before a
blocking lock. Caller-owned transactions must use the same isolation level and
remain open if the controller needs to retain the freeze through promotion.

The signed manifest includes an opaque checkpoint reference, source/schema
revisions, snapshot time, epoch/revision watermark, row count, required HMAC key
versions, ciphertext length/digest and signature. `validUntil` is the next
tombstone activation/expiry boundary. A sequence alone cannot prove completeness
after time changes which records are active; validation rejects at that boundary,
as well as after the configured maximum age or a deletion-clock revision change.

Minimal tombstone records are JSON-encoded only in bounded memory and streamed
through the pinned age X25519 encryption binary. The export job receives the
public recipient, never an identity. Canonical 0700 owner-controlled directories,
exclusive staging, 0600 files, fsync and final signed-manifest publication reuse
the backup contract. Runtime archives and keys remain ignored data, not Git
fixtures or evidence. No plaintext file, tombstone value, signing key or child
diagnostic is logged.

## Import And Proof Boundary

Import receives a trusted expected current watermark from the recovery
controller. It must not derive that expectation from the selected old archive.
When the live source is available, its clock is rechecked before and after target
writes. If the source is unavailable, an independently preserved checkpoint is
usable only when its current completeness can be independently attested; a recent
filename or a valid signature alone does not establish that fact. Task 11 must
refuse unproven offline promotion, not manufacture an attestation.

The importer validates the strict manifest, signature, age, time boundary,
ciphertext, canonical paths, byte/row bounds, every decrypted field, unique
records, row count and exact key set. It writes the isolated target transactionally
and records append-only evidence bound to the restore reference and manifest.
Exact replay is idempotent; conflicting material is refused. A failed import
cannot leave a partial set of target tombstones or a pass record.

Import preserves older unexpired target key versions and never shortens an
existing suppression merely because a key rotated. Full deletion reconciliation
must load every still-required key, including older active target keys, and run
the existing complete Phase 3 scan. Missing keys or remaining matches must prevent
application attachment. Successful transfer is not itself a deletion-gate pass
or a full-restore pass.

## Inherited External-Effect Work

`PostgresRestoreFence.quarantine` takes a lock-safe inherited snapshot and records
only internal source IDs, restore reference, a closed reason and time. Immutable
source quarantine covers admitted events, processing/model work, reply drafts,
outbound intents, notification work and their notification parents.

Pending/leased processing and notification work becomes quarantined. Queued and
active model leases terminate with `guard_blocked`. Pending/leased outbound work
with no dispatch becomes canceled with `restore_quarantined`; authorized attempts
are abandoned before dispatch. Existing dispatch-start evidence becomes
`delivery_unknown`, never an automatic retry. Existing attempt/status history is
retained; notification retries cannot recreate a prior external effect from an
older snapshot.

A separate database recovery hold blocks new work too. Application checks return
no processing, outbound or notification claims, and SQL guards reject newly
runnable processing/model/draft/intent/attempt/notification writes. Per-source
quarantine remains after the hold is reviewed, so releasing new work does not
re-enable inherited sources.

A review record requires all five explicit reconciliation assertions: consent,
suppression, human pause, privacy workflows and channel policy. Its reviewer must
be a currently active administrator with an effective assignment, and its time
must not predate the hold. Evidence is append-only. This database record is not a
public approval endpoint, an MFA/session authorization mechanism, or a promotion
permission. Task 11 must protect review writes with least-privilege roles and
bind human approval, current authority, checkpoint/import/fence references,
fresh clocks and final isolated gates before attachment.

## Private Checkpoint Job

```text
node dist/operations-main.js checkpoint
```

This explicitly invoked one-shot samples the current clock, exports current
authority and prints only closed status/reason codes and row count. It has no
identity mount and does not run on application startup. Host scheduling and
post-maintenance invocation are implemented in later Phase 6 tasks.

In addition to the checkpoint role's existing operations/resource bounds and
protected database/recipient/recovery-HMAC files, the job requires
`CHECKPOINT_ARCHIVE_DIRECTORY`, `CHECKPOINT_MAX_ROWS` and
`CHECKPOINT_MAX_PAYLOAD_BYTES`. Import/promotion callers supply the configurable
`CHECKPOINT_MAX_AGE_MS` value explicitly. There are no enabling defaults.
Use a dedicated protected checkpoint subdirectory of the named archive volume;
do not mix checkpoint references into the backup catalog's directory.

Export failure records a sanitized PostgreSQL-backed dashboard incident when the
database remains writable; an unavailable database still produces a closed CLI
failure for the host journal. No n8n dependency is introduced.

## Validation Boundary

`scripts/test-phase6-checkpoint.sh` is the complete Task 10 gate: the native
crypto cases followed by guarded fence, outbound, model and deletion regressions.

`scripts/test-encrypted-backup.sh checkpoint` adds real age checkpoint and compiled
CLI tests to the existing non-root, read-only-image native backup harness. Ordinary
integration runs explicitly skip those toolchain-dependent cases; the separate
native gate must pass. Independent synthetic source/older-target fixtures prove
post-archive deletion reapplication, not a full database dump/restore.

The guarded migration runner explicitly sets `singleTransaction: true`. A RED
test exposed that its prior omitted setting allowed a blocked lower downgrade to
remove newer safety migrations first. The regression now preserves the complete
installed schema, and migration tests assert the full current version. Production
deployment still must not run automatic down migrations.

All validation uses authored synthetic data and scoped local Docker resources.
The clean-source gate at `1962a1cf0f7056d68f64df0737501c82f1653aea` passes
50 native units, 11 real crypto/CLI tests and 62 policy/fence regressions. The
complete code gate passes 909 tests with 22 platform-specific skips across 61
files; ordinary PostgreSQL passes 494 tests with 11 native-only skips across 44
files. Every native-only integration case passes in the separate native gate.
Post-suite hygiene is zero test schemas/advisory locks and zero labelled generated
backup containers, volumes and candidate images.

No server, customer, live model/provider, Cloudflare, n8n or production action is
implied by these results.
