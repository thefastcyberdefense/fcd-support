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
  printf '"fcd-support.operation.service":"%s","fcd-support.operation.command":"%s"},"environment":{"OPS_OPERATION_REFERENCE":"%s"' "$OPS_JOB_SERVICE" "$OPS_JOB_COMMAND_HASH" "$OPS_JOB_REFERENCE"
  separator=,
  for key in OPS_DATABASE_SYSTEM_IDENTIFIER OPS_DATABASE_NAME OPS_DATABASE_SCHEMA OPS_DATABASE_ROLE_PREFIX OPS_SCHEMA_REVISION; do
    printf '%s"%s":"%s"' "$separator" "$key" "${OPS_JOB_TARGET[$key]}"; separator=,
  done
  if [[ "$OPS_JOB_SERVICE" == restore || "$OPS_JOB_SERVICE" == restore-reconcile || "$OPS_JOB_SERVICE" == promote ]]; then
    for key in OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER OPS_SOURCE_DATABASE_NAME; do
      printf ',"%s":"%s"' "$key" "${OPS_JOB_TARGET[$key]}"
    done
  fi
  printf '}'
  # Only health reads a bounded, content-free host input. Keep every other
  # operation's stdin closed so a lost pipe cannot hold it open indefinitely.
  [[ "$OPS_JOB_SERVICE" != health && "$OPS_JOB_SERVICE" != promote ]] || printf ',"stdin_open":true'
  printf '}}'
  if [[ "$OPS_JOB_SERVICE" == bootstrap ]] && declare -F operations_selection_read >/dev/null; then
    operations_selection_read || return 1
    if [[ "${OPS_SELECTION[STATE_RESTORE_REF]:-none}" != none ]]; then
      [[ "${OPS_SELECTION[STATE_RESTORE_REF]}" =~ ^restore_[a-f0-9]{32}$ && "${OPS_SELECTION[STATE_VOLUME_ORIGIN]:-}" =~ ^fcd-support-restore-[a-z0-9-]+$ &&
        "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" && "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "${OPS_JOB_TARGET[OPS_DATABASE_SYSTEM_IDENTIFIER]}" ]] || return 1
      operations_absolute_path "${OPS_CONFIG[FCD_SECRET_ROOT]}" || return 1
      printf ',"secrets":{"bootstrap-database":{"file":"%s/restore/restore-database"}}' "${OPS_CONFIG[FCD_SECRET_ROOT]}"
    fi
  fi
  printf '}\n'
}

operations_job_command() {
  local service="$1" command_path argument; shift
  command_path=dist/operations-main.js
  case "$service" in
    bootstrap) command_path=dist/operations/bootstrap-main.js ;;
    restore|restore-reconcile)
      [[ "$#" == 5 && "$1" == restore && "$2" =~ ^restore_[a-f0-9]{32}$ && "$3" =~ ^backup_[a-f0-9]{32}$ && "$4" =~ ^checkpoint_[a-f0-9]{32}$ && ${#5} -ge 4 && ${#5} -le 5464 && "$5" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
      (( ${#5} % 4 == 0 )) || return 1
      if [[ "$service" == restore ]]; then command_path=dist/operations/restore-stream-main.js; else command_path=dist/operations/restore-reconcile-main.js; fi ;;
    restore-bootstrap)
      [[ "$#" == 3 && ( "$1" == prepare || "$1" == converge ) && "$2" =~ ^[1-9][0-9]{0,19}$ && "$3" == /run/secrets ]] || return 1
      command_path=dist/operations/bootstrap-main.js ;;
    restore-migrate)
      [[ "$#" == 2 && "$1" == migrate && "$2" =~ ^[1-9][0-9]{0,19}$ ]] || return 1
      command_path=dist/operations/restore-migrate-main.js ;;
    promote)
      [[ "$#" == 6 && "$1" == promote && "$2" =~ ^restore_[a-f0-9]{32}$ && "$3" =~ ^restore_[a-f0-9]{32}$ && "$2" != "$3" && "$4" =~ ^backup_[a-f0-9]{32}$ && "$5" =~ ^checkpoint_[a-f0-9]{32}$ && ${#6} -ge 4 && ${#6} -le 5464 && "$6" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
      (( ${#6} % 4 == 0 )) || return 1
      declare -F operations_promotion_host_check >/dev/null || return 1
      command_path=dist/operations/promotion-main.js ;;
    health)
      [[ "$#" == 1 && "$1" == health ]] || return 1
      OPS_HEALTH_INPUT_JSON="${OPS_HEALTH_INPUT_JSON-'{}'}"
      (( ${#OPS_HEALTH_INPUT_JSON} >= 1 && ${#OPS_HEALTH_INPUT_JSON} <= 16384 )) || return 1
      command_path=dist/operations/health-main.js ;;
  esac
  OPS_JOB_COMMAND="$1"
  OPS_JOB_COMMAND_JSON="[\"node\",\"$command_path\""
  for argument in "$@"; do OPS_JOB_COMMAND_JSON+=",\"$argument\""; done
  OPS_JOB_COMMAND_JSON+=']'
}

operations_job_start() {
  if [[ "$OPS_JOB_SERVICE" == promote ]]; then
    operations_job_promotion_exchange
  elif [[ "$OPS_JOB_SERVICE" == health ]]; then
    printf '%s' "$OPS_HEALTH_INPUT_JSON" | operations_docker container start --attach --interactive "$OPS_JOB_CONTAINER" >/dev/null
  else
    operations_docker container start "$OPS_JOB_CONTAINER" >/dev/null
  fi
}

# The job retains the source SQL freeze while the checked host answers two
# fresh challenges. No reusable proof file or host socket enters the container.
operations_job_promotion_exchange() {
  local promotion_read promotion_write promotion_pid line prefix nonce previous='' sequence failed=false
  OPS_PROMOTION_ACK=''; OPS_PROMOTION_TRANSCRIPT=''
  declare -F operations_promotion_host_check >/dev/null || return 1
  coproc OPS_PROMOTION_PIPE { operations_docker container start --attach --interactive "$OPS_JOB_CONTAINER" 2>/dev/null; }
  promotion_pid="$OPS_PROMOTION_PIPE_PID"
  exec {promotion_read}<&"${OPS_PROMOTION_PIPE[0]}" {promotion_write}>&"${OPS_PROMOTION_PIPE[1]}" || return 1
  for sequence in 1 2; do
    if ! IFS= read -r -n 1025 -t "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}" -u "$promotion_read" line; then failed=true; break; fi
    prefix="{\"event\":\"promotion_host_check\",\"operationRef\":\"$OPS_JOB_REFERENCE\",\"sequence\":$sequence,\"challenge\":\""
    if [[ ${#line} -gt 1024 || ! "$line" =~ ^"$prefix"([a-f0-9]{32})'"}'$ ]]; then failed=true; break; fi
    nonce="${BASH_REMATCH[1]}"
    if [[ "$nonce" == "$previous" ]] || ! operations_promotion_host_check >/dev/null 2>&1; then failed=true; break; fi
    previous="$nonce"
    OPS_PROMOTION_TRANSCRIPT+="$line"$'\n'
    if ! printf '{"event":"promotion_host_verified","operationRef":"%s","sequence":%s,"challenge":"%s"}\n' "$OPS_JOB_REFERENCE" "$sequence" "$nonce" >&"$promotion_write"; then failed=true; break; fi
  done
  if [[ "$failed" == false ]]; then
    if IFS= read -r -n 1025 -t "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}" -u "$promotion_read" line && [[ "$line" == '{"status":"completed","processed":1,"reasonCode":"ok"}' ]]; then
      OPS_PROMOTION_ACK="$line"; OPS_PROMOTION_TRANSCRIPT+="$line"
    else failed=true; fi
  fi
  exec {promotion_write}>&- {promotion_read}<&-
  if [[ "$failed" == true ]]; then
    operations_docker container logs --tail 32 "$OPS_JOB_CONTAINER" >&3 2>/dev/null || true
    kill "$promotion_pid" 2>/dev/null || true
    wait "$promotion_pid" 2>/dev/null || true
    OPS_PROMOTION_ACK=''; OPS_PROMOTION_TRANSCRIPT=''
    return 1
  fi
  wait "$promotion_pid" || return 1
}

operations_job_acknowledgement() {
  local acknowledgement="$1"
  case "$OPS_JOB_SERVICE/$OPS_JOB_COMMAND" in
    checkpoint/export-checkpoint-reference)
      [[ "$acknowledgement" =~ ^checkpoint_[a-f0-9]{32}$ ]]; return ;;
    restore/restore|restore-bootstrap/prepare|restore-bootstrap/converge|restore-migrate/migrate|restore-reconcile/restore|promote/promote)
      [[ "$acknowledgement" == '{"status":"completed","processed":1,"reasonCode":"ok"}' ]]; return ;;
    backup/pre-migration-backup|backup/scheduled-backup)
      [[ "$acknowledgement" =~ ^backup_[a-f0-9]{32}$ ]]; return ;;
    health/health)
      [[ "$acknowledgement" != '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}' ]] || return 0 ;;
    backup/backup|maintenance/retention|maintenance/deletion|maintenance/lease_recovery|maintenance/learning)
      [[ "$acknowledgement" != '{"status":"skipped","processed":0,"reasonCode":"not_due"}' ]] || return 0 ;;
  esac
  [[ "$acknowledgement" =~ ^\{\"status\":\"completed\",\"processed\":(0|[1-9][0-9]{0,8}),\"reasonCode\":\"ok\"\}$ ]]
}

operations_job_create_stopped() {
  local key file=compose.operations.yml profile="operations-$OPS_JOB_SERVICE"
  case "$OPS_JOB_SERVICE" in
    restore) file=compose.restore.yml; profile=isolated-restore ;;
    restore-bootstrap|restore-migrate|restore-reconcile) file=compose.restore.yml; profile="$OPS_JOB_SERVICE" ;;
    promote) file=compose.restore.yml; profile=restore-promote ;;
  esac
  local -a settings=() endpoint=()
  [[ -z "${OPS_DOCKER_ENDPOINT:-}" ]] || endpoint=(--host "$OPS_DOCKER_ENDPOINT")
  for key in "${!OPS_CONFIG[@]}"; do settings+=("$key=${OPS_CONFIG[$key]}"); done
  env -i "PATH=$PATH" LC_ALL=C COMPOSE_DISABLE_ENV_FILE=1 "${settings[@]}" \
    timeout --signal=TERM --kill-after="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))s" \
    "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" \
    docker "${endpoint[@]}" compose --project-directory "$OPS_ROOT" --env-file /dev/null \
      --file "$OPS_ROOT/infra/$file" --file "$OPS_JOB_OVERRIDE" \
      --project-name "$OPS_JOB_PROJECT" --profile "$profile" \
      create --no-build --pull never --no-recreate "$OPS_JOB_SERVICE" >/dev/null 2>&1
}

operations_execute_job() {
  local service="${1:-}" argument image_metadata token wait_result actual_exit acknowledgement hash index=0
  [[ "$#" -ge 2 && "$#" -le 14 && "$service" =~ ^(bootstrap|migrate|backup|verify-backup|checkpoint|health|maintenance|restore|restore-bootstrap|restore-migrate|restore-reconcile|promote)$ ]] || operations_fail operations_job_arguments_invalid
  shift
  for argument in "$@"; do
    (( index += 1 ))
    if [[ ( "$service" == restore || "$service" == restore-reconcile ) && "$index" == 5 || "$service" == promote && "$index" == 6 ]]; then
      [[ ${#argument} -ge 4 && ${#argument} -le 5464 && "$argument" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || operations_fail operations_job_arguments_invalid
    else
      [[ ${#argument} -ge 1 && ${#argument} -le 256 && "$argument" =~ ^[A-Za-z0-9_./:-]+$ ]] || operations_fail operations_job_arguments_invalid
    fi
  done
  operations_job_command "$service" "$@" || operations_fail operations_job_arguments_invalid
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
  if [[ "$service" == restore || "$service" == restore-bootstrap || "$service" == restore-migrate || "$service" == restore-reconcile || "$service" == promote ]]; then
    [[ "${OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER:-}" =~ ^[1-9][0-9]{0,19}$ && "$OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER" != "$OPS_DATABASE_SYSTEM_IDENTIFIER" ]] || operations_fail operations_job_arguments_invalid
    operations_config_field FCD_RESTORE_PROJECT "${OPS_CONFIG[FCD_RESTORE_PROJECT]:-}" || operations_fail operations_job_arguments_invalid
    operations_config_field FCD_RESTORE_VOLUME "${OPS_CONFIG[FCD_RESTORE_VOLUME]:-}" || operations_fail operations_job_arguments_invalid
    OPS_JOB_TARGET[OPS_DATABASE_SYSTEM_IDENTIFIER]="$OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER"
    if [[ "$service" == restore || "$service" == restore-reconcile || "$service" == promote ]]; then
      OPS_JOB_TARGET[OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER]="$OPS_DATABASE_SYSTEM_IDENTIFIER"
      OPS_JOB_TARGET[OPS_SOURCE_DATABASE_NAME]="${OPS_CONFIG[FCD_POSTGRES_DB]}"
    fi
  fi
  image_metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || operations_fail operations_image_invalid
  OPS_JOB_IMAGE="${image_metadata%%/*}"
  [[ "$OPS_JOB_IMAGE" =~ ^sha256:[a-f0-9]{64}$ && "$image_metadata" == "$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64" ]] || operations_fail operations_image_invalid
  token="$(od -An -N16 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || operations_fail operations_job_arguments_invalid
  OPS_JOB_REFERENCE="operation_$token"; OPS_JOB_PROJECT="fcd-support-operation-$token"; OPS_JOB_SERVICE="$service"
  OPS_JOB_CONTAINER=''; OPS_JOB_VERIFIED=false
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
  operations_job_start || operations_job_uncertain
  wait_result="$(operations_docker container wait "$OPS_JOB_CONTAINER")" || operations_job_uncertain
  [[ "$wait_result" == 0 ]] || operations_job_uncertain
  operations_job_assert_container exited || operations_job_uncertain
  actual_exit="$(operations_docker container inspect --format '{{.State.Status}}/{{.State.ExitCode}}' "$OPS_JOB_CONTAINER")" || operations_job_uncertain
  [[ "$actual_exit" == exited/0 ]] || operations_job_uncertain
  if [[ "$service" == promote ]]; then
    acknowledgement="$(operations_docker container logs --tail 4 "$OPS_JOB_CONTAINER")" || operations_job_uncertain
    [[ "$acknowledgement" == "$OPS_PROMOTION_TRANSCRIPT" ]] || operations_job_uncertain
    acknowledgement="$OPS_PROMOTION_ACK"
  else
    acknowledgement="$(operations_docker container logs --tail 2 "$OPS_JOB_CONTAINER")" || operations_job_uncertain
  fi
  operations_job_acknowledgement "$acknowledgement" || operations_job_uncertain
  operations_job_remove_exited || operations_job_uncertain
  [[ -f "$OPS_JOB_OVERRIDE" && ! -L "$OPS_JOB_OVERRIDE" && "$(stat -c '%u:%g:%a:%h' -- "$OPS_JOB_OVERRIDE")" == 1000:1000:600:1 ]] || operations_job_uncertain
  rm -- "$OPS_JOB_OVERRIDE" || operations_fail operations_job_uncertain
  operations_job_state_sync
  operations_job_state_transition "$OPS_JOB_REFERENCE" completed "$OPS_JOB_CONTAINER"
  operations_job_state_clear "$OPS_JOB_REFERENCE"
  printf '%s\n' "$acknowledgement"
}
