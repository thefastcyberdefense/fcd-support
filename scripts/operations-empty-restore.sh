#!/usr/bin/env bash
# A private, locked and descriptive empty-target close-out. No SQL jobs or
# volume/network changes are authorized by this helper.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-restore-controller.sh"

operations_empty_pending_clear() {
  local file root="${OPS_CONFIG[FCD_STATE_ROOT]}"
  [[ ! -e "$root/active-job" && ! -L "$root/active-job" ]] || return 1
  for file in "$root"/*.next "$root"/job-*.json; do [[ ! -e "$file" && ! -L "$file" ]] || return 1; done
}

operations_empty_context() {
  local used
  operations_empty_pending_clear || return 1
  restore_state_root
  restore_state_pair "$OPS_RESTORE_REF"
  [[ "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == intent &&
    "${OPS_RESTORE_STATE[RESTORE_TARGET_PROJECT]}" == "${OPS_CONFIG[FCD_RESTORE_PROJECT]}" &&
    "${OPS_RESTORE_STATE[RESTORE_TARGET_VOLUME]}" == "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" ]] || return 1
  restore_state_source quiescent
  if [[ -n "$OPS_EMPTY_INTENT_ID" ]]; then
    [[ "$RESTORE_INTENT_FILE_ID/$RESTORE_INTENT_FILE_SHA256/$RESTORE_SOURCE_FILE_ID/$RESTORE_SOURCE_FILE_SHA256" == "$OPS_EMPTY_INTENT_ID/$OPS_EMPTY_INTENT_HASH/$OPS_EMPTY_SOURCE_ID/$OPS_EMPTY_SOURCE_HASH" ]] || return 1
  else
    OPS_EMPTY_INTENT_ID="$RESTORE_INTENT_FILE_ID"; OPS_EMPTY_INTENT_HASH="$RESTORE_INTENT_FILE_SHA256"
    OPS_EMPTY_SOURCE_ID="$RESTORE_SOURCE_FILE_ID"; OPS_EMPTY_SOURCE_HASH="$RESTORE_SOURCE_FILE_SHA256"
  fi
  OPS_RESTORE_SOURCE_REF="${OPS_RESTORE_STATE[RESTORE_SOURCE_SELECTION_REF]}"
  OPS_RESTORE_SOURCE_VOLUME="${OPS_RESTORE_STATE[RESTORE_SOURCE_VOLUME]}"
  OPS_RESTORE_SOURCE_SYSTEM="${OPS_RESTORE_STATE[RESTORE_SOURCE_SYSTEM_IDENTIFIER]}"
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_PHASE]}" == quiescent && "${OPS_SELECTION[STATE_VOLUME]}" != "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" &&
    "${OPS_SELECTION[STATE_PREVIOUS_VOLUME]}" != "${OPS_CONFIG[FCD_RESTORE_VOLUME]}" &&
    "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || return 1
  used="$(operations_deployment_record_path used "${OPS_CONFIG[FCD_RESTORE_VOLUME]}")" || return 1
  [[ ! -e "$used" && ! -L "$used" && ! -e "$used.next" && ! -L "$used.next" ]] || return 1
  OPS_RESTORE_SOURCE_REVISION="${OPS_SELECTION[STATE_REVISION]}"
  operations_retained_read "$OPS_RESTORE_SOURCE_REVISION"
  [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" ]] || return 1
  if [[ -n "$OPS_EMPTY_RETAINED_ID" ]]; then
    [[ "$OPS_DEPLOYMENT_RECORD_ID/$OPS_DEPLOYMENT_RECORD_SHA256" == "$OPS_EMPTY_RETAINED_ID/$OPS_EMPTY_RETAINED_HASH" ]] || return 1
  else OPS_EMPTY_RETAINED_ID="$OPS_DEPLOYMENT_RECORD_ID"; OPS_EMPTY_RETAINED_HASH="$OPS_DEPLOYMENT_RECORD_SHA256"; fi
  OPS_EMPTY_SOURCE_APPLICATION="${OPS_RETAINED[BUNDLE_APPLICATION_IMAGE]}"
  OPS_RESTORE_SOURCE_POSTGRES="${OPS_RETAINED[BUNDLE_POSTGRES_IMAGE]}"
}

operations_empty_verifier_image() {
  local policy
  policy="$(operations_docker image inspect --format '{{if .Config.Volumes}}has_volumes{{else}}none{{end}}/{{.Config.User}}' "$1")" || return 1
  [[ "$policy" == none/node || "$policy" == none/1000 || "$policy" == none/1000:1000 ]]
}

operations_empty_source_proof() {
  operations_restore_source_quiescent || return 1
  operations_empty_verifier_image "$OPS_EMPTY_SOURCE_APPLICATION" || return 1
  # Inspect with the retained source's immutable images and actual revision;
  # this subshell never changes the candidate configuration in the caller.
  (
    OPS_CONFIG[FCD_SUPPORT_REVISION]="$OPS_RESTORE_SOURCE_REVISION"
    OPS_CONFIG[FCD_SUPPORT_IMAGE]="$OPS_EMPTY_SOURCE_APPLICATION"
    OPS_CONFIG[FCD_OPERATIONS_IMAGE]="$OPS_EMPTY_SOURCE_APPLICATION"
    OPS_CONFIG[FCD_POSTGRES_IMAGE]="$OPS_RESTORE_SOURCE_POSTGRES"
    operations_inspect_bootstrap_database >/dev/null
  ) || return 1
}

operations_empty_snapshot() {
  local project="${OPS_CONFIG[FCD_RESTORE_PROJECT]}" volume="${OPS_CONFIG[FCD_RESTORE_VOLUME]}" value root mode target_path id ids mounts mount canonical network_ids network_names volume_row network_row=absent mountpoint created
  value="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$project")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker ps --all --quiet --no-trunc --filter "volume=$volume")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker ps --all --quiet --no-trunc --filter "label=fcd-support.restore.ref=$OPS_RESTORE_REF")" || return 1
  [[ -z "$value" ]] || return 1
  value="$(operations_docker ps --all --quiet --no-trunc --filter "label=fcd-support.operation.parent=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  [[ -z "$value" ]] || return 1
  root="$(operations_docker info --format '{{.DockerRootDir}}')" || return 1
  operations_absolute_path "$root" && [[ -d "$root" && ! -L "$root" && "$(realpath -e -- "$root" 2>/dev/null)" == "$root" && "$(stat -c '%u' -- "$root")" == 0 ]] || return 1
  operations_protected_ancestors "$root" || return 1
  mode="$(stat -c '%d:%i:%u:%g:%a' -- "$root")" || return 1
  target_path="$root/volumes/$volume/_data"
  operations_absolute_path "$target_path" || return 1
  value="$(operations_docker volume ls --quiet --filter "name=^$volume$")" || return 1
  [[ "$value" == "$volume" ]] || return 1
  operations_restore_volume || return 1
  volume_row="$OPS_RESTORE_VOLUME_STAMP"
  IFS=/ read -r _ created _ <<<"$volume_row"
  mountpoint="$(operations_docker volume inspect --format '{{.Mountpoint}}' "$volume")" || return 1
  [[ "$mountpoint" == "$target_path" ]] || return 1
  network_ids="$(operations_docker network ls --quiet --no-trunc --filter "label=com.docker.compose.project=$project")" || return 1
  network_names="$(operations_docker network ls --quiet --no-trunc --filter "name=^$project-data$")" || return 1
  [[ "$network_ids" == "$network_names" ]] || return 1
  if [[ -n "$network_ids" ]]; then
    [[ "$network_ids" =~ ^[a-f0-9]{64}$ ]] || return 1
    operations_restore_network 0 || return 1
    [[ "$OPS_RESTORE_NETWORK_STAMP" == "$network_ids/"* ]] || return 1
    network_row="$OPS_RESTORE_NETWORK_STAMP"
  fi
  ids="$(operations_docker ps --all --quiet --no-trunc)" || return 1
  (( ${#ids} <= 16640 )) || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    mounts="$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$id")" || return 1
    (( ${#mounts} <= 65536 )) || return 1
    while IFS= read -r mount; do
      [[ -n "$mount" ]] || continue
      operations_absolute_path "$mount" || return 1
      canonical="$(realpath -e -- "$mount" 2>/dev/null)" || return 1
      operations_disjoint "$target_path" "$canonical" || return 1
    done <<<"$mounts"
  done <<<"$ids"
  OPS_EMPTY_CREATED="$created"; OPS_EMPTY_MOUNTPOINT="$mountpoint"
  OPS_EMPTY_SNAPSHOT="$mode|$volume_row|$network_row|$mountpoint"
}

operations_empty_probe() {
  local result
  result="$(operations_docker run --rm --pull never --network none --read-only --user 1000:1000 \
    --label "com.docker.compose.project=${OPS_CONFIG[FCD_RESTORE_PROJECT]}" --label "fcd-support.restore.ref=$OPS_RESTORE_REF" \
    --cap-drop ALL --security-opt no-new-privileges --cpus "${OPS_CONFIG[FCD_ADMIN_CPUS]}" \
    --memory "${OPS_CONFIG[FCD_ADMIN_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_ADMIN_PIDS]}" \
    --mount "type=bind,src=$OPS_EMPTY_MOUNTPOINT,dst=/target,readonly" \
    --entrypoint node "$OPS_CONTROLLER_APPLICATION" dist/operations/empty-restore-target-main.js)" || return 1
  [[ "$result" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s' "$result"
}

operations_empty_restore_checked() {
  local OPS_EMPTY_INTENT_ID='' OPS_EMPTY_INTENT_HASH='' OPS_EMPTY_SOURCE_ID='' OPS_EMPTY_SOURCE_HASH='' OPS_EMPTY_RETAINED_ID='' OPS_EMPTY_RETAINED_HASH=''
  local OPS_EMPTY_SOURCE_APPLICATION OPS_RESTORE_SOURCE_REF OPS_RESTORE_SOURCE_VOLUME OPS_RESTORE_SOURCE_SYSTEM OPS_RESTORE_SOURCE_REVISION OPS_RESTORE_SOURCE_POSTGRES
  local OPS_RESTORE_REFERENCE="$OPS_RESTORE_REF" OPS_RESTORE_VOLUME_STAMP='' OPS_RESTORE_NETWORK_STAMP='' OPS_EMPTY_SNAPSHOT OPS_EMPTY_CREATED OPS_EMPTY_MOUNTPOINT
  local first snapshot created proof field
  [[ "$#" == 0 ]] || return 1
  for field in FCD_RESTORE_PROJECT FCD_RESTORE_VOLUME FCD_ADMIN_CPUS FCD_ADMIN_MEMORY_MIB FCD_ADMIN_PIDS; do
    operations_config_field "$field" "${OPS_CONFIG[$field]:-}" || return 1
  done
  operations_empty_context || return 1
  operations_controller_images || return 1
  operations_empty_verifier_image "$OPS_CONTROLLER_APPLICATION" || return 1
  operations_empty_source_proof || return 1
  operations_empty_snapshot || return 1
  snapshot="$OPS_EMPTY_SNAPSHOT"; created="$OPS_EMPTY_CREATED"
  first="$(operations_empty_probe)" || return 1
  operations_empty_snapshot || return 1
  [[ "$OPS_EMPTY_SNAPSHOT" == "$snapshot" ]] || return 1
  operations_empty_context && operations_empty_source_proof || return 1
  proof="$(operations_empty_probe)" || return 1
  [[ "$proof" == "$first" ]] || return 1
  operations_empty_snapshot || return 1
  [[ "$OPS_EMPTY_SNAPSHOT" == "$snapshot" && "$OPS_EMPTY_CREATED" == "$created" ]] || return 1
  operations_empty_context && operations_empty_source_proof || return 1
  operations_empty_snapshot || return 1
  [[ "$OPS_EMPTY_SNAPSHOT" == "$snapshot" && "$OPS_EMPTY_CREATED" == "$created" ]] || return 1
  operations_empty_context && operations_restore_source_quiescent && operations_empty_pending_clear || return 1
  operations_empty_snapshot || return 1
  [[ "$OPS_EMPTY_SNAPSHOT" == "$snapshot" && "$OPS_EMPTY_CREATED" == "$created" ]] || return 1
  operations_empty_context && operations_empty_pending_clear || return 1
  restore_state_abandon "$OPS_RESTORE_REF" "$OPS_REVISION" "$OPS_CONTROLLER_APPLICATION" "$created" "$proof" >/dev/null
}

operations_abandon_empty_restore() {
  (operations_empty_restore_checked "$@") >/dev/null 2>&1 || operations_fail operations_empty_restore_refused
  printf '%s\n' restore_abandoned=true
}
