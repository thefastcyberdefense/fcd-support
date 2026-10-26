# Phase 6 Deployment Safety Prerequisites

## Implementation Status

This is an intermediate Task 11 checkpoint, not a deployment or restore gate pass.

### Restore metadata, promotion protocol and live-socket prerequisites

The next local prerequisite checkpoint adds a networkless strict target-metadata
codec and protected literal restore intent/completion history. An intent binds
source selection, physical identity, archive/checkpoint references, target scope,
images and revision before mutation. Completion requires the same quiescent source
and canonical target metadata, retains the immutable intent and refuses reused
references/targets, partial files, unsafe links/modes and changed source history.
Neither record is promotion authority or changes the selected volume.

The internal promotion command accepts only source checkpoint and target owner
database capabilities plus required deletion/checkpoint material. It refuses
archive/bootstrap/migrator credentials, binds actual sessions to physical database
identities and validates the previous restore binding. Two fresh canonical stdio
challenges couple the existing source-freeze/reconciliation library to future host
checks. Replayed, substituted, unsolicited, truncated, stalled or aborted exchanges
refuse; final acknowledgement requires both checks and successful pool shutdown.
The two-cluster native case exercises real post-archive deletion and both bindings;
it does not establish a host volume switch or deployed-runtime promotion.

Shared preflight now acquires the deployment lock and loads protected selection
before testing the admin socket, still before its first Docker call. Only a
matching managed READY deployment may retain a real UID/GID 1000, mode-0600,
single-link Unix socket with stable device/inode identity until controlled drain.
Initial admission and non-ready/unsafe evidence still refuse a present socket.
This preflight never connects, unlinks, changes permissions or stops a process;
the existing verify/recovery semantics remain unchanged.

Verification exited 0: the full code gate passed 1,444 tests with 365 platform
skips across 100 files (27.80 seconds for tests); native `restore` passed 142 unit
tests across eight files and 46 PostgreSQL integrations across two files
(28.38 seconds for integration). Native focused socket preflight passed all
21 cases, including 14 real Linux filesystem/Unix-socket cases. These are authored
synthetic local tests. The existing native host-preflight suite also passed all
50 cases after the call-order change. No server, browser, Meta, Manifest, n8n or
provider check is claimed.

Automatic approval review rejected the combined Compose patch that attached
restore/promotion to the source operations network and supplied all bootstrap
password files. It was not applied. The safer split-job proposal at
`docs/reviews/phase-6-restore-capability-boundary.md` separates target-only password
bootstrap/migration from jobs with source reachability. Its explicit owner decision
is pending; no production Compose/network/secret-mount change or server deployment
has occurred. Public restore/promotion wiring remains disabled.

### Earlier integration checkpoint

The 2026-10-26 integration work also adds a standalone restricted-capability
restore command, revision-pinned scheduler primitives, private health/dashboard
components and signed notification delivery. The actual synthetic restore-command
case preserves unrelated rows, reapplies current deletion, quarantines inherited
work, retains the recovery hold and acknowledges only after four managed pools
close. Its metadata argument describes the independently verified target; it is
not promotion authority. Public host restore/promotion/switch wiring remains
unfinished. Notification deletion now creates terminal source markers and cancels
pending/leased delivery in the erasure transaction while preserving attempt evidence
and the business escalation state. Health and notification enablement still do not
authorize external traffic. Scheduler/health/notification integration and aggregate
regression evidence are being completed; P6-GATE remains blocked.

The code gate passed with `VITEST_MAX_WORKERS=4 npm run check`: 1,382 passed,
331 platform skips across 95 files. The full ordinary PostgreSQL run passed
615 tests with 50 native-only skips across 56 files (128.20 seconds). A default-concurrency attempt hit the existing
five-second Phase 0 fixture-copy timeout under concurrent local Docker work; its
deadline was not increased. Native timer validation passed 63/63 using the real
offline systemd analyzer. The test image alone supplies that analyzer and a small
writable `/tmp`; the deployed operations image and host systemd remain unchanged.

The native aggregate run passed 850 units across 37 files and 133 PostgreSQL
cases with one native-restore-only skip, but initially failed the new scheduled
backup CLI fixture. That fixture supplied a schema-startup URL option that the
dump boundary correctly refuses. A restricted synthetic login with a default
namespace and query-free URL corrected the fixture without relaxing production
validation; its rerun passed all 43 backup units and all three real crypto/CLI
cases, including same-slot reference replay and separate verification. Following
host-health integration, focused native checks passed 17 host-collection and
65 scheduler cases. The native two-cluster restore file passed all 26 cases,
including the real restricted-capability command; a separate maintenance fixture
ACL cleanup failure was corrected and its compiled control passed in the aggregate
run. These are component/regression results, not a full deployed-runtime gate.

Current command composition now connects `deploy-runtime.sh`, `verify-runtime.sh`,
`rollback-runtime.sh` and `recover-admin-socket.sh` to the verified internal
controllers. Restore/promotion entry points remain disabled pending their host
integration. This is operator CLI availability, not new public HTTP exposure.
Fresh installation requires an absent target volume and absent runtime project;
its immutable intent precedes uniquely labelled volume creation and PostgreSQL-only
startup. Two fresh host/physical proofs precede quiescent pointer publication.
Interrupted intents, job records and pointer replacements refuse implicit replay.
Existing ready deployments use retained source image identities, and source
PostgreSQL directory ownership/modes are checked before application shutdown.
Legacy admission requires explicit protected `FCD_ADMISSION_REVISION`,
`FCD_ADMISSION_IMAGE` and `FCD_ADMISSION_POSTGRES_IMAGE` fields supplied by the
reviewed handoff. No source image identity is guessed from an untrusted label.
Version-one retained manifests authorize exact-schema rollback only; images are
not rebuilt, migrations never run down and data-volume selection never rolls
back automatically. All execution flags remain false.

Controller validation: `npm run check` exited 0 with 1,145 passing tests and 327
platform skips across 84 files. The complete native grants gate exited 0 with
628 unit tests across 27 files and 83 PostgreSQL integrations across seven files
(41.37 seconds for integration). Fourteen first-boot filesystem/Docker-transport
cases and eleven controller sequencing cases passed. Invalid arguments are
rejected before loading the larger controller; two initial Windows subprocess
timeouts exposed that ordering and the corrected entry tests now pass. These
results do not claim an actual full runtime deployment or server test.
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
and seals an immutable binding. A separate owner-only bootstrap profile now
prepares scoped roles before migration and converges application grants afterward.
Its invocation is not yet wired into public deployment. Runtime host inspection now
has an internal collector and validator, described below; public verification wiring,
bootstrap orchestration, independently inspected host target binding,
locked promotion/switch wiring, retained-image rollback
and explicit stale-socket recovery remain Task 11 work. In particular, the operations CLI's
`verify-runtime` command checks only database schema/deployment metadata; it is
not evidence of container, network, filesystem, socket or public-route safety.
P6-004 remains in progress and P6-GATE remains blocked.

## Durable Operation Job Lifecycle

The internal host controller now journals job intent under the pre-provisioned
`FCD_STATE_ROOT` before creating a stopped container. The root must be owned by
UID/GID 1000, mode 0700, on supported persistent local storage. Each journal is
a mode-0600, single-link literal record, checked against the held deployment
lock descriptor. It stores only scope/reference, service, revision, immutable
image ID, command hash, container ID and phase. It contains no command arguments,
credentials or business state. Writes and directory changes are synchronized;
PostgreSQL remains authoritative for application state.

Jobs use a unique Compose project and the existing private operations network.
Their archive volume must already exist; operations Compose cannot create it.
The controller checks the unique container, actual image, both Compose and job
scope labels, command and stopped state, then durably records its container ID
and started phase before issuing start. A success acknowledgement is buffered
until exit, fixed output validation, exact container removal and absence checks
have succeeded and the journal has been cleared.

Lost acknowledgements, failed jobs and uncertain cleanup preserve an unresolved
record. The controller attempts bounded shutdown/removal only for a verified
owned container. Successful cancellation does not establish whether a database
transaction committed, so it never silently clears uncertainty or replays the
job. A controller killed after start also leaves the record. Host preflight
refuses any pending record, including a symlink, before Docker access. Resolving
uncertainty still requires operation-specific postcondition reconciliation;
the internal filesystem transition helper is not a portable approval token.

Native tests cover 21 filesystem journal cases and 19 job lifecycle cases,
including process death, failed cancellation, wrong ownership/project/service,
duplicate discovery and lost create/start/wait/removal acknowledgements. Their
Docker transport is a test-owned executable double. The complete pinned native
gate passed 347 units and 68 integrations; the code gate passed 1,045 tests with
146 platform skips across 70 files. The full ordinary PostgreSQL regression and
isolated restore suite were not rerun for this host-only change. These internal
prerequisites do not enable the public deployment commands or close Task 11.
Bootstrap orchestration, source binding, selected-volume state, restore switching,
retained rollback, pending-job reconciliation and final public wiring remain.

A separate actual local Docker check runs the fixed stopped-create helper. It
refuses an absent external archive volume without creating it, then verifies the
created container's image/scope/command, hardening, archive configuration and
private network configuration. Its start timestamp stays zero: no job executes
and no database connection occurs. Scoped cleanup passes. Windows uses a
test-owned Compose-plugin configuration and empty-file/path adaptation; these
fixture adaptations do not relax the Linux production controller.

## Protected Selection And Retained Revisions

The internal host metadata library now stores a versioned selection pointer,
immutable used-volume history and immutable retained revision bundles under
`FCD_STATE_ROOT`. It uses the checked deployment lock, persistent local storage,
UID/GID 1000, protected ancestors and mode-0600 single-link files. Records are
literal data, never sourced. Writes are synchronized; selection replacement
checks inode/content identity before an atomic rename. A leftover replacement
file remains for reconciliation and blocks further selection reads.

Selection and history bind project, database/schema namespace, volume origin,
logical name, creation time and physical system identifier. A restored selection
requires a different cluster and an unused volume name, records the previous
volume, and cannot lower the recorded schema revision. Used-volume history is
never overwritten or deleted by this library. Losing the selection pointer while
any history exists refuses initialization, including a newly configured volume.
There is no implicit fallback to configuration or an older volume.

The phases are quiescent, draining, database-changing, switching, starting, ready
and uncertain. Write exposure
is recorded before application startup. It cannot be cleared for the same volume,
and uncertainty cannot silently transition to ready. Retained bundles can be
recorded only from a ready selection; they bind the full revision, namespace,
schema revision and application/operations/PostgreSQL image IDs. Identical
retention is idempotent; replacing a bundle with different IDs refuses.

These records contain no business state and grant no attachment authority. The
trusted controller must still prove current host/SQL identity, fresh restoration
and deletion evidence, quiescence and compatibility under its lock. Live image
inspection for retained-image compatibility, rollback execution, controlled-outage/startup integration, operation-specific
uncertainty resolution and public controller wiring remain incomplete. The
native filesystem cases do not constitute a deployed runtime or switch.

### Controlled application drain

The internal drain helper requires a durable `draining` selection with possible
writes recorded before any signal. A ready managed selection can enter this
phase. First adoption of the legacy admission deployment can initialize directly
in `draining`, without creating false ready or retained-image evidence. Adoption
is now preceded by protected source discovery; public deployment integration is
still pending. Before ready,
the schema field is a lower bound; only fresh SQL verification can establish
the schema for startup and retention.

Under the checked deployment lock, the helper binds the source revision and
independently supplied immutable application/PostgreSQL image IDs to each actual
container, its program, entrypoint, user and lifecycle. It checks private database
networks, absence of foreign peers, exclusive volume use, absence of application
named volumes, exact volume creation
identity and provenance, physical cluster identifier and all stopped/running host
binds for socket/database aliases. The legacy upstream PostgreSQL image has no
revision label or default image user. Admission mode accepts that shape only
for the caller's pinned image ID and still requires the actual container to run
as PostgreSQL's non-root user. Managed mode requires the source revision label.

It stops reply, outbound, notification, admin and API actors in that order,
checking the frozen actor set and source instance before and after each step.
PostgreSQL is never stopped or removed. A remaining socket blocks all container
removal and preserves its stopped owner for separate recovery; the drain never
unlinks or repairs it. Only after every actor is stopped and the socket absent
does the helper remove those exact containers, preserving images and volumes.
A lost stop/removal acknowledgement can be resolved only by proving the exact
postcondition. Any refused or interrupted drain remains non-ready; an observed
failure records uncertainty and never restarts an application. Final volume,
network, physical identifier and actor proofs precede `quiescent`.

The native shutdown matrix uses an executable Docker double with real protected
filesystem records, a real deployment lock and real Unix socket fixtures. A
separate actual local Docker check verifies the omitted-field projections on
the pinned upstream image and keeps its operation container unstarted. These
proofs do not establish server shutdown, adoption discovery, application startup,
promotion, rollback or P6 completion. Public host commands remain disabled.

Validation on 2026-10-25 (Asia/Dhaka): `npm run check` passed 1,072 tests with
215 platform skips across 73 files, plus lint, strict typecheck and build. The
complete pinned native gate passed 443 units across 16 files and 70 PostgreSQL
integrations across six files (36.54 seconds for the integration run), including
all 27 drain cases and both new draining-state cases. The actual stopped-create
check passed its seven existing checks and two upstream-image projections.
Full ordinary PostgreSQL and isolated restore were not rerun for this host-only
checkpoint; their latest results remain 574/39 native-only skips and 42 units/22
integrations respectively. No SSH, server, provider or external infrastructure
action occurred.

### First-admission discovery

The internal admission adopter requires independently supplied source revision
and immutable application/PostgreSQL image IDs. Under the deployment lock, it
refuses an existing pointer, pending replacement, active operation, used-volume
history or retained bundle before Docker access. It verifies the source images,
single running non-root legacy PostgreSQL actor, exact selected volume mount,
local default volume driver, creation time and Compose provenance. A strict
physical identifier read is surrounded by matching actor, mount, volume and image
samples. Changed or ambiguous discovery creates no new selection.

Successful discovery initializes a fresh draining reference with possible writes
already recorded, the observed physical cluster and source revision. Schema
`000000` is explicitly provisional until SQL verification; adoption does not
claim schema readiness or create a retained bundle. It never stops, removes or
starts a container. The controller must next invoke the separately verified
drain with the same source image pins. Native cases cover the composition of
adoption followed by drain, as well as standalone discovery refusals. A failed
durable write preserves partial history for reconciliation rather than erasing
it. The adopter remains internal; PostgreSQL container convergence, startup and
public controller integration are still unfinished.

For focused development, the networkless `state` test mode accepts one optional
test file from its fixed allowlist. Unknown paths and filtering the full `grants`
gate are refused before Docker; the complete gate always runs every selected
unit and integration test.

Adoption validation on 2026-10-25 (Asia/Dhaka): `npm run check` passed 1,072 tests
with 232 platform skips across 74 files, plus lint, typecheck and build. The pinned
native gate passed 460 units across 17 files and 70 PostgreSQL integrations across
six files (35.53 seconds for integrations), including the 16 discovery cases and
28 drain cases. Focused test-filter refusal checks passed twice. Full ordinary
PostgreSQL and isolated restore were not rerun; the SQL/restore implementation
and previous results are unchanged. This is local synthetic evidence only.

### PostgreSQL container convergence

The internal convergence helper operates only after applications have been
drained and removed. It verifies a quiescent selection, source revision/image,
the sole owned PostgreSQL actor, private networks, exclusive volume/socket
boundaries, physical cluster and data-directory contract. It accepts independently
pinned admission or managed source images, then binds target Compose interpolation
to the independently verified immutable PostgreSQL image for the target revision.

Before its first stop/remove/start, it synchronizes `database-changing` state.
This records the target revision without advancing the schema lower bound,
changing the selected volume or clearing prior write exposure. It stops and
removes only the verified old PostgreSQL container, preserves the volume and
images, and starts only PostgreSQL with dependencies, builds and pulls disabled.
Lost acknowledgements are resolved only by exact stopped/absent postconditions
and fresh complete target proof. Full PostgreSQL-only host inspection and the
selected physical identifier are checked before returning to quiescent. A
refused mutation records uncertainty; process death leaves a non-ready phase.
The helper never automatically restarts old actors, switches storage or repairs
filesystem permissions. It does not run owner bootstrap/migrations or start
applications; integration with those next stages remains unfinished.

The 19 native convergence cases use real protected filesystem state and a
deployment lock, an executable Docker double and a stub for the separately
tested PostgreSQL-only host collector. They do not constitute actual Docker
replacement, server shutdown or deployment evidence. Two added filesystem cases
cover the database-changing phase, preserved schema/write history and refusal
to bypass an outage or clear uncertainty.

### Existing-volume permission prerequisite

An actual local Docker check, `bash scripts/test-postgres-seed.sh`, observed
`999:999:1777` on a fresh volume seeded by the pinned upstream PostgreSQL image.
It starts only `stat`, with no network and no database server, then removes its
scoped container/volume. The hardened image requires `999:999:700` on the data
root, PostgreSQL-major directory and PGDATA. The convergence helper therefore
reads those three actual directories before stopping PostgreSQL and refuses
broad or wrong-owner storage. It never runs `chmod`, `chown` or a repair command.

The eventual public deployment preflight must perform this same read before
application shutdown. The existing server volume has not been inspected for
this prerequisite. Task 16 must record its actual modes/owners and, if necessary,
include an explicit reviewed permission-preparation or isolated-volume migration
step in the external handoff. The local upstream seed observation does not
establish the current server's permissions or authorize modifying them.

Convergence validation on 2026-10-25 (Asia/Dhaka): `npm run check` passed 1,072
tests with 253 platform skips across 75 files, plus lint, typecheck and build.
The complete pinned native gate passed 481 units across 18 files and 70
PostgreSQL integrations across six files (34.65 seconds for integrations).
Focused transition tests passed 30 cases; convergence passed 19. The separate
actual Docker seed proof passed with no database startup and scoped cleanup.
Full ordinary PostgreSQL and isolated restore were not rerun for this host-only
change. Public controllers and the server remain untouched.

### Private Compose integration boundaries

Rendered contracts now accept either full-revision image tags or exact lowercase
`sha256` image IDs. Full revision labels remain mandatory. Runtime and bootstrap
host proof bind any configured image ID to the actual container image and the
independently inspected image metadata. A different actual ID, changed revision
label or malformed identifier refuses. This allows the convergence stage's
immutable image interpolation to pass the same full host contract as tagged
artifacts; a rendered contract alone is not attachment authority.

The sanitized Compose launcher explicitly supplies `MODEL_EXECUTION_ENABLED`,
`OUTBOUND_EXECUTION_ENABLED` and `N8N_EXECUTION_ENABLED` as `false`, after all
configuration dictionary values. This satisfies the private runtime's required
interpolation and prevents ambient or in-memory execution flags from enabling
providers. These fixed flags enforce the approved private-disabled mode; they
are not rate/cost limits or model-policy defaults.

The actual local stopped-create harness now renders the runtime through this
same launcher and validates it with the compiled contract before creating its
stopped operation container. Its fixture keeps the configured stop grace aligned
with the synthetic runtime settings. The check starts no application or operation
job and makes no database connection. Windows fixture path/plugin adaptations
do not replace the separately gated Ubuntu/SSH validation.

### Bootstrap and private startup composition

The internal startup helper takes independently pinned application, operations
and PostgreSQL image IDs for the target revision. It checks the selected
quiescent cluster and namespace, refuses a known higher schema before any
upgrade, freezes image interpolation and requires the full PostgreSQL-only
contract/host proof. It then runs the verified owner-prepare, encrypted backup,
separate verification, migration, grant convergence and registration sequence.

The journalled deployment-started job independently verifies the actual SQL
schema, principal and cluster before candidate startup evidence is recorded.
The synchronized starting state records write exposure before Compose starts
only API, admin and reply with dependencies, builds and pulls disabled. Complete
runtime host, SQL, socket and process proofs must pass before and after the
journalled deployment-succeeded job. Only then can the selection become ready
and retain the three exact image IDs. SQL readiness probes use the durable job
executor inside this helper's private scope; they do not use the legacy
`run --rm` path. A lost start response is accepted only after full postcondition
verification, without replaying start.

The 19 orchestration cases use real Bash with test-owned boundary doubles. They
cover ordering, known schema incompatibility, target changes, failed upgrade or
metadata, lost start acknowledgement and failed readiness/retention. They do not
start real application containers. Failure records uncertainty, then attempts
verified containment of partial actors while preserving storage and unresolved
job evidence. Pending-job and state-replacement reconciliation remain required
before public controller enablement.
No public deployment/verification handler is introduced by this helper.

Startup integration validation on 2026-10-25 (Asia/Dhaka): `npm run check` passed
1,102 tests with 256 platform skips across 77 files, plus lint, typecheck and
build. The full pinned native gate passed 514 units across 20 files and 70
PostgreSQL integrations across six files (34.85 seconds for integrations).
This includes all 19 startup orchestration cases, nine direct immutable-image
cases, three native collector cases and two execution-environment cases. Actual
local Compose rendering/contract validation, seven existing stopped-create
checks and two upstream-image projections passed without job startup or database
connection in that harness. Full ordinary PostgreSQL and isolated restore were
not rerun; their SQL implementation is unchanged. No SSH/server/provider action
occurred, and Task 11/P6-004 remain in progress.

### Partial-start containment

The internal containment helper requires the held deployment lock, a readable
starting/uncertain target selection with write exposure, the selected volume and
an independently pinned application image for the exact revision. It verifies
each target actor's scope, image, user, command, entrypoint and frozen lifecycle;
admin additionally requires its dedicated socket bind. It stops only those
verified application actors and continues containing verified peers when another
actor is unknown or changes. It accepts a lost stop acknowledgement only after
the exact exited postcondition. Changed/unknown actors are preserved and cause
a closed failure. The final actor set and stopped identities are checked again.

It never stops PostgreSQL, removes a container/image/volume, repairs a directory,
unlinks a socket, restarts an actor or executes SQL. Stopped admin owners are
retained; any remaining socket is left for separately verified recovery. A pending
one-shot journal does not block this safety stop; its bytes are untouched and
no new database operation is authorized. Success means only that the verified
target actors stopped, not socket quiescence, job resolution or runtime readiness.

Startup failures now call this helper after marking uncertainty. Invalid argument
lists and already-ready/wrong-scope entry states refuse before changing state
or attempting containment. Unreadable pending replacement state still refuses
the containment scope check; it requires separate protected-state reconciliation.
Containment failure preserves uncertainty and does not trigger forced cleanup or
fallback. Public controllers remain disabled until those remaining recovery
paths and the rest of Task 11 are complete.

Containment validation on 2026-10-25 (Asia/Dhaka): `npm run check` passed 1,105
tests with 270 platform skips across 78 files, plus lint, typecheck and build.
The complete native gate passed 531 units across 21 files and 70 PostgreSQL
integrations across six files (35.18 seconds for integrations). Fourteen new
native containment cases preserve actual Unix socket device/inode and pending
journal bytes; startup orchestration passes 22 cases. Docker shutdown in those
cases uses executable doubles. Full ordinary PostgreSQL and isolated restore
were not rerun; no server/provider action or public enablement occurred.

### Operation/backend correlation prerequisite

Managed one-shot jobs now receive the same opaque `operation_` reference as their
durable journal. Operations-only secret loading binds database connections to
`fcd-support:<reference>` at PostgreSQL startup; the label is 54 ASCII bytes.
Existing namespace options are preserved and the fixed application name is
applied last, overriding URI name/options spoofing and ambient defaults. The
resolved database URI remains non-enumerable/redacted, and errors contain no URI
or reference values. Runtime application roles reject this field before reading
credentials; direct legacy CLI use without a reference is unchanged.

Encrypted backup exports pass the canonical name to both the snapshot exporter
and external `pg_dump`. The native dump connection accepts only the canonical
name and matching fixed startup options; arbitrary query options remain refused.
The operations image advertises reference-input capability. That capability and
reference are correlation metadata, not authorization to clear a journal or
attach applications.

Actual local PostgreSQL tests verify namespace preservation, startup-name
override, visibility while connected and disappearance after closure. The real
encrypted-backup test holds an authored fixture table lock long enough to observe
both exporter and dump backends under the same reference, then confirms zero
matching backends before accepting completion. Compiled bootstrap and deployment
CLI integration fixtures also use operation references. The actual stopped-create
Docker check verifies the reference environment field without starting the job.

Journal settlement still requires verified job termination and fresh PostgreSQL
backend/operation postconditions before any clear. No resolver is enabled by
this change. Legacy untracked images/jobs cannot be assumed settled from a zero
reference count. Isolated-restore target connection tracking remains part of the
unfinished restore host integration; its internal static labels are not covered
by this managed-job claim. No production/server/provider traffic was used.

Correlation checkpoint validation: `npm run check` exited 0 with 1,119 passing
tests and 270 platform skips across 79 files. The actual stopped-create check
exited 0 with 11 checks; the job was never started. A prior native regression
hit the drain fixture's 15-second aggregate subprocess allowance; an isolated
rerun passed all 28 cases (the slow case took 11.5 seconds). Its aggregate
allowance is now 30 seconds with a 35-second test deadline; production command
timeouts are unchanged.
The complete native grants gate exited 0 with 545 unit tests across 22 files
and 71 PostgreSQL integration tests across six files (35.89 seconds for the
integration pass). Cleanup checks found zero generated schemas, roles, advisory
locks, labelled test resources or candidate images. These are local synthetic
results; the deployment/restore workflow remains incomplete.

### Interrupted-job recovery prerequisites

`operations_contain_interrupted_job` is an internal containment primitive for a
recorded container in created, started or uncertain state. It requires the
checked local configuration and held deployment lock. Before stopping anything
it verifies the current exact revision and operations image, image reference
capability, journal container ID and command hash, unique Compose ownership,
entrypoint, non-root user, read-only root, no privilege or host publication and
an unchanged start cookie. A narrow environment projection binds its operation
reference and database system/name/schema/role-prefix/schema-revision metadata
to the protected selection and configuration. It never projects a database URI
or the full environment. Journal and selection replacement checks guard the
destructive boundaries.

The controller records uncertainty before shutdown. Lost stop or remove
acknowledgements succeed only when the exact unchanged actor is stopped and its
subsequent absence is verified. It preserves both uncertain records, the job
override, PostgreSQL, storage and application containers. It does not replay,
start another job, inspect logs, clear a journal or report application readiness.
Pending IDs, pending state replacements and missing actors refuse; adoption and
resolution of those interrupted boundaries remain unfinished. These checks do
not independently prove the actual database host/volume: fresh host inspection
and SQL scope checks remain mandatory for the eventual recovery controller.

`inspectOperationSettlement` provides the separate SQL prerequisite. Its owner
connection starts a read-only transaction, verifies the physical database identity
on that connection and requires a distinct, correctly tracked probe reference
with full PostgreSQL activity visibility. It acquires both existing grants and
deployment advisory barriers without waiting, clears the statistics snapshot,
and requires zero old-reference backends across all databases and zero prepared
transactions across the cluster. Existing or ambiguous activity refuses. It rolls
back and destroys its connection; the compiled `inspect-settlement` command also
closes its pool before emitting its fixed acknowledgement. The command reads no
role password files and changes no grants or business state.

The settlement result is a backend observation after independently verified job
termination, not evidence of the interrupted job's success. Legacy images and
untracked connection classes remain unsupported. The SQL probe and containment
primitive are not yet wired into a durable recovery controller. That controller
must preserve the original journal while running a separately tracked read-only
probe, verify operation-specific current postconditions and fresh host state,
and resolve uncertainty without inventing success or automatically replaying the
operation. Pending selection replacement, empty first boot, restore ownership/
switching, retained-image compatibility and public controller integration remain
Task 11 work. No server deployment or live provider call occurred.

The focused native settlement gate exited 0 with 28 unit tests and 12 actual
PostgreSQL/compiled-CLI integration tests. Those cases include lingering same-DB
and other-DB connections, each held advisory barrier, wrong identities and an
untracked probe. The containment matrix exited 0 with 23 cases using real
protected filesystem/flock boundaries and a Docker executable double; it did not
start or stop actual runtime jobs. The prepared-transaction refusal and connection/
close-failure paths have unit coverage; no actual prepared transaction was created.

The final frozen code gate exited 0 with 1,134 passing tests and 293 platform
skips across 81 files. The full native grants gate exited 0 with 583 unit tests
across 24 files and 83 PostgreSQL integration tests across seven files (37.21
seconds for integration). The actual stopped-create harness exited 0 with 12
checks, including image recovery-capability labels; its job was never started.
The earlier full run's tests passed, but editing its active shell runner caused
a wrapper syntax failure; that run is not counted as a gate pass. The frozen
rerun above supplies the complete passing evidence. Cleanup found zero generated
schemas, roles, advisory locks, labelled test resources and candidate images.

### First-boot intent prerequisite

An immutable `initial-deployment.record` now binds a random internal selection
reference, exact revision, three immutable image IDs, intended volume, database,
schema, role prefix and target schema revision under the existing protected
root/flock. Its typed 12-field record uses exclusive creation, file/directory
sync and verified reads. It contains no invented physical database identifier,
write-exposure flag or readiness state. It cannot be replaced by a second create,
and changed scope/images or a pending replacement refuse.

Creation refuses existing selection/history, pending job/transition evidence or
an earlier initialization intent. A pending intent blocks ordinary selection
initialization, legacy admission adoption and the missing-pointer PostgreSQL
inspection path. This prevents those paths from treating an interrupted first
boot as an unused deployment. The intent is metadata only: it neither proves an
empty target nor creates/attaches a volume, starts PostgreSQL, runs SQL or grants
application access. The future first-boot controller must verify fresh host
eligibility before recording intent, create/bind the intended volume safely,
sample the actual initialized physical identity and publish a matching protected
selection only after fresh proofs. That controller and interrupted-intent
reconciliation remain unfinished; no implicit repair or reinitialization exists.

Validation exited 0: `npm run check` passed 1,134 tests with 313 platform skips
across 82 files; the complete native grants gate passed 603 unit tests across
25 files and 83 PostgreSQL integration tests across seven files (38.09 seconds
for integration). This includes 20 first-boot intent/guard cases using real
protected filesystem/flock boundaries. Syntax, formatting and diff checks passed.
Cleanup found zero generated schemas, roles, advisory locks, labelled resources
and candidate images. These checks do not test actual first-boot database startup
or deploy anything to the local server. Task 11/P6-004 remain in progress.

### Earlier protected-selection validation

Code gate 1,066 passed/171 platform skips across 72 files; combined
native gate 393 units/70 integrations. The multi-step switch test has a 20-second
aggregate allowance for its separately bounded subprocesses; production command
timeouts are unchanged. The last full ordinary PostgreSQL and isolated restore
runs remain the source-binding checkpoint below; neither was repeated for this
host-filesystem-only change.

The selection adapter now sets Compose's volume interpolation from the validated
pointer and refuses a missing record. Host inspection reads the protected record
before and after its Docker/readiness samples. It compares the independently
sampled physical identifier before SQL probes and rejects changed record stamps,
stale configured volume names and missing pointers with history. A configured
runtime also requires starting/ready phase, recorded write exposure and matching
revision/schema; an empty state root cannot silently verify a running runtime.

The compiled validator accepts a separately supplied exact volume identity:
name, creation time and the original Docker project/logical labels. This supports
restored-volume labels and explicitly absent labels on pre-provisioned volumes;
it never rewrites labels or infers expected provenance from its current sample.
Without an explicit selection binding, the original managed-volume rule remains.
The remaining image/resource/network/socket and foreign-bind checks are unchanged.

The host collector cases use a state-reader adapter double and fake Docker
transport with the real compiled validator; the state protocol is covered
separately by 26 native filesystem cases. These are component proofs, not an
actual server deployment or complete promotion. The actual local stopped-create
proof also checks Docker's absent-label projection on its scoped external volume.

Selection-binding validation: code gate 1,072 passed/186 platform skips across
72 files; networkless host harness 154 passed; state/lifecycle harness 132 passed;
combined native gate 414 units/70 integrations. The actual local stopped-create
check passed seven closed checks and removed its scoped resources. The latest
full ordinary PostgreSQL and isolated restore evidence remains the earlier
source-binding checkpoint; this extension changes host metadata verification.

## Deployment SQL Target And Principal

The internal database-upgrade helper now composes owner preparation, a separately
verified pre-migration backup, nonsuperuser forward migration, owner grant
convergence and final archive registration. It requires an idle protected job
journal and the PostgreSQL-only host proof. It samples its own physical identity,
retains container ID/start time, and checks the host/instance/identity around
each isolated job. Failed stages, invalid references, process restarts and target
substitutions stop the sequence. It never starts applications or switches storage.
The existing bare `fcd-support` runtime project is accepted without permitting
that bare name for isolated restore projects.

Seventeen shell orchestration cases use trusted-function doubles; they do not
constitute a whole Docker deployment. Code gate: 1,066 passed/146 platform skips
across 71 files. The native gate passed 368 units/70 integrations, including
these cases and the actual restricted-role SQL/crypto/CLI tests. The full ordinary
PostgreSQL and isolated restore runs below were not repeated for this shell-only
extension. Controlled drain/removal/startup, persistent
selected-volume state, restore/promotion switching, retained rollback and public
command wiring remain unfinished.

Compiled backup, backup verification and checkpoint jobs now also require
`OPS_DATABASE_SYSTEM_IDENTIFIER` and `OPS_DATABASE_NAME`. The private host sampler
supplies these values; a connection URI does not establish the expected identity.
Missing or mismatched bindings refuse without a new eligible archive. Backup
checks its metadata connection and passes the binding into archive production.
The archive producer verifies its actual source, exports a read-only,
repeatable-read snapshot and passes that snapshot to `pg_dump`. The exporter
must close successfully before the signed manifest is published. Checked-out
connection errors are contained, and a terminated exporting session refuses.

Checkpoint export compares identity on its own transaction before taking the
source freeze and reading suppression state. A caller-held transaction uses
that same connection. The internal library options remain optional for existing
compositions; the compiled host CLI requires the binding. Backup/checkpoint
acknowledgements wait for metadata pool closure. Native tests cover wrong/missing
bindings, unchanged archive inventories, actual restricted-role backups on
empty/admission schemas and exporter loss. This does not wire public deployment
or establish a complete restore/promotion workflow.

Source-binding checkpoint validation: code gate 1,045 passed/146 platform skips;
pinned native gate 347 units/70 integrations; full ordinary PostgreSQL regression
574 passed/39 native-only skips across 50 files (118.53 seconds); isolated native
restore 42 units/22 integrations (26.74-second integration file). All 39 ordinary
integration skips are covered by the separate native runs. No server, provider
or production asset was contacted.

The deployment CLI now requires `OPS_DATABASE_SYSTEM_IDENTIFIER`,
`OPS_DATABASE_NAME` and `OPS_DATABASE_ROLE_PREFIX`. A missing or invalid binding
refuses before application DDL. The migrator compares actual cluster/database
identity on its DDL-owning connection. Deployment evidence and SQL verification
perform the same comparison on their transaction-owning connection and take the
same deployment advisory lock before accessing revision evidence.

The actual session login and current role must both match the managed migrator.
That role must retain its bootstrap scope marker, own the expected schema, use
that schema, have no memberships and have the intended nonsuperuser attributes.
The bootstrap owner URI is refused even if it points to the right database. A
correctly named role later promoted to superuser is also refused. The fixed
catalogue helpers are schema-qualified, and evidence writes use the checked
transaction and narrowed search path. Success is emitted only after the one-shot
connection and pool close successfully.

Native RED reproduced both a wrong cluster being ignored and owner credentials
being accepted for application migration. The updated compiled CLI fixture uses
a real prepared nonsuperuser login, rejects those cases before schema changes,
and proves that target/principal refusals do not add deployment rows. It also
rejects a competing deployment lock. Actual local test `pg_controldata` and SQL
system identifiers matched; only that closed comparison result was recorded.
The host wrapper still needs to sample and pass that physical binding dynamically
as part of bootstrap/deployment orchestration. This change does not enable a
public deployment handler or authorize server mutation.

Target/principal checkpoint validation: `npm run check` passed 1,032 tests with
80 platform skips across 67 files. Pinned native `grants` passed 268 units and
68 integrations, including the expanded compiled CLI case (6.54 seconds).
Native `restore` passed 42 units and 22 integrations (26.69-second file including
teardown), retaining older-admission and substituted-target coverage. The latest
full ordinary PostgreSQL regression remains the earlier bootstrap checkpoint's
574 passed/37 separately covered native skips; it was not rerun for this change.

## Current Runtime Host Inspection

The same internal validator now has a separate bootstrap mode. It requires only
the selected PostgreSQL container on all six private data networks, matching
storage/image/resource proofs, and an absent admin socket. Application members,
extra volume users, changed samples and overlapping foreign binds refuse. A
stopped admin container retaining the socket-root bind also blocks this proof;
future deployment orchestration must dispose of the verified stopped application
container rather than unlinking a socket or weakening that boundary.

`operations-database.sh` reads the system identifier from the selected container's
fixed PostgreSQL control-file path. Image, revision, unique container and start
identity are checked before and after the read. The fixed container-side parser
rejects tool failures, warnings and duplicate identifiers. The host accepts only
one positive unsigned 64-bit decimal line, preserving trailing delimiters while
checking it. Runtime inspection passes this freshly sampled value and the protected
database/schema/role-prefix/revision fields into the deployment SQL job. It does
not derive the expected cluster from the same unverified connection URI.

Validation for this extension: code gate 1,045 passed/104 platform skips across
68 files; networkless native harness 134 passed; combined pinned native gate
305 units/68 integrations. Thirteen new metadata cases, seven shell bootstrap
cases, seventeen physical-reader cases and the identifier-to-job bridge pass.
The physical-reader cases include actual execution of the fixed parser against
synthetic warning/duplicate/failure output. All five projection/parser checks pass
against actual local test Docker resources, including control-file/SQL identity
equality. Docker transport remains faked in the shell orchestration cases. No
fully deployed runtime, bootstrap ordering or server acceptance is established.

`operations-runtime-host.sh` collects two narrowed Docker snapshots around separate
SQL, API, admin Unix-socket, admin TCP-absence and reply-heartbeat probes. It never
requests full inspect output, environment values, message rows or secret contents.
Environment metadata contains names only, plus the three execution flags mapped
to closed boolean values or an invalid marker. Its compiled validator runs by an
inspected immutable image ID, without networks, mounts, secrets or Docker access.
The caller must retain the protected configuration, local-daemon preflight and
deployment lock throughout this current inspection.

The validator first checks the rendered private-disabled Compose contract. It
then compares actual images, revisions, commands, non-root users, resource limits,
read-only roots, capability restrictions, tmpfs settings, mounts, no host ports and
exact per-role network memberships. Only PostgreSQL, API, admin and reply may be
present in the runtime project. Each internal data network must have its exact
expected members; ingress must contain only the API and the independently selected
peer identified by protected `FCD_INGRESS_PEER_ID`. No route or tunnel is changed.
All three external execution flags remain false.

All containers, including stopped containers in other projects, are scanned for
binds overlapping the admin socket root or selected PostgreSQL storage. Secret
binds must be read-only and match their configured role-specific source files.
The admin socket/root retain exact UID/GID/mode and device/inode identity; aliases,
parent mounts, foreign users, replacement and restart between samples refuse.
The selected local volume must have only the selected PostgreSQL container as a
user. Successful Docker health alone cannot satisfy any missing process probe.

This is still an internal inspection capability. Public commands remain disabled;
bootstrap orchestration, locked restore/promotion switching, compatible retained
rollback and ambiguous-job cancellation/cleanup remain before those commands can
be enabled. A closed verification result is a current sample, not an attachment
token or a replacement for source quiescence.

Local validation: `npm run check` passed 1,032 tests with 80 platform skips across
67 files. The networkless native verifier/collector harness passed 97 tests;
its five shell cases use a fake Docker transport with the real compiled validator
and real scoped Unix socket/stat fixtures. They cover success, failed probing,
changed samples, an extra container and a successful-looking result followed by
a failed Docker command. The combined pinned native gate passed 268 units and
68 PostgreSQL integrations. Four narrowed projection formats passed against the
actual local synthetic Docker test database resources. Those shape checks do not
attest that the older test database is a hardened runtime, and the fake transport
cases do not establish a fully deployed private runtime. Final checks found zero
test schemas, advisory locks, generated roles, scoped helper containers or backup
candidate images. No server deployment or live service request occurred.

## Explicit Bootstrap Profile

The `operations-bootstrap` profile is an explicit one-shot job. It receives the
PostgreSQL owner URI and eleven distinct role-password files; normal migration,
backup, verification and application jobs receive none of those bootstrap files.
It has no archive or database-volume mount, no identity, no host publication and
only the private operations data network. Its non-root, read-only container uses
the configured migrator resource limits. The command has no default phase or
cluster argument, so invoking the profile alone refuses before reading secrets.

`bootstrap-main` requires `prepare` or `converge`, an independently obtained actual
PostgreSQL system identifier and the protected password-file directory. It binds
the actual connection's cluster and database before role changes, requires all
external execution flags disabled, and emits only a closed result. Password DDL
uses the existing transaction-local logging suppression. A configurable deadline
rolls back preparation; termination of its one-shot owner connection is handled
without an uncaught error or successful acknowledgement after an ambiguous close.

Preparation accepts an empty namespace or a known migrated application schema,
rejects foreign objects without migration evidence, and is replayable. Application
roles receive no business-table privileges yet. The backup login can read the
existing business data and sequence positions, with the narrow existing backup
catalogue exception where that catalogue exists. Separate verification can record
its result. The dedicated nonsuperuser migrator then runs forward migrations;
explicit convergence finally grants each runtime role its existing allowlist.
Protected host configuration now requires `FCD_DATABASE_SCHEMA` and
`FCD_DATABASE_ROLE_PREFIX`; neither is executable shell content.

Local native fixtures prove empty and old-admission preparation, actual encrypted
backup with the identity unreadable, separate decryption/list verification before
migration, nonsuperuser migration, post-migration convergence and receipt
preservation. They also cover current-catalogue state updates, foreign function/type
refusal, atomic deadline failure and wrong-cluster CLI refusal. The rendered
Compose test rejects seven changes involving secret leakage, external networks,
execution flags, default arguments and profile removal. This is a bootstrap
prerequisite, not a completed locked host deployment controller.

Bootstrap checkpoint validation on 2026-10-24 (Asia/Dhaka): `npm run check`
passed 979 tests with 74 platform skips across 67 files. The full ordinary
PostgreSQL suite passed 574 tests with 37 native-only skips across 50 files
(138.71 seconds). Native `grants` passed 171 units and 68 integrations; native
`restore` passed 42 units and 22 integrations, covering every integration skip.
The render-only bootstrap gate and all seven negative controls passed. The full
local topology gate passed with nine allowed and twenty denied paths, no admin
TCP listener and real socket UID separation. Formatting, shell syntax and diff
checks passed. Final database checks found zero test schemas, advisory locks,
generated role accounts or synthetic restore databases; no labelled backup-test
container, volume or network remained. These are local synthetic checks only.

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
nor copying that record authorizes attachment. The internal `verifyPromotion`
prerequisite below now refreshes the database proof. Fresh host inspection and
quiescence wiring, failure-safe switching and private-disabled startup remain unfinished. Human
policy review is still required before external execution after a switch.

### Fresh Promotion Verification

`verifyPromotion` requires the historical restore reference plus a distinct
`verificationRef`, actual target identity, reviewed revision/schema, current
signed checkpoint, complete active keyring and explicit batch/time bounds.
It does not restore the SQL archive again. Shared reconciliation imports the
current checkpoint under the new reference, fences inherited work, reapplies
deletions and seals a new immutable gate/binding in one target transaction.
The old import and binding remain unchanged. The additional recovery hold is
not automatically reviewed or released.

The parent must still be held and unreviewed, match every target identity and
revision/schema field, and have no failed restore outcome. Current PostgreSQL
cluster identity must match the source recorded at restore time. The fresh
checkpoint must retain that source catalogue's epoch and never regress its
sequence; a valid signature from a different catalogue on the same cluster is
not sufficient. The target uses the same deployment advisory-lock namespace
as the migrator, refusing a concurrent deployment instead of returning readiness.

The trusted host caller supplies `assertQuiesced(signal)`. It must retain its
checked deployment lock, actual source application shutdown and target isolation
before invoking the verifier until the eventual switch is complete. The
assertion runs before work and again during the final source freeze. A supplied
deadline and AbortSignal bound it, including a noncooperative callback; only
successful completion without a value is accepted. The source freeze remains
held through checkpoint validation, target commit and final evidence. A stale
checkpoint, lost quiescence, changed identity, missing key, time boundary or
exhausted batch bound rolls back all fresh evidence/erasure.

The returned `{status:'ready'}` is an internal result for that still-quiesced
operation, not a transferable token, saved approval or Docker attachment.
No public promotion controller invokes it yet. Docker inspection and the
quiescence implementation must be wired and rechecked through failure-safe
switching before any application attachment. No external-execution flag is
enabled by this function.

### Explicit Stale Socket Recovery Prerequisites

`admin-socket-recovery.ts` is a separate compiled filesystem helper. It requires
Linux UID/GID 1000, a real owned 0700 directory and the exact owned 0600 socket
device/inode supplied by the checked host. Only an actual bounded Unix
`ECONNREFUSED` result can permit removal; an active non-HTTP listener, timeout,
missing path, regular file, directory or symlink is not evidence of staleness.
The helper rechecks directory/socket identity and its monotonic deadline before
one unlink. It creates no directory, repairs no permissions and stops no process.

The internal `scripts/operations-admin-socket.sh` controller additionally checks
a unique exited admin container, exact project/service/revision and selected
runtime image identity. It scans bind sources of every container, including
stopped containers, resolves canonical host paths and refuses foreign, aliased
or ancestor/descendant access to the socket root. The owner's mount must be the
exact dedicated writable admin-socket mount. Unknown or unresolvable bind shapes
fail closed rather than being ignored. The root remains subject to the shared
protected-ancestor/local-daemon/deployment-lock preflight.

The helper image is resolved to a checked immutable ID. Its invocation has no
network, Docker socket or secrets, a read-only root filesystem, explicit resource
bounds and only the dedicated socket-directory bind. Ambiguous transport stdout
is withheld. Native tests exercise the real compiled filesystem helper behind
a fake external Docker transport; they do not establish real Ubuntu daemon,
UID mapping or SSH behavior. Neither this library nor its helper is wired into
the public recovery command yet. Cancellation/cleanup of ambiguous jobs, full
runtime verification and the completed host controller remain required before
enabling that command.

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

The subsequent promotion/socket prerequisite gate passed 959 code tests with
74 platform skips across 66 files. The additional 22 Linux socket cases pass
in the native gate, including the real compiled helper behind the fake Docker
transport. Native `grants` passed 152 units/60 integrations; native `restore`
passed 42 units/22 integrations. These include post-restore deletion refresh,
source-catalogue substitution and sequence regression refusal, quiescence
deadline/abort and rollback, binding replay refusal and source-freeze contention.
Three narrowed projection shapes were also checked against actual local test
Docker metadata. The full ordinary PostgreSQL regression passed 568 tests with
35 native-only skips across 49 files (116.04 seconds); all 35 skips are covered
by the native gates. This is still not a public recovery/promotion command, actual
server deployment or P6-GATE pass.
