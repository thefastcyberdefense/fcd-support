#!/usr/bin/env bash
# Read-only live promotion proof. Caller retains the deployment lock, protected
# configuration, exact revision and local Docker endpoint. Never source in a job.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-runtime-host.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-restore-host.sh"

operations_promotion_host_context() {
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_PHASE]}" == quiescent && "${OPS_SELECTION[STATE_REF]}" == "$OPS_PH_SELECTION" &&
    "${OPS_SELECTION[STATE_VOLUME]}" == "$OPS_PH_VOLUME" && "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" == "$OPS_PH_VOLUME" &&
    "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "$OPS_PH_SYSTEM" && "${OPS_SELECTION[STATE_REVISION]}" == "$OPS_PH_REVISION" &&
    "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" ]] || return 1
  [[ "$(operations_selection_body)" == "$OPS_PH_SELECTION_BODY" && "$OPS_SELECTION_FILE_ID" == "$OPS_PH_SELECTION_FILE_ID" &&
    "$OPS_SELECTION_FILE_SHA256" == "$OPS_PH_SELECTION_SHA256" ]] || return 1
  operations_job_state_same_file || return 1
  [[ "${OPS_JOB_STATE[JOB_PHASE]}" == started && "${OPS_JOB_STATE[JOB_REF]}" == "$OPS_JOB_REFERENCE" &&
    "${OPS_JOB_STATE[JOB_CONTAINER]}" == "$OPS_JOB_CONTAINER" && "${OPS_JOB_STATE[JOB_SERVICE]}" == promote &&
    "${OPS_JOB_STATE[JOB_IMAGE]}" == "$OPS_JOB_IMAGE" && "${OPS_JOB_STATE[JOB_COMMAND_SHA256]}" == "$OPS_JOB_COMMAND_HASH" &&
    "${OPS_JOB_STATE[JOB_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || return 1
  operations_job_assert_container running && [[ "$(operations_job_discover)" == "$OPS_JOB_CONTAINER" ]]
}

operations_promotion_host_network() {
  local metadata peers
  peers="$(operations_docker network inspect --format '{{range $id,$member := .Containers}}{{println $id}}{{end}}' "$1")" || return 1
  peers="$(operations_runtime_ids "$peers")" || return 1
  metadata="$(operations_docker network inspect --format "$OPERATIONS_RUNTIME_NETWORK_FORMAT" "$1")" || return 1
  printf '%s,"members":%s}' "$metadata" "$peers"
}

operations_promotion_host_volume() {
  local metadata users
  metadata="$(operations_docker volume inspect --format "$OPERATIONS_RUNTIME_VOLUME_FORMAT" "$1")" || return 1
  users="$(operations_docker ps --all --quiet --no-trunc --filter "volume=$1")" || return 1
  users="$(operations_runtime_ids "$users")" || return 1
  printf '%s,"users":%s}' "$metadata" "$users"
}

operations_promotion_host_environment() {
  # Only names and these fixed nonsecret path/identity settings enter stdio.
  # Never project unknown values or a complete Config.Env array.
  local template='{ {{$first := true}}' key
  for key in NODE_ENV OPS_GIT_REVISION OPS_OPERATION_REFERENCE OPS_DATABASE_SYSTEM_IDENTIFIER OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER OPS_DATABASE_NAME OPS_SOURCE_DATABASE_NAME OPS_DATABASE_SCHEMA OPS_DATABASE_ROLE_PREFIX OPS_SCHEMA_REVISION RESTORE_SOURCE_SERVICE_ALIAS RESTORE_TARGET_SERVICE_ALIAS RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE RESTORE_TARGET_OWNER_DATABASE_URL_FILE PRIVACY_HMAC_KEYRING_FILE BACKUP_AGE_IDENTITY_FILE RECOVERY_MANIFEST_HMAC_FILE MODEL_EXECUTION_ENABLED OUTBOUND_EXECUTION_ENABLED N8N_EXECUTION_ENABLED CHECKPOINT_ARCHIVE_DIRECTORY PG_MAJOR PG_VERSION PGDATA PG_SHA256; do
    template+='{{range .Config.Env}}{{if eq (index (split . "=") 0) "'"$key"'"}}{{if $first}}{{$first = false}}{{else}},{{end}}'"\"$key\":"'{{json (slice . '"$((${#key}+1))"')}}{{end}}{{end}}'
  done
  template+='}'
  operations_docker container inspect --format "$template" "$OPS_JOB_CONTAINER"
}

operations_promotion_host_binds() {
  local ids id raw path canonical separator='' count=0
  ids="$(operations_docker ps --all --quiet --no-trunc)" || return 1
  (( ${#ids} > 0 && ${#ids} <= 16640 )) || return 1
  printf '['
  while IFS= read -r id; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    raw="$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$id")" || return 1
    (( ${#raw} <= 65536 )) || return 1
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      (( count += 1 )); (( count <= 512 )) || return 1
      operations_absolute_path "$path" || return 1
      canonical="$(realpath -e -- "$path" 2>/dev/null)" || return 1
      operations_absolute_path "$canonical" || return 1
      printf '%s{"containerId":"%s","source":"%s","canonicalSource":"%s"}' "$separator" "$id" "$path" "$canonical"; separator=,
    done <<<"$raw"
  done <<<"$ids"
  printf ']'
}

operations_promotion_host_snapshot() {
  local source target job source_image target_image runtime_image source_networks='' target_network role separator='' source_volume target_volume archive_volume source_actors target_actors job_actors target_id source_system target_system environment labels binds source_terminal target_terminal
  operations_promotion_host_context || return 1
  source_actors="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  [[ "$source_actors" == "$OPS_PH_SOURCE" ]] || return 1
  target_actors="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RESTORE_PROJECT]}")" || return 1
  [[ "$target_actors" =~ ^[a-f0-9]{64}$ ]] || return 1
  target_id="$target_actors"
  job_actors="$(operations_job_discover)" || return 1
  [[ "$job_actors" == "$OPS_JOB_CONTAINER" ]] || return 1
  source="$(operations_docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$OPS_PH_SOURCE")" || return 1
  target="$(operations_docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$target_id")" || return 1
  job="$(operations_docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$OPS_JOB_CONTAINER")" || return 1
  source_image="$(operations_docker image inspect --format "$OPERATIONS_RUNTIME_IMAGE_FORMAT" "$OPS_PH_IMAGE")" || return 1
  target_image="$(operations_docker image inspect --format "$OPERATIONS_RUNTIME_IMAGE_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_IMAGE]}")" || return 1
  runtime_image="$(operations_docker image inspect --format "$OPERATIONS_RUNTIME_IMAGE_FORMAT" "${OPS_CONFIG[FCD_SUPPORT_IMAGE]}")" || return 1
  for role in webhook admin reply outbound notification operations; do
    source_networks+="$separator$(operations_promotion_host_network "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}-$role-data")" || return 1; separator=,
  done
  target_network="$(operations_promotion_host_network "${OPS_CONFIG[FCD_RESTORE_PROJECT]}-data")" || return 1
  source_volume="$(operations_promotion_host_volume "$OPS_PH_VOLUME")" || return 1
  target_volume="$(operations_promotion_host_volume "${OPS_CONFIG[FCD_RESTORE_VOLUME]}")" || return 1
  archive_volume="$(operations_docker volume inspect --format '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"mountpoint":{{json .Mountpoint}}}' "${OPS_CONFIG[FCD_BACKUP_VOLUME]}")" || return 1
  environment="$(operations_promotion_host_environment)" || return 1
  labels="$(operations_docker container inspect --format '{"reference":{{json (index .Config.Labels "fcd-support.operation.ref")}},"parent":{{json (index .Config.Labels "fcd-support.operation.parent")}},"service":{{json (index .Config.Labels "fcd-support.operation.service")}},"commandHash":{{json (index .Config.Labels "fcd-support.operation.command")}}}' "$OPS_JOB_CONTAINER")" || return 1
  binds="$(operations_promotion_host_binds)" || return 1
  # Only physical pg_controldata is executed here; the job owns checkpoint/SQL.
  source_system="$(operations_read_database_control_identifier "$OPS_PH_SOURCE")" || return 1
  target_system="$(operations_read_database_control_identifier "$target_id")" || return 1
  source_terminal="$(operations_docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$OPS_PH_SOURCE")" || return 1
  target_terminal="$(operations_docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$target_id")" || return 1
  operations_promotion_host_context || return 1
  printf '{"source":{"postgres":%s,"terminal":%s,"image":%s,"networks":[%s],"volume":%s,"projectActors":["%s"],"systemIdentifier":"%s","selectionReference":"%s"},"target":{"postgres":%s,"terminal":%s,"image":%s,"network":%s,"volume":%s,"projectActors":["%s"],"systemIdentifier":"%s"},"job":%s,"jobEnvironment":%s,"jobLabels":%s,"jobProjectActors":["%s"],"runtimeImage":%s,"archiveVolume":%s,"hostBinds":%s}' \
    "$source" "$source_terminal" "$source_image" "$source_networks" "$source_volume" "$source_actors" "$source_system" "$OPS_PH_SELECTION" "$target" "$target_terminal" "$target_image" "$target_network" "$target_volume" "$target_actors" "$target_system" "$job" "$environment" "$labels" "$job_actors" "$runtime_image" "$archive_volume" "$binds"
}

operations_promotion_host_secrets() {
  local secret owner
  # Resolve only fixed credential paths; no secret bytes are read or emitted.
  for secret in restore/restore-checkpoint-database restore/restore-database restore/restore-keyring verify-backup/restore-identity backup/recovery-hmac postgres/postgres-password restore/restore-postgres-password; do
    case "$secret" in
      postgres/postgres-password|restore/restore-postgres-password) owner=999:999 ;;
      *) owner=1000:1000 ;;
    esac
    secret="${OPS_CONFIG[FCD_SECRET_ROOT]}/$secret"
    [[ -f "$secret" && ! -L "$secret" && "$(realpath -e -- "$secret" 2>/dev/null)" == "$secret" && "$(stat -c '%u:%g:%h' -- "$secret")" == "$owner:1" && ( "$(stat -c '%a' -- "$secret")" == 600 || "$(stat -c '%a' -- "$secret")" == 400 ) ]] && operations_protected_ancestors "$(dirname -- "$secret")" || return 1
  done
}

operations_inspect_promotion_host() (
  local bound="${1:-}" field before after result image volume_project volume_logical options payload
  [[ "$#" == 7 && ${#bound} -ge 2 && ${#bound} -le 2048 && "$2" =~ ^[a-f0-9]{64}$ && "$3" =~ ^fcd-support[-a-z0-9_]{1,100}$ && "$4" =~ ^[1-9][0-9]{0,19}$ && "$5" =~ ^selection_[a-f0-9]{32}$ && "$6" =~ ^[a-f0-9]{40}$ && "$7" =~ ^sha256:[a-f0-9]{64}$ ]] || operations_fail promotion_host_invalid
  local OPS_PH_SOURCE="$2" OPS_PH_VOLUME="$3" OPS_PH_SYSTEM="$4" OPS_PH_SELECTION="$5" OPS_PH_REVISION="$6" OPS_PH_IMAGE="$7" OPS_PH_SELECTION_BODY OPS_PH_SELECTION_FILE_ID OPS_PH_SELECTION_SHA256
  for field in FCD_RUNTIME_PROJECT FCD_RESTORE_PROJECT FCD_POSTGRES_VOLUME FCD_RESTORE_VOLUME FCD_BACKUP_VOLUME FCD_SUPPORT_REVISION FCD_SUPPORT_IMAGE FCD_POSTGRES_IMAGE FCD_OPERATIONS_IMAGE FCD_SECRET_ROOT FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_DATABASE_ROLE_PREFIX FCD_SCHEMA_REVISION FCD_STOP_GRACE_MS FCD_RESTORE_CPUS FCD_RESTORE_MEMORY_MIB FCD_RESTORE_PIDS FCD_RESTORE_TMPFS_MIB FCD_POSTGRES_CPUS FCD_POSTGRES_MEMORY_MIB FCD_POSTGRES_PIDS FCD_POSTGRES_TMPFS_MIB; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || operations_fail promotion_host_invalid
  done
  [[ "${OPS_JOB_SERVICE:-}" == promote && "${OPS_JOB_CONTAINER:-}" =~ ^[a-f0-9]{64}$ && "${OPS_JOB_IMAGE:-}" =~ ^sha256:[a-f0-9]{64}$ && "${OPS_JOB_REFERENCE:-}" =~ ^operation_[a-f0-9]{32}$ && "${OPS_JOB_PROJECT:-}" == "fcd-support-operation-${OPS_JOB_REFERENCE#operation_}" && "${OPS_JOB_COMMAND_HASH:-}" =~ ^[a-f0-9]{64}$ && ${#OPS_JOB_COMMAND_JSON} -le 8192 && "${OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER:-}" =~ ^[1-9][0-9]{0,19}$ && "$OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER" != "$OPS_PH_SYSTEM" ]] || operations_fail promotion_host_invalid
  image="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || operations_fail promotion_host_invalid
  [[ "$image" == "$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64/node" || "$image" == "$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64/1000" || "$image" == "$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64/1000:1000" ]] || operations_fail promotion_host_invalid
  operations_promotion_host_secrets || operations_fail promotion_host_invalid
  operations_job_state_read
  operations_selection_read
  OPS_PH_SELECTION_BODY="$(operations_selection_body)" || operations_fail promotion_host_invalid
  OPS_PH_SELECTION_FILE_ID="$OPS_SELECTION_FILE_ID"; OPS_PH_SELECTION_SHA256="$OPS_SELECTION_FILE_SHA256"
  operations_promotion_host_context || operations_fail promotion_host_invalid
  volume_project="${OPS_SELECTION[STATE_VOLUME_ORIGIN]}"; volume_logical="${OPS_SELECTION[STATE_VOLUME_LOGICAL]}"
  if [[ "$volume_project" == none ]]; then volume_project=null; volume_logical=null; else volume_project="\"$volume_project\""; volume_logical="\"$volume_logical\""; fi
  options="$(printf '{"expectedHost":%s,"runtimeProject":"%s","sourceContainerId":"%s","sourceVolumeName":"%s","sourceSystemIdentifier":"%s","sourceSelectionReference":"%s","sourceRevision":"%s","sourcePostgresImageId":"%s","targetSystemIdentifier":"%s","gitRevision":"%s","secretRoot":"%s","backupVolumeName":"%s","databaseName":"%s","databaseSchema":"%s","rolePrefix":"%s","schemaRevision":"%s","job":{"id":"%s","reference":"%s","project":"%s","imageId":"%s","command":%s,"commandHash":"%s"},"sourceVolumeIdentity":{"project":%s,"logicalName":%s,"createdAt":"%s"},"limits":{"postgres":{"cpus":%s,"memoryMiB":%s,"pids":%s,"tmpfsMiB":%s},"job":{"cpus":%s,"memoryMiB":%s,"pids":%s,"tmpfsMiB":%s},"stopTimeoutSeconds":%s}}' "$bound" "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" "$OPS_PH_SOURCE" "$OPS_PH_VOLUME" "$OPS_PH_SYSTEM" "$OPS_PH_SELECTION" "$OPS_PH_REVISION" "$OPS_PH_IMAGE" "$OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" "${OPS_CONFIG[FCD_BACKUP_VOLUME]}" "${OPS_CONFIG[FCD_POSTGRES_DB]}" "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" "${OPS_CONFIG[FCD_DATABASE_ROLE_PREFIX]}" "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" "$OPS_JOB_CONTAINER" "$OPS_JOB_REFERENCE" "$OPS_JOB_PROJECT" "$OPS_JOB_IMAGE" "$OPS_JOB_COMMAND_JSON" "$OPS_JOB_COMMAND_HASH" "$volume_project" "$volume_logical" "${OPS_SELECTION[STATE_VOLUME_CREATED_AT]}" "${OPS_CONFIG[FCD_POSTGRES_CPUS]}" "${OPS_CONFIG[FCD_POSTGRES_MEMORY_MIB]}" "${OPS_CONFIG[FCD_POSTGRES_PIDS]}" "${OPS_CONFIG[FCD_POSTGRES_TMPFS_MIB]}" "${OPS_CONFIG[FCD_RESTORE_CPUS]}" "${OPS_CONFIG[FCD_RESTORE_MEMORY_MIB]}" "${OPS_CONFIG[FCD_RESTORE_PIDS]}" "${OPS_CONFIG[FCD_RESTORE_TMPFS_MIB]}" "$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))")"
  before="$(operations_promotion_host_snapshot)" || operations_fail promotion_host_invalid
  after="$(operations_promotion_host_snapshot)" || operations_fail promotion_host_invalid
  payload="$(printf '{"options":%s,"samples":{"before":%s,"after":%s}}' "$options" "$before" "$after")"
  (( ${#payload} <= 524288 )) || operations_fail promotion_host_invalid
  result="$({ printf '%s' "$payload" | operations_docker run --rm --interactive --pull never --network none --read-only --user 1000:1000 \
    --label "fcd-support.promotion-inspection=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
    --cpus "${OPS_CONFIG[FCD_RESTORE_CPUS]}" --memory "${OPS_CONFIG[FCD_RESTORE_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_RESTORE_PIDS]}" \
    --entrypoint node "$OPS_JOB_IMAGE" dist/operations/promotion-host-main.js; } 2>/dev/null)" || operations_fail promotion_host_invalid
  operations_promotion_host_context || operations_fail promotion_host_invalid
  [[ "$result" == "$bound" ]] || operations_fail promotion_host_invalid
  printf '%s\n' "$bound"
)
