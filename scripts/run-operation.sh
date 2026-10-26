#!/usr/bin/env bash
# Revision-bound host scheduler. Configuration remains literal protected data.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-common.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-deployment-state.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-job-lifecycle.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-health-host.sh"

operations_scheduled_arguments() {
  [[ "$#" == 3 && "$1" =~ ^(backup|maintenance|health)$ && "$2" =~ ^[a-f0-9]{40}$ ]] || operations_fail operations_arguments_invalid
  operations_absolute_path "$3" || operations_fail operations_arguments_invalid
  OPS_SCHEDULED_JOB="$1"; OPS_REVISION="$2"; OPS_CONFIG_FILE="$3"
}

operations_scheduled_ready() {
  operations_selection_apply
  [[ "${OPS_SELECTION[STATE_PHASE]}" == ready && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == yes && "${OPS_SELECTION[STATE_REVISION]}" == "$OPS_REVISION" && "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || operations_fail operations_schedule_not_ready
  OPS_DATABASE_SYSTEM_IDENTIFIER="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"
}

# Shared preflight invokes this under deployment.lock, before Docker access.
operations_preflight_selection() { operations_scheduled_ready; }

operations_scheduled_images() {
  local field bundle metadata image
  operations_retained_read "$OPS_REVISION"
  [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || operations_fail operations_schedule_not_ready
  for field in FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE; do
    case "$field" in
      FCD_SUPPORT_IMAGE) bundle=BUNDLE_APPLICATION_IMAGE ;;
      FCD_OPERATIONS_IMAGE) bundle=BUNDLE_OPERATIONS_IMAGE ;;
      FCD_POSTGRES_IMAGE) bundle=BUNDLE_POSTGRES_IMAGE ;;
    esac
    metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "${OPS_CONFIG[$field]}")" || operations_fail operations_schedule_not_ready
    image="${metadata%%/*}"
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$metadata" == "$image/$OPS_REVISION/linux/amd64" && "${OPS_RETAINED[$bundle]}" == "$image" ]] || operations_fail operations_schedule_not_ready
    OPS_CONFIG[$field]="$image"
  done
}

operations_scheduled_time() {
  OPS_SCHEDULED_EPOCH="$(date -u +%s)" || operations_fail operations_schedule_clock_invalid
  [[ "$OPS_SCHEDULED_EPOCH" =~ ^[1-9][0-9]{8,10}$ ]] || operations_fail operations_schedule_clock_invalid
  OPS_SCHEDULED_AT="$(date -u -d "@$OPS_SCHEDULED_EPOCH" +%Y-%m-%dT%H:%M:%S.000Z)" || operations_fail operations_schedule_clock_invalid
  [[ "$OPS_SCHEDULED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]] || operations_fail operations_schedule_clock_invalid
}

operations_health_gap_read() {
  local file="${OPS_CONFIG[FCD_STATE_ROOT]}/health-outage" before opened after data descriptor shell_pid="$BASHPID" size
  OPS_HEALTH_GAP_STARTED=''; OPS_HEALTH_GAP_LAST=''
  [[ ! -e "$file.next" && ! -L "$file.next" ]] || operations_fail operations_health_gap_invalid
  [[ -e "$file" || -L "$file" ]] || return 0
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%u:%g:%a:%h' -- "$file")" == 1000:1000:600:1 ]] || operations_fail operations_health_gap_invalid
  size="$(stat -c '%s' -- "$file")"
  [[ "$size" =~ ^[1-9][0-9]{0,2}$ ]] && (( size <= 256 )) || operations_fail operations_health_gap_invalid
  before="$(stat -c '%d:%i:%u:%g:%a:%h:%s' -- "$file")"
  exec {descriptor}<"$file" || operations_fail operations_health_gap_invalid
  opened="$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- "/proc/$shell_pid/fd/$descriptor")"
  [[ "$opened" == "$before" ]] || operations_fail operations_health_gap_invalid
  if IFS= read -r -d '' data <&"$descriptor"; then operations_fail operations_health_gap_invalid; fi
  after="$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- "/proc/$shell_pid/fd/$descriptor")"
  exec {descriptor}<&-
  [[ "$after" == "$before" && "$(stat -c '%d:%i:%u:%g:%a:%h:%s' -- "$file")" == "$before" && "${#data}" == "$size" ]] || operations_fail operations_health_gap_invalid
  [[ "$data" =~ ^OUTAGE_VERSION=1$'\n'OUTAGE_STARTED_AT=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z)$'\n'OUTAGE_LAST_OBSERVED_AT=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z)$'\n'$ ]] || operations_fail operations_health_gap_invalid
  OPS_HEALTH_GAP_STARTED="${BASH_REMATCH[1]}"; OPS_HEALTH_GAP_LAST="${BASH_REMATCH[2]}"
  [[ "$OPS_HEALTH_GAP_STARTED" < "$OPS_HEALTH_GAP_LAST" || "$OPS_HEALTH_GAP_STARTED" == "$OPS_HEALTH_GAP_LAST" ]] || operations_fail operations_health_gap_invalid
  [[ "$OPS_HEALTH_GAP_LAST" < "$OPS_SCHEDULED_AT" || "$OPS_HEALTH_GAP_LAST" == "$OPS_SCHEDULED_AT" ]] || operations_fail operations_health_gap_invalid
  for data in "$OPS_HEALTH_GAP_STARTED" "$OPS_HEALTH_GAP_LAST"; do
    [[ "$(date -u -d "$data" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)" == "$data" ]] || operations_fail operations_health_gap_invalid
  done
}

operations_health_gap_write() {
  local file="${OPS_CONFIG[FCD_STATE_ROOT]}/health-outage"
  [[ -n "$OPS_HEALTH_GAP_STARTED" ]] || OPS_HEALTH_GAP_STARTED="$OPS_SCHEDULED_AT"
  (umask 077; printf 'OUTAGE_VERSION=1\nOUTAGE_STARTED_AT=%s\nOUTAGE_LAST_OBSERVED_AT=%s\n' "$OPS_HEALTH_GAP_STARTED" "$OPS_SCHEDULED_AT" |
    dd "of=$file.next" conv=excl,fsync oflag=nofollow status=none) 2>/dev/null || operations_fail operations_health_gap_invalid
  [[ -f "$file.next" && ! -L "$file.next" && "$(stat -c '%u:%g:%a:%h' -- "$file.next")" == 1000:1000:600:1 ]] || operations_fail operations_health_gap_invalid
  mv --no-target-directory -- "$file.next" "$file" || operations_fail operations_health_gap_invalid
  sync -f "${OPS_CONFIG[FCD_STATE_ROOT]}" || operations_fail operations_health_gap_invalid
}

operations_scheduled_health() {
  local acknowledgement snapshot=''
  operations_health_gap_read
  OPS_HEALTH_INPUT_JSON='{}'
  if [[ -n "$OPS_HEALTH_GAP_STARTED" ]]; then
    OPS_HEALTH_INPUT_JSON="{\"outageGap\":{\"startedAt\":\"$OPS_HEALTH_GAP_STARTED\",\"lastObservedAt\":\"$OPS_HEALTH_GAP_LAST\"}}"
  fi
  if snapshot="$(operations_collect_health_host)" && [[ -n "$snapshot" ]] && (( ${#snapshot} <= 8192 )); then
    if [[ "$OPS_HEALTH_INPUT_JSON" == '{}' ]]; then
      OPS_HEALTH_INPUT_JSON="{\"hostSnapshot\":$snapshot}"
    else
      OPS_HEALTH_INPUT_JSON="{\"hostSnapshot\":$snapshot,${OPS_HEALTH_INPUT_JSON:1}"
    fi
  fi
  acknowledgement="$(operations_execute_job health health)" || operations_fail operations_schedule_failed
  unset OPS_HEALTH_INPUT_JSON
  case "$acknowledgement" in
    '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}')
      operations_health_gap_write
      printf '{"event":"operations_health","component":"postgres","state":"unavailable","checkedAt":"%s"}\n' "$OPS_SCHEDULED_AT" >&2 ;;
    *)
      [[ "$acknowledgement" =~ ^\{\"status\":\"completed\",\"processed\":[0-9]{1,9},\"reasonCode\":\"ok\"\}$ ]] || operations_fail operations_schedule_failed
      if [[ -n "$OPS_HEALTH_GAP_STARTED" ]]; then
        rm -- "${OPS_CONFIG[FCD_STATE_ROOT]}/health-outage" || operations_fail operations_health_gap_invalid
        sync -f "${OPS_CONFIG[FCD_STATE_ROOT]}" || operations_fail operations_health_gap_invalid
      fi ;;
  esac
}

operations_scheduled_dispatch() {
  local job="$1" backup_class backup_ref maintenance slot slot_seconds slot_at
  operations_scheduled_time
  case "$job" in
    backup)
      # Current day and current month only. PostgreSQL owns slot completion;
      # repeated activation re-verifies its exact archive instead of copying it.
      for backup_class in daily monthly; do
        backup_ref="$(operations_execute_job backup scheduled-backup "$backup_class" "$OPS_SCHEDULED_AT")" || operations_fail operations_schedule_failed
        [[ "$backup_ref" =~ ^backup_[a-f0-9]{32}$ ]] || operations_fail operations_schedule_failed
        operations_execute_job verify-backup verify-backup "$backup_ref" >/dev/null || operations_fail operations_schedule_failed
      done
      operations_execute_job backup prune-backups "$OPS_SCHEDULED_AT" >/dev/null || operations_fail operations_schedule_failed ;;
    maintenance)
      slot_seconds="${OPS_CONFIG[FCD_MAINTENANCE_SLOT_SECONDS]:-}"
      [[ "$slot_seconds" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$slot_seconds <= 86400 )) || operations_fail operations_timer_config_invalid
      slot="$(( OPS_SCHEDULED_EPOCH / (10#$slot_seconds) * (10#$slot_seconds) ))"
      slot_at="$(date -u -d "@$slot" +%Y-%m-%dT%H:%M:%S.000Z)" || operations_fail operations_schedule_clock_invalid
      for maintenance in retention deletion lease_recovery learning; do
        operations_execute_job maintenance "$maintenance" "scheduled:$maintenance:$slot" "$slot_at" >/dev/null || operations_fail operations_schedule_failed
      done ;;
    health) operations_scheduled_health ;;
    *) operations_fail operations_arguments_invalid ;;
  esac
}

operations_scheduled_main() {
  operations_scheduled_arguments "$@"
  [[ "$(uname -s)" == Linux ]] || operations_fail operations_platform_invalid
  OPS_ROOT="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  # verify is the existing preflight's read/write-safe live-socket mode. The
  # scheduler's stricter ready-selection hook still rejects every outage phase.
  OPS_ACTION=verify
  operations_load_config "$OPS_CONFIG_FILE"
  operations_preflight
  operations_scheduled_ready
  operations_scheduled_images
  operations_scheduled_dispatch "$OPS_SCHEDULED_JOB"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then operations_scheduled_main "$@"; fi
