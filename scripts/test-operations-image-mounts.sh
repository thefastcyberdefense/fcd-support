#!/usr/bin/env bash
# Real stopped-container mount proof using only a fresh synthetic scope.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 1 ]] || { echo operations_image_mount_arguments_invalid >&2; exit 1; }
image="$1"; scope="fcd-support-operations-mount-proof-$$-$RANDOM"; volume="$scope-archive"
cleanup() {
  local ids id found users
  ids="$(docker ps --all --quiet --no-trunc --filter "label=fcd-support.operations-mount-proof=$scope")" || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ && "$(docker inspect --format '{{index .Config.Labels "fcd-support.operations-mount-proof"}}' "$id")" == "$scope" ]] || return 1
    docker rm --force --volumes "$id" >/dev/null || return 1
  done <<<"$ids"
  found="$(docker volume ls --quiet --filter "name=^$volume$")" || return 1
  if [[ -n "$found" ]]; then
    [[ "$found" == "$volume" && "$(docker volume inspect --format '{{index .Labels "fcd-support.operations-mount-proof"}}' "$volume")" == "$scope" ]] || return 1
    users="$(docker ps --all --quiet --filter "volume=$volume")" || return 1
    [[ -z "$users" ]] || return 1
    docker volume rm "$volume" >/dev/null || return 1
  fi
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
[[ -z "$(docker volume ls --quiet --filter "name=^$volume$")" ]]
docker volume create --label "fcd-support.operations-mount-proof=$scope" "$volume" >/dev/null
declared="$(docker image inspect --format '{{if .Config.Volumes}}yes{{else}}no{{end}}' "$image")"
validator="$(docker create --pull never --name "$scope-validator" --label "fcd-support.operations-mount-proof=$scope" \
  --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node "$image" --version)"
[[ "$validator" =~ ^[a-f0-9]{64}$ ]]
validator_count="$(docker inspect --format '{{len .Mounts}}' "$validator")"
docker rm --volumes "$validator" >/dev/null
job="$(docker create --pull never --name "$scope-job" --label "fcd-support.operations-mount-proof=$scope" \
  --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,src=$volume,dst=/var/lib/fcd-support/backups,readonly" --entrypoint node "$image" --version)"
[[ "$job" =~ ^[a-f0-9]{64}$ ]]
job_count="$(docker inspect --format '{{len .Mounts}}' "$job")"
job_archive="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/fcd-support/backups"}}{{.Type}}/{{.Name}}/{{.RW}}{{end}}{{end}}' "$job")"
docker rm --volumes "$job" >/dev/null
if [[ "$declared" != no || "$validator_count" != 0 || "$job_count" != 1 || "$job_archive" != "volume/$volume/false" ]]; then
  printf 'operations_image_declares_volumes=%s\nvalidator_has_extra_mount=%s\njob_has_extra_mount=%s\n' "$declared" "$([[ "$validator_count" == 0 ]] && echo false || echo true)" "$([[ "$job_count" == 1 ]] && echo false || echo true)" >&2
  exit 1
fi
printf '%s\n' operations_image_has_no_implicit_volumes=true validator_has_no_mounts=true job_has_only_explicit_mount=true
