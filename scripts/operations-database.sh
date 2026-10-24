#!/usr/bin/env bash
# Internal physical-identity read. Caller retains selected-storage metadata
# proof, protected configuration, a local Docker endpoint and deployment lock.

IFS= read -r -d '' OPERATIONS_DATABASE_CONTROL_COMMAND <<'CONTROL' || true
pg_controldata /var/lib/postgresql/18/docker 2>&1 | awk '
/^(pg_controldata:|WARNING:|ERROR:)/ {bad=1}
/^Database system identifier:[ \t]+[1-9][0-9]*$/ {count++; value=$NF}
END {if(count!=1 || bad)exit 1; printf "%s\n",value}'
CONTROL

operations_read_database_identity() {
  local field image image_id postgres before after prefix reply value
  local format='{{.Id}}/{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Image}}/{{.State.Running}}/{{.State.Paused}}/{{.State.Restarting}}/{{.State.Dead}}/{{.State.StartedAt}}'
  local image_format='{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}'
  [[ "$#" == 0 ]] || operations_fail operations_database_identity_invalid
  for field in FCD_RUNTIME_PROJECT FCD_SUPPORT_REVISION FCD_POSTGRES_IMAGE; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || operations_fail operations_database_identity_invalid
  done
  image="$(operations_docker image inspect --format "$image_format" "${OPS_CONFIG[FCD_POSTGRES_IMAGE]}")" || operations_fail operations_database_identity_invalid
  [[ "$image" =~ ^(sha256:[a-f0-9]{64})/([a-f0-9]{40})/linux/amd64/(postgres|999|999:999)$ && "${BASH_REMATCH[2]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || operations_fail operations_database_identity_invalid
  image_id="${BASH_REMATCH[1]}"
  postgres="$(operations_runtime_id postgres)" || operations_fail operations_database_identity_invalid
  before="$(operations_docker container inspect --format "$format" "$postgres")" || operations_fail operations_database_identity_invalid
  prefix="$postgres/${OPS_CONFIG[FCD_RUNTIME_PROJECT]}/postgres/${OPS_CONFIG[FCD_SUPPORT_REVISION]}/$image_id/true/false/false/false/"
  [[ "$before" == "$prefix"* && "${before#"$prefix"}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] || operations_fail operations_database_identity_invalid
  # The fixed container-side pipeline emits only one identifier. Tool errors,
  # CRC warnings and failed pipelines cannot produce an accepted identity.
  # A sentinel preserves trailing newlines for strict single-line validation.
  reply="$(operations_docker exec "$postgres" env LC_ALL=C bash -o pipefail -c "$OPERATIONS_DATABASE_CONTROL_COMMAND" && printf '%s' .physical-id-end)" || operations_fail operations_database_identity_invalid
  [[ "$reply" == *$'\n.physical-id-end' ]] || operations_fail operations_database_identity_invalid
  value="${reply%$'\n.physical-id-end'}"
  [[ "$value" =~ ^[1-9][0-9]{0,19}$ && "$value" != *$'\n'* ]] || operations_fail operations_database_identity_invalid
  if (( ${#value} == 20 )) && [[ "$value" > 18446744073709551615 ]]; then operations_fail operations_database_identity_invalid; fi
  after="$(operations_docker container inspect --format "$format" "$postgres")" || operations_fail operations_database_identity_invalid
  [[ "$after" == "$before" && "$(operations_runtime_id postgres)" == "$postgres" && "$(operations_docker image inspect --format "$image_format" "${OPS_CONFIG[FCD_POSTGRES_IMAGE]}")" == "$image" ]] || operations_fail operations_database_identity_invalid
  printf '%s\n' "$value"
}
