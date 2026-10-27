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
