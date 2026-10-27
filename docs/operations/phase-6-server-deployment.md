# Phase 6 Local Server Deployment And Validation

## Authorization and sequence

The owner approved continued Phase 6/7 development and repeated test deployment
on `redwan@192.168.10.40` on 2026-10-26. Routine implementation decisions are
delegated. Production assets, existing unknown-provenance data and live provider
traffic remain protected. This record makes the next authorized server action
concrete before execution; it does not declare a P6 or P7 gate pass.

Stage A runs the committed synthetic test stack on the real Ubuntu/Docker host.
It precedes the final gate to expose host-specific defects early. Stage B will
exercise the complete hardened controller with fresh synthetic configuration
and storage after its exact commands are added here. Replacing the existing
admission stack, enabling live providers and testing actual Meta assets are
later, separate steps with their own recorded prerequisites.

## Stage A immutable source and affected resources

- Source: `83978fc4ed3b5986c213b6ebaa056e1dc3f320c0`.
- Checkout: `/home/redwan/apps/fcd-support`.
- Expected starting checkout: `207a5e6357c1e1a7c75918793262d835574d898d`, clean.
- Fresh Compose project: `fcd-support-test-p6-83978fc`.
- Private test network: `fcd-support-test-p6-83978fc_data`.
- Synthetic volume: `fcd-support-test-p6-83978fc_postgres_test_data`.
- New private logs: `/home/redwan/fcd-support-validation-83978fc`, mode `0700`.
- The harness creates uniquely labelled `fcd-support-backup-test-*` resources
  and removes only resources whose exact ownership labels match its own run.
- Builds use the repository's pinned Node/PostgreSQL/operations images and
  authored fixtures. The local integration-image tag may be rebuilt. No broad
  Docker cleanup, image pruning or removal of another project's resource occurs.

The existing API, PostgreSQL, tunnel, database volume, protected configuration,
test subscriptions and public route are not changed. The Git checkout advances,
but the existing containers execute their retained built images. No live secret
file is mounted in the synthetic jobs. Host Node 24.16.0 is not used for npm
validation; the tests execute inside the pinned container toolchain.

## Stage A exact action list

Use BatchMode, a ten-second connection timeout and StrictHostKeyChecking=yes.
Before mutation, require the clean starting revision above, UID/GID `1000:1000`,
at least 12 GiB free on the Docker filesystem, no pre-existing resource for the
fresh Compose project and no pre-existing log directory. Capture only ID,
start-time and running-state snapshots of these retained containers:

```text
fcd-support-fcd-support-api-1
fcd-support-postgres-1
fcd-support-cloudflared
```

Then execute these commands, stopping on any failure. Redirect test/build/Git
output to the protected log directory; report only closed status, counts,
durations and version/revision evidence.

```bash
umask 077
cd /home/redwan/apps/fcd-support
FCD_TEST_REVISION=83978fc4ed3b5986c213b6ebaa056e1dc3f320c0
FCD_TEST_PROJECT=fcd-support-test-p6-83978fc
FCD_TEST_LOG=/home/redwan/fcd-support-validation-83978fc
mkdir -m 0700 "$FCD_TEST_LOG"
git fetch --no-tags origin main >"$FCD_TEST_LOG/git-fetch.log" 2>&1
git cat-file -e "${FCD_TEST_REVISION}^{commit}"
git checkout --detach "$FCD_TEST_REVISION" >"$FCD_TEST_LOG/git-checkout.log" 2>&1
test "$(git rev-parse HEAD)" = "$FCD_TEST_REVISION"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
export FCD_SYNTHETIC_TEST_PROJECT="$FCD_TEST_PROJECT"
bash scripts/test-encrypted-backup.sh unit >"$FCD_TEST_LOG/unit.log" 2>&1
docker compose --file infra/compose.test.yml --project-name "$FCD_TEST_PROJECT" \
  run --build --rm runner npm run test:integration >"$FCD_TEST_LOG/postgres.log" 2>&1
bash scripts/test-encrypted-backup.sh grants >"$FCD_TEST_LOG/grants.log" 2>&1
bash scripts/test-encrypted-backup.sh restore >"$FCD_TEST_LOG/restore.log" 2>&1
```

After the jobs, verify zero temporary schemas, generated fixture roles and
advisory locks using counts only. Verify the test network is internal, has only
the intended PostgreSQL endpoint and publishes no ports. Compare all three
retained-container snapshots with the initial snapshots. A mismatch is a failed
isolation check, not grounds to restart or repair an existing service.

After successful ownership/member checks, remove only the fresh project with:

```bash
docker compose --file infra/compose.test.yml \
  --project-name fcd-support-test-p6-83978fc down --volumes
```

Verify zero containers, networks and volumes for that exact project and zero
new harness-labelled resources. Keep protected logs outside Git; commit only
sanitized evidence. Do not print raw logs, database rows or configuration.

## Failure and rollback scope

A failed build/test stops the sequence. Preserve the failing private log and
any ambiguous resource for diagnosis. Cleanup must first prove exact project,
labels and members; never delete based on a loose name prefix alone. No server
permission, SSH, firewall, tunnel, production asset or existing database repair
is part of this stage.

The old application remains running from its original image and volume. If
the source checkout must be restored, require a clean worktree and check out
`207a5e6357c1e1a7c75918793262d835574d898d` detached. Do not reset a branch, rebuild
the old application, down-migrate or select another database volume. A later
Stage B record will describe its own application/restore failure boundaries.

## Stage A ordinary-runner correction follow-up

After the original native lanes finish and their fresh project passes cleanup,
repeat only the affected ordinary PostgreSQL lane at exact revision
`3f8783fdc588346aeab82260812329adb00bce2f`. Require the clean checkout still at
`83978fc4ed3b5986c213b6ebaa056e1dc3f320c0`, zero original-project/harness resources,
UID/GID `1000:1000`, at least 12 GiB free, and unchanged retained-container
snapshots. Do not replace source while a bind-mounted test job is running.

Use fresh project `fcd-support-test-p6-3f8783f`, its own internal data network
and PostgreSQL volume, and new private logs at
`/home/redwan/fcd-support-validation-3f8783f`. Refuse any pre-existing resource or
log directory for that namespace. Apply the same initial/post-run snapshots,
network/port checks, temporary-schema/role/lock counts and project-only cleanup
as above. The exact commands after those guards are:

```bash
umask 077
cd /home/redwan/apps/fcd-support
FCD_TEST_LOG=/home/redwan/fcd-support-validation-3f8783f
mkdir -m 0700 "$FCD_TEST_LOG"
git fetch --no-tags origin main >"$FCD_TEST_LOG/git-fetch.log" 2>&1
git cat-file -e '3f8783fdc588346aeab82260812329adb00bce2f^{commit}'
git checkout --detach 3f8783fdc588346aeab82260812329adb00bce2f \
  >"$FCD_TEST_LOG/git-checkout.log" 2>&1
test "$(git rev-parse HEAD)" = 3f8783fdc588346aeab82260812329adb00bce2f
test -z "$(git status --porcelain=v1 --untracked-files=all)"
docker compose --file infra/compose.test.yml \
  --project-name fcd-support-test-p6-3f8783f run --build --rm runner \
  npm run test:integration >"$FCD_TEST_LOG/postgres.log" 2>&1
```

After verified ownership/member and database cleanup counts, use the exact same
Compose file/project with `down --volumes`, then check zero remaining resources
and unchanged retained containers. A failure preserves private evidence and
stops this follow-up. The existing application rollback scope is unchanged.

## Execution evidence

Stage A started on 2026-10-27 (Asia/Dhaka). Read-only guards passed, the exact
source was checked out cleanly and the networkless Linux unit lane passed
1,714 tests with 324 native-only skips across 113 files (49.22 seconds for tests;
162 seconds including first image builds). The first reporting wrapper stopped
after that pass because ANSI colors preceded the summary text; stripping colors
before matching fixed reporting without rerunning or changing passing tests.

The ordinary PostgreSQL lane then failed before executing its cases: the
capability-dropped root runner could not read new checkout files owned by UID
1000 with mode `0600`. This is a real Ubuntu permission failure that the Windows
host and world-readable GitHub checkout had not exposed. The proposed correction
runs the integration image as `node` and gives it ownership of its copied lockfile
and package metadata. A regression first failed with 11 passing cases, then all
12 image-contract cases passed after that correction. No source permissions or
runtime capability checks were widened. The corrected local code gate passed
1,672 tests with 367 platform skips across 113 files (216.63 seconds). Its
complete ordinary PostgreSQL run passed 619 with 52 separately covered native
skips across 56 files (139.98 seconds).

GitHub Actions at `4a6de6a21eb303185896ad04cff64fc76e2ad251` passed unit CI,
CodeQL Advanced and both ordinary PostgreSQL/native operations jobs. Those
passes predate the server-specific integration-runner ownership correction;
the corrected revision receives its own subsequent run.

The independent native lanes already execute as UID 1000 and are being checked
against the same committed source while the ordinary-runner correction receives
local validation. They do not depend on the failed ordinary lane. Their results,
the exact corrected revision and the follow-up ordinary PostgreSQL action will
be recorded separately. Full hardened runtime, socket/SSH, host restart and live
test-asset acceptance remain open.

### Completed Stage A evidence

The real server native lanes at `83978fc` passed:

| Lane | Actual result | Test duration |
| --- | --- | --- |
| Unit | 1,714 passed, 324 native-only skips, 113 files | 49.22 s |
| Native operations units | 1,100 passed, 49 files | 297.25 s |
| Native operations PostgreSQL | 139 passed, one restore-only skip, 13 files | 50.64 s |
| Restore units | 171 passed, 11 files | 26.70 s |
| Two-cluster restore PostgreSQL | 47 passed, two files | 56.87 s |

The corrected ordinary PostgreSQL lane at `3f8783f` then passed 619 tests with
52 native-only skips across 56 files (126.91 seconds; 146 seconds including
build/startup). The complementary native lanes above cover those capabilities.
Each completed stage was checked against actual exit status; reporting did not
convert a skipped or failed case into a pass.

Both project cleanups passed with zero temporary schemas, non-builtin fixture
roles and advisory locks, followed by zero containers/networks/volumes for the
exact project. The three retained admission containers had identical IDs,
start-times and running state before/after. Their images, storage, configuration
and public tunnel were not replaced. No live provider call occurred.

The SSH command wrapper also required explicit closed stdin for Compose exec:
without it, an exec could consume the remaining piped operator script and omit
post-checks. Cleanup was rerun separately with `--interactive=false` and
`</dev/null`; only the subsequent observed counts and final acknowledgements
establish successful cleanup.

All three GitHub Actions workflows passed again at
`99c930654f332b42b387896bfc4f4868003be3c6`, including the corrected integration
image. The server checkout remains clean at the exact tested `3f8783f` source.
Stage A validates synthetic jobs on Ubuntu/Docker; full runtime/controller,
SSH dashboard, interruption matrix and live test-asset gates remain open.

## Stage B preparation

`scripts/test-synthetic-runtime-deployment.sh` prepares the next actual
controller drill. Its fixture generator creates only a fresh
`fcd-support-host-test-*` namespace, independent protected configuration/state/
socket roots, newly generated test-only credentials and distinct source/target
owner credentials. Its networkless key-generation helper receives only the
fresh key directory; each PostgreSQL ownership helper receives one fresh secret
file and only `CHOWN`, without any source directory, database volume or other
credential. Private runtime flags remain false.

The planned drill builds all three pinned images, creates a synthetic ingress
peer with a separate ordinary-egress bridge, invokes the actual deploy/verify
commands and checks private HTTP/socket behavior. It preserves the three old
admission containers and retains its explicitly synthetic private runtime for
the following restore/interruption matrix. No public route, tunnel, test asset,
existing database or provider configuration is part of it.

Five new fixture/argument checks pass after observed failures. Complete code
gate: 1,677 passed/367 platform skips/115 files (199.55 seconds); Linux unit
lane: 1,720 passed/324 native-only skips/115 files (72.58 seconds). These establish
preparation/guard coverage only. The new drill has not yet established a full
host deployment pass. Its exact committed source, action and rollback scope
must be appended before execution.

### Stage B exact authorized action

Execute source `e0565d00167a376c49dfb130cbc602152508aa5a` from a clean server
checkout initially at `3f8783fdc588346aeab82260812329adb00bce2f`. Require both
Stage A projects and all temporary harness resources to be absent, the old
three-container snapshot to match the completed Stage A record, and at least
12 GiB free. Refuse any pre-existing Stage B resource or directory.

The exact namespace is `fcd-support-host-test-p6-e0565d0`, with protected root
`/home/redwan/fcd-support-host-test-p6-e0565d0`. The application/operations/
PostgreSQL image tags use that namespace plus the full source revision. The
controller creates its own fresh PostgreSQL volume; the drill creates only
its matching backup volume, internal ingress and ordinary-egress bridges, and
synthetic peer. Password-owner helpers affect only the two newly generated
PostgreSQL password files. No existing file ownership changes.

After the guards above, execute via the existing trusted SSH connection:

```bash
umask 077
cd /home/redwan/apps/fcd-support
git fetch --no-tags origin main
git cat-file -e 'e0565d00167a376c49dfb130cbc602152508aa5a^{commit}'
git checkout --detach e0565d00167a376c49dfb130cbc602152508aa5a
test -z "$(git status --porcelain=v1 --untracked-files=all)"
bash scripts/test-synthetic-runtime-deployment.sh \
  e0565d00167a376c49dfb130cbc602152508aa5a --synthetic-only
```

Git/build/operation diagnostics are redirected to private logs. Close stdin
for the invoked drill and its Docker commands when passing operator commands
over SSH. Report only the drill's fixed acknowledgements and closed failure
phase. The script itself is the committed, reviewable exact action list.

On success, keep the new synthetic private runtime/state for the subsequent
restore and interruption tests. On failure, preserve its exact state, volumes,
actors and private logs; diagnose before any retry or cleanup. Do not edit an
intent/journal, reuse first-boot storage, restart an uncertain app or fall back
to the old database. A clean source checkout may be returned detached to
`3f8783f` only after proving no bind-mounted job is running. Existing admission
containers remain at their original image/volume; no old-stack rollback action
or public route change is required by this isolated drill.

This execution does not install timers, enable providers, seed real customers,
reconfigure SSH or replace the public admission path. Those remaining actions
require their own exact records within the already authorized test-server work.

### Stage B first host result and timezone correction

The drill reached deployment at exact source `e0565d0` and failed closed with
`operations_deployment_refused`. The controller had recorded first-boot intent
and created its labelled volume, but no runtime PostgreSQL or application actor
had started. The synthetic ingress peer, images, protected fixture and intent
were preserved. No intent, journal, permission guard or old stack was repaired
to force a retry.

The actual Docker volume timestamp carried offset `+06:00`; the shell and
TypeScript validators accepted only UTC `Z`. Local/GitHub Docker engines had
returned `Z`, so their earlier gates had not exercised this real-host format.
The correction accepts bounded RFC3339 offsets and at most nine fractional
digits only for Docker volume creation metadata. Container start times and
application-issued timestamps keep their existing contracts. Exact timestamp
text remains part of the identity/hash comparison: equal instants written
differently cannot silently substitute for a bound volume identity.

Authored offset regressions first produced seven failures, then 228 passing
focused cases with 30 native-only skips across five files. The initial promotion
fixture also reused volume time as container start time; those independently
observed fields now have separate authored values. Full code/restore/SQL evidence
and the next exact fresh-namespace action follow after validation. The interrupted
`e0565d0` intent is not eligible for implicit first-boot resumption.

The corrected full code gate exited 0 with 1,689 tests/367 platform skips across
116 files (211.47 seconds). Native restore passed 172 units plus 47 PostgreSQL
cases (26.85 seconds for integration). The focused real PostgreSQL binding suite
passed 28 cases (3.40 seconds), including offset-text persistence and refusal of
an equivalent-time replacement. Retained admission IDs/start-times/running state
were rechecked after the failed drill and still matched the Stage A baseline.
All Actions workflows at `20bf5e3` passed before the timezone correction; the
new source requires its own fresh run and separate host execution evidence.

### Stage B timezone-fix follow-up action

Repeat the committed drill only in fresh namespace
`fcd-support-host-test-p6-eed4695`, from exact source
`eed46956666558c867e8abab74208913318aa65a`. The server must initially remain
clean at `e0565d00167a376c49dfb130cbc602152508aa5a`, with no active operation
job. Preserve the entire prior `e0565d0` fixture, labelled volume, images and peer;
do not reuse or alter its interrupted initialization record. Require the retained
admission snapshot to match, the new namespace to be absent and the same disk,
ownership and private-only guards as the original drill.

After those checks, fetch origin, verify the exact commit, check it out detached,
verify a clean tree and execute:

```bash
bash scripts/test-synthetic-runtime-deployment.sh \
  eed46956666558c867e8abab74208913318aa65a --synthetic-only
```

Close stdin and keep diagnostics private as above. New protected root is
`/home/redwan/fcd-support-host-test-p6-eed4695`; all service/image/network/volume
names derive from that new namespace. The exact script actions and failure/
rollback boundaries are unchanged. Retain successful synthetic runtime for
the next matrix; retain uncertain state on failure. No public admission,
provider, SSH or existing database mutation is included.

### Stage B second host result and projection correction

At `eed4695`, the timezone-aware controller created and started its fresh
PostgreSQL actor successfully; that actor was healthy. Bootstrap snapshot
collection then refused before selection publication or application startup.
The previous interrupted intent hash/inode/ownership/size and all retained
admission IDs/start-times/running states remained unchanged.

Read-only staged diagnosis verified the protected intent/volume, rendered
Compose, all six internal database bridges and the host-wide bind-source
checks (26 actors, nine bind paths; zero invalid or unresolved paths). Direct
execution of the narrow Docker projection exposed the actual error: bind
mounts omit the optional `Name` key. A separate never-started synthetic actor
also reproduced an omitted `State.Health` key. No full inspect/environment,
secret content or business row was displayed.

Runtime/promotion and restore projections now use explicit optional-map access
for those two fields. Validators still require healthy running runtime actors,
exact mounts and resource/identity boundaries. A new real Docker probe creates
only a never-started, networkless, capability-dropped actor with one read-only
public package-metadata bind, checks both JSON projections and removes the
exact verified created actor. Both projection checks passed after observed
template failures; 132 focused cases passed with 30 native-only skips. The probe
is added to ordinary CI so fake Docker transports cannot hide this omission.

CI at `0c7fcfb` separately caught an unnecessary optional chain in the newly
added PostgreSQL binding assertion. It is removed; the new full gates cover
the final test source as well as the projection correction. Further server
execution still requires a new committed source and fresh namespace. Both
prior interrupted states remain preserved; no readiness or P6 pass is claimed.

Final projection-correction gates exited 0: full code 1,689 passed/367 platform
skips/116 files (228.66 seconds); native operations 1,103 units/49 files (368.95
seconds), then 139 PostgreSQL cases/13 files with one separately covered
restore-only skip (54.05 seconds). Both real Docker projections passed and zero
projection fixture containers remained. The independent restore/binding evidence
above remains applicable; no SQL/runtime semantic changed in this correction.

### Stage B projection-fix follow-up action

Use exact source `50abeb8e94f4e5ca467178039353a1c657a13f73`, starting from the
clean server checkout at `eed46956666558c867e8abab74208913318aa65a`. Require no
active job in either prior fixture, unchanged original admission snapshots and
the usual fresh-namespace/capacity guards. Fingerprint and preserve both prior
initialization records; neither is resumed, selected, stopped or repaired.

Fetch origin, verify that exact commit, check it out detached and require a
clean tree. Execute, with closed stdin and protected diagnostics:

```bash
bash scripts/test-docker-projections.sh
bash scripts/test-synthetic-runtime-deployment.sh \
  50abeb8e94f4e5ca467178039353a1c657a13f73 --synthetic-only
```

The first command creates/removes only its never-started networkless labelled
probe. The second uses fresh namespace `fcd-support-host-test-p6-50abeb8` and
protected root `/home/redwan/fcd-support-host-test-p6-50abeb8`. All other exact
actions, private flags, retained-stack checks and failure/rollback limits match
the committed script and preceding records. On success retain its synthetic
private runtime for the next tests; on failure preserve its uncertain state.
No production/customer/provider/tunnel action is included.

### Stage B same-revision diagnostic action

At `50abeb8`, both actual Docker projections passed on the server, but the new
controller attempt still refused before a PostgreSQL actor appeared. Preserve
that third initialization record and all earlier fixtures. Read-only volume and
Compose/dry-run checks passed; no existing initialization may be resumed to
capture a better error.

A separate fresh diagnostic namespace is authorized under the same repeated
test-server scope: `fcd-support-host-test-p6-50abeb8-diag`, protected root
`/home/redwan/fcd-support-host-test-p6-50abeb8-diag`. Require the clean checkout
to remain exactly `50abeb8e94f4e5ca467178039353a1c657a13f73`, no active operation
job, absent diagnostic resources, adequate capacity and unchanged old admission
snapshots. Use the committed fixture generator with that namespace and revision.
Reuse the three already verified `50abeb8` images by explicit inspected image
IDs in the new protected configuration; do not rebuild or change any image.

Provision only this fresh fixture's age identity/recipient, two PostgreSQL
password ownerships, backup volume, internal ingress/ordinary-egress bridges and
synthetic peer as in the committed drill. Keep all external execution false.
Invoke the same public controller through its loaded repository functions:

```bash
source scripts/operations-common.sh
source scripts/operations-controller.sh
operations_main deploy 50abeb8e94f4e5ca467178039353a1c657a13f73 \
  --mode private-disabled \
  /home/redwan/fcd-support-host-test-p6-50abeb8-diag/config/operations.env
```

This still performs the public argument, exact source, protected configuration,
flock, intent, image, volume and capability checks. It must not override a guard
or publish a selection through a private helper. Enable Bash function-line tracing
only: record source filename and line number to a private descriptor; never use
`set -x`, `BASH_COMMAND`, expanded arguments, environments or secret values.
Close stdin for deployment. This trace observes the real failing control path
without modifying source on Ubuntu or changing failure semantics.

On failure preserve the new state and diagnostics. On success run the public
verify command and normal private checks before any readiness claim. Retained
admission and all three prior intent fingerprints must remain unchanged. The
same no-fallback/no-public-route/no-provider rollback limits apply.

### Address-pool exhaustion and exact test-resource disposition

The fresh diagnostic fixture stopped during network provisioning with Docker's
`all predefined address pools have been fully subnetted`. It had not entered
the controller, created an initialization intent or started PostgreSQL. This
is consistent with the preceding successful render/no-actor outcome; that
original suppressed Compose error was not captured. Retaining every failed scope's bridges exhausted the host's
default pool. No daemon address pool, host route or foreign network will change.

Release only ephemeral actors/networks for these exact test scopes:

```text
fcd-support-host-test-p6-e0565d0
fcd-support-host-test-p6-eed4695
fcd-support-host-test-p6-50abeb8
fcd-support-host-test-p6-50abeb8-diag
```

Before mutation, require a clean `50abeb8` checkout, matching legacy snapshots,
no selected deployment or active/temporary job in any scope, and the original
three initial-intent fingerprints. The diagnostic scope must have no initial
intent and no PostgreSQL actor/volume. Save private minimized actor/network
metadata. Verify each actor's exact immutable ID, project/service labels, image
ID/revision, non-root identity, volume attachment and zero host ports. Allowed
actors are only the synthetic ingress peers and the fresh `eed4695` PostgreSQL
actor; refuse any application or unexpected actor.

Stop only those freshly verified IDs with bounded grace, verify stopped state
and unchanged identity, then remove by immutable ID without force or volume
removal. Release only each scope's exact labelled bridge IDs after every member
has gone and ownership/name/driver/scope/internal-mode checks still match. A
changed/foreign participant or ambiguous result stops cleanup. Never use prune,
loose prefix deletion, daemon reconfiguration or a source-volume switch.

Keep every volume, generated credential/key, private log and initialization
record. Record actor/network disposal as explicit failed-fixture disposition;
these initializations remain ineligible for implicit resume. Verify unchanged
legacy snapshots and intent fingerprints afterwards, and report only counts.

After that disposition, complete only the already generated diagnostic scope's
fixture provisioning: require its protected configuration/key presence, no
initial intent/selection/job and no PostgreSQL volume; recreate its two exact
bridges and synthetic peer, record that new peer ID in its configuration, and
make its first public controller call with the same source and private line
tracing described above. This is first initialization, not resumption of an
interrupted intent. Reuse its existing protected test credentials and backup
volume. Run public verify/private HTTP/socket checks on success and retain
uncertain state on failure. No provider or public admission change is included.

### Observed disposition and protected-record regression

The bounded disposition completed: four verified test actors and 17 owned test
bridges were removed. Every test volume and initialization record remained;
original admission snapshots matched. No prune, daemon configuration change,
foreign resource or volume removal occurred.

After completing the diagnostic scope's provisioning, its first public
controller call started healthy PostgreSQL, passed host sampling/physical-ID
checks and reached volume-history publication. Private source-line tracing
then identified a separate parser boundary: the record's general literal
alphabet rejected `+`, although the per-field timestamp validator accepted
`+06:00`. A used-volume history record was created, but no authoritative
selection was published and no application started. Preserve that intent,
history and volume; do not reconstruct its missing pointer manually.

A new native filesystem round-trip first failed with 30 other cases passing.
After admitting the timestamp alphabet through the general parser, all 31
protected-record cases passed (25.73 seconds), including positive/negative
offset preservation across selection/history reads and a starting transition.
Every value still passes its closed per-field validator; no shell evaluation,
normalization, permission or history check was removed.

The synthetic fixture's future restore project/volume names also failed their
production target-identity schema. Those fresh names now use the required
`fcd-support-restore-*` prefix; a regression failed first, then all five fixture/
argument checks passed. The helper-only code gate passed 1,689/367 platform
skips and its Linux unit lane passed 1,732/324 native-only skips before the new
protected-record case was added. These are preparation checks, not an executed
host restore or final Phase 6 pass. Final combined verification and the next
exact fresh source/namespace follow separately.

Final combined `npm run check` exited 0: 1,689 passed/368 platform skips across
116 files (203.87 seconds). The added native record case is covered by the
31-case passing filesystem gate; its skip in the Windows run is explicit.
All three Actions workflows passed at `b941cf5` before this final parser/fixture
checkpoint. These results still do not establish a completed host deployment.

### Stage B protected-record fix action

Deploy exact source `91eb8f3697179b732e406675e82b6251101f7c92` in fresh namespace
`fcd-support-host-test-p6-91eb8f3`, protected root
`/home/redwan/fcd-support-host-test-p6-91eb8f3`. Start from the clean server
checkout at `50abeb8e94f4e5ca467178039353a1c657a13f73`; require no active
operation and unchanged legacy snapshots. Fingerprint all four prior initial
intents and the diagnostic used-volume history; preserve them and every volume.
The new namespace, target restore namespace and all its resources must be absent.

Fetch origin, verify the exact commit, check it out detached and verify a clean
tree. Re-run the actual Docker projection probe, then:

```bash
bash scripts/test-synthetic-runtime-deployment.sh \
  91eb8f3697179b732e406675e82b6251101f7c92 --synthetic-only
```

Close stdin; keep all diagnostics protected. The script enforces fresh storage,
flags, numeric ownership, pinned images, capacity and actual public deploy/verify/
HTTP/socket checks. The corrected fresh restore names use the required prefix.
Retain a successful private synthetic runtime for the next matrix; retain state
on failure. No previous intent is resumed, no missing pointer is reconstructed,
and no existing database, provider or public admission route changes. Compare
all preserved fingerprints and original admission snapshots afterwards.

### One-shot creation CLI regression probe

At `91eb8f3`, initialization published quiescent state successfully. The first
bootstrap job then remained `pending/uncertain` with no job container, and startup
marked the deployment uncertain with schema `000000` and no possible application
writes. Do not clear, replay or resume that job. The real Compose CLI rejects
`create --no-deps`; this option exists on other subcommands but not `create`.

The correction removes the unsupported option and rejects implicit one-shot
dependencies/links. Isolated restore jobs no longer inherit `depends_on`:
their PostgreSQL actor is already separately created and verified by the locked
host controller. Fifteen dependency/link regressions failed first, then passed.
The real Docker probe is extended to exercise the actual Linux stopped-job
creation helper; Windows reports that host-only portion as skipped explicitly.

Before committing the final helper change, run an independent actual Linux CLI
canary on the same approved server: project
`fcd-support-create-cli-synthetic-91eb8f3`, service `bootstrap`, profile
`operations-bootstrap`. Require a clean checkout still at `91eb8f3`, no existing
canary actor and unchanged legacy/state fingerprints. Feed one authored Compose
service over stdin, using the pinned Node digest, user `1000:1000`, read-only
root, all capabilities dropped, no-new-privileges, network `none`, 0.25 CPU,
128 MiB and 32 PIDs, with no volume, secret or host port. Invoke under the same
empty environment and explicit local Unix Docker endpoint with:

```text
compose --env-file /dev/null --file - --project-name
fcd-support-create-cli-synthetic-91eb8f3 --profile operations-bootstrap
create --no-build --pull never --no-recreate bootstrap
```

Verify exactly one labelled actor in `created/false` state with the specified
image/user/mount/network/resource boundaries, then remove that immutable ID
without force. Never start it. Verify zero canary actors and unchanged old
admission/state fingerprints. Capture only a fixed acknowledgement; no backend,
archive, credential, current job or network-pool mutation is involved. This
canary proves CLI syntax/creation, not bootstrap SQL success or runtime readiness.

The actual Linux canary passed with the intended empty environment/local endpoint,
exactly one stopped hardened actor, zero canary actors after cleanup, and unchanged
pending state/legacy fingerprints. The final code gate exited 0: 1,704 passed/
368 platform skips/116 files (209.77 seconds). Native operations passed 1,119
units/49 files (339.65 seconds) and 139 PostgreSQL cases/13 files with one separate
restore-only skip (54.77 seconds). The extended helper probe is now in CI; its
Windows host-only skip is explicit. New server deployment still needs its own
fresh committed source and state; no job outcome was inferred from this canary.

### Stopped-job fix deployment action

Use exact source `1fe31b53547d30a16c8d6138e18456d3d6331908`, starting from the
clean server checkout at `91eb8f3697179b732e406675e82b6251101f7c92`. Preserve the
entire pending/uncertain `91eb8f3` project and its journal; verify no operation
actor is running and no source-mounted test is active before changing checkout.
Fingerprint all existing fixture history/journals and the legacy baseline.

First release only the now-failed, unselected
`fcd-support-host-test-p6-50abeb8-diag` actors/networks to reserve subnet capacity.
Require no selection, active job or pending metadata replacement there; validate
its initial and used-volume records, current PostgreSQL physical identity,
exact image/user/volume/port metadata and its one synthetic peer. Apply the same
bounded stop/exact-ID non-force removal and empty-owned-bridge checks above.
Preserve all history, credentials and volumes, including its used-volume record.
The `91eb8f3` pending project is excluded from this disposition.

Fetch origin, verify the exact new commit, check out detached and require a clean
tree. Run the committed Linux Docker probe, including actual stopped-job helper
creation/cleanup, then execute:

```bash
bash scripts/test-synthetic-runtime-deployment.sh \
  1fe31b53547d30a16c8d6138e18456d3d6331908 --synthetic-only
```

Fresh namespace/root is `fcd-support-host-test-p6-1fe31b5` under `/home/redwan`.
Require no pre-existing resource in that namespace; the committed script checks
disk, separate roots/credentials, images, flags, mounts and actual deployment.
Close stdin, keep logs private and compare all preserved history/legacy
fingerprints afterwards. Retain the new private runtime only after public verify
and private HTTP/socket checks pass; otherwise preserve uncertainty. No replay,
job clearing, old-volume switch, provider or public route change is included.

### Archive-path fixture correction

The stopped-job fix drill at `1fe31b5` passed both Docker metadata probes and
the actual Linux stopped-create helper. First bootstrap preparation completed;
the pre-migration backup then failed and left a durable uncertain backup record.
Selection remains uncertain, schema `000000`, application writes impossible,
with no application actor. All prior history and original admission snapshots
matched after the attempt. The released diagnostic scope had exactly two
actors/eight bridges removed; its history and both volumes remain preserved.

Read-only checks confirmed that the authored test configuration omitted
`BACKUP_ARCHIVE_DIRECTORY`, `BACKUP_TMPFS_DIRECTORY` and checkpoint paths. The
backup command requires these settings and refuses before execution without
them. Four fixture regressions failed first; nine focused tests then passed
after supplying paths under the existing archive volume and bounded tmpfs.
Verification, checkpoint and split-restore settings are included. Production
backup logic and capability boundaries are unchanged. The uncertain job is
preserved; another fresh committed-source drill is required.

### Corrected fixture deployment action

Deploy exact source `a6de43665215dfe68f7de2052c289d80a0c33b3f` from the clean
server checkout at `1fe31b53547d30a16c8d6138e18456d3d6331908`. Use fresh scope
`fcd-support-host-test-p6-a6de436` and root `/home/redwan/fcd-support-host-test-p6-a6de436`.
Fingerprint every prior fixture state/history file and retained admission
snapshot before and after. Require no source-mounted test or running operation.

To reserve subnet capacity, retire only failed `fcd-support-host-test-p6-1fe31b5`
PostgreSQL/peer actors and its eight bridges. Require its selection to remain
uncertain with schema `000000` and writes impossible, the uncertain backup
journal's actor to be absent from a successful full Docker actor listing, and
no application/operation actor. Verify initial/current image IDs, physical
database identity, project labels, numeric user, read-only root, exact named
volume, no published port and peer mounts. Stop the two verified immutable IDs
with 30-second grace and remove them without force or volume removal. Remove
only empty exact owned bridge IDs with the documented names/internal flags.
Preserve every volume, credential, intent, selection and job/used-volume record;
never resolve or replay the uncertain backup. Preserve the older `91eb8f3` scope.

Fetch origin, check out the exact new source detached, require a clean tree,
and run the actual Docker probe followed by:

```bash
bash scripts/test-synthetic-runtime-deployment.sh \
  a6de43665215dfe68f7de2052c289d80a0c33b3f --synthetic-only
```

Close stdin and keep diagnostics private. Retain a successful private runtime
for the remaining matrix; otherwise retain its uncertainty. No provider, public
route, production asset or original database changes are included.

### First private READY runtime and follow-up matrix

Exact deployed source `a6de436` completed encrypted pre-migration backup and
verification, forward migrations to `000016`, grant convergence, deployment
metadata, all four healthy actors and the public verify command. Protected
selection is READY. Admin `/login` returns 200 through a socket owned
`1000:1000`, mode `0600`. All earlier history and admission snapshots matched.

The final test-runner HTTP check failed because its unsigned POST used fetch's
default text content type, correctly rejected as an invalid body. An execution
test runs that exact authored probe against the real Fastify app: one RED/three
passing, then 33 passing focused fixture/script/admission cases after declaring
`application/json`. No production admission rule changed. Do not redeploy or
reinitialize the healthy runtime merely to correct this test-only probe.

Continue on the clean server checkout at full source
`a6de43665215dfe68f7de2052c289d80a0c33b3f`, same synthetic scope/config/root.
Run the corrected three HTTP requests from its exact synthetic peer, expecting
403/404/401 with no signature and no accepted work. Recheck public verify,
socket mode and no active job. Temporarily open an SSH local forward only on
client `127.0.0.1:13004` to that exact remote Unix socket, with host-key checking,
batch authentication and ExitOnForwardFailure. Require the client port to be
unused first; check login 200 and authenticated operations redirect through the
forward, then terminate only the newly created SSH process and verify port closure.
Do not change SSH daemon settings, publish Docker ports or disclose credentials.

After those checks, execute the existing `run-operation.sh backup` for the same
full revision/config. Verify one current daily and monthly slot with signed
archives and run it again to prove replay does not create another archive.
Use a hardened networkless metadata reader mounting only that test archive
volume read-only and its recovery HMAC file read-only to select the verified
daily backup reference, bound to this exact revision/schema. Never print an
archive, key, message or arbitrary manifest. Under the existing checked
configuration, public verify and deployment lock, invoke the committed
checkpoint job `export-checkpoint-reference`; capture only its closed reference.

Then call the public `restore-runtime.sh BACKUP_REF CHECKPOINT_REF FULL_REVISION
CONFIG_PATH` into the still-absent exact configured restore scope/volume, followed
only on success by `promote-restore.sh RESTORE_REF FULL_REVISION CONFIG_PATH`.
The existing controllers own drain, backup, current checkpoint, split capability
jobs, deletion/fence validation, two fresh host challenges, switching and startup.
Verify READY on the selected distinct restored physical cluster and retain both
volumes. Finally test the existing retained exact-schema rollback command using
the same retained full revision and verify its public postcondition. Keep all
provider flags false and preserve uncertainty on any refusal; never replay a
pending job, repair selection or switch back manually. Keep protected logs and
compare original admission plus all other fixture-state fingerprints afterwards.
These actions affect only fresh authored synthetic storage and private runtime;
they do not authorize provider traffic, original admission adoption or P6 closure.

### Installed checks and source-drain defect

The corrected actual peer requests passed 403/404/401. Public verify passed again
with unchanged protected state, Unix login 200 and socket `1000:1000:600`.
Actual SSH forwarding on client `127.0.0.1:13004` passed login 200 and the
unauthenticated operations redirect 303 to `/login`. The owned SSH process was
terminated and the port was confirmed closed. No SSH policy or server port changed.

Both scheduled daily/monthly backups and replay passed. Networkless metadata
inspection verified signatures and an unchanged three-archive reference set
(pre-migration/daily/monthly). Current checkpoint export passed. Restore wrote
its immutable intent, then source drain refused before stopping an actor or
creating target resources. Source selection became uncertain at schema `000016`;
all four source actors remain healthy, no operation journal is pending, and the
original admission plus every other fixture-state fingerprint matched.

Read-only diagnosis under the deployment lock verified the actor guards and
located the failure at the drain's PostgreSQL mount projection. `%s/%s` placed
an extra slash before an already absolute destination, while its expected value
contained one slash. The earlier newline concern came from diagnostic quoting;
it is not established as a production defect. A real never-started Docker actor
with a fresh labelled volume reproduced the failing exact production template.
Space-separated `println` metadata now passes the same actual-Docker check and
keeps exact volume/destination/write-mode matching. Probe actor and volume are
removed by checked ownership without force; no runtime boundary is weakened.

The same exact-format Docker regression also failed for admission adoption,
which shared the separator mistake; both projections now pass. Native fake
responses were corrected to match actual space-separated metadata. The initial
focused drain run exposed its shared adoption path (27 pass/one failure), then
the complete native gate passed 1,119 units/49 files (319.24 seconds) and 139
PostgreSQL cases/13 files with one separately covered restore-only skip (52.87
seconds). Full code passed 1,709/368 platform skips/116 files (212.16 seconds).
All four actual Docker metadata checks pass locally; Linux stopped creation
remains explicitly skipped on Windows. The corrected narrow mount predicate
also passed read-only against the existing synthetic Ubuntu PostgreSQL actor.
This proves metadata rendering, not a successful public drain/restore.

### Corrected mount deployment and restore action

Deploy exact source `5d35777e2e32f4f30d6c90fdec05507d43765cd2` from the clean
server checkout at `a6de43665215dfe68f7de2052c289d80a0c33b3f`. New fresh scope
is `fcd-support-host-test-p6-5d35777`, protected root
`/home/redwan/fcd-support-host-test-p6-5d35777`. Fingerprint all seven existing
fixture-state roots, including `a6de436`'s restore intent/uncertain selection,
and retain the original admission snapshot throughout.

First retire only `a6de436`'s five synthetic actors (reply/admin/API/PostgreSQL/
peer) and eight bridges to reserve subnet capacity. Require selection uncertain
at `000016`, no active/pending operation and no restore-target actor/volume.
Verify all five exact immutable IDs, retained image IDs/revision, users, read-only
roots, commands, no publication, peer label/no mounts, PostgreSQL volume and
physical identity before any stop. Stop reply, admin, API, PostgreSQL and peer
with 30-second grace; recheck unchanged identities and stopped state, then remove
those IDs without force or volumes. Remove only the eight exact owned empty
bridge IDs with their expected driver/internal/project metadata. Preserve all
credentials, volumes, selections, restore intents, journals and history, including
the older pending `91eb8f3` scope. This is failed-fixture disposition, not a
successful controller drain or reconciliation of its uncertainty.

Fetch origin, check out the new exact source detached and require a clean tree.
Run `scripts/test-docker-projections.sh` (four metadata checks and Linux stopped
creation), then the full synthetic deployment runner with that full revision
and `--synthetic-only`, stdin closed. Require successful deploy/verify/private
HTTP/socket postconditions and unchanged preserved fingerprints/admission.

Only after success, repeat the previously recorded scheduled backup/replay,
signed daily-reference selection, current checkpoint export under public verify/
lock, public isolated restore, successful public promotion and same-revision
retained rollback matrix using the new full revision, namespace and config.
The exact configured target is `fcd-support-restore-host-test-p6-5d35777`, volume
`fcd-support-restore-host-test-p6-5d35777-data`. Preserve both source/target volumes
and all uncertain state on failure; no automatic replay, pointer repair or
fallback is included. Keep all providers disabled and all other assets unchanged.

At `5d35777`, all five Linux Docker canaries and the entire fresh deployment
runner passed, including public deploy/verify, private HTTP/socket checks and
unchanged prior history/admission snapshots. Scheduled backup plus replay again
passed with the same three signed archives. The corrected restore matrix is
running separately; those earlier passes do not establish its outcome.

### Split directory-environment correction

At `5d35777`, actual source drain completed: all application actors stopped and
were removed, source state became quiescent and a healthy isolated target
PostgreSQL actor was created. The first stream job then failed and was contained;
its uncertain journal, restore intent and both databases remain preserved. No
application was attached to the target, and promotion/rollback were not attempted.
Earlier fixture fingerprints and original admission snapshots matched.

The shared authored `restore.env` supplied all three archive/tmpfs/checkpoint
paths. Stream explicitly rejects the checkpoint directory, and reconciliation
explicitly rejects stream directories. Sixteen regressions failed (15 per-role
Compose path mutations plus the fixture); role-specific Compose directory
settings now keep those guards intact. Shared restore policy retains numeric
bounds only. The rendered contract requires each intended path and rejects
foreign paths, including on target-only bootstrap/migration jobs.

The first disposable full-controller Actions run reached deployment but failed;
it is not a pass. Its previous diagnostics reported only the broad stage, and
sudo retained an inaccessible runner HOME. The workflow now selects the operator
HOME explicitly. A test-only diagnostic helper filters only fixed closed codes
and bounded known-source/line/status entries; it never forwards arbitrary logs,
arguments, command text, environment or secrets. Two rejection tests failed first
and now pass. The CI-only Bash trace remains in protected fixture logs, with no
raw artifact upload. The next workflow result must establish the actual cause
and outcome; the HOME correction alone is not asserted as the deployment fix.

Correction gates exited 0: full code 1,727 passed/368 platform skips/117 files
(213.93 seconds), native restore 202 units/11 files (38.52 seconds) plus 47
PostgreSQL cases/2 files (34.87 seconds). Sixteen path regressions and both
closed-output rejection cases were observed failing first. Formatting, strict
typing, lint, shell syntax and whitespace checks pass. New CI execution and a
fresh exact-source host restore remain required; no uncertain job was replayed.

### Split-settings deployment action

Use full source `8ccb9a09bd0c264376ce76e36694659c7d47815b` from the clean server
checkout at `5d35777e2e32f4f30d6c90fdec05507d43765cd2`. Fresh runtime/root is
`fcd-support-host-test-p6-8ccb9a0` under `/home/redwan`; its exact target project
and volume are `fcd-support-restore-host-test-p6-8ccb9a0` and the same name with
`-data`. Preserve the entire `5d35777` source/target, restore intent and uncertain
stream journal; no operation actor may be running before checkout changes.

Reserve subnets by retiring only the older `91eb8f3` PostgreSQL/peer actors and
eight bridges. Require its selection uncertain, writes impossible, schema
`000000`, bootstrap journal uncertain with actor `pending`, and a successful
operation-parent actor listing empty. Verify initial image IDs/revision, physical
database identity, exact project/service/user/root/publication/volume metadata
and peer label/no mounts. Apply the existing two-actor exact-ID stop/recheck/
non-force-remove and eight empty-owned-bridge procedure. Preserve every volume,
credential, immutable intent, selection, journal and used-volume record. This
releases failed-fixture resources only; it does not reconcile or resume that job.

Fingerprint every existing fixture-state root and original admission snapshot
before/after. Fetch origin, check out the exact new source detached, require a
clean tree and run all Docker canaries plus the full synthetic deployment runner
with that revision and `--synthetic-only`, stdin closed. After successful private
deploy/verify/HTTP/socket checks, repeat the recorded backup/replay, verified
daily-reference selection, checkpoint export, public restore, successful public
promotion and retained same-revision rollback matrix using only the new scope.
Stop on any refusal, preserve both databases and uncertainty, and report only
closed evidence. No previous job replay, production/admission adoption, provider
call, global network-pool change or public route mutation is included.

### Interrupted pre-intent build completion

The `8ccb9a0` operator connection ended during image preparation. Read-only
checks found complete application/operations tags for that exact revision,
no corresponding live build client, no runtime actor and only the original
deployment lock in the fresh state root. No initialization intent or PostgreSQL
authority exists there. Do not rerun the fresh-root constructor or infer a
deployment pass from the two image tags.

Complete only this previously authored root on the same clean exact checkout
`8ccb9a09bd0c264376ce76e36694659c7d47815b`: require the state directory to contain
only its owner-0600 lock; all source/target/backup volumes, ingress/egress/target
networks and peer/operation/runtime actors must still be absent. Require the
verification identity/recipient to be absent and both fresh PostgreSQL password
files still owned `1000:1000:600`. Fingerprint all other fixture state and original
admission IDs/start-times/states before and after.

Verify actual application/operations IDs, revision, platform and non-root user.
Validate Node/npm/pg_dump/pg_restore/age versions in a hardened networkless
operations-image probe with no mount, secret or backend connection. Build only
the missing PostgreSQL tag from the pinned Dockerfile/full revision, bounded
by 600 seconds with 30-second termination grace; validate its immutable metadata.
Then execute the unchanged, committed runner body from `stage=keys` onward
with the same root/project/revision/server mode and retained snapshot. This
performs only the already recorded key/password provisioning, isolated resource
creation and first public deploy/verify/HTTP/socket checks. No repository source
is edited on Ubuntu. Any intent/job or partial provisioning present before the
checks refuses completion; after a failure preserve evidence rather than repeat.
Only after success proceed to the already approved new-scope restore matrix.

### Observed server restart and new preservation baseline

Read-only checks explain the interrupted build: server uptime shows a restart
during this validation interval. All three admission container IDs and immutable
images/revisions still match the old inventory; their start times changed
together. The older `5d35777` source remains quiescent with its uncertain restore
journal; its isolated target stopped under its `restart: no` policy. No target
was promoted. This is observed interruption evidence, not a controlled restart
acceptance pass. The old preservation snapshot must not be overwritten.

Before completing the still-pre-intent `8ccb9a0` fixture, require exact admission
IDs and running states to match the original snapshot, with only start-time
changes. Verify the expected original revision and no publication changes.
Create a separate owner-0600 snapshot at
`/home/redwan/fcd-support-host-test-p6-8ccb9a0/logs/retained-post-restart.snapshot`.
All subsequent completion/matrix checks compare to this new captured snapshot;
preserve the original snapshot as historical evidence. Repeat all earlier
pre-intent, resource, credential-presence and image/toolchain checks. Any further
identity/start-time change stops execution again. This updates observed
preservation evidence after an external restart and grants no journal replay,
old-volume adoption, automatic target restart or production action.

### Partial-target preservation and fresh retry action

Post-restart completion passed toolchain/deploy/verify/private HTTP/socket
checks at `8ccb9a0`. Backup/replay again verified the same three signed archives.
The next restore drained source and completed its source-only upgrade, created
the target volume, then refused before target network/actor creation. Source is
quiescent, no job is pending, and the partial target/intent are preserved. A
read-only inventory found 30 bridge networks; address-pool exhaustion is the
working diagnosis until the bounded probe below confirms it.

Continue only from clean exact source `8ccb9a09bd0c264376ce76e36694659c7d47815b`
and the captured post-restart admission baseline. Preserve all older state and
the current partial target volume/intent. First attempt one fresh internal
bridge canary named `fcd-support-subnet-check-8ccb9a0`, with a dedicated capacity
probe label, no actor or route. Capture Docker stderr privately and recognize
only the known exhausted-pool message. If it unexpectedly succeeds, verify its
immutable ID/label/internal bridge/zero-member postcondition, remove only that
ID without force, and stop to reassess rather than assume the diagnosis.

After confirmed exhaustion, release only the stopped synthetic
`fcd-support-host-test-p6-5d35777-ingress-peer` and its now-empty ingress/egress
bridges. Verify its exact ID, retained `5d35777` application image, revision,
node/read-only/no-capability/no-port/no-mount boundary, synthetic label and
stopped state. Remove that ID without force. Remove only the two empty exact
owned bridge IDs with internal flags true/false respectively. Preserve the
`5d35777` PostgreSQL actors, both data volumes, all six source data bridges,
target bridge, uncertain job and intent. No global prune/address-pool change.

Create a new owner-only configuration variant at
`/home/redwan/fcd-support-host-test-p6-8ccb9a0/config-restore-r2`, initially absent.
Copy only the known regular owner-0600 non-secret role settings; keep original
configuration untouched. Its literal host file preserves runtime project,
source/backup/state/socket/secret roots, revision, images and all provider flags.
Only its config-root reference and fresh restore project/volume change to
`fcd-support-restore-host-test-p6-8ccb9a0-r2` and that name with `-data`.
Set the variant's synthetic checkpoint maximum age to 600000 ms to budget the
measured multistep host drill; other numeric bounds remain unchanged. This is
an explicit test setting, not a production default or bypass of freshness.

Under normal protected config/image/deployment-lock and quiescent-bootstrap
host/physical-identity checks, export a new checkpoint with the existing narrow
checkpoint job. Use the already verified current daily backup reference.
Run the public restore into the absent fresh `r2` target, then only on success
public promotion, verification and retained same-revision rollback with this
variant. Never resume the old target/intent, repair selection or replay an
uncertain job. Preserve all volumes and immutable old intent fingerprints;
compare every other fixture and admission snapshot afterwards. Any further
restart, unexpected peer, pending job or identity change refuses execution.
