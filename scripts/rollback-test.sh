#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REVISION="${1:-}"
CONFIRMATION="${2:-}"
ENV_FILE="${3:-/home/redwan/.config/fcd-support/runtime.env}"
COMPOSE_FILE="$REPOSITORY_ROOT/infra/compose.deploy.yml"

if [[ ! "$TARGET_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "First argument must be the full target 40-character Git revision." >&2
  exit 1
fi

if [[ "$CONFIRMATION" != "--confirm-schema-compatible" ]]; then
  echo "Rollback requires --confirm-schema-compatible after migration compatibility is reviewed." >&2
  exit 1
fi

export FCD_SUPPORT_REVISION="$TARGET_REVISION"
export FCD_SUPPORT_IMAGE="fcd-support-api:$TARGET_REVISION"

compose() {
  docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"
}

if [[ ! -f "$ENV_FILE" || "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  echo "Protected runtime environment file is missing or not mode 600." >&2
  exit 1
fi

if ! docker image inspect "$FCD_SUPPORT_IMAGE" >/dev/null 2>&1; then
  echo "Retained rollback image is unavailable; refusing to rebuild an old revision implicitly." >&2
  exit 1
fi

image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$FCD_SUPPORT_IMAGE")"
if [[ "$image_revision" != "$TARGET_REVISION" ]]; then
  echo "Rollback image label does not match the requested revision." >&2
  exit 1
fi

compose config --quiet
compose up --detach --no-deps --no-build fcd-support-api

api_id="$(compose ps --quiet fcd-support-api)"
for _ in $(seq 1 30); do
  if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id")" == "healthy" ]]; then
    break
  fi
  sleep 2
done

if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id")" != "healthy" ]]; then
  echo "Rolled-back API did not become healthy." >&2
  exit 1
fi

"$REPOSITORY_ROOT/scripts/verify-test-deployment.sh" "$TARGET_REVISION" "$ENV_FILE"

echo "API rollback completed to retained revision ${TARGET_REVISION:0:12}."
