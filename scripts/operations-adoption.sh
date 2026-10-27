#!/usr/bin/env bash
# Internal first-admission intent. Caller supplies independently pinned source
# images/revision and keeps protected config, local Docker and deployment lock.
# This never proves readiness, drains an actor or starts a container.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-drain.sh"

operations_adoption_checked() {
  local revision="$1" application_image="$2" postgres_image="$3" field file root image postgres before volume mount identifier created prefix tail token
  [[ "$revision" =~ ^[a-f0-9]{40}$ && "$application_image" =~ ^sha256:[a-f0-9]{64}$ && "$postgres_image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  for field in FCD_RUNTIME_PROJECT FCD_POSTGRES_VOLUME FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_COMMAND_TIMEOUT_SECONDS FCD_STOP_GRACE_MS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || return 1
  done
  operations_job_state_root
  operations_deployment_state_root
  root="${OPS_CONFIG[FCD_STATE_ROOT]}"
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || return 1
  # A lost pointer must never disguise an existing managed/used deployment.
  for file in "$root/deployment-state" "$root/deployment-state.next" "$root/initial-deployment.record" "$root/initial-deployment.record.next" "$root"/volume-*.record "$root"/retained-*.record; do
    [[ ! -e "$file" && ! -L "$file" ]] || return 1
  done
  image="$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$application_image")" || return 1
  [[ "$image" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64/(node|1000|1000:1000)$ && "$image" == "$application_image/$revision/"* ]] || return 1
  [[ "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$postgres_image")" == "$postgres_image/none/linux/amd64/none" ]] || return 1
  postgres="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --filter label=com.docker.compose.service=postgres)" || return 1
  [[ "$postgres" =~ ^[a-f0-9]{64}$ ]] || return 1
  before="$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$postgres")" || return 1
  prefix="$postgres/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres/none/$postgres_image/running/true/false/false/false/"
  [[ "$before" == "$prefix"* ]] || return 1
  tail="${before#"$prefix"}"
  [[ "$tail" =~ ^(postgres|999|999:999)/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || return 1
  local volume_format='{{.Name}}/{{.CreatedAt}}/{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{with index .Labels "com.docker.compose.project"}}{{.}}{{else}}none{{end}}/{{with index .Labels "com.docker.compose.volume"}}{{.}}{{else}}none{{end}}'
  local mount_format='{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name .Destination .RW}}{{end}}{{end}}'
  volume="$(operations_docker volume inspect --format "$volume_format" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  created="${volume#"${OPS_CONFIG[FCD_POSTGRES_VOLUME]}/"}"
  created="${created%"/local/local/default/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres-data"}"
  operations_deployment_field STATE_VOLUME_CREATED_AT "$created" || return 1
  [[ "$volume" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}/$created/local/local/default/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres-data" ]] || return 1
  mount="$(operations_docker container inspect --format "$mount_format" "$postgres")" || return 1
  [[ "$mount" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]} /var/lib/postgresql true" ]] || return 1
  identifier="$(operations_read_database_control_identifier "$postgres")" || return 1
  [[ "$(operations_docker container inspect --format "$OPERATIONS_DRAIN_ACTOR_FORMAT" "$postgres")" == "$before" && "$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --filter label=com.docker.compose.service=postgres)" == "$postgres" ]] || return 1
  [[ "$(operations_docker volume inspect --format "$volume_format" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" == "$volume" && "$(operations_docker container inspect --format "$mount_format" "$postgres")" == "$mount" ]] || return 1
  [[ "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$application_image")" == "$image" && "$(operations_docker image inspect --format "$OPERATIONS_DRAIN_IMAGE_FORMAT" "$postgres_image")" == "$postgres_image/none/linux/amd64/none" ]] || return 1
  token="$(od -An -N16 -tx1 /dev/urandom)" || return 1
  token="${token//[[:space:]]/}"; [[ "$token" =~ ^[a-f0-9]{32}$ ]] || return 1
  # Zero is explicitly provisional: adoption cannot establish an SQL schema
  # version or manufacture retained/ready evidence. Backup/migration verify it.
  operations_selection_adopt_draining "selection_$token" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" \
    "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" postgres-data "$created" "$identifier" \
    "${OPS_CONFIG[FCD_POSTGRES_DB]}" "$revision" 000000
}

operations_adopt_admission() {
  if [[ "$#" == 3 ]] && (operations_adoption_checked "$@") >/dev/null 2>&1; then return 0; fi
  # Preserve incomplete immutable history/selection writes for reconciliation;
  # never erase them or modify existing deployment state after a refusal.
  operations_fail operations_admission_adoption_refused
}
