#!/usr/bin/env bash
# Internal content-free host journal. PostgreSQL still owns all business state.
# Terminal/resolved phases are recorded only after the trusted caller verifies
# job termination and operation-specific postconditions. This is not a token.

operations_job_state_invalid() { operations_fail operations_job_state_invalid; }

operations_job_state_root() {
  local root="${OPS_CONFIG[FCD_STATE_ROOT]:-}" fs lock opened shell_pid="$BASHPID"
  [[ "$(uname -s)" == Linux && "$(id -u):$(id -g)" == 1000:1000 ]] || operations_job_state_invalid
  operations_absolute_path "$root" && operations_private_directory "$root" || operations_job_state_invalid
  fs="$(stat -f -c '%T' -- "$root")" || operations_job_state_invalid
  case "$fs" in ext2/ext3|ext4|btrfs|xfs|zfs) ;; *) operations_job_state_invalid ;; esac
  [[ "${OPS_LOCK_DESCRIPTOR:-}" =~ ^[0-9]{1,6}$ ]] || operations_job_state_invalid
  lock="$root/deployment.lock"
  [[ -f "$lock" && ! -L "$lock" && "$(stat -c '%u:%g:%a:%h' -- "$lock")" == 1000:1000:600:1 ]] || operations_job_state_invalid
  opened="$(stat -Lc '%d:%i:%u:%g:%a:%h' -- "/proc/$shell_pid/fd/$OPS_LOCK_DESCRIPTOR")" || operations_job_state_invalid
  [[ "$opened" == "$(stat -c '%d:%i:%u:%g:%a:%h' -- "$lock")" ]] || operations_job_state_invalid
  flock --nonblock "$OPS_LOCK_DESCRIPTOR" 2>/dev/null || operations_job_state_invalid
  [[ -n "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]:-}" ]] && operations_config_field FCD_COMMAND_TIMEOUT_SECONDS "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}" || operations_job_state_invalid
  OPS_JOB_STATE_FILE="$root/active-job"
}

operations_job_state_field() {
  case "$1" in
    JOB_VERSION) [[ "$2" == 1 ]] ;;
    JOB_REF) [[ "$2" =~ ^operation_[a-f0-9]{32}$ ]] ;;
    JOB_PARENT) operations_config_field FCD_RUNTIME_PROJECT "$2" ;;
    JOB_SERVICE) [[ "$2" =~ ^(bootstrap|migrate|backup|verify-backup|checkpoint|health|maintenance|restore|restore-bootstrap|restore-migrate|restore-reconcile|promote|socket-recovery|runtime-inspection|restore-inspection)$ ]] ;;
    JOB_REVISION) [[ "$2" =~ ^[a-f0-9]{40}$ ]] ;;
    JOB_IMAGE) [[ "$2" =~ ^sha256:[a-f0-9]{64}$ ]] ;;
    JOB_COMMAND_SHA256) [[ "$2" =~ ^[a-f0-9]{64}$ ]] ;;
    JOB_CONTAINER) [[ "$2" == pending || "$2" =~ ^[a-f0-9]{64}$ ]] ;;
    JOB_PHASE) [[ "$2" =~ ^(intent|created|started|completed|cancelled|uncertain|resolved)$ ]] ;;
    *) return 1 ;;
  esac
}

operations_job_state_check() {
  local field
  (( ${#OPS_JOB_STATE[@]} == 9 )) || operations_job_state_invalid
  for field in JOB_VERSION JOB_REF JOB_PARENT JOB_SERVICE JOB_REVISION JOB_IMAGE JOB_COMMAND_SHA256 JOB_CONTAINER JOB_PHASE; do
    [[ -n "${OPS_JOB_STATE[$field]:-}" ]] && operations_job_state_field "$field" "${OPS_JOB_STATE[$field]}" || operations_job_state_invalid
  done
  [[ "${OPS_JOB_STATE[JOB_PARENT]}" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" ]] || operations_job_state_invalid
  case "${OPS_JOB_STATE[JOB_PHASE]}" in
    intent) [[ "${OPS_JOB_STATE[JOB_CONTAINER]}" == pending ]] || operations_job_state_invalid ;;
    created|started|completed) [[ "${OPS_JOB_STATE[JOB_CONTAINER]}" =~ ^[a-f0-9]{64}$ ]] || operations_job_state_invalid ;;
  esac
}

operations_job_state_read() {
  local file before opened after size descriptor data line key value count=0 shell_pid="$BASHPID"
  [[ "$#" == 0 ]] || operations_job_state_invalid
  operations_job_state_root
  file="$OPS_JOB_STATE_FILE"
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%u:%g:%a:%h' -- "$file")" == 1000:1000:600:1 ]] || operations_job_state_invalid
  before="$(stat -c '%d:%i:%u:%g:%a:%s:%h' -- "$file")" || operations_job_state_invalid
  size="$(stat -c '%s' -- "$file")" || operations_job_state_invalid
  [[ "$size" =~ ^[1-9][0-9]{0,3}$ ]] && (( size <= 4096 )) || operations_job_state_invalid
  exec {descriptor}<"$file" || operations_job_state_invalid
  opened="$(stat -Lc '%d:%i:%u:%g:%a:%s:%h' -- "/proc/$shell_pid/fd/$descriptor")" || operations_job_state_invalid
  [[ "$opened" == "$before" ]] || operations_job_state_invalid
  if IFS= read -r -d '' data <&"$descriptor"; then operations_job_state_invalid; fi
  after="$(stat -Lc '%d:%i:%u:%g:%a:%s:%h' -- "/proc/$shell_pid/fd/$descriptor")" || operations_job_state_invalid
  exec {descriptor}<&-
  [[ "$after" == "$before" && "${#data}" == "$size" && -f "$file" && ! -L "$file" && "$(stat -c '%d:%i:%u:%g:%a:%s:%h' -- "$file")" == "$before" && "$data" == *$'\n' ]] || operations_job_state_invalid
  OPS_JOB_STATE_FILE_ID="$(stat -c '%d:%i' -- "$file")"
  OPS_JOB_STATE_FILE_SHA256="$(printf '%s' "$data" | sha256sum)"; OPS_JOB_STATE_FILE_SHA256="${OPS_JOB_STATE_FILE_SHA256%% *}"
  data="${data%$'\n'}"
  declare -gA OPS_JOB_STATE=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    (( count += 1 )); (( count <= 9 )) || operations_job_state_invalid
    [[ "$line" =~ ^(JOB_[A-Z0-9_]+)=([^=]+)$ ]] || operations_job_state_invalid
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${OPS_JOB_STATE[$key]+present}" ]] && operations_job_state_field "$key" "$value" || operations_job_state_invalid
    OPS_JOB_STATE["$key"]="$value"
  done <<<"$data"
  operations_job_state_check
}

operations_job_state_emit() {
  local field
  operations_job_state_check
  for field in JOB_VERSION JOB_REF JOB_PARENT JOB_SERVICE JOB_REVISION JOB_IMAGE JOB_COMMAND_SHA256 JOB_CONTAINER JOB_PHASE; do
    printf '%s=%s\n' "$field" "${OPS_JOB_STATE[$field]}"
  done
}

operations_job_state_sync() {
  timeout --signal=TERM --kill-after=1s "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" sync -f -- "${OPS_CONFIG[FCD_STATE_ROOT]}" 2>/dev/null || operations_job_state_invalid
}

operations_job_state_write() {
  local file="$1"
  (umask 077; operations_job_state_emit | timeout --signal=TERM --kill-after=1s "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" dd "of=$file" conv=excl,fsync oflag=nofollow status=none) 2>/dev/null || operations_job_state_invalid
  operations_job_state_sync
}

operations_job_state_same_file() {
  local hash
  [[ -f "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" && "$(stat -c '%d:%i' -- "$OPS_JOB_STATE_FILE")" == "$OPS_JOB_STATE_FILE_ID" && "$(stat -c '%u:%g:%a:%h' -- "$OPS_JOB_STATE_FILE")" == 1000:1000:600:1 ]] || operations_job_state_invalid
  hash="$(sha256sum -- "$OPS_JOB_STATE_FILE")" || operations_job_state_invalid
  [[ "${hash%% *}" == "$OPS_JOB_STATE_FILE_SHA256" ]] || operations_job_state_invalid
}

operations_job_state_begin() {
  [[ "$#" == 4 ]] || operations_job_state_invalid
  operations_job_state_root
  [[ ! -e "$OPS_JOB_STATE_FILE" && ! -L "$OPS_JOB_STATE_FILE" ]] || operations_job_state_invalid
  declare -gA OPS_JOB_STATE=([JOB_VERSION]=1 [JOB_REF]="$1" [JOB_PARENT]="${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" [JOB_SERVICE]="$2"
    [JOB_REVISION]="${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" [JOB_IMAGE]="$3" [JOB_COMMAND_SHA256]="$4" [JOB_CONTAINER]=pending [JOB_PHASE]=intent)
  operations_job_state_check
  operations_job_state_write "$OPS_JOB_STATE_FILE"
  operations_job_state_read
}

operations_job_state_transition() {
  local reference phase container_id prior old_container temporary
  [[ "$#" == 3 ]] || operations_job_state_invalid
  reference="$1"; phase="$2"; container_id="$3"
  operations_job_state_read
  [[ "${OPS_JOB_STATE[JOB_REF]}" == "$reference" ]] && operations_job_state_field JOB_PHASE "$phase" && operations_job_state_field JOB_CONTAINER "$container_id" || operations_job_state_invalid
  prior="${OPS_JOB_STATE[JOB_PHASE]}"; old_container="${OPS_JOB_STATE[JOB_CONTAINER]}"
  case "$prior:$phase" in
    intent:created|intent:cancelled|intent:uncertain|created:started|created:cancelled|created:uncertain|started:completed|started:uncertain|uncertain:resolved) ;;
    *) operations_job_state_invalid ;;
  esac
  [[ "$old_container" == pending || "$container_id" == "$old_container" ]] || operations_job_state_invalid
  if [[ "$old_container" == pending && "$container_id" != pending && "$phase" != created && "$phase" != resolved ]]; then operations_job_state_invalid; fi
  OPS_JOB_STATE[JOB_PHASE]="$phase"; OPS_JOB_STATE[JOB_CONTAINER]="$container_id"
  operations_job_state_check
  temporary="${OPS_CONFIG[FCD_STATE_ROOT]}/active-job-${reference#operation_}.next"
  operations_job_state_write "$temporary"
  operations_job_state_same_file
  mv --no-target-directory -- "$temporary" "$OPS_JOB_STATE_FILE" 2>/dev/null || operations_job_state_invalid
  operations_job_state_sync
  operations_job_state_read
}

operations_job_state_clear() {
  [[ "$#" == 1 ]] || operations_job_state_invalid
  operations_job_state_read
  [[ "${OPS_JOB_STATE[JOB_REF]}" == "$1" && "${OPS_JOB_STATE[JOB_PHASE]}" =~ ^(completed|cancelled|resolved)$ ]] || operations_job_state_invalid
  operations_job_state_same_file
  rm -- "$OPS_JOB_STATE_FILE" 2>/dev/null || operations_job_state_invalid
  operations_job_state_sync
  unset OPS_JOB_STATE OPS_JOB_STATE_FILE_ID OPS_JOB_STATE_FILE_SHA256
}
