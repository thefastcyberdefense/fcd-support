#!/usr/bin/env bash
# Internal locked restore composition. Completion is historical restore evidence,
# never permission to attach the target or restart application writers.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-controller.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-restore-host.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-restore-state.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-restore-metadata.sh"

OPERATIONS_RESTORE_VOLUME_FORMAT='{{.Name}}/{{.CreatedAt}}/{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.volume"}}/{{index .Labels "fcd-support.restore.ref"}}'
OPERATIONS_RESTORE_NETWORK_FORMAT='{{.Id}}/{{.Name}}/{{.Created}}/{{.Driver}}/{{.Internal}}/{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.network"}}/{{index .Labels "fcd-support.restore.ref"}}/{{len .Containers}}'

operations_restore_subnet_preflight() {
  [[ "$#" == 0 && -n "${OPS_CONFIG[FCD_RESTORE_SUBNET]:-}" ]] || return 1
  operations_config_field FCD_RESTORE_SUBNET "${OPS_CONFIG[FCD_RESTORE_SUBNET]}" || return 1
  [[ -f "$OPS_ROOT/scripts/operations-restore-subnet.ts" && ! -L "$OPS_ROOT/scripts/operations-restore-subnet.ts" ]] || return 1
  env -i "PATH=$PATH" LC_ALL=C timeout --signal=TERM \
    --kill-after="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))s" \
    "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" node "$OPS_ROOT/scripts/operations-restore-subnet.ts" \
    "${OPS_CONFIG[FCD_RESTORE_SUBNET]}" >/dev/null 2>&1
}

operations_restore_target_absent() {
  local project="${OPS_CONFIG[FCD_RESTORE_PROJECT]}" volume="${OPS_CONFIG[FCD_RESTORE_VOLUME]}" value
  value="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$project")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker ps --all --quiet --no-trunc --filter "volume=$volume")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker volume ls --quiet --filter "name=^$volume$")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker network ls --quiet --no-trunc --filter "name=^$project-data$")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker network ls --quiet --no-trunc --filter "label=com.docker.compose.project=$project")" || return 1
  [[ -z "$value" ]]
}

operations_restore_source_alias() {
  local id="$1" aliases
  aliases="$(operations_docker container inspect --format "{{with index .NetworkSettings.Networks \"${OPS_CONFIG[FCD_RUNTIME_PROJECT]}-operations-data\"}}{{range .Aliases}}{{if eq . \"fcd-support-source-postgres\"}}source{{end}}{{if eq . \"fcd-support-restore-postgres\"}}target{{end}}{{end}}{{end}}" "$id")" || return 1
  [[ "$aliases" == source ]]
}

operations_restore_target_alias() {
  local id="$1" aliases
  aliases="$(operations_docker container inspect --format "{{with index .NetworkSettings.Networks \"${OPS_CONFIG[FCD_RESTORE_PROJECT]}-data\"}}{{range .Aliases}}{{if eq . \"fcd-support-source-postgres\"}}source{{end}}{{if eq . \"fcd-support-restore-postgres\"}}target{{end}}{{end}}{{end}}" "$id")" || return 1
  [[ "$aliases" == target ]]
}

operations_restore_source_quiescent() {
  local id row identifier
  local OPS_DRAIN_MODE=managed
  local -A OPS_DRAIN_ROLES=() OPS_DRAIN_EXPECTED=()
  operations_selection_apply || return 1
  [[ "${OPS_SELECTION[STATE_PHASE]}" == quiescent && "${OPS_SELECTION[STATE_REF]}" == "$OPS_RESTORE_SOURCE_REF" &&
    "${OPS_SELECTION[STATE_VOLUME]}" == "$OPS_RESTORE_SOURCE_VOLUME" && "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "$OPS_RESTORE_SOURCE_SYSTEM" &&
    "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" && "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" &&
    "${OPS_SELECTION[STATE_REVISION]}" == "$OPS_RESTORE_SOURCE_REVISION" && "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || return 1
  operations_controller_source_storage "$OPS_RESTORE_SOURCE_REVISION" "$OPS_RESTORE_SOURCE_POSTGRES" managed || return 1
  id="$(operations_runtime_id postgres)" || return 1
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" == "$id" &&
    "$(operations_docker ps --all --quiet --no-trunc --filter "volume=$OPS_RESTORE_SOURCE_VOLUME")" == "$id" ]] || return 1
  row="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" || return 1
  OPS_DRAIN_ROLES[postgres]="$id"; OPS_DRAIN_EXPECTED[$id]="$row"
  operations_drain_boundaries || return 1
  identifier="$(operations_read_database_control_identifier "$id")" || return 1
  [[ "$identifier" == "$OPS_RESTORE_SOURCE_SYSTEM" &&
    "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" == "$row" && "$(operations_runtime_id postgres)" == "$id" ]]
}

operations_restore_volume() {
  local row name created driver scope options project logical reference extra
  row="$(operations_docker volume inspect --format "$OPERATIONS_RESTORE_VOLUME_FORMAT" "${OPS_CONFIG[FCD_RESTORE_VOLUME]}")" || return 1
  IFS=/ read -r name created driver scope options project logical reference extra <<<"$row"
  [[ -z "$extra" && "$row" == "$name/$created/local/local/default/$project/restore-data/$OPS_RESTORE_REFERENCE" &&
    "$name" == "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" && "$project" == "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" ]] || return 1
  operations_deployment_field STATE_VOLUME_CREATED_AT "$created" || return 1
  [[ -z "$OPS_RESTORE_VOLUME_STAMP" || "$OPS_RESTORE_VOLUME_STAMP" == "$row" ]] || return 1
  OPS_RESTORE_VOLUME_STAMP="$row"
}

operations_restore_network() {
  local count="$1" row id name created driver internal project logical reference members extra stamp
  row="$(operations_docker network inspect --format "$OPERATIONS_RESTORE_NETWORK_FORMAT" "${OPS_CONFIG[FCD_RESTORE_PROJECT]}-data")" || return 1
  IFS=/ read -r id name created driver internal project logical reference members extra <<<"$row"
  [[ -z "$extra" && "$id" =~ ^[a-f0-9]{64}$ && "$row" == "$id/$name/$created/bridge/true/$project/restore_data/$OPS_RESTORE_REFERENCE/$count" &&
    "$name" == "${OPS_CONFIG[FCD_RESTORE_PROJECT]}-data" && "$project" == "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" ]] || return 1
  operations_deployment_field STATE_VOLUME_CREATED_AT "$created" || return 1
  if [[ -n "${OPS_CONFIG[FCD_RESTORE_SUBNET]:-}" ]]; then
    operations_config_field FCD_RESTORE_SUBNET "${OPS_CONFIG[FCD_RESTORE_SUBNET]}" || return 1
    [[ "$(operations_docker network inspect --format '{{.Id}}/{{.IPAM.Driver}}/{{len .IPAM.Config}}/{{range .IPAM.Config}}{{.Subnet}}{{end}}' "${OPS_CONFIG[FCD_RESTORE_PROJECT]}-data")" == "$id/default/1/${OPS_CONFIG[FCD_RESTORE_SUBNET]}" ]] || return 1
  fi
  stamp="${row%/*}"
  [[ -z "$OPS_RESTORE_NETWORK_STAMP" || "$OPS_RESTORE_NETWORK_STAMP" == "$stamp" ]] || return 1
  OPS_RESTORE_NETWORK_STAMP="$stamp"
}

operations_restore_target_postgres() {
  local id
  id="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" --filter label=com.docker.compose.service=postgres)" || return 1
  [[ "$id" =~ ^[a-f0-9]{64}$ && ( -z "$OPS_RESTORE_TARGET_POSTGRES" || "$OPS_RESTORE_TARGET_POSTGRES" == "$id" ) ]] || return 1
  [[ "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RESTORE_PROJECT]}")" == "$id" &&
    "$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_CONFIG[FCD_RESTORE_VOLUME]}")" == "$id" &&
    "$(operations_docker container inspect --format '{{index .Config.Labels "fcd-support.restore.ref"}}' "$id")" == "$OPS_RESTORE_REFERENCE" ]] || return 1
  operations_restore_volume && operations_restore_network 1 || return 1
  operations_restore_target_alias "$id" || return 1
  OPS_RESTORE_TARGET_POSTGRES="$id"
}

operations_restore_metadata_matches() {
  local token="$1" system="$2" data line key value count=0
  local -A fields=()
  (( ${#token} >= 1 && ${#token} <= 5464 )) && [[ "$token" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  data="$(operations_restore_metadata_decode "$token")" || return 1
  (( ${#data} >= 1 && ${#data} <= 4096 )) || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    (( count += 1 )); (( count <= 9 )) || return 1
    [[ "$line" =~ ^(TARGET_[A-Z_]+)=([A-Za-z0-9_.:-]+)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    case "$key" in TARGET_PROJECT|TARGET_VOLUME|TARGET_SYSTEM_IDENTIFIER|TARGET_DATABASE_NAME|TARGET_SCHEMA|TARGET_APP_IMAGE|TARGET_PG_IMAGE|TARGET_REVISION|TARGET_SCHEMA_REVISION) ;; *) return 1 ;; esac
    [[ -z "${fields[$key]+present}" ]] || return 1
    fields[$key]="$value"
  done <<<"$data"
  (( count == 9 )) && [[ "${fields[TARGET_PROJECT]:-}" == "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" && "${fields[TARGET_VOLUME]:-}" == "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" &&
    "${fields[TARGET_SYSTEM_IDENTIFIER]:-}" == "$system" && "${fields[TARGET_DATABASE_NAME]:-}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" &&
    "${fields[TARGET_SCHEMA]:-}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" && "${fields[TARGET_APP_IMAGE]:-}" == "$OPS_CONTROLLER_APPLICATION" &&
    "${fields[TARGET_PG_IMAGE]:-}" == "$OPS_CONTROLLER_POSTGRES" && "${fields[TARGET_REVISION]:-}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" &&
    "${fields[TARGET_SCHEMA_REVISION]:-}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]]
}

# A proof belongs to this locked invocation and this exact target. Check it
# around every leg; a completed earlier leg never permits a later blind replay.
operations_restore_bound_proof() {
  local metadata="$1" identifier="$2" token="$3" id
  restore_state_read "$OPS_RESTORE_REFERENCE" || return 1
  [[ "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == intent ]] || return 1
  operations_restore_metadata_matches "$token" "$identifier" || return 1
  operations_restore_source_quiescent || return 1
  id="$(operations_runtime_id postgres)" || return 1
  operations_restore_source_alias "$id" || return 1
  operations_restore_target_postgres || return 1
  [[ "$(operations_inspect_restore_host "$metadata")" == "$metadata" &&
    "$(operations_read_database_control_identifier "$OPS_RESTORE_TARGET_POSTGRES")" == "$identifier" ]] || return 1
  operations_restore_source_quiescent
}

operations_restore_leg() {
  local metadata="$1" identifier="$2" token="$3" acknowledgement job_failed=false; shift 3
  operations_restore_bound_proof "$metadata" "$identifier" "$token" || return 1
  acknowledgement="$(operations_execute_job "$@")" || job_failed=true
  # Independently sample the postcondition even after a failed/lost job ACK.
  # This observation cannot clear its journal or permit another job on failure.
  operations_restore_bound_proof "$metadata" "$identifier" "$token" || return 1
  [[ "$job_failed" == false && "$acknowledgement" == '{"status":"completed","processed":1,"reasonCode":"ok"}' ]]
}
operations_restore_checked() {
  local field phase source_application source_operations metadata token identifier id image source_metadata
  local -a network_subnet=()
  local OPS_RESTORE_REFERENCE OPS_RESTORE_SOURCE_REF OPS_RESTORE_SOURCE_VOLUME OPS_RESTORE_SOURCE_SYSTEM OPS_RESTORE_SOURCE_REVISION OPS_RESTORE_SOURCE_POSTGRES
  local OPS_RESTORE_VOLUME_STAMP='' OPS_RESTORE_NETWORK_STAMP='' OPS_RESTORE_TARGET_POSTGRES=''
  [[ "$#" == 0 && "${OPS_BACKUP_REF:-}" =~ ^backup_[a-f0-9]{32}$ && "${OPS_CHECKPOINT_REF:-}" =~ ^checkpoint_[a-f0-9]{32}$ ]] || return 1
  for field in FCD_RESTORE_PROJECT FCD_RESTORE_VOLUME FCD_POSTGRES_VOLUME FCD_BACKUP_VOLUME FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_SCHEMA_REVISION FCD_READY_TIMEOUT_SECONDS; do
    operations_config_field "$field" "${OPS_CONFIG[$field]:-}" || return 1
  done
  if [[ -n "${OPS_CONFIG[FCD_RESTORE_SUBNET]:-}" ]]; then
    operations_config_field FCD_RESTORE_SUBNET "${OPS_CONFIG[FCD_RESTORE_SUBNET]}" || return 1
    operations_restore_subnet_preflight || return 1
    network_subnet=(--subnet "${OPS_CONFIG[FCD_RESTORE_SUBNET]}")
  fi
  [[ "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" =~ ^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$ &&
    "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" != "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" &&
    "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" != "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" && "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" != "${OPS_CONFIG[FCD_BACKUP_VOLUME]}" ]] || return 1
  operations_job_state_root || return 1
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  operations_controller_images || return 1
  operations_selection_apply || return 1
  phase="${OPS_SELECTION[STATE_PHASE]}"
  [[ ( "$phase" == ready || "$phase" == quiescent ) && "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" &&
    "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" && "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" &&
    "${OPS_SELECTION[STATE_VOLUME]}" != "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" ]] || return 1
  OPS_RESTORE_SOURCE_REF="${OPS_SELECTION[STATE_REF]}"; OPS_RESTORE_SOURCE_VOLUME="${OPS_SELECTION[STATE_VOLUME]}"
  OPS_RESTORE_SOURCE_SYSTEM="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"; OPS_RESTORE_SOURCE_REVISION="${OPS_SELECTION[STATE_REVISION]}"
  operations_retained_read "$OPS_RESTORE_SOURCE_REVISION" || return 1
  [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" &&
    "${OPS_RETAINED[BUNDLE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" && "${OPS_RETAINED[BUNDLE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" ]] || return 1
  source_application="${OPS_RETAINED[BUNDLE_APPLICATION_IMAGE]}"; source_operations="${OPS_RETAINED[BUNDLE_OPERATIONS_IMAGE]}"; OPS_RESTORE_SOURCE_POSTGRES="${OPS_RETAINED[BUNDLE_POSTGRES_IMAGE]}"
  for image in "$source_application" "$source_operations" "$OPS_RESTORE_SOURCE_POSTGRES"; do
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
    source_metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "$image")" || return 1
    [[ "$source_metadata" == "$image/$OPS_RESTORE_SOURCE_REVISION/linux/amd64" ]] || return 1
  done
  # Refuse inherited storage permissions before any application outage.
  operations_controller_source_storage "$OPS_RESTORE_SOURCE_REVISION" "$OPS_RESTORE_SOURCE_POSTGRES" managed || return 1
  operations_restore_target_absent || return 1
  token="$(od -An -N16 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || return 1
  OPS_RESTORE_REFERENCE="restore_$token"
  OPS_CONFIG[FCD_RESTORE_REFERENCE]="$OPS_RESTORE_REFERENCE"
  operations_restore_validate_compose || return 1
  restore_state_begin "$OPS_RESTORE_REFERENCE" "$OPS_BACKUP_REF" "$OPS_CHECKPOINT_REF" "$OPS_RESTORE_SOURCE_REF" "$OPS_RESTORE_SOURCE_VOLUME" "$OPS_RESTORE_SOURCE_SYSTEM" \
    "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" "$OPS_CONTROLLER_APPLICATION" "$OPS_CONTROLLER_OPERATIONS" "$OPS_CONTROLLER_POSTGRES" \
    "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" >/dev/null || return 1
  if [[ "$phase" == ready ]]; then
    operations_selection_draining "$OPS_RESTORE_SOURCE_REF" || return 1
    operations_drain_owned_applications "$OPS_RESTORE_SOURCE_REVISION" "$source_application" "$OPS_RESTORE_SOURCE_POSTGRES" managed || return 1
  fi
  operations_restore_source_quiescent || return 1
  id="$(operations_runtime_id postgres)" || return 1
  if [[ "$OPS_RESTORE_SOURCE_REVISION" != "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" || "$OPS_RESTORE_SOURCE_POSTGRES" != "$OPS_CONTROLLER_POSTGRES" ]] || ! operations_restore_source_alias "$id"; then
    operations_converge_postgres "$OPS_RESTORE_SOURCE_REVISION" "$OPS_RESTORE_SOURCE_POSTGRES" managed "$OPS_CONTROLLER_POSTGRES" || return 1
    OPS_RESTORE_SOURCE_REVISION="${OPS_CONFIG[FCD_SUPPORT_REVISION]}"; OPS_RESTORE_SOURCE_POSTGRES="$OPS_CONTROLLER_POSTGRES"
  fi
  operations_restore_source_quiescent || return 1
  id="$(operations_runtime_id postgres)" || return 1
  operations_restore_source_alias "$id" || return 1
  # Grant provisioning stays in the verified source-only upgrade job before a
  # target bridge exists. Source-connected restore legs receive no bootstrap
  # password set and cannot substitute for this source capability preparation.
  OPS_DATABASE_SYSTEM_IDENTIFIER="$OPS_RESTORE_SOURCE_SYSTEM"
  operations_upgrade_database || return 1
  operations_restore_source_quiescent || return 1
  id="$(operations_runtime_id postgres)" || return 1
  operations_restore_source_alias "$id" || return 1
  # The deployment lock excludes cooperative changes; absence is sampled again
  # immediately before creation and exact reference labels resolve lost ACKs.
  operations_restore_target_absent || return 1
  operations_docker volume create --driver local --label "com.docker.compose.project=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" \
    --label com.docker.compose.volume=restore-data --label "fcd-support.restore.ref=$OPS_RESTORE_REFERENCE" "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" >/dev/null 2>&1 || true
  operations_restore_volume || return 1
  if (( ${#network_subnet[@]} > 0 )); then operations_restore_subnet_preflight || return 1; fi
  operations_docker network create --driver bridge --internal "${network_subnet[@]}" --label "com.docker.compose.project=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" \
    --label com.docker.compose.network=restore_data --label "fcd-support.restore.ref=$OPS_RESTORE_REFERENCE" "${OPS_CONFIG[FCD_RESTORE_PROJECT]}-data" >/dev/null 2>&1 || true
  operations_restore_network 0 || return 1
  [[ -z "$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_CONFIG[FCD_RESTORE_VOLUME]}")" ]] || return 1
  operations_compose restore --project-name "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" \
    --no-deps --no-build --pull never postgres >/dev/null 2>&1 || true
  operations_restore_target_postgres || return 1
  metadata="$(operations_inspect_restore_host)" || return 1
  identifier="$(operations_read_database_control_identifier "$OPS_RESTORE_TARGET_POSTGRES")" || return 1
  operations_deployment_field STATE_SYSTEM_IDENTIFIER "$identifier" && [[ "$identifier" != "$OPS_RESTORE_SOURCE_SYSTEM" ]] || return 1
  [[ "$(operations_inspect_restore_host "$metadata")" == "$metadata" ]] || return 1
  token="$(operations_restore_metadata_encode "$metadata" "$identifier")" || return 1
  operations_restore_metadata_matches "$token" "$identifier" || return 1
  OPS_DATABASE_SYSTEM_IDENTIFIER="$OPS_RESTORE_SOURCE_SYSTEM"
  OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER="$identifier"
  # These are deliberately separate journaled containers. Only stream and
  # reconciliation may join the source bridge. Grant preparation/convergence
  # and forward migration use their target-only profiles and distinct secrets.
  operations_restore_leg "$metadata" "$identifier" "$token" restore restore "$OPS_RESTORE_REFERENCE" "$OPS_BACKUP_REF" "$OPS_CHECKPOINT_REF" "$token" || return 1
  operations_restore_leg "$metadata" "$identifier" "$token" restore-bootstrap prepare "$identifier" /run/secrets || return 1
  operations_restore_leg "$metadata" "$identifier" "$token" restore-migrate migrate "$identifier" || return 1
  operations_restore_leg "$metadata" "$identifier" "$token" restore-bootstrap converge "$identifier" /run/secrets || return 1
  operations_restore_leg "$metadata" "$identifier" "$token" restore-reconcile restore "$OPS_RESTORE_REFERENCE" "$OPS_BACKUP_REF" "$OPS_CHECKPOINT_REF" "$token" || return 1
  restore_state_complete "$OPS_RESTORE_REFERENCE" "$token" >/dev/null || return 1
  printf '%s\n' "$OPS_RESTORE_REFERENCE"
}

operations_restore() {
  local reference
  reference="$(operations_restore_checked "$@" 2>/dev/null)" || operations_fail operations_restore_refused
  [[ "$reference" =~ ^restore_[a-f0-9]{32}$ ]] || operations_fail operations_restore_refused
  printf '%s\n' "$reference"
}
