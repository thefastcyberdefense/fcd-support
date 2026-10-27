#!/usr/bin/env bash
# Real-host synthetic controller proof. Never loads the admission configuration.
set -Eeuo pipefail
[[ "$#" == 2 && "$1" =~ ^[a-f0-9]{40}$ && "$2" == --synthetic-only ]] || { printf 'synthetic_host_arguments_invalid\n' >&2; exit 1; }
revision="$1"
project="fcd-support-host-test-p6-${revision:0:7}"
restore_project="fcd-support-restore-host-test-p6-${revision:0:7}"
fixture="/home/redwan/$project"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
stage=preflight
trap 'printf "synthetic_host_failed=%s\n" "$stage" >&2' ERR
[[ "$(uname -s)" == Linux && "$(id -u):$(id -g)" == 1000:1000 && "$root" == /home/redwan/apps/fcd-support ]]
[[ "$(git -C "$root" rev-parse HEAD)" == "$revision" && -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)" ]]
[[ "$(realpath -e /home/redwan)" == /home/redwan && "$(stat -c '%u' /home/redwan)" == 1000 ]]
[[ ! -e "$fixture" && ! -L "$fixture" ]]
[[ "$(df -Pk /var/lib/docker | awk 'NR==2 {print $4}')" -ge 12582912 ]]
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]]
[[ -z "$(docker ps -aq --filter "label=fcd-support.synthetic-host-test=$project")" ]]
for name in "$project-ingress" "$project-egress" "$restore_project-data"; do ! docker network inspect "$name" >/dev/null 2>&1; done
for name in "$project-postgres" "$project-backups" "$restore_project-data"; do ! docker volume inspect "$name" >/dev/null 2>&1; done
for role in application operations postgres; do ! docker image inspect "$project-$role:$revision" >/dev/null 2>&1; done
snapshot() { docker container inspect --format '{{.Id}}/{{.State.StartedAt}}/{{.State.Running}}' fcd-support-fcd-support-api-1 fcd-support-postgres-1 fcd-support-cloudflared; }
before="$(snapshot)"
[[ "$(printf '%s\n' "$before" | grep -c '/true$')" == 3 ]]
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
docker volume create --label "fcd-support.synthetic-host-test=$project" "$project-backups" >/dev/null </dev/null
docker network create --internal --label "fcd-support.synthetic-host-test=$project" "$project-ingress" >/dev/null </dev/null
docker network create --label "fcd-support.synthetic-host-test=$project" "$project-egress" >/dev/null </dev/null
peer="$(docker run --detach --name "$project-ingress-peer" --label "fcd-support.synthetic-host-test=$project" --network "$project-ingress" --user node --init --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 --entrypoint node "$project-application:$revision" -e 'setInterval(()=>{},1000)' </dev/null)"
[[ "$peer" =~ ^[a-f0-9]{64}$ ]]
docker network connect "$project-egress" "$peer" </dev/null
printf 'FCD_INGRESS_PEER_ID=%s\n' "$peer" >>"$fixture/config/operations.env"
stage=deploy
bash scripts/deploy-runtime.sh "$revision" --mode private-disabled "$fixture/config/operations.env" >"$fixture/logs/deploy.log" 2>&1 </dev/null
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
# Keep this explicitly synthetic private stack and its protected state for the
# subsequent deployment/restore/failure matrix. Never auto-remove uncertain jobs.
