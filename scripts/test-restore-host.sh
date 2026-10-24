#!/usr/bin/env bash
# Actual Docker projections on freshly labelled synthetic resources only.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || { echo restore_host_test_arguments_invalid >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
REVISION="$(git -C "$NATIVE_ROOT" rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
SCOPE="fcd-support-restore-host-test-$$-$RANDOM"
PROJECT="fcd-support-restore-synthetic-$$-$RANDOM"
NETWORK="$PROJECT-data"
EXTRA_NETWORK="$PROJECT-extra"
VOLUME="$PROJECT-postgres"
LIVE_VOLUME="$SCOPE-live"
POSTGRES="$SCOPE-postgres"
FOREIGN="$SCOPE-foreign"
STOPPED="$SCOPE-stopped"
OPS="$SCOPE-operations:$REVISION"
RUNTIME="$SCOPE-runtime:$REVISION"
PG_IMAGE="$SCOPE-postgres:$REVISION"
cleanup() {
  for container in "$POSTGRES" "$FOREIGN" "$STOPPED"; do
    if [[ "$(docker inspect --format '{{index .Config.Labels "fcd-support.restore-host-test"}}' "$container" 2>/dev/null || true)" == "$SCOPE" ]]; then
      docker rm --force "$container" >/dev/null 2>&1 || true
    fi
  done
  for network in "$NETWORK" "$EXTRA_NETWORK"; do
    if [[ "$(docker network inspect --format '{{index .Labels "fcd-support.restore-host-test"}}' "$network" 2>/dev/null || true)" == "$SCOPE" ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  done
  for volume in "$VOLUME" "$LIVE_VOLUME"; do
    if [[ "$(docker volume inspect --format '{{index .Labels "fcd-support.restore-host-test"}}' "$volume" 2>/dev/null || true)" == "$SCOPE" ]]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
  done
  for image in "$OPS" "$RUNTIME" "$PG_IMAGE"; do
    if [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true)" == "$REVISION" ]]; then docker image rm "$image" >/dev/null 2>&1 || true; fi
  done
}
trap cleanup EXIT
for kind in operations runtime postgres; do
  case "$kind" in operations) file=infra/Dockerfile.operations; tag="$OPS";; runtime) file=Dockerfile; tag="$RUNTIME";; postgres) file=infra/Dockerfile.postgres; tag="$PG_IMAGE";; esac
  docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --file "$NATIVE_ROOT/$file" --tag "$tag" "$NATIVE_ROOT" >/dev/null 2>&1 || { echo restore_host_test_build_failed >&2; exit 1; }
done
create_network() {
  docker network create --internal --label "fcd-support.restore-host-test=$SCOPE" --label "com.docker.compose.project=$PROJECT" --label com.docker.compose.network=restore_data "$NETWORK" >/dev/null
}
create_network
docker volume create --label "fcd-support.restore-host-test=$SCOPE" --label "com.docker.compose.project=$PROJECT" --label com.docker.compose.volume=restore-data "$VOLUME" >/dev/null
docker volume create --label "fcd-support.restore-host-test=$SCOPE" "$LIVE_VOLUME" >/dev/null
docker run --detach --name "$POSTGRES" --label "fcd-support.restore-host-test=$SCOPE" \
  --label "com.docker.compose.project=$PROJECT" --label com.docker.compose.service=postgres --label "org.opencontainers.image.revision=$REVISION" \
  --network "$NETWORK" --read-only --user 999:999 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 1 --memory 512m --pids-limit 128 --mount "type=volume,src=$VOLUME,dst=/var/lib/postgresql" \
  --tmpfs /var/run/postgresql:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=16m --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m \
  --env POSTGRES_USER=fcd_support_test --env POSTGRES_DB=postgres --env POSTGRES_HOST_AUTH_METHOD=trust --env PGDATA=/var/lib/postgresql/18/docker \
  --health-cmd 'pg_isready -U fcd_support_test -d postgres' --health-interval 1s --health-timeout 2s --health-retries 30 "$PG_IMAGE" >/dev/null
for ((attempt=0; attempt<40; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$POSTGRES")" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$POSTGRES")" == healthy ]] || { echo restore_host_test_database_unhealthy >&2; exit 1; }
source "$ROOT/scripts/operations-common.sh"
declare -A OPS_CONFIG=([FCD_RESTORE_PROJECT]="$PROJECT" [FCD_RESTORE_VOLUME]="$VOLUME" [FCD_POSTGRES_VOLUME]="$LIVE_VOLUME"
  [FCD_SUPPORT_REVISION]="$REVISION" [FCD_SUPPORT_IMAGE]="$RUNTIME" [FCD_OPERATIONS_IMAGE]="$OPS" [FCD_POSTGRES_IMAGE]="$PG_IMAGE"
  [FCD_RESTORE_CPUS]=1 [FCD_RESTORE_MEMORY_MIB]=256 [FCD_RESTORE_PIDS]=64)
# Test-owned transport uses the actual local development Docker CLI. Production
# endpoint/config/lock preflight is not being claimed on Windows by this harness.
operations_docker() { timeout --signal=TERM --kill-after=2s 30s docker "$@" 2>/dev/null; }
[[ -f "$ROOT/scripts/operations-restore-host.sh" ]] || { echo restore_host_collector_missing >&2; exit 1; }
source "$ROOT/scripts/operations-restore-host.sh"
projection="$(operations_restore_host_snapshot)"
if ! printf '%s' "$projection" | operations_docker run --rm --interactive --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 128m --pids-limit 32 --entrypoint node "$OPS" -e 'let text="";for await(const chunk of process.stdin)text+=chunk;try{JSON.parse(text)}catch{process.exitCode=1}'; then
  echo restore_host_test_projection_json_invalid >&2; exit 1
fi
echo restore_host_projection_valid=true
report="$(operations_inspect_restore_host)"
[[ "$report" == *"\"projectName\":\"$PROJECT\""* && "$report" == *"\"volumeName\":\"$VOLUME\""* ]] || exit 1
echo restore_host_initial_sample_valid=true
[[ "$(operations_inspect_restore_host "$report")" == "$report" ]] || exit 1
count=1
refused() {
  local output
  if output="$(operations_inspect_restore_host "$report" 2>&1)"; then echo restore_host_test_refusal_missing >&2; exit 1; fi
  [[ "$output" == restore_host_invalid ]] || { echo restore_host_test_diagnostics_invalid >&2; exit 1; }
  ((count+=1))
}
docker create --name "$STOPPED" --label "fcd-support.restore-host-test=$SCOPE" --network none --mount "type=volume,src=$VOLUME,dst=/var/lib/postgresql,readonly" --entrypoint node "$RUNTIME" -e 'process.exit(0)' >/dev/null
refused
docker rm "$STOPPED" >/dev/null
docker run --detach --name "$FOREIGN" --label "fcd-support.restore-host-test=$SCOPE" --network "$NETWORK" --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 64m --pids-limit 32 --entrypoint node "$RUNTIME" -e 'setInterval(()=>{},1000)' >/dev/null
refused
docker rm --force "$FOREIGN" >/dev/null
docker network create --internal --label "fcd-support.restore-host-test=$SCOPE" "$EXTRA_NETWORK" >/dev/null
docker network connect "$EXTRA_NETWORK" "$POSTGRES"
refused
docker network disconnect "$EXTRA_NETWORK" "$POSTGRES"
docker network rm "$EXTRA_NETWORK" >/dev/null
OPS_CONFIG[FCD_POSTGRES_VOLUME]="$VOLUME"
refused
OPS_CONFIG[FCD_POSTGRES_VOLUME]="$LIVE_VOLUME"
OPS_CONFIG[FCD_SUPPORT_IMAGE]="$OPS"
refused
OPS_CONFIG[FCD_SUPPORT_IMAGE]="$RUNTIME"
OPS_CONFIG[FCD_SUPPORT_REVISION]="$(printf 'f%.0s' {1..40})"
refused
OPS_CONFIG[FCD_SUPPORT_REVISION]="$REVISION"
docker network disconnect "$NETWORK" "$POSTGRES"
docker network rm "$NETWORK" >/dev/null
create_network
docker network connect "$NETWORK" "$POSTGRES"
refused
[[ "$(operations_inspect_restore_host)" != "$report" ]] || exit 1
printf 'restore_host_local=true;checks=%s\n' "$count"
