#!/usr/bin/env bash
# Fresh, labelled Docker networks only; never touches an existing project.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 1 && "$1" =~ ^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+(@sha256:[a-f0-9]{64})?$ ]] || { echo synthetic_network_test_arguments_invalid >&2; exit 1; }
IMAGE="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/synthetic-host-networks.sh"
HEX="$(printf '%07x' "$(( ((RANDOM << 16) | RANDOM) & 0xfffffff ))")"
PROJECT="fcd-support-host-test-p6-$HEX"
FILE=''; NATIVE_FILE=''
cleanup() {
  local ids id row name members label
  ids="$(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$PROJECT")" || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ && "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' "$id")" == "$PROJECT/probe" ]] || return 1
    docker rm --force --volumes "$id" >/dev/null || return 1
  done <<<"$ids"
  ids="$(docker network ls --quiet --no-trunc --filter "label=fcd-support.synthetic-host-test=$PROJECT")" || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    row="$(docker network inspect --format '{{.Name}}/{{len .Containers}}/{{index .Labels "fcd-support.synthetic-host-test"}}' "$id")" || return 1
    IFS=/ read -r name members label <<<"$row"
    [[ "$label" == "$PROJECT" && "$members" == 0 && "$name" =~ ^${PROJECT}-(webhook-data|admin-data|reply-data|outbound-data|notification-data|operations-data|ingress|egress|extra)$ ]] || return 1
    docker network rm "$id" >/dev/null || return 1
  done <<<"$ids"
  if [[ -n "$FILE" && -e "$FILE" ]]; then [[ -f "$FILE" && ! -L "$FILE" ]] && rm -- "$FILE"; fi
}
[[ "$(docker image inspect --format '{{if .Config.Volumes}}yes{{else}}no{{end}}' "$IMAGE")" == no ]]
existing_containers="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT")"
existing_project_networks="$(docker network ls --quiet --filter "label=com.docker.compose.project=$PROJECT")"
existing_synthetic_networks="$(docker network ls --quiet --filter "label=fcd-support.synthetic-host-test=$PROJECT")"
[[ -z "$existing_containers" && -z "$existing_project_networks" && -z "$existing_synthetic_networks" ]]
for role in webhook-data admin-data reply-data outbound-data notification-data operations-data ingress egress extra; do
  synthetic_host_require_absent network "$PROJECT-$role"
done
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
for role in webhook admin reply outbound notification operations ingress egress; do
  name="$PROJECT-$role-data"; internal=(--internal); labels=(--label "fcd-support.synthetic-host-test=$PROJECT")
  if [[ "$role" == ingress || "$role" == egress ]]; then
    name="$PROJECT-$role"; [[ "$role" != egress ]] || internal=()
  else labels+=(--label "com.docker.compose.project=$PROJECT" --label "com.docker.compose.network=${role}_data"); fi
  synthetic_host_require_absent network "$name"
  docker network create --driver bridge "${internal[@]}" "${labels[@]}" "$name" >/dev/null
done
snapshot="$(synthetic_precreated_network_snapshot "$PROJECT")"
synthetic_precreated_network_unchanged "$PROJECT" "$snapshot"
FILE="$(mktemp "${TMPDIR:-/tmp}/fcd-network-proof.XXXXXXXX.yml")"
NATIVE_FILE="$FILE"
if command -v cygpath >/dev/null 2>&1; then NATIVE_FILE="$(cygpath -m "$FILE")"; fi
cat >"$FILE" <<EOF
services:
  probe:
    image: $IMAGE
    user: '1000:1000'
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    cpus: 0.25
    mem_limit: 64m
    pids_limit: 32
    entrypoint: ['node']
    command: ['-e', 'setInterval(()=>{},60000)']
    networks: [webhook_data]
networks:
  webhook_data:
    name: $PROJECT-webhook-data
    internal: true
EOF
before="$(docker network inspect --format '{{.Id}}' "$PROJECT-webhook-data")"
docker compose --project-name "$PROJECT" --file "$NATIVE_FILE" up --detach --no-build --pull never probe >/dev/null 2>&1
[[ "$(docker network inspect --format '{{.Id}}/{{len .Containers}}' "$PROJECT-webhook-data")" == "$before/1" ]]
if synthetic_precreated_network_snapshot "$PROJECT" >/dev/null 2>&1; then echo synthetic_network_participant_accepted >&2; exit 1; fi
actor="$(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$PROJECT")"
[[ "$actor" =~ ^[a-f0-9]{64}$ && "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$actor")" == probe ]]
docker rm --force --volumes "$actor" >/dev/null
synthetic_precreated_network_unchanged "$PROJECT" "$snapshot"
docker network create --driver bridge --internal --label "fcd-support.synthetic-host-test=$PROJECT" "$PROJECT-extra" >/dev/null
if synthetic_precreated_network_snapshot "$PROJECT" >/dev/null 2>&1; then echo synthetic_network_extra_accepted >&2; exit 1; fi
extra="$(docker network inspect --format '{{.Id}}/{{len .Containers}}' "$PROJECT-extra")"
[[ "$extra" =~ ^[a-f0-9]{64}/0$ ]]
docker network rm "${extra%/*}" >/dev/null
docker network rm "$before" >/dev/null
docker network create --driver bridge --internal --label "fcd-support.synthetic-host-test=$PROJECT" --label "com.docker.compose.project=$PROJECT" --label com.docker.compose.network=webhook_data "$PROJECT-webhook-data" >/dev/null
if synthetic_precreated_network_unchanged "$PROJECT" "$snapshot" >/dev/null 2>&1; then echo synthetic_network_replacement_accepted >&2; exit 1; fi
printf '%s\n' precreated_network_compose_adoption=true precreated_network_unsafe_changes_refused=true
