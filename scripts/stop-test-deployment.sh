#!/usr/bin/env bash
set -Eeuo pipefail

stop_service() {
  local service="$1"
  local container_output
  local -a container_ids=()

  if ! container_output="$(docker ps --quiet \
    --filter 'label=com.docker.compose.project=fcd-support' \
    --filter "label=com.docker.compose.service=$service")"; then
    echo "Failed to query Docker containers for $service." >&2
    exit 1
  fi

  if [[ -n "$container_output" ]]; then
    mapfile -t container_ids <<< "$container_output"
    docker stop "${container_ids[@]}" >/dev/null
  fi
}

stop_service fcd-support-api
stop_service postgres

echo "Stopped the test API and PostgreSQL. The database volume, containers, retained images, networks, and tunnel were preserved."
