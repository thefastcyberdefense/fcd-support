#!/usr/bin/env bash
# Test harness diagnostics only. Never forward arbitrary process output.
synthetic_host_runtime_diagnostic() {
  local code="${1:-}"
  case "$code" in
    runtime_host_diagnostic=arguments|runtime_host_diagnostic=input|runtime_host_diagnostic=validation|runtime_host_diagnostic=revision|runtime_host_diagnostic=ingress|runtime_host_diagnostic=compose|runtime_host_diagnostic=paths|runtime_host_diagnostic=samples|runtime_host_diagnostic=volume_identity|runtime_host_diagnostic=topology|runtime_host_diagnostic=images|runtime_host_diagnostic=volume|runtime_host_diagnostic=network_set|runtime_host_diagnostic=network_labels|runtime_host_diagnostic=network_members|runtime_host_diagnostic=container_policy|runtime_host_diagnostic=container_networks|runtime_host_diagnostic=tmpfs|runtime_host_diagnostic=mounts|runtime_host_diagnostic=binds|runtime_host_diagnostic=protected_binds|runtime_host_diagnostic=socket_users|runtime_host_diagnostic=stability)
      printf '%s\n' "$code" ;;
    runtime_host_diagnostic=samples.*|runtime_host_diagnostic=volume_identity.*)
      case "${code#*.}" in
        id|project|service|revision|imageId|running|paused|restarting|dead|healthy|startedAt|restartCount|readOnlyRootfs|privileged|init|user|networkMode|networks|hostPortBindings|publishedPortBindings|publishAllPorts|pidMode|ipcMode|utsMode|capAdd|capDrop|securityOpt|devices|deviceRequests|groupAdd|volumesFrom|extraHosts|sysctls|nanoCpus|memory|pidsLimit|stopTimeout|restartPolicy|tmpfs|command|entrypoint|environmentNames|executionFlags|mounts|type|name|source|destination|readWrite|propagation|images|containers|volume|socket|hostBinds|driver|scope|options|logicalName|createdAt|mountpoint|users|os|architecture|before|after|probes|postgresSql|apiHttp|adminSocket|adminNoTcp|replyHeartbeat|internal|members|containerId|canonicalSource|device|inode|uid|gid|mode|rootDevice|rootInode|rootUid|rootGid|rootMode)
          printf '%s\n' "$code" ;;
      esac ;;
  esac
  return 0
}

synthetic_host_report_failure() {
  local stage=unknown line file="${2:-}"
  case "${1:-}" in
    preflight|fixture|build|keys|isolated-resources|deploy|verify|private-http|backup|checkpoint|restore|promote|rollback|cleanup) stage="$1" ;;
  esac
  printf 'synthetic_host_failed=%s\n' "$stage" >&2
  # Diagnostic enums only; identities, references and arbitrary values are ignored.
  local state_root="${4:-}" record
  if [[ -n "$state_root" ]]; then
    for record in active-job deployment-state; do
      [[ -f "$state_root/$record" && ! -L "$state_root/$record" ]] || continue
      while IFS= read -r line; do
        if [[ "$record" == active-job && "$line" =~ ^JOB_SERVICE=(bootstrap|migrate|backup|verify-backup|checkpoint|health|maintenance|restore|restore-bootstrap|restore-migrate|restore-reconcile|promote)$ ]]; then
          printf 'synthetic_host_job_service=%s\n' "${BASH_REMATCH[1]}" >&2
        elif [[ "$record" == active-job && "$line" =~ ^JOB_PHASE=(intent|created|started|uncertain|completed)$ ]]; then
          printf 'synthetic_host_job_phase=%s\n' "${BASH_REMATCH[1]}" >&2
        elif [[ "$record" == deployment-state && "$line" =~ ^STATE_PHASE=(ready|draining|quiescent|switching|starting|uncertain)$ ]]; then
          printf 'synthetic_host_selection_phase=%s\n' "${BASH_REMATCH[1]}" >&2
        fi
      done < <(head -c 4096 -- "$state_root/$record" 2>/dev/null)
    done
  fi
  [[ -f "$file" && ! -L "$file" ]] || return 0
  while IFS= read -r line; do
    case "$line" in
      operations_arguments_invalid|operations_platform_invalid|operations_revision_invalid|operations_config_invalid|operations_lock_invalid|operations_lock_conflict|operations_daemon_invalid|operations_image_invalid|operations_volume_invalid|operations_socket_root_invalid|operations_socket_present|operations_job_pending|operations_selection_missing|operations_reconciliation_required|operations_deployment_refused|operations_verification_refused|operations_restore_refused|operations_promotion_refused|operations_rollback_refused|operations_schedule_failed)
        printf '%s\n' "$line" >&2 ;;
    esac
  done < <(head -c 16384 -- "$file" 2>/dev/null)
  file="${3:-}"
  [[ -f "$file" && ! -L "$file" ]] || return 0
  local -a transport_frames=() trace_frames=() diagnostics=()
  local script diagnostic frame
  local -i i start=0 count=0
  while IFS= read -r line; do
    diagnostic="$(synthetic_host_runtime_diagnostic "$line")"
    if [[ -n "$diagnostic" ]]; then
      diagnostics+=("$diagnostic")
    elif [[ "$line" =~ ^([a-z-]+\.sh):[0-9]{1,6}:previous=[1-9][0-9]{0,2}$ ]]; then
      script="${BASH_REMATCH[1]}"
      case "$script" in
        operations-job-lifecycle.sh|operations-promotion-host.sh|operations-promotion-controller.sh|operations-restore-host.sh|operations-restore-controller.sh|operations-runtime-host.sh)
          transport_frames+=("$line")
          if (( ${#transport_frames[@]} > 16 )); then
            transport_frames=("${transport_frames[@]:1}")
          fi
          trace_frames+=("$line") ;;
        operations-common.sh|operations-controller.sh|operations-startup.sh|operations-bootstrap.sh|operations-first-boot.sh|operations-deployment-state.sh|operations-postgres.sh|operations-drain.sh|operations-containment.sh|operations-restore-state.sh|operations-restore-metadata.sh)
          trace_frames+=("$line") ;;
      esac
    fi
  done < <(head -c 8388608 -- "$file" 2>/dev/null)
  local -A seen=()
  for frame in "${transport_frames[@]}"; do
    printf '%s\n' "$frame" >&2
    seen["$frame"]=1
  done
  for frame in "${diagnostics[@]}"; do
    printf '%s\n' "$frame" >&2
  done
  count="${#trace_frames[@]}"
  if (( count > 48 )); then
    (( start = count - 48 ))
  fi
  for (( i = start; i < count; i++ )); do
    frame="${trace_frames[i]}"
    if [[ -z "${seen["$frame"]:-}" ]]; then
      printf '%s\n' "$frame" >&2
    fi
  done
}
