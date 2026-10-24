#!/usr/bin/env bash
# Internal only. The caller owns the checked local daemon/configuration, exact
# checkout and deployment lock. All supplied arguments are content-free.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-job-state.sh"

OPERATIONS_JOB_IDENTITY_FORMAT='{{.Id}}/{{.Image}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{index .Config.Labels "fcd-support.operation.ref"}}/{{index .Config.Labels "fcd-support.operation.parent"}}/{{index .Config.Labels "fcd-support.operation.service"}}/{{index .Config.Labels "fcd-support.operation.command"}}/{{.State.Status}}/{{.State.Paused}}/{{.State.Restarting}}/{{.State.Dead}}/{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}'

operations_job_discover() {
  operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$OPS_JOB_PROJECT"
}

operations_job_assert_container() {
  local phase="$1" actual command
  [[ "${OPS_JOB_CONTAINER:-}" =~ ^[a-f0-9]{64}$ ]] || return 1
  actual="$(operations_docker container inspect --format "$OPERATIONS_JOB_IDENTITY_FORMAT" "$OPS_JOB_CONTAINER")" || return 1
  [[ "$actual" == "$OPS_JOB_CONTAINER/$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/$OPS_JOB_REFERENCE/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/$OPS_JOB_SERVICE/$OPS_JOB_COMMAND_HASH/$phase/false/false/false/$OPS_JOB_PROJECT/$OPS_JOB_SERVICE" ]] || return 1
  command="$(operations_docker container inspect --format '{{json .Config.Cmd}}' "$OPS_JOB_CONTAINER")" || return 1
  [[ "$command" == "$OPS_JOB_COMMAND_JSON" ]]
}

operations_job_remove_exited() {
  local remaining
  operations_job_assert_container exited || return 1
  operations_docker container rm "$OPS_JOB_CONTAINER" >/dev/null || return 1
  remaining="$(operations_job_discover)" || return 1
  [[ -z "$remaining" ]]
}

operations_job_cancel_owned() {
  local phase
  # Never stop/remove an unverified container, even after a failed create.
  for phase in running created exited; do
    if operations_job_assert_container "$phase"; then
      if [[ "$phase" != exited ]]; then
        operations_docker container stop --time "$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))" "$OPS_JOB_CONTAINER" >/dev/null || return 1
      fi
      operations_job_remove_exited
      return
    fi
  done
  return 1
}

operations_job_uncertain() {
  # Cancellation contains the job but cannot prove whether its DB transaction
  # committed. Keep the durable record even when exact cleanup succeeds.
  [[ "${OPS_JOB_VERIFIED:-false}" != true ]] || operations_job_cancel_owned || true
  operations_job_state_read
  operations_job_state_transition "$OPS_JOB_REFERENCE" uncertain "${OPS_JOB_STATE[JOB_CONTAINER]}"
  operations_fail operations_job_uncertain
}

operations_job_override() {
  local separator='' key
  printf '{"services":{"%s":{"image":"%s","command":%s,"labels":{' "$OPS_JOB_SERVICE" "$OPS_JOB_IMAGE" "$OPS_JOB_COMMAND_JSON"
  printf '"org.opencontainers.image.revision":"%s",' "${OPS_CONFIG[FCD_SUPPORT_REVISION]}"
  printf '"fcd-support.operation.ref":"%s","fcd-support.operation.parent":"%s",' "$OPS_JOB_REFERENCE" "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}"
  printf '"fcd-support.operation.service":"%s","fcd-support.operation.command":"%s"},"environment":{' "$OPS_JOB_SERVICE" "$OPS_JOB_COMMAND_HASH"
  for key in OPS_DATABASE_SYSTEM_IDENTIFIER OPS_DATABASE_NAME OPS_DATABASE_SCHEMA OPS_DATABASE_ROLE_PREFIX OPS_SCHEMA_REVISION; do
    printf '%s"%s":"%s"' "$separator" "$key" "${OPS_JOB_TARGET[$key]}"; separator=,
  done
  printf '}}}}\n'
}

operations_job_create_stopped() {
  local key
  local -a settings=() endpoint=()
  [[ -z "${OPS_DOCKER_ENDPOINT:-}" ]] || endpoint=(--host "$OPS_DOCKER_ENDPOINT")
  for key in "${!OPS_CONFIG[@]}"; do settings+=("$key=${OPS_CONFIG[$key]}"); done
  env -i "PATH=$PATH" LC_ALL=C COMPOSE_DISABLE_ENV_FILE=1 "${settings[@]}" \
    timeout --signal=TERM --kill-after="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))s" \
    "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" \
    docker "${endpoint[@]}" compose --project-directory "$OPS_ROOT" --env-file /dev/null \
      --file "$OPS_ROOT/infra/compose.operations.yml" --file "$OPS_JOB_OVERRIDE" \
      --project-name "$OPS_JOB_PROJECT" --profile "operations-$OPS_JOB_SERVICE" \
      create --no-build --pull never --no-recreate "$OPS_JOB_SERVICE" >/dev/null 2>&1
}

operations_execute_job() {
  local service="${1:-}" argument command_path image_metadata token wait_result actual_exit acknowledgement hash
  [[ "$#" -ge 2 && "$#" -le 14 && "$service" =~ ^(bootstrap|migrate|backup|verify-backup|checkpoint|health|maintenance)$ ]] || operations_fail operations_job_arguments_invalid
  shift
  for argument in "$@"; do
    [[ "$argument" =~ ^[A-Za-z0-9_./:-]{1,256}$ ]] || operations_fail operations_job_arguments_invalid
  done
  operations_job_state_root
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || operations_fail operations_job_pending
  operations_config_field FCD_SUPPORT_REVISION "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" || operations_fail operations_job_arguments_invalid
  operations_config_field FCD_RUNTIME_PROJECT "${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" || operations_fail operations_job_arguments_invalid
  [[ "${OPS_DATABASE_SYSTEM_IDENTIFIER:-}" =~ ^[1-9][0-9]{0,19}$ ]] || operations_fail operations_job_arguments_invalid
  for argument in FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_DATABASE_ROLE_PREFIX FCD_SCHEMA_REVISION; do
    operations_config_field "$argument" "${OPS_CONFIG[$argument]:-}" || operations_fail operations_job_arguments_invalid
  done
  declare -gA OPS_JOB_TARGET=([OPS_DATABASE_SYSTEM_IDENTIFIER]="$OPS_DATABASE_SYSTEM_IDENTIFIER" [OPS_DATABASE_NAME]="${OPS_CONFIG[FCD_POSTGRES_DB]}"
    [OPS_DATABASE_SCHEMA]="${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" [OPS_DATABASE_ROLE_PREFIX]="${OPS_CONFIG[FCD_DATABASE_ROLE_PREFIX]}" [OPS_SCHEMA_REVISION]="${OPS_CONFIG[FCD_SCHEMA_REVISION]}")
  image_metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || operations_fail operations_image_invalid
  OPS_JOB_IMAGE="${image_metadata%%/*}"
  [[ "$OPS_JOB_IMAGE" =~ ^sha256:[a-f0-9]{64}$ && "$image_metadata" == "$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64" ]] || operations_fail operations_image_invalid
  token="$(od -An -N16 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || operations_fail operations_job_arguments_invalid
  OPS_JOB_REFERENCE="operation_$token"; OPS_JOB_PROJECT="fcd-support-operation-$token"; OPS_JOB_SERVICE="$service"
  OPS_JOB_CONTAINER=''; OPS_JOB_VERIFIED=false
  command_path=dist/operations-main.js
  [[ "$service" != bootstrap ]] || command_path=dist/operations/bootstrap-main.js
  OPS_JOB_COMMAND_JSON="[\"node\",\"$command_path\""
  for argument in "$@"; do OPS_JOB_COMMAND_JSON+=",\"$argument\""; done
  OPS_JOB_COMMAND_JSON+=']'
  hash="$(printf '%s' "$OPS_JOB_COMMAND_JSON" | sha256sum)"; OPS_JOB_COMMAND_HASH="${hash%% *}"
  operations_job_state_begin "$OPS_JOB_REFERENCE" "$service" "$OPS_JOB_IMAGE" "$OPS_JOB_COMMAND_HASH"
  OPS_JOB_OVERRIDE="${OPS_CONFIG[FCD_STATE_ROOT]}/job-$token.json"
  (umask 077; operations_job_override | timeout --signal=TERM --kill-after=1s "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" dd "of=$OPS_JOB_OVERRIDE" conv=excl,fsync oflag=nofollow status=none) 2>/dev/null || operations_job_uncertain
  operations_job_state_sync
  operations_job_create_stopped || operations_job_uncertain
  OPS_JOB_CONTAINER="$(operations_job_discover)" || operations_job_uncertain
  [[ "$OPS_JOB_CONTAINER" =~ ^[a-f0-9]{64}$ ]] && operations_job_assert_container created || operations_job_uncertain
  OPS_JOB_VERIFIED=true
  operations_job_state_transition "$OPS_JOB_REFERENCE" created "$OPS_JOB_CONTAINER"
  # Record before start: a lost start acknowledgement is never replay-safe.
  operations_job_state_transition "$OPS_JOB_REFERENCE" started "$OPS_JOB_CONTAINER"
  operations_docker container start "$OPS_JOB_CONTAINER" >/dev/null || operations_job_uncertain
  wait_result="$(operations_docker container wait "$OPS_JOB_CONTAINER")" || operations_job_uncertain
  [[ "$wait_result" == 0 ]] || operations_job_uncertain
  operations_job_assert_container exited || operations_job_uncertain
  actual_exit="$(operations_docker container inspect --format '{{.State.Status}}/{{.State.ExitCode}}' "$OPS_JOB_CONTAINER")" || operations_job_uncertain
  [[ "$actual_exit" == exited/0 ]] || operations_job_uncertain
  acknowledgement="$(operations_docker container logs --tail 2 "$OPS_JOB_CONTAINER")" || operations_job_uncertain
  if [[ ! "$acknowledgement" =~ ^backup_[a-f0-9]{32}$ && ! "$acknowledgement" =~ ^\{\"status\":\"completed\",\"processed\":[0-9]{1,9},\"reasonCode\":\"ok\"\}$ ]]; then operations_job_uncertain; fi
  operations_job_remove_exited || operations_job_uncertain
  [[ -f "$OPS_JOB_OVERRIDE" && ! -L "$OPS_JOB_OVERRIDE" && "$(stat -c '%u:%g:%a:%h' -- "$OPS_JOB_OVERRIDE")" == 1000:1000:600:1 ]] || operations_job_uncertain
  rm -- "$OPS_JOB_OVERRIDE" || operations_fail operations_job_uncertain
  operations_job_state_sync
  operations_job_state_transition "$OPS_JOB_REFERENCE" completed "$OPS_JOB_CONTAINER"
  operations_job_state_clear "$OPS_JOB_REFERENCE"
  printf '%s\n' "$acknowledgement"
}
