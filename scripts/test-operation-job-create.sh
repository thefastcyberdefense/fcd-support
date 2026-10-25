#!/usr/bin/env bash
# Actual local Docker creation proof. No job is started and no secret is read.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || exit 1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
source scripts/operations-common.sh
source scripts/operations-job-lifecycle.sh
REVISION="$(git rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
SCOPE="fcd-support-phase6-test-job-create-$$-$RANDOM"
FIXTURE="$ROOT/.superpowers/sdd/2026-10-04-phase-6-hardened-local-operations/$SCOPE"
[[ ! -e "$FIXTURE" && ! -L "$FIXTURE" ]] || exit 1
NATIVE_ROOT="$ROOT"; NATIVE_FIXTURE="$FIXTURE"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; NATIVE_FIXTURE="$(cygpath -m "$FIXTURE")"; fi
IMAGE="$SCOPE-operations:$REVISION"; NETWORK="$SCOPE-operations-data"; VOLUME="$SCOPE-backups"
cleanup() {
  local id label
  for id in $(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_JOB_PROJECT:-missing}"); do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    label="$(docker container inspect --format '{{index .Config.Labels "fcd-support.operation.parent"}}/{{.State.Status}}/{{.State.StartedAt}}' "$id")" || return 1
    [[ "$label" == "$SCOPE/created/0001-01-01T00:00:00Z" ]] || return 1
    docker container rm "$id" >/dev/null || return 1
  done
  if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    [[ "$(docker volume inspect --format '{{index .Labels "fcd-support.job-create-test"}}' "$VOLUME")" == "$SCOPE" ]] || return 1
    docker volume rm "$VOLUME" >/dev/null || return 1
  fi
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    [[ "$(docker network inspect --format '{{index .Labels "fcd-support.job-create-test"}}/{{len .Containers}}' "$NETWORK")" == "$SCOPE/0" ]] || return 1
    docker network rm "$NETWORK" >/dev/null || return 1
  fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    [[ "$(docker image inspect --format '{{index .Config.Labels "fcd-support.job-create-test"}}' "$IMAGE")" == "$SCOPE" ]] || return 1
    docker image rm "$IMAGE" >/dev/null || return 1
  fi
  [[ -d "$FIXTURE" && ! -L "$FIXTURE" && "$(realpath -- "$FIXTURE")" == "$ROOT/.superpowers/sdd/2026-10-04-phase-6-hardened-local-operations/$SCOPE" ]] || return 1
  rm -r -- "$FIXTURE"
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
node "$NATIVE_ROOT/tests/helpers/phase6-network-fixture.ts" "$NATIVE_FIXTURE" "$SCOPE" "$REVISION"
docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --label "fcd-support.job-create-test=$SCOPE" --file infra/Dockerfile.operations --tag "$IMAGE" . >/dev/null 2>&1
docker network create --internal --label "fcd-support.job-create-test=$SCOPE" "$NETWORK" >/dev/null
OPS_DOCKER_ENDPOINT="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"
[[ "$OPS_DOCKER_ENDPOINT" == unix:///* || "$OPS_DOCKER_ENDPOINT" == npipe:////./pipe/dockerDesktopLinuxEngine ]] || exit 1
export DOCKER_HOST="$OPS_DOCKER_ENDPOINT"
# Git Bash's sanitized child loses Windows plugin discovery. A test-owned CLI
# config supplies only the installed Compose plugin directory, never auth data.
if command -v cygpath >/dev/null 2>&1; then
  real_docker="$(command -v docker)"
  plugin="$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}')"
  [[ -n "$plugin" ]] || exit 1
  plugin="$(cygpath -m "$plugin")"
  mkdir -- "$FIXTURE/bin" "$FIXTURE/docker-config"
  node --input-type=module -e 'import fs from "node:fs";import path from "node:path";fs.writeFileSync(process.argv[1],JSON.stringify({cliPluginsExtraDirs:[path.dirname(process.argv[2])]}),{mode:0o600});' "$NATIVE_FIXTURE/docker-config/config.json" "$plugin"
  : > "$FIXTURE/empty.env"
  printf '#!/usr/bin/env bash\nexport MSYS_NO_PATHCONV=1\nargs=("$@"); for ((i=0;i<${#args[@]}-1;i++)); do if [[ "${args[$i]}" == --env-file && "${args[$((i+1))]}" == /dev/null ]]; then args[$((i+1))]=%q; fi; done\nexec %q --config %q "${args[@]}"\n' "$NATIVE_FIXTURE/empty.env" "$real_docker" "$NATIVE_FIXTURE/docker-config" > "$FIXTURE/bin/docker"
  chmod 700 -- "$FIXTURE/bin/docker"
  export PATH="$FIXTURE/bin:$PATH"
fi
declare -A OPS_CONFIG=()
# This file was just authored by the fixed synthetic fixture generator. It is
# parsed as literal values; neither it nor real host configuration is sourced.
while IFS='=' read -r key value; do [[ "$key" != FCD_* ]] || OPS_CONFIG["$key"]="$value"; done < "$FIXTURE/fixture.env"
OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]=30
[[ "$(operations_docker info --format '{{.OSType}}')" == linux ]] || exit 1
OPS_ROOT="$NATIVE_ROOT"; OPS_JOB_SERVICE=backup
runtime_model="$(operations_compose runtime --profile '*' config --format json)" || { echo operation_private_compose_render_failed >&2; exit 1; }
printf '%s' "$runtime_model" | node "$NATIVE_ROOT/dist/operations/compose-contract-main.js" runtime "$REVISION" \
  "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}" "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" "$NATIVE_ROOT" >/dev/null
unset runtime_model
echo operation_private_compose_render_verified=true
token="$(od -An -N16 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
[[ "$token" =~ ^[a-f0-9]{32}$ ]] || exit 1
OPS_JOB_PROJECT="fcd-support-operation-$token"; OPS_JOB_REFERENCE="operation_$token"
OPS_JOB_IMAGE="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
OPS_JOB_COMMAND_JSON='["node","dist/operations-main.js","pre-migration-backup","2030-04-01T00:00:00.000Z"]'
hash="$(printf '%s' "$OPS_JOB_COMMAND_JSON" | sha256sum)"; OPS_JOB_COMMAND_HASH="${hash%% *}"
declare -A OPS_JOB_TARGET=([OPS_DATABASE_SYSTEM_IDENTIFIER]=1111111111111111111 [OPS_DATABASE_NAME]=fcd_support_test [OPS_DATABASE_SCHEMA]=public [OPS_DATABASE_ROLE_PREFIX]=fcd_support [OPS_SCHEMA_REVISION]=000016)
OPS_JOB_OVERRIDE="$NATIVE_FIXTURE/job.json"
operations_job_override > "$FIXTURE/job.json"
if operations_job_create_stopped; then echo operation_job_missing_volume_accepted >&2; exit 1; fi
[[ -z "$(operations_job_discover)" ]] || exit 1
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then exit 1; fi
echo operation_job_missing_volume_refused=true
docker volume create --label "fcd-support.job-create-test=$SCOPE" "$VOLUME" >/dev/null
external_labels="$(docker volume inspect --format '{{json (index .Labels "com.docker.compose.project")}}/{{json (index .Labels "com.docker.compose.volume")}}' "$VOLUME")"
[[ "$external_labels" == '""/""' || "$external_labels" == null/null ]] || exit 1
echo operation_job_external_label_projection=true
if ! operations_job_create_stopped; then
  echo operation_job_create_failed >&2; exit 1
fi
echo operation_job_create_returned=true
OPS_JOB_CONTAINER="$(operations_job_discover)"
[[ "$OPS_JOB_CONTAINER" =~ ^[a-f0-9]{64}$ ]] || { echo operation_job_discovery_failed >&2; exit 1; }
if ! operations_job_assert_container created; then
  actual="$(operations_docker container inspect --format "$OPERATIONS_JOB_IDENTITY_FORMAT" "$OPS_JOB_CONTAINER")"
  expected="$OPS_JOB_CONTAINER/$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/$OPS_JOB_REFERENCE/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/$OPS_JOB_SERVICE/$OPS_JOB_COMMAND_HASH/created/false/false/false/$OPS_JOB_PROJECT/$OPS_JOB_SERVICE"
  IFS=/ read -r -a actual_fields <<< "$actual"; IFS=/ read -r -a expected_fields <<< "$expected"
  for ((i=0;i<${#expected_fields[@]};i++)); do [[ "${actual_fields[$i]:-missing}" == "${expected_fields[$i]}" ]] || printf 'operation_job_identity_field_%s_mismatch\n' "$i" >&2; done
  [[ "$(operations_docker container inspect --format '{{json .Config.Cmd}}' "$OPS_JOB_CONTAINER")" == "$OPS_JOB_COMMAND_JSON" ]] || echo operation_job_command_mismatch >&2
  exit 1
fi
[[ "$(docker container inspect --format '{{.State.StartedAt}}/{{.HostConfig.ReadonlyRootfs}}/{{.HostConfig.Privileged}}/{{.Config.User}}/{{.HostConfig.RestartPolicy.Name}}/{{len .HostConfig.PortBindings}}' "$OPS_JOB_CONTAINER")" == 0001-01-01T00:00:00Z/true/false/node/no/0 ]] || exit 1
echo operation_job_stopped_identity_verified=true
[[ "$(docker container inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "OPS_OPERATION_REFERENCE"}}{{println .}}{{end}}{{end}}' "$OPS_JOB_CONTAINER")" == "OPS_OPERATION_REFERENCE=$OPS_JOB_REFERENCE" ]] || exit 1
echo operation_job_backend_reference_configured=true
[[ "$(docker container inspect --format '{{json .HostConfig.Binds}}' "$OPS_JOB_CONTAINER")" == "[\"$VOLUME:/var/lib/fcd-support/backups:rw\"]" ]] || { echo operation_job_archive_configuration_failed >&2; exit 1; }
echo operation_job_external_archive_configured=true
[[ "$(docker container inspect --format '{{.HostConfig.NetworkMode}}' "$OPS_JOB_CONTAINER")" == "$NETWORK" ]] || { echo operation_job_network_configuration_failed >&2; exit 1; }
echo operation_job_private_network_configured=true
source "$ROOT/scripts/operations-drain.sh"
# The actual upstream admission image omits Config.Labels and Config.User.
# These projections must handle both without starting a container.
upstream='postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636'
[[ "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$upstream")" == 'sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636/none/linux/amd64/none' ]]
[[ "$(operations_docker image inspect --format '{{json (index .Config "Entrypoint")}}' "$upstream")" == '["docker-entrypoint.sh"]' ]]
echo operation_drain_upstream_projections=2
echo operation_job_never_started=true
