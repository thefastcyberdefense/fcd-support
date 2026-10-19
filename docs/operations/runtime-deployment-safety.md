# Phase 6 Deployment Safety Prerequisites

## Implementation Status

This is an intermediate Task 11 checkpoint, not a deployment or restore gate pass.
The role bootstrap library, protected host configuration/preflight, orchestration
ordering and forward-migration primitive are implemented locally. The public
host commands refuse an incomplete installation before Docker activity when a
required verification or recovery handler is absent. They are not ready for
server use.

Actual container/socket verification, bootstrap-profile wiring, complete isolated
database restore, bound promotion proof, retained-image rollback and explicit
stale-socket recovery remain Task 11 work. In particular, the operations CLI's
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

## Local Verification

Run the ordinary code and PostgreSQL gates plus the separate pinned nonroot
native-toolchain gate:

```text
npm run check
docker compose --file infra/compose.test.yml run --rm runner npm run test:integration
bash scripts/test-encrypted-backup.sh grants
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
