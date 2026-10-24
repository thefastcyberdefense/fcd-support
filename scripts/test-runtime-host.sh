#!/usr/bin/env bash
# Networkless native proof with synthetic fixtures and fake Docker transport.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || { echo runtime_host_test_arguments_invalid >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
SCOPE="fcd-support-runtime-host-test-$$-$RANDOM"
npm run build --silent
docker run --rm --name "$SCOPE" --label "fcd-support.runtime-host-test=$SCOPE" \
  --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --cpus 1 --memory 512m --pids-limit 64 \
  --tmpfs /run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=32m \
  --tmpfs /var/lib/fcd-support/backups:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=32m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m \
  --tmpfs /workspace/node_modules/.vite-temp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m \
  --mount "type=bind,src=$NATIVE_ROOT/scripts,dst=/workspace/scripts,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/infra,dst=/workspace/infra,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/src,dst=/workspace/src,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tests,dst=/workspace/tests,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/dist,dst=/workspace/dist,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/vitest.config.ts,dst=/workspace/vitest.config.ts,readonly" \
  --mount "type=bind,src=$NATIVE_ROOT/tsconfig.json,dst=/workspace/tsconfig.json,readonly" \
  --env RUN_ENCRYPTED_BACKUP_TESTS=synthetic-operations-toolchain-only \
  fcd-support-integration-test:local npx vitest run tests/phase6-compose-contract.test.ts tests/database-identity-script.test.ts
echo runtime_host_local=true
