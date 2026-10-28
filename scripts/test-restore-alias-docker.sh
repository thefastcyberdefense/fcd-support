#!/usr/bin/env bash
# Exercise the repository's rendered aliases on two fresh synthetic bridges.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
[[ "$#" == 1 ]] || { echo restore_alias_test_arguments_invalid >&2; exit 1; }
IMAGE="$1"
SCOPE="fcd-support-alias-proof-$$-$RANDOM"
SOURCE_NETWORK="$SCOPE-operations-data"; TARGET_PROJECT="$SCOPE-restore"; TARGET_NETWORK="$TARGET_PROJECT-data"
cleanup() {
  local ids id network
  ids="$(docker ps --all --quiet --no-trunc --filter "label=fcd-support.alias-proof=$SCOPE")" || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ && "$(docker inspect --format '{{index .Config.Labels "fcd-support.alias-proof"}}' "$id")" == "$SCOPE" ]] || return 1
    docker rm --force --volumes "$id" >/dev/null || return 1
  done <<<"$ids"
  for network in "$SOURCE_NETWORK" "$TARGET_NETWORK"; do
    if docker network inspect "$network" >/dev/null 2>&1; then
      [[ "$(docker network inspect --format '{{index .Labels "fcd-support.alias-proof"}}/{{len .Containers}}' "$network")" == "$SCOPE/0" ]] || return 1
      docker network rm "$network" >/dev/null || return 1
    fi
  done
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
render_aliases() {
  docker compose --file "$NATIVE_ROOT/infra/compose.$1.yml" --profile '*' config --no-interpolate --no-env-resolution --format json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const j=JSON.parse(s);const n=process.argv[1]==="runtime"?"operations_data":"restore_data";const a=j.services.postgres.networks[n].aliases;if(!Array.isArray(a)||a.length<1||a.length>16||a.some(x=>typeof x!=="string"||!/^[a-z0-9-]+$/.test(x)))process.exit(1);process.stdout.write(a.join("\n"))})' "$1"
}
source_render="$(render_aliases runtime)"
target_render="$(render_aliases restore)"
source_aliases=(); target_aliases=()
while IFS= read -r alias; do source_aliases+=(--network-alias "$alias"); done <<<"$source_render"
while IFS= read -r alias; do target_aliases+=(--network-alias "$alias"); done <<<"$target_render"
[[ "$(docker image inspect --format '{{if .Config.Volumes}}yes{{else}}no{{end}}' "$IMAGE")" == no ]]
for network in "$SOURCE_NETWORK" "$TARGET_NETWORK"; do
  [[ -z "$(docker network ls --quiet --filter "name=^$network$")" ]]
  docker network create --driver bridge --internal --label "fcd-support.alias-proof=$SCOPE" "$network" >/dev/null
done
run_actor() {
  docker run --detach --pull never --name "$SCOPE-$1" --label "fcd-support.alias-proof=$SCOPE" --network "$2" --read-only --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges --cpus 0.25 --memory 64m --pids-limit 32 --entrypoint node "${@:3}" "$IMAGE" -e 'setInterval(()=>{},60000)' >/dev/null
}
run_actor source "$SOURCE_NETWORK" "${source_aliases[@]}"
run_actor target "$TARGET_NETWORK" "${target_aliases[@]}"
run_actor probe "$SOURCE_NETWORK"
docker network connect "$TARGET_NETWORK" "$SCOPE-probe"
source "$ROOT/scripts/operations-common.sh"
source "$ROOT/scripts/operations-restore-controller.sh"
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]="$SCOPE" [FCD_RESTORE_PROJECT]="$TARGET_PROJECT")
operations_docker() { docker "$@"; }
source_id="$(docker inspect --format '{{.Id}}' "$SCOPE-source")"
target_id="$(docker inspect --format '{{.Id}}' "$SCOPE-target")"
operations_restore_source_alias "$source_id"
operations_restore_target_alias "$target_id"
SOURCE_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$SOURCE_NETWORK\"}}{{.IPAddress}}{{end}}" "$SCOPE-source")"
TARGET_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$TARGET_NETWORK\"}}{{.IPAddress}}{{end}}" "$SCOPE-target")"
[[ -n "$SOURCE_IP" && -n "$TARGET_IP" && "$SOURCE_IP" != "$TARGET_IP" ]]
docker exec --env "SOURCE_IP=$SOURCE_IP" --env "TARGET_IP=$TARGET_IP" "$SCOPE-probe" node -e '
  const dns=require("node:dns").promises;
  (async()=>{let wrong=false,right=false,sourceOk=false,sourceWrong=false;for(let i=0;i<20;i++){
    const target=await dns.lookup("fcd-support-restore-postgres",{all:true});
    wrong ||= target.some(x=>x.address===process.env.SOURCE_IP);
    right ||= target.some(x=>x.address===process.env.TARGET_IP);
    const source=await dns.lookup("fcd-support-source-postgres",{all:true});
    sourceOk ||= source.some(x=>x.address===process.env.SOURCE_IP);
    sourceWrong ||= source.some(x=>x.address===process.env.TARGET_IP);
  }
  console.log(`restore_target_resolves_source=${wrong}`);
  console.log(`restore_target_resolves_target=${right}`);
  console.log(`restore_source_resolves_source=${sourceOk}`);
  console.log(`restore_source_resolves_target=${sourceWrong}`);
  if(wrong||!right||!sourceOk||sourceWrong)process.exit(1);
  })().catch(()=>process.exit(1));'
run_actor collision-source "$SOURCE_NETWORK" --network-alias fcd-support-source-postgres --network-alias fcd-support-restore-postgres
collision_id="$(docker inspect --format '{{.Id}}' "$SCOPE-collision-source")"
if operations_restore_source_alias "$collision_id"; then echo conflicting_source_alias_accepted >&2; exit 1; fi
run_actor collision-target "$TARGET_NETWORK" --network-alias fcd-support-source-postgres --network-alias fcd-support-restore-postgres
collision_id="$(docker inspect --format '{{.Id}}' "$SCOPE-collision-target")"
if operations_restore_target_alias "$collision_id"; then echo conflicting_target_alias_accepted >&2; exit 1; fi
printf '%s\n' live_alias_guards_reject_collisions=true
