#!/usr/bin/env bash
# Internal containment only. The caller supplies checked local daemon/configuration
# and holds the deployment lock. This never clears a journal or proves SQL settlement.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-job-lifecycle.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-deployment-state.sh"

operations_orphan_pending_transition() {
  local file
  for file in "${OPS_CONFIG[FCD_STATE_ROOT]}"/active-job-*.next; do
    [[ ! -e "$file" && ! -L "$file" ]] || return 1
  done
}

operations_orphan_environment() {
  local actual line key value count=0
  local -A seen=() expected=(
    [OPS_OPERATION_REFERENCE]="$OPS_JOB_REFERENCE"
    [OPS_DATABASE_SYSTEM_IDENTIFIER]="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"
    [OPS_DATABASE_NAME]="${OPS_CONFIG[FCD_POSTGRES_DB]}"
    [OPS_DATABASE_SCHEMA]="${OPS_CONFIG[FCD_DATABASE_SCHEMA]}"
    [OPS_DATABASE_ROLE_PREFIX]="${OPS_CONFIG[FCD_DATABASE_ROLE_PREFIX]}"
    [OPS_SCHEMA_REVISION]="${OPS_CONFIG[FCD_SCHEMA_REVISION]}")
  # Only these content-free fields may leave Docker inspect. Never project the
  # complete environment, connection URI, credentials or arbitrary diagnostics.
  actual="$(operations_docker container inspect --format '{{range .Config.Env}}{{$parts := split . "="}}{{$key := index $parts 0}}{{if or (eq $key "OPS_OPERATION_REFERENCE") (eq $key "OPS_DATABASE_SYSTEM_IDENTIFIER") (eq $key "OPS_DATABASE_NAME") (eq $key "OPS_DATABASE_SCHEMA") (eq $key "OPS_DATABASE_ROLE_PREFIX") (eq $key "OPS_SCHEMA_REVISION")}}{{println .}}{{end}}{{end}}' "$OPS_JOB_CONTAINER")" || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^(OPS_[A-Z_]+)=([A-Za-z0-9_]+)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -n "${expected[$key]:-}" && -z "${seen[$key]:-}" && "$value" == "${expected[$key]}" ]] || return 1
    seen[$key]=yes; (( count += 1 ))
  done <<<"$actual"
  [[ "$count" == "${#expected[@]}" ]]
}

operations_orphan_cookie() {
  operations_docker container inspect --format '{{.State.StartedAt}}/{{.RestartCount}}/{{.Config.User}}/{{.HostConfig.ReadonlyRootfs}}/{{.HostConfig.Privileged}}/{{len .HostConfig.PortBindings}}' "$OPS_JOB_CONTAINER"
}

operations_orphan_selection_frozen() {
  operations_selection_read
  [[ "$OPS_SELECTION_FILE_ID" == "$OPS_ORPHAN_SELECTION_ID" && "$OPS_SELECTION_FILE_SHA256" == "$OPS_ORPHAN_SELECTION_SHA256" ]]
}

operations_orphan_frozen() {
  operations_job_assert_container "$1" &&
    [[ "$(operations_orphan_cookie)" == "$OPS_ORPHAN_COOKIE" ]] &&
    [[ "$(operations_docker container inspect --format '{{json .Config.Entrypoint}}' "$OPS_JOB_CONTAINER")" == "$OPS_ORPHAN_ENTRYPOINT" ]] &&
    [[ "$(operations_job_discover)" == "$OPS_JOB_CONTAINER" ]]
}

operations_contain_interrupted_job_checked() {
  local metadata command_hash phase='' candidate selection_ref
  [[ "$#" == 0 ]] || return 1
  operations_job_state_read
  operations_orphan_pending_transition || return 1
  [[ "${OPS_JOB_STATE[JOB_PHASE]}" =~ ^(created|started|uncertain)$ && "${OPS_JOB_STATE[JOB_CONTAINER]}" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "${OPS_JOB_STATE[JOB_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" && "${OPS_JOB_STATE[JOB_SERVICE]}" =~ ^(bootstrap|migrate|backup|verify-backup|checkpoint|health|maintenance)$ ]] || return 1
  operations_selection_read
  OPS_ORPHAN_SELECTION_ID="$OPS_SELECTION_FILE_ID"; OPS_ORPHAN_SELECTION_SHA256="$OPS_SELECTION_FILE_SHA256"
  selection_ref="${OPS_SELECTION[STATE_REF]}"
  [[ "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" && "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]:-}" ]] || return 1
  for candidate in FCD_DATABASE_ROLE_PREFIX FCD_SCHEMA_REVISION FCD_STOP_GRACE_MS; do
    operations_config_field "$candidate" "${OPS_CONFIG[$candidate]:-}" || return 1
  done
  OPS_JOB_REFERENCE="${OPS_JOB_STATE[JOB_REF]}"; OPS_JOB_CONTAINER="${OPS_JOB_STATE[JOB_CONTAINER]}"
  OPS_JOB_IMAGE="${OPS_JOB_STATE[JOB_IMAGE]}"; OPS_JOB_SERVICE="${OPS_JOB_STATE[JOB_SERVICE]}"
  OPS_JOB_COMMAND_HASH="${OPS_JOB_STATE[JOB_COMMAND_SHA256]}"
  OPS_JOB_PROJECT="fcd-support-operation-${OPS_JOB_REFERENCE#operation_}"
  metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}/{{index .Config.Labels "fcd-support.operation-reference"}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || return 1
  [[ "$metadata" == "$OPS_JOB_IMAGE/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64/node/1" ]] || return 1
  [[ "$(operations_job_discover)" == "$OPS_JOB_CONTAINER" ]] || return 1
  OPS_JOB_COMMAND_JSON="$(operations_docker container inspect --format '{{json .Config.Cmd}}' "$OPS_JOB_CONTAINER")" || return 1
  command_hash="$(printf '%s' "$OPS_JOB_COMMAND_JSON" | sha256sum)" || return 1
  [[ "${command_hash%% *}" == "$OPS_JOB_COMMAND_HASH" ]] || return 1
  OPS_ORPHAN_ENTRYPOINT="$(operations_docker image inspect --format '{{json .Config.Entrypoint}}' "$OPS_JOB_IMAGE")" || return 1
  OPS_ORPHAN_COOKIE="$(operations_orphan_cookie)" || return 1
  [[ "$OPS_ORPHAN_COOKIE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z/0/node/true/false/0$ ]] || return 1
  operations_orphan_environment || return 1
  for candidate in running created exited; do
    if operations_orphan_frozen "$candidate"; then phase="$candidate"; break; fi
  done
  [[ -n "$phase" ]] || return 1
  operations_orphan_selection_frozen || return 1
  # Intent precedes every stop/remove. Lost acknowledgements are resolved only
  # by the exact actor's unchanged stopped state and subsequent verified absence.
  [[ "${OPS_JOB_STATE[JOB_PHASE]}" == uncertain ]] || operations_job_state_transition "$OPS_JOB_REFERENCE" uncertain "$OPS_JOB_CONTAINER"
  [[ "${OPS_SELECTION[STATE_PHASE]}" == uncertain ]] || operations_selection_uncertain "$selection_ref"
  OPS_ORPHAN_SELECTION_ID="$OPS_SELECTION_FILE_ID"; OPS_ORPHAN_SELECTION_SHA256="$OPS_SELECTION_FILE_SHA256"
  operations_job_state_same_file
  operations_orphan_frozen "$phase" || return 1
  if [[ "$phase" != exited ]]; then
    operations_docker container stop --time "$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))" "$OPS_JOB_CONTAINER" >/dev/null 2>&1 || true
  fi
  operations_orphan_frozen exited || return 1
  operations_orphan_selection_frozen || return 1
  operations_job_state_same_file
  operations_docker container rm "$OPS_JOB_CONTAINER" >/dev/null 2>&1 || true
  [[ -z "$(operations_job_discover)" ]] || return 1
  operations_job_state_same_file
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_REF]}" == "$selection_ref" && "${OPS_SELECTION[STATE_PHASE]}" == uncertain ]] || return 1
  operations_orphan_pending_transition
}

operations_contain_interrupted_job() {
  (operations_contain_interrupted_job_checked "$@") >/dev/null 2>&1 || operations_fail operations_job_containment_refused
}
