#!/usr/bin/env bash
set -Eeuo pipefail

stop_service() {
  local service="$1"
  local -a container_ids=()
  mapfile -t container_ids < <(docker ps --quiet \
    --filter 'label=com.docker.compose.project=fcd-support' \
    --filter "label=com.docker.compose.service=$service")

  if (( ${#container_ids[@]} > 0 )); then
    docker stop "${container_ids[@]}" >/dev/null
  fi
}

stop_service fcd-support-api
stop_service postgres

echo "Stopped the test API and PostgreSQL. The database volume, containers, retained images, networks, and tunnel were preserved."
