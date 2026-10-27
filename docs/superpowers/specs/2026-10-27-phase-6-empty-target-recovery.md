# Phase 6 Empty Target Recovery

This is a focused Task 11 recovery addendum. Codex selected this design under
the owner's standing delegation to resolve routine implementation details and
finish Phase 6. It is not an individually reviewed owner decision or a P6 pass.

## Problem and approach

An exhausted Docker address pool left a quiescent source, an immutable restore
intent and a newly created empty target volume. No target database or SQL job
started. The existing history guard correctly refuses another attempt while
that intent remains unresolved. Choosing another target alone must not bypass it.

Three approaches were considered: silently ignore an apparently empty intent
(loses explicit recovery evidence), move to another complete deployment root
(preserves data but leaves the operator recovery gap), or explicitly record
verified abandonment. Select the third: keep the old intent and every resource,
seal a separate terminal record, and permanently reserve its target names.

## Boundary

Provide a private `abandon-empty-restore.sh RESTORE_REF FULL_REVISION CONFIG_PATH`
command. It does not execute business SQL, remove a volume/network/container,
change selected storage, start a database or make an application ready. It
cannot clear an uncertain job. Backend settlement and recovery of a nonempty
target remain separate unfinished work.

Require protected configuration, exact clean code/image revision, deployment
flock, immutable original intent, a quiescent source with unchanged selection
and physical identity, and no active/pending job or metadata transition. The
intent must name the same source and configured target, which must never have
been selected or recorded as used. Independent retained source images identify
the actual source even when recovery code is a later revision.

Require successful current Docker listings proving no target or operation actor,
no target-volume user and no overlapping host bind. An absent target is allowed.
An existing target must be a default local volume labelled for this exact intent;
an optional target bridge must also be owned, internal and empty. Foreign,
substituted, ambiguous, unreadable or nonempty resources refuse recovery.

A networkless non-root read-only probe mounts only the existing target's exact
data directory. A named-volume mount is unsafe here: Docker may create a new
volume if the original disappears between inspection and container creation.
The host must instead obtain the path from the inspected, labelled default
local volume, verify that it is exactly the standard data directory under the
canonical, root-owned Docker data root, and use a read-only bind without
`bind-create-src`. Docker refuses an absent bind source. This one bind exposes
the same target data directory and no other host directory, secret, archive,
backend connection or Docker socket. The probe lists no filenames and reads no
file contents. Only an empty directory and stable root identity may produce its
closed proof. Repeat resource/selection checks around the probe and immediately
before sealing. The caller keeps the lock throughout.

The host check relies on the local Docker daemon and its root-controlled data
directory as trusted infrastructure. Verify the Docker root and its ancestors
are canonical and not writable by untrusted users, verify the target's exact
driver/path/labels, and resolve every other container's bind source before
rejecting overlaps. A failed or ambiguous bind inspection refuses recovery.
This does not defend against a compromised root user or Docker daemon.

## Durable result

Keep `.intent` unchanged. Publish an exclusive fsynced `.abandoned` record
through a deterministic `.next`, binding the original fields plus the fixed
reason, current verifier revision/image, target-volume creation stamp (or
absence), and a content-free proof digest. Refuse conflicting completed and
abandoned records, unsafe file ownership/mode, changed source/intent, partial
publication, replay or target reuse. An abandoned attempt can never satisfy
promotion's completed-restore requirement.

Only a valid terminal record lets a later explicit restore choose a different
fresh target. The new restore still repeats every source, archive, checkpoint,
capability, host and SQL gate. Existing unsettled SQL journals remain blockers.

## Validation

Test schema/state transitions, immutable history, conflicting/partial records,
target reservation and promotion refusal. Exercise empty/nonempty/symlinked/
changed directory probes without content disclosure. Native host tests cover
pending jobs, used targets, foreign actors/binds, daemon ambiguity, label/volume
replacement, source drift and actual probe confinement. Finish with the real
empty server target, preserved old intent/volume, a new target attempt, complete
code/native gates and exact recorded server actions before mutation.
