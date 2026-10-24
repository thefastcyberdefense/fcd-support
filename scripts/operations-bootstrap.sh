#!/usr/bin/env bash
# Internal database-only upgrade. The caller has drained applications and keeps
# the checked local daemon, protected configuration and deployment lock. Public
# controller wiring, application startup and deployment evidence are separate.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-job-lifecycle.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-runtime-host.sh"

operations_bootstrap_instance() {
  local container value
  [[ "$#" == 0 ]] || return 1
  container="$(operations_runtime_id postgres)" || return 1
  [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
  value="$(operations_docker container inspect --format '{{.Id}}/{{.State.StartedAt}}' "$container")" || return 1
  [[ "$value" == "$container/"* && "${value#"$container/"}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || return 1
  printf '%s' "$value"
}

operations_bootstrap_assert_target() {
  local instance system_identifier
  operations_inspect_bootstrap_database >/dev/null 2>&1 || operations_fail operations_bootstrap_metadata_failed
  instance="$(operations_bootstrap_instance)" || operations_fail operations_bootstrap_target_changed
  [[ "$instance" == "$OPS_BOOTSTRAP_INSTANCE" ]] || operations_fail operations_bootstrap_target_changed
  system_identifier="$(operations_read_database_identity 2>/dev/null)" || operations_fail operations_bootstrap_target_changed
  [[ "$system_identifier" == "$OPS_DATABASE_SYSTEM_IDENTIFIER" ]] || operations_fail operations_bootstrap_target_changed
}

operations_bootstrap_job() {
  local reason="$1"; shift
  operations_bootstrap_assert_target
  # Contain a job's closed failure/exit while preserving its durable journal.
  (operations_execute_job "$@" >/dev/null 2>&1) || operations_fail "$reason"
  operations_bootstrap_assert_target
}

operations_upgrade_database() {
  local backup timestamp
  [[ "$#" == 0 ]] || operations_fail operations_bootstrap_arguments_invalid
  OPS_PRE_MIGRATION_BACKUP_REF=''
  operations_job_state_root
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || operations_fail operations_bootstrap_job_pending
  operations_inspect_bootstrap_database >/dev/null 2>&1 || operations_fail operations_bootstrap_metadata_failed
  OPS_BOOTSTRAP_INSTANCE="$(operations_bootstrap_instance)" || operations_fail operations_bootstrap_target_invalid
  OPS_DATABASE_SYSTEM_IDENTIFIER="$(operations_read_database_identity 2>/dev/null)" || operations_fail operations_bootstrap_target_invalid
  [[ "$OPS_DATABASE_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]{0,19}$ ]] || operations_fail operations_bootstrap_target_invalid
  operations_bootstrap_job operations_bootstrap_prepare_failed bootstrap prepare "$OPS_DATABASE_SYSTEM_IDENTIFIER" /run/secrets
  operations_bootstrap_assert_target
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" || operations_fail operations_bootstrap_clock_invalid
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]] || operations_fail operations_bootstrap_clock_invalid
  backup="$(operations_execute_job backup pre-migration-backup "$timestamp" 2>/dev/null)" || operations_fail operations_bootstrap_backup_failed
  [[ "$backup" =~ ^backup_[a-f0-9]{32}$ ]] || operations_fail operations_bootstrap_backup_failed
  operations_bootstrap_assert_target
  operations_bootstrap_job operations_bootstrap_verification_failed verify-backup verify-backup "$backup"
  operations_bootstrap_job operations_bootstrap_migration_failed migrate migrate
  operations_bootstrap_job operations_bootstrap_convergence_failed bootstrap converge "$OPS_DATABASE_SYSTEM_IDENTIFIER" /run/secrets
  # The freshly installed catalog is accessible only after grant convergence.
  operations_bootstrap_job operations_bootstrap_registration_failed verify-backup verify-backup "$backup"
  OPS_PRE_MIGRATION_BACKUP_REF="$backup"
}
