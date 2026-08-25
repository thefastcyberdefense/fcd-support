#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-/home/redwan/.config/fcd-support/runtime.env}"

docker compose \
  --env-file "$ENV_FILE" \
  --file "$REPOSITORY_ROOT/infra/compose.deploy.yml" \
  down --remove-orphans

echo "Stopped the test API and PostgreSQL. The database volume and tunnel were preserved."
