# Backup, Isolated Restore And Promotion

This guide consolidates the implemented Phase 6 boundaries. Full host recovery
and failure-matrix validation remain open; see `runtime-deployment-safety.md`
and the exact server record before execution. Detailed cryptographic/checkpoint
contracts remain in `encrypted-backups.md` and `restore-safety.md`.

## Create and retain verified archives

Backup creation uses the dedicated backup role, a public age recipient, the
manifest authentication key and the protected archive volume. It does not mount
the age private identity. Plaintext streams through bounded memory-backed
scratch and must never be written to a persistent host directory or log.

Only a completed authenticated manifest makes an archive eligible. Verification
uses a separate restricted role and private identity. Incomplete ciphertext,
wrong keys, malformed manifests, full/read-only storage and timeouts fail closed.
Pruning validates required replacements first and retains the configured daily
and monthly copies independently. Never prune in response to a failed backup.

Keep archive ownership, verification-identity availability and capacity under
operator review. Record metadata-only restore drills at least quarterly, using
authored synthetic data where the validation policy requires it. Never include
an archive, key, database URI, dump or message body in evidence committed to Git.

## Restore into fresh isolated storage

```bash
bash scripts/restore-runtime.sh BACKUP_REF CHECKPOINT_REF FULL_REVISION CONFIG_PATH
```

The controller requires a quiescent verified source and protected immutable
restore intent. It creates a distinct labelled target volume and an internal
target bridge. The target is not attached to runtime applications, ingress,
Manifest, n8n or provider networks.

Restore capabilities are split:

1. Stream verified ciphertext with catalog-only source access and the distinct
   target owner. No bootstrap passwords or migrator credential enter this job.
2. Prepare grants on the target-only bridge, then migrate with the restricted
   target migrator, then converge target grants. These jobs cannot reach source.
3. Reconcile the current signed deletion checkpoint using narrow source
   checkpoint access, target owner and all active privacy-key versions.

Imported outbound work remains quarantined and restored conversations retain a
recovery hold. Apply every unexpired tombstone, including deletions after the
archive. Historical restore evidence is descriptive and does not select storage,
resume conversations or prove that promotion is currently safe.

## Promote only after fresh proof

```bash
bash scripts/promote-restore.sh RESTORE_REF FULL_REVISION CONFIG_PATH
```

Promotion exports a fresh source checkpoint and holds the SQL source freeze.
Two bounded nonce/sequence-bound host exchanges independently recheck actual
source/target/job identities, network membership, resources, secret mounts and
protected selection/journal. Current deletion reconciliation and pool closure
precede the closed acknowledgement; a cached proof or lost connection cannot
be treated as fresh authorization.

The controller records switching before replacing the exact verified database
actors. It retains both volumes, starts the selected database privately and
reruns role/schema/identity/runtime checks. Future bootstrap uses the distinct
restored-owner URI. Failure preserves uncertainty and does not automatically
switch back to the source volume after writes may have occurred.

## Stop and investigate

Missing keys, stale/incomplete checkpoints, substituted identities, unexpected
participants, wrong mounts/flags, unresolved jobs, unsafe directories, schema
incompatibility or ambiguous process state stop recovery. Preserve evidence
and volumes. Do not delete journals, reuse a restore reference, edit selection
records, remove an unknown actor or weaken a guard to force completion.

Production data recovery and production-number behavior still require their
separate reviewed action plan. Passing the synthetic restore library suite
does not establish an installed-host restore or production acceptance pass.
