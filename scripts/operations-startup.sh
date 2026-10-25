#!/usr/bin/env bash
# Internal bootstrap/private-start composition, not a public deployment handler.
# Caller retains exact protected artifacts/config, local Docker and flock.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-bootstrap.sh"

operations_startup_selection() {
  local phase="$1"
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_REF]}" == "$OPS_STARTUP_REFERENCE" && "${OPS_SELECTION[STATE_PHASE]}" == "$phase" && "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" && "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" == "$OPS_STARTUP_IDENTIFIER" && "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" && "${OPS_SELECTION[STATE_DATABASE_NAME]}" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" && "${OPS_SELECTION[STATE_SCHEMA_NAME]}" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" && ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  if [[ "$phase" == starting ]]; then
    [[ "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == yes ]] || return 1
  else [[ "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" < "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" || "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || return 1; fi
}

operations_startup_checked() {
  local application="$1" operations="$2" postgres="$3" field expected meta identifier
  local OPS_ACTION=private-startup OPS_STARTUP_REFERENCE OPS_STARTUP_IDENTIFIER
  [[ "$application" =~ ^sha256:[a-f0-9]{64}$ && "$operations" =~ ^sha256:[a-f0-9]{64}$ && "$postgres" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  for field in FCD_RUNTIME_PROJECT FCD_SUPPORT_REVISION FCD_SCHEMA_REVISION FCD_POSTGRES_VOLUME FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_DATABASE_ROLE_PREFIX FCD_READY_TIMEOUT_SECONDS FCD_COMMAND_TIMEOUT_SECONDS FCD_STOP_GRACE_MS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || return 1
  done
  operations_job_state_root
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  operations_selection_read
  OPS_STARTUP_REFERENCE="${OPS_SELECTION[STATE_REF]}"; OPS_STARTUP_IDENTIFIER="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"
  operations_startup_selection quiescent || return 1
  operations_socket_root || return 1
  for field in FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE; do
    operations_config_field "$field" "${OPS_CONFIG[$field]:-}" || return 1
    case "$field" in FCD_SUPPORT_IMAGE) expected="$application" ;; FCD_OPERATIONS_IMAGE) expected="$operations" ;; FCD_POSTGRES_IMAGE) expected="$postgres" ;; esac
    meta="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[$field]}")" || return 1
    [[ "$meta" == "$expected/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64/"* ]] || return 1
    if [[ "$field" == FCD_POSTGRES_IMAGE ]]; then [[ "${meta##*/}" =~ ^(postgres|999|999:999)$ ]] || return 1;
    else [[ "${meta##*/}" =~ ^(node|1000|1000:1000)$ ]] || return 1; fi
    OPS_CONFIG[$field]="$expected"
  done
  # SQL readiness probes also use the durable executor in this private scope.
  # No legacy run--rm owner/migrator job can outlive the journal unnoticed.
  operations_job() { operations_execute_job "$@"; }
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  identifier="$(operations_read_database_identity 2>/dev/null)" || return 1
  [[ "$identifier" == "$OPS_STARTUP_IDENTIFIER" ]] || return 1
  operations_startup_selection quiescent || return 1
  operations_upgrade_database >/dev/null 2>&1 || return 1
  [[ "${OPS_PRE_MIGRATION_BACKUP_REF:-}" =~ ^backup_[a-f0-9]{32}$ && "${OPS_DATABASE_SYSTEM_IDENTIFIER:-}" == "$OPS_STARTUP_IDENTIFIER" ]] || return 1
  operations_startup_selection quiescent || return 1
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  identifier="$(operations_read_database_identity 2>/dev/null)" || return 1
  [[ "$identifier" == "$OPS_STARTUP_IDENTIFIER" ]] || return 1
  # The metadata job independently checks actual schema/principal/cluster on
  # its owning connection before recording candidate startup evidence.
  operations_execute_job migrate deployment-started >/dev/null 2>&1 || return 1
  operations_startup_selection quiescent || return 1
  operations_selection_starting "$OPS_STARTUP_REFERENCE" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_SCHEMA_REVISION]}"
  operations_startup_selection starting || return 1
  operations_socket_root || return 1
  operations_compose runtime up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" \
    --no-deps --no-build --pull never fcd-support-api fcd-support-admin fcd-support-reply >/dev/null 2>&1 || true
  # Never replay a timed-out start. Resolve only its complete fresh postcondition.
  operations_inspect_runtime_host >/dev/null 2>&1 || return 1
  operations_startup_selection starting || return 1
  operations_execute_job migrate deployment-succeeded >/dev/null 2>&1 || return 1
  operations_inspect_runtime_host >/dev/null 2>&1 || return 1
  operations_startup_selection starting || return 1
  operations_selection_ready "$OPS_STARTUP_REFERENCE"
  operations_retain_revision "$OPS_STARTUP_REFERENCE" "$application" "$operations" "$postgres"
}

operations_start_private_runtime() {
  if [[ "$#" == 3 ]] && (operations_startup_checked "$@") >/dev/null 2>&1; then return 0; fi
  # Keep volumes and partial actors for verified containment/reconciliation.
  # Public orchestration must add that failure leg before this is exposed.
  (operations_selection_read
    [[ "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" && ( "${OPS_SELECTION[STATE_PHASE]}" == quiescent || "${OPS_SELECTION[STATE_PHASE]}" == starting || "${OPS_SELECTION[STATE_PHASE]}" == ready ) ]] || exit 1
    operations_selection_uncertain "${OPS_SELECTION[STATE_REF]}"
  ) >/dev/null 2>&1 || true
  operations_fail operations_startup_refused
}
