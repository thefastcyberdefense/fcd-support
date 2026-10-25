#!/usr/bin/env bash
# Local synthetic metadata proof only. No PostgreSQL server or DB is started.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || exit 1
endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"
[[ "$endpoint" == unix:///* || "$endpoint" == npipe:////./pipe/dockerDesktopLinuxEngine ]] || exit 1
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST="$endpoint"
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || exit 1
scope="fcd-support-pg-seed-test-$$-$RANDOM"
volume="$scope-data"
cleanup() {
  local id label
  id="$(docker ps --all --quiet --no-trunc --filter "name=^/$scope$" --filter "label=fcd-support.pg-seed-test=$scope")" || return 1
  if [[ -n "$id" ]]; then
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    docker rm --force "$id" >/dev/null || return 1
  fi
  label="$(docker volume inspect --format '{{index .Labels "fcd-support.pg-seed-test"}}' "$volume" 2>/dev/null || true)"
  if [[ -n "$label" ]]; then
    [[ "$label" == "$scope" ]] || return 1
    docker volume rm "$volume" >/dev/null || return 1
  fi
  [[ -z "$(docker ps --all --quiet --filter "label=fcd-support.pg-seed-test=$scope")" && -z "$(docker volume ls --quiet --filter "label=fcd-support.pg-seed-test=$scope")" ]]
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
docker volume create --label "fcd-support.pg-seed-test=$scope" "$volume" >/dev/null
[[ "$(docker volume inspect --format '{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{index .Labels "fcd-support.pg-seed-test"}}' "$volume")" == "local/local/default/$scope" ]]
permissions="$(docker run --rm --pull never --name "$scope" --label "fcd-support.pg-seed-test=$scope" \
  --network none --read-only --user 999:999 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 0.5 --memory 128m --pids-limit 32 \
  --mount "type=volume,src=$volume,dst=/var/lib/postgresql" --entrypoint stat \
  postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636 \
  -c '%u:%g:%a' /var/lib/postgresql)"
[[ "$permissions" == 999:999:1777 ]]
printf '%s\n' postgres_upstream_seed_mode=1777 postgres_hardened_required_mode=700 postgres_seed_database_started=false
