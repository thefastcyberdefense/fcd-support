#!/usr/bin/env bash
# Internal controlled outage. Caller supplies independently verified immutable
# source images and keeps protected config, local daemon and deployment lock.
# No public entry point is installed until the complete controller is safe.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-database.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-deployment-state.sh"

OPERATIONS_DRAIN_ACTOR_FORMAT='{{.Id}}/{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}/{{with index .Config.Labels "org.opencontainers.image.revision"}}{{.}}{{else}}none{{end}}/{{.Image}}/{{.State.Status}}/{{.State.Running}}/{{.State.Paused}}/{{.State.Restarting}}/{{.State.Dead}}/{{.Config.User}}/{{.State.StartedAt}}'
OPERATIONS_DRAIN_IMAGE_FORMAT='{{.Id}}/{{with index .Config "Labels"}}{{with index . "org.opencontainers.image.revision"}}{{.}}{{else}}none{{end}}{{else}}none{{end}}/{{.Os}}/{{.Architecture}}/{{with index .Config "User"}}{{.}}{{else}}none{{end}}'

operations_drain_selection() {
  local stamp
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_PHASE]}" == draining && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == yes && "${OPS_SELECTION[STATE_REVISION]}" == "$OPS_DRAIN_REVISION" && "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" ]] || return 1
  stamp="$(operations_selection_body)" || return 1
  [[ "$stamp" == "$OPS_DRAIN_SELECTION" && ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]]
}

operations_drain_actor_set() {
  local ids id meta
  local -A present=()
  operations_drain_selection || return 1
  ids="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  (( ${#ids} <= 4096 )) || return 1
  while IFS= read -r id; do
    [[ "$id" =~ ^[a-f0-9]{64}$ && -z "${present[$id]:-}" && -n "${OPS_DRAIN_EXPECTED[$id]:-}" ]] || return 1
    present[$id]=yes
    meta="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" || return 1
    [[ "$meta" == "${OPS_DRAIN_EXPECTED[$id]}" ]] || return 1
  done <<<"$ids"
  (( ${#present[@]} == ${#OPS_DRAIN_EXPECTED[@]} ))
}

operations_drain_boundaries() {
  local networks network logical peers id ids mounts mount canonical named volume database_root count=0
  local root="${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}" postgres="${OPS_DRAIN_ROLES[postgres]}"
  local -A seen=() allowed=()
  local -a expected_networks=()
  if [[ "$OPS_DRAIN_MODE" == admission ]]; then expected_networks=(data);
  else expected_networks=(webhook-data admin-data reply-data outbound-data notification-data operations-data); fi
  for network in "${expected_networks[@]}"; do allowed["${OPS_CONFIG[FCD_RUNTIME_PROJECT]}-$network"]=yes; done
  networks="$(operations_docker container inspect --format '{{range $name, $network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$postgres")" || return 1
  (( ${#networks} <= 4096 )) || return 1
  while IFS= read -r network; do
    [[ -n "$network" && -n "${allowed[$network]:-}" && -z "${seen[$network]:-}" ]] || return 1
    seen[$network]=yes
    logical="${network#"${OPS_CONFIG[FCD_RUNTIME_PROJECT]}-"}"; logical="${logical//-/_}"
    [[ "$(operations_docker network inspect --format '{{.Name}}/{{.Driver}}/{{.Internal}}/{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.network"}}' "$network")" == "$network/bridge/true/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/$logical" ]] || return 1
    peers="$(operations_docker network inspect --format '{{range $id, $member := .Containers}}{{println $id}}{{end}}' "$network")" || return 1
    (( ${#peers} <= 4096 )) || return 1
    while IFS= read -r id; do [[ "$id" =~ ^[a-f0-9]{64}$ && -n "${OPS_DRAIN_EXPECTED[$id]:-}" ]] || return 1; done <<<"$peers"
  done <<<"$networks"
  (( ${#seen[@]} == ${#allowed[@]} )) || return 1
  named="$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  [[ "$named" == "$postgres" ]] || return 1
  volume="$(operations_docker volume inspect --format '{{.Name}}/{{.CreatedAt}}/{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{with index .Labels "com.docker.compose.project"}}{{.}}{{else}}none{{end}}/{{with index .Labels "com.docker.compose.volume"}}{{.}}{{else}}none{{end}}' "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  [[ "$volume" == "${OPS_SELECTION[STATE_VOLUME]}/${OPS_SELECTION[STATE_VOLUME_CREATED_AT]}/local/local/default/${OPS_SELECTION[STATE_VOLUME_ORIGIN]}/${OPS_SELECTION[STATE_VOLUME_LOGICAL]}" ]] || return 1
  database_root="$(operations_docker volume inspect --format '{{.Mountpoint}}' "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  operations_absolute_path "$database_root" && operations_disjoint "$database_root" "$root" || return 1
  [[ "$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name .Destination .RW}}{{end}}{{end}}' "$postgres")" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]} /var/lib/postgresql true" ]] || return 1
  for id in "${!OPS_DRAIN_EXPECTED[@]}"; do
    [[ "$id" != "$postgres" ]] || continue
    [[ -z "$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$id")" ]] || return 1
  done
  # Scan every stopped/running host container: aliases or parent binds cannot
  # share the private socket directory, even if they have foreign labels.
  ids="$(operations_docker ps --all --quiet --no-trunc)" || return 1
  (( ${#ids} <= 16640 )) || return 1
  while IFS= read -r id; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    mounts="$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$id")" || return 1
    (( ${#mounts} <= 65536 )) || return 1
    while IFS= read -r mount; do
      [[ -n "$mount" ]] || continue
      operations_absolute_path "$mount" || return 1
      canonical="$(realpath -e -- "$mount" 2>/dev/null)" || return 1
      operations_disjoint "$database_root" "$canonical" || return 1
      if ! operations_disjoint "$root" "$canonical"; then
        [[ "$id" == "${OPS_DRAIN_ROLES[fcd-support-admin]:-}" && "$mount" == "$root" && "$canonical" == "$root" ]] || return 1
        (( count += 1 ))
      fi
    done <<<"$mounts"
  done <<<"$ids"
  if [[ -n "${OPS_DRAIN_ROLES[fcd-support-admin]:-}" ]]; then
    [[ "$count" == 1 && "$(operations_docker container inspect --format "{{range .Mounts}}{{if eq .Source \"$root\"}}{{if and (eq .Type \"bind\") (eq .Destination \"/run/fcd-support-admin\") .RW}}valid{{else}}invalid{{end}}{{end}}{{end}}" "${OPS_DRAIN_ROLES[fcd-support-admin]}")" == valid ]] || return 1
  else [[ "$count" == 0 ]] || return 1; fi
}

operations_drain_checked() {
  local revision="$1" app_image="$2" pg_image="$3" mode="$4" field image project expected_user meta ids id role rev actual status running paused restarting dead user started extra command old stopped grace system app_entrypoint pg_entrypoint entrypoint
  local OPS_ACTION=verify
  local -A OPS_DRAIN_ROLES=() OPS_DRAIN_EXPECTED=()
  local OPS_DRAIN_REVISION="$revision" OPS_DRAIN_MODE="$mode" OPS_DRAIN_SELECTION
  [[ "$revision" =~ ^[a-f0-9]{40}$ && "$app_image" =~ ^sha256:[a-f0-9]{64}$ && "$pg_image" =~ ^sha256:[a-f0-9]{64}$ && ( "$mode" == managed || "$mode" == admission ) ]] || return 1
  for field in FCD_RUNTIME_PROJECT FCD_POSTGRES_VOLUME FCD_COMMAND_TIMEOUT_SECONDS FCD_STOP_GRACE_MS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || return 1
  done
  operations_job_state_root
  operations_selection_read
  OPS_DRAIN_SELECTION="$(operations_selection_body)" || return 1
  operations_drain_selection || return 1
  operations_socket_root
  if [[ -e "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock" || -L "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock" ]]; then
    [[ -S "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock" && ! -L "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock" && "$(stat -c '%u:%g:%a' -- "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock")" == 1000:1000:600 ]] || return 1
  fi
  meta="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$app_image")" || return 1
  [[ "$meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(node|1000|1000:1000)$ && "$meta" == "$app_image/$revision/"* ]] || return 1
  meta="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$pg_image")" || return 1
  # The legacy upstream image has no revision label. Its immutable ID is
  # independently pinned by the caller; never infer it from an actor's image.
  if [[ "$mode" == admission ]]; then
    [[ "$meta" == "$pg_image/none/linux/amd64/none" ]] || return 1
  else
    [[ "$meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(postgres|999|999:999)$ && "$meta" == "$pg_image/$revision/"* ]] || return 1
  fi
  app_entrypoint="$(operations_docker image inspect --format '{{json (index .Config "Entrypoint")}}' "$app_image")" || return 1
  pg_entrypoint="$(operations_docker image inspect --format '{{json (index .Config "Entrypoint")}}' "$pg_image")" || return 1
  [[ -n "$app_entrypoint" && -n "$pg_entrypoint" && ${#app_entrypoint} -le 4096 && ${#pg_entrypoint} -le 4096 ]] || return 1
  ids="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  (( ${#ids} <= 4096 )) || return 1
  while IFS= read -r id; do
    [[ "$id" =~ ^[a-f0-9]{64}$ && -z "${OPS_DRAIN_EXPECTED[$id]:-}" ]] || return 1
    meta="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" || return 1
    IFS=/ read -r actual project role rev image status running paused restarting dead user started extra <<<"$meta"
    [[ "$actual" == "$id" && "$project" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" && -z "$extra" && "$paused/$restarting/$dead" == false/false/false && "$started" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ && -n "$role" && -z "${OPS_DRAIN_ROLES[$role]:-}" ]] || return 1
    case "$role" in
      postgres)
        expected_user='^(postgres|999|999:999)$'; command='["postgres"]'
        entrypoint="$pg_entrypoint"
        [[ "$image" == "$pg_image" && "$status/$running" == running/true && ( ( "$mode" == managed && "$rev" == "$revision" ) || ( "$mode" == admission && "$rev" == none ) ) ]] || return 1 ;;
      fcd-support-api|fcd-support-admin|fcd-support-reply|fcd-support-outbound|fcd-support-notification)
        [[ "$mode" == managed || "$role" == fcd-support-api ]] || return 1
        [[ "$image" == "$app_image" && "$rev" == "$revision" && ( "$status/$running" == running/true || "$status/$running" == exited/false ) ]] || return 1
        expected_user='^(node|1000|1000:1000)$'
        entrypoint="$app_entrypoint"
        case "$role" in
          fcd-support-api) command='["node","dist/main.js"]' ;;
          fcd-support-admin) command='["node","dist/admin-main.js"]' ;;
          *) command="[\"node\",\"dist/worker-main.js\",\"${role#fcd-support-}\"]" ;;
        esac ;;
      *) return 1 ;;
    esac
    [[ "$user" =~ $expected_user && "$(operations_docker container inspect --format '{{json .Config.Cmd}}' "$id")" == "$command" && "$(operations_docker container inspect --format '{{json (index .Config "Entrypoint")}}' "$id")" == "$entrypoint" && "$(operations_docker container inspect --format '{{len .HostConfig.PortBindings}}/{{.HostConfig.Privileged}}' "$id")" == 0/false ]] || return 1
    OPS_DRAIN_ROLES[$role]="$id"; OPS_DRAIN_EXPECTED[$id]="$meta"
  done <<<"$ids"
  [[ -n "${OPS_DRAIN_ROLES[postgres]:-}" && ${#OPS_DRAIN_ROLES[@]} -le 6 ]] || return 1
  operations_drain_boundaries || return 1
  system="$(operations_read_database_control_identifier "${OPS_DRAIN_ROLES[postgres]}")" || return 1
  [[ "$system" == "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" ]] || return 1
  operations_drain_actor_set || return 1
  grace="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))"
  for role in fcd-support-reply fcd-support-outbound fcd-support-notification fcd-support-admin fcd-support-api; do
    id="${OPS_DRAIN_ROLES[$role]:-}"; [[ -n "$id" ]] || continue
    operations_drain_actor_set || return 1
    old="${OPS_DRAIN_EXPECTED[$id]}"; stopped="${old/\/running\/true\//\/exited\/false\/}"
    # A lost stop acknowledgement is resolved only by its exact postcondition.
    if [[ "$old" != "$stopped" ]]; then operations_docker stop --time "$grace" "$id" >/dev/null 2>&1 || true; fi
    OPS_DRAIN_EXPECTED[$id]="$stopped"
    operations_drain_actor_set || return 1
  done
  [[ ! -e "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock" && ! -L "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}/admin.sock" ]] || return 1
  for role in fcd-support-reply fcd-support-outbound fcd-support-notification fcd-support-admin fcd-support-api; do
    id="${OPS_DRAIN_ROLES[$role]:-}"; [[ -n "$id" ]] || continue
    operations_drain_actor_set || return 1
    # No force, volume removal, image removal or automatic socket recovery.
    operations_docker rm "$id" >/dev/null 2>&1 || true
    unset 'OPS_DRAIN_EXPECTED[$id]' 'OPS_DRAIN_ROLES[$role]'
    operations_drain_actor_set || return 1
  done
  operations_drain_boundaries || return 1
  system="$(operations_read_database_control_identifier "${OPS_DRAIN_ROLES[postgres]}")" || return 1
  [[ "$system" == "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" ]] || return 1
  operations_drain_actor_set || return 1
  operations_selection_quiesce "${OPS_SELECTION[STATE_REF]}"
}

operations_drain_owned_applications() {
  if [[ "$#" == 4 ]] && (operations_drain_checked "$@") >/dev/null 2>&1; then return 0; fi
  # An interrupted or refused drain never restarts anything. Preserve uncertainty
  # only for the verified source marker; malformed/unrelated state stays intact.
  (operations_selection_read
    [[ "$#" == 4 && "${OPS_SELECTION[STATE_PHASE]}" == draining && "${OPS_SELECTION[STATE_REVISION]}" == "$1" ]] || exit 1
    operations_selection_uncertain "${OPS_SELECTION[STATE_REF]}"
  ) >/dev/null 2>&1 || true
  operations_fail operations_drain_refused
}
