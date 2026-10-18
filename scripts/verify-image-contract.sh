#!/usr/bin/env bash
# Local synthetic checks only. Never attaches a running project or live network.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVISION="${1:-}"
[[ "$#" == 1 && "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'image_revision_invalid' >&2; exit 1; }
CONTEXT_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then CONTEXT_ROOT="$(cygpath -m "$ROOT")"; fi
PREFIX="fcd-support-phase6-image-test-$$-$RANDOM"
APP="fcd-support-phase6-image-test-app:$REVISION"
OPS="fcd-support-phase6-image-test-operations:$REVISION"
PG="fcd-support-phase6-image-test-postgres:$REVISION"
TUNNEL="fcd-support-phase6-image-test-cloudflared:$REVISION"
VOLUMES=()
PG_CONTAINER=""
cleanup() {
  if [[ -n "$PG_CONTAINER" ]]; then docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; fi
  for volume in "${VOLUMES[@]}"; do
    [[ "$volume" == "$PREFIX-"* ]] || continue
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
create_volume() {
  docker volume create "$PREFIX-$1" >/dev/null
  VOLUMES+=("$PREFIX-$1")
}
for role in app operations postgres cloudflared; do
  case "$role" in
    app) file=Dockerfile; image="$APP" ;;
    operations) file=infra/Dockerfile.operations; image="$OPS" ;;
    postgres) file=infra/Dockerfile.postgres; image="$PG" ;;
    cloudflared) file=Dockerfile.cloudflared; image="$TUNNEL" ;;
  esac
  docker build --platform linux/amd64 --build-arg "VCS_REF=$REVISION" --file "$CONTEXT_ROOT/$file" --tag "$image" "$CONTEXT_ROOT" >/dev/null 2>&1 || { echo "image_build_failed=$role" >&2; exit 1; }
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$REVISION" ]]
done
[[ "$(docker image inspect --format '{{.Config.User}}' "$APP")" == node ]]
[[ "$(docker image inspect --format '{{.Config.User}}' "$OPS")" == node ]]
[[ "$(docker image inspect --format '{{.Config.User}}' "$PG")" == postgres ]]
[[ "$(docker image inspect --format '{{.Config.User}}' "$TUNNEL")" == 65532:65532 ]]
echo 'image_users_and_revisions=true'

HARDENED=(--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --pids-limit 100)
NODE_TMPFS=(--tmpfs /run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m)
create_volume backups
create_volume secrets
create_volume wrong-owner
create_volume wrong-mode
create_volume postgres

# Isolated fixture provisioning models host-owned 0600 files. Only this test
# initialization uses root; every application/database execution is non-root.
docker run --rm --network none --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --user 0 \
  --mount "type=volume,src=$PREFIX-secrets,dst=/fixture" \
  --entrypoint sh "$APP" -ec 'chmod 0711 /fixture; umask 077; for owner in 1000 999 65532; do printf "%s" synthetic_image_contract_secret > "/fixture/$owner"; chown "$owner:$owner" "/fixture/$owner"; done' >/dev/null
# Mark this volume populated with deliberately incompatible root ownership.
docker run --rm --network none --cap-drop ALL --user 0 --mount "type=volume,src=$PREFIX-wrong-owner,dst=/fixture" \
  --entrypoint sh "$APP" -ec 'touch /fixture/populated; test "$(stat -c %u /fixture)" = 0' >/dev/null
docker run --rm --network none --cap-drop ALL --cap-add CHOWN --user 0 --mount "type=volume,src=$PREFIX-wrong-mode,dst=/fixture" \
  --entrypoint sh "$APP" -ec 'touch /fixture/populated; chmod 0755 /fixture; chown 1000:1000 /fixture' >/dev/null

OPS_MOUNTS=(--mount "type=volume,src=$PREFIX-backups,dst=/var/lib/fcd-support/backups")
for tool in node npm pg_dump pg_restore age age-keygen; do
  docker run "${HARDENED[@]}" "${NODE_TMPFS[@]}" "${OPS_MOUNTS[@]}" "$OPS" "$tool" --version
done
docker run "${HARDENED[@]}" "$TUNNEL" version

docker run "${HARDENED[@]}" "${NODE_TMPFS[@]}" "${OPS_MOUNTS[@]}" \
  --mount "type=volume,src=$PREFIX-secrets,dst=/run/secrets,readonly" "$OPS" node --input-type=module -e '
import { readFileSync, statSync } from "node:fs";
if ((statSync("/run/secrets/1000").mode & 0o777) !== 0o600) process.exit(1);
readFileSync("/run/secrets/1000");
for (const owner of [999,65532]) { let denied = false; try { readFileSync(`/run/secrets/${owner}`); } catch { denied = true; } if (!denied) process.exit(1); }
' >/dev/null
# Repeat the actual kernel DAC check under the other runtime UIDs. The tunnel
# image is distroless; a Node executable provides the probe, not its own shell.
for owner in 999 65532; do
  docker run "${HARDENED[@]}" --user "$owner:$owner" --entrypoint node \
    --mount "type=volume,src=$PREFIX-secrets,dst=/run/secrets,readonly" "$APP" --input-type=module -e '
import { readFileSync, statSync } from "node:fs";
const uid = process.getuid();
if ((statSync(`/run/secrets/${uid}`).mode & 0o777) !== 0o600) process.exit(1);
readFileSync(`/run/secrets/${uid}`);
for (const owner of [1000,999,65532].filter(n => n !== uid)) { let denied = false; try { readFileSync(`/run/secrets/${owner}`); } catch { denied = true; } if (!denied) process.exit(1); }
' >/dev/null
done
echo 'secret_ownership=true'

for command in main admin-main 'worker-main reply' 'worker-main outbound' 'worker-main notification'; do
  read -r entry role <<< "$command"
  args=(node "dist/$entry.js")
  if [[ -n "${role:-}" ]]; then args+=("$role"); fi
  if output="$(docker run "${HARDENED[@]}" "${NODE_TMPFS[@]}" "$APP" "${args[@]}" 2>&1)"; then echo 'missing_configuration_accepted' >&2; exit 1; fi
  [[ "$output" =~ (service_start_failed|admin_service_start_failed|worker_start_failed) ]]
done
if output="$(docker run "${HARDENED[@]}" "${NODE_TMPFS[@]}" "${OPS_MOUNTS[@]}" "$OPS" node dist/operations-main.js invalid 2>&1)"; then echo 'invalid_operations_command_accepted' >&2; exit 1; fi
[[ "$output" == *operations_job_failed* ]]
echo 'unconfigured_entrypoints_fail_closed=true'

if docker run "${HARDENED[@]}" "${NODE_TMPFS[@]}" --mount "type=volume,src=$PREFIX-wrong-owner,dst=/var/lib/fcd-support/backups" "$OPS" node --version >/dev/null 2>&1; then echo 'wrong_volume_owner_accepted' >&2; exit 1; fi
if docker run "${HARDENED[@]}" --mount "type=volume,src=$PREFIX-wrong-owner,dst=/var/lib/postgresql" "$PG" postgres --version >/dev/null 2>&1; then echo 'wrong_postgres_owner_accepted' >&2; exit 1; fi
if docker run "${HARDENED[@]}" "${NODE_TMPFS[@]}" --mount "type=volume,src=$PREFIX-wrong-mode,dst=/var/lib/fcd-support/backups" "$OPS" node --version >/dev/null 2>&1; then echo 'wrong_volume_mode_accepted' >&2; exit 1; fi
echo 'wrong_volume_owner_rejected=true'
echo 'wrong_volume_mode_rejected=true'

PG_CONTAINER="$PREFIX-postgres"
docker run -d --name "$PG_CONTAINER" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --cpus 1 --memory 512m --pids-limit 100 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --tmpfs /var/run/postgresql:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=8m \
  --mount "type=volume,src=$PREFIX-postgres,dst=/var/lib/postgresql" \
  --mount "type=volume,src=$PREFIX-secrets,dst=/run/secrets,readonly" \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/999 --env POSTGRES_DB=fcd_synthetic_image_contract "$PG" >/dev/null
ready=false
for ((attempt=0; attempt<45; attempt++)); do
  if docker exec "$PG_CONTAINER" pg_isready -q -U postgres -d fcd_synthetic_image_contract; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
[[ "$(docker container inspect --format '{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{json .HostConfig.CapDrop}}' "$PG_CONTAINER")" == 'true|false|["ALL"]' ]]
docker exec "$PG_CONTAINER" sh -ec 'test "$(stat -c %u "$PGDATA")" = 999; test "$(stat -c %a "$PGDATA")" = 700'
docker stop --time 15 "$PG_CONTAINER" >/dev/null
echo 'nonroot_postgres_initialization=true'
echo 'image_contract=true'
