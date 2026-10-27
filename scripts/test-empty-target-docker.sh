#!/usr/bin/env bash
# Real Docker proof using only a freshly labelled synthetic volume and actors.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 2 && "$2" =~ ^[a-f0-9]{40}$ ]] || { echo empty_target_docker_arguments_invalid >&2; exit 1; }
image="$1"; revision="$2"; scope="fcd-support-empty-proof-$$-$RANDOM"; volume="$scope-data"; actor="$scope-probe"
cleanup() {
  local ids id label users found
  ids="$(docker ps --all --quiet --no-trunc --filter "label=fcd-support.empty-proof=$scope")" || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    label="$(docker inspect --format '{{index .Config.Labels "fcd-support.empty-proof"}}' "$id")" || return 1
    [[ "$label" == "$scope" ]] || return 1
    docker rm --force --volumes "$id" >/dev/null || return 1
  done <<<"$ids"
  found="$(docker volume ls --quiet --filter "name=^$volume$")" || return 1
  if [[ -n "$found" ]]; then
    [[ "$found" == "$volume" && "$(docker volume inspect --format '{{index .Labels "fcd-support.empty-proof"}}' "$volume")" == "$scope" ]] || return 1
    users="$(docker ps --all --quiet --filter "volume=$volume")" || return 1
    [[ -z "$users" ]] || return 1
    docker volume rm "$volume" >/dev/null || return 1
  fi
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
trap 'result=$?; printf "empty_target_docker_failed_line=%s status=%s\n" "$LINENO" "$result" >&2' ERR
metadata="$(docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "$image")"
[[ "$metadata" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64$ && "$metadata" == */"$revision"/linux/amd64 ]]
[[ "$(docker image inspect --format '{{if .Config.Volumes}}has_volumes{{else}}none{{end}}/{{.Config.User}}' "$image")" == none/node ]]
[[ -z "$(docker volume ls --quiet --filter "name=^$volume$")" && -z "$(docker ps --all --quiet --filter "name=^/$actor$")" ]]
docker volume create --label "fcd-support.empty-proof=$scope" "$volume" >/dev/null
[[ "$(docker volume inspect --format '{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{index .Labels "fcd-support.empty-proof"}}' "$volume")" == "local/local/default/$scope" ]]
mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
[[ "$mountpoint" == /* && "$mountpoint" != *','* ]]
probe() {
  local id policy security shape source result
  id="$(docker create --pull never --name "$actor" --label "fcd-support.empty-proof=$scope" \
    --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
    --cpus 0.25 --memory 128m --pids-limit 32 --mount "type=bind,src=$mountpoint,dst=/target,readonly" \
    --entrypoint node "$image" dist/operations/empty-restore-target-main.js)" || { echo empty_target_probe_create_failed >&2; return 1; }
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { echo empty_target_probe_id_invalid >&2; return 1; }
  policy="$(docker inspect --format '{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.Privileged}} {{join .HostConfig.CapDrop ","}} {{len .Mounts}}' "$id")" || { echo empty_target_probe_policy_inspect_failed >&2; return 1; }
  security="$(docker inspect --format '{{join .HostConfig.SecurityOpt ","}}' "$id")" || { echo empty_target_probe_security_inspect_failed >&2; return 1; }
  shape="$(docker inspect --format '{{range .Mounts}}{{.Type}} {{.Destination}} {{.RW}}{{end}}' "$id")" || { echo empty_target_probe_mount_inspect_failed >&2; return 1; }
  source="$(docker inspect --format '{{range .Mounts}}{{.Source}}{{end}}' "$id")" || { echo empty_target_probe_source_inspect_failed >&2; return 1; }
  [[ "$policy" == 'none true 1000:1000 false ALL 1' ]] || { echo empty_target_probe_policy_invalid >&2; return 1; }
  [[ "$security" == no-new-privileges || "$security" == no-new-privileges:true ]] || { echo empty_target_probe_security_invalid >&2; return 1; }
  [[ "$shape" == 'bind /target false' ]] || { echo empty_target_probe_mount_invalid >&2; return 1; }
  [[ "$source" == "$mountpoint" ]] || { echo empty_target_probe_source_invalid >&2; return 1; }
  if result="$(docker start --attach "$id" 2>/dev/null)"; then
    docker rm --volumes "$id" >/dev/null || return 1
    [[ "$result" =~ ^[a-f0-9]{64}$ ]] || { echo empty_target_probe_output_invalid >&2; return 1; }
    printf '%s' "$result"
  else
    docker rm --volumes "$id" >/dev/null || return 1
    echo empty_target_probe_execution_failed >&2; return 1
  fi
}
first="$(probe)"; second="$(probe)"
[[ "$first" == "$second" ]]
docker run --rm --pull never --name "$scope-writer" --label "fcd-support.empty-proof=$scope" \
  --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 0.25 --memory 128m --pids-limit 32 --mount "type=volume,src=$volume,dst=/target" \
  --entrypoint mkdir "$image" /target/synthetic-marker >/dev/null
if probe >/dev/null 2>&1; then echo empty_target_nonempty_accepted >&2; exit 1; fi
[[ "$(docker volume inspect --format '{{index .Labels "fcd-support.empty-proof"}}' "$volume")" == "$scope" && -z "$(docker ps --all --quiet --filter "volume=$volume")" ]]
docker volume rm "$volume" >/dev/null
if docker create --pull never --name "$actor" --label "fcd-support.empty-proof=$scope" --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,src=$mountpoint,dst=/target,readonly" \
  --entrypoint node "$image" dist/operations/empty-restore-target-main.js >/dev/null 2>&1; then
  echo empty_target_missing_bind_accepted >&2; exit 1
fi
[[ -z "$(docker volume ls --quiet --filter "name=^$volume$")" ]]
printf '%s\n' empty_target_docker_confinement=true empty_target_nonempty_refused=true empty_target_missing_bind_refused=true
