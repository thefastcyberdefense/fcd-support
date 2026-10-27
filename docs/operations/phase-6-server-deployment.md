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
