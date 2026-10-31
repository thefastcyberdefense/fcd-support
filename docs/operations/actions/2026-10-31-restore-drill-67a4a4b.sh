#!/usr/bin/env bash
# Exact synthetic stage driver. Markers are descriptive, never recovery authority.
set -Eeuo pipefail
export LC_ALL=C
revision=67a4a4bede6d3252dc936a6e410f4b90c1359ac3
root=/home/redwan/apps/fcd-support
fixture=/home/redwan/fcd-support-host-test-p6-67a4a4b
target=fcd-support-restore-host-test-p6-67a4a4b
action=/home/redwan/fcd-support-p6-action-67a4a4b/restore-drill
config="$fixture/config/operations.env"
[[ "$#" == 1 && ( "$1" == restore || "$1" == promote || "$1" == rollback ) ]] || { printf 'synthetic_restore_arguments_invalid\n' >&2; exit 1; }
stage="$1-preflight"
trap 'printf "synthetic_restore_drill_refused_stage=%s\n" "$stage" >&2' ERR
[[ "$(id -u):$(id -g)" == 1000:1000 && "$(realpath -e "$action")" == "$action" && "$(stat -c '%u:%g:%a' "$action")" == 1000:1000:700 ]]
[[ "$(git -C "$root" rev-parse HEAD)" == "$revision" && -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)" ]]
[[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" && ! -e "$fixture/state/deployment-state.next" && ! -L "$fixture/state/deployment-state.next" ]]
for path in "$config" "$fixture/config/restore.env" "$action/operations.env.simulation" "$action/restore.env.simulation"; do
  [[ -f "$path" && ! -L "$path" && "$(stat -c '%u:%g:%a:%h' "$path")" == 1000:1000:600:1 && "$(realpath -e "$path")" == "$path" ]]
done
cmp --silent "$config" "$action/operations.env.simulation"
cmp --silent "$fixture/config/restore.env" "$action/restore.env.simulation"
umask 077
set -o noclobber
target_absent() {
  local actors volumes networks
  actors="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$target")" || return 1
  volumes="$(docker volume ls --quiet --filter "name=^$target-data$")" || return 1
  networks="$(docker network ls --quiet --filter "name=^$target-data$")" || return 1
  [[ -z "$actors" && -z "$volumes" && -z "$networks" ]]
}
read_restore_ref() {
  [[ -f "$action/restore.ref" && ! -L "$action/restore.ref" && "$(stat -c '%u:%g:%a:%h' "$action/restore.ref")" == 1000:1000:600:1 ]]
  restore_ref="$(cat "$action/restore.ref")"
  [[ "$restore_ref" =~ ^restore_[a-f0-9]{32}$ ]]
}
case "$1" in
  restore)
    [[ ! -e "$action/restore-started" && ! -L "$action/restore-started" ]]
    target_absent
    node "$root/scripts/operations-restore-subnet.ts" 198.19.8.0/24 >"$action/subnet-check.log" 2>&1 </dev/null
    bash "$root/scripts/verify-runtime.sh" "$revision" "$config" >"$action/before-restore-verify.log" 2>&1 </dev/null
    daily="$(python3 - <<'PY'
import json,re,stat
from pathlib import Path
p=Path('/home/redwan/fcd-support-p6-action-67a4a4b/backup-replay/metadata-1.json'); s=p.lstat()
assert stat.S_ISREG(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_nlink)==(1000,1000,0o600,1)
rows=[row for row in json.loads(p.read_text()) if row['class']=='daily']; assert len(rows)==1
row=rows[0]; assert row['gitRevision']=='67a4a4bede6d3252dc936a6e410f4b90c1359ac3' and row['schemaRevision']=='000016' and re.fullmatch('backup_[a-f0-9]{32}',row['backupRef'])
print(row['backupRef'])
PY
)"
    [[ "$daily" =~ ^backup_[a-f0-9]{32}$ ]]
    printf 'started\n' >"$action/restore-started"
    cat "$fixture/state/deployment-state" >"$action/source-selection.original"
    stage=checkpoint
    (
      source "$root/scripts/run-operation.sh"
      operations_scheduled_arguments backup "$revision" "$config"
      OPS_ROOT="$root"; OPS_ACTION=verify
      operations_load_config "$OPS_CONFIG_FILE"
      operations_preflight
      operations_scheduled_ready
      operations_scheduled_images
      operations_execute_job checkpoint export-checkpoint-reference
    ) >"$action/checkpoint.ref" 2>"$action/checkpoint.log" </dev/null
    checkpoint="$(cat "$action/checkpoint.ref")"
    [[ "$checkpoint" =~ ^checkpoint_[a-f0-9]{32}$ ]]
    stage=isolated_restore
    bash "$root/scripts/restore-runtime.sh" "$daily" "$checkpoint" "$revision" "$config" >"$action/restore.ref" 2>"$action/restore.log" </dev/null
    read_restore_ref
    grep -qx RESTORE_PHASE=completed "$fixture/state/restore-${restore_ref#restore_}.record"
    [[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
    grep -qx STATE_PHASE=quiescent "$fixture/state/deployment-state"
    printf 'completed\n' >"$action/restore-completed"
    printf 'synthetic_fresh_restore_completed=true\n' ;;
  promote)
    [[ -f "$action/restore-completed" && ! -e "$action/promote-started" && ! -L "$action/promote-started" ]]
    read_restore_ref
    grep -qx STATE_PHASE=quiescent "$fixture/state/deployment-state"
    printf 'started\n' >"$action/promote-started"
    stage=fresh_promotion
    bash "$root/scripts/promote-restore.sh" "$restore_ref" "$revision" "$config" >"$action/promote.log" 2>&1 </dev/null
    stage=promoted_runtime_verify
    bash "$root/scripts/verify-runtime.sh" "$revision" "$config" >"$action/promoted-verify.log" 2>&1 </dev/null
    python3 - <<'PY'
from pathlib import Path
root=Path('/home/redwan/fcd-support-host-test-p6-67a4a4b'); action=Path('/home/redwan/fcd-support-p6-action-67a4a4b/restore-drill')
def fields(p):return dict(line.split('=',1) for line in p.read_text().splitlines())
old=fields(action/'source-selection.original'); new=fields(root/'state/deployment-state')
assert new['STATE_PHASE']=='ready' and new['STATE_VOLUME']=='fcd-support-restore-host-test-p6-67a4a4b-data' and new['STATE_PREVIOUS_VOLUME']==old['STATE_VOLUME'] and new['STATE_SYSTEM_IDENTIFIER']!=old['STATE_SYSTEM_IDENTIFIER']
PY
    cat "$fixture/state/deployment-state" >"$action/promoted-selection"
    printf 'completed\n' >"$action/promote-completed"
    printf 'synthetic_fresh_promotion_verified=true\n' ;;
  rollback)
    [[ -f "$action/promote-completed" && ! -e "$action/rollback-started" && ! -L "$action/rollback-started" ]]
    printf 'started\n' >"$action/rollback-started"
    stage=retained_compatible_rollback
    bash "$root/scripts/rollback-runtime.sh" "$revision" --confirm-schema-compatible "$config" >"$action/rollback.log" 2>&1 </dev/null
    stage=rollback_runtime_verify
    bash "$root/scripts/verify-runtime.sh" "$revision" "$config" >"$action/rollback-verify.log" 2>&1 </dev/null
    python3 - <<'PY'
import subprocess
from pathlib import Path
root=Path('/home/redwan/fcd-support-host-test-p6-67a4a4b'); action=Path('/home/redwan/fcd-support-p6-action-67a4a4b/restore-drill')
def fields(p):return dict(line.split('=',1) for line in p.read_text().splitlines())
before=fields(action/'promoted-selection'); after=fields(root/'state/deployment-state'); original=fields(action/'source-selection.original')
assert after['STATE_PHASE']=='ready' and after['STATE_VOLUME']==before['STATE_VOLUME'] and after['STATE_SYSTEM_IDENTIFIER']==before['STATE_SYSTEM_IDENTIFIER']
for name in [after['STATE_VOLUME'],original['STATE_VOLUME']]:
    assert subprocess.check_output(['docker','volume','inspect','--format','{{.Name}}',name],text=True,timeout=15).strip()==name
PY
    printf 'completed\n' >"$action/rollback-completed"
    printf 'synthetic_compatible_rollback_verified=true\n' ;;
esac
