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
    synthetic_host_runtime_diagnostic "$line"
    if [[ "$line" =~ ^([a-z-]+\.sh):[0-9]{1,6}:previous=[1-9][0-9]{0,2}$ ]]; then
      case "${BASH_REMATCH[1]}" in
        operations-common.sh|operations-controller.sh|operations-startup.sh|operations-bootstrap.sh|operations-first-boot.sh|operations-job-lifecycle.sh|operations-runtime-host.sh|operations-deployment-state.sh|operations-postgres.sh|operations-drain.sh|operations-containment.sh)
          printf '%s\n' "$line" ;;
      esac
    fi
  done < <(head -c 8388608 -- "$file" 2>/dev/null) | tail -n 64 >&2
}
