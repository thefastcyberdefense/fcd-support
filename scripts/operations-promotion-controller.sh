#!/usr/bin/env bash
# Locked fresh-promotion composition. Historical restore records only select
# resources; two live SQL/host exchanges and a final proof precede attachment.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-restore-controller.sh"

# Fixed metadata allowlists deliberately omit credentials and container Env.
# Full mount identities are compared in memory; they are never logged/emitted.
OPERATIONS_PROMOTION_STATIC_FORMAT='{{.Id}}/{{.Image}}/{{json .Config.Cmd}}/{{json .Config.Entrypoint}}/{{json .Mounts}}/{{json .HostConfig.NetworkMode}}/{{.HostConfig.ReadonlyRootfs}}/{{.HostConfig.Privileged}}/{{len .HostConfig.PortBindings}}/{{.HostConfig.PublishAllPorts}}/{{json .HostConfig.CapAdd}}/{{json .HostConfig.CapDrop}}/{{json .HostConfig.SecurityOpt}}/{{.HostConfig.Memory}}/{{.HostConfig.NanoCpus}}/{{.HostConfig.PidsLimit}}/{{json .HostConfig.PidMode}}/{{json .HostConfig.IpcMode}}/{{range $name,$network := .NetworkSettings.Networks}}{{$name}}/{{$network.NetworkID}};{{end}}'
OPERATIONS_PROMOTION_NETWORK_FORMAT='{{.Id}}/{{.Name}}/{{.Driver}}/{{.Internal}}/{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.network"}}'

operations_promotion_volume_facts() {
  local volume
  for volume in "${!OPS_PROMOTION_VOLUME_FACTS[@]}"; do
    [[ "$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "$volume")" == "${OPS_PROMOTION_VOLUME_FACTS[$volume]}" ]] || return 1
  done
}

# Capture only after the complete source/target inspectors have established
# hardening and ownership. This snapshot binds every subsequent destructive
# actor action to the exact inspected instance; it is not independent authority.
operations_promotion_capture_postgres() {
  local id="$1" project="$2" volume="$3" image="$4" revision="$5" system="$6" row prefix tail static image_meta names network fact logical count=0 volume_fact name created rest
  [[ "$#" == 6 && "$id" =~ ^[a-f0-9]{64}$ && -z "${OPS_PROMOTION_ACTORS[$id]:-}" &&
    "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ ]] || return 1
  operations_config_field FCD_RUNTIME_PROJECT "$project" && operations_config_field FCD_POSTGRES_VOLUME "$volume" && operations_deployment_field STATE_SYSTEM_IDENTIFIER "$system" || return 1
  row="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" || return 1
  prefix="$id/$project/postgres/$revision/$image/running/true/false/false/false/"
  [[ "$row" == "$prefix"* ]] || return 1
  tail="${row#"$prefix"}"
  [[ "$tail" =~ ^(postgres|999|999:999)/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || return 1
  image_meta="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$image")" || return 1
  [[ "$image_meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(postgres|999|999:999)$ && "$image_meta" == "$image/$revision/"* ]] || return 1
  static="$(operations_docker container inspect --format "$OPERATIONS_PROMOTION_STATIC_FORMAT" "$id")" || return 1
  (( ${#static} > 0 && ${#static} <= 65536 )) || return 1
  volume_fact="$(operations_docker volume inspect --format "$OPERATIONS_POSTGRES_VOLUME_FORMAT" "$volume")" || return 1
  IFS=/ read -r name created rest <<<"$volume_fact"
  [[ "$name" == "$volume" && "$rest" == local/local/default/* ]] && operations_deployment_field STATE_VOLUME_CREATED_AT "$created" || return 1
  names="$(operations_docker container inspect --format '{{range $name,$network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$id")" || return 1
  (( ${#names} > 0 && ${#names} <= 2048 )) || return 1
  local -A seen=()
  while IFS= read -r network; do
    [[ -z "${seen[$network]:-}" ]] || return 1
    seen[$network]=yes; (( count += 1 )); (( count <= 6 )) || return 1
    if [[ "$project" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" ]]; then
      case "$network" in "$project-webhook-data"|"$project-admin-data"|"$project-reply-data"|"$project-outbound-data"|"$project-notification-data"|"$project-operations-data") ;; *) return 1 ;; esac
      logical="${network#"$project-"}"; logical="${logical//-/_}"
    else
      [[ "$project" == "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" && "$network" == "$project-data" ]] || return 1
      logical=restore_data
    fi
    fact="$(operations_docker network inspect --format "$OPERATIONS_PROMOTION_NETWORK_FORMAT" "$network")" || return 1
    [[ "$fact" =~ ^[a-f0-9]{64}/ && "$fact" == "${fact%%/*}/$network/bridge/true/$project/$logical" ]] || return 1
    OPS_PROMOTION_NETWORK_FACTS["$id|$network"]="$fact"
  done <<<"$names"
  if [[ "$project" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" ]]; then (( count == 6 )) || return 1; else (( count == 1 )) || return 1; fi
  OPS_PROMOTION_ACTORS[$id]="$row"; OPS_PROMOTION_STATIC[$id]="$static"; OPS_PROMOTION_VOLUMES[$id]="$volume"; OPS_PROMOTION_PROJECTS[$id]="$project"
  OPS_PROMOTION_SYSTEMS[$id]="$system"; OPS_PROMOTION_IMAGES[$id]="$image_meta"; OPS_PROMOTION_NETWORKS[$id]="$names"; OPS_PROMOTION_VOLUME_FACTS[$volume]="$volume_fact"
  operations_promotion_postgres_proof "$id" running
}

operations_promotion_postgres_proof() {
  local id="$1" phase="$2" expected network peers image
  [[ "$#" == 2 && "$id" =~ ^[a-f0-9]{64}$ && ( "$phase" == running || "$phase" == exited ) && -n "${OPS_PROMOTION_ACTORS[$id]:-}" ]] || return 1
  expected="${OPS_PROMOTION_ACTORS[$id]}"
  [[ "$phase" != exited ]] || expected="${expected/\/running\/true\//\/exited\/false\/}"
  [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" == "$expected" &&
    "$(operations_docker container inspect --format "$OPERATIONS_PROMOTION_STATIC_FORMAT" "$id")" == "${OPS_PROMOTION_STATIC[$id]}" &&
    "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_PROMOTION_PROJECTS[$id]}")" == "$id" &&
    "$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_PROMOTION_VOLUMES[$id]}")" == "$id" ]] || return 1
  image="${OPS_PROMOTION_IMAGES[$id]%%/*}"
  [[ "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$image")" == "${OPS_PROMOTION_IMAGES[$id]}" &&
    "$(operations_docker container inspect --format '{{range $name,$network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$id")" == "${OPS_PROMOTION_NETWORKS[$id]}" ]] || return 1
  operations_promotion_volume_facts || return 1
  while IFS= read -r network; do
    [[ "$(operations_docker network inspect --format "$OPERATIONS_PROMOTION_NETWORK_FORMAT" "$network")" == "${OPS_PROMOTION_NETWORK_FACTS["$id|$network"]}" ]] || return 1
    peers="$(operations_docker network inspect --format '{{range $id,$member := .Containers}}{{println $id}}{{end}}' "$network")" || return 1
    if [[ "$phase" == running ]]; then [[ "$peers" == "$id" ]] || return 1; else [[ -z "$peers" ]] || return 1; fi
  done <<<"${OPS_PROMOTION_NETWORKS[$id]}"
  if [[ "$phase" == running ]]; then
    [[ "$(operations_read_database_control_identifier "$id")" == "${OPS_PROMOTION_SYSTEMS[$id]}" ]] || return 1
  else
    [[ "$(operations_docker container inspect --format '{{.State.ExitCode}}/{{.State.OOMKilled}}' "$id")" == 0/false ]] || return 1
  fi
}

operations_promotion_remove_postgres() {
  local id="$1" network
  [[ "$#" == 1 && "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  operations_promotion_switched && operations_promotion_postgres_proof "$id" running || return 1
  operations_docker stop --time "$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))" "$id" >/dev/null 2>&1 || true
  operations_promotion_switched && operations_promotion_postgres_proof "$id" exited || return 1
  operations_docker rm "$id" >/dev/null 2>&1 || true
  operations_promotion_switched && operations_promotion_volume_facts || return 1
  [[ -z "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_PROMOTION_PROJECTS[$id]}")" &&
    -z "$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_PROMOTION_VOLUMES[$id]}")" ]] || return 1
  while IFS= read -r network; do
    [[ "$(operations_docker network inspect --format "$OPERATIONS_PROMOTION_NETWORK_FORMAT" "$network")" == "${OPS_PROMOTION_NETWORK_FACTS["$id|$network"]}" &&
      -z "$(operations_docker network inspect --format '{{range $id,$member := .Containers}}{{println $id}}{{end}}' "$network")" ]] || return 1
  done <<<"${OPS_PROMOTION_NETWORKS[$id]}"
}

operations_promotion_record() {
  restore_state_read "$OPS_PROMOTION_ORIGINAL_REF" || return 1
  [[ "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == completed &&
    "$(restore_state_emit completed "$OPS_PROMOTION_ORIGINAL_REF")" == "$OPS_PROMOTION_RECORD" ]] || return 1
}

operations_promotion_source_selection() {
  operations_selection_read || return 1
  [[ "${OPS_SELECTION[STATE_PHASE]}" == quiescent &&
    "${OPS_SELECTION[STATE_REF]}" == "$OPS_RESTORE_SOURCE_REF" &&
    "${OPS_SELECTION[STATE_VOLUME]}" == "$OPS_RESTORE_SOURCE_VOLUME" &&
    "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "$OPS_RESTORE_SOURCE_SYSTEM" &&
    "${OPS_SELECTION[STATE_REVISION]}" == "$OPS_RESTORE_SOURCE_REVISION" &&
    "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]]
}

operations_promotion_bound_proof() {
  operations_job_state_root || return 1
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  operations_promotion_record && operations_promotion_source_selection || return 1
  operations_restore_source_quiescent || return 1
  [[ "$(operations_runtime_id postgres)" == "$OPS_PROMOTION_SOURCE_ID" ]] || return 1
  operations_restore_source_alias "$OPS_PROMOTION_SOURCE_ID" || return 1
  operations_restore_target_postgres || return 1
  [[ "$(operations_inspect_restore_host "$OPS_PROMOTION_HOST")" == "$OPS_PROMOTION_HOST" &&
    "$(operations_read_database_control_identifier "$OPS_RESTORE_TARGET_POSTGRES")" == "$OPS_PROMOTION_TARGET_SYSTEM" &&
    "$(operations_restore_metadata_encode "$OPS_PROMOTION_HOST" "$OPS_PROMOTION_TARGET_SYSTEM")" == "$OPS_PROMOTION_TOKEN" ]] || return 1
  operations_restore_metadata_matches "$OPS_PROMOTION_TOKEN" "$OPS_PROMOTION_TARGET_SYSTEM" || return 1
  operations_restore_source_quiescent && operations_promotion_source_selection
}

# The transport owns canonical request parsing, exact challenge/sequence checks
# and the checked live job journal. This callback never replies on its own and
# cannot use the normal host inspector while that owned job joins both bridges.
operations_promotion_host_check() {
  [[ "$#" == 0 ]] || return 1
  operations_job_state_root || return 1
  operations_promotion_record && operations_promotion_source_selection || return 1
  [[ "$(operations_inspect_promotion_host "$OPS_PROMOTION_HOST" "$OPS_PROMOTION_SOURCE_ID" \
    "$OPS_RESTORE_SOURCE_VOLUME" "$OPS_RESTORE_SOURCE_SYSTEM" "$OPS_RESTORE_SOURCE_REF" \
    "$OPS_RESTORE_SOURCE_REVISION" "$OPS_RESTORE_SOURCE_POSTGRES")" == "$OPS_PROMOTION_HOST" ]] || return 1
  operations_promotion_record && operations_promotion_source_selection
}

operations_export_promotion_checkpoint() {
  local reference
  reference="$(operations_execute_job checkpoint export-checkpoint-reference)" || return 1
  [[ "$reference" =~ ^checkpoint_[a-f0-9]{32}$ && "$reference" != "${OPS_RESTORE_STATE[RESTORE_CHECKPOINT_REF]}" ]] || return 1
  printf '%s\n' "$reference"
}

operations_promotion_switched() {
  operations_job_state_root || return 1
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  operations_selection_read || return 1
  [[ "${OPS_SELECTION[STATE_REF]}" == "$OPS_PROMOTION_SWITCH_REF" &&
    "${OPS_SELECTION[STATE_PHASE]}" == switching && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == no &&
    "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" &&
    "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" == "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" &&
    "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "$OPS_PROMOTION_TARGET_SYSTEM" &&
    "${OPS_SELECTION[STATE_RESTORE_REF]}" == "$OPS_PROMOTION_VERIFICATION_REF" &&
    "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" &&
    "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" ]]
}

operations_promote_checked() {
  local phase source_application field checkpoint acknowledgement token id created rest
  [[ "$#" == 0 && "${OPS_RESTORE_REF:-}" =~ ^restore_[a-f0-9]{32}$ ]] || return 1
  # Missing live-proof or startup implementations refuse before any outage.
  for field in operations_inspect_promotion_host operations_start_private_runtime operations_restore_metadata_encode operations_restore_metadata_decode; do
    declare -F "$field" >/dev/null || return 1
  done
  operations_job_state_root || return 1
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  operations_controller_images || return 1
  OPS_PROMOTION_ORIGINAL_REF="$OPS_RESTORE_REF"; OPS_RESTORE_REFERENCE="$OPS_RESTORE_REF"
  restore_state_read "$OPS_PROMOTION_ORIGINAL_REF" || return 1
  [[ "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == completed &&
    "${OPS_RESTORE_STATE[RESTORE_APP_IMAGE]}" == "$OPS_CONTROLLER_APPLICATION" &&
    "${OPS_RESTORE_STATE[RESTORE_OPS_IMAGE]}" == "$OPS_CONTROLLER_OPERATIONS" &&
    "${OPS_RESTORE_STATE[RESTORE_PG_IMAGE]}" == "$OPS_CONTROLLER_POSTGRES" ]] || return 1
  OPS_PROMOTION_RECORD="$(restore_state_emit completed "$OPS_PROMOTION_ORIGINAL_REF")" || return 1
  OPS_PROMOTION_TOKEN="${OPS_RESTORE_STATE[RESTORE_TARGET_METADATA]}"
  OPS_RESTORE_SOURCE_REF="${OPS_RESTORE_STATE[RESTORE_SOURCE_SELECTION_REF]}"
  OPS_RESTORE_SOURCE_VOLUME="${OPS_RESTORE_STATE[RESTORE_SOURCE_VOLUME]}"
  OPS_RESTORE_SOURCE_SYSTEM="${OPS_RESTORE_STATE[RESTORE_SOURCE_SYSTEM_IDENTIFIER]}"
  OPS_CONFIG[FCD_RESTORE_PROJECT]="${OPS_RESTORE_STATE[RESTORE_TARGET_PROJECT]}"
  OPS_CONFIG[FCD_RESTORE_VOLUME]="${OPS_RESTORE_STATE[RESTORE_TARGET_VOLUME]}"
  OPS_CONFIG[FCD_RESTORE_REFERENCE]="$OPS_PROMOTION_ORIGINAL_REF"
  for field in FCD_RESTORE_PROJECT FCD_RESTORE_VOLUME FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_SCHEMA_REVISION FCD_READY_TIMEOUT_SECONDS FCD_STOP_GRACE_MS; do
    operations_config_field "$field" "${OPS_CONFIG[$field]:-}" || return 1
  done
  operations_selection_apply || return 1
  phase="${OPS_SELECTION[STATE_PHASE]}"
  [[ ( "$phase" == ready || "$phase" == quiescent ) &&
    "${OPS_SELECTION[STATE_REF]}" == "$OPS_RESTORE_SOURCE_REF" && "${OPS_SELECTION[STATE_VOLUME]}" == "$OPS_RESTORE_SOURCE_VOLUME" &&
    "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "$OPS_RESTORE_SOURCE_SYSTEM" &&
    "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" && "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" &&
    "${OPS_SELECTION[STATE_VOLUME]}" != "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" ]] || return 1
  OPS_RESTORE_SOURCE_REVISION="${OPS_SELECTION[STATE_REVISION]}"
  operations_retained_read "$OPS_RESTORE_SOURCE_REVISION" || return 1
  [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" &&
    "${OPS_RETAINED[BUNDLE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" && "${OPS_RETAINED[BUNDLE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" ]] || return 1
  source_application="${OPS_RETAINED[BUNDLE_APPLICATION_IMAGE]}"; OPS_RESTORE_SOURCE_POSTGRES="${OPS_RETAINED[BUNDLE_POSTGRES_IMAGE]}"
  operations_controller_source_storage "$OPS_RESTORE_SOURCE_REVISION" "$OPS_RESTORE_SOURCE_POSTGRES" managed || return 1
  operations_restore_target_postgres || return 1
  OPS_PROMOTION_HOST="$(operations_inspect_restore_host)" || return 1
  OPS_PROMOTION_TARGET_SYSTEM="$(operations_read_database_control_identifier "$OPS_RESTORE_TARGET_POSTGRES")" || return 1
  [[ "$OPS_PROMOTION_TARGET_SYSTEM" != "$OPS_RESTORE_SOURCE_SYSTEM" &&
    "$(operations_restore_metadata_encode "$OPS_PROMOTION_HOST" "$OPS_PROMOTION_TARGET_SYSTEM")" == "$OPS_PROMOTION_TOKEN" ]] || return 1
  operations_restore_metadata_matches "$OPS_PROMOTION_TOKEN" "$OPS_PROMOTION_TARGET_SYSTEM" || return 1
  IFS=/ read -r id created rest <<<"$OPS_RESTORE_VOLUME_STAMP"
  [[ "$id" == "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" ]] && operations_deployment_field STATE_VOLUME_CREATED_AT "$created" || return 1
  OPS_PROMOTION_CREATED_AT="$created"
  OPS_PROMOTION_SOURCE_ID="$(operations_runtime_id postgres)" || return 1
  [[ "$OPS_PROMOTION_SOURCE_ID" =~ ^[a-f0-9]{64}$ ]] || return 1
  OPS_PROMOTION_MUTATED=yes
  if [[ "$phase" == ready ]]; then
    operations_selection_draining "$OPS_RESTORE_SOURCE_REF" || return 1
    operations_drain_owned_applications "$OPS_RESTORE_SOURCE_REVISION" "$source_application" "$OPS_RESTORE_SOURCE_POSTGRES" managed || return 1
  fi
  operations_promotion_bound_proof || return 1
  OPS_DATABASE_SYSTEM_IDENTIFIER="$OPS_RESTORE_SOURCE_SYSTEM"
  OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER="$OPS_PROMOTION_TARGET_SYSTEM"
  checkpoint="$(operations_export_promotion_checkpoint)" || return 1
  operations_promotion_bound_proof || return 1
  token="$(od -An -N16 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
  [[ "$token" =~ ^[a-f0-9]{32}$ && "restore_$token" != "$OPS_PROMOTION_ORIGINAL_REF" ]] || return 1
  OPS_PROMOTION_VERIFICATION_REF="restore_$token"
  acknowledgement="$(operations_execute_job promote promote "$OPS_PROMOTION_ORIGINAL_REF" "$OPS_PROMOTION_VERIFICATION_REF" \
    "${OPS_RESTORE_STATE[RESTORE_BACKUP_REF]}" "$checkpoint" "$OPS_PROMOTION_TOKEN")" || return 1
  [[ "$acknowledgement" == '{"status":"completed","processed":1,"reasonCode":"ok"}' ]] || return 1
  operations_promotion_bound_proof || return 1
  # Capture complete immutable actor/volume/network facts while both fresh
  # source/target proofs still hold. Every later stop/remove repeats those facts.
  operations_promotion_capture_postgres "$OPS_PROMOTION_SOURCE_ID" "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" "$OPS_RESTORE_SOURCE_VOLUME" "$OPS_RESTORE_SOURCE_POSTGRES" "$OPS_RESTORE_SOURCE_REVISION" "$OPS_RESTORE_SOURCE_SYSTEM" || return 1
  operations_promotion_capture_postgres "$OPS_RESTORE_TARGET_POSTGRES" "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" "$OPS_CONTROLLER_POSTGRES" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "$OPS_PROMOTION_TARGET_SYSTEM" || return 1
  operations_promotion_bound_proof || return 1
  token="$(od -An -N16 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
  [[ "$token" =~ ^[a-f0-9]{32}$ && "selection_$token" != "$OPS_RESTORE_SOURCE_REF" ]] || return 1
  OPS_PROMOTION_SWITCH_REF="selection_$token"
  operations_selection_switch "$OPS_RESTORE_SOURCE_REF" "$OPS_PROMOTION_SWITCH_REF" "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" \
    "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" "$OPS_PROMOTION_CREATED_AT" "$OPS_PROMOTION_TARGET_SYSTEM" "${OPS_CONFIG[FCD_POSTGRES_DB]}" \
    "$OPS_PROMOTION_VERIFICATION_REF" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" || return 1
  OPS_CONFIG[FCD_POSTGRES_VOLUME]="${OPS_CONFIG[FCD_RESTORE_VOLUME]}"
  operations_promotion_switched || return 1
  operations_promotion_remove_postgres "$OPS_PROMOTION_SOURCE_ID" || return 1
  operations_promotion_remove_postgres "$OPS_RESTORE_TARGET_POSTGRES" || return 1
  operations_promotion_switched || return 1
  # Never replay a timed-out create. Only fresh host and physical postconditions
  # can resolve its outcome; no application actor is requested here.
  operations_compose runtime up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" \
    --no-deps --no-build --pull never postgres >/dev/null 2>&1 || true
  operations_promotion_switched || return 1
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  [[ "$(operations_read_database_identity)" == "$OPS_PROMOTION_TARGET_SYSTEM" ]] || return 1
  operations_promotion_switched || return 1
  operations_start_private_runtime "$OPS_CONTROLLER_APPLICATION" "$OPS_CONTROLLER_OPERATIONS" "$OPS_CONTROLLER_POSTGRES"
}

operations_promotion_uncertain() {
  trap - EXIT
  [[ "$OPS_PROMOTION_MUTATED" == yes && "$OPS_PROMOTION_DONE" != yes ]] || return 0
  (operations_selection_read || exit 1
    [[ "${OPS_SELECTION[STATE_REF]}" == "$OPS_RESTORE_SOURCE_REF" || "${OPS_SELECTION[STATE_REF]}" == "$OPS_PROMOTION_SWITCH_REF" ]] || exit 1
    [[ "${OPS_SELECTION[STATE_PHASE]}" != uncertain ]] || exit 0
    operations_selection_uncertain "${OPS_SELECTION[STATE_REF]}"
  ) >/dev/null 2>&1 || true
}

operations_promote() {
  local OPS_PROMOTION_MUTATED=no OPS_PROMOTION_DONE=no OPS_PROMOTION_SWITCH_REF=''
  local OPS_PROMOTION_ORIGINAL_REF='' OPS_PROMOTION_RECORD='' OPS_PROMOTION_TOKEN='' OPS_PROMOTION_HOST='' OPS_PROMOTION_TARGET_SYSTEM='' OPS_PROMOTION_CREATED_AT='' OPS_PROMOTION_SOURCE_ID='' OPS_PROMOTION_VERIFICATION_REF=''
  local OPS_RESTORE_REFERENCE='' OPS_RESTORE_SOURCE_REF='' OPS_RESTORE_SOURCE_VOLUME='' OPS_RESTORE_SOURCE_SYSTEM='' OPS_RESTORE_SOURCE_REVISION='' OPS_RESTORE_SOURCE_POSTGRES='' OPS_RESTORE_TARGET_POSTGRES=''
  local OPS_RESTORE_VOLUME_STAMP='' OPS_RESTORE_NETWORK_STAMP=''
  local -A OPS_PROMOTION_ACTORS=() OPS_PROMOTION_STATIC=() OPS_PROMOTION_VOLUMES=() OPS_PROMOTION_PROJECTS=() OPS_PROMOTION_SYSTEMS=() OPS_PROMOTION_IMAGES=() OPS_PROMOTION_NETWORKS=() OPS_PROMOTION_NETWORK_FACTS=() OPS_PROMOTION_VOLUME_FACTS=()
  if (trap operations_promotion_uncertain EXIT
    operations_promote_checked "$@" || exit 1
    OPS_PROMOTION_DONE=yes
  ) >/dev/null 2>&1; then return 0; fi
  operations_fail operations_promotion_refused
}
