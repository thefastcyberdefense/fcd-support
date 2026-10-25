#!/usr/bin/env bash
# Public command implementations. Entry points load common preflight first.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-first-boot.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-adoption.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-postgres.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-startup.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-admin-socket.sh"

operations_controller_images() {
  local field metadata id
  for field in FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE; do
    metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "${OPS_CONFIG[$field]}")" || return 1
    id="${metadata%%/*}"
    [[ "$id" =~ ^sha256:[a-f0-9]{64}$ && "$metadata" == "$id/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64" ]] || return 1
    OPS_CONFIG[$field]="$id"
  done
  OPS_CONTROLLER_APPLICATION="${OPS_CONFIG[FCD_SUPPORT_IMAGE]}"
  OPS_CONTROLLER_OPERATIONS="${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}"
  OPS_CONTROLLER_POSTGRES="${OPS_CONFIG[FCD_POSTGRES_IMAGE]}"
}

operations_controller_source_storage() {
  local revision="$1" image="$2" mode="$3" id before prefix tail identifier
  [[ "$mode" == managed || "$mode" == admission ]] || return 1
  id="$(operations_runtime_id postgres)" || return 1
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$mode" != admission ]] || revision=none
  before="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" || return 1
  prefix="$id/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres/$revision/$image/running/true/false/false/false/"
  [[ "$before" == "$prefix"* ]] || return 1
  tail="${before#"$prefix"}"
  [[ "$tail" =~ ^(postgres|999|999:999)/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || return 1
  [[ "$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name .Destination .RW}}{{end}}{{end}}' "$id")" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]} /var/lib/postgresql true" ]] || return 1
  identifier="$(operations_read_database_control_identifier "$id")" || return 1
  if [[ "$mode" == managed ]]; then [[ "$identifier" == "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" ]] || return 1; fi
  # Check the hardened image's storage contract BEFORE any application outage.
  operations_postgres_storage_contract "$id" || return 1
  [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$id")" == "$before" && "$(operations_read_database_control_identifier "$id")" == "$identifier" ]]
}

operations_preflight_selection() {
  local file root="${OPS_CONFIG[FCD_STATE_ROOT]}"
  OPS_DEPLOYMENT_HAS_SELECTION=no
  if [[ -e "$root/deployment-state" || -L "$root/deployment-state" ]]; then
    operations_selection_apply
    OPS_DEPLOYMENT_HAS_SELECTION=yes
  else
    [[ "$OPS_ACTION" == deploy ]] || operations_fail operations_selection_missing
    for file in "$root/deployment-state.next" "$root/initial-deployment.record" "$root/initial-deployment.record.next" "$root"/volume-*.record "$root"/retained-*.record; do
      [[ ! -e "$file" && ! -L "$file" ]] || operations_fail operations_reconciliation_required
    done
  fi
}

operations_deploy_checked() {
  local source_revision source_application source_postgres mode phase actors
  operations_controller_images || return 1
  if [[ ! -e "${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state" ]]; then
    actors="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
    if [[ -z "$actors" ]]; then
      operations_initialize_private_database "$OPS_CONTROLLER_APPLICATION" "$OPS_CONTROLLER_OPERATIONS" "$OPS_CONTROLLER_POSTGRES" || return 1
    else
      source_revision="${OPS_CONFIG[FCD_ADMISSION_REVISION]:-}"; source_application="${OPS_CONFIG[FCD_ADMISSION_IMAGE]:-}"; source_postgres="${OPS_CONFIG[FCD_ADMISSION_POSTGRES_IMAGE]:-}"
      [[ "$source_revision" =~ ^[a-f0-9]{40}$ && "$source_application" =~ ^sha256:[a-f0-9]{64}$ && "$source_postgres" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
      operations_controller_source_storage "$source_revision" "$source_postgres" admission || return 1
      operations_adopt_admission "$source_revision" "$source_application" "$source_postgres" || return 1
      operations_drain_owned_applications "$source_revision" "$source_application" "$source_postgres" admission || return 1
      operations_converge_postgres "$source_revision" "$source_postgres" admission "$OPS_CONTROLLER_POSTGRES" || return 1
    fi
  else
    operations_selection_apply
    phase="${OPS_SELECTION[STATE_PHASE]}"; source_revision="${OPS_SELECTION[STATE_REVISION]}"
    [[ "$phase" == ready || "$phase" == quiescent ]] || return 1
    if [[ "$phase" != quiescent || "$source_revision" != "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]]; then
      operations_retained_read "$source_revision"
      source_application="${OPS_RETAINED[BUNDLE_APPLICATION_IMAGE]}"; source_postgres="${OPS_RETAINED[BUNDLE_POSTGRES_IMAGE]}"
      [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" ]] || return 1
      operations_controller_source_storage "$source_revision" "$source_postgres" managed || return 1
      if [[ "$phase" == ready ]]; then
        operations_selection_draining "${OPS_SELECTION[STATE_REF]}"
        operations_drain_owned_applications "$source_revision" "$source_application" "$source_postgres" managed || return 1
      fi
      operations_converge_postgres "$source_revision" "$source_postgres" managed "$OPS_CONTROLLER_POSTGRES" || return 1
    fi
  fi
  operations_start_private_runtime "$OPS_CONTROLLER_APPLICATION" "$OPS_CONTROLLER_OPERATIONS" "$OPS_CONTROLLER_POSTGRES"
}

operations_deploy() {
  (operations_deploy_checked) >/dev/null 2>&1 || operations_fail operations_deployment_refused
}

operations_verify() {
  (operations_controller_images || exit 1
    operations_selection_apply || exit 1
    [[ "${OPS_SELECTION[STATE_PHASE]}" == ready && "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" && "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || exit 1
    operations_job_state_root
    [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || exit 1
    operations_job() { operations_execute_job "$@"; }
    operations_inspect_runtime_host >/dev/null
  ) >/dev/null 2>&1 || operations_fail operations_verification_refused
}

operations_rollback() {
  (operations_controller_images || exit 1
    operations_selection_apply || exit 1
    [[ "${OPS_SELECTION[STATE_PHASE]}" == ready ]] || exit 1
    operations_retained_read "${OPS_CONFIG[FCD_SUPPORT_REVISION]}"
    # Version-one retained manifests assert exact-schema compatibility only.
    [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" && "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" && "${OPS_RETAINED[BUNDLE_APPLICATION_IMAGE]}" == "$OPS_CONTROLLER_APPLICATION" && "${OPS_RETAINED[BUNDLE_OPERATIONS_IMAGE]}" == "$OPS_CONTROLLER_OPERATIONS" && "${OPS_RETAINED[BUNDLE_POSTGRES_IMAGE]}" == "$OPS_CONTROLLER_POSTGRES" ]] || exit 1
    operations_deploy_checked
  ) >/dev/null 2>&1 || operations_fail operations_rollback_refused
}
