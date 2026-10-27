#!/usr/bin/env bash
# Actual Docker template proof against a fresh, never-started synthetic actor.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || { printf 'docker_projection_arguments_invalid\n' >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/scripts/operations-runtime-host.sh"
source "$root/scripts/operations-restore-host.sh"
scope="fcd-support-projection-test-$$-$RANDOM"
native_root="$root"
if command -v cygpath >/dev/null 2>&1; then native_root="$(cygpath -m "$root")"; fi
revision="$(git -C "$native_root" rev-parse HEAD)"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
cleanup() {
  local actor
  actor="$(docker ps --all --quiet --no-trunc --filter "label=fcd-support.projection-test=$scope")" || return 1
  [[ -n "$actor" ]] || return 0
  [[ "$actor" =~ ^[a-f0-9]{64}$ && "$(docker container inspect --format '{{index .Config.Labels "fcd-support.projection-test"}}/{{.State.Status}}' "$actor")" == "$scope/created" ]] || return 1
  docker rm "$actor" >/dev/null
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
docker create --name "$scope" --label "fcd-support.projection-test=$scope" \
  --label com.docker.compose.project=fcd-support-projection-synthetic \
  --label com.docker.compose.service=postgres --label "org.opencontainers.image.revision=$revision" \
  --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 0.25 --memory 128m --pids-limit 32 \
  --mount "type=bind,src=$native_root/package.json,dst=/synthetic-public-metadata,readonly" \
  node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d >/dev/null
for kind in runtime restore; do
  case "$kind" in runtime) format="$OPERATIONS_RUNTIME_CONTAINER_FORMAT" ;; restore) format="$OPERATIONS_RESTORE_CONTAINER_FORMAT" ;; esac
  docker container inspect --format "$format" "$scope" | \
    node --input-type=module -e 'let text="";for await(const b of process.stdin)text+=b;const p=JSON.parse(text);if(p.healthy!==false||p.running!==false||p.mounts.length!==1||p.mounts[0].type!=="bind"||p.mounts[0].name!==""||p.mounts[0].readWrite!==false||p.hostPortBindings!==0)process.exit(1)'
  printf 'docker_%s_projection_passed=true\n' "$kind"
done
