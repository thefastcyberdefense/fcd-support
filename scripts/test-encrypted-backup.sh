#!/usr/bin/env bash
# Pinned, synthetic, non-root local backup proof. Never attaches a live project.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
MODE="${1:-backup}"
[[ ( "$#" -le 1 || ( "$#" == 2 && "$MODE" == state ) ) && ( "$MODE" == backup || "$MODE" == checkpoint || "$MODE" == grants || "$MODE" == restore || "$MODE" == state || "$MODE" == settlement || "$MODE" == unit ) ]] || { echo backup_test_mode_invalid >&2; exit 1; }
TEST_PROJECT="${FCD_SYNTHETIC_TEST_PROJECT:-fcd-support-test}"
[[ "$TEST_PROJECT" == fcd-support-test || "$TEST_PROJECT" =~ ^fcd-support-test-[a-z0-9-]{1,32}$ ]] || { echo backup_test_project_invalid >&2; exit 1; }
TEST_NETWORK="${TEST_PROJECT}_data"
UNIT_FILES=(tests/backup.test.ts tests/backup-retention.test.ts)
INTEGRATION_FILES=(tests/integration/postgres-encrypted-backup.test.ts)
if [[ "$MODE" == checkpoint || "$MODE" == grants ]]; then
  UNIT_FILES+=(tests/deletion-checkpoint.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-deletion-checkpoint.test.ts)
fi
if [[ "$MODE" == grants ]]; then
  UNIT_FILES+=(tests/empty-restore-target.test.ts)
  UNIT_FILES+=(tests/operations-empty-restore.test.ts)
  UNIT_FILES+=(tests/empty-restore-absence.test.ts tests/empty-restore-source-image.test.ts tests/empty-restore-orphan.test.ts)
  UNIT_FILES+=(tests/systemd-contract.test.ts tests/operations-scheduled-job.test.ts tests/maintenance-pool.test.ts tests/restore-command.test.ts)
  UNIT_FILES+=(tests/operations-health-host.test.ts)
  UNIT_FILES+=(tests/health-collector.test.ts tests/health-main.test.ts tests/admin-operations.test.ts)
  UNIT_FILES+=(tests/n8n-client.test.ts tests/notification-worker.test.ts tests/notification-runtime.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-health-role.test.ts tests/integration/postgres-admin-operations.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-notification-flow.test.ts tests/integration/postgres-notification-work.test.ts tests/integration/postgres-notification-privacy-grants.test.ts tests/integration/postgres-maintenance-pool.test.ts)
  UNIT_FILES+=(tests/operations-scripts.test.ts)
  UNIT_FILES+=(tests/restore-host.test.ts tests/restore-host-script.test.ts)
  UNIT_FILES+=(tests/admin-socket-recovery.test.ts)
  UNIT_FILES+=(tests/admin-socket-recovery-script.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-runtime-grants.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-bootstrap-grants.test.ts)
  UNIT_FILES+=(tests/bootstrap-command.test.ts)
  UNIT_FILES+=(tests/postgres-runtime-grants.test.ts)
  UNIT_FILES+=(tests/phase6-compose-contract.test.ts)
  UNIT_FILES+=(tests/database-identity-script.test.ts)
  UNIT_FILES+=(tests/operations-job-state.test.ts)
  UNIT_FILES+=(tests/operations-job-lifecycle.test.ts)
  UNIT_FILES+=(tests/operations-bootstrap-script.test.ts)
  UNIT_FILES+=(tests/operations-deployment-state.test.ts)
  UNIT_FILES+=(tests/operations-drain-script.test.ts)
  UNIT_FILES+=(tests/operations-adoption-script.test.ts)
  UNIT_FILES+=(tests/operations-postgres-converge.test.ts)
  UNIT_FILES+=(tests/operations-compose-environment.test.ts)
  UNIT_FILES+=(tests/operations-startup-script.test.ts)
  UNIT_FILES+=(tests/operations-containment.test.ts)
  UNIT_FILES+=(tests/operation-reference.test.ts)
  UNIT_FILES+=(tests/operation-settlement.test.ts)
  UNIT_FILES+=(tests/operations-orphan-containment.test.ts)
  UNIT_FILES+=(tests/operations-initial-intent.test.ts)
  UNIT_FILES+=(tests/operations-first-boot.test.ts)
  UNIT_FILES+=(tests/operations-controller.test.ts)
  UNIT_FILES+=(tests/operations-live-socket-preflight.test.ts)
  UNIT_FILES+=(tests/operations-restore-controller.test.ts tests/operations-promotion-controller.test.ts)
  UNIT_FILES+=(tests/restore-job-split.test.ts tests/restore-metadata-script.test.ts tests/promotion-host-transport.test.ts)
  UNIT_FILES+=(tests/promotion-host.test.ts tests/promotion-host-script.test.ts tests/restore-compose-split.test.ts)
  UNIT_FILES+=(tests/restore-entrypoints.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-operation-settlement.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-deployment-cli.test.ts tests/integration/postgres-forward-migration.test.ts)
fi
if [[ "$MODE" == settlement ]]; then
  UNIT_FILES=(tests/operation-settlement.test.ts tests/bootstrap-command.test.ts)
  INTEGRATION_FILES=(tests/integration/postgres-operation-settlement.test.ts)
fi
if [[ "$MODE" == restore ]]; then
  UNIT_FILES+=(tests/empty-restore-target.test.ts)
  UNIT_FILES+=(tests/maintenance-pool.test.ts tests/restore-command.test.ts)
  UNIT_FILES+=(tests/promotion-command.test.ts tests/promotion-handshake.test.ts tests/restore-metadata.test.ts tests/operations-restore-state.test.ts)
  UNIT_FILES+=(tests/restore-split-command.test.ts tests/restore-migrate-command.test.ts tests/restore-compose-split.test.ts)
  INTEGRATION_FILES=(tests/integration/postgres-isolated-restore.test.ts tests/integration/postgres-maintenance-pool.test.ts)
fi
if [[ "$MODE" == state ]]; then
  UNIT_FILES=(tests/operations-job-state.test.ts tests/operations-job-lifecycle.test.ts tests/operations-scripts.test.ts tests/operations-bootstrap-script.test.ts tests/operations-deployment-state.test.ts tests/operations-drain-script.test.ts tests/operations-adoption-script.test.ts tests/operations-postgres-converge.test.ts tests/operations-compose-environment.test.ts tests/operations-startup-script.test.ts tests/operations-containment.test.ts tests/operations-orphan-containment.test.ts tests/operations-initial-intent.test.ts tests/operations-first-boot.test.ts tests/systemd-contract.test.ts tests/operations-scheduled-job.test.ts)
  INTEGRATION_FILES=()
  # Focused native filesystem iteration, restricted to the fixed state suite.
  UNIT_FILES+=(tests/operations-health-host.test.ts)
  UNIT_FILES+=(tests/operations-restore-state.test.ts)
  UNIT_FILES+=(tests/empty-restore-target.test.ts)
  UNIT_FILES+=(tests/operations-empty-restore.test.ts)
  UNIT_FILES+=(tests/empty-restore-absence.test.ts tests/empty-restore-source-image.test.ts tests/empty-restore-orphan.test.ts)
  UNIT_FILES+=(tests/operations-live-socket-preflight.test.ts)
  UNIT_FILES+=(tests/operations-restore-controller.test.ts tests/operations-promotion-controller.test.ts)
  # The complete grants gate always runs its full unit/integration selection.
  UNIT_FILES+=(tests/promotion-host-script.test.ts)
  if [[ "$#" == 2 ]]; then
    selected=''
    for file in "${UNIT_FILES[@]}"; do [[ "$file" != "$2" ]] || selected="$file"; done
    [[ -n "$selected" ]] || { echo backup_test_mode_invalid >&2; exit 1; }
    UNIT_FILES=("$selected")
  fi
fi
if [[ "$MODE" == unit ]]; then UNIT_FILES=(); INTEGRATION_FILES=(); fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
REVISION="$(git -C "$NATIVE_ROOT" rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
SCOPE="fcd-support-backup-test-$$-$RANDOM"
OPS="$SCOPE-operations:$REVISION"
APP="$SCOPE-application:$REVISION"
RUNNER="$SCOPE-runner:$REVISION"
VOLUME="$SCOPE-backups"
RESTORE_NETWORK="$SCOPE-restore"
RESTORE_VOLUME="$SCOPE-postgres"
cleanup() {
  for container in "$SCOPE-unit" "$SCOPE-integration" "$SCOPE-postgres"; do
    if [[ "$(docker inspect --format '{{index .Config.Labels "fcd-support.backup-test"}}' "$container" 2>/dev/null || true)" == "$SCOPE" ]]; then
      docker rm --force --volumes "$container" >/dev/null 2>&1 || true
    fi
  done
  if [[ "$(docker volume inspect --format '{{index .Labels "fcd-support.backup-test"}}' "$VOLUME" 2>/dev/null || true)" == "$SCOPE" ]]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
  if [[ "$(docker volume inspect --format '{{index .Labels "fcd-support.backup-test"}}' "$RESTORE_VOLUME" 2>/dev/null || true)" == "$SCOPE" ]]; then
    docker volume rm "$RESTORE_VOLUME" >/dev/null 2>&1 || true
  fi
  if [[ "$(docker network inspect --format '{{index .Labels "fcd-support.backup-test"}}' "$RESTORE_NETWORK" 2>/dev/null || true)" == "$SCOPE" ]]; then
    docker network rm "$RESTORE_NETWORK" >/dev/null 2>&1 || true
  fi
  for image in "$RUNNER" "$OPS" "$APP"; do
    if [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true)" == "$REVISION" ]]; then
      docker image rm "$image" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT
if [[ "$MODE" != state && "$MODE" != unit ]]; then
docker compose --file "$NATIVE_ROOT/infra/compose.test.yml" --project-name "$TEST_PROJECT" up --detach --wait postgres >/dev/null
# This is the repository's isolated trust-auth synthetic DB, never a server network.
[[ "$(docker network inspect --format '{{.Internal}}' "$TEST_NETWORK")" == true ]]
[[ "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$TEST_NETWORK")" == "$TEST_PROJECT" ]]
for container in $(docker network inspect --format '{{range $id, $member := .Containers}}{{$id}} {{end}}' "$TEST_NETWORK"); do
  [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' "$container")" == "$TEST_PROJECT/postgres" ]] || { echo backup_test_network_participant_invalid >&2; exit 1; }
done
fi
docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --file "$NATIVE_ROOT/infra/Dockerfile.operations" --tag "$OPS" "$NATIVE_ROOT" >/dev/null 2>&1 || { echo backup_operations_build_failed >&2; exit 1; }
bash "$ROOT/scripts/test-operations-image-mounts.sh" "$OPS"
if [[ "$MODE" == restore ]]; then bash "$ROOT/scripts/test-restore-alias-docker.sh"; fi
docker build --platform linux/amd64 --file "$NATIVE_ROOT/infra/Dockerfile.integration" --tag fcd-support-integration-test:local "$NATIVE_ROOT" >/dev/null 2>&1 || { echo backup_dependencies_build_failed >&2; exit 1; }
docker build --platform linux/amd64 --build-arg "OPERATIONS_IMAGE=$OPS" --file "$NATIVE_ROOT/infra/Dockerfile.backup-test" --tag "$RUNNER" "$NATIVE_ROOT" >/dev/null 2>&1 || { echo backup_runner_build_failed >&2; exit 1; }
docker volume create --label "fcd-support.backup-test=$SCOPE" "$VOLUME" >/dev/null
if [[ "$MODE" == restore ]]; then
  docker network create --internal --label "fcd-support.backup-test=$SCOPE" "$RESTORE_NETWORK" >/dev/null
  docker volume create --label "fcd-support.backup-test=$SCOPE" "$RESTORE_VOLUME" >/dev/null
  docker run --detach --name "$SCOPE-postgres" --label "fcd-support.backup-test=$SCOPE" \
    --network "$RESTORE_NETWORK" --network-alias restore-postgres --network-alias fcd-support-restore-postgres --security-opt no-new-privileges \
    --cpus 1 --memory 1g --pids-limit 128 --mount "type=volume,src=$RESTORE_VOLUME,dst=/var/lib/postgresql" \
    --env POSTGRES_USER=fcd_support_test --env POSTGRES_DB=postgres --env POSTGRES_HOST_AUTH_METHOD=trust \
    --health-cmd 'pg_isready -U fcd_support_test -d postgres' --health-interval 1s --health-timeout 2s --health-retries 30 \
    postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636 >/dev/null
  for ((attempt=0; attempt<40; attempt++)); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$SCOPE-postgres")" == healthy ]] && break
    sleep 1
  done
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$SCOPE-postgres")" == healthy ]] || { echo restore_test_database_unhealthy >&2; exit 1; }
fi
run_tests() {
local job="$1"; shift
local launch=(run --rm) network="$TEST_NETWORK"
local -a extra_mounts=() extra_environment=()
local temporary_mount=/tmp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m
if [[ "$MODE" == state || "$MODE" == unit ]]; then network=none; fi
if [[ "$MODE" == unit ]]; then
  for path in docs .github AGENTS.md SECURITY.md README.md Dockerfile Dockerfile.cloudflared .dockerignore .node-version; do
    [[ -e "$ROOT/$path" && ! -L "$ROOT/$path" ]] || { echo backup_test_source_invalid >&2; return 1; }
    extra_mounts+=(--mount "type=bind,src=$NATIVE_ROOT/$path,dst=/workspace/$path,readonly")
  done
  # Some portable tests execute authored fake CLIs. Only this networkless test
  # container gets executable memory-backed scratch; deployed mounts stay noexec.
  temporary_mount=/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m
  extra_environment+=(--env TMPDIR=/tmp)
fi
if [[ "$MODE" == restore && "$job" == integration ]]; then launch=(create); fi
docker "${launch[@]}" --name "$SCOPE-$job" --label "fcd-support.backup-test=$SCOPE" --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 1 --memory 1g --pids-limit 128 \
  --tmpfs /run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=64m \
  --tmpfs "$temporary_mount" \
  --tmpfs /workspace/node_modules/.vite-temp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m \
  --mount "type=volume,src=$VOLUME,dst=/var/lib/fcd-support/backups" \
  --mount "type=bind,src=$NATIVE_ROOT/src,dst=/workspace/src,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/scripts,dst=/workspace/scripts,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/infra,dst=/workspace/infra,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tests,dst=/workspace/tests,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/migrations,dst=/workspace/migrations,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tsconfig.json,dst=/workspace/tsconfig.json,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/vitest.config.ts,dst=/workspace/vitest.config.ts,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/vitest.integration.config.ts,dst=/workspace/vitest.integration.config.ts,readonly" \
  "${extra_mounts[@]}" \
  --env NODE_ENV=test --env ALLOW_DESTRUCTIVE_DATABASE_TESTS=fcd-support-test-only \
  --env TEST_DATABASE_URL=postgresql://fcd_support_test@postgres:5432/fcd_support_test \
  --env "RUN_ENCRYPTED_BACKUP_TESTS=$([[ "$MODE" != unit ]] && echo synthetic-operations-toolchain-only || true)" \
  --env "RUN_ISOLATED_RESTORE_TESTS=$([[ "$MODE" == restore ]] && echo synthetic-isolated-cluster-only || true)" \
  --env RESTORE_TEST_DATABASE_URL=postgresql://fcd_support_test@restore-postgres:5432/postgres \
  --env BACKUP_TEST_ARCHIVE_ROOT=/var/lib/fcd-support/backups \
  "${extra_environment[@]}" \
  "$RUNNER" "$@"
if [[ "$MODE" == restore && "$job" == integration ]]; then
  docker network connect "$RESTORE_NETWORK" "$SCOPE-$job"
  docker start --attach "$SCOPE-$job"
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$SCOPE-$job")" == 0 ]]
fi
}
run_tests unit run "${UNIT_FILES[@]}"
if (( ${#INTEGRATION_FILES[@]} > 0 )); then run_tests integration run --config vitest.integration.config.ts "${INTEGRATION_FILES[@]}"; fi
if [[ "$MODE" == grants || ( "$MODE" == state && ( "$#" == 1 || "${2:-}" == tests/operations-empty-restore.test.ts || "${2:-}" == tests/empty-restore-target.test.ts ) ) ]]; then
  docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --file "$NATIVE_ROOT/Dockerfile" --tag "$APP" "$NATIVE_ROOT" >/dev/null 2>&1 || { echo empty_target_application_build_failed >&2; exit 1; }
  bash "$ROOT/scripts/test-empty-target-docker.sh" "$APP" "$REVISION"
  bash "$ROOT/scripts/test-synthetic-cleanup.sh" "$OPS" "$REVISION"
fi
if [[ "$MODE" == state ]]; then echo operations_state_local=true; elif [[ "$MODE" == unit ]]; then echo operations_unit_local=true; else echo encrypted_backup_local=true; fi
