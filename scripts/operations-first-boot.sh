#!/usr/bin/env bash
# Internal first initialization only; never reuses an existing volume or intent.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-runtime-host.sh"

OPERATIONS_INITIAL_VOLUME_FORMAT='{{.Name}}/{{.CreatedAt}}/{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.volume"}}/{{index .Labels "fcd-support.initial.ref"}}'

operations_initial_volume() {
  local value expected
  operations_initial_intent_matches "$OPS_INITIAL_APPLICATION" "$OPS_INITIAL_OPERATIONS" "$OPS_INITIAL_POSTGRES"
  [[ "$OPS_INITIAL_FILE_ID/$OPS_INITIAL_FILE_SHA256" == "$OPS_INITIAL_STAMP" ]] || return 1
  value="$(operations_docker volume inspect --format "$OPERATIONS_INITIAL_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  expected="${OPS_CONFIG[FCD_POSTGRES_VOLUME]}/"
  [[ "$value" == "$expected"* ]] || return 1
  value="${value#"$expected"}"
  OPS_INITIAL_CREATED="${value%%/*}"
  operations_deployment_field STATE_VOLUME_CREATED_AT "$OPS_INITIAL_CREATED" || return 1
  [[ "$value" == "$OPS_INITIAL_CREATED/local/local/default/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres-data/${OPS_INITIAL[INITIAL_REF]}" ]] || return 1
  [[ -z "${OPS_INITIAL_VOLUME_STAMP:-}" || "$OPS_INITIAL_VOLUME_STAMP" == "$value" ]] || return 1
  OPS_INITIAL_VOLUME_STAMP="$value"
}

operations_initial_host_context() {
  [[ "$#" == 1 && "$1" == bootstrap ]] || return 1
  operations_initial_volume || return 1
  OPS_RUNTIME_VOLUME_IDENTITY="{\"name\":\"${OPS_CONFIG[FCD_POSTGRES_VOLUME]}\",\"project\":\"${OPS_CONFIG[FCD_RUNTIME_PROJECT]}\",\"logicalName\":\"postgres-data\",\"createdAt\":\"$OPS_INITIAL_CREATED\"}"
  OPS_RUNTIME_SELECTED_IDENTIFIER="${OPS_INITIAL_IDENTIFIER:-}"
  OPS_RUNTIME_SELECTION_STAMP="$OPS_INITIAL_STAMP/$OPS_INITIAL_VOLUME_STAMP"
}

operations_initial_database_checked() {
  local field expected meta actors volumes identifier file
  [[ "$#" == 3 && "$1" =~ ^sha256:[a-f0-9]{64}$ && "$2" =~ ^sha256:[a-f0-9]{64}$ && "$3" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  local OPS_INITIAL_APPLICATION="$1" OPS_INITIAL_OPERATIONS="$2" OPS_INITIAL_POSTGRES="$3"
  local OPS_INITIAL_STAMP OPS_INITIAL_VOLUME_STAMP='' OPS_INITIAL_IDENTIFIER='' OPS_INITIAL_CREATED
  operations_deployment_state_root
  for field in FCD_POSTGRES_VOLUME FCD_BACKUP_VOLUME FCD_SUPPORT_REVISION FCD_DATABASE_ROLE_PREFIX FCD_SCHEMA_REVISION FCD_READY_TIMEOUT_SECONDS; do
    operations_config_field "$field" "${OPS_CONFIG[$field]:-}" || return 1
  done
  [[ "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" != "${OPS_CONFIG[FCD_BACKUP_VOLUME]}" ]] || return 1
  # All history is checked before Docker and checked again by exclusive intent
  # creation. A repeated invocation never implicitly resumes an interrupted boot.
  for file in "${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state" "${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state.next" "${OPS_CONFIG[FCD_STATE_ROOT]}/initial-deployment.record" "${OPS_CONFIG[FCD_STATE_ROOT]}/initial-deployment.record.next" "${OPS_CONFIG[FCD_STATE_ROOT]}/active-job" "${OPS_CONFIG[FCD_STATE_ROOT]}"/active-job-*.next "${OPS_CONFIG[FCD_STATE_ROOT]}"/volume-*.record "${OPS_CONFIG[FCD_STATE_ROOT]}"/retained-*.record; do
    [[ ! -e "$file" && ! -L "$file" ]] || return 1
  done
  operations_socket_root || return 1
  for field in FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE; do
    case "$field" in FCD_SUPPORT_IMAGE) expected="$1" ;; FCD_OPERATIONS_IMAGE) expected="$2" ;; FCD_POSTGRES_IMAGE) expected="$3" ;; esac
    meta="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[$field]}")" || return 1
    [[ "$meta" == "$expected/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/linux/amd64/"* ]] || return 1
    if [[ "$field" == FCD_POSTGRES_IMAGE ]]; then [[ "${meta##*/}" =~ ^(postgres|999|999:999)$ ]] || return 1;
    else [[ "${meta##*/}" =~ ^(node|1000|1000:1000)$ ]] || return 1; fi
    OPS_CONFIG[$field]="$expected"
  done
  actors="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}")" || return 1
  volumes="$(operations_docker volume ls --quiet --filter "name=^${OPS_CONFIG[FCD_POSTGRES_VOLUME]}$")" || return 1
  [[ -z "$actors" && -z "$volumes" ]] || return 1
  operations_initial_intent_create "$@"
  OPS_INITIAL_STAMP="$OPS_INITIAL_FILE_ID/$OPS_INITIAL_FILE_SHA256"
  operations_docker volume create --driver local --label "com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" \
    --label com.docker.compose.volume=postgres-data --label "fcd-support.initial.ref=${OPS_INITIAL[INITIAL_REF]}" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" >/dev/null 2>&1 || true
  operations_initial_volume || return 1
  [[ -z "$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" ]] || return 1
  # This fixed private override exists only inside this checked controller's
  # subshell. Ordinary missing-pointer inspection continues to reject the intent.
  operations_runtime_selection_context() { operations_initial_host_context "$@"; }
  operations_compose runtime up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" --no-deps --no-build --pull never postgres >/dev/null 2>&1 || true
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  identifier="$(operations_read_database_identity)" || return 1
  operations_deployment_field STATE_SYSTEM_IDENTIFIER "$identifier" || return 1
  OPS_INITIAL_IDENTIFIER="$identifier"
  operations_inspect_bootstrap_database >/dev/null 2>&1 || return 1
  [[ "$(operations_read_database_identity)" == "$identifier" ]] || return 1
  operations_initial_volume || return 1
  operations_initial_intent_publish "$identifier" "$OPS_INITIAL_CREATED" "$@"
}

operations_initialize_private_database() {
  (operations_initial_database_checked "$@") >/dev/null 2>&1 || operations_fail operations_initialization_refused
}
