#!/usr/bin/env bash
# Actual Docker template proof against a fresh, never-started synthetic actor.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || { printf 'docker_projection_arguments_invalid\n' >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/scripts/operations-runtime-host.sh"
source "$root/scripts/operations-restore-host.sh"
source "$root/scripts/operations-common.sh"
source "$root/scripts/operations-job-lifecycle.sh"
scope="fcd-support-projection-test-$$-$RANDOM"
fixture=''
projection_volume=''
native_root="$root"
if command -v cygpath >/dev/null 2>&1; then native_root="$(cygpath -m "$root")"; fi
revision="$(git -C "$native_root" rev-parse HEAD)"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
cleanup() {
  local actor
  actor="$(docker ps --all --quiet --no-trunc --filter "label=fcd-support.projection-test=$scope")" || return 1
  if [[ -n "$actor" ]]; then
    [[ "$actor" =~ ^[a-f0-9]{64}$ && "$(docker container inspect --format '{{index .Config.Labels "fcd-support.projection-test"}}/{{.State.Status}}' "$actor")" == "$scope/created" ]] || return 1
    docker rm "$actor" >/dev/null
  fi
  if [[ -n "$projection_volume" ]]; then
    [[ "$(docker volume inspect --format '{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{index .Labels "fcd-support.projection-test"}}' "$projection_volume")" == "local/local/default/$scope" && -z "$(docker ps --all --quiet --filter "volume=$projection_volume")" ]] || return 1
    docker volume rm "$projection_volume" >/dev/null || return 1
    projection_volume=''
  fi
  if [[ -n "$fixture" ]]; then
    [[ -d "$fixture" && ! -L "$fixture" && "$(realpath -e "$fixture")" == "$fixture" ]] || return 1
    for file in "$fixture/infra/compose.operations.yml" "$fixture/override.json"; do
      [[ ! -e "$file" ]] || { [[ -f "$file" && ! -L "$file" ]] && rm -- "$file"; }
    done
    [[ ! -d "$fixture/infra" ]] || rmdir -- "$fixture/infra"
    rmdir -- "$fixture"
  fi
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
docker create --name "$scope" --label "fcd-support.projection-test=$scope" \
  --label com.docker.compose.project=fcd-support-projection-synthetic \
  --label com.docker.compose.service=postgres --label "org.opencontainers.image.revision=$revision" \
  --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 0.25 --memory 128m --pids-limit 32 \
  --mount "type=bind,src=$native_root/package.json,dst=/synthetic-public-metadata,readonly" \
  node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d >/dev/null
for kind in runtime restore; do
  case "$kind" in runtime) format="$OPERATIONS_RUNTIME_CONTAINER_FORMAT" ;; restore) format="$OPERATIONS_RESTORE_CONTAINER_FORMAT" ;; esac
  docker container inspect --format "$format" "$scope" | \
    node --input-type=module -e 'let text="";for await(const b of process.stdin)text+=b;const p=JSON.parse(text);if(p.healthy!==false||p.running!==false||p.mounts.length!==1||p.mounts[0].type!=="bind"||p.mounts[0].name!==""||p.mounts[0].readWrite!==false||p.hostPortBindings!==0)process.exit(1)'
  printf 'docker_%s_projection_passed=true\n' "$kind"
done
cleanup
projection_volume="$scope-data"
[[ -z "$(docker volume ls --quiet --filter "name=^$projection_volume$")" ]]
docker volume create --label "fcd-support.projection-test=$scope" "$projection_volume" >/dev/null
docker create --name "$scope" --label "fcd-support.projection-test=$scope" \
  --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 0.25 --memory 128m --pids-limit 32 \
  --mount "type=volume,src=$projection_volume,dst=/var/lib/postgresql" \
  node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d >/dev/null
for kind in drain adoption; do
  format="$(node --input-type=module -e 'import {readFile} from "node:fs/promises";const s=await readFile(process.argv[1],"utf8");const m=/'\''([^'\'']*\.Name \.Destination \.RW[^'\'']*)'\''/u.exec(s);if(!m)process.exit(1);console.log(m[1])' "$native_root/scripts/operations-$kind.sh")"
  [[ "$(docker container inspect --format "$format" "$scope")" == "$projection_volume /var/lib/postgresql true" ]] || { printf 'docker_%s_mount_projection_failed\n' "$kind" >&2; exit 1; }
  printf 'docker_%s_mount_projection_passed=true\n' "$kind"
done
cleanup
if [[ "$(uname -s)" != Linux ]]; then
  printf 'docker_single_job_create_skipped=linux-only\n'
  exit 0
fi
fixture="$(mktemp -d "${TMPDIR:-/tmp}/fcd-support-projection.XXXXXXXX")"
fixture="$(cd "$fixture" && pwd -P)"
mkdir "$fixture/infra"
cat >"$fixture/infra/compose.operations.yml" <<MODEL
services:
  bootstrap:
    image: node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
    profiles: [operations-bootstrap]
    user: '1000:1000'
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    network_mode: none
    cpus: 0.25
    mem_limit: 128m
    pids_limit: 32
    labels:
      fcd-support.projection-test: $scope
    command: [node, -e, 'process.exit(0)']
MODEL
printf '{}\n' >"$fixture/override.json"
native_fixture="$fixture"
if command -v cygpath >/dev/null 2>&1; then native_fixture="$(cygpath -m "$fixture")"; fi
OPS_ROOT="$native_fixture"
OPS_JOB_OVERRIDE="$native_fixture/override.json"
OPS_JOB_PROJECT="$scope-job"
OPS_JOB_SERVICE=bootstrap
OPS_DOCKER_ENDPOINT="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"
[[ "$OPS_DOCKER_ENDPOINT" == unix:///* ]]
declare -A OPS_CONFIG=([FCD_COMMAND_TIMEOUT_SECONDS]=15 [FCD_STOP_GRACE_MS]=1000)
operations_job_create_stopped || { printf 'docker_job_create_failed\n' >&2; exit 1; }
actor="$(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$OPS_JOB_PROJECT")"
[[ "$actor" =~ ^[a-f0-9]{64}$ && "$(docker container inspect --format '{{.State.Status}}/{{.State.Running}}/{{.Config.User}}/{{.HostConfig.ReadonlyRootfs}}/{{.HostConfig.Privileged}}/{{len .HostConfig.PortBindings}}/{{.HostConfig.NetworkMode}}' "$actor")" == created/false/1000:1000/true/false/0/none ]]
printf 'docker_single_job_create_passed=true\n'
