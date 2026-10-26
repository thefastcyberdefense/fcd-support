#!/usr/bin/env bash
# Creates one complete, validated unit generation in a new protected directory.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/run-operation.sh"

operations_timers_validate() {
  local field
  for field in FCD_BACKUP_CALENDAR FCD_MAINTENANCE_CALENDAR FCD_HEALTH_CALENDAR \
    FCD_MAINTENANCE_SLOT_SECONDS FCD_TIMER_TIMEOUT_SECONDS FCD_TIMER_MEMORY_MIB FCD_TIMER_TASKS_MAX \
    FCD_TIMER_CPUS FCD_TIMER_ACCURACY_SECONDS FCD_TIMER_RANDOMIZED_DELAY_SECONDS; do
    operations_config_field "$field" "${OPS_CONFIG[$field]:-}" || operations_fail operations_timer_config_invalid
  done
  for field in FCD_BACKUP_CALENDAR FCD_MAINTENANCE_CALENDAR FCD_HEALTH_CALENDAR; do
    systemd-analyze calendar -- "${OPS_CONFIG[$field]}" >/dev/null || operations_fail operations_timer_calendar_invalid
  done
}

operations_timers_emit() {
  local template="$1" calendar="${2:-}" data quota
  data="$(cat -- "$OPS_ROOT/infra/systemd/$template")" || return 1
  quota="$(awk -v cpus="${OPS_CONFIG[FCD_TIMER_CPUS]}" 'BEGIN { printf "%.3f", cpus * 100 }')" || return 1
  data="${data//@ROOT@/$OPS_ROOT}"; data="${data//@REVISION@/$OPS_REVISION}"
  data="${data//@CONFIG@/$OPS_CONFIG_FILE}"; data="${data//@STATE_ROOT@/${OPS_CONFIG[FCD_STATE_ROOT]}}"
  data="${data//@TIMEOUT_SECONDS@/${OPS_CONFIG[FCD_TIMER_TIMEOUT_SECONDS]}}"
  data="${data//@MEMORY_MIB@/${OPS_CONFIG[FCD_TIMER_MEMORY_MIB]}}"
  data="${data//@TASKS_MAX@/${OPS_CONFIG[FCD_TIMER_TASKS_MAX]}}"; data="${data//@CPU_QUOTA@/$quota}"
  data="${data//@ACCURACY_SECONDS@/${OPS_CONFIG[FCD_TIMER_ACCURACY_SECONDS]}}"
  data="${data//@RANDOMIZED_DELAY_SECONDS@/${OPS_CONFIG[FCD_TIMER_RANDOMIZED_DELAY_SECONDS]}}"
  data="${data//@CALENDAR@/$calendar}"
  [[ ! "$data" =~ @[A-Z_]+@ ]] || return 1
  printf '%s\n' "$data"
}

operations_timers_render() (
  local destination="$1" parent stage='' identity file job field
  local -a files=(fcd-support-operation@.service fcd-support-backup.timer fcd-support-maintenance.timer fcd-support-health.timer)
  operations_absolute_path "$destination" || operations_fail operations_timer_destination_invalid
  [[ ! -e "$destination" && ! -L "$destination" ]] || operations_fail operations_timer_destination_invalid
  parent="$(dirname -- "$destination")"
  operations_private_directory "$parent" || operations_fail operations_timer_destination_invalid
  for field in "$OPS_ROOT" "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" "${OPS_CONFIG[FCD_STATE_ROOT]}" "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}"; do
    operations_disjoint "$destination" "$field" || operations_fail operations_timer_destination_invalid
  done
  # No filesystem output exists until every calendar/resource value validates.
  operations_timers_validate
  umask 077
  stage="$(mktemp -d -- "$parent/.fcd-support-units.XXXXXXXX")" || operations_fail operations_timer_render_failed
  trap 'if [[ -n "$stage" && -d "$stage" && ! -L "$stage" ]]; then for file in "${files[@]}"; do rm -f -- "$stage/$file"; done; rmdir -- "$stage" 2>/dev/null || true; fi' EXIT
  identity="$(stat -c '%d:%i' -- "$stage")"
  operations_timers_emit fcd-support-operation@.service | dd "of=$stage/${files[0]}" conv=excl,fsync oflag=nofollow status=none || operations_fail operations_timer_render_failed
  for job in backup maintenance health; do
    field="FCD_${job^^}_CALENDAR"
    operations_timers_emit "fcd-support-$job.timer.in" "${OPS_CONFIG[$field]}" |
      dd "of=$stage/fcd-support-$job.timer" conv=excl,fsync oflag=nofollow status=none || operations_fail operations_timer_render_failed
  done
  for file in "${files[@]}"; do
    [[ -f "$stage/$file" && ! -L "$stage/$file" && "$(stat -c '%u:%g:%a:%h' -- "$stage/$file")" == 1000:1000:600:1 ]] || operations_fail operations_timer_render_failed
  done
  systemd-analyze verify -- "${files[@]/#/$stage/}" >/dev/null 2>&1 || operations_fail operations_timer_verification_failed
  sync -f "$stage" || operations_fail operations_timer_render_failed
  mv --no-clobber --no-target-directory -- "$stage" "$destination" || operations_fail operations_timer_render_failed
  [[ ! -e "$stage" && ! -L "$stage" && "$(stat -c '%d:%i' -- "$destination")" == "$identity" ]] || operations_fail operations_timer_render_failed
  stage=''
  sync -f "$parent" || operations_fail operations_timer_render_failed
)

operations_timers_main() {
  [[ "$#" == 3 ]] || operations_fail operations_arguments_invalid
  operations_scheduled_arguments maintenance "$1" "$2"
  operations_absolute_path "$3" || operations_fail operations_arguments_invalid
  [[ "$(uname -s)" == Linux ]] || operations_fail operations_platform_invalid
  OPS_ROOT="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"; OPS_ACTION=verify
  operations_load_config "$OPS_CONFIG_FILE"
  operations_preflight
  operations_scheduled_ready
  operations_scheduled_images
  operations_timers_render "$3"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then operations_timers_main "$@"; fi
