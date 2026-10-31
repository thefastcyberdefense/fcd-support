#!/usr/bin/env bash
# Single-use synthetic backup/replay drill; no restore, provider or public action.
set -Eeuo pipefail
export LC_ALL=C
revision=67a4a4bede6d3252dc936a6e410f4b90c1359ac3
project=fcd-support-host-test-p6-67a4a4b
target=fcd-support-restore-host-test-p6-67a4a4b
fixture="/home/redwan/$project"
source_root=/home/redwan/apps/fcd-support
action="/home/redwan/fcd-support-p6-action-67a4a4b/backup-replay"
image="$project-operations:$revision"
volume="$project-backups"
key="$fixture/secrets/backup/recovery-hmac"
stage=preflight
trap 'printf "synthetic_backup_refused_stage=%s\n" "$stage" >&2' ERR
[[ "$#" == 0 && "$(id -u):$(id -g)" == 1000:1000 ]]
[[ "$(git -C "$source_root" rev-parse HEAD)" == "$revision" && -z "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ]]
[[ ! -e "$action" && ! -L "$action" && -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]]
[[ "$(stat -c '%u:%g:%a' "${action%/*}")" == 1000:1000:700 && "$(realpath -e "${action%/*}")" == "${action%/*}" ]]
context="$(docker context show)"
[[ "$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$context")" == unix:///var/run/docker.sock ]]
[[ "$(docker info --format '{{.DockerRootDir}}')" == /var/lib/docker ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}/{{if .Config.Volumes}}yes{{else}}no{{end}}' "$image")" == "$revision/no" ]]
[[ -f "$key" && ! -L "$key" && "$(stat -c '%u:%g:%a:%h' "$key")" == 1000:1000:600:1 && "$(realpath -e "$key")" == "$key" ]]
[[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
grep -qx STATE_PHASE=ready "$fixture/state/deployment-state"
actors="$(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$project")"
mapfile -t actor_ids <<<"$actors"
[[ "${#actor_ids[@]}" == 4 ]]
facts="$(docker inspect --format '{{.State.Running}}/{{.State.Health.Status}}/{{.HostConfig.ReadonlyRootfs}}/{{len .HostConfig.PortBindings}}' "${actor_ids[@]}")"
while IFS= read -r fact; do [[ "$fact" == true/healthy/true/0 ]]; done <<<"$facts"
target_absent() {
  local containers volumes networks
  containers="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$target")" || return 1
  volumes="$(docker volume ls --quiet --filter "name=^$target-data$")" || return 1
  networks="$(docker network ls --quiet --filter "name=^$target-data$")" || return 1
  [[ -z "$containers" && -z "$volumes" && -z "$networks" ]]
}
target_absent
volume_row="$(docker volume inspect --format '{{.Name}}|{{.Driver}}|{{.Scope}}|{{if .Options}}custom{{else}}default{{end}}|{{index .Labels "fcd-support.synthetic-host-test"}}|{{.Mountpoint}}' "$volume")"
[[ "$volume_row" == "$volume|local|local|default|$project|/var/lib/docker/volumes/$volume/_data" ]]
archive_source="${volume_row##*|}"
for index in 0 1 2; do
  existing="$(docker ps --all --quiet --filter "name=^/$project-backup-metadata-$index$")"
  [[ -z "$existing" ]]
done

preserve() {
  python3 - <<'PY'
import hashlib,json,stat,subprocess
from pathlib import Path
baseline=Path('/home/redwan/fcd-support-p6-action-67a4a4b/preserved-baseline.json')
s=baseline.lstat(); assert stat.S_ISREG(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_nlink)==(1000,1000,0o600,1)
data=json.loads(baseline.read_text())
for path,expected in data['files'].items():
    p=Path(path); s=p.lstat(); assert stat.S_ISREG(s.st_mode) and not p.is_symlink()
    actual=[s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_size,s.st_mtime_ns,hashlib.sha256(p.read_bytes()).hexdigest()]
    assert actual==expected
for actor in data['actors']:
    actual=subprocess.check_output(['docker','inspect','--format','{{.Id}}|{{.Image}}|{{.State.Status}}|{{.State.StartedAt}}',actor['id']],text=True,timeout=15).strip()
    assert actual=='|'.join([actor['id'],actor['image'],actor['state'],actor['started']])
PY
}

umask 077
mkdir -- "$action"
date -u +%Y-%m-%d >"$action/day"
reader="$(cat <<'JS'
import {readdir} from 'node:fs/promises';
import {readBackupManifest} from '/app/dist/operations/backup.js';
try {
  const root='/var/lib/fcd-support/backups';
  const refs=(await readdir(root)).sort();
  if(refs.length<1||refs.length>16||refs.some(value=>!/^backup_[a-f0-9]{32}$/.test(value)))throw Error();
  const result=[];
  for(const ref of refs){
    const manifest=await readBackupManifest(root,ref,'/run/secrets/recovery-hmac');
    if(manifest.gitRevision!=='67a4a4bede6d3252dc936a6e410f4b90c1359ac3'||(manifest.class!=='pre_migration'&&manifest.schemaRevision!=='000016'))throw Error();
    result.push(manifest);
  }
  process.stdout.write(JSON.stringify(result));
} catch { process.stderr.write('synthetic_manifest_read_refused\n'); process.exitCode=1; }
JS
)"
metadata() {
  local index="$1" id fact
  id="$(docker create --pull never --name "$project-backup-metadata-$index" --label "fcd-support.synthetic-backup-reader=$project" \
    --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
    --cpus 0.5 --memory 128m --pids-limit 32 --entrypoint node \
    --mount "type=bind,src=$archive_source,dst=/var/lib/fcd-support/backups,readonly" \
    --mount "type=bind,src=$key,dst=/run/secrets/recovery-hmac,readonly" \
    "$image" --input-type=module -e "$reader" 2>"$action/reader-$index-create.log" </dev/null)"
  [[ "$id" =~ ^[a-f0-9]{64}$ ]]
  fact="$(docker inspect --format '{{.Id}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{len .HostConfig.PortBindings}}|{{len .Mounts}}|{{.State.Status}}|{{index .Config.Labels "fcd-support.synthetic-backup-reader"}}' "$id")"
  [[ "$fact" == "$id|none|true|1000:1000|0|2|created|$project" ]]
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/fcd-support/backups"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$id")" == "bind|$archive_source|false" ]]
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/recovery-hmac"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$id")" == "bind|$key|false" ]]
  docker start --attach "$id" >"$action/metadata-$index.json" 2>"$action/reader-$index.log" </dev/null
  [[ "$(docker inspect --format '{{.Id}}|{{.State.Status}}|{{.State.ExitCode}}|{{index .Config.Labels "fcd-support.synthetic-backup-reader"}}' "$id")" == "$id|exited|0|$project" ]]
  docker container rm "$id" >/dev/null
}
stage=initial_preservation
preserve
stage=initial_metadata
metadata 0
python3 - "$action/metadata-0.json" <<'PY'
import json,sys
data=json.load(open(sys.argv[1])); assert len(data)==1 and data[0]['class']=='pre_migration'
PY
for index in 1 2; do
  stage="scheduled_backup_$index"
  [[ "$(date -u +%Y-%m-%d)" == "$(cat "$action/day")" ]]
  bash "$source_root/scripts/run-operation.sh" backup "$revision" "$fixture/config/operations.env" >"$action/schedule-$index.log" 2>&1 </dev/null
  stage="runtime_verify_$index"
  bash "$source_root/scripts/verify-runtime.sh" "$revision" "$fixture/config/operations.env" >"$action/verify-$index.log" 2>&1 </dev/null
  preserve
  stage="signed_metadata_$index"
  metadata "$index"
  python3 - "$action/metadata-$index.json" <<'PY'
import json,sys
data=json.load(open(sys.argv[1])); assert len(data)==3 and sorted(row['class'] for row in data)==['daily','monthly','pre_migration']
PY
done
stage=replay_comparison
[[ "$(date -u +%Y-%m-%d)" == "$(cat "$action/day")" ]]
cmp --silent "$action/metadata-1.json" "$action/metadata-2.json"
preserve
[[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
target_absent
printf '%s\n' synthetic_backup_three_signed_archives=true synthetic_backup_replay_unchanged=true synthetic_backup_runtime_verified=true synthetic_backup_prior_state_unchanged=true
