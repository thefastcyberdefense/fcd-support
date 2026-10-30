#!/usr/bin/env bash
# Real-host synthetic controller proof. Never loads the admission configuration.
set -Eeuo pipefail
[[ "$#" == 2 && "$1" =~ ^[a-f0-9]{40}$ && ( "$2" == --synthetic-only || "$2" == --synthetic-precreated || "$2" == --ephemeral-ci || "$2" == --ephemeral-ci-precreated ) ]] || { printf 'synthetic_host_arguments_invalid\n' >&2; exit 1; }
revision="$1"
mode="$2"
ci_mode=false
precreated_mode=false
[[ "$mode" != --ephemeral-ci && "$mode" != --ephemeral-ci-precreated ]] || ci_mode=true
[[ "$mode" != --synthetic-precreated && "$mode" != --ephemeral-ci-precreated ]] || precreated_mode=true
operator_home=/home/redwan
project="fcd-support-host-test-p6-${revision:0:7}"
if [[ "$ci_mode" == true ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true ]] || { printf 'synthetic_host_ci_context_invalid\n' >&2; exit 1; }
  operator_home=/home/fcd-support-ci
  project="fcd-support-host-test-ci-${revision:0:7}"
fi
restore_project="${project/fcd-support-host-test-/fcd-support-restore-host-test-}"
fixture="$operator_home/$project"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/scripts/synthetic-host-evidence.sh"
source "$root/scripts/synthetic-host-networks.sh"
stage=preflight
trap 'synthetic_host_report_failure "$stage" "$fixture/logs/$stage.log" "$fixture/logs/deploy-lines.log"' ERR
[[ "$(uname -s)" == Linux && "$(id -u):$(id -g)" == 1000:1000 ]]
if [[ "$ci_mode" == true ]]; then
  all_containers="$(docker ps --all --quiet --no-trunc)"
  [[ "$root" == /home/fcd-support-ci/repository && -z "$all_containers" ]]
else [[ "$root" == /home/redwan/apps/fcd-support ]]; fi
[[ "$(git -C "$root" rev-parse HEAD)" == "$revision" && -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)" ]]
[[ "$(realpath -e "$operator_home")" == "$operator_home" && "$(stat -c '%u' "$operator_home")" == 1000 ]]
[[ ! -e "$fixture" && ! -L "$fixture" ]]
[[ "$(df -Pk /var/lib/docker | awk 'NR==2 {print $4}')" -ge 12582912 ]]
project_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
synthetic_containers="$(docker ps -aq --filter "label=fcd-support.synthetic-host-test=$project")"
[[ -z "$project_containers" && -z "$synthetic_containers" ]]
if [[ "$precreated_mode" == true ]]; then
  synthetic_host_require_absent network "$restore_project-data"
  network_snapshot="$(synthetic_precreated_network_snapshot "$project")"
else
  for name in "$project-ingress" "$project-egress" "$restore_project-data"; do synthetic_host_require_absent network "$name"; done
fi
for name in "$project-postgres" "$project-backups" "$restore_project-data"; do synthetic_host_require_absent volume "$name"; done
for role in application operations postgres; do synthetic_host_require_absent image "$project-$role:$revision"; done
snapshot() {
  if [[ "$ci_mode" == true ]]; then
    docker ps --all --quiet --no-trunc --filter label=com.docker.compose.project=fcd-support
  else docker container inspect --format '{{.Id}}/{{.State.StartedAt}}/{{.State.Running}}' fcd-support-fcd-support-api-1 fcd-support-postgres-1 fcd-support-cloudflared; fi
}
before="$(snapshot)"
if [[ "$ci_mode" == true ]]; then [[ -z "$before" ]]; else [[ "$(printf '%s\n' "$before" | grep -c '/true$')" == 3 ]]; fi
umask 077
stage=fixture
cd "$root"
node tests/helpers/runtime-host-fixture.ts "$fixture" "$project" "$revision" </dev/null
printf '%s\n' "$before" >"$fixture/logs/retained.snapshot"
stage=build
for role in application operations postgres; do
  case "$role" in application) file=Dockerfile ;; *) file="infra/Dockerfile.$role" ;; esac
  docker build --platform linux/amd64 --build-arg "VCS_REF=$revision" --label "fcd-support.synthetic-host-test=$project" --file "$file" --tag "$project-$role:$revision" "$root" >"$fixture/logs/build-$role.log" 2>&1 </dev/null
done
stage=keys
safe=(--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 --label "fcd-support.synthetic-host-test=$project")
docker run "${safe[@]}" --user node --mount "type=bind,src=$fixture/secrets/verify-backup,dst=/keys" --entrypoint age-keygen "$project-operations:$revision" -o /keys/restore-identity >"$fixture/logs/keygen.log" 2>&1 </dev/null
docker run "${safe[@]}" --user node --mount "type=bind,src=$fixture/secrets/verify-backup/restore-identity,dst=/identity,readonly" --entrypoint age-keygen "$project-operations:$revision" -y /identity >"$fixture/secrets/backup/backup-recipient" 2>"$fixture/logs/recipient.log" </dev/null
# Only the two fresh PostgreSQL secret files need UID 999. Each helper sees one
# file, no parent directory, no database volume and no other credential.
for password in "$fixture/secrets/postgres/postgres-password" "$fixture/secrets/restore/restore-postgres-password"; do
  [[ -f "$password" && ! -L "$password" && "$(stat -c '%u:%g:%a' "$password")" == 1000:1000:600 ]]
  docker run "${safe[@]}" --user 0:0 --cap-add CHOWN --mount "type=bind,src=$password,dst=/synthetic-postgres-password" --entrypoint chown "$project-application:$revision" 999:999 /synthetic-postgres-password >"$fixture/logs/password-owner.log" 2>&1 </dev/null
  [[ "$(stat -c '%u:%g:%a' "$password")" == 999:999:600 ]]
done
stage=isolated-resources
if [[ "$precreated_mode" == true ]]; then synthetic_precreated_network_unchanged "$project" "$network_snapshot"; fi
docker volume create --label "fcd-support.synthetic-host-test=$project" "$project-backups" >/dev/null </dev/null
if [[ "$precreated_mode" == true ]]; then
  synthetic_precreated_network_unchanged "$project" "$network_snapshot"
else
  docker network create --internal --label "fcd-support.synthetic-host-test=$project" "$project-ingress" >/dev/null </dev/null
  docker network create --label "fcd-support.synthetic-host-test=$project" "$project-egress" >/dev/null </dev/null
fi
peer="$(docker run --detach --name "$project-ingress-peer" --label "fcd-support.synthetic-host-test=$project" --network "$project-ingress" --user node --init --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 --entrypoint node "$project-application:$revision" -e 'setInterval(()=>{},1000)' </dev/null)"
[[ "$peer" =~ ^[a-f0-9]{64}$ ]]
docker network connect "$project-egress" "$peer" </dev/null
printf 'FCD_INGRESS_PEER_ID=%s\n' "$peer" >>"$fixture/config/operations.env"
stage=deploy
if [[ "$ci_mode" == true ]]; then
  cat >"$fixture/logs/trace-entry.bash" <<'TRACE'
exec 3>"${FCD_SYNTHETIC_TRACE:?}"
source "${FCD_SYNTHETIC_EVIDENCE_LIBRARY:?}"
set -o functrace
trap 'trace_status=$?; trace_source="${BASH_SOURCE[0]-stdin}"; printf "%s:%s:previous=%s\n" "${trace_source##*/}" "$LINENO" "$trace_status" >&3; synthetic_host_runtime_diagnostic "${result-}" >&3' DEBUG
TRACE
  BASH_ENV="$fixture/logs/trace-entry.bash" FCD_SYNTHETIC_TRACE="$fixture/logs/deploy-lines.log" FCD_SYNTHETIC_EVIDENCE_LIBRARY="$root/scripts/synthetic-host-evidence.sh" FCD_RUNTIME_HOST_DIAGNOSTICS=closed-v1 \
    bash scripts/deploy-runtime.sh "$revision" --mode private-disabled "$fixture/config/operations.env" >"$fixture/logs/deploy.log" 2>&1 </dev/null
else
  bash scripts/deploy-runtime.sh "$revision" --mode private-disabled "$fixture/config/operations.env" >"$fixture/logs/deploy.log" 2>&1 </dev/null
fi
stage=verify
bash scripts/verify-runtime.sh "$revision" "$fixture/config/operations.env" >"$fixture/logs/verify.log" 2>&1 </dev/null
stage=private-http
docker exec "$peer" node --input-type=module -e 'const u="http://fcd-support-api:3003";if((await fetch(u+"/webhooks/meta",{signal:AbortSignal.timeout(3000)})).status!==403||(await fetch(u+"/health",{signal:AbortSignal.timeout(3000)})).status!==404||(await fetch(u+"/webhooks/meta",{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(3000)})).status!==401)process.exit(1)' >"$fixture/logs/http.log" 2>&1 </dev/null
[[ "$(curl --silent --show-error --max-time 5 --unix-socket "$fixture/socket/admin.sock" --output /dev/null --write-out '%{http_code}' http://localhost/login)" == 200 ]]
[[ "$(stat -c '%u:%g:%a' "$fixture/socket/admin.sock")" == 1000:1000:600 ]]
[[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
grep -qx 'STATE_PHASE=ready' "$fixture/state/deployment-state"
[[ "$(snapshot)" == "$before" ]]
printf 'synthetic_host_deploy_passed=true\nsynthetic_host_verify_passed=true\nsynthetic_host_private_http_passed=true\nsynthetic_host_existing_stack_unchanged=true\n'
if [[ "$ci_mode" == true ]]; then
  stage=backup
  initial_system_id="$(sed -n 's/^STATE_SYSTEM_IDENTIFIER=//p' "$fixture/state/deployment-state")"
  initial_volume="$(sed -n 's/^STATE_VOLUME=//p' "$fixture/state/deployment-state")"
  [[ "$initial_system_id" =~ ^[1-9][0-9]{0,19}$ && "$initial_volume" == "$project-postgres" ]]
  bash scripts/run-operation.sh backup "$revision" "$fixture/config/operations.env" >"$fixture/logs/backup.log" 2>&1 </dev/null
  [[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
  grep -qx 'STATE_PHASE=ready' "$fixture/state/deployment-state"
  backup_ref="$(docker run "${safe[@]}" --mount "type=volume,src=$project-backups,dst=/var/lib/fcd-support/backups,readonly" --entrypoint node "$project-application:$revision" -e '
    import { readdirSync, readFileSync } from "node:fs";
    const dirs = readdirSync("/var/lib/fcd-support/backups").filter(d => /^backup_[a-f0-9]{32}$/.test(d));
    if (dirs.length === 0) process.exit(1);
    const ref = dirs[dirs.length - 1];
    const manifest = JSON.parse(readFileSync(`/var/lib/fcd-support/backups/${ref}/manifest.json`, "utf8"));
    if (manifest.backupRef !== ref || manifest.state !== "created") process.exit(1);
    console.log(ref);
  ')"
  [[ "$backup_ref" =~ ^backup_[a-f0-9]{32}$ ]]
  printf 'synthetic_host_backup_passed=true\n'

  stage=checkpoint
  checkpoint_ref="$(
    bash -c '
      set -Eeuo pipefail
      source scripts/run-operation.sh
      operations_scheduled_arguments backup "$1" "$2"
      OPS_ROOT="$PWD"; OPS_ACTION=verify
      operations_load_config "$OPS_CONFIG_FILE"
      operations_preflight
      operations_scheduled_ready
      operations_scheduled_images
      operations_execute_job checkpoint export-checkpoint-reference
    ' bash "$revision" "$fixture/config/operations.env"
  )"
  [[ "$checkpoint_ref" =~ ^checkpoint_[a-f0-9]{32}$ ]]
  [[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
  printf 'synthetic_host_checkpoint_passed=true\n'

  stage=restore
  restore_ref="$(bash scripts/restore-runtime.sh "$backup_ref" "$checkpoint_ref" "$revision" "$fixture/config/operations.env" 2>"$fixture/logs/restore.log")"
  [[ "$restore_ref" =~ ^restore_[a-f0-9]{32}$ ]]
  [[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
  grep -qx 'RESTORE_PHASE=completed' "$fixture/state/restore-${restore_ref#restore_}.record"
  grep -qx "RESTORE_REF=$restore_ref" "$fixture/state/restore-${restore_ref#restore_}.record"
  grep -qx "RESTORE_BACKUP_REF=$backup_ref" "$fixture/state/restore-${restore_ref#restore_}.record"
  grep -qx "RESTORE_CHECKPOINT_REF=$checkpoint_ref" "$fixture/state/restore-${restore_ref#restore_}.record"
  grep -qx 'STATE_PHASE=quiescent' "$fixture/state/deployment-state"
  docker volume inspect "$project-postgres" >/dev/null
  docker volume inspect "$restore_project-data" >/dev/null
  printf 'synthetic_host_restore_passed=true\n'

  stage=promote
  bash scripts/promote-restore.sh "$restore_ref" "$revision" "$fixture/config/operations.env" >"$fixture/logs/promote.log" 2>&1 </dev/null
  [[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
  grep -qx 'STATE_PHASE=ready' "$fixture/state/deployment-state"
  promoted_volume="$(sed -n 's/^STATE_VOLUME=//p' "$fixture/state/deployment-state")"
  promoted_system_id="$(sed -n 's/^STATE_SYSTEM_IDENTIFIER=//p' "$fixture/state/deployment-state")"
  [[ "$promoted_volume" == "$restore_project-data" ]]
  [[ "$promoted_system_id" =~ ^[1-9][0-9]{0,19}$ ]]
  [[ "$promoted_system_id" != "$initial_system_id" ]]
  docker volume inspect "$project-postgres" >/dev/null
  docker volume inspect "$restore_project-data" >/dev/null
  bash scripts/verify-runtime.sh "$revision" "$fixture/config/operations.env" >"$fixture/logs/verify-promoted.log" 2>&1 </dev/null
  docker exec "$peer" node --input-type=module -e 'const u="http://fcd-support-api:3003";if((await fetch(u+"/webhooks/meta",{signal:AbortSignal.timeout(3000)})).status!==403||(await fetch(u+"/health",{signal:AbortSignal.timeout(3000)})).status!==404||(await fetch(u+"/webhooks/meta",{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(3000)})).status!==401)process.exit(1)' >"$fixture/logs/http-promoted.log" 2>&1 </dev/null
  [[ "$(curl --silent --show-error --max-time 5 --unix-socket "$fixture/socket/admin.sock" --output /dev/null --write-out '%{http_code}' http://localhost/login)" == 200 ]]
  printf 'synthetic_host_promote_passed=true\n'

  stage=rollback
  bash scripts/rollback-runtime.sh "$revision" --confirm-schema-compatible "$fixture/config/operations.env" >"$fixture/logs/rollback.log" 2>&1 </dev/null
  [[ ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
  grep -qx 'STATE_PHASE=ready' "$fixture/state/deployment-state"
  rolled_back_volume="$(sed -n 's/^STATE_VOLUME=//p' "$fixture/state/deployment-state")"
  rolled_back_system_id="$(sed -n 's/^STATE_SYSTEM_IDENTIFIER=//p' "$fixture/state/deployment-state")"
  [[ "$rolled_back_volume" == "$restore_project-data" ]]
  [[ "$rolled_back_system_id" == "$promoted_system_id" ]]
  docker volume inspect "$project-postgres" >/dev/null
  docker volume inspect "$restore_project-data" >/dev/null
  bash scripts/verify-runtime.sh "$revision" "$fixture/config/operations.env" >"$fixture/logs/verify-rollback.log" 2>&1 </dev/null
  docker exec "$peer" node --input-type=module -e 'const u="http://fcd-support-api:3003";if((await fetch(u+"/webhooks/meta",{signal:AbortSignal.timeout(3000)})).status!==403||(await fetch(u+"/health",{signal:AbortSignal.timeout(3000)})).status!==404||(await fetch(u+"/webhooks/meta",{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(3000)})).status!==401)process.exit(1)' >"$fixture/logs/http-rollback.log" 2>&1 </dev/null
  [[ "$(curl --silent --show-error --max-time 5 --unix-socket "$fixture/socket/admin.sock" --output /dev/null --write-out '%{http_code}' http://localhost/login)" == 200 ]]
  printf 'synthetic_host_rollback_passed=true\n'

  stage=cleanup
  source "$root/scripts/synthetic-host-cleanup.sh"
  synthetic_host_cleanup
  printf 'synthetic_host_recovery_passed=true\nsynthetic_host_cleanup_passed=true\n'
fi
# Keep this explicitly synthetic private stack and its protected state for the
# subsequent deployment/restore/failure matrix. Never auto-remove uncertain jobs.
