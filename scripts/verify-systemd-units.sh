#!/usr/bin/env bash
# Read-only rendered systemd unit alignment verifier. Never writes unit files,
# never modifies /etc/systemd/system, and never invokes system service tools.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/render-systemd-units.sh"

operations_verify_systemd_units() (
  local destination="$1" expected actual
  local -a files=(fcd-support-operation@.service fcd-support-backup.timer fcd-support-maintenance.timer fcd-support-health.timer)
  local -a jobs=(backup maintenance health)
  local -a calendars=(FCD_BACKUP_CALENDAR FCD_MAINTENANCE_CALENDAR FCD_HEALTH_CALENDAR)
  local index file actual_hash expected_hash content

  operations_absolute_path "$destination" || operations_fail operations_timer_alignment_invalid
  [[ -d "$destination" && ! -L "$destination" ]] || operations_fail operations_timer_alignment_invalid
  operations_timers_validate >/dev/null 2>&1 || operations_fail operations_timer_alignment_invalid

  for file in "${files[@]}"; do
    [[ -f "$destination/$file" && ! -L "$destination/$file" ]] || operations_fail operations_timer_alignment_invalid
    [[ "$(stat -c '%u:%g:%a:%h' -- "$destination/$file" 2>/dev/null)" == 1000:1000:600:1 ]] || operations_fail operations_timer_alignment_invalid
    ! grep -qE '@[A-Z_]+@' "$destination/$file" || operations_fail operations_timer_alignment_invalid
  done

  expected_hash="$(operations_timers_emit fcd-support-operation@.service | sha256sum)" || operations_fail operations_timer_alignment_invalid
  expected_hash="${expected_hash%% *}"
  actual_hash="$(sha256sum -- "$destination/${files[0]}" 2>/dev/null)" || operations_fail operations_timer_alignment_invalid
  actual_hash="${actual_hash%% *}"
  [[ "$actual_hash" == "$expected_hash" ]] || operations_fail operations_timer_alignment_invalid
  content="$(<"$destination/${files[0]}")"
  [[ "$content" == *"run-operation.sh %i $OPS_REVISION $OPS_CONFIG_FILE"* ]] || operations_fail operations_timer_alignment_invalid

  for index in 0 1 2; do
    file="fcd-support-${jobs[$index]}.timer"
    expected_hash="$(operations_timers_emit "$file.in" "${OPS_CONFIG[${calendars[$index]}]}" | sha256sum)" || operations_fail operations_timer_alignment_invalid
    expected_hash="${expected_hash%% *}"
    actual_hash="$(sha256sum -- "$destination/$file" 2>/dev/null)" || operations_fail operations_timer_alignment_invalid
    actual_hash="${actual_hash%% *}"
    [[ "$actual_hash" == "$expected_hash" ]] || operations_fail operations_timer_alignment_invalid
  done

  printf 'systemd_units_aligned=true\n'
)

operations_verify_systemd_main() {
  [[ "$#" == 3 && "$1" =~ ^[a-f0-9]{40}$ ]] || operations_fail operations_arguments_invalid
  operations_absolute_path "$2" && operations_absolute_path "$3" || operations_fail operations_arguments_invalid
  [[ "$(uname -s)" == Linux ]] || operations_fail operations_platform_invalid
  OPS_ROOT="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  OPS_ACTION=verify; OPS_REVISION="$1"; OPS_CONFIG_FILE="$2"
  operations_load_config "$OPS_CONFIG_FILE"
  operations_preflight
  operations_verify_systemd_units "$3"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then operations_verify_systemd_main "$@"; fi
