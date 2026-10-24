#!/usr/bin/env bash
# Pinned, synthetic, non-root local backup proof. Never attaches a live project.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
MODE="${1:-backup}"
[[ "$#" -le 1 && ( "$MODE" == backup || "$MODE" == checkpoint || "$MODE" == grants || "$MODE" == restore ) ]] || { echo backup_test_mode_invalid >&2; exit 1; }
UNIT_FILES=(tests/backup.test.ts tests/backup-retention.test.ts)
INTEGRATION_FILES=(tests/integration/postgres-encrypted-backup.test.ts)
if [[ "$MODE" == checkpoint || "$MODE" == grants ]]; then
  UNIT_FILES+=(tests/deletion-checkpoint.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-deletion-checkpoint.test.ts)
fi
if [[ "$MODE" == grants ]]; then
  UNIT_FILES+=(tests/operations-scripts.test.ts)
  UNIT_FILES+=(tests/restore-host.test.ts tests/restore-host-script.test.ts)
  UNIT_FILES+=(tests/admin-socket-recovery.test.ts)
  UNIT_FILES+=(tests/admin-socket-recovery-script.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-runtime-grants.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-bootstrap-grants.test.ts)
  UNIT_FILES+=(tests/bootstrap-command.test.ts)
  UNIT_FILES+=(tests/phase6-compose-contract.test.ts)
  UNIT_FILES+=(tests/database-identity-script.test.ts)
  INTEGRATION_FILES+=(tests/integration/postgres-deployment-cli.test.ts tests/integration/postgres-forward-migration.test.ts)
fi
if [[ "$MODE" == restore ]]; then
  INTEGRATION_FILES=(tests/integration/postgres-isolated-restore.test.ts)
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
REVISION="$(git -C "$NATIVE_ROOT" rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
SCOPE="fcd-support-backup-test-$$-$RANDOM"
OPS="$SCOPE-operations:$REVISION"
RUNNER="$SCOPE-runner:$REVISION"
VOLUME="$SCOPE-backups"
RESTORE_NETWORK="$SCOPE-restore"
RESTORE_VOLUME="$SCOPE-postgres"
cleanup() {
  for container in "$SCOPE-unit" "$SCOPE-integration" "$SCOPE-postgres"; do
    if [[ "$(docker inspect --format '{{index .Config.Labels "fcd-support.backup-test"}}' "$container" 2>/dev/null || true)" == "$SCOPE" ]]; then
      docker rm --force "$container" >/dev/null 2>&1 || true
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
  for image in "$RUNNER" "$OPS"; do
    if [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true)" == "$REVISION" ]]; then
      docker image rm "$image" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT
docker compose --file "$NATIVE_ROOT/infra/compose.test.yml" up --detach --wait postgres >/dev/null
# This is the repository's isolated trust-auth synthetic DB, never a server network.
[[ "$(docker network inspect --format '{{.Internal}}' fcd-support-test_data)" == true ]]
[[ "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' fcd-support-test_data)" == fcd-support-test ]]
for container in $(docker network inspect --format '{{range $id, $member := .Containers}}{{$id}} {{end}}' fcd-support-test_data); do
  [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' "$container")" == fcd-support-test/postgres ]] || { echo backup_test_network_participant_invalid >&2; exit 1; }
done
docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --file "$NATIVE_ROOT/infra/Dockerfile.operations" --tag "$OPS" "$NATIVE_ROOT" >/dev/null 2>&1 || { echo backup_operations_build_failed >&2; exit 1; }
docker build --platform linux/amd64 --build-arg "OPERATIONS_IMAGE=$OPS" --file "$NATIVE_ROOT/infra/Dockerfile.backup-test" --tag "$RUNNER" "$NATIVE_ROOT" >/dev/null 2>&1 || { echo backup_runner_build_failed >&2; exit 1; }
docker volume create --label "fcd-support.backup-test=$SCOPE" "$VOLUME" >/dev/null
if [[ "$MODE" == restore ]]; then
  docker network create --internal --label "fcd-support.backup-test=$SCOPE" "$RESTORE_NETWORK" >/dev/null
  docker volume create --label "fcd-support.backup-test=$SCOPE" "$RESTORE_VOLUME" >/dev/null
  docker run --detach --name "$SCOPE-postgres" --label "fcd-support.backup-test=$SCOPE" \
    --network "$RESTORE_NETWORK" --network-alias restore-postgres --security-opt no-new-privileges \
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
local launch=(run --rm)
if [[ "$MODE" == restore && "$job" == integration ]]; then launch=(create); fi
docker "${launch[@]}" --name "$SCOPE-$job" --label "fcd-support.backup-test=$SCOPE" --network fcd-support-test_data --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 1 --memory 1g --pids-limit 128 \
  --tmpfs /run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=64m \
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
  --env NODE_ENV=test --env ALLOW_DESTRUCTIVE_DATABASE_TESTS=fcd-support-test-only \
  --env TEST_DATABASE_URL=postgresql://fcd_support_test@postgres:5432/fcd_support_test \
  --env RUN_ENCRYPTED_BACKUP_TESTS=synthetic-operations-toolchain-only \
  --env "RUN_ISOLATED_RESTORE_TESTS=$([[ "$MODE" == restore ]] && echo synthetic-isolated-cluster-only || true)" \
  --env RESTORE_TEST_DATABASE_URL=postgresql://fcd_support_test@restore-postgres:5432/postgres \
  --env BACKUP_TEST_ARCHIVE_ROOT=/var/lib/fcd-support/backups \
  "$RUNNER" "$@"
if [[ "$MODE" == restore && "$job" == integration ]]; then
  docker network connect "$RESTORE_NETWORK" "$SCOPE-$job"
  docker start --attach "$SCOPE-$job"
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$SCOPE-$job")" == 0 ]]
fi
}
run_tests unit run "${UNIT_FILES[@]}"
run_tests integration run --config vitest.integration.config.ts "${INTEGRATION_FILES[@]}"
echo encrypted_backup_local=true
