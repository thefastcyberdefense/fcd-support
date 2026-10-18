#!/usr/bin/env bash
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
PROJECT="${1:-}"
REVISION="${2:-}"
[[ "$#" == 2 && "$PROJECT" =~ ^fcd-support-phase6-test-[a-z0-9-]+$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo 'socket_test_scope_invalid' >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
IMAGE="$PROJECT-application:$REVISION"
VOLUME="$PROJECT-admin-socket"
[[ "$(docker image inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$IMAGE")" == "$PROJECT" ]] || { echo 'socket_test_image_invalid' >&2; exit 1; }
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then echo 'socket_test_volume_not_fresh' >&2; exit 1; fi
docker volume create --label "com.docker.compose.project=$PROJECT" "$VOLUME" >/dev/null
SAFE=(--read-only --init --cap-drop ALL --security-opt no-new-privileges --cpus 0.5 --memory 256m --pids-limit 64 --network none --label "com.docker.compose.project=$PROJECT")
# The image's existing owner-only /run/fcd-support directory seeds this new,
# scoped volume through Docker copy-up. No root/chown/permission repair.
docker run --rm --name "$PROJECT-socket-seed" "${SAFE[@]}" --user node \
  --mount "type=volume,src=$VOLUME,dst=/run/fcd-support" "$IMAGE" \
  node --input-type=module -e 'import {lstat,readdir} from "node:fs/promises"; const s=await lstat("/run/fcd-support"); if(!s.isDirectory()||s.uid!==1000||s.gid!==1000||(s.mode&4095)!==448||(await readdir("/run/fcd-support")).length!==0)process.exit(1);'
docker run --rm --name "$PROJECT-socket-tests" "${SAFE[@]}" --user node \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  --tmpfs /workspace/node_modules/.vite-temp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --mount "type=bind,src=$NATIVE_ROOT/src,dst=/workspace/src,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tests,dst=/workspace/tests,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/dist,dst=/workspace/dist,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tsconfig.json,dst=/workspace/tsconfig.json,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/vitest.config.ts,dst=/workspace/vitest.config.ts,readonly" \
  fcd-support-integration-test:local npx vitest run tests/admin-socket.test.ts tests/secret-files.test.ts
echo 'admin_socket_native_linux=true'
