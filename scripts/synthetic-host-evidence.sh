#!/usr/bin/env bash
# Test harness diagnostics only. Never forward arbitrary process output.
source "$(dirname -- "${BASH_SOURCE[0]}")/promotion-stability-diagnostics.sh"
synthetic_host_health_ack_diagnostic() {
  local caller_status=$?
  local -a saved_rematch=()
  if [[ -v BASH_REMATCH ]]; then
    saved_rematch=("${BASH_REMATCH[@]}")
  fi

  local status value category=unexpected processed
  if [[ $# -ge 2 ]]; then
    status="${1-}"
    value="${2-}"
    if [[ ! "$status" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
      category="unobserved"
    elif [[ "$status" -ne 0 ]]; then
      category="log_read_failed:$status"
    elif [[ -z "$value" ]]; then
      category="empty"
    elif [[ "$value" == *$'\r'* ]]; then
      category="carriage_return"
    elif [[ "$value" == *$'\n'* ]]; then
      category="multiple_lines"
    elif [[ "$value" == '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}' ]]; then
      category="dependency_unavailable"
    elif [[ "$value" == '{"status":"completed","processed":'*',"reasonCode":"ok"}' ]]; then
      processed="${value#'{"status":"completed","processed":'}"
      processed="${processed%',"reasonCode":"ok"}'}"
      if [[ -n "$processed" && ${#processed} -le 9 && "$processed" != *[!0-9]* && ( "$processed" == 0 || "$processed" != 0* ) ]]; then
        category="completed"
      fi
    fi
  else
    value="${1-}"
    if [[ -z "$value" ]]; then
      category="empty"
    elif [[ "$value" == log_read_failed ]]; then
      category="log_read_failed"
    elif [[ "$value" =~ ^log_read_failed:([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
      category="$value"
    elif [[ "$value" =~ ^([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
      category="log_read_failed:$value"
    elif [[ "$value" == *$'\r'* ]]; then
      category="carriage_return"
    elif [[ "$value" == *$'\n'* ]]; then
      category="multiple_lines"
    elif [[ "$value" == '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}' ]]; then
      category="dependency_unavailable"
    elif [[ "$value" == '{"status":"completed","processed":'*',"reasonCode":"ok"}' ]]; then
      processed="${value#'{"status":"completed","processed":'}"
      processed="${processed%',"reasonCode":"ok"}'}"
      if [[ -n "$processed" && ${#processed} -le 9 && "$processed" != *[!0-9]* && ( "$processed" == 0 || "$processed" != 0* ) ]]; then
        category="completed"
      fi
    fi
  fi

  printf 'synthetic_health_ack_diagnostic=%s\n' "$category"

  if [[ ${#saved_rematch[@]} -gt 0 ]]; then
    BASH_REMATCH=("${saved_rematch[@]}")
  else
    unset BASH_REMATCH
  fi
  return "$caller_status"
}

synthetic_host_promotion_cmd_diagnostic() {
  local caller_status=$?
  local status="${1-}" result="${2-}" expected="${3-}" category=''
  local -a saved_rematch=()
  if [[ -v BASH_REMATCH ]]; then
    saved_rematch=("${BASH_REMATCH[@]}")
  fi

  if [[ ! "$status" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
    category="unobserved"
  elif [[ "$status" -eq 0 ]]; then
    if [[ -z "$result" ]]; then
      category="empty_output:0"
    elif [[ -n "$expected" && "$result" == "$expected" ]]; then
      category="canonical_success"
    else
      category="unallowlisted_output:0"
    fi
  elif [[ "$result" == runtime_host_diagnostic=* ]]; then
    local allowlisted
    allowlisted="$(synthetic_host_runtime_diagnostic "$result")"
    if [[ -n "$allowlisted" ]]; then
      category="allowlisted_diagnostic"
    else
      category="unallowlisted_output:$status"
    fi
  elif [[ -z "$result" ]]; then
    category="empty_output:$status"
  else
    category="unallowlisted_output:$status"
  fi

  printf 'synthetic_promotion_cmd_diagnostic=%s\n' "$category"
  if [[ "$category" == "allowlisted_diagnostic" && -n "${allowlisted-}" ]]; then
    printf '%s\n' "$allowlisted"
  fi

  if [[ ${#saved_rematch[@]} -gt 0 ]]; then
    BASH_REMATCH=("${saved_rematch[@]}")
  else
    unset BASH_REMATCH
  fi
  return "$caller_status"
}

synthetic_host_runtime_diagnostic() {
  local code="${1:-}"
  case "$code" in
    synthetic_health_ack_diagnostic=empty|synthetic_health_ack_diagnostic=log_read_failed|synthetic_health_ack_diagnostic=carriage_return|synthetic_health_ack_diagnostic=multiple_lines|synthetic_health_ack_diagnostic=dependency_unavailable|synthetic_health_ack_diagnostic=completed|synthetic_health_ack_diagnostic=unexpected|synthetic_health_ack_diagnostic=unobserved)
      printf '%s\n' "$code" ;;
    synthetic_health_attach_diagnostic=nonzero:*)
      case "${code#*:}" in
        [1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]) printf '%s\n' "$code" ;;
      esac ;;
    synthetic_health_ack_diagnostic=log_read_failed:*)
      local status_val="${code#*:}"
      if [[ "$status_val" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
        printf '%s\n' "$code"
      fi ;;
    synthetic_promotion_cmd_diagnostic=canonical_success|synthetic_promotion_cmd_diagnostic=allowlisted_diagnostic|synthetic_promotion_cmd_diagnostic=unobserved)
      printf '%s\n' "$code" ;;
    synthetic_promotion_cmd_diagnostic=empty_output:*|synthetic_promotion_cmd_diagnostic=unallowlisted_output:*|synthetic_promotion_cmd_diagnostic=unavailable_transport:*|synthetic_promotion_cmd_diagnostic=nonzero_execution:*)
      local status_val="${code#*:}"
      if [[ "$status_val" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
        printf '%s\n' "$code"
      fi ;;
    runtime_host_diagnostic=arguments|runtime_host_diagnostic=input|runtime_host_diagnostic=validation|runtime_host_diagnostic=revision|runtime_host_diagnostic=ingress|runtime_host_diagnostic=compose|runtime_host_diagnostic=paths|runtime_host_diagnostic=samples|runtime_host_diagnostic=volume_identity|runtime_host_diagnostic=topology|runtime_host_diagnostic=images|runtime_host_diagnostic=volume|runtime_host_diagnostic=network_set|runtime_host_diagnostic=network_labels|runtime_host_diagnostic=network_members|runtime_host_diagnostic=container_policy|runtime_host_diagnostic=container_networks|runtime_host_diagnostic=tmpfs|runtime_host_diagnostic=mounts|runtime_host_diagnostic=binds|runtime_host_diagnostic=protected_binds|runtime_host_diagnostic=socket_users|runtime_host_diagnostic=stability)
      printf '%s\n' "$code" ;;
    runtime_host_diagnostic=samples.stability.*)
      if operations_promotion_stability_diagnostic_allowed "${code#runtime_host_diagnostic=}"; then printf '%s\n' "$code"; fi ;;
    runtime_host_diagnostic=samples.*|runtime_host_diagnostic=volume_identity.*)
      case "${code#*.}" in
        id|systemIdentifier|project|projectActors|service|revision|imageId|reference|running|paused|restarting|dead|healthy|startedAt|restartCount|readOnlyRootfs|privileged|init|user|networkMode|networks|hostPortBindings|publishedPortBindings|publishAllPorts|pidMode|ipcMode|utsMode|capAdd|capDrop|securityOpt|devices|deviceRequests|groupAdd|volumesFrom|extraHosts|sysctls|nanoCpus|memory|pidsLimit|stopTimeout|restartPolicy|tmpfs|command|entrypoint|environmentNames|executionFlags|mounts|type|name|source|destination|readWrite|propagation|images|containers|volume|socket|hostBinds|driver|scope|options|logicalName|createdAt|mountpoint|users|os|architecture|before|after|probes|postgresSql|apiHttp|adminSocket|adminNoTcp|replyHeartbeat|internal|members|containerId|canonicalSource|device|inode|uid|gid|mode|rootDevice|rootInode|rootUid|rootGid|rootMode|stability|target)
          printf '%s\n' "$code" ;;
      esac ;;
  esac
  return 0
}

synthetic_host_report_failure() {
  local stage=unknown line file="${2:-}"
  case "${1:-}" in
    preflight|fixture|build|keys|isolated-resources|deploy|verify|private-http|maintenance|backup|health|health-[1-9]|health-10|checkpoint|restore|promote|rollback|cleanup) stage="$1" ;;
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
  local -i i start=0 count=0 budget=0
  local -A seen_diagnostics=()
  while IFS= read -r line; do
    diagnostic=''
    # Trace lines need no validator subprocess, and accepted duplicates need no
    # repeated work. Keep the closed validator as the publication authority.
    if [[ "$line" =~ ^(runtime_host_diagnostic|synthetic_health_ack_diagnostic|synthetic_health_attach_diagnostic|synthetic_promotion_cmd_diagnostic)=[A-Za-z0-9_.:]{1,128}$ ]] &&
      (( ${#diagnostics[@]} < 16 )) && [[ -z "${seen_diagnostics[$line]:-}" ]]; then
      diagnostic="$(synthetic_host_runtime_diagnostic "$line")"
    fi
    if [[ -n "$diagnostic" ]]; then
      if (( ${#diagnostics[@]} < 16 )) && [[ -z "${seen_diagnostics[$diagnostic]:-}" ]]; then
        diagnostics+=("$diagnostic")
        seen_diagnostics[$diagnostic]=yes
      fi
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
    if (( ${#trace_frames[@]} > 48 )); then trace_frames=("${trace_frames[@]:1}"); fi
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
  (( budget = 64 - ${#transport_frames[@]} - ${#diagnostics[@]} ))
  if (( count > budget )); then
    (( start = count - budget ))
  fi
  for (( i = start; i < count; i++ )); do
    frame="${trace_frames[i]}"
    if [[ -z "${seen["$frame"]:-}" ]]; then
      printf '%s\n' "$frame" >&2
    fi
  done
}
