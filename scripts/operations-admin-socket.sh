#!/usr/bin/env bash
# Internal host-control leg. Caller retains protected config/local-daemon
# preflight and deployment lock. Not sourced by a public command yet.

operations_recover_socket() {
  local field root socket owner ids id mounts mount canonical meta runtime_image validator_image before after result
  local mounted=0
  local -a containers=()
  [[ "${OPS_ACTION:-}" == recover-admin-socket ]] || operations_fail operations_socket_recovery_refused
  for field in FCD_ADMIN_SOCKET_ROOT FCD_RUNTIME_PROJECT FCD_SUPPORT_REVISION FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_ADMIN_CPUS FCD_ADMIN_MEMORY_MIB FCD_ADMIN_PIDS FCD_HEALTH_TIMEOUT_MS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || operations_fail operations_socket_recovery_refused
  done
  (( ${OPS_CONFIG[FCD_HEALTH_TIMEOUT_MS]} <= 300000 )) || operations_fail operations_socket_recovery_refused
  root="${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}"; socket="$root/admin.sock"
  [[ -d "$root" && ! -L "$root" && "$(realpath -e -- "$root")" == "$root" && "$(stat -c '%u:%g:%a' -- "$root")" == 1000:1000:700 ]] || operations_fail operations_socket_recovery_refused
  [[ -S "$socket" && ! -L "$socket" && "$(stat -c '%u:%g:%a' -- "$socket")" == 1000:1000:600 ]] || operations_fail operations_socket_recovery_refused
  before="$(stat -c '%d:%i' -- "$socket")" || operations_fail operations_socket_recovery_refused
  [[ "$before" =~ ^[0-9]{1,20}:[0-9]{1,20}$ ]] || operations_fail operations_socket_recovery_refused
  meta="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[FCD_SUPPORT_IMAGE]}")" || operations_fail operations_socket_recovery_refused
  [[ "$meta" =~ ^(sha256:[a-f0-9]{64})/([a-f0-9]{40})/linux/amd64/(node|1000|1000:1000)$ && "${BASH_REMATCH[2]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || operations_fail operations_socket_recovery_refused
  runtime_image="${BASH_REMATCH[1]}"
  meta="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || operations_fail operations_socket_recovery_refused
  [[ "$meta" =~ ^(sha256:[a-f0-9]{64})/([a-f0-9]{40})/linux/amd64/(node|1000|1000:1000)$ && "${BASH_REMATCH[2]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || operations_fail operations_socket_recovery_refused
  validator_image="${BASH_REMATCH[1]}"
  owner="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --filter label=com.docker.compose.service=fcd-support-admin)" || operations_fail operations_socket_recovery_refused
  [[ "$owner" =~ ^[a-f0-9]{64}$ ]] || operations_fail operations_socket_recovery_refused
  local owner_format='{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Image}}/{{.State.Status}}/{{.State.Running}}/{{.State.Paused}}/{{.State.Restarting}}/{{.State.Dead}}'
  local expected="${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/fcd-support-admin/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/$runtime_image/exited/false/false/false/false"
  [[ "$(operations_docker container inspect --format "$owner_format" "$owner")" == "$expected" ]] || operations_fail operations_socket_recovery_refused
  ids="$(operations_docker ps --all --quiet --no-trunc)" || operations_fail operations_socket_recovery_refused
  ids="${ids//$'\n'/ }"; read -r -a containers <<<"$ids"
  (( ${#containers[@]} > 0 && ${#containers[@]} <= 256 )) || operations_fail operations_socket_recovery_refused
  for id in "${containers[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || operations_fail operations_socket_recovery_refused
    mounts="$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$id")" || operations_fail operations_socket_recovery_refused
    (( ${#mounts} <= 65536 )) || operations_fail operations_socket_recovery_refused
    while IFS= read -r mount || [[ -n "$mount" ]]; do
      [[ -n "$mount" ]] || continue
      operations_absolute_path "$mount" || operations_fail operations_socket_recovery_refused
      canonical="$(realpath -e -- "$mount" 2>/dev/null)" || operations_fail operations_socket_recovery_refused
      if ! operations_disjoint "$root" "$canonical"; then
        [[ "$id" == "$owner" && "$mount" == "$root" && "$canonical" == "$root" ]] || operations_fail operations_socket_recovery_refused
        (( mounted += 1 ))
      fi
    done <<<"$mounts"
  done
  (( mounted == 1 )) || operations_fail operations_socket_recovery_refused
  meta="$(operations_docker container inspect --format "{{range .Mounts}}{{if eq .Source \"$root\"}}{{if and (eq .Type \"bind\") (eq .Destination \"/run/fcd-support-admin\") .RW}}valid{{else}}invalid{{end}}{{end}}{{end}}" "$owner")" || operations_fail operations_socket_recovery_refused
  [[ "$meta" == valid && "$(operations_docker container inspect --format "$owner_format" "$owner")" == "$expected" ]] || operations_fail operations_socket_recovery_refused
  after="$(stat -c '%d:%i' -- "$socket")" || operations_fail operations_socket_recovery_refused
  [[ "$after" == "$before" && -S "$socket" && ! -L "$socket" ]] || operations_fail operations_socket_recovery_refused
  result="$(operations_docker run --rm --pull never --network none --read-only --user 1000:1000 \
    --label "fcd-support.socket-recovery=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
    --cpus "${OPS_CONFIG[FCD_ADMIN_CPUS]}" --memory "${OPS_CONFIG[FCD_ADMIN_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_ADMIN_PIDS]}" \
    --mount "type=bind,src=$root,dst=/run/fcd-support-admin" --entrypoint node "$validator_image" \
    dist/operations/admin-socket-recovery.js /run/fcd-support-admin/admin.sock "${before%:*}" "${before#*:}" "${OPS_CONFIG[FCD_HEALTH_TIMEOUT_MS]}" 2>/dev/null)" || operations_fail operations_socket_recovery_refused
  [[ "$result" == '{"status":"recovered"}' ]] || operations_fail operations_socket_recovery_refused
  printf '%s\n' admin_socket_recovered
}
