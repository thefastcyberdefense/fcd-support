#!/usr/bin/env bash
# Read-only host sampling. Source only after operations-common.sh. The caller
# must hold its checked deployment lock and local-daemon/config preflight.

OPERATIONS_RESTORE_CONTAINER_FORMAT='{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"imageId":{{json .Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"healthy":{{with index .State "Health"}}{{eq .Status "healthy"}}{{else}}false{{end}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"user":{{json .Config.User}},"networkMode":{{json .HostConfig.NetworkMode}},"networkIds":[{{$separator := ""}}{{range .NetworkSettings.Networks}}{{$separator}}{{json .NetworkID}}{{$separator = ","}}{{end}}],"hostPortBindings":{{len .HostConfig.PortBindings}},"publishAllPorts":{{json .HostConfig.PublishAllPorts}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"mounts":[{{range $i,$mount := .Mounts}}{{if $i}},{{end}}{"type":{{json $mount.Type}},"name":{{with index $mount "Name"}}{{json .}}{{else}}""{{end}},"destination":{{json $mount.Destination}},"readWrite":{{json $mount.RW}}}{{end}}]}'

operations_restore_host_ids() {
  local values="$1" id separator=''
  local -a ids=()
  values="${values//$'\n'/ }"
  read -r -a ids <<<"$values"
  (( ${#ids[@]} <= 32 )) || return 1
  printf '['
  for id in "${ids[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    printf '%s"%s"' "$separator" "$id"
    separator=,
  done
  printf ']'
}

operations_restore_host_snapshot() {
  local project="${OPS_CONFIG[FCD_RESTORE_PROJECT]}" volume="${OPS_CONFIG[FCD_RESTORE_VOLUME]}" live="${OPS_CONFIG[FCD_POSTGRES_VOLUME]}"
  local volume_json live_json network_json postgres_json pg_image runtime_image ids members users postgres_id
  local volume_format='{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"mountpoint":{{json .Mountpoint}}'
  local image_format='{"id":{{json .Id}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"os":{{json .Os}},"architecture":{{json .Architecture}},"user":{{json .Config.User}}}'
  volume_json="$(operations_docker volume inspect --format "$volume_format,\"project\":{{json (index .Labels \"com.docker.compose.project\")}},\"logicalName\":{{json (index .Labels \"com.docker.compose.volume\")}},\"createdAt\":{{json .CreatedAt}}}" "$volume")" || return 1
  live_json="$(operations_docker volume inspect --format "$volume_format}" "$live")" || return 1
  ids="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres)" || return 1
  [[ "$ids" =~ ^[a-f0-9]{64}$ ]] || return 1
  postgres_id="$ids"
  members="$(operations_docker network inspect --format '{{range $id,$member := .Containers}}{{println $id}}{{end}}' "$project-data")" || return 1
  members="$(operations_restore_host_ids "$members")" || return 1
  network_json="$(operations_docker network inspect --format '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"internal":{{json .Internal}},"project":{{json (index .Labels "com.docker.compose.project")}},"logicalName":{{json (index .Labels "com.docker.compose.network")}}' "$project-data")" || return 1
  network_json+=",\"members\":$members}"
  users="$(operations_docker ps --all --quiet --no-trunc --filter "volume=$volume")" || return 1
  users="$(operations_restore_host_ids "$users")" || return 1
  # Never request environment, command, secret contents, complete inspect output
  # or arbitrary labels. Only these fixed metadata fields cross into the validator.
  postgres_json="$(operations_docker container inspect --format "$OPERATIONS_RESTORE_CONTAINER_FORMAT" "$postgres_id")" || return 1
  pg_image="$(operations_docker image inspect --format "$image_format" "${OPS_CONFIG[FCD_POSTGRES_IMAGE]}")" || return 1
  runtime_image="$(operations_docker image inspect --format "$image_format" "${OPS_CONFIG[FCD_SUPPORT_IMAGE]}")" || return 1
  printf '{"volume":%s,"liveVolume":%s,"network":%s,"postgres":%s,"volumeUsers":%s,"postgresImage":%s,"runtimeImage":%s}' \
    "$volume_json" "$live_json" "$network_json" "$postgres_json" "$users" "$pg_image" "$runtime_image"
}

operations_inspect_restore_host() {
  local field before after result image validator_image bound="${1:-}"
  local -a arguments=()
  [[ "$#" -le 1 && "${#bound}" -le 2048 ]] || operations_fail restore_host_invalid
  for field in FCD_RESTORE_PROJECT FCD_RESTORE_VOLUME FCD_POSTGRES_VOLUME FCD_SUPPORT_REVISION FCD_POSTGRES_IMAGE FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_RESTORE_CPUS FCD_RESTORE_MEMORY_MIB FCD_RESTORE_PIDS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || operations_fail restore_host_invalid
  done
  [[ "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" =~ ^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$ && "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" != "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" ]] || operations_fail restore_host_invalid
  image="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || operations_fail restore_host_invalid
  [[ "$image" =~ ^(sha256:[a-f0-9]{64})/([a-f0-9]{40})/linux/amd64/(node|1000|1000:1000)$ && "${BASH_REMATCH[2]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || operations_fail restore_host_invalid
  validator_image="${BASH_REMATCH[1]}"
  before="$(operations_restore_host_snapshot)" || operations_fail restore_host_invalid
  after="$(operations_restore_host_snapshot)" || operations_fail restore_host_invalid
  arguments=("${OPS_CONFIG[FCD_RESTORE_PROJECT]}" "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}")
  [[ -z "$bound" ]] || arguments+=("$bound")
  # Docker capability remains on the host. This one-shot validation process is
  # unprivileged, networkless, read-only, resource bounded, and has no mounts.
  result="$({ printf '{"before":%s,"after":%s}' "$before" "$after" | \
    operations_docker run --rm --interactive --pull never --network none --read-only --user 1000:1000 \
      --label "fcd-support.restore-inspection=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
      --cpus "${OPS_CONFIG[FCD_RESTORE_CPUS]}" --memory "${OPS_CONFIG[FCD_RESTORE_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_RESTORE_PIDS]}" \
      --entrypoint node "$validator_image" dist/operations/restore-host-main.js "${arguments[@]}"; } 2>/dev/null)" || operations_fail restore_host_invalid
  printf '%s\n' "$result"
}
