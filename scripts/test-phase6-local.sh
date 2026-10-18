#!/usr/bin/env bash
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REVISION="$(git rev-parse HEAD)"
PROJECT="fcd-support-phase6-test-$$-$RANDOM"
FIXTURE="$ROOT/.superpowers/sdd/2026-10-04-phase-6-hardened-local-operations/$PROJECT"
NATIVE_FIXTURE="$FIXTURE"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_FIXTURE="$(cygpath -m "$FIXTURE")"; fi
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
node tests/helpers/phase6-network-fixture.ts "$NATIVE_FIXTURE" "$PROJECT" "$REVISION"
ENV_FILE="$NATIVE_FIXTURE/fixture.env"
BASE=(docker compose --env-file "$ENV_FILE" --file infra/compose.runtime.yml)
MODEL=("${BASE[@]}" --file infra/compose.model.yml)
TEST=("${MODEL[@]}" --file infra/compose.phase6-test.yml --profile model-execution --profile outbound-execution --profile notification-execution)
cleanup() {
  local id name label volume network ids
  # Resolve and validate every target first. Refuse cleanup if an unexpected
  # participant/attachment has appeared; preserve the stack for inspection.
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" || return 1
  for id in $ids; do
    [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    name="$(docker inspect --format '{{.Name}}' "$id")"
    [[ "$name" == "/$PROJECT-"* ]] || { echo 'cleanup_scope_refused' >&2; return 1; }
    while IFS= read -r network; do [[ -z "$network" || "$network" == "$PROJECT-"* ]] || { echo 'cleanup_network_refused' >&2; return 1; }; done < <(docker inspect --format '{{range $name,$net := .NetworkSettings.Networks}}{{$name}}{{println}}{{end}}' "$id")
    while IFS= read -r volume; do [[ -z "$volume" || "$volume" == "$PROJECT-"* ]] || { echo 'cleanup_volume_refused' >&2; return 1; }; done < <(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{println}}{{end}}{{end}}' "$id")
  done
  for network in ingress model notification; do
    if docker network inspect "$PROJECT-$network" >/dev/null 2>&1; then
      label="$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$PROJECT-$network")"
      [[ "$label" == "$PROJECT" ]] || { echo 'cleanup_label_refused' >&2; return 1; }
      while IFS= read -r name; do [[ -z "$name" || "$name" == "$PROJECT-"* ]] || { echo 'cleanup_participant_refused' >&2; return 1; }; done < <(docker network inspect --format '{{range .Containers}}{{.Name}}{{println}}{{end}}' "$PROJECT-$network")
    fi
  done
  if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null || return 1; fi
  "${TEST[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || return 1
  if docker volume inspect "$PROJECT-admin-socket" >/dev/null 2>&1; then
    [[ "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$PROJECT-admin-socket")" == "$PROJECT" ]] || return 1
    docker volume rm "$PROJECT-admin-socket" >/dev/null || return 1
  fi
  for network in ingress model notification; do
    if docker network inspect "$PROJECT-$network" >/dev/null 2>&1; then docker network rm "$PROJECT-$network" >/dev/null; fi
  done
  if docker image inspect "$PROJECT-application:$REVISION" >/dev/null 2>&1; then
    [[ "$(docker image inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$PROJECT-application:$REVISION")" == "$PROJECT" ]] || return 1
    docker image rm "$PROJECT-application:$REVISION" >/dev/null
  fi
}
trap 'status=$?; cleanup || status=1; exit "$status"' EXIT
npm run build --silent
docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --label "com.docker.compose.project=$PROJECT" --tag "$PROJECT-application:$REVISION" --file Dockerfile . >"$FIXTURE/image-build.log" 2>&1
SOCKET_ROOT="/run/$PROJECT-admin-socket"
"${BASE[@]}" --profile '*' config --format json 2>"$FIXTURE/render.stderr" | tee "$FIXTURE/runtime.json" | node dist/operations/compose-contract-main.js runtime "$REVISION" "$SOCKET_ROOT" "$NATIVE_FIXTURE/config" "$NATIVE_FIXTURE/secrets" "$NATIVE_ROOT"
MODEL_EXECUTION_ENABLED=true "${MODEL[@]}" --profile '*' config --format json 2>"$FIXTURE/render.stderr" | tee "$FIXTURE/model.json" | node dist/operations/compose-contract-main.js model "$REVISION" "$SOCKET_ROOT" "$NATIVE_FIXTURE/config" "$NATIVE_FIXTURE/secrets" "$NATIVE_ROOT"
docker compose --env-file "$ENV_FILE" --file infra/compose.operations.yml --profile '*' config --format json 2>"$FIXTURE/render.stderr" | tee "$FIXTURE/operations.json" | node dist/operations/compose-contract-main.js operations "$REVISION"
docker compose --env-file "$ENV_FILE" --file infra/compose.restore.yml --profile '*' config --format json 2>"$FIXTURE/render.stderr" | tee "$FIXTURE/restore.json" | node dist/operations/compose-contract-main.js restore "$REVISION" "$PROJECT-postgres-data"
default_services="$("${BASE[@]}" config --services 2>"$FIXTURE/render.stderr")"
[[ "$default_services" != *fcd-support-outbound* && "$default_services" != *fcd-support-notification* ]]
echo 'external_profiles_not_autostarted=true'

if docker network inspect "$PROJECT-model" >/dev/null 2>&1; then echo 'test_network_not_fresh' >&2; exit 1; fi
if MODEL_EXECUTION_ENABLED=true "${TEST[@]}" up --detach --no-build --pull never >"$FIXTURE/missing-network.log" 2>&1; then echo 'missing_external_network_accepted' >&2; exit 1; fi
grep -q 'external.*not.*found' "$FIXTURE/missing-network.log"
echo 'missing_external_network_rejected=true'
bash "$ROOT/scripts/test-phase6-admin-socket.sh" "$PROJECT" "$REVISION" >"$FIXTURE/socket-proof.log" 2>&1
echo 'admin_socket_native_linux=true'
for network in ingress model notification; do
  docker network create --internal --label "com.docker.compose.project=$PROJECT" "$PROJECT-$network" >/dev/null
done
# Capture only synthetic logs; never print full docker inspect/config output.
MODEL_EXECUTION_ENABLED=true "${TEST[@]}" up --detach --wait --wait-timeout 90 >"$FIXTURE/up.log" 2>&1
bash "$ROOT/scripts/verify-network-contract.sh" "$PROJECT"
APP_IMAGE="$PROJECT-application:$REVISION"
SOCKET_SAFE=(--read-only --init --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 64m --pids-limit 32 --network none --label "com.docker.compose.project=$PROJECT" --entrypoint node --mount "type=volume,src=$PROJECT-admin-socket,dst=/run/fcd-support-admin,readonly")
docker run --rm --name "$PROJECT-socket-owner" "${SOCKET_SAFE[@]}" --user 1000:1000 "$APP_IMAGE" dist/admin/admin-socket-health.js /run/fcd-support-admin/admin.sock 1000
for uid in 999 65532; do
  docker run --rm --name "$PROJECT-socket-denied-$uid" "${SOCKET_SAFE[@]}" --user "$uid:$uid" "$APP_IMAGE" -e 'const s=require("net").connect({path:"/run/fcd-support-admin/admin.sock"});s.on("connect",()=>{s.destroy();process.exit(1)}).on("error",e=>process.exit(e.code==="EACCES"?0:1)).setTimeout(1000,()=>{s.destroy();process.exit(1)});'
  docker run --rm --name "$PROJECT-socket-wrong-owner-$uid" "${SOCKET_SAFE[@]}" --user "$uid:$uid" "$APP_IMAGE" --input-type=module -e 'import Fastify from "fastify";import {startAdminSocket} from "./dist/admin/admin-socket.js";try{await startAdminSocket(Fastify(),"/run/fcd-support-admin/admin.sock");process.exit(1)}catch(e){process.exit(e.message==="admin_socket_invalid"?0:1)}'
done
echo 'admin_socket_uid_separation=true'
TEST_NODE='node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
SAFE=(--user node --read-only --init --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 64m --pids-limit 32 --label "com.docker.compose.project=$PROJECT")
docker network inspect "$PROJECT-model" --format '{{json .}}' | node dist/operations/compose-contract-main.js network "$PROJECT-manifest-fake-1,$PROJECT-fcd-support-reply-1" >/dev/null
docker run -d --name "$PROJECT-unexpected" "${SAFE[@]}" --network "$PROJECT-model" --label com.docker.compose.service=unexpected "$TEST_NODE" node -e 'setInterval(()=>{},1000)' >/dev/null
if docker network inspect "$PROJECT-model" --format '{{json .}}' | node dist/operations/compose-contract-main.js network "$PROJECT-manifest-fake-1,$PROJECT-fcd-support-reply-1" >"$FIXTURE/participant.log" 2>&1; then echo 'unexpected_participant_accepted' >&2; exit 1; fi
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$PROJECT-unexpected")" == "$PROJECT" ]]
docker rm -f "$PROJECT-unexpected" >/dev/null
echo 'unexpected_external_participant_rejected=true'

if docker run --rm --name "$PROJECT-missing-secret" "${SAFE[@]}" --network "$PROJECT-model" --label com.docker.compose.service=missing-secret \
  --entrypoint node --mount "type=bind,src=$NATIVE_FIXTURE/missing-secret,dst=/run/secrets/missing,readonly" "$PROJECT-application:$REVISION" \
  --input-type=module -e 'import {readSecretFile} from "./dist/operations/secret-files.js"; try { await readSecretFile("/run/secrets/missing"); process.exit(0); } catch { process.exit(1); }' >"$FIXTURE/missing-secret.log" 2>&1; then echo 'missing_secret_mount_accepted' >&2; exit 1; fi
echo 'missing_secret_mount_rejected=true'
npx vitest run tests/compose-port.test.ts >"$FIXTURE/port-preflight.log" 2>&1
echo 'conflicting_bind_rejected=true'
echo 'phase6_local_topology=true'
