#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPROVED_REVISION="${1:-}"
ENV_FILE="${2:-/home/redwan/.config/fcd-support/runtime.env}"
COMPOSE_FILE="$REPOSITORY_ROOT/infra/compose.deploy.yml"
INGRESS_NETWORK="fcd-support-ingress"
TUNNEL_CONTAINER="fcd-support-cloudflared"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is missing: $1" >&2
    exit 1
  }
}

require_setting() {
  local key="$1"
  if ! awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (length(value) > 0) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$ENV_FILE"; then
    echo "Required runtime setting is blank or missing: $key" >&2
    exit 1
  fi
}

for command in awk docker git grep seq stat; do
  require_command "$command"
done

if [[ ! "$APPROVED_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "First argument must be the full approved 40-character Git revision." >&2
  exit 1
fi

current_revision="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)"
if [[ "$current_revision" != "$APPROVED_REVISION" ]]; then
  echo "Checked-out revision does not match the approved revision; refusing to deploy." >&2
  exit 1
fi

if [[ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=all)" ]]; then
  echo "Repository contains uncommitted or untracked files; refusing to deploy." >&2
  exit 1
fi

export FCD_SUPPORT_REVISION="$APPROVED_REVISION"
export FCD_SUPPORT_IMAGE="fcd-support-api:$APPROVED_REVISION"

compose() {
  docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Runtime environment file not found: $ENV_FILE" >&2
  exit 1
fi

if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  echo "Refusing to deploy because $ENV_FILE is not mode 600." >&2
  exit 1
fi

for key in DATABASE_URL POSTGRES_PASSWORD META_APP_SECRET META_VERIFY_TOKEN; do
  require_setting "$key"
done

if ! docker network inspect "$INGRESS_NETWORK" >/dev/null 2>&1; then
  docker network create --internal --attachable "$INGRESS_NETWORK" >/dev/null
  echo "Created private Docker network: $INGRESS_NETWORK"
fi

if [[ "$(docker network inspect --format '{{.Internal}}' "$INGRESS_NETWORK")" != "true" ]]; then
  echo "Existing network $INGRESS_NETWORK is not internal; refusing to continue." >&2
  exit 1
fi

if ! docker container inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
  echo "Tunnel container not found: $TUNNEL_CONTAINER" >&2
  exit 1
fi

if [[ "$(docker container inspect --format '{{.State.Running}}' "$TUNNEL_CONTAINER")" != "true" ]]; then
  echo "Tunnel container is not running: $TUNNEL_CONTAINER" >&2
  exit 1
fi

"$REPOSITORY_ROOT/scripts/start-cloudflared.sh" --validate-only "$APPROVED_REVISION"

if ! docker container inspect --format '{{json .NetworkSettings.Networks}}' "$TUNNEL_CONTAINER" \
  | grep -q "\"$INGRESS_NETWORK\""; then
  docker network connect "$INGRESS_NETWORK" "$TUNNEL_CONTAINER"
  echo "Attached $TUNNEL_CONTAINER to $INGRESS_NETWORK."
fi

compose config --quiet
compose pull postgres
compose build --pull fcd-support-api

image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$FCD_SUPPORT_IMAGE")"
if [[ "$image_revision" != "$APPROVED_REVISION" ]]; then
  echo "Built image revision label does not match the approved revision." >&2
  exit 1
fi

compose up --detach postgres

postgres_id="$(compose ps --quiet postgres)"
for _ in $(seq 1 30); do
  if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_id")" == "healthy" ]]; then
    break
  fi
  sleep 2
done

if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_id")" != "healthy" ]]; then
  echo "PostgreSQL did not become healthy." >&2
  exit 1
fi

compose run --rm migrate
compose up --detach --no-deps --no-build fcd-support-api

api_id="$(compose ps --quiet fcd-support-api)"
for _ in $(seq 1 30); do
  if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id")" == "healthy" ]]; then
    break
  fi
  sleep 2
done

if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id")" != "healthy" ]]; then
  echo "API did not become healthy." >&2
  exit 1
fi

"$REPOSITORY_ROOT/scripts/verify-test-deployment.sh" "$APPROVED_REVISION" "$ENV_FILE"

echo "Test webhook deployment is ready at approved revision ${APPROVED_REVISION:0:12}."
