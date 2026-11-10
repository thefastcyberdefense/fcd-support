#!/usr/bin/env bash
# Fixed schema-owned stability paths only. Never inspect or publish record keys/values.
operations_promotion_stability_diagnostic_allowed() {
  local code="${1-}" field
  [[ "$#" == 1 && ${#code} -le 128 ]] || return 1
  case "$code" in
    samples.stability.source_terminal.*|samples.stability.target_terminal.*)
      field="${code#samples.stability.}"; field="${field#*.}" ;;
    samples.stability.before_after.source.postgres.*|samples.stability.before_after.source.terminal.*|samples.stability.before_after.target.postgres.*|samples.stability.before_after.target.terminal.*)
      field="${code#samples.stability.before_after.}"; field="${field#*.}"; field="${field#*.}" ;;
    samples.stability.before_after.job.*)
      field="${code#samples.stability.before_after.job.}" ;;
    samples.stability.before_after.source.image|samples.stability.before_after.source.networks|samples.stability.before_after.source.volume|samples.stability.before_after.source.projectActors|samples.stability.before_after.source.systemIdentifier|samples.stability.before_after.source.selectionReference|samples.stability.before_after.target.image|samples.stability.before_after.target.network|samples.stability.before_after.target.volume|samples.stability.before_after.target.projectActors|samples.stability.before_after.target.systemIdentifier|samples.stability.before_after.jobEnvironment|samples.stability.before_after.jobLabels|samples.stability.before_after.jobProjectActors|samples.stability.before_after.runtimeImage|samples.stability.before_after.archiveVolume|samples.stability.before_after.hostBinds) return 0 ;;
    *) return 1 ;;
  esac
  case "$field" in
    id|revision|imageId|project|service|running|paused|restarting|dead|healthy|startedAt|restartCount|readOnlyRootfs|privileged|init|user|networkMode|networks|hostPortBindings|publishedPortBindings|publishAllPorts|pidMode|ipcMode|utsMode|capAdd|capDrop|securityOpt|devices|deviceRequests|groupAdd|volumesFrom|extraHosts|sysctls|nanoCpus|memory|pidsLimit|stopTimeout|restartPolicy|tmpfs|command|entrypoint|environmentNames|executionFlags|mounts) return 0 ;;
    *) return 1 ;;
  esac
}
