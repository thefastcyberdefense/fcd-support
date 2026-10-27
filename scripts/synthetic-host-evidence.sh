#!/usr/bin/env bash
# Test harness diagnostics only. Never forward arbitrary process output.
synthetic_host_report_failure() {
  local stage=unknown line file="${2:-}"
  case "${1:-}" in
    preflight|fixture|build|keys|isolated-resources|deploy|verify|private-http) stage="$1" ;;
  esac
  printf 'synthetic_host_failed=%s\n' "$stage" >&2
  [[ -f "$file" && ! -L "$file" ]] || return 0
  while IFS= read -r line; do
    case "$line" in
      operations_arguments_invalid|operations_platform_invalid|operations_revision_invalid|operations_config_invalid|operations_lock_invalid|operations_lock_conflict|operations_daemon_invalid|operations_image_invalid|operations_volume_invalid|operations_socket_root_invalid|operations_socket_present|operations_job_pending|operations_selection_missing|operations_reconciliation_required|operations_deployment_refused|operations_verification_refused)
        printf '%s\n' "$line" >&2 ;;
    esac
  done < <(head -c 16384 -- "$file" 2>/dev/null)
  file="${3:-}"
  [[ -f "$file" && ! -L "$file" ]] || return 0
  while IFS= read -r line; do
    if [[ "$line" =~ ^([a-z-]+\.sh):[0-9]{1,6}:previous=[1-9][0-9]{0,2}$ ]]; then
      case "${BASH_REMATCH[1]}" in
        operations-common.sh|operations-controller.sh|operations-startup.sh|operations-bootstrap.sh|operations-first-boot.sh|operations-job-lifecycle.sh|operations-runtime-host.sh|operations-deployment-state.sh|operations-postgres.sh|operations-drain.sh|operations-containment.sh)
          printf '%s\n' "$line" ;;
      esac
    fi
  done < <(head -c 8388608 -- "$file" 2>/dev/null) | tail -n 64 >&2
}
