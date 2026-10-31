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

| Lane                           | Actual result                                  | Test duration |
| ------------------------------ | ---------------------------------------------- | ------------- |
| Unit                           | 1,714 passed, 324 native-only skips, 113 files | 49.22 s       |
| Native operations units        | 1,100 passed, 49 files                         | 297.25 s      |
| Native operations PostgreSQL   | 139 passed, one restore-only skip, 13 files    | 50.64 s       |
| Restore units                  | 171 passed, 11 files                           | 26.70 s       |
| Two-cluster restore PostgreSQL | 47 passed, two files                           | 56.87 s       |

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

### Capacity proof and blocked intent recovery

The isolated capacity canary confirmed Docker's exhausted-pool response. The
one stopped synthetic peer and its two empty owned bridges were released;
all state fingerprints, volumes and admission snapshots matched. The separate
`r2` configuration was created with private permissions and the recorded
600000-ms test bound. A new narrow checkpoint exported successfully.

The public retry then refused before creating any new intent/resource. Read-only
preflight verified retained images, source storage, target absence and rendered
Compose; the remaining guard is deliberate: `restore_state_begin` refuses every
unresolved historical intent, even when a different target/ref is requested.
The old empty partial target therefore needs an explicit verified abandonment/
reconciliation path before another attempt. No record was removed, rewritten or
represented as completed. This is an implementation gap in Task 11 recovery;
the earlier retry action does not authorize bypassing it.

### Reproducible CI renderer and closed diagnostics

An independent reproduction used both checksum-verified official renderers,
the real runtime Compose file and compiled contract with a fresh synthetic
fixture in a hardened networkless container. Compose 2.38.2 omitted explicit
`bind.create_host_path:false` and failed; 5.5.1 retained it and passed. CI now
pins 5.5.1 by SHA-256 and checks the version actually invoked under UID 1000
and the controller's empty-environment convention. Runtime boundary predicates
remain unchanged. The fixture/binaries/container were cleaned up.

Opt-in networkless validator diagnostics now expose only fixed stages and known
schema field names, with unchanged refusal status/default generic output. Parent
review/focused checks passed 130 cases with 30 complementary native skips; the
complete four-worker code gate passed 1730/368 platform skips/117 files in
203.77 seconds. The compiled diagnostic CLI case passed separately. Arbitrary
keys, values, errors and command text are not emitted. Actual new CI execution
still determines the installed controller result; no CI pass is inferred here.

### Pinned empty-target close-out action

The following authorized synthetic-server action uses exact application source
`9ffc37048de38520e7ed9c7d735af1664c6a42d2`. It does not authorize a provider,
Meta, tunnel, production-number or customer-traffic operation. Before mutation,
require the clean server checkout at `8ccb9a09bd0c264376ce76e36694659c7d47815b`,
the recorded post-restart admission snapshot, unchanged older fixture state,
the quiescent `fcd-support-host-test-p6-8ccb9a0` source, its retained image
bundle and physical identifier, and no pending or orphaned job/actor. Stop if
any fingerprint, container start time, ownership, local daemon or Git state
differs.

Preserve the original intent `restore_f0c280a16d21b3d84bbf71fd930cbbe4` and
its labelled target volume `fcd-support-restore-host-test-p6-8ccb9a0-data`.
Require the target to exist with its exact project/reference labels, have no
users or target actor, and have no target network. Never delete or replace it.
Check the old source application image has no declared volumes and retain all
older images, files, state records, test projects and admission actors.

Fetch the committed source and detach the clean test checkout at the exact
revision. Build separate, explicitly labelled synthetic application, operations
and PostgreSQL images under new tags for this revision; do not replace any old
tag. Create a new owner-only host-configuration variant with the same original
runtime/config/secret/state/socket roots, source/backup/target identities and
disabled provider settings. Change only the source revision and the three
candidate image references. Keep the original role environment and configuration
files unchanged; the variant host file may be outside the original config root.

Run `abandon-empty-restore.sh` once with that exact reference, revision and
variant. The command may create and remove only its own networkless read-only
probe containers; it may write only the new `.abandoned` terminal record. It
must leave the original intent, source selection/volume/actor, target volume,
all older state and admission snapshot unchanged. Record only closed results,
never raw file content or credentials. On any refusal, timeout, restart,
unexpected record or changed fingerprint, stop and preserve all evidence; do
not delete the target, edit the journal, retry blindly or switch storage. The
distinct fresh-target restore requires its own separately recorded action after
this close-out is verified.

### Empty-target close-out result

On 2026-10-27 (Asia/Dhaka), all four Actions workflows passed for the
documentation-only successor of `9ffc370`. The read-only preflight passed, then
the exact source, three separate candidate images and protected configuration
variant were prepared on the synthetic server. The public private close-out
returned `restore_abandoned=true`; its terminal record is owner-only and
content-free. A separate read-only check confirmed the original intent and
labelled target volume remain, the source is quiescent with no pending job,
and the original admission snapshot is unchanged. Other fixture fingerprints
also matched. No provider, Meta, tunnel or customer-traffic call occurred.

This closes only that empty interrupted intent. No restored database, promotion,
rollback or P6 gate pass is claimed. The separate operations-image inherited
volume issue must be resolved before the next full restore/promotion drill.

### Exact candidate restore and promotion action

Use only synthetic source `538d1d06b36800cd1fefc778c42f6a248b3ba2b8`, after
its four GitHub Actions workflows pass. The server checkout must still be clean
at `9ffc37048de38520e7ed9c7d735af1664c6a42d2`; the existing post-restart
admission snapshot and older fixture-state fingerprints must match their
pre-action samples. Require a healthy quiescent PostgreSQL source, no active
or uncertain job, and the preserved original intent and `.abandoned` record.
The old target `fcd-support-restore-host-test-p6-8ccb9a0-data` must retain its
exact reference label and have no users. The distinct target project
`fcd-support-restore-host-test-p6-8ccb9a0-r2`, its `-data` volume and its
`-data` network must all be absent. Stop on any mismatch.

Actions passed for that exact revision: private runtime `40623783649`,
CodeQL `40623783659`, CI `40623783646`, and PostgreSQL/native operations
`40623783739`.

The read-only disk sample found 19 GiB free on Docker's filesystem, while the
three retained candidate-predecessor images totalled 451 MiB and the synthetic
source data occupied 69 MiB. Resample immediately before mutation; require free
space greater than twice the combined image sizes and source-data size. Stop if
the sample is unavailable or fails this test.

Fetch synchronized `main` and check out only the exact candidate. Build
separate application, operations and PostgreSQL image tags under the existing
synthetic project's name, each labelled with the candidate revision and test
project. Verify their immutable IDs, architecture and revisions; verify the
operations image has no declared volume and can execute Node as UID 1000 in a
read-only, networkless, capability-dropped container. Leave existing tags and
all retained images untouched.

Create the initially absent, owner-only configuration variant
`/home/redwan/fcd-support-host-test-p6-8ccb9a0/config-restore-image-538d1d0`.
Copy only the previously verified non-secret role settings from
`config-restore-r2`, preserving their contents and permissions. Change only the
configuration-root, candidate revision and three image references in its
operations file. Keep the distinct `r2` target, the synthetic 600000-ms
checkpoint-age setting, and disabled model, outbound and n8n execution. Keep
all existing configuration and secret files unchanged.

Under the normal deployment lock and protected configuration checks, verify
the retained source image and physical database identity. Inspect its quiescent
host projection using the retained application image's validator with the
retained source revision and images; first verify that validator image has no
declared volumes. Keep the candidate image and revision for the actual jobs.
Export one fresh synthetic checkpoint and use the existing verified backup
reference. Then run the public `restore-runtime.sh` once into the absent `r2`
target. Only after success run `promote-restore.sh`, `verify-runtime.sh`, the
same-revision `rollback-runtime.sh --confirm-schema-compatible`, and verify
again. Confirm the restored cluster has a different physical identity, both
database volumes remain, the restored selection stays ready, and no job remains.

Recheck the old intent, abandonment record, old target metadata, other fixture
fingerprints and admission snapshot at each boundary. On refusal, interruption,
drift or unexpected state, stop and preserve the evidence; do not replay a job,
delete a volume, repair a selection or retry blindly. This authorizes only the
described synthetic server drill. It does not authorize live Meta, model,
provider, n8n or tunnel calls, production assets, or customer traffic.

### Candidate restore result

On 2026-10-28 (Asia/Dhaka), the recorded preflight, candidate image and
configuration checks, and fresh synthetic checkpoint passed. The public restore
converged the synthetic source to the candidate revision and created the
isolated `r2` volume, network and healthy PostgreSQL actor. Its first stream
job then ended in a closed refusal with an `uncertain` durable job record. The
recorded job container was no longer present; Docker retained no matching exit
events. The target database had zero application tables in a read-only count,
which does not establish that the uncertain job had no side effects.

The source remains quiescent and healthy; the isolated target remains healthy.
The new restore intent, uncertain job, override, target volume and network are
preserved. The prior empty-target intent, abandonment record and target volume
remain, and the admission snapshot is unchanged. No promotion or rollback was
attempted. Do not replay the job, clear its journal, remove the target or infer
a successful restore. Root-cause diagnosis and any supported reconciliation
require separate evidence and a separately recorded action.

Read-only follow-up found that the source PostgreSQL container advertised the
target hostname on its operations network and logged a PostgreSQL superuser
authentication failure after target startup. The archive-reader role, catalog
grants and selected verified-backup state were present. A separate local Docker
reproduction showed that this alias collision can route the target hostname to
the source; after separating aliases, each name resolved only to its own
synthetic database. The removed server job's exact DNS answer remains unknown.
No server job, journal or resource was changed by these checks.

### Fresh synthetic deployment with precreated bridges

Run this action only after all four GitHub workflows pass for exact source
`b0ba255016100a733887fe0e61f8f5065b1a1e86` and this action is committed and
pushed. On `redwan@192.168.10.40`, require UID/GID 1000, a clean server checkout
at `538d1d06b36800cd1fefc778c42f6a248b3ba2b8`, Docker root
`/var/lib/docker`, and at least 12 GiB free on its filesystem. Recheck the saved
admission snapshot and require that no existing container bind mount overlaps
the checkout. The old `8ccb9a0`
source and `r2` target must both be healthy, and the restore job, its override,
the prior intent and abandonment record must remain present. Sample the old
state records, source and target identities, target volume/network identities,
and admission snapshot; require them to match again before and after the new
deployment. Stop on any mismatch or unavailable evidence.

The candidate passed private runtime `40722695090`, CodeQL `40722695201`, CI
`40722695139`, and PostgreSQL/native operations `40722695059`. The latter
included 1,197 native tests, 139 PostgreSQL tests with one restore-only skip,
250 restore tests, and 47 two-cluster PostgreSQL tests. Its separate complete
PostgreSQL job passed 620 tests with 52 skips.

The only new source project is `fcd-support-host-test-p6-b0ba255`, under
`/home/redwan/fcd-support-host-test-p6-b0ba255`; its restore project is
`fcd-support-restore-host-test-p6-b0ba255`. Require the fixture path, project
containers, target network and volume, source volumes, candidate image tags,
and all eight named bridges to be absent. Fetch synchronized `main` and check
out the exact source above in the existing server checkout. Do not change any
existing project, journal, image, volume, container or network.

Create eight dedicated bridge networks in order from `198.18.240.0/24` through
`198.18.247.0/24`. The first six are internal networks named for the project and
`webhook-data`, `admin-data`, `reply-data`, `outbound-data`, `notification-data`
and `operations-data`; label each with the exact synthetic project, Compose
project and corresponding underscore-form Compose network name. The seventh
is the internal project ingress bridge; the eighth is its non-internal egress
bridge. Both carry the exact synthetic project label. Before the first creation,
check the whole `198.18.240.0/20` test block against Docker IPAM, non-default
host IPv4 routes and host IPv4 interface networks. Immediately before each
creation, repeat that check for the particular `/24`. Stop on overlap, drift,
unavailable metadata or an existing name. Do not change Docker's default pool.

Validate all eight bridges with the committed precreated-network guard, then run
`scripts/test-synthetic-runtime-deployment.sh` once at the exact revision with
`--synthetic-precreated`. It creates only private synthetic credentials and
resources, deploys in `private-disabled` mode, and checks the private HTTP and
Unix-socket paths. Preserve logs privately and report only closed pass/fail
markers. Compare the old state and admission snapshots again. A refusal,
interruption or mismatch stops the action: retain all new and old resources and
evidence, do not retry, prune, clear a journal or infer a restore outcome.

This action does not perform a restore, promotion or rollback, contact Meta,
Manifest, n8n or another provider, expose a tunnel, or touch production assets
or customer traffic. A fresh restore/promotion drill needs a separate recorded
action after the new deployment is verified.

### Precreated-bridge deployment result

On 2026-10-28 (Asia/Dhaka), the recorded action created and validated the
eight dedicated bridges, then deployed exact source `b0ba255` in the new
private-disabled synthetic project. Deployment, runtime verification and the
private HTTP checks passed. The old synthetic state records, database actor and
target resource fingerprints, and admission baseline matched before and after.

An independent read-only check found the exact clean server checkout, READY
state with no active job, four healthy runtime actors, the protected admin Unix
socket and login response, and the expected private HTTP responses 403, 404 and 401. The previous restore job remains uncertain and the admission baseline is
unchanged. No restore, promotion, rollback, live provider, Meta, n8n or customer
traffic was attempted. Phase 6 and its restore/failure-matrix gate remain open.

### Fresh synthetic backup replay and capacity action

Using only clean server source `b0ba255016100a733887fe0e61f8f5065b1a1e86`
and project `fcd-support-host-test-p6-b0ba255`, run this action after its record
is committed and pushed. Require the new runtime to be READY, its four expected
actors healthy, its admin socket private, and no active job. Check the retained
admission snapshot and the earlier `8ccb9a0` uncertain restore, target and
healthy database actors. Sample their protected state and resource identities;
require those samples and the new runtime actor identities to match again after
each stage. Reject missing, changed, ambiguous or unavailable evidence.

Run the existing private backup scheduler once with the new project's protected
configuration, then inspect the resulting archives with the committed signed
manifest reader in a non-root, networkless, read-only container. Mount only the
new project's backup volume and its recovery HMAC file read-only; never display
their contents. Require one signed pre-migration, daily and monthly archive;
the daily and monthly archives must match the exact source and schema. Run the
same scheduler again within the same UTC day and month and verify the same
signed archive identities and metadata, proving replay. Keep diagnostics in new
private files, reverify READY and no active job, and print only fixed results.
The exact metadata-reader logic passed a local synthetic replay simulation and
rejected a modified archive. The server container mounts remain to be tested.

Then make one internal default-pool capacity probe named
`fcd-support-subnet-check-b0ba255` with a dedicated synthetic label. Require the
name absent first. If creation succeeds, verify the exact returned network ID,
label, bridge driver, internal flag and zero participants; remove only that ID
without force and verify its absence. A failed or ambiguous creation, changed
state, unexpected participant or failed removal stops the action and preserves
the evidence. Do not alter any other network or Docker's global address pool.

This action performs no restore, promotion, rollback, provider call or public
exposure. A successful capacity sample is not a reservation; the subsequent
fresh restore/promotion drill requires a separate committed action and another
target-absence check. Do not clear or replay the older uncertain job.

### Fresh synthetic backup replay result

On 2026-10-28 (Asia/Dhaka), the recorded action completed both scheduled backup
runs. A non-root, networkless reader verified three signed archives; their
authenticated metadata and identities were identical after replay. The single
internal default-pool capacity probe was created, verified empty and removed by
its exact ID. The old synthetic state and resource fingerprints, current source
actor identities and admission baseline matched throughout.

Independent read-only checks confirmed private backup evidence files, READY
source without an active job, absence of the capacity probe and fresh restore
target, the preserved older uncertain job and unchanged admission baseline.
No restore, promotion, rollback, provider traffic or customer traffic occurred.

### Fresh synthetic restore, promotion and rollback action

Use only clean source `b0ba255016100a733887fe0e61f8f5065b1a1e86` and the READY
synthetic project `fcd-support-host-test-p6-b0ba255`, after this action is
committed and pushed. Recheck the admission baseline, old `8ccb9a0` uncertain
job and target, four healthy new source actors, protected socket, no active job,
and absence of the new target project, volume and network. Require the new
project's model, outbound and n8n execution flags to remain false. Sample old
state and resource identities and require them unchanged throughout. Inspect
only content-free preservation metadata; do not replay, resolve or reuse the
old restore target or job.

Select the new project's current daily backup only after a networkless,
read-only metadata reader verifies all three signed archives and ciphertext
digests. Separately use the existing narrowly scoped archive-reader role on the
private operations network to verify the selected daily reference has a
verified catalog entry for the exact revision and schema. Do not print archive
contents, connection strings, keys or reference values.
The exact reader logic passed a local signed synthetic archive test and refused
tampering; a separate synthetic catalog test accepted verified state and
refused unverified state. The live private catalog connection remains to be
tested by this action.

The authored test fixture has a 60000-ms checkpoint-age limit. To accommodate
the measured multistep host drill, change only its restore-only setting to
600000 ms. Under the new project's deployment lock, require the exact original
settings and private file ownership, verify no existing container bind-mounts
that file or a parent, and exercise the exact update on an owned private
synthetic copy. Verify and remove only that simulation's two exact files and
directory, then preserve an owner-only original copy before the atomic update.
All other settings and the application's configurable limits stay unchanged.
On failure or interruption preserve the original copy and resulting state; do not
automatically reverse or retry an uncertain operation.

Under the normal checked configuration, live verification and deployment lock,
export one fresh synthetic checkpoint with the committed checkpoint job. Perform
one newly created, internal, labelled default-pool capacity probe, verify it is
empty and remove its exact ID; then immediately recheck target absence. The
capacity check is a sample, not a reservation. Run the public restore command
once with the signed daily backup and fresh checkpoint. On success only, run
promotion, public verification, the retained same-revision schema-compatible
rollback command and verification again. Require the selected restored physical
database identity to differ from the source and preserve both volumes. Recheck
the old state and admission baseline at every boundary. A failure, lost
acknowledgement, mismatch or uncertain job stops the drill; retain all state and
resources without replay, manual selection repair or automatic cleanup.

This is a private synthetic test only. It does not contact Meta, Manifest, n8n
or another provider, expose a tunnel, use customer traffic or change production
assets. Passing this drill alone does not complete the Phase 6 failure matrix or
gate.

### Fresh synthetic restore and uncertain promotion result

On 2026-10-28 (Asia/Dhaka), the recorded action selected a signed daily backup
with a verified catalog entry, safely changed the synthetic restore-only
checkpoint-age setting after testing the update, exported a fresh checkpoint,
and rechecked target-network capacity. The public restore completed and wrote
its completed restore record. The subsequent promotion returned
`operations_promotion_refused`; no rollback was attempted.

Read-only follow-up on 2026-10-29 found the new selection and promotion job
both marked uncertain, with `STATE_WRITES_POSSIBLE=yes`. Both synthetic source
and restored PostgreSQL actors were healthy. The promotion job's recorded
container was absent, its override remained, and the completed restore record
remained. The earlier `8ccb9a0` uncertain job and admission baseline were also
preserved. The absence of the actor does not establish whether promotion had
side effects or which database is authoritative.

Preserve both databases, volumes, networks, settings, restore record, job and
override. Do not retry promotion, clear the journal, repair the selection or
infer rollback. Diagnose the refusal with content-free read-only evidence and
design any supported settlement separately. Phase 6 and its failure matrix
remain open; no live provider or customer traffic was used.

Read-only diagnosis found no currently matching operation backend or prepared
transaction on either synthetic database, and the target lacked the promotion
verification binding. Docker's journal recorded deletion of the exact task but
contained no exit status. These point-in-time observations do not settle the job.
The old promotion host secret guard also refused the preserved fixture because
it expected UID 1000 for PostgreSQL password files owned by UID 999. A real
Docker regression reproduced that refusal; the role-specific correction is
under validation. A separate read-only render of the preserved promotion job
showed its checkpoint root is `/var/lib/fcd-support/backups`, while the old
host validator expected a `checkpoints` subdirectory. A Compose-linked regression
reproduced that mismatch. Both fixes passed local validation: the full code gate
passed 1,801 tests with 423 platform skips; native operations passed 1,198 tests
and 139 PostgreSQL tests with one restore-only skip; the separate restore gate
passed 250 tests and 47 PostgreSQL tests. Real Docker ownership and negative
cases passed, the updated guard accepted the preserved metadata read-only, and
synthetic test projects were cleaned up. All four exact-revision GitHub checks
passed for `fdf08d4`. The removed job's exact failure point remains unknown.

### Configurable restore subnet checkpoint

The restore controller now accepts optional protected `FCD_RESTORE_SUBNET`.
It checks host routes and interfaces before intent and before bridge creation,
and binds the actual network ID and single IPAM subnet on every target proof.
Omitting the setting keeps the existing default-pool behavior. This permits
planning a fresh independent fixture without clearing the uncertain promotion
or changing the daemon's global pools.

The final code gate passed 1,851 tests with 433 platform skips across 125 files
using four workers (235.32 seconds for tests). Native validation passed 1,258
tests across 55 files and 139 PostgreSQL tests with one restore-only skip
across 13 files. All 41 native subnet cases passed after correcting the test
bootstrap to load the shared shell helpers. Real Docker checked explicit
allocation, actual controller network ID/IPAM binding, wrong-IPAM refusal and
conflicting-subnet refusal. Cleanup reported zero resources for the isolated
test project.

Read-only server checks found a clean `b0ba255` checkout, at least 12 GiB free,
healthy latest source/target databases, a healthy older source and its exact
`r2` target, preserved journals and running admission actors. The older source
selection remains quiescent; the latest promotion selection remains uncertain.
The candidate `198.18.224.0/20` test block had no sampled Docker IPAM, non-default
route or interface-network overlap. The new checker was streamed to Node
without writing server files: it accepted unused `198.18.232.0/24` and refused
occupied `198.18.240.0/24`. These are point-in-time checks, not a network
reservation or a deployment. Exact-revision GitHub checks and a separately
committed server action remain required. No job was retried or settled, and no
production, provider or customer traffic was used.

### Fresh independent deployment action at 6faff8b

Execute only after all four GitHub workflows pass for exact source
`6faff8b37c6bd6d867c2cace30bdb0bc88578561` and this action record is committed
and pushed. Use `redwan@192.168.10.40`, UID/GID 1000, and the existing clean
checkout `/home/redwan/apps/fcd-support` at
`b0ba255016100a733887fe0e61f8f5065b1a1e86`. Require the local Docker daemon,
Docker root `/var/lib/docker`, and at least 12 GiB free there. Require no
container bind mount to overlap the checkout and no running operations job.
Keep command output in new owner-only action logs, with closed results only.

All four exact-source workflows passed: CI `40841770778`, PostgreSQL/native
operations `40841770849`, CodeQL `40841770958` and private runtime controller
`40841771071`. These remote checks do not themselves execute this server action.

Before mutation, preserve the original admission snapshot and verify its actor
IDs and running states. The start-time drift documented below must not be
silently overwritten. After rechecking recorded image/version, read-only-root,
zero-host-port and original PostgreSQL-volume properties, save a separate
owner-only current admission metadata baseline in the new action directory.
Compare that baseline after each stage, and require the old snapshot file hash
unchanged. Sample protected prior synthetic state/history files and existing
source/target actor, volume and network identities without displaying file
contents or reference values. In particular, preserve the entire `b0ba255`
uncertain promotion, its job override and completed restore record, its healthy
source database and exact stopped restore target. Preserve the older `8ccb9a0`
quiescent healthy source, uncertain restore job, original intent/abandonment
history and exact stopped `r2` target, plus
all earlier fixture history. Require the same samples after each stage and at
the end; refuse unavailable evidence or drift. Do not resolve, replay or reuse
any old job or target.

The only new runtime project is `fcd-support-host-test-p6-6faff8b`, under
`/home/redwan/fcd-support-host-test-p6-6faff8b`. Its future target project is
`fcd-support-restore-host-test-p6-6faff8b`. Require both namespaces, fixture
root, source/backup/target volumes, eight named bridges, restore bridge and
candidate image tags to be absent. Create a separate initially absent,
owner-only `/home/redwan/fcd-support-p6-action-6faff8b` log directory. Fetch
synchronized `main` and check out only the exact source above; refuse local
changes rather than resetting them. Existing admission actors continue using
their retained built images.

Check the complete `198.18.224.0/20` test block against current Docker IPAM,
non-default IPv4 routes in every host table and IPv4 interface networks.
Require no overlap and available bounded inventory. Create eight dedicated
bridge networks in order from `198.18.224.0/24` through `198.18.231.0/24`,
repeating the individual subnet check and name-absence check immediately before
each creation. The first six are internal, named with the new project and
`webhook-data`, `admin-data`, `reply-data`, `outbound-data`, `notification-data`
and `operations-data`. Label each with the exact synthetic project, Compose
project and corresponding underscore-form Compose network name. The seventh
is the internal project ingress bridge; the eighth is its non-internal egress
bridge. Both carry the exact synthetic-project label. Verify returned immutable
IDs, default single-subnet IPAM, exact requested subnet and zero membership.
Do not change Docker's default pool or any existing network.

Validate the eight bridges with the committed precreated-network guard. Then
run once, with closed stdin and private diagnostics:

```sh
bash scripts/test-synthetic-runtime-deployment.sh \
  6faff8b37c6bd6d867c2cace30bdb0bc88578561 --synthetic-precreated
```

The committed harness creates fresh synthetic credentials and pinned images,
deploys in private-disabled mode and checks the operator deploy/verify commands,
private HTTP 403/404/401, admin Unix-socket login 200 and protected socket
ownership. Independently require four healthy runtime actors, READY selection,
no active job and matching preserved-state/admission samples. Retain a
successful new synthetic runtime for the following backup/restore matrix.

A refusal, interruption, lost acknowledgement or changed evidence stops the
action. Preserve all new and old resources and diagnostics; do not retry,
clear state, infer an outcome or switch to an older database. The existing
admission stack is unaffected by this separate project, so no admission
rollback is part of this action. It performs no restore, promotion, provider
traffic, tunnel change or production action. Using `198.18.232.0/24` as a
future explicit restore subnet requires a separate recorded action and fresh
overlap/absence checks; this sample does not reserve that subnet.

### Read-only admission snapshot drift before the fresh action

The original `b0ba255` admission snapshot no longer matches container start
times. All three immutable container IDs and running states still match. The
host reports a current boot later than the snapshot file's modification time;
the Docker start timestamps are about 69 seconds earlier than that reported
boot time. This inconsistent wall-clock evidence does not establish an exact
restart sequence or settle any interrupted job.

Independent bounded checks found two stable current metadata samples: the API
and tunnel retain the recorded `207a5e6` image references, PostgreSQL uses a
pinned `18.4` reference and reports version `18.4`, all three actors are healthy
with read-only roots and zero host ports, and PostgreSQL retains the original
named volume. The latest and older synthetic job records and their overrides
passed protected-file/state checks, and the latest completed restore record
remains. No restart, state repair or new deployment was performed.

The fresh action above preserves the original snapshot and records a separate
current metadata baseline only after those identity/definition checks pass
again. Require both the old file's preservation and the new baseline's stability
throughout the action. Neither baseline proves SQL-job termination or permits
clearing uncertainty.

Further read-only inspection found both preserved restore targets exited with
automatic restart disabled, while their two source databases remain running
and healthy. Each target's actual image, restore-reference label and named
volume match its protected original restore intent. The fresh action now
requires those exact stopped states and bindings and must leave them stopped;
it does not restart or inspect SQL on either target. Current actor/state/resource
fingerprints are bound into the separate baseline and must remain unchanged.
This is preservation of observed state, not proof of the uncertain jobs' outcomes.

The concrete executor is
`docs/operations/actions/2026-10-29-deploy-6faff8b.py`. Its syntax and actual
server `--inspect` mode passed without writing server files or changing Docker
resources. It holds temporary shared locks on old synthetic deployment journals
and fingerprints their protected files and actor/network/volume metadata.
Docker's unordered mount list is sorted before comparison; all mount fields
and duplicate entries remain in the comparison. The executor preserves the
original admission snapshot and writes the separate current baseline only in
`--execute` mode, in the new private action directory.

After this record and executor are committed and pushed, run the exact executor
from the local checkout with stdin closed for every child command:

```powershell
$taskAction = Get-Content -LiteralPath 'docs/operations/actions/2026-10-29-deploy-6faff8b.py' -Raw
$taskAction | ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes redwan@192.168.10.40 "tr -d '\r' | python3 - --execute"
```

The action must emit both `synthetic_action_deployment_verified=true` and
`synthetic_action_preserved_state_unchanged=true`. Any refusal preserves
resources and private diagnostics; never rerun this single-use executor to
repair an interrupted attempt. Execution is still pending at this checkpoint.

### Fresh 6faff8b deployment result

On 2026-10-29 (Asia/Dhaka), the action and exact executor committed at
`9c2e404` completed against source
`6faff8b37c6bd6d867c2cace30bdb0bc88578561`. The eight explicit bridges passed
the precreated-network guard, then the committed harness completed pinned image
builds, private-disabled deployment, runtime verification, private HTTP
403/404/401 and admin Unix-socket login 200 with `1000:1000:600` ownership.
The executor emitted both required success acknowledgements. All prior
protected file and actor/network/volume fingerprints matched the separate
current baseline; the original admission snapshot remained unchanged. The old
restore targets remained stopped and no uncertain journal was resolved.

An independent read-only check confirmed a clean exact-source server checkout,
READY selection without an active job, four healthy actors with read-only roots
and zero host ports, private admin socket/login, unchanged prior state-file
fingerprints and absence of the fresh restore project, volume and bridge.
The new runtime is retained for the next backup/replay and isolated
restore/promotion/rollback drill. Those actions have not yet run for this scope;
Phase 6 and its gate remain open. No provider traffic, tunnel change, production
asset change or customer data was used.

The executor's additional `--audit` mode rechecks the protected saved baseline
without writing files, starting containers or changing journals. It cannot
repeat deployment or settle any job. This is the preservation check for later
separately recorded drills; run `--audit`, never `--execute`, after this completed
single-use action.

### Fresh 6faff8b backup/replay action

After this record and `docs/operations/actions/2026-10-29-backup-replay-6faff8b.sh`
are committed and pushed, use only exact source
`6faff8b37c6bd6d867c2cace30bdb0bc88578561` and the READY synthetic project
`fcd-support-host-test-p6-6faff8b`. Its four source actors must be healthy and
private, with no active job; the fresh restore target must remain absent. Run
the deployment executor's read-only `--audit` before and after this drill to
recheck the entire old-state baseline. Preserve all old journals and stopped
targets; never execute the old deployment again.

The single-use backup script requires a local daemon, the exact clean source,
the new project's retained operations image without implicit volumes, the
existing labelled backup volume and its exact Docker-root mountpoint, and the
protected new recovery-HMAC file. It creates only a new owner-only
`/home/redwan/fcd-support-p6-action-6faff8b/backup-replay` evidence directory.
It reads the initial pre-migration archive, runs the existing public scheduler
`scripts/run-operation.sh backup <revision> <new-config>` once, verifies the
runtime and signed metadata, then repeats in the same UTC day/month and compares
the complete authenticated metadata byte-for-byte. No settings or limits change.

Each metadata reader is a fresh named, labelled, non-root, networkless,
read-only, resource-limited container. It has exactly two read-only bind mounts:
the existing backup volume's mountpoint and the new project's recovery-HMAC
file. It receives no database, restore identity, provider key or customer data.
Before start, verify its actual identity, user, network, ports and two mounts;
remove only that exact exited, successful reader. The existing manifest reader
verifies HMAC and ciphertext digest without decrypting an archive. Manifests,
references, hashes and key material must never be printed or committed; only
closed outcomes are reported. All reader and scheduler diagnostics remain private.

Require one pre-migration, one daily and one monthly signed archive, with daily
and monthly matching the exact source/schema. Replay must retain identical
authenticated metadata. The script checks preserved prior file and actor
identity/start/state metadata at each boundary, and runs public runtime
verification after each scheduler activation. Final full read-only audit must
pass, with READY/no job and the fresh restore target still absent. A refusal,
uncertain job, clock-period change or lost acknowledgement stops this action;
preserve the evidence and do not rerun the single-use script or clear state.
No restore, promotion, rollback, tunnel, live provider or production action is
included. The signed-reader library's malformed/tampered cases already pass
the exact-source unit/native gates; this wrapper must pass shell and embedded
JavaScript syntax checks before execution. Actual server execution is pending.

### Fresh 6faff8b backup/replay result

On 2026-10-29 (Asia/Dhaka), the exact action committed at `cda55ed` passed on
the fresh `6faff8b` synthetic runtime. The networkless reader verified the
initial pre-migration archive, then the scheduler created and verified daily
and monthly backups. Its second activation retained the same three signed
archives with identical authenticated metadata. Runtime verification passed
after each activation. Full saved-baseline audits passed before and after;
the script's prior-file and actor checks also passed at each boundary.

An independent read-only check confirmed private evidence-directory/file
permissions, identical three-archive replay metadata, four healthy source
actors, READY/no job, removal of the three successful metadata readers and
absence of the fresh restore volume and bridge. No settings, checkpoint,
restore, promotion, rollback, public route or live provider were changed.
Fresh checkpoint/isolated restore/promotion/rollback and the remaining
interruption/failure matrix are still required for Phase 6.

### Fresh 6faff8b restore configuration preparation action

After this record and
`docs/operations/actions/2026-10-29-prepare-restore-6faff8b.py` are committed
and pushed, run that exact helper once with `--apply` on the synthetic server.
Its syntax and actual read-only `--inspect` mode passed. Require exact clean
source `6faff8b`, the new READY selection without an active/pending job or state
replacement, local Docker, an absent fresh target and the unused checked
`198.18.232.0/24` subnet. Run the full preservation `--audit` before and after.

Under the new project's existing deployment lock, verify protected regular
configuration files with canonical paths, single links and `1000:1000:600`
metadata. Require the original host file to have no restore-subnet setting and
the restore role's checkpoint age to be exactly 60000 ms. Verify no existing
container bind-mounts either file or an ancestor.

Create only the initially absent, owner-only
`/home/redwan/fcd-support-p6-action-6faff8b/restore-drill` directory. Preserve
byte-exact original host and restore-role settings there. First simulate and
validate the two changes on separate private copies, including the real
protected host configuration parser. Then atomically replace only
`config/operations.env` to add `FCD_RESTORE_SUBNET=198.18.232.0/24`, and
`config/restore.env` to set `CHECKPOINT_MAX_AGE_MS=600000`. Require every other
setting and byte outside the two changes unchanged. Flush copies and directory
entries; retain originals and simulations as private evidence. These are scoped
synthetic settings; application defaults and all other customizable bounds stay
unchanged.

Require final parser validation and READY/no job. Any failed simulation,
replacement or acknowledgement stops the action and preserves all files; no
automatic reversal or retry is permitted. This action performs no checkpoint,
SQL job, restore, promotion, rollback, network creation, provider or production
operation. The later fresh restore drill requires its own committed action.

### Fresh restore preparation result and staged drill action

The `e930e5b` preparation action passed on 2026-10-29 (Asia/Dhaka). It retained
the original settings and simulations, changed only the two recorded synthetic
settings, passed the real host parser and retained READY/no job. Full saved
preservation audits passed before and after. No checkpoint or SQL job ran.

After this record and `docs/operations/actions/2026-10-29-restore-drill-6faff8b.sh`
are committed and pushed, execute its stages once, in order: `restore`,
`promote`, then `rollback`. Use only the exact clean `6faff8b` source, the new
synthetic project, protected prepared settings and signed daily backup selected
from the successful private replay evidence. The stage driver requires actual
settings to match the validated private simulations. Markers describe attempts
and acknowledgements; they never replace the controllers' journal, physical
identity or fresh-proof checks. Refuse existing attempt markers and preserve
them on failure; do not rerun a stage.

Before and after each successful stage, run the deployment executor's full
read-only `--audit`. Require old journals, original admission snapshot,
current admission baseline and prior actor/network/volume metadata unchanged;
the old restore targets must remain stopped. Stop the sequence on any refusal,
uncertain journal, lost acknowledgement, failed audit or changed evidence.

The `restore` stage requires the fresh project/volume/bridge absent and the
explicit `198.18.232.0/24` subnet available. It publicly verifies the READY
runtime, preserves its selected identity privately, and exports one fresh
checkpoint using the existing scheduler's protected configuration, deployment
lock, Ready/physical identity and retained-image checks with the narrow
`checkpoint export-checkpoint-reference` job. Then run `restore-runtime.sh`
once with that checkpoint, the selected signed daily backup and prepared
configuration. The existing restore implementation independently checks the
signed manifest, ciphertext digest and verified authoritative backup catalog.
Require its completed protected restore record, quiescent source and no active
job. This stage does not attach application writers to the target.

Only after restore succeeds, `promote` invokes the existing fresh-checkpoint,
two-challenge promotion controller and public runtime verification. Require
READY on the fresh restored volume with a physical system identifier distinct
from the original source and the original volume retained as provenance.
Only then may `rollback` invoke the retained same-revision, exact-schema
compatibility command and public verification. It must preserve the selected
restored volume and physical identity; it does not restore old data or select
the old source volume. Verify both named volumes remain present.

Keep all references, metadata and diagnostics in the private restore-drill
directory, with only closed outcomes printed. The stage driver's shell and
embedded Python syntax must pass before execution. A failure preserves both
databases, volumes, networks, files and uncertainty; there is no automatic
rollback, cleanup, retry or selection repair. No provider, public tunnel,
production asset or customer-data action is included. This drill alone cannot
complete the remaining interruption matrix or P6-GATE.

### Fresh restore success and refused promotion

On 2026-10-29 (Asia/Dhaka), the committed `80ea3d2` restore stage exported a
fresh checkpoint and completed the isolated restore on explicit subnet
`198.18.232.0/24`. The completed restore record, quiescent source and no active
job passed; the full prior-scope preservation audit also passed.

The following promotion stage returned `operations_promotion_refused`.
Read-only inspection found the new selection and promotion job uncertain,
`STATE_WRITES_POSSIBLE=yes`, the selected pointer still naming the original
volume, the recorded job actor absent, and the job override/completed restore
record preserved. Both new PostgreSQL actors are running and healthy. Rollback
was not attempted. The old-scope full preservation audit still matches.
These observations do not establish whether promotion SQL had side effects.

Protected file metadata showed about 3.3 seconds from job-override creation to
the uncertain job record; that timing does not establish a root cause. A
separate read-only stability probe used the actual guarded Docker projection:
ten source reads were stable, while ten target reads had four adjacent raw
changes. Both had two mounts, and every complete parsed observation matched
after mount-order normalization. The collector's raw source/target string
rechecks can reject unchanged resources solely because of Docker mount order.
This independently reproducible blocker is specified in
`docs/superpowers/specs/2026-10-29-phase-6-promotion-metadata-stability.md`.
The removed job's exact failure point remains unknown.

Preserve the entire fresh scope and all earlier uncertain scopes. Do not rerun
any stage, restart/clear a job, repair the pointer or infer rollback. The next
local Task 11 correction must retain all observations and security checks while
comparing unordered mounts semantically, with deterministic regressions and
fresh CI before another separately recorded server drill. Phase 6 is not done.

### Independent event-history follow-up and local work allocation

A subsequent read-only probe on 2026-10-29 bound the uncertain `promote` job to
its protected journal and queried Docker lifecycle events for that exact actor,
from ten seconds before the attempt marker to sixty seconds after the uncertain
journal's modification time. Docker returned zero events. Retained event
history may be incomplete; this is neither an exit receipt nor evidence that
the actor never started. No raw event attributes, actor IDs, references or
message content were emitted. All current-scope state-file identities and
hashes matched before and after, the rollback-attempt marker remained absent,
and the full saved old-scope preservation audit passed before and after.

Code inspection of `operations_job_uncertain` shows that the controller can
stop and remove an exactly verified owned actor while retaining the uncertain
durable job record. Consequently, actor absence is consistent with containment
after a failure and does not establish its cause or SQL outcome. No historical
termination receipt or failure-stage proof was recovered. Future fresh-action
diagnostics should capture bounded, content-free lifecycle and protocol-stage
evidence before an actor can be removed, without changing public controller
checks or treating diagnostic observations as recovery authority.

The owner requested a larger Antigravity assignment. The handoff committed at
`15a2b55` assigns four isolated local tasks: the existing metadata-stability
correction, exact Task 11 gap coverage, Tasks 12–14 integration readiness, and
validated review-branch delivery. Codex retains server diagnosis/action records
and later deployment/gate decisions. Antigravity must not edit the active
tracker/context/server-action files, touch the server or merge its branch.
This records the assignment, not an assertion that Antigravity has started or
completed it. All uncertain scopes remain preserved.

### Reviewed correction and next fresh synthetic action

This proposal was subsequently withdrawn before execution; see the later
static-guard blocker below. Do not execute or recreate it without the reviewed
post-verification fix and a newly pinned action.

Antigravity's submitted head was `b802e3cbbcd093e0f2bef06097dacb3d5319fd24`.
A fresh read-only review found seven important code, test and evidence issues.
The corrected head `ace6babde69eba45c6d3cf4bd4cc6051f800ca49` passed 1,873
tests with 433 platform skips across 125 files, 1,280 native tests across 55
files, and 139 PostgreSQL tests with one restore-only skip across 13 files.
Real Docker proofs passed and exact-owned test resources were removed. All four
PR workflows passed: CI `40902218674`, CodeQL `40902218718`, private runtime
`40902218680`, PostgreSQL/native `40902218850`. PR #1 was squash-merged as
`70f8e7073d20bce0b54d84011e001a2bd5bb527f`; its tree matches the tested head.
Require all four merged-source workflows before deploying that exact revision.

The correction also canonicalizes the unordered host bind inventory without
losing multiplicity, fixes the counter-based regression and uses compiled
production comparison in the Docker probe. Eighty-four exact matrix test titles
matched their named source files. Corrected coverage does not prove a historic
server failure point, resolve an old job or complete Task 11/P6-GATE.

Read-only server checks passed after correcting a probe that incorrectly looked
for a shared setting in the restore-specific file. The shared call bound is
20,000 ms, promotion host-check bound 10,000 ms, and prepared checkpoint maximum
age 600,000 ms. Both preserved `6faff8b` databases remained healthy/private,
state identities/hashes matched, and the old-scope audit passed. An unused
198.19.0.0/20 block and the minimum free disk capacity passed. Candidate namespace
checks were performed for `ace6bab`; the actual `70f8e70` action must repeat its
own namespace and capacity checks. No deployment or retry occurred in that probe.

#### Passive observation choice and implementation steps

Codex selected a passive host observer for the fresh synthetic promotion.
This is a routine diagnostic choice under the owner's delegated execution
authority, not a claim of separate owner approval or a new recovery design.
Three approaches were considered:

1. A bounded passive observer of scoped Docker lifecycle events and the pinned
   promotion job's closed protocol output. It preserves stage evidence before
   cleanup while leaving the public controller unchanged. This is selected.
2. New production-controller phase journaling. This could give stronger stage
   attribution but changes the deployed logging surface and needs a separate
   application change; it is deferred.
3. Reconstructing evidence only after actor removal. The zero-event historical
   query already shows that this cannot provide dependable stage evidence.

The observer may invoke only read-only local Docker events, inspect and logs
commands. It must bind a matching start event to the exact protected current job
journal and actual identity before following output. It cannot start, stop,
remove, replay or settle any container or operation, query SQL, change selection,
attach storage, or grant readiness. It writes only enumerated stage codes,
bounded elapsed milliseconds and an optional numeric Docker exit code into one
new owner-only action file. Never persist raw event attributes, logs, references,
challenges, IDs, paths from output, errors or arbitrary reason strings. Retain
bounded buffers, output count, total duration and only owned reader processes.
Diagnostic gaps or observed exit codes never establish SQL outcome.

Execution steps are:

1. Write synthetic parser/record tests first. The initial minimal stubs produced
   11 expected assertion failures across 14 tests; implement and verify GREEN.
2. Self-review the observer, test bounded framing, nonce/reference/sequence
   matching, foreign events, malformed input and content-free records. Verify
   syntax and run the same pure tests on Linux without starting an observer.
3. Pin a new deployment executor to `70f8e70`, starting only from the clean
   `6faff8b` server checkout. Its full baseline includes the now-older uncertain
   `6faff8b` scope as well as all earlier scopes and the original admission
   snapshot. Preserve stopped targets and all prior state/storage.
4. Precreate eight separately checked bridges in 198.19.0.0/24 through
   198.19.7.0/24. After deployment, backup/replay and protected preparation,
   configure only the fresh target's 198.19.8.0/24 subnet and the synthetic
   checkpoint age bound. Repeat actual route, interface and Docker IPAM checks.
5. Commit/push the concrete action and diagnostics before execution; require
   merged-source CI and a fresh read-only preflight. Deploy once in a fresh
   namespace, then verify four healthy private actors, READY/no job and all
   preservation baselines before proceeding.
6. Run the recorded backup/replay and isolated restore stages. Start the passive
   observer and require its fixed ready marker before the single public
   promotion stage. Keep public verification and all current journals as the
   authority; observer output is diagnostic only. Only successful promotion and
   verification permit the compatible retained-revision rollback stage.
7. Stop on any refusal, uncertainty, failed preservation, lost acknowledgement
   or incomplete required proof. Preserve every scope and diagnostic file. Do
   not rerun a stage, infer completion from a missing actor, repair a pointer,
   clear journals or add a resolver. Remaining interruption/integration evidence
   and the Task 15 whole-phase review remain required before P6-GATE.

### Later static-guard blocker and withdrawn unexecuted proposal

All four merged-source `70f8e70` workflows passed: CI `40903959620`, CodeQL
`40903959344`, private runtime `40903959355`, PostgreSQL/native `40903959531`.
The generated fresh action's `--inspect` passed the full read-only admission,
including old-state preservation, absent namespace and proposed network range.
It was **not executed**.

A subsequent adjacent-guard check found `OPERATIONS_PROMOTION_STATIC_FORMAT`
still embeds raw JSON `.Mounts`. Capture/proof compares the complete resulting
string before PostgreSQL stop/removal. The controller source is identical at
`6faff8b` and `70f8e70`. A read-only probe of that exact template produced two
adjacent raw changes across ten source reads and two across ten target reads.
All complete projections matched after sorting complete raw mount records,
including all fields and multiplicity; a deliberate reversal also rejected raw
equality without any metadata change. State hashes matched before/after.
This independently demonstrates a later false-refusal blocker; it does not
recover the earlier job's failure point or settle its SQL outcome.

The four generated `70f8e70` action copies were individually verified as local
untracked drafts and withdrawn. All tracked predecessor drivers remain. No
fresh server namespace, action directory, baseline, network, image or volume was
created. Do not execute the `70f8e70` proposal. The bounded correction in
`docs/superpowers/specs/2026-10-29-phase-6-post-verification-metadata-stability.md`
and its matching plan must pass review and exact-source CI first. Regenerate
the action/observer pins for that corrected source and repeat admission.

The passive observer received a fresh pre-execution review. One cleanup finding
was reproduced: default SIGTERM/SIGHUP could bypass reader cleanup. A flag-based
signal handler now exits through owned-reader cleanup; persistent Docker
readers also carry their own `--until` bound. Windows verification passed 28
tests with one SIGHUP skip; Linux passed all 29. Hermetic worker subprocesses
exercise the actual loop's full protocol/lifecycle, timeout, EOF, partial
launch, real signal delivery and kill fallback. These are synthetic process
tests, not an actual observer or promotion run. A clean-environment read-only
Docker transport check passed separately on the preserved server.

The observer is still a prototype pinned to the unadmitted `70f8e70` scope.
Its launch marker is not a subscription acknowledgement, SQL outcome or runtime
readiness proof. Observations from independent streams need not reflect causal
execution ordering. Its diagnostic duration argument is bounded to 10–300
seconds, with persistent reader wall-clock bounds five seconds longer; buffers
and the 64-record output limit remain finite. All output is fixed stage/time and
optional numeric exit status. No actual observer has been started. AGY's new
handoff prioritizes the static-guard fix, then automated CI recovery and genuinely
additional observer runtime coverage. Task 11/Task 15/P6-GATE remain open.

### Fresh reviewed 67a4a4b action (2026-10-31)

PR #2 is merged as `67a4a4bede6d3252dc936a6e410f4b90c1359ac3` with the exact
application tree tested at `9c6ffc5`. The corrected-source four workflows pass;
all four exact merged-source workflows must also pass before execution. See
`docs/reviews/2026-10-31-pr-2-integration.md` for independent evidence.

Read-only SSH diagnosis found only the default bridge was recreated, coinciding
with Docker daemon initialization. Custom network identities/configurations and
actor memberships by network name match; protected files and volumes match.
The old baseline remains immutable and refuses actor start/endpoint drift. Two
current observations are stable. Capture a separate current baseline in the new
action directory; do not replace or claim a match against the old baseline.
Old uncertain jobs retain unknown SQL outcomes. All old targets, including
`6faff8b`, are stopped/restart-disabled and must remain so.

The following single-use records are pinned to the merged source, the clean old
`6faff8b` checkout and fresh private `67a4a4b` namespaces:

- `docs/operations/actions/2026-10-31-deploy-67a4a4b.py`
- `docs/operations/actions/2026-10-31-backup-replay-67a4a4b.sh`
- `docs/operations/actions/2026-10-31-prepare-restore-67a4a4b.py`
- `docs/operations/actions/2026-10-31-restore-drill-67a4a4b.sh`

Fresh independent review found no Important/Critical issue. `--inspect` passed
read-only admission, preservation/absent-scope checks and capacity. Syntax and
repinned observer pure tests passed (32/one Windows SIGHUP skip). These records
have not executed. Commit/push them before server mutation.

Execute deployment once; require final verification and full `--audit`. Run
backup/replay once and audit. Prepare only the fresh protected fixture's isolated
`198.19.8.0/24` target subnet and explicit synthetic 600,000 ms checkpoint window;
the eight fresh source bridges occupy `198.19.0.0/24` through `198.19.7.0/24`.
Run isolated restore once and audit. Start the repinned passive observer in a
separate SSH session, require its launch marker, then promote once. Its marker
is not a subscription acknowledgement and observations never settle SQL jobs.
Only successful public promotion and verification permit compatible retained
same-revision rollback, followed by public verify and full preservation audit.
Both source/restored volumes must remain. Stop on any refusal, uncertainty,
missing acknowledgement or preservation failure; never retry or repair a scope.

No provider call, Meta asset, tunnel/public ingress, production resource, old
selection/job or old target is changed by this action. Task 11 and P6-GATE remain
open pending actual proof, remaining interruption coverage and independent review.

Before committing this action, all four merged-source workflows passed:
CI `41167434851`, CodeQL `41167434819`, PostgreSQL/native `41167435035` and
private runtime `41167434856`. The action stays pinned to the tested `67a4a4b`
application source even when later documentation commits advance main.

### Observed reboot and separately gated fresh admin recovery

The `7afffd5` recorded action deployed exact `67a4a4b`, verified backup/replay,
completed isolated restore and passed public promotion/verify. Audits matched
through pre-promotion. The post-promotion audit refused old start/endpoint drift;
stop the original action and do not invoke its rollback stage.

Read-only diagnosis proves a host reboot during the drill. Old protected files,
volumes, actor identities and other definitions remain exact; custom network
identities/configuration/member identities match. Seven running actors restarted
and the default bridge was recreated. The old baseline remains immutable.
Fresh admin has a protected refused stale socket; API, reply and PostgreSQL are
healthy. Current public verification is required after recovery.

The separately reviewed record
`docs/operations/actions/2026-10-31-reboot-recovery-67a4a4b.py` admits only the
strict reboot delta, captures a separate current baseline, pins boot/daemon and
old restart policies, and requires all old targets stopped/restart-disabled.
After final review, read-only inspect and commit/push, run `--recover` once:
exact fresh admin stop under lock, unchanged public inode-bound socket recovery,
then same admin start under lock and configured bounded health/public verify.
Public commands acquire their own deployment lock; never nest them under the
outer stop/start lock. No manual unlink, chmod, recreation or retry.
Only a successful recorded recovery and current verification permit its separate
one-use `--rollback`, followed by public verify and `--audit`. Immutable fresh
configuration/secret metadata/restore evidence/bundle stay bound after rollback
and during audits. Keep the selected restored identity and both volumes.
Further restart, pending job, missing acknowledgement or drift stops continuation.
See `docs/reviews/2026-10-31-server-reboot-recovery.md` for actual evidence and
limits. This proposal has not executed and does not close Task 11 or P6-GATE.

### Separate inert canary recovery after successful socket repair

The committed `4c51898` socket action recovered the stale entry, restarted the
same admin and reached healthy readiness. Final public verify refused because
the reboot stopped the synthetic ingress canary (restart `no`). The action
stopped without its completion marker; never rerun it or fill in that marker.
All four runtime services are healthy, and saved baseline/policy/binding checks
match. Rollback remains unattempted.

Use the separately reviewed
`docs/operations/actions/2026-10-31-peer-recovery-67a4a4b.py` only after its
commit/push and read-only `--inspect`. Run `--recover` once to start only the
configured exact same inert, mount-free, credential-free canary under lock,
then require unchanged public verification and preserved baselines/bindings.
Its actual two network identities/static definitions and hardening are pinned.
A new `peer-recovery/runtime-completed` is required for its separate one-use
`--rollback`; successful public rollback/verify and `--audit` must preserve the
restored physical identity and both volumes. Original failed records remain
immutable. Any refusal or restart stops continuation. No old scope is retried.
The concrete proposal passes 11 hermetic methods and scoped independent review;
no canary action has executed at this record point. Application remains `67a4a4b`.

### Rollback-only continuation after acknowledged canary start

The `626f411` canary start was acknowledged and the same peer is running. The
post-start guard refused before verification: only each network's live `Status`
allocation counters changed (+1 IP in use/-1 available). Every static field and
preservation/binding check matched. Preserve that failed attempt and its absent
completion marker; never rerun the canary or socket-recovery stages.

The separate
`docs/operations/actions/2026-10-31-rollback-after-reboot-67a4a4b.py` admits only
the exact known counter schema/transition while pinning all other peer/network
fields and failed evidence. After review/commit/push and read-only `--inspect`,
run `--execute` once. Current public verify precedes the one-use rollback intent;
only then run unchanged same-revision rollback and public verify. Its new
`rollback-after-reboot` proof/markers never modify prior records. Require
`--audit`, healthy private runtime, unchanged selected restored identity and both
volumes, exact old baseline/restart policies and immutable fresh bindings.
Any refusal, restart, missing acknowledgement or drift stops continuation.
Six hermetic methods and read-only admission pass; execution remains pending.
