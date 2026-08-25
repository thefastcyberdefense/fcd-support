#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPROVED_REVISION="${1:-}"
ENV_FILE="${2:-/home/redwan/.config/fcd-support/runtime.env}"

if [[ ! "$APPROVED_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "First argument must be the full deployed 40-character Git revision." >&2
  exit 1
fi

export FCD_SUPPORT_REVISION="$APPROVED_REVISION"
export FCD_SUPPORT_IMAGE="fcd-support-api:$APPROVED_REVISION"

docker compose \
  --env-file "$ENV_FILE" \
  --file "$REPOSITORY_ROOT/infra/compose.deploy.yml" \
  down --remove-orphans

echo "Stopped the test API and PostgreSQL. The database volume, retained images, and tunnel were preserved."
