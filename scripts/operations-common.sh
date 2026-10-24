#!/usr/bin/env bash
# Private host-control helpers. Configuration is data, never shell code.
set -Eeuo pipefail
export LC_ALL=C

operations_fail() { printf '%s\n' "$1" >&2; exit 1; }

operations_protected_ancestors() {
  local current="$1" owner mode operator
  operator="$(id -u)" || return 1
  while :; do
    [[ -d "$current" && ! -L "$current" ]] || return 1
    owner="$(stat -c '%u' -- "$current")" || return 1
    mode="$(stat -c '%a' -- "$current")" || return 1
    [[ "$owner" == 0 || "$owner" == "$operator" ]] || return 1
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#022) == 0 )) || return 1
    [[ "$current" != / ]] || break
    current="$(dirname -- "$current")"
  done
}

operations_absolute_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "$1" != / && "$1" != */ && "$1" != *//* ]] || return 1
  [[ "/${1#/}/" != */../* && "/${1#/}/" != */./* ]]
}

operations_config_field() {
  local key="$1" value="$2"
  case "$key" in
    FCD_CONFIG_ROOT|FCD_SECRET_ROOT|FCD_ADMIN_SOCKET_ROOT|FCD_STATE_ROOT)
      operations_absolute_path "$value" ;;
    FCD_SUPPORT_REVISION) [[ "$value" =~ ^[a-f0-9]{40}$ ]] ;;
    FCD_INGRESS_PEER_ID) [[ "$value" =~ ^[a-f0-9]{64}$ ]] ;;
    FCD_SCHEMA_REVISION) [[ "$value" =~ ^[0-9]{6}$ ]] ;;
    FCD_DATABASE_SCHEMA) [[ "$value" =~ ^[a-z][a-z0-9_]{0,62}$ ]] ;;
    FCD_DATABASE_ROLE_PREFIX) [[ "$value" =~ ^fcd_[a-z0-9_]{1,28}$ ]] ;;
    FCD_SUPPORT_IMAGE|FCD_OPERATIONS_IMAGE|FCD_POSTGRES_IMAGE)
      [[ "$value" =~ ^[a-z0-9][a-z0-9./:@_-]{1,255}$ && "$value" != *..* ]] ;;
    FCD_RUNTIME_PROJECT|FCD_RESTORE_PROJECT|FCD_POSTGRES_VOLUME|FCD_RESTORE_VOLUME|FCD_BACKUP_VOLUME|FCD_INGRESS_NETWORK|FCD_NOTIFICATION_NETWORK)
      [[ "$value" =~ ^fcd-support[-a-z0-9_]{1,100}$ ]] ;;
    FCD_POSTGRES_DB) [[ "$value" =~ ^fcd_support(_[a-z0-9_]+)?$ ]] ;;
    FCD_ADMIN_ORIGIN) [[ "$value" =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}$ ]] ;;
    FCD_ADMIN_BROWSER_PORT)
      [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$value <= 65535 )) ;;
    FCD_COMMAND_TIMEOUT_SECONDS|FCD_READY_TIMEOUT_SECONDS)
      [[ "$value" =~ ^[1-9][0-9]{0,3}$ ]] && (( 10#$value <= 3600 )) ;;
    FCD_STOP_GRACE_MS|FCD_HEALTH_INTERVAL_MS|FCD_HEALTH_TIMEOUT_MS|FCD_HEALTH_START_MS|FCD_HEALTH_RETRIES)
      [[ "$value" =~ ^[1-9][0-9]{0,8}$ ]] && (( 10#$value <= 900000 )) ;;
    *)
      if [[ "$key" =~ ^FCD_(WEBHOOK|ADMIN|REPLY|OUTBOUND|NOTIFICATION|POSTGRES|BACKUP|VERIFY_BACKUP|MAINTENANCE|HEALTH|MIGRATE|RESTORE|CHECKPOINT)_(MEMORY_MIB|PIDS|TMPFS_MIB)$ ]]; then
        [[ "$value" =~ ^[1-9][0-9]{0,7}$ ]] && (( 10#$value <= 16777216 ))
      elif [[ "$key" =~ ^FCD_(WEBHOOK|ADMIN|REPLY|OUTBOUND|NOTIFICATION|POSTGRES|BACKUP|VERIFY_BACKUP|MAINTENANCE|HEALTH|MIGRATE|RESTORE|CHECKPOINT)_CPUS$ ]]; then
        [[ "$value" =~ ^[0-9]{1,3}(\.[0-9]{1,3})?$ && "$value" =~ [1-9] ]]
      else return 1
      fi ;;
  esac
}

operations_load_config() {
  local file="$1" before opened after descriptor data line key value size shell_pid="$BASHPID" count=0
  operations_absolute_path "$file" || operations_fail operations_config_invalid
  [[ -f "$file" && ! -L "$file" ]] || operations_fail operations_config_invalid
  operations_protected_ancestors "$(dirname -- "$file")" || operations_fail operations_config_invalid
  before="$(stat -c '%d:%i:%u:%a:%s' -- "$file")" || operations_fail operations_config_invalid
  [[ "$(stat -c '%u' -- "$file")" == "$(id -u)" ]] || operations_fail operations_config_invalid
  [[ "$(stat -c '%a' -- "$file")" == 600 || "$(stat -c '%a' -- "$file")" == 400 ]] || operations_fail operations_config_invalid
  size="$(stat -c '%s' -- "$file")"
  [[ "$size" =~ ^[1-9][0-9]{0,4}$ ]] && (( size <= 65536 )) || operations_fail operations_config_invalid
  exec {descriptor}<"$file" || operations_fail operations_config_invalid
  opened="$(stat -Lc '%d:%i:%u:%a:%s' -- "/proc/$shell_pid/fd/$descriptor")" || operations_fail operations_config_invalid
  [[ "$opened" == "$before" ]] || operations_fail operations_config_invalid
  # A successful delimiter read means a NUL was found. Otherwise the bounded
  # complete file is preserved, including trailing newlines, in this variable.
  if IFS= read -r -d '' data <&"$descriptor"; then operations_fail operations_config_invalid; fi
  after="$(stat -Lc '%d:%i:%u:%a:%s' -- "/proc/$shell_pid/fd/$descriptor")" || operations_fail operations_config_invalid
  exec {descriptor}<&-
  [[ "$after" == "$before" && "${#data}" == "$size" ]] || operations_fail operations_config_invalid
  declare -gA OPS_CONFIG=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    (( count += 1 )); (( count <= 512 )) || operations_fail operations_config_invalid
    line="${line%$'\r'}"
    [[ -n "$line" && "$line" != \#* ]] || continue
    [[ "$line" =~ ^(FCD_[A-Z0-9_]+)=([^=]+)$ ]] || operations_fail operations_config_invalid
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${OPS_CONFIG[$key]+present}" ]] || operations_fail operations_config_invalid
    operations_config_field "$key" "$value" || operations_fail operations_config_invalid
    OPS_CONFIG["$key"]="$value"
  done <<<"$data"
  unset data
}

operations_parse_arguments() {
  OPS_ACTION="$1"; shift
  OPS_BACKUP_REF=''; OPS_CHECKPOINT_REF=''; OPS_RESTORE_REF=''
  case "$OPS_ACTION" in
    deploy) [[ "$#" == 4 && "$2" == --mode && "$3" == private-disabled ]] || operations_fail operations_arguments_invalid; OPS_REVISION="$1"; OPS_CONFIG_FILE="$4" ;;
    verify) [[ "$#" == 2 ]] || operations_fail operations_arguments_invalid; OPS_REVISION="$1"; OPS_CONFIG_FILE="$2" ;;
    rollback) [[ "$#" == 3 && "$2" == --confirm-schema-compatible ]] || operations_fail operations_arguments_invalid; OPS_REVISION="$1"; OPS_CONFIG_FILE="$3" ;;
    restore)
      [[ "$#" == 4 && "$1" =~ ^backup_[a-f0-9]{32}$ && "$2" =~ ^checkpoint_[a-f0-9]{32}$ ]] || operations_fail operations_arguments_invalid
      OPS_BACKUP_REF="$1"; OPS_CHECKPOINT_REF="$2"; OPS_REVISION="$3"; OPS_CONFIG_FILE="$4" ;;
    promote)
      [[ "$#" == 3 && "$1" =~ ^restore_[a-f0-9]{32}$ ]] || operations_fail operations_arguments_invalid
      OPS_RESTORE_REF="$1"; OPS_REVISION="$2"; OPS_CONFIG_FILE="$3" ;;
    recover-admin-socket) [[ "$#" == 3 && "$2" == --confirm-admin-stopped ]] || operations_fail operations_arguments_invalid; OPS_REVISION="$1"; OPS_CONFIG_FILE="$3" ;;
    *) operations_fail operations_arguments_invalid ;;
  esac
  [[ "$OPS_REVISION" =~ ^[a-f0-9]{40}$ ]] || operations_fail operations_arguments_invalid
}

operations_compose() {
  local kind="$1" key seconds grace; shift
  local -a settings=() files=() endpoint=()
  [[ -z "${OPS_DOCKER_ENDPOINT:-}" ]] || endpoint=(--host "$OPS_DOCKER_ENDPOINT")
  for key in "${!OPS_CONFIG[@]}"; do settings+=("$key=${OPS_CONFIG[$key]}"); done
  case "$kind" in
    runtime) files=(--file "$OPS_ROOT/infra/compose.runtime.yml") ;;
    operations) files=(--file "$OPS_ROOT/infra/compose.operations.yml") ;;
    restore) files=(--file "$OPS_ROOT/infra/compose.restore.yml") ;;
    *) operations_fail operations_config_invalid ;;
  esac
  seconds="${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}"
  grace="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))"
  # An empty explicit env file and empty child environment prevent ambient
  # Compose files/profiles, Docker endpoints, dotenv and credential injection.
  env -i "PATH=$PATH" LC_ALL=C COMPOSE_DISABLE_ENV_FILE=1 "${settings[@]}" \
    timeout --signal=TERM --kill-after="${grace}s" "${seconds}s" \
    docker "${endpoint[@]}" compose --project-directory "$OPS_ROOT" --env-file /dev/null "${files[@]}" "$@" 2>/dev/null
}

operations_docker() {
  local -a endpoint=()
  [[ -z "${OPS_DOCKER_ENDPOINT:-}" ]] || endpoint=(--host "$OPS_DOCKER_ENDPOINT")
  env -i "PATH=$PATH" LC_ALL=C timeout --signal=TERM \
    --kill-after="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))s" \
    "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" docker "${endpoint[@]}" "$@" 2>/dev/null
}

operations_job() {
  local service="$1" field; shift
  local -a target=()
  if [[ "$service" == migrate ]]; then
    [[ "${OPS_DATABASE_SYSTEM_IDENTIFIER:-}" =~ ^[1-9][0-9]{0,19}$ ]] || return 1
    for field in FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_DATABASE_ROLE_PREFIX FCD_SCHEMA_REVISION; do
      [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || return 1
    done
    target=(--env "OPS_DATABASE_SYSTEM_IDENTIFIER=$OPS_DATABASE_SYSTEM_IDENTIFIER"
      --env "OPS_DATABASE_NAME=${OPS_CONFIG[FCD_POSTGRES_DB]}"
      --env "OPS_DATABASE_SCHEMA=${OPS_CONFIG[FCD_DATABASE_SCHEMA]}"
      --env "OPS_DATABASE_ROLE_PREFIX=${OPS_CONFIG[FCD_DATABASE_ROLE_PREFIX]}"
      --env "OPS_SCHEMA_REVISION=${OPS_CONFIG[FCD_SCHEMA_REVISION]}")
  fi
  operations_compose operations --profile "operations-$service" run --rm --no-TTY --no-deps \
    "${target[@]}" "$service" node dist/operations-main.js "$@"
}

operations_stop_applications() {
  local seconds="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))"
  operations_compose runtime --profile '*' stop --timeout "$seconds" \
    fcd-support-api fcd-support-admin fcd-support-reply fcd-support-outbound fcd-support-notification >/dev/null
}

operations_start_private() {
  operations_compose runtime up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" \
    --no-build --pull never fcd-support-api fcd-support-admin fcd-support-reply >/dev/null
}

operations_deploy() {
  local backup timestamp
  operations_stop_applications || operations_fail operations_drain_failed
  operations_compose runtime up --detach --wait --wait-timeout "${OPS_CONFIG[FCD_READY_TIMEOUT_SECONDS]}" \
    --no-build --pull never postgres >/dev/null || operations_fail operations_database_start_failed
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  backup="$(operations_job backup pre-migration-backup "$timestamp")" || operations_fail operations_backup_failed
  [[ "$backup" =~ ^backup_[a-f0-9]{32}$ ]] || operations_fail operations_backup_failed
  operations_job verify-backup verify-backup "$backup" >/dev/null || operations_fail operations_backup_verification_failed
  operations_job migrate migrate >/dev/null || operations_fail operations_migration_failed
  # This second isolated verification adopts the pre-schema manifest only after
  # the operations catalog exists. No restore identity reaches the migrator.
  operations_job verify-backup verify-backup "$backup" >/dev/null || operations_fail operations_backup_registration_failed
  operations_job migrate deployment-started >/dev/null || operations_fail operations_evidence_failed
  if ! operations_start_private; then
    operations_stop_applications || true
    operations_job migrate deployment-failed >/dev/null || true
    operations_fail operations_start_failed
  fi
  if ! operations_job migrate verify-runtime >/dev/null; then
    operations_stop_applications || true
    operations_job migrate deployment-failed >/dev/null || true
    operations_fail operations_verification_failed
  fi
  operations_job migrate deployment-succeeded >/dev/null || {
    operations_stop_applications || true
    operations_fail operations_evidence_failed
  }
}

operations_disjoint() {
  [[ "$1" != "$2" && "$1/" != "$2/"* && "$2/" != "$1/"* ]]
}

operations_private_directory() {
  local path="$1"
  [[ -d "$path" && ! -L "$path" && "$(realpath -e -- "$path" 2>/dev/null)" == "$path" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' -- "$path")" == 1000:1000:700 ]] || return 1
  operations_protected_ancestors "$path"
}

operations_exact_revision() {
  local top current status
  top="$(git -c core.fsmonitor=false -C "$OPS_ROOT" rev-parse --show-toplevel 2>/dev/null)" || operations_fail operations_revision_invalid
  current="$(git -c core.fsmonitor=false -C "$OPS_ROOT" rev-parse HEAD 2>/dev/null)" || operations_fail operations_revision_invalid
  status="$(git -c core.fsmonitor=false -C "$OPS_ROOT" status --porcelain --untracked-files=normal 2>/dev/null)" || operations_fail operations_revision_invalid
  [[ "$top" == "$OPS_ROOT" && "$current" == "$OPS_REVISION" && -z "$status" ]] || operations_fail operations_revision_invalid
}

operations_socket_root() {
  local socket="${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}" path
  [[ "$(id -u):$(id -g)" == 1000:1000 && -r "$socket" && -w "$socket" && -x "$socket" ]] || operations_fail operations_socket_root_invalid
  operations_private_directory "$socket" || operations_fail operations_socket_root_invalid
  for path in "$OPS_ROOT" "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" "${OPS_CONFIG[FCD_STATE_ROOT]}"; do
    operations_disjoint "$path" "$socket" || operations_fail operations_socket_root_invalid
  done
  case "$OPS_ACTION" in verify|recover-admin-socket) ;;
    *) [[ ! -e "$socket/admin.sock" && ! -L "$socket/admin.sock" ]] || operations_fail operations_socket_present ;;
  esac
}

operations_image_revisions() {
  local field revision architecture
  for field in FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE; do
    revision="$(operations_docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${OPS_CONFIG[$field]}")" || operations_fail operations_image_invalid
    architecture="$(operations_docker image inspect --format '{{.Os}}/{{.Architecture}}' "${OPS_CONFIG[$field]}")" || operations_fail operations_image_invalid
    [[ "$revision" == "$OPS_REVISION" && "$architecture" == linux/amd64 ]] || operations_fail operations_image_invalid
  done
}

operations_preflight() {
  local field path volume shape mountpoint lock before opened shell_pid="$BASHPID"
  for field in FCD_SUPPORT_REVISION FCD_SCHEMA_REVISION FCD_CONFIG_ROOT FCD_SECRET_ROOT FCD_STATE_ROOT FCD_ADMIN_SOCKET_ROOT \
    FCD_RUNTIME_PROJECT FCD_SUPPORT_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_IMAGE FCD_POSTGRES_DB FCD_DATABASE_SCHEMA FCD_DATABASE_ROLE_PREFIX FCD_POSTGRES_VOLUME FCD_BACKUP_VOLUME \
    FCD_COMMAND_TIMEOUT_SECONDS FCD_READY_TIMEOUT_SECONDS FCD_STOP_GRACE_MS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] || operations_fail operations_config_invalid
  done
  [[ "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" == "$OPS_REVISION" && "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" != "${OPS_CONFIG[FCD_BACKUP_VOLUME]}" ]] || operations_fail operations_config_invalid
  for field in FCD_CONFIG_ROOT FCD_SECRET_ROOT FCD_STATE_ROOT; do
    path="${OPS_CONFIG[$field]}"
    operations_private_directory "$path" || operations_fail operations_config_invalid
    operations_disjoint "$path" "$OPS_ROOT" || operations_fail operations_config_invalid
  done
  operations_disjoint "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" || operations_fail operations_config_invalid
  operations_disjoint "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_STATE_ROOT]}" || operations_fail operations_config_invalid
  operations_disjoint "${OPS_CONFIG[FCD_SECRET_ROOT]}" "${OPS_CONFIG[FCD_STATE_ROOT]}" || operations_fail operations_config_invalid
  operations_socket_root
  operations_exact_revision
  lock="${OPS_CONFIG[FCD_STATE_ROOT]}/deployment.lock"
  [[ -f "$lock" && ! -L "$lock" && "$(stat -c '%u:%g:%a' -- "$lock")" == 1000:1000:600 ]] || operations_fail operations_lock_invalid
  before="$(stat -c '%d:%i' -- "$lock")"
  exec {OPS_LOCK_DESCRIPTOR}<>"$lock" || operations_fail operations_lock_invalid
  opened="$(stat -Lc '%d:%i' -- "/proc/$shell_pid/fd/$OPS_LOCK_DESCRIPTOR")" || operations_fail operations_lock_invalid
  [[ "$before" == "$opened" ]] || operations_fail operations_lock_invalid
  flock --nonblock "$OPS_LOCK_DESCRIPTOR" 2>/dev/null || operations_fail operations_lock_conflict
  # A crashed job may still be running or may have committed without an ACK.
  # Its protected record must be reconciled before any new host operation.
  [[ ! -e "${OPS_CONFIG[FCD_STATE_ROOT]}/active-job" && ! -L "${OPS_CONFIG[FCD_STATE_ROOT]}/active-job" ]] || operations_fail operations_job_pending
  unset OPS_DOCKER_ENDPOINT
  OPS_DOCKER_ENDPOINT="$(operations_docker context inspect --format '{{(index .Endpoints "docker").Host}}')" || operations_fail operations_daemon_invalid
  [[ "$OPS_DOCKER_ENDPOINT" == unix:///* ]] && operations_absolute_path "${OPS_DOCKER_ENDPOINT#unix://}" || operations_fail operations_daemon_invalid
  operations_image_revisions
  for volume in "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" "${OPS_CONFIG[FCD_BACKUP_VOLUME]}"; do
    shape="$(operations_docker volume inspect --format '{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}' "$volume")" || operations_fail operations_volume_invalid
    mountpoint="$(operations_docker volume inspect --format '{{.Mountpoint}}' "$volume")" || operations_fail operations_volume_invalid
    [[ "$shape" == local/local/default ]] && operations_absolute_path "$mountpoint" || operations_fail operations_volume_invalid
    operations_disjoint "$mountpoint" "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}" || operations_fail operations_socket_root_invalid
  done
}

operations_require_handlers() {
  local handler
  local -a handlers=()
  case "$OPS_ACTION" in
    deploy) handlers=(operations_deploy operations_verify) ;;
    verify) handlers=(operations_verify) ;;
    rollback) handlers=(operations_rollback operations_verify) ;;
    restore) handlers=(operations_restore) ;;
    promote) handlers=(operations_promote operations_verify) ;;
    recover-admin-socket) handlers=(operations_recover_socket) ;;
    *) operations_fail operations_arguments_invalid ;;
  esac
  # A partial installation cannot start an outage or attach storage without its
  # actual verification/recovery code. Missing handlers are never bypassed.
  for handler in "${handlers[@]}"; do
    declare -F "$handler" >/dev/null || operations_fail operations_action_unavailable
  done
}

operations_main() {
  operations_parse_arguments "$@"
  operations_require_handlers
  [[ "$(uname -s)" == Linux ]] || operations_fail operations_platform_invalid
  OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  operations_load_config "$OPS_CONFIG_FILE"
  operations_preflight
  case "$OPS_ACTION" in
    deploy) operations_deploy ;;
    verify) operations_verify ;;
    rollback) operations_rollback ;;
    restore) operations_restore ;;
    promote) operations_promote ;;
    recover-admin-socket) operations_recover_socket ;;
  esac
}
