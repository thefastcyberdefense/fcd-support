#!/usr/bin/env bash
# Internal controlled PostgreSQL container replacement, never a data-volume
# switch. Caller retains protected configuration, local Docker and flock.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-drain.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-runtime-host.sh"

OPERATIONS_POSTGRES_VOLUME_FORMAT='{{.Name}}/{{.CreatedAt}}/{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{with index .Labels "com.docker.compose.project"}}{{.}}{{else}}none{{end}}/{{with index .Labels "com.docker.compose.volume"}}{{.}}{{else}}none{{end}}'

operations_postgres_storage_contract() {
  [[ "$#" == 1 && "$1" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$(operations_docker exec "$1" /usr/bin/stat -c '%u:%g:%a' -- \
    /var/lib/postgresql /var/lib/postgresql/18 /var/lib/postgresql/18/docker)" == $'999:999:700\n999:999:700\n999:999:700' ]]
}

operations_postgres_context() {
  operations_selection_read
  [[ "$(operations_selection_body)" == "$OPS_POSTGRES_SELECTION" && "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" && ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]]
}

operations_postgres_source() {
  operations_postgres_context || return 1
  [[ "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" == "$OPS_POSTGRES_SOURCE" ]] || return 1
  [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$OPS_POSTGRES_SOURCE")" == "$OPS_POSTGRES_SOURCE_ROW" ]] || return 1
  [[ "$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" == "$OPS_POSTGRES_VOLUME" ]]
}

operations_postgres_target() {
  local target before identifier prefix tail
  operations_postgres_context || return 1
  [[ "$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" == "$OPS_POSTGRES_VOLUME" ]] || return 1
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  target="$(operations_runtime_id postgres)" || return 1
  [[ "$target" =~ ^[a-f0-9]{64}$ && "$target" != "$OPS_POSTGRES_SOURCE" ]] || return 1
  before="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$target")" || return 1
  prefix="$target/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/${OPS_CONFIG[FCD_POSTGRES_IMAGE]}/running/true/false/false/false/"
  [[ "$before" == "$prefix"* ]] || return 1
  tail="${before#"$prefix"}"
  [[ "$tail" =~ ^(postgres|999|999:999)/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || return 1
  identifier="$(operations_read_database_control_identifier "$target")" || return 1
  [[ "$identifier" == "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" ]] || return 1
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$target")" == "$before" && "$(operations_runtime_id postgres)" == "$target" ]] || return 1
  [[ "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" == "$target" && "$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" == "$OPS_POSTGRES_VOLUME" ]] || return 1
  operations_postgres_context
}

operations_postgres_converge_checked() {
  local source_revision="$1" source_image="$2" mode="$3" target_image="$4" field meta rev prefix tail identifier grace
  local OPS_ACTION=database-convergence
  local OPS_POSTGRES_SELECTION OPS_POSTGRES_SOURCE OPS_POSTGRES_SOURCE_ROW OPS_POSTGRES_VOLUME
  local OPS_DRAIN_MODE="$mode"
  local -A OPS_DRAIN_EXPECTED=() OPS_DRAIN_ROLES=()
  [[ "$source_revision" =~ ^[a-f0-9]{40}$ && "$source_image" =~ ^sha256:[a-f0-9]{64}$ && "$target_image" =~ ^sha256:[a-f0-9]{64}$ && ( "$mode" == admission || "$mode" == managed ) ]] || return 1
  for field in FCD_RUNTIME_PROJECT FCD_POSTGRES_VOLUME FCD_POSTGRES_IMAGE FCD_SUPPORT_REVISION FCD_COMMAND_TIMEOUT_SECONDS FCD_STOP_GRACE_MS FCD_READY_TIMEOUT_SECONDS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || return 1
  done
  operations_job_state_root
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_PHASE]}" == quiescent && "${OPS_SELECTION[STATE_REVISION]}" == "$source_revision" && "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" && ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  OPS_POSTGRES_SELECTION="$(operations_selection_body)" || return 1
  operations_socket_root
  meta="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$source_image")" || return 1
  if [[ "$mode" == admission ]]; then
    [[ "$meta" == "$source_image/none/linux/amd64/none" ]] || return 1; rev=none
  else
    [[ "$meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(postgres|999|999:999)$ && "$meta" == "$source_image/$source_revision/"* ]] || return 1; rev="$source_revision"
  fi
  meta="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$target_image")" || return 1
  [[ "$meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(postgres|999|999:999)$ && "$meta" == "$target_image/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/"* ]] || return 1
  [[ "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_IMAGE]}")" == "$meta" ]] || return 1
  # Freeze interpolation to the immutable target; this subshell never edits the
  # protected configuration file or mutates the caller's in-memory map.
  OPS_CONFIG[FCD_POSTGRES_IMAGE]="$target_image"
  OPS_POSTGRES_SOURCE="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  [[ "$OPS_POSTGRES_SOURCE" =~ ^[a-f0-9]{64}$ ]] || return 1
  OPS_POSTGRES_SOURCE_ROW="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$OPS_POSTGRES_SOURCE")" || return 1
  prefix="$OPS_POSTGRES_SOURCE/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres/$rev/$source_image/running/true/false/false/false/"
  [[ "$OPS_POSTGRES_SOURCE_ROW" == "$prefix"* ]] || return 1
  tail="${OPS_POSTGRES_SOURCE_ROW#"$prefix"}"
  [[ "$tail" =~ ^(postgres|999|999:999)/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || return 1
  [[ "$(operations_docker container inspect --format '{{json .Config.Cmd}}' "$OPS_POSTGRES_SOURCE")" == '["postgres"]' && "$(operations_docker container inspect --format '{{json (index .Config "Entrypoint")}}' "$OPS_POSTGRES_SOURCE")" == "$(operations_docker image inspect --format '{{json (index .Config "Entrypoint")}}' "$source_image")" && "$(operations_docker container inspect --format '{{len .HostConfig.PortBindings}}/{{.HostConfig.Privileged}}' "$OPS_POSTGRES_SOURCE")" == 0/false ]] || return 1
  OPS_DRAIN_EXPECTED[$OPS_POSTGRES_SOURCE]="$OPS_POSTGRES_SOURCE_ROW"; OPS_DRAIN_ROLES[postgres]="$OPS_POSTGRES_SOURCE"
  operations_drain_boundaries || return 1
  OPS_POSTGRES_VOLUME="$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  identifier="$(operations_read_database_control_identifier "$OPS_POSTGRES_SOURCE")" || return 1
  [[ "$identifier" == "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" ]] || return 1
  # The hardened image never repairs inherited directory ownership/modes. Check
  # its data-directory contract while the old PG actor is still running, before
  # opening an outage that would otherwise fail at the replacement entrypoint.
  operations_postgres_storage_contract "$OPS_POSTGRES_SOURCE" || return 1
  operations_postgres_source || return 1
  operations_selection_database_changing "${OPS_SELECTION[STATE_REF]}" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}"
  OPS_POSTGRES_SELECTION="$(operations_selection_body)" || return 1
  operations_postgres_source || return 1
  grace="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))"
  operations_docker stop --time "$grace" "$OPS_POSTGRES_SOURCE" >/dev/null 2>&1 || true
  OPS_POSTGRES_SOURCE_ROW="${OPS_POSTGRES_SOURCE_ROW/\/running\/true\//\/exited\/false\/}"
  operations_postgres_source || return 1
  operations_docker rm "$OPS_POSTGRES_SOURCE" >/dev/null 2>&1 || true
  operations_postgres_context || return 1
  [[ -z "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" && -z "$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" ]] || return 1
  [[ "$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" == "$OPS_POSTGRES_VOLUME" ]] || return 1
  # A failed/lost client response is never replayed. Only the complete fresh
  # PG-only postcondition below may resolve its outcome in this invocation.
  operations_compose runtime up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" --no-deps --no-build --pull never postgres >/dev/null 2>&1 || true
  operations_postgres_target || return 1
  operations_selection_quiesce "${OPS_SELECTION[STATE_REF]}"
}

operations_converge_postgres() {
  if [[ "$#" == 4 ]] && (operations_postgres_converge_checked "$@") >/dev/null 2>&1; then return 0; fi
  (operations_selection_read
    [[ "${OPS_SELECTION[STATE_PHASE]}" == database-changing && "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" ]] || exit 1
    operations_selection_uncertain "${OPS_SELECTION[STATE_REF]}"
  ) >/dev/null 2>&1 || true
  operations_fail operations_postgres_convergence_refused
}
