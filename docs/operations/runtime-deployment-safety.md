# Phase 6 Deployment Safety Prerequisites

## Implementation Status

This is an intermediate Task 11 checkpoint, not a deployment or restore gate pass.
The role bootstrap library, protected host configuration/preflight, orchestration
ordering and forward-migration primitive are implemented locally. The public
host commands refuse an incomplete installation before Docker activity when a
required verification or recovery handler is absent. They are not ready for
server use.

A read-only restore-host collector now inspects actual Docker resources and
binds two matching samples to the selected revision and optional prior host
identity. Its validator runs in a networkless, unprivileged, read-only container
without mounts. It is not yet wired into the locked restore/promotion commands;
it does not replace application shutdown, source quiescence or fresh SQL proof.

An internal encrypted-stream restore stage now restores a real full synthetic
database into a separate local Docker PostgreSQL cluster. This does not complete
the restore/reconciliation/promotion workflow. Its internal database composition
now imports the current checkpoint, quarantines inherited work, reapplies deletion
and seals an immutable binding. Actual container/socket verification,
bootstrap-profile wiring, independently inspected host target binding,
fresh promotion proof, retained-image rollback
and explicit stale-socket recovery remain Task 11 work. In particular, the operations CLI's
`verify-runtime` command checks only database schema/deployment metadata; it is
not evidence of container, network, filesystem, socket or public-route safety.
P6-004 remains in progress and P6-GATE remains blocked.

No Ubuntu/SSH deployment, provider/Meta request, external infrastructure mutation or
production-number action is established by this checkpoint. The immediate
external-action approval boundary in Task 16 remains unchanged.

## Protected Host Configuration

Deployment configuration is a protected non-secret `KEY=value` file. Only the
explicit `FCD_` field allowlist is accepted. Values are literal, unquoted ASCII
data: there is no shell evaluation, sourcing of environment content or arbitrary
environment export. Duplicate/unknown keys, command substitution, NUL bytes,
relative/traversing paths and unsupported value types fail closed.

The file must be owned by the invoking account with mode 0400 or 0600. File
identity, size and ownership/mode are checked against the opened descriptor;
symlinked or untrusted writable ancestors are refused. Runtime configuration,
secrets and deployment state roots must be distinct protected directories outside
the checkout. The admin socket root must also be disjoint from these roots and
from database/archive volume storage, with actual UID/GID 1000:1000, mode 0700
and access by the invoking SSH account. No mkdir, chmod, chown, firewall repair
or socket removal is performed by these checks.

The preflight requires a clean exact-revision checkout, matching retained local
image labels/platform, a pre-provisioned owner-only deployment lock, and default
local volumes rather than arbitrary local-driver bind options. It rejects remote
Docker contexts and pins subsequent commands to the checked local Unix endpoint.
Compose runs with an empty explicit dotenv file and a restricted environment;
ambient Compose profiles/files or Docker endpoint variables are not inherited.
Timeouts and stop grace are supplied through protected configuration.

## Database Role Boundary

`configureRuntimeGrants` is an explicit bootstrap library, not an automatically
executed server change. Its initial owner credential must remain in the explicit
operations plane; no runtime role receives that credential. Separate dedicated
password files are required for all ten runtime/operations logins and the
migrator. Bootstrap requires a PostgreSQL superuser, an exact database/schema
scope marker, distinct protected password material and a nonblocking advisory
lock. Foreign role scopes, memberships in either direction and unknown tables
or views are refused rather than silently adopted.

Password-bearing DDL is issued only after statement/error/duration/sampling and
parameter logging are disabled for the bootstrap transaction. SCRAM is selected
explicitly. Failures expose only a closed error code, not a database exception,
password-bearing SQL or secret-file content. Existing managed role settings are
reset and the intended schema is bound for new logins.

Runtime logins are NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
NOBYPASSRLS and NOINHERIT. The migrator owns the application schema and objects;
runtime roles cannot create application tables, schemas or temporary tables.
PUBLIC create/temporary/function privileges are removed. Reruns converge relation,
column, sequence and function privileges, not merely add new grants.

The explicit repository/table/column matrix is in
`src/persistence/postgres-runtime-grants.ts`:

- Webhook admission can store receipts/events and inspect suppressions, not read
  contacts or administrator credentials.
- Reply and outbound have their implemented policy/work permissions, not
  administrator credential authority; outbound cannot write tombstones.
- Admin owns its private authentication and review workflows. Notification uses
  the minimized source view and delivery records, not consent/conversation writes.
- Maintenance can execute its bounded policy jobs, not publish knowledge.
  Health can record incidents but cannot acknowledge them, including on insertion.
- Backup can read business tables and sequence positions without advancing
  business IDs. Its only write exception is content-free backup catalog insertion
  and state advancement. Arbitrary catalog-material updates are denied.
- Verification has only its backup catalog permissions, not business-data reads.
  Checkpoint has tombstone/clock read access and signed catalog insertion, not
  direct tombstone or clock updates.

Checkpoint source freezing uses a fixed, schema-bound SECURITY DEFINER helper
owned by the nonsuperuser migrator. It only obtains the transaction's SHARE lock;
it accepts no caller SQL or table name. Checkpoint export calls it when bootstrap
has installed it. Existing isolated owner fixtures retain their direct-lock path.

## Forward Migration And Backup Ordering

`runForwardMigrations` accepts only forward execution against the schema version
actually packaged in the operations image. A mismatching target or newer installed
schema is refused. A deployment advisory lock and explicit single-transaction
migration run prevent concurrent/partially applied execution. The one-shot
connection is destroyed afterward so neither session settings nor locks leak.
No automatic down migration is available.

The host orchestration's tested ordering is controlled outage, database readiness,
encrypted pre-migration backup, separate identity-bearing verification, forward
migration, post-schema catalog adoption, started evidence, private startup,
verification and succeeded evidence. Failed backup verification cannot invoke
migration. Startup/verification failure stops applications and preserves volumes.
The backup reference command returns only its opaque internal archive reference;
ordinary scheduled backup output remains unchanged.

Pre-migration manifests sample the source migration registry rather than copy the
configured target schema version. An empty registry/schema is recorded as
`000000`; a populated registry retains its actual source version even when the
protected configuration names a higher migration target. Native CLI checks cover
both cases, including the actual nonsuperuser backup login.

Ordering tests substitute only the external Docker process. They do not prove
that a complete host deployment has occurred. Compiled CLI tests separately
exercise actual PostgreSQL migration/evidence and actual pg_dump/age verification.
Those checks still do not constitute a full database restore or promotion.

## Isolated Encrypted Restore Stage

`restoreEncryptedBackup` in `src/operations/restore.ts` is an internal SQL/stream
primitive, not a host command or a promotion authorization. No public host handler
or operations CLI invokes it yet. The host controller must independently establish
fresh volume/network isolation and supply the actual expected target cluster
identity before invoking it; SQL checks cannot prove Docker network membership.

The primitive selects an archive from the current source's PostgreSQL catalog,
requires verified/restore-verified state, and matches its signed on-disk manifest,
metadata and ciphertext digest. A catalog copied inside the selected archive is
not used to authorize the selection. It compares actual PostgreSQL system identifiers
and refuses the authoritative source cluster even when a different empty database
on that cluster was selected. A substituted target identity, populated user schema,
relation, function, type, extension, large object or another target database session
is refused. A nonblocking target advisory lock spans the operation.

After independent decrypt/list verification, it streams `age --decrypt` directly
into `pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname`.
There is no `--clean`, database recreation or plaintext dump file. The database
name is supplied explicitly: omitting it would emit SQL instead of restoring it.
PostgreSQL documents the direct-database and all-or-nothing transaction semantics
in its [pg_restore reference](https://www.postgresql.org/docs/18/app-pgrestore.html).
Only trusted catalogued application archives are accepted; restore can execute
source-defined SQL and is not a safe general-purpose importer for untrusted dumps.

The structural verifier drains the decrypt stream after `pg_restore --list`
finishes its table of contents. Otherwise large valid archives can fail with a
broken pipe, and stopping at the TOC would not establish complete decryption.
The bounded sink discards remaining plaintext without buffering it to a file;
both child exit statuses must still succeed. A late decryption failure continues
to reject verification. Full restore streams retain strict consumer behavior.

The subprocess environment is restricted, password material stays in an exclusive
owner-only temporary file on tmpfs, diagnostics are discarded, and SQL/process
timeouts are supplied explicitly. The streamed ciphertext's digest and open-file
stability are checked, both cluster identities are sampled again, and the actual
restored migration registry must match the signed source schema. Temporary
credentials are removed and one-shot connections are destroyed on success and
failure. Failures return only closed codes.

A SQL restore error rolls back its restore transaction. A later schema, digest or
identity verification failure can leave populated isolated data; the primitive
never deletes that target or switches applications to it. A `restored` result is
not `ready`, does not change the archive catalog to `restore_verified`, and does
not replace current checkpoint import, quarantine, rotated-key loading, bounded
deletion reapplication, a fresh persisted final gate or host target binding.

The separate `restore` native-test mode creates a labelled fresh internal network
and PostgreSQL volume. It uses a dedicated synthetic source database for a full
dump, including the shared `pg_trgm` dependency. A schema-only fixture initially
exposed a missing operator-class restore failure; the retained negative case now
proves that incomplete archive rolls back atomically rather than silently repairing
or accepting it. The harness also covers old admission-schema restore followed by
forward migration, real row preservation, source/target/session refusal, wrong or
missing identity, corrupt ciphertext, source-schema mismatch and timeout cleanup.
An additional real archive with 1 MiB of generated synthetic binary data proves
verification and full restoration beyond pipe-buffer size.

Loaded-cluster reruns exposed a fixture teardown timeout, not a restore assertion
failure. Closed diagnostics showed the synthetic source database's `DROP DATABASE`
waiting on PostgreSQL's `IPC / CheckpointDone` after the full regression workload.
This matches the forced checkpoint in
[PostgreSQL 18's database cleanup](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/dbcommands.c).
Snapshot teardown now runs in a separate, bounded 60-second cleanup hook instead
of consuming the unchanged 20-second assertion deadline. Restore/process
deadlines are unchanged; no PostgreSQL durability setting was altered and no
test was skipped. This fixture fix is separate from the large-archive verifier
fix. The same workload-then-restore reproduction subsequently passed all 14 cases
in 40.90 seconds including teardown; the old-admission restore/migration assertion
took 976 ms. The full Task 11 workflow remains unfinished.

## Independent Restore Host Inspection

`scripts/operations-restore-host.sh` supplies `operations_inspect_restore_host`
to the trusted host-control plane. The caller must retain the existing checked
deployment lock, protected configuration and local-Docker-endpoint preflight.
No public entrypoint or application process invokes it yet; missing-handler
interlocks remain unchanged.

The collector requests only fixed, narrowed Docker metadata: actual image IDs
and revisions/platforms/users; volume name, creation time, default local-driver
shape and project/logical labels; internal bridge-network ID and membership;
and database container health, role, mounts, publication and hardening flags.
It never requests environment variables, commands, arbitrary labels, secret
contents or full inspect output. Live-volume name/path aliasing, custom volume
options, foreign endpoints, extra networks, ports, namespaces, privileges or
mounts refuse validation. The target must have exactly one healthy hardened
PostgreSQL endpoint and one volume user. Stopped containers count as volume
users. A one-shot SQL job must be absent when this probe runs.

The metadata validator is `src/operations/restore-host-main.ts`, backed by
`restore-host.ts`. Its image is resolved to an immutable ID after checking the
revision, Linux/amd64 platform and unprivileged image user. The host launches
that ID with no network, mounts, Docker socket, secrets or database connection;
CPU, memory and PID bounds come from protected restore configuration. Input is
bounded to 64 KiB. Optional prior identity is parsed as data, never shell code.
Child stdout is withheld until successful exit; ambiguous transport results
and diagnostics produce only `restore_host_invalid`.

Both independently collected samples must validate and retain matching volume,
creation time, network/image identities and PostgreSQL container ID. This catches
replacement between samples but is not a reservation against later changes.
The result is content-free host metadata, not `ready` or a promotion token.
Actual SQL cluster/database/schema identity still comes from the database leg.
Fresh promotion must retain quiescence and recheck this host evidence before
attachment, including after interruption. Recovery-policy review is still
required before external execution.

The separate `scripts/test-restore-host.sh` harness builds the pinned application,
operations and PostgreSQL images and creates only labelled synthetic volumes,
networks and containers. It exercises the collector with the actual local Docker
CLI and the compiled validator, including a stopped volume reader, foreign
endpoint, extra database network, live-volume alias, selected runtime-image and
revision mismatch, and a recreated network under the same name. The harness's
development-host transport does not establish Ubuntu/SSH, protected host-path
permissions or deployment-lock preflight. No application attachment occurs.

## Local Verification

### Composed Database Reconciliation

`restoreAndReconcile` is an internal operations-plane function, not a host handler.
It returns historical `deletion_verified` evidence, never `ready`. The selected
archive's catalog lifecycle remains unchanged. The public restore/promotion
commands and operations CLI do not invoke this composition yet.

The function binds the stream destination URI, actual migration-owning PostgreSQL
connection and reconciliation connection to the same expected cluster/database.
The migration identity check runs before DDL on that very connection, not on a
separate preflight session. A native regression first reproduced a substituted
pool creating schema objects on the synthetic source; it must now reject without
creating them. Forward migration remains up-only and uses the packaged target
schema revision.

After restoration/migration, a bounded READ COMMITTED source transaction acquires
the checkpoint SHARE freeze before resampling its durable clock. The freeze is
retained through import, quarantine, bounded deletion batches, fresh finalization
and binding commit. Signed checkpoint freshness is checked before the stream,
again under that freeze and before commit. Gate key versions come from all active
target tombstones plus the configured active key, not only the archive's key list.
Missing old keys, exhausted batch bounds, changed source clocks and crossed
source or target-only time boundaries refuse the composition.
The native composition regression attempts an actual competing source deletion
at binding insertion and requires its bounded lock-timeout refusal, proving the
freeze remains held at the final evidence step.

Import, new recovery hold/quarantine, erasure, final gate, restore pass and binding
are one bounded target transaction. Failure rolls those changes back; the SQL
snapshot remains isolated and is never dropped or attached. One-shot sessions
are rolled back/destroyed on every path. Limits, batch bounds, age and clock are
explicit caller configuration within validation ceilings; no provider or customer
traffic is involved.

Migration 000016 adds `operations_restore_bindings`. It links the immutable
checkpoint import, source watermark/signature/ciphertext digest, a unique final
gate and passed restore run to the revision/schema and target identity digest.
The actual PostgreSQL cluster/database/schema are sampled; volume creation time,
network and image identities are **trusted host-controller inputs**, not facts
established by this database library. Native tests use explicitly synthetic host
metadata and real separate-cluster SQL identities. The independent host collector
above is now available, but locked controller wiring is still required before
host use.

Binding update/delete and populated truncate/downgrade are refused. An empty
binding table may be truncated only under READ COMMITTED after its ACCESS
EXCLUSIVE lock; the schema-qualified trigger refuses older isolation snapshots
and cannot be redirected by a caller's search path. This permits harmless empty
synthetic reset and empty migration rollback without deleting evidence. Runtime
roles cannot insert/update/delete/truncate bindings; admin/backup reads do not
confer publication or promotion authority. A final gate cannot seal two restores,
concurrent sealing produces one pass, and exact seal replay is refused.
An actual queued-truncate race starts while a writer's new binding is uncommitted;
after the writer commits, the guard sees that row and refuses truncation.
Empty downgrade obtains the same exclusive lock before checking emptiness and
rejects older isolation snapshots. A separate queued-downgrade regression first
reproduced loss of newly committed synthetic evidence; it now must retain both
the binding and migration registry entry. No production down migration is enabled.

`PostgresRestoreEvidence.load` returns historical evidence, including
`recoveryHeldAtSeal`, not a claim that recovery remains held now. Neither loading
nor copying that record authorizes attachment. `verifyPromotion`, fresh host
inspection wiring, current checkpoint refresh with all application access closed,
failure-safe switching and private-disabled startup remain unfinished. Human
policy review is still required before external execution after a switch.

### Commands And Evidence

Run the ordinary code and PostgreSQL gates plus the separate pinned nonroot
native-toolchain gate:

```text
npm run check
docker compose --file infra/compose.test.yml run --rm runner npm run test:integration
bash scripts/test-encrypted-backup.sh grants
bash scripts/test-encrypted-backup.sh restore
bash scripts/test-restore-host.sh
```

The native gate covers Linux-only filesystem, flock and script checks, real
nonsuperuser logins, pg_dump/age transfer, checkpoint locking and the compiled
private CLI. All fixtures are authored synthetic data on scoped local resources.

The 2026-10-19 (Asia/Dhaka) prerequisite checkpoint passed `npm run check` with
916 tests and 52 platform-specific skips across 62 files. The complete ordinary
PostgreSQL suite passed 529 tests with 13 native-only skips across 47 files
(103.65 seconds). The separate native gate passed 87 unit tests and 48 integration
tests, including those 13 integration skips. Post-test inventory reported zero
temporary schemas, advisory locks, generated database roles and scoped native
backup containers/volumes/images. These counts do not close Task 11.

The 2026-10-23 (Asia/Dhaka) SQL/stream checkpoint passed `npm run check` with
918 tests and 52 platform-specific skips across 62 files. The complete ordinary
PostgreSQL gate passed 529 tests with 27 native-only skips across 48 files
(103.41 seconds). The native `grants` gate passed 89 units and 48 integrations;
the native `restore` gate passed 42 units and 14 integrations, including real
full-size encrypted archive verification/restoration. Together they cover all
27 ordinary integration skips. Final inventory was zero temporary schemas,
advisory locks, generated role-prefix accounts, synthetic restore databases and
labelled backup-test containers, networks, volumes and candidate images.
The fixture checkpoint-wait diagnosis and separate teardown deadline are recorded
above. These passing gates do not close the full Task 11 completion contract.

The subsequent composed-reconciliation code gate passed 918 tests with 52
platform-specific skips across 62 files. The complete ordinary PostgreSQL suite
passed 568 tests with 33 native-only skips across 49 files (117.28 seconds),
including all 27 binding/migration/concurrency cases and actual nonsuperuser
migrator identity validation. Native `grants` passed 89 units/60 integrations;
native `restore` passed 42 units/20 integrations, covering all 33 ordinary
integration skips together. The loaded-cluster restore file passed in 24.25
seconds including teardown. These counts do not close Task 11; committed-source
confirmation is tracked separately from this prerequisite validation.

The 2026-10-24 (Asia/Dhaka) host-inspection checkpoint passed `npm run check`
with 959 tests and 52 platform-specific skips across 64 files, including 41 new
host-validator/collector cases. The complete ordinary PostgreSQL suite passed
568 tests with 33 native-only skips across 49 files (120.90 seconds). Native
`grants` passed 130 units/60 integrations; native `restore` passed 42 units/20
integrations. Together those gates cover all 33 ordinary integration skips.
The separate actual-Docker host harness passed eight cases and its JSON
projection/initial-sample boundary checks. These are local synthetic proofs of
host sampling, not an installed controller, promotion, application attachment or
Ubuntu/SSH gate. Task 11/P6-004 remain in progress.
