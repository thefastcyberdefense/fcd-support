#!/usr/bin/env bash
# Pinned, synthetic, non-root local backup proof. Never attaches a live project.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
REVISION="$(git -C "$NATIVE_ROOT" rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
SCOPE="fcd-support-backup-test-$$-$RANDOM"
OPS="$SCOPE-operations:$REVISION"
RUNNER="$SCOPE-runner:$REVISION"
VOLUME="$SCOPE-backups"
cleanup() {
  for container in "$SCOPE-unit" "$SCOPE-integration"; do
    if [[ "$(docker inspect --format '{{index .Config.Labels "fcd-support.backup-test"}}' "$container" 2>/dev/null || true)" == "$SCOPE" ]]; then
      docker rm --force "$container" >/dev/null 2>&1 || true
    fi
  done
  if [[ "$(docker volume inspect --format '{{index .Labels "fcd-support.backup-test"}}' "$VOLUME" 2>/dev/null || true)" == "$SCOPE" ]]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
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
run_tests() {
local job="$1"; shift
docker run --rm --name "$SCOPE-$job" --label "fcd-support.backup-test=$SCOPE" --network fcd-support-test_data --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 1 --memory 1g --pids-limit 128 \
  --tmpfs /run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=64m \
  --tmpfs /workspace/node_modules/.vite-temp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m \
  --mount "type=volume,src=$VOLUME,dst=/var/lib/fcd-support/backups" \
  --mount "type=bind,src=$NATIVE_ROOT/src,dst=/workspace/src,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tests,dst=/workspace/tests,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/migrations,dst=/workspace/migrations,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tsconfig.json,dst=/workspace/tsconfig.json,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/vitest.config.ts,dst=/workspace/vitest.config.ts,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/vitest.integration.config.ts,dst=/workspace/vitest.integration.config.ts,readonly" \
  --env NODE_ENV=test --env ALLOW_DESTRUCTIVE_DATABASE_TESTS=fcd-support-test-only \
  --env TEST_DATABASE_URL=postgresql://fcd_support_test@postgres:5432/fcd_support_test \
  --env RUN_ENCRYPTED_BACKUP_TESTS=synthetic-operations-toolchain-only \
  --env BACKUP_TEST_ARCHIVE_ROOT=/var/lib/fcd-support/backups \
  "$RUNNER" "$@"
}
run_tests unit run tests/backup.test.ts tests/backup-retention.test.ts
run_tests integration run --config vitest.integration.config.ts tests/integration/postgres-encrypted-backup.test.ts
echo encrypted_backup_local=true
