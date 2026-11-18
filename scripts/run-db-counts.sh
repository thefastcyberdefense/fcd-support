#!/usr/bin/env bash
# Read-only aggregate pipeline counts wrapper using the shared preflight and journal executor.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-common.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-deployment-state.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-job-lifecycle.sh"

operations_db_counts_ready() {
  operations_selection_apply
  [[ "${OPS_SELECTION[STATE_PHASE]}" == ready && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == yes && "${OPS_SELECTION[STATE_REVISION]}" == "$OPS_REVISION" && "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || operations_fail operations_db_counts_not_ready
  OPS_DATABASE_SYSTEM_IDENTIFIER="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"
}

operations_preflight_selection() { operations_db_counts_ready; }

operations_db_counts_main() {
  local field bundle metadata image
  [[ "$#" == 2 && "$1" =~ ^[a-f0-9]{40}$ ]] || operations_fail operations_arguments_invalid
  operations_absolute_path "$2" || operations_fail operations_arguments_invalid
  OPS_REVISION="$1"; OPS_CONFIG_FILE="$2"
  [[ "$(uname -s)" == Linux ]] || operations_fail operations_platform_invalid
  OPS_ROOT="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  OPS_ACTION=verify
  operations_load_config "$OPS_CONFIG_FILE"
  operations_preflight
  operations_db_counts_ready
  operations_retained_read "$OPS_REVISION"
  [[ "${OPS_RETAINED[BUNDLE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]}" ]] || operations_fail operations_db_counts_not_ready
  for field in FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE; do
    case "$field" in
      FCD_SUPPORT_IMAGE) bundle=BUNDLE_APPLICATION_IMAGE ;;
      FCD_OPERATIONS_IMAGE) bundle=BUNDLE_OPERATIONS_IMAGE ;;
      FCD_POSTGRES_IMAGE) bundle=BUNDLE_POSTGRES_IMAGE ;;
    esac
    metadata="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "${OPS_CONFIG[$field]}")" || operations_fail operations_db_counts_not_ready
    image="${metadata%%/*}"
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$metadata" == "$image/$OPS_REVISION/linux/amd64" && "${OPS_RETAINED[$bundle]}" == "$image" ]] || operations_fail operations_db_counts_not_ready
    OPS_CONFIG[$field]="$image"
  done
  operations_execute_job maintenance db-counts
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then operations_db_counts_main "$@"; fi
