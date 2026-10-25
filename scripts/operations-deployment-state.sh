#!/usr/bin/env bash
# Private host metadata only. A record never authorizes Docker attachment: the
# trusted controller must retain its lock and current SQL/host verification.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-job-state.sh"

operations_deployment_state_invalid() { operations_fail operations_deployment_state_invalid; }
operations_deployment_state_root() {
  (operations_job_state_root) >/dev/null 2>&1 || operations_deployment_state_invalid
  operations_config_field FCD_RUNTIME_PROJECT "${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" || operations_deployment_state_invalid
  operations_config_field FCD_POSTGRES_DB "${OPS_CONFIG[FCD_POSTGRES_DB]:-}" && operations_config_field FCD_DATABASE_SCHEMA "${OPS_CONFIG[FCD_DATABASE_SCHEMA]:-}" || operations_deployment_state_invalid
}
operations_deployment_record_fields() {
  case "$1" in
    selection) OPS_DEPLOYMENT_FIELDS=(STATE_VERSION STATE_PROJECT STATE_REF STATE_PHASE STATE_VOLUME STATE_VOLUME_ORIGIN STATE_VOLUME_LOGICAL STATE_VOLUME_CREATED_AT STATE_SYSTEM_IDENTIFIER STATE_DATABASE_NAME STATE_SCHEMA_NAME STATE_PREVIOUS_VOLUME STATE_RESTORE_REF STATE_WRITES_POSSIBLE STATE_REVISION STATE_SCHEMA_REVISION) ;;
    used) OPS_DEPLOYMENT_FIELDS=(USED_VERSION USED_PROJECT USED_VOLUME USED_CREATED_AT USED_SYSTEM_IDENTIFIER USED_FIRST_SELECTION USED_ORIGIN USED_LOGICAL USED_DATABASE_NAME USED_SCHEMA_NAME) ;;
    retained) OPS_DEPLOYMENT_FIELDS=(BUNDLE_VERSION BUNDLE_PROJECT BUNDLE_REVISION BUNDLE_SCHEMA_REVISION BUNDLE_DATABASE_NAME BUNDLE_SCHEMA_NAME BUNDLE_APPLICATION_IMAGE BUNDLE_OPERATIONS_IMAGE BUNDLE_POSTGRES_IMAGE) ;;
    *) operations_deployment_state_invalid ;;
  esac
}
operations_deployment_record_path() {
  local hash
  operations_deployment_state_root
  case "$1" in
    selection) [[ -z "$2" ]] || operations_deployment_state_invalid; printf '%s/deployment-state' "${OPS_CONFIG[FCD_STATE_ROOT]}" ;;
    retained) [[ "$2" =~ ^[a-f0-9]{40}$ ]] || operations_deployment_state_invalid; printf '%s/retained-%s.record' "${OPS_CONFIG[FCD_STATE_ROOT]}" "$2" ;;
    used)
      operations_config_field FCD_POSTGRES_VOLUME "$2" || operations_deployment_state_invalid
      hash="$(printf '%s' "$2" | sha256sum)"; hash="${hash%% *}"
      [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || operations_deployment_state_invalid
      printf '%s/volume-%s.record' "${OPS_CONFIG[FCD_STATE_ROOT]}" "$hash" ;;
    *) operations_deployment_state_invalid ;;
  esac
}
operations_deployment_field() {
  case "$1" in
    STATE_VERSION|USED_VERSION|BUNDLE_VERSION) [[ "$2" == 1 ]] ;;
    STATE_PROJECT|USED_PROJECT|BUNDLE_PROJECT) [[ "$2" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" ]] ;;
    STATE_REF|USED_FIRST_SELECTION) [[ "$2" =~ ^selection_[a-f0-9]{32}$ ]] ;;
    STATE_PHASE) [[ "$2" =~ ^(quiescent|switching|starting|ready|uncertain)$ ]] ;;
    STATE_VOLUME|USED_VOLUME) operations_config_field FCD_POSTGRES_VOLUME "$2" ;;
    STATE_VOLUME_ORIGIN|USED_ORIGIN) [[ "$2" == none ]] || operations_config_field FCD_RUNTIME_PROJECT "$2" ;;
    STATE_VOLUME_LOGICAL|USED_LOGICAL) [[ "$2" =~ ^(postgres-data|restore-data|none)$ ]] ;;
    STATE_VOLUME_CREATED_AT|USED_CREATED_AT) [[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] ;;
    STATE_SYSTEM_IDENTIFIER|USED_SYSTEM_IDENTIFIER)
      [[ "$2" =~ ^[1-9][0-9]{0,19}$ ]] && { (( ${#2} < 20 )) || [[ "$2" < 18446744073709551615 || "$2" == 18446744073709551615 ]]; } ;;
    STATE_DATABASE_NAME|USED_DATABASE_NAME|BUNDLE_DATABASE_NAME) [[ "$2" == "${OPS_CONFIG[FCD_POSTGRES_DB]}" ]] ;;
    STATE_SCHEMA_NAME|USED_SCHEMA_NAME|BUNDLE_SCHEMA_NAME) [[ "$2" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" ]] ;;
    STATE_PREVIOUS_VOLUME) [[ "$2" == none ]] || operations_config_field FCD_POSTGRES_VOLUME "$2" ;;
    STATE_RESTORE_REF) [[ "$2" == none || "$2" =~ ^restore_[a-f0-9]{32}$ ]] ;;
    STATE_WRITES_POSSIBLE) [[ "$2" == yes || "$2" == no ]] ;;
    STATE_REVISION|BUNDLE_REVISION) [[ "$2" =~ ^[a-f0-9]{40}$ ]] ;;
    STATE_SCHEMA_REVISION|BUNDLE_SCHEMA_REVISION) [[ "$2" =~ ^[0-9]{6}$ ]] ;;
    BUNDLE_APPLICATION_IMAGE|BUNDLE_OPERATIONS_IMAGE|BUNDLE_POSTGRES_IMAGE) [[ "$2" =~ ^sha256:[a-f0-9]{64}$ ]] ;;
    *) return 1 ;;
  esac
}
operations_deployment_record_check() {
  local kind="$1" selector="$2" field
  operations_deployment_record_fields "$kind"
  (( ${#OPS_DEPLOYMENT_RECORD[@]} == ${#OPS_DEPLOYMENT_FIELDS[@]} )) || operations_deployment_state_invalid
  for field in "${OPS_DEPLOYMENT_FIELDS[@]}"; do
    [[ -n "${OPS_DEPLOYMENT_RECORD[$field]:-}" ]] && operations_deployment_field "$field" "${OPS_DEPLOYMENT_RECORD[$field]}" || operations_deployment_state_invalid
  done
  case "$kind" in
    retained) [[ "${OPS_DEPLOYMENT_RECORD[BUNDLE_REVISION]}" == "$selector" ]] || operations_deployment_state_invalid ;;
    used)
      [[ "${OPS_DEPLOYMENT_RECORD[USED_VOLUME]}" == "$selector" ]] || operations_deployment_state_invalid
      case "${OPS_DEPLOYMENT_RECORD[USED_LOGICAL]}" in
        none) [[ "${OPS_DEPLOYMENT_RECORD[USED_ORIGIN]}" == none ]] || operations_deployment_state_invalid ;;
        postgres-data) [[ "${OPS_DEPLOYMENT_RECORD[USED_ORIGIN]}" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" ]] || operations_deployment_state_invalid ;;
        restore-data) [[ "${OPS_DEPLOYMENT_RECORD[USED_ORIGIN]}" =~ ^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$ ]] || operations_deployment_state_invalid ;;
      esac ;;
    selection)
      case "${OPS_DEPLOYMENT_RECORD[STATE_PHASE]}" in
        starting|ready) [[ "${OPS_DEPLOYMENT_RECORD[STATE_WRITES_POSSIBLE]}" == yes ]] || operations_deployment_state_invalid ;;
        switching) [[ "${OPS_DEPLOYMENT_RECORD[STATE_WRITES_POSSIBLE]}" == no && "${OPS_DEPLOYMENT_RECORD[STATE_RESTORE_REF]}" != none ]] || operations_deployment_state_invalid ;;
      esac
      if [[ "${OPS_DEPLOYMENT_RECORD[STATE_RESTORE_REF]}" == none ]]; then
        [[ "${OPS_DEPLOYMENT_RECORD[STATE_PREVIOUS_VOLUME]}" == none ]] || operations_deployment_state_invalid
        if [[ "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME_ORIGIN]}" == none ]]; then
          [[ "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME_LOGICAL]}" == none ]] || operations_deployment_state_invalid
        else
          [[ "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME_ORIGIN]}" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" && "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME_LOGICAL]}" == postgres-data ]] || operations_deployment_state_invalid
        fi
      else
        [[ "${OPS_DEPLOYMENT_RECORD[STATE_PREVIOUS_VOLUME]}" != none && "${OPS_DEPLOYMENT_RECORD[STATE_PREVIOUS_VOLUME]}" != "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME]}" && "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME_LOGICAL]}" == restore-data && "${OPS_DEPLOYMENT_RECORD[STATE_VOLUME_ORIGIN]}" =~ ^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$ ]] || operations_deployment_state_invalid
      fi ;;
  esac
}
operations_deployment_record_read() {
  local kind="$1" selector="$2" file before descriptor opened after data size line key value count=0 shell_pid="$BASHPID" hash
  file="$(operations_deployment_record_path "$kind" "$selector")" || operations_deployment_state_invalid
  [[ -f "$file" && ! -L "$file" && ! -e "$file.next" && ! -L "$file.next" && "$(stat -c '%u:%g:%a:%h' -- "$file")" == 1000:1000:600:1 ]] || operations_deployment_state_invalid
  size="$(stat -c '%s' -- "$file")"; [[ "$size" =~ ^[1-9][0-9]{0,3}$ ]] && (( size <= 8192 )) || operations_deployment_state_invalid
  before="$(stat -c '%d:%i:%u:%g:%a:%s:%h' -- "$file")"
  exec {descriptor}<"$file" || operations_deployment_state_invalid
  opened="$(stat -Lc '%d:%i:%u:%g:%a:%s:%h' -- "/proc/$shell_pid/fd/$descriptor")" || operations_deployment_state_invalid
  [[ "$opened" == "$before" ]] || operations_deployment_state_invalid
  if IFS= read -r -d '' data <&"$descriptor"; then operations_deployment_state_invalid; fi
  after="$(stat -Lc '%d:%i:%u:%g:%a:%s:%h' -- "/proc/$shell_pid/fd/$descriptor")" || operations_deployment_state_invalid
  exec {descriptor}<&-
  [[ "$after" == "$before" && "${#data}" == "$size" && "$data" == *$'\n' && -f "$file" && ! -L "$file" && "$(stat -c '%d:%i:%u:%g:%a:%s:%h' -- "$file")" == "$before" ]] || operations_deployment_state_invalid
  OPS_DEPLOYMENT_RECORD_ID="$(stat -c '%d:%i' -- "$file")"
  hash="$(printf '%s' "$data" | sha256sum)"; OPS_DEPLOYMENT_RECORD_SHA256="${hash%% *}"
  data="${data%$'\n'}"
  declare -gA OPS_DEPLOYMENT_RECORD=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((count+=1)); ((count<=16)) || operations_deployment_state_invalid
    [[ "$line" =~ ^([A-Z_]+)=([A-Za-z0-9_./:-]+)$ ]] || operations_deployment_state_invalid
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${OPS_DEPLOYMENT_RECORD[$key]+present}" ]] && operations_deployment_field "$key" "$value" || operations_deployment_state_invalid
    OPS_DEPLOYMENT_RECORD["$key"]="$value"
  done <<< "$data"
  operations_deployment_record_check "$kind" "$selector"
}
operations_deployment_record_emit() {
  local field
  operations_deployment_record_check "$1" "$2"
  for field in "${OPS_DEPLOYMENT_FIELDS[@]}"; do printf '%s=%s\n' "$field" "${OPS_DEPLOYMENT_RECORD[$field]}"; done
}
operations_deployment_record_sync() { (operations_job_state_sync) >/dev/null 2>&1 || operations_deployment_state_invalid; }
operations_deployment_record_write() {
  local file="$1" body="$2"
  (( ${#body} > 0 && ${#body} < 8192 )) || operations_deployment_state_invalid
  (umask 077; printf '%s\n' "$body" | timeout --signal=TERM --kill-after=1s "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" dd "of=$file" conv=excl,fsync oflag=nofollow status=none) 2>/dev/null || operations_deployment_state_invalid
  operations_deployment_record_sync
}
operations_deployment_record_create() {
  local kind="$1" selector="$2" body="$3" file
  file="$(operations_deployment_record_path "$kind" "$selector")" || operations_deployment_state_invalid
  [[ ! -e "$file" && ! -L "$file" && ! -e "$file.next" && ! -L "$file.next" ]] || operations_deployment_state_invalid
  operations_deployment_record_write "$file" "$body"
  operations_deployment_record_read "$kind" "$selector"
}
operations_selection_read() {
  local field
  [[ "$#" == 0 ]] || operations_deployment_state_invalid
  operations_deployment_record_read selection ''
  declare -gA OPS_SELECTION=()
  for field in "${!OPS_DEPLOYMENT_RECORD[@]}"; do OPS_SELECTION["$field"]="${OPS_DEPLOYMENT_RECORD[$field]}"; done
  OPS_SELECTION_FILE_ID="$OPS_DEPLOYMENT_RECORD_ID"; OPS_SELECTION_FILE_SHA256="$OPS_DEPLOYMENT_RECORD_SHA256"
  operations_deployment_record_read used "${OPS_SELECTION[STATE_VOLUME]}"
  [[ "${OPS_DEPLOYMENT_RECORD[USED_CREATED_AT]}" == "${OPS_SELECTION[STATE_VOLUME_CREATED_AT]}" && "${OPS_DEPLOYMENT_RECORD[USED_SYSTEM_IDENTIFIER]}" == "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" && "${OPS_DEPLOYMENT_RECORD[USED_FIRST_SELECTION]}" == "${OPS_SELECTION[STATE_REF]}" ]] || operations_deployment_state_invalid
  [[ "${OPS_DEPLOYMENT_RECORD[USED_ORIGIN]}" == "${OPS_SELECTION[STATE_VOLUME_ORIGIN]}" && "${OPS_DEPLOYMENT_RECORD[USED_LOGICAL]}" == "${OPS_SELECTION[STATE_VOLUME_LOGICAL]}" ]] || operations_deployment_state_invalid
}
operations_selection_body() {
  local field
  declare -gA OPS_DEPLOYMENT_RECORD=()
  for field in "${!OPS_SELECTION[@]}"; do OPS_DEPLOYMENT_RECORD["$field"]="${OPS_SELECTION[$field]}"; done
  operations_deployment_record_emit selection ''
}
operations_selection_used() {
  local body
  declare -gA OPS_DEPLOYMENT_RECORD=([USED_VERSION]=1 [USED_PROJECT]="${OPS_SELECTION[STATE_PROJECT]}" [USED_VOLUME]="${OPS_SELECTION[STATE_VOLUME]}" [USED_CREATED_AT]="${OPS_SELECTION[STATE_VOLUME_CREATED_AT]}" [USED_SYSTEM_IDENTIFIER]="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" [USED_FIRST_SELECTION]="${OPS_SELECTION[STATE_REF]}" [USED_ORIGIN]="${OPS_SELECTION[STATE_VOLUME_ORIGIN]}" [USED_LOGICAL]="${OPS_SELECTION[STATE_VOLUME_LOGICAL]}" [USED_DATABASE_NAME]="${OPS_SELECTION[STATE_DATABASE_NAME]}" [USED_SCHEMA_NAME]="${OPS_SELECTION[STATE_SCHEMA_NAME]}")
  body="$(operations_deployment_record_emit used "${OPS_SELECTION[STATE_VOLUME]}")" || operations_deployment_state_invalid
  operations_deployment_record_create used "${OPS_SELECTION[STATE_VOLUME]}" "$body"
}
operations_selection_replace() {
  local file="${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state" body hash
  body="$(operations_selection_body)" || operations_deployment_state_invalid
  operations_deployment_record_write "$file.next" "$body"
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%d:%i' -- "$file")" == "$OPS_SELECTION_FILE_ID" && "$(stat -c '%u:%g:%a:%h' -- "$file")" == 1000:1000:600:1 ]] || operations_deployment_state_invalid
  hash="$(sha256sum -- "$file")" || operations_deployment_state_invalid
  [[ "${hash%% *}" == "$OPS_SELECTION_FILE_SHA256" ]] || operations_deployment_state_invalid
  mv --no-target-directory -- "$file.next" "$file" 2>/dev/null || operations_deployment_state_invalid
  operations_deployment_record_sync
  operations_selection_read
}
operations_selection_create() {
  local body file historical
  [[ "$#" == 9 ]] || operations_deployment_state_invalid
  operations_deployment_state_root
  file="$(operations_deployment_record_path selection '')" || operations_deployment_state_invalid
  [[ ! -e "$file" && ! -L "$file" && ! -e "$file.next" && ! -L "$file.next" ]] || operations_deployment_state_invalid
  # Missing selection plus any prior history is an unresolved loss, never a
  # fresh installation, including when a different volume is configured.
  for historical in "${OPS_CONFIG[FCD_STATE_ROOT]}"/volume-*.record "${OPS_CONFIG[FCD_STATE_ROOT]}"/retained-*.record; do
    [[ ! -e "$historical" && ! -L "$historical" ]] || operations_deployment_state_invalid
  done
  declare -gA OPS_SELECTION=([STATE_VERSION]=1 [STATE_PROJECT]="${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" [STATE_REF]="$1" [STATE_PHASE]=quiescent [STATE_VOLUME]="$2" [STATE_VOLUME_ORIGIN]="$3" [STATE_VOLUME_LOGICAL]="$4" [STATE_VOLUME_CREATED_AT]="$5" [STATE_SYSTEM_IDENTIFIER]="$6" [STATE_DATABASE_NAME]="$7" [STATE_SCHEMA_NAME]="${OPS_CONFIG[FCD_DATABASE_SCHEMA]}" [STATE_PREVIOUS_VOLUME]=none [STATE_RESTORE_REF]=none [STATE_WRITES_POSSIBLE]=no [STATE_REVISION]="$8" [STATE_SCHEMA_REVISION]="$9")
  body="$(operations_selection_body)" || operations_deployment_state_invalid
  operations_selection_used
  operations_deployment_record_create selection '' "$body"
  operations_selection_read
}
operations_selection_transition() {
  local reference="$1" phase="$2" old
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_REF]}" == "$reference" ]] || operations_deployment_state_invalid
  old="${OPS_SELECTION[STATE_PHASE]}"
  case "$old:$phase" in
    ready:quiescent|starting:ready|quiescent:uncertain|switching:uncertain|starting:uncertain|ready:uncertain) ;;
    *) operations_deployment_state_invalid ;;
  esac
  OPS_SELECTION[STATE_PHASE]="$phase"; operations_selection_replace
}
operations_selection_ready() { [[ "$#" == 1 ]] || operations_deployment_state_invalid; operations_selection_transition "$1" ready; }
operations_selection_quiesce() { [[ "$#" == 1 ]] || operations_deployment_state_invalid; operations_selection_transition "$1" quiescent; }
operations_selection_uncertain() { [[ "$#" == 1 ]] || operations_deployment_state_invalid; operations_selection_transition "$1" uncertain; }
operations_selection_starting() {
  [[ "$#" == 3 ]] || operations_deployment_state_invalid
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_REF]}" == "$1" && ( "${OPS_SELECTION[STATE_PHASE]}" == quiescent || "${OPS_SELECTION[STATE_PHASE]}" == switching ) ]] || operations_deployment_state_invalid
  [[ "$3" > "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" || "$3" == "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" ]] || operations_deployment_state_invalid
  OPS_SELECTION[STATE_REVISION]="$2"; OPS_SELECTION[STATE_SCHEMA_REVISION]="$3"; OPS_SELECTION[STATE_PHASE]=starting; OPS_SELECTION[STATE_WRITES_POSSIBLE]=yes
  operations_selection_replace
}
operations_selection_switch() {
  local previous old_identifier old_database old_schema body used_file
  [[ "$#" == 10 ]] || operations_deployment_state_invalid
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_REF]}" == "$1" && "$1" != "$2" && "${OPS_SELECTION[STATE_PHASE]}" == quiescent ]] || operations_deployment_state_invalid
  previous="${OPS_SELECTION[STATE_VOLUME]}"; old_identifier="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"; old_database="${OPS_SELECTION[STATE_DATABASE_NAME]}"; old_schema="${OPS_SELECTION[STATE_SCHEMA_REVISION]}"
  [[ "$3" != "$previous" && "$6" != "$old_identifier" && "$7" == "$old_database" && ( "${10}" > "$old_schema" || "${10}" == "$old_schema" ) ]] || operations_deployment_state_invalid
  used_file="$(operations_deployment_record_path used "$3")" || operations_deployment_state_invalid
  [[ ! -e "$used_file" && ! -L "$used_file" ]] || operations_deployment_state_invalid
  OPS_SELECTION[STATE_REF]="$2"; OPS_SELECTION[STATE_PHASE]=switching; OPS_SELECTION[STATE_VOLUME]="$3"; OPS_SELECTION[STATE_VOLUME_ORIGIN]="$4"; OPS_SELECTION[STATE_VOLUME_LOGICAL]=restore-data; OPS_SELECTION[STATE_VOLUME_CREATED_AT]="$5"; OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]="$6"; OPS_SELECTION[STATE_DATABASE_NAME]="$7"; OPS_SELECTION[STATE_PREVIOUS_VOLUME]="$previous"; OPS_SELECTION[STATE_RESTORE_REF]="$8"; OPS_SELECTION[STATE_REVISION]="$9"; OPS_SELECTION[STATE_SCHEMA_REVISION]="${10}"; OPS_SELECTION[STATE_WRITES_POSSIBLE]=no
  body="$(operations_selection_body)" || operations_deployment_state_invalid
  operations_selection_used
  operations_selection_replace
}
operations_retained_read() {
  local field
  [[ "$#" == 1 ]] || operations_deployment_state_invalid
  operations_deployment_record_read retained "$1"
  declare -gA OPS_RETAINED=()
  for field in "${!OPS_DEPLOYMENT_RECORD[@]}"; do OPS_RETAINED["$field"]="${OPS_DEPLOYMENT_RECORD[$field]}"; done
}
operations_retain_revision() {
  local body file existing
  [[ "$#" == 4 ]] || operations_deployment_state_invalid
  operations_selection_read
  [[ "${OPS_SELECTION[STATE_REF]}" == "$1" && "${OPS_SELECTION[STATE_PHASE]}" == ready ]] || operations_deployment_state_invalid
  declare -gA OPS_DEPLOYMENT_RECORD=([BUNDLE_VERSION]=1 [BUNDLE_PROJECT]="${OPS_SELECTION[STATE_PROJECT]}" [BUNDLE_REVISION]="${OPS_SELECTION[STATE_REVISION]}" [BUNDLE_SCHEMA_REVISION]="${OPS_SELECTION[STATE_SCHEMA_REVISION]}" [BUNDLE_DATABASE_NAME]="${OPS_SELECTION[STATE_DATABASE_NAME]}" [BUNDLE_SCHEMA_NAME]="${OPS_SELECTION[STATE_SCHEMA_NAME]}" [BUNDLE_APPLICATION_IMAGE]="$2" [BUNDLE_OPERATIONS_IMAGE]="$3" [BUNDLE_POSTGRES_IMAGE]="$4")
  body="$(operations_deployment_record_emit retained "${OPS_SELECTION[STATE_REVISION]}")" || operations_deployment_state_invalid
  file="$(operations_deployment_record_path retained "${OPS_SELECTION[STATE_REVISION]}")" || operations_deployment_state_invalid
  if [[ -e "$file" || -L "$file" ]]; then
    operations_deployment_record_read retained "${OPS_SELECTION[STATE_REVISION]}"
    existing="$(operations_deployment_record_emit retained "${OPS_SELECTION[STATE_REVISION]}")" || operations_deployment_state_invalid
    [[ "$body" == "$existing" ]] || operations_deployment_state_invalid
  else operations_deployment_record_create retained "${OPS_SELECTION[STATE_REVISION]}" "$body"; fi
}
