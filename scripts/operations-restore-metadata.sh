#!/usr/bin/env bash
# Pure metadata and Compose validation ports. No network, credentials or mounts.
operations_restore_metadata_image() {
  local metadata
  metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || return 1
  [[ "$metadata" =~ ^(sha256:[a-f0-9]{64})/([a-f0-9]{40})/linux/amd64/(node|1000|1000:1000)$ && "${BASH_REMATCH[2]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}
operations_restore_metadata_run() {
  local input="$1" image; shift
  image="$(operations_restore_metadata_image)" || return 1
  printf '%s' "$input" | operations_docker run --rm --interactive --pull never --network none --read-only --user 1000:1000 \
    --label "fcd-support.restore-metadata=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
    --cpus "${OPS_CONFIG[FCD_RESTORE_CPUS]}" --memory "${OPS_CONFIG[FCD_RESTORE_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_RESTORE_PIDS]}" \
    --entrypoint node "$image" dist/operations/restore-metadata-main.js "$@"
}
operations_restore_metadata_encode() {
  local token
  [[ "$#" == 2 && ${#1} -ge 2 && ${#1} -le 2048 && "$2" =~ ^[1-9][0-9]{0,19}$ ]] || return 1
  token="$(operations_restore_metadata_run "$1" encode "$2" "${OPS_CONFIG[FCD_POSTGRES_DB]}" "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_SCHEMA_REVISION]}")" || return 1
  [[ ${#token} -ge 4 && ${#token} -le 5464 && "$token" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] && (( ${#token} % 4 == 0 )) || return 1
  printf '%s\n' "$token"
}
operations_restore_metadata_decode() {
  local fields line
  [[ "$#" == 1 && ${#1} -ge 4 && ${#1} -le 5464 && "$1" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] && (( ${#1} % 4 == 0 )) || return 1
  fields="$(operations_restore_metadata_run '' decode-fields "$1")" || return 1
  (( ${#fields} > 0 && ${#fields} <= 2048 )) || return 1
  while IFS= read -r line; do [[ "$line" =~ ^TARGET_[A-Z_]+=[A-Za-z0-9_:-]+$ ]] || return 1; done <<<"$fields"
  printf '%s\n' "$fields"
}
operations_restore_validate_compose() {
  local model image result
  model="$(operations_compose restore --profile '*' config --format json)" || return 1
  (( ${#model} > 0 && ${#model} <= 1048576 )) || return 1
  image="$(operations_restore_metadata_image)" || return 1
  result="$(printf '%s' "$model" | operations_docker run --rm --interactive --pull never --network none --read-only --user 1000:1000 \
    --label "fcd-support.restore-metadata=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
    --cpus "${OPS_CONFIG[FCD_RESTORE_CPUS]}" --memory "${OPS_CONFIG[FCD_RESTORE_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_RESTORE_PIDS]}" \
    --entrypoint node "$image" dist/operations/compose-contract-main.js restore "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  [[ "$result" == compose_contract=true ]]
}
