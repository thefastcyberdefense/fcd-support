#!/usr/bin/env bash
# Internal safety containment only: stop verified target applications while
# preserving PostgreSQL, storage, socket owners and any unresolved job journal.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-drain.sh"

operations_containment_checked() {
  local image="$1" field metadata entrypoint ids id actual project role revision actual_image status running paused restarting dead user started extra command row stopped after grace failed=0
  local OPS_ACTION=verify
  local -A seen=() rows=() roles=() final=()
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  for field in FCD_RUNTIME_PROJECT FCD_SUPPORT_REVISION FCD_SUPPORT_IMAGE FCD_POSTGRES_VOLUME FCD_COMMAND_TIMEOUT_SECONDS FCD_STOP_GRACE_MS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || return 1
  done
  operations_job_state_root
  operations_selection_read
  [[ ( "${OPS_SELECTION[STATE_PHASE]}" == starting || "${OPS_SELECTION[STATE_PHASE]}" == uncertain ) && "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" && "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == yes ]] || return 1
  operations_socket_root || return 1
  metadata="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$image")" || return 1
  [[ "$metadata" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(node|1000|1000:1000)$ && "$metadata" == "$image/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/"* ]] || return 1
  [[ "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "${OPS_CONFIG[FCD_SUPPORT_IMAGE]}")" == "$metadata" ]] || return 1
  entrypoint="$(operations_docker image inspect --format '{{json (index .Config "Entrypoint")}}' "$image")" || return 1
  [[ -n "$entrypoint" && ${#entrypoint} -le 4096 ]] || return 1
  ids="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  (( ${#ids} <= 1040 )) || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    if [[ ! "$id" =~ ^[a-f0-9]{64}$ || -n "${seen[$id]:-}" ]]; then failed=1; continue; fi
    seen[$id]=yes
    row="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" || { failed=1; continue; }
    IFS=/ read -r actual project role revision actual_image status running paused restarting dead user started extra <<<"$row"
    if [[ "$actual" != "$id" || "$project" != "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" ]]; then failed=1; continue; fi
    [[ "$role" != postgres ]] || continue
    case "$role" in
      fcd-support-api) command='["node","dist/main.js"]' ;;
      fcd-support-admin) command='["node","dist/admin-main.js"]' ;;
      fcd-support-reply|fcd-support-outbound|fcd-support-notification) command="[\"node\",\"dist/worker-main.js\",\"${role#fcd-support-}\"]" ;;
      *) failed=1; continue ;;
    esac
    if [[ "$revision" != "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" || "$actual_image" != "$image" || ! "$user" =~ ^(node|1000|1000:1000)$ || "$paused/$restarting/$dead" != false/false/false || -n "$extra" || ! "$started" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ || ( "$status/$running" != running/true && "$status/$running" != exited/false ) ]]; then failed=1; continue; fi
    if [[ "$(operations_docker container inspect --format '{{json .Config.Cmd}}' "$id")" != "$command" || "$(operations_docker container inspect --format '{{json (index .Config "Entrypoint")}}' "$id")" != "$entrypoint" ]]; then failed=1; continue; fi
    if [[ "$role" == fcd-support-admin ]]; then
      metadata="$(operations_docker container inspect --format "{{range .Mounts}}{{if eq .Source \"${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}\"}}{{if and (eq .Type \"bind\") (eq .Destination \"/run/fcd-support-admin\") .RW}}valid{{else}}invalid{{end}}{{end}}{{end}}" "$id")" || { failed=1; continue; }
      if [[ "$metadata" != valid ]]; then failed=1; continue; fi
    fi
    rows[$id]="$row"; roles[$id]="$role"
  done <<<"$ids"
  grace="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))"
  for role in fcd-support-reply fcd-support-outbound fcd-support-notification fcd-support-api fcd-support-admin; do
    for id in "${!rows[@]}"; do
      [[ "${roles[$id]}" == "$role" ]] || continue
      row="${rows[$id]}"
      if [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" != "$row" ]]; then failed=1; continue; fi
      stopped="${row/\/running\/true\//\/exited\/false\/}"
      if [[ "$row" != "$stopped" ]]; then operations_docker stop --time "$grace" "$id" >/dev/null 2>&1 || true; fi
      if [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" != "$stopped" ]]; then failed=1; continue; fi
      rows[$id]="$stopped"
    done
  done
  after="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  (( ${#after} <= 1040 )) || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    if [[ ! "$id" =~ ^[a-f0-9]{64}$ || -z "${seen[$id]:-}" || -n "${final[$id]:-}" ]]; then failed=1; continue; fi
    final[$id]=yes
    if [[ -n "${rows[$id]:-}" && "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" != "${rows[$id]}" ]]; then failed=1; fi
  done <<<"$after"
  (( ${#seen[@]} == ${#final[@]} )) || failed=1
  # This proves only stopped target actors. It does not clear a pending job,
  # claim socket quiescence, repair a selection or authorize another operation.
  (( failed == 0 ))
}

operations_contain_private_runtime() {
  if [[ "$#" == 1 ]] && (operations_containment_checked "$@") >/dev/null 2>&1; then return 0; fi
  operations_fail operations_containment_refused
}
