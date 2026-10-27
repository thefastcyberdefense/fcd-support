#!/usr/bin/env bash
# Descriptive restore history only. This never changes the selected database.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-deployment-state.sh"
restore_state_invalid() { operations_fail operations_restore_state_invalid; }
restore_state_root() { (operations_deployment_state_root) >/dev/null 2>&1 || restore_state_invalid; }
restore_state_field() {
  [[ "$#" == 2 ]] || return 1
  case "$1" in
    RESTORE_VERSION) [[ "$2" == 1 ]] ;;
    RESTORE_PROJECT) [[ "$2" == "${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" ]] ;;
    RESTORE_REF) [[ "$2" =~ ^restore_[a-f0-9]{32}$ ]] ;;
    RESTORE_PHASE) [[ "$2" == intent || "$2" == completed || "$2" == abandoned ]] ;;
    RESTORE_BACKUP_REF) [[ "$2" =~ ^backup_[a-f0-9]{32}$ ]] ;;
    RESTORE_CHECKPOINT_REF) [[ "$2" =~ ^checkpoint_[a-f0-9]{32}$ ]] ;;
    RESTORE_SOURCE_SELECTION_REF) [[ "$2" =~ ^selection_[a-f0-9]{32}$ ]] ;;
    RESTORE_SOURCE_VOLUME) operations_config_field FCD_POSTGRES_VOLUME "$2" ;;
    RESTORE_SOURCE_SYSTEM_IDENTIFIER)
      [[ "$2" =~ ^[1-9][0-9]{0,19}$ ]] && { (( ${#2} < 20 )) || [[ "$2" < 18446744073709551615 || "$2" == 18446744073709551615 ]]; } ;;
    RESTORE_DATABASE_NAME) [[ "$2" == "${OPS_CONFIG[FCD_POSTGRES_DB]:-}" ]] ;;
    RESTORE_SCHEMA) [[ "$2" == "${OPS_CONFIG[FCD_DATABASE_SCHEMA]:-}" ]] ;;
    RESTORE_TARGET_PROJECT) [[ "$2" =~ ^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$ ]] ;;
    RESTORE_TARGET_VOLUME) [[ "$2" =~ ^fcd-support-restore-[a-z0-9][a-z0-9_-]{0,127}$ ]] ;;
    RESTORE_APP_IMAGE|RESTORE_OPS_IMAGE|RESTORE_PG_IMAGE) [[ "$2" =~ ^sha256:[a-f0-9]{64}$ ]] ;;
    RESTORE_REVISION) [[ "$2" =~ ^[a-f0-9]{40}$ ]] ;;
    RESTORE_SCHEMA_REVISION) [[ "$2" =~ ^[0-9]{6}$ ]] ;;
    RESTORE_TARGET_METADATA) (( ${#2} >= 4 && ${#2} <= 5464 && ${#2} % 4 == 0 )) && [[ "$2" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ;;
    RESTORE_ABANDON_REASON) [[ "$2" == empty_target_verified ]] ;;
    RESTORE_VERIFIER_REVISION) [[ "$2" =~ ^[a-f0-9]{40}$ ]] ;;
    RESTORE_VERIFIER_IMAGE) [[ "$2" =~ ^sha256:[a-f0-9]{64}$ ]] ;;
    RESTORE_EMPTY_VOLUME_CREATED_AT) [[ "$2" == absent ]] || operations_deployment_field STATE_VOLUME_CREATED_AT "$2" ;;
    RESTORE_EMPTY_PROOF_SHA) [[ "$2" =~ ^[a-f0-9]{64}$ ]] ;;
    *) return 1 ;;
  esac
}
restore_state_fields() {
  RESTORE_STATE_FIELDS=(RESTORE_VERSION RESTORE_PROJECT RESTORE_REF RESTORE_PHASE RESTORE_BACKUP_REF RESTORE_CHECKPOINT_REF RESTORE_SOURCE_SELECTION_REF RESTORE_SOURCE_VOLUME RESTORE_SOURCE_SYSTEM_IDENTIFIER RESTORE_DATABASE_NAME RESTORE_SCHEMA RESTORE_TARGET_PROJECT RESTORE_TARGET_VOLUME RESTORE_APP_IMAGE RESTORE_OPS_IMAGE RESTORE_PG_IMAGE RESTORE_REVISION RESTORE_SCHEMA_REVISION)
  [[ "$1" != completed ]] || RESTORE_STATE_FIELDS+=(RESTORE_TARGET_METADATA)
  [[ "$1" != abandoned ]] || RESTORE_STATE_FIELDS+=(RESTORE_ABANDON_REASON RESTORE_VERIFIER_REVISION RESTORE_VERIFIER_IMAGE RESTORE_EMPTY_VOLUME_CREATED_AT RESTORE_EMPTY_PROOF_SHA)
}
restore_state_check() {
  local phase="$1" reference="$2" field
  restore_state_fields "$phase"
  (( ${#OPS_RESTORE_STATE[@]} == ${#RESTORE_STATE_FIELDS[@]} )) || restore_state_invalid
  for field in "${RESTORE_STATE_FIELDS[@]}"; do
    [[ -n "${OPS_RESTORE_STATE[$field]:-}" ]] && restore_state_field "$field" "${OPS_RESTORE_STATE[$field]}" || restore_state_invalid
  done
  [[ "${OPS_RESTORE_STATE[RESTORE_REF]}" == "$reference" && "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == "$phase" && "${OPS_RESTORE_STATE[RESTORE_SOURCE_VOLUME]}" != "${OPS_RESTORE_STATE[RESTORE_TARGET_VOLUME]}" && "${OPS_RESTORE_STATE[RESTORE_TARGET_PROJECT]}" != "${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" ]] || restore_state_invalid
}
restore_state_path() {
  [[ "$#" == 2 && "$2" =~ ^restore_[a-f0-9]{32}$ && ( "$1" == intent || "$1" == record || "$1" == abandoned ) ]] || restore_state_invalid
  printf '%s/restore-%s.%s' "${OPS_CONFIG[FCD_STATE_ROOT]}" "${2#restore_}" "$1"
}
restore_state_file_read() {
  local kind="$1" reference="$2" file before opened after descriptor data size line key value count=0 shell_pid="$BASHPID" hash phase=intent
  [[ "$kind" != record ]] || phase=completed
  [[ "$kind" != abandoned ]] || phase=abandoned
  file="$(restore_state_path "$kind" "$reference")" || restore_state_invalid
  [[ -f "$file" && ! -L "$file" && ! -e "$file.next" && ! -L "$file.next" && "$(stat -c '%u:%g:%a:%h' -- "$file")" == 1000:1000:600:1 ]] || restore_state_invalid
  size="$(stat -c '%s' -- "$file")" || restore_state_invalid
  [[ "$size" =~ ^[1-9][0-9]{0,3}$ ]] && (( size <= 8192 )) || restore_state_invalid
  before="$(stat -c '%d:%i:%u:%g:%a:%s:%h' -- "$file")" || restore_state_invalid
  exec {descriptor}<"$file" || restore_state_invalid
  opened="$(stat -Lc '%d:%i:%u:%g:%a:%s:%h' -- "/proc/$shell_pid/fd/$descriptor")" || restore_state_invalid
  [[ "$opened" == "$before" ]] || restore_state_invalid
  if IFS= read -r -d '' -n 8193 data <&"$descriptor"; then restore_state_invalid; fi
  after="$(stat -Lc '%d:%i:%u:%g:%a:%s:%h' -- "/proc/$shell_pid/fd/$descriptor")" || restore_state_invalid
  exec {descriptor}<&-
  [[ "$after" == "$before" && "${#data}" == "$size" && "$data" == *$'\n' && -f "$file" && ! -L "$file" && "$(stat -c '%d:%i:%u:%g:%a:%s:%h' -- "$file")" == "$before" ]] || restore_state_invalid
  RESTORE_STATE_FILE_ID="$(stat -c '%d:%i' -- "$file")" || restore_state_invalid
  hash="$(printf '%s' "$data" | sha256sum)" || restore_state_invalid
  RESTORE_STATE_FILE_SHA256="${hash%% *}"
  data="${data%$'\n'}"
  declare -gA OPS_RESTORE_STATE=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((count+=1)); ((count <= 23)) || restore_state_invalid
    [[ "$line" =~ ^([A-Z_]+)=([A-Za-z0-9_./:+=-]+)$ ]] || restore_state_invalid
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${OPS_RESTORE_STATE[$key]+present}" ]] && restore_state_field "$key" "$value" || restore_state_invalid
    OPS_RESTORE_STATE[$key]="$value"
  done <<<"$data"
  restore_state_check "$phase" "$reference"
}
restore_state_metadata() {
  local token="$1" decoded line key value count=0 field
  restore_state_field RESTORE_TARGET_METADATA "$token" && declare -F operations_restore_metadata_decode >/dev/null || restore_state_invalid
  decoded="$(operations_restore_metadata_decode "$token" 2>/dev/null)" || restore_state_invalid
  (( ${#decoded} > 0 && ${#decoded} <= 2048 )) || restore_state_invalid
  local -A target=() fields=([TARGET_PROJECT]=RESTORE_TARGET_PROJECT [TARGET_VOLUME]=RESTORE_TARGET_VOLUME [TARGET_DATABASE_NAME]=RESTORE_DATABASE_NAME [TARGET_SCHEMA]=RESTORE_SCHEMA [TARGET_APP_IMAGE]=RESTORE_APP_IMAGE [TARGET_PG_IMAGE]=RESTORE_PG_IMAGE [TARGET_REVISION]=RESTORE_REVISION [TARGET_SCHEMA_REVISION]=RESTORE_SCHEMA_REVISION)
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((count+=1)); ((count <= 9)) || restore_state_invalid
    [[ "$line" =~ ^([A-Z_]+)=([A-Za-z0-9_:-]+)$ ]] || restore_state_invalid
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${target[$key]+present}" ]] || restore_state_invalid
    if [[ "$key" == TARGET_SYSTEM_IDENTIFIER ]]; then
      restore_state_field RESTORE_SOURCE_SYSTEM_IDENTIFIER "$value" && [[ "$value" != "${OPS_RESTORE_STATE[RESTORE_SOURCE_SYSTEM_IDENTIFIER]}" ]] || restore_state_invalid
    else
      field="${fields[$key]:-}"; [[ -n "$field" ]] || restore_state_invalid
      [[ "$value" == "${OPS_RESTORE_STATE[$field]}" ]] || restore_state_invalid
    fi
    target[$key]="$value"
  done <<<"$decoded"
  (( ${#target[@]} == 9 )) && [[ -n "${target[TARGET_SYSTEM_IDENTIFIER]:-}" ]] || restore_state_invalid
}
restore_state_pair() {
  local reference="$1" field record abandoned kind
  local -A intent=()
  restore_state_file_read intent "$reference"
  RESTORE_INTENT_FILE_ID="$RESTORE_STATE_FILE_ID"; RESTORE_INTENT_FILE_SHA256="$RESTORE_STATE_FILE_SHA256"
  for field in "${!OPS_RESTORE_STATE[@]}"; do intent[$field]="${OPS_RESTORE_STATE[$field]}"; done
  record="$(restore_state_path record "$reference")" || restore_state_invalid
  abandoned="$(restore_state_path abandoned "$reference")" || restore_state_invalid
  [[ ! -e "$record.next" && ! -L "$record.next" && ! -e "$abandoned.next" && ! -L "$abandoned.next" ]] || restore_state_invalid
  [[ ( ! -e "$record" && ! -L "$record" ) || ( ! -e "$abandoned" && ! -L "$abandoned" ) ]] || restore_state_invalid
  kind=''
  if [[ -e "$record" || -L "$record" ]]; then kind=record; fi
  if [[ -e "$abandoned" || -L "$abandoned" ]]; then kind=abandoned; fi
  if [[ -n "$kind" ]]; then
    restore_state_file_read "$kind" "$reference"
    for field in "${!intent[@]}"; do
      [[ "$field" == RESTORE_PHASE || "${OPS_RESTORE_STATE[$field]}" == "${intent[$field]}" ]] || restore_state_invalid
    done
    [[ "$kind" != record ]] || restore_state_metadata "${OPS_RESTORE_STATE[RESTORE_TARGET_METADATA]}"
  fi
}
restore_state_source() {
  local required="${1:-}" sample reference volume identifier database schema phase file_id file_hash
  sample="$( { operations_selection_read; printf '%s|%s|%s|%s|%s|%s|%s|%s' "${OPS_SELECTION[STATE_REF]}" "${OPS_SELECTION[STATE_VOLUME]}" "${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}" "${OPS_SELECTION[STATE_DATABASE_NAME]}" "${OPS_SELECTION[STATE_SCHEMA_NAME]}" "${OPS_SELECTION[STATE_PHASE]}" "$OPS_SELECTION_FILE_ID" "$OPS_SELECTION_FILE_SHA256"; } 2>/dev/null)" || restore_state_invalid
  IFS='|' read -r reference volume identifier database schema phase file_id file_hash <<<"$sample"
  [[ "$reference" == "${OPS_RESTORE_STATE[RESTORE_SOURCE_SELECTION_REF]}" && "$volume" == "${OPS_RESTORE_STATE[RESTORE_SOURCE_VOLUME]}" && "$identifier" == "${OPS_RESTORE_STATE[RESTORE_SOURCE_SYSTEM_IDENTIFIER]}" && "$database" == "${OPS_RESTORE_STATE[RESTORE_DATABASE_NAME]}" && "$schema" == "${OPS_RESTORE_STATE[RESTORE_SCHEMA]}" && "$file_id" =~ ^[0-9]{1,20}:[0-9]{1,20}$ && "$file_hash" =~ ^[a-f0-9]{64}$ ]] || restore_state_invalid
  [[ "$required" != quiescent || "$phase" == quiescent ]] || restore_state_invalid
  RESTORE_SOURCE_FILE_ID="$file_id"; RESTORE_SOURCE_FILE_SHA256="$file_hash"
}
restore_state_same_file() {
  local file="$1" identity="$2" expected_hash="$3" hash
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%d:%i' -- "$file")" == "$identity" && "$(stat -c '%u:%g:%a:%h' -- "$file")" == 1000:1000:600:1 ]] || restore_state_invalid
  hash="$(sha256sum -- "$file")" || restore_state_invalid
  [[ "${hash%% *}" == "$expected_hash" && ! -L "$file" && "$(stat -c '%d:%i' -- "$file")" == "$identity" ]] || restore_state_invalid
}
restore_state_emit() {
  local phase="$1" reference="$2" field
  restore_state_check "$phase" "$reference"
  for field in "${RESTORE_STATE_FIELDS[@]}"; do printf '%s=%s\n' "$field" "${OPS_RESTORE_STATE[$field]}"; done
}
restore_state_write() { (operations_deployment_record_write "$1" "$2") >/dev/null 2>&1 || restore_state_invalid; }
restore_state_current() {
  [[ "${OPS_RESTORE_STATE[RESTORE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" && "${OPS_RESTORE_STATE[RESTORE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]:-}" ]] || restore_state_invalid
}
restore_state_read() {
  [[ "$#" == 1 ]] && restore_state_field RESTORE_REF "$1" || restore_state_invalid
  restore_state_root
  restore_state_pair "$1"
  restore_state_current
  restore_state_source
}
restore_state_request() {
  [[ "$#" == 13 ]] || restore_state_invalid
  declare -gA OPS_RESTORE_STATE=([RESTORE_VERSION]=1 [RESTORE_PROJECT]="${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" [RESTORE_REF]="$1" [RESTORE_PHASE]=intent [RESTORE_BACKUP_REF]="$2" [RESTORE_CHECKPOINT_REF]="$3" [RESTORE_SOURCE_SELECTION_REF]="$4" [RESTORE_SOURCE_VOLUME]="$5" [RESTORE_SOURCE_SYSTEM_IDENTIFIER]="$6" [RESTORE_DATABASE_NAME]="${OPS_CONFIG[FCD_POSTGRES_DB]:-}" [RESTORE_SCHEMA]="${OPS_CONFIG[FCD_DATABASE_SCHEMA]:-}" [RESTORE_TARGET_PROJECT]="$7" [RESTORE_TARGET_VOLUME]="$8" [RESTORE_APP_IMAGE]="$9" [RESTORE_OPS_IMAGE]="${10}" [RESTORE_PG_IMAGE]="${11}" [RESTORE_REVISION]="${12}" [RESTORE_SCHEMA_REVISION]="${13}")
  restore_state_check intent "$1"
}
restore_state_begin() {
  [[ "$#" == 13 ]] || restore_state_invalid
  local reference="$1" source_id source_hash target_project="$7" target_volume="$8" file stem other body
  restore_state_request "$@"
  restore_state_root
  restore_state_current
  restore_state_source
  source_id="$RESTORE_SOURCE_FILE_ID"; source_hash="$RESTORE_SOURCE_FILE_SHA256"
  # Interrupted intents and previously used targets remain reserved. Unknown or
  # partial histories cannot be bypassed by choosing a fresh restore reference.
  for file in "${OPS_CONFIG[FCD_STATE_ROOT]}"/restore-*; do
    [[ -e "$file" || -L "$file" ]] || continue
    stem="${file##*/}"
    [[ "$stem" =~ ^restore-([a-f0-9]{32})[.](intent|record|abandoned)$ ]] || restore_state_invalid
    other="restore_${BASH_REMATCH[1]}"
    [[ "$other" != "$reference" ]] || restore_state_invalid
    restore_state_pair "$other"
    [[ ( "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == completed || "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == abandoned ) && "${OPS_RESTORE_STATE[RESTORE_TARGET_PROJECT]}" != "$target_project" && "${OPS_RESTORE_STATE[RESTORE_TARGET_VOLUME]}" != "$target_volume" ]] || restore_state_invalid
  done
  restore_state_request "$@"
  body="$(restore_state_emit intent "$reference")" || restore_state_invalid
  restore_state_same_file "${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state" "$source_id" "$source_hash"
  file="$(restore_state_path intent "$reference")" || restore_state_invalid
  restore_state_write "$file" "$body"
  restore_state_read "$reference"
}

# Trusted host caller must prove emptiness and retain the deployment lock. This
# descriptive terminal record neither clears jobs nor permits target attachment.
# The verifier may be newer than the immutable intent/source deployment.
restore_state_abandon() {
  [[ "$#" == 5 ]] && restore_state_field RESTORE_REF "$1" &&
    restore_state_field RESTORE_VERIFIER_REVISION "$2" && restore_state_field RESTORE_VERIFIER_IMAGE "$3" &&
    restore_state_field RESTORE_EMPTY_VOLUME_CREATED_AT "$4" && restore_state_field RESTORE_EMPTY_PROOF_SHA "$5" || restore_state_invalid
  local reference="$1" verifier="$2" image="$3" created="$4" proof="$5" record completed intent intent_id intent_hash source_id source_hash body next_id
  [[ "$verifier" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" && "$image" == "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]:-}" ]] || restore_state_invalid
  restore_state_root
  restore_state_pair "$reference"
  [[ "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == intent ]] || restore_state_invalid
  restore_state_source quiescent
  intent_id="$RESTORE_INTENT_FILE_ID"; intent_hash="$RESTORE_INTENT_FILE_SHA256"
  source_id="$RESTORE_SOURCE_FILE_ID"; source_hash="$RESTORE_SOURCE_FILE_SHA256"
  OPS_RESTORE_STATE[RESTORE_PHASE]=abandoned; OPS_RESTORE_STATE[RESTORE_ABANDON_REASON]=empty_target_verified
  OPS_RESTORE_STATE[RESTORE_VERIFIER_REVISION]="$verifier"; OPS_RESTORE_STATE[RESTORE_VERIFIER_IMAGE]="$image"
  OPS_RESTORE_STATE[RESTORE_EMPTY_VOLUME_CREATED_AT]="$created"; OPS_RESTORE_STATE[RESTORE_EMPTY_PROOF_SHA]="$proof"
  body="$(restore_state_emit abandoned "$reference")" || restore_state_invalid
  record="$(restore_state_path abandoned "$reference")"; completed="$(restore_state_path record "$reference")"; intent="$(restore_state_path intent "$reference")"
  [[ ! -e "$record" && ! -L "$record" && ! -e "$record.next" && ! -L "$record.next" ]] || restore_state_invalid
  restore_state_write "$record.next" "$body"
  next_id="$(stat -c '%d:%i' -- "$record.next")" || restore_state_invalid
  restore_state_same_file "$intent" "$intent_id" "$intent_hash"
  restore_state_same_file "${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state" "$source_id" "$source_hash"
  restore_state_root
  [[ ! -e "$record" && ! -L "$record" && ! -e "$completed" && ! -L "$completed" && ! -e "$completed.next" && ! -L "$completed.next" ]] || restore_state_invalid
  mv --no-clobber --no-target-directory -- "$record.next" "$record" 2>/dev/null || restore_state_invalid
  [[ ! -e "$record.next" && ! -L "$record.next" && "$(stat -c '%d:%i' -- "$record")" == "$next_id" ]] || restore_state_invalid
  (operations_deployment_record_sync) >/dev/null 2>&1 || restore_state_invalid
  restore_state_pair "$reference"
  restore_state_source quiescent
}
restore_state_complete() {
  [[ "$#" == 2 ]] && restore_state_field RESTORE_REF "$1" && restore_state_field RESTORE_TARGET_METADATA "$2" || restore_state_invalid
  local reference="$1" token="$2" record intent intent_id intent_hash source_id source_hash body next_id
  restore_state_read "$reference"
  [[ "${OPS_RESTORE_STATE[RESTORE_PHASE]}" == intent ]] || restore_state_invalid
  restore_state_source quiescent
  intent_id="$RESTORE_INTENT_FILE_ID"; intent_hash="$RESTORE_INTENT_FILE_SHA256"
  source_id="$RESTORE_SOURCE_FILE_ID"; source_hash="$RESTORE_SOURCE_FILE_SHA256"
  restore_state_metadata "$token"
  OPS_RESTORE_STATE[RESTORE_PHASE]=completed; OPS_RESTORE_STATE[RESTORE_TARGET_METADATA]="$token"
  body="$(restore_state_emit completed "$reference")" || restore_state_invalid
  record="$(restore_state_path record "$reference")"; intent="$(restore_state_path intent "$reference")"
  [[ ! -e "$record" && ! -L "$record" && ! -e "$record.next" && ! -L "$record.next" ]] || restore_state_invalid
  restore_state_write "$record.next" "$body"
  next_id="$(stat -c '%d:%i' -- "$record.next")" || restore_state_invalid
  restore_state_same_file "$intent" "$intent_id" "$intent_hash"
  restore_state_same_file "${OPS_CONFIG[FCD_STATE_ROOT]}/deployment-state" "$source_id" "$source_hash"
  restore_state_root
  [[ ! -e "$record" && ! -L "$record" ]] || restore_state_invalid
  mv --no-clobber --no-target-directory -- "$record.next" "$record" 2>/dev/null || restore_state_invalid
  [[ ! -e "$record.next" && ! -L "$record.next" && "$(stat -c '%d:%i' -- "$record")" == "$next_id" ]] || restore_state_invalid
  (operations_deployment_record_sync) >/dev/null 2>&1 || restore_state_invalid
  restore_state_read "$reference"
}
