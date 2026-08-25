#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="ensure"
case "${1:-}" in
  --validate-only | --replace-existing)
    MODE="${1#--}"
    shift
    ;;
esac

TUNNEL_CONTAINER="fcd-support-cloudflared"
TOKEN_FILE="${1:-/home/redwan/.config/fcd-support/cloudflared.token}"
CLOUDFLARED_IMAGE="fcd-support-cloudflared:0aa26e284f05e6c77ae375b8c9c11d9"
EXPECTED_COMMAND="tunnel --no-autoupdate --metrics 0.0.0.0:2000 run --token-file /run/secrets/cloudflared-token"
EXPECTED_HEALTH='["CMD","cloudflared","tunnel","--metrics","127.0.0.1:2000","ready"]'

if [[ ! -f "$TOKEN_FILE" || "$(stat -c '%a' "$TOKEN_FILE")" != "600" ]]; then
  echo "Protected Cloudflare token file is missing or not mode 600." >&2
  exit 1
fi

TOKEN_FILE="$(readlink -f "$TOKEN_FILE")"
EXPECTED_USER="$(id -u):$(id -g)"

if [[ "$MODE" == "validate-only" ]]; then
  if ! docker image inspect "$CLOUDFLARED_IMAGE" >/dev/null 2>&1; then
    echo "Pinned project tunnel image is unavailable." >&2
    exit 1
  fi
else
  docker build --pull \
    --file "$REPOSITORY_ROOT/Dockerfile.cloudflared" \
    --tag "$CLOUDFLARED_IMAGE" \
    "$REPOSITORY_ROOT" >/dev/null
fi

EXPECTED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CLOUDFLARED_IMAGE")"

validate_contract() {
  local actual_mount
  local expected_mount
  local health_test

  [[ "$(docker container inspect --format '{{.Image}}' "$TUNNEL_CONTAINER")" == "$EXPECTED_IMAGE_ID" ]] || return 1
  [[ "$(docker container inspect --format '{{.Config.User}}' "$TUNNEL_CONTAINER")" == "$EXPECTED_USER" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$TUNNEL_CONTAINER")" == "true" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.Privileged}}' "$TUNNEL_CONTAINER")" == "false" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$TUNNEL_CONTAINER")" == "unless-stopped" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.NetworkMode}}' "$TUNNEL_CONTAINER")" == "bridge" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.Memory}}' "$TUNNEL_CONTAINER")" == "134217728" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.NanoCpus}}' "$TUNNEL_CONTAINER")" == "250000000" ]] || return 1
  [[ "$(docker container inspect --format '{{.HostConfig.PidsLimit}}' "$TUNNEL_CONTAINER")" == "100" ]] || return 1
  [[ "$(docker container inspect --format '{{json .HostConfig.CapDrop}}' "$TUNNEL_CONTAINER")" == '["ALL"]' ]] || return 1
  [[ "$(docker container inspect --format '{{json .HostConfig.SecurityOpt}}' "$TUNNEL_CONTAINER")" == '["no-new-privileges:true"]' ]] || return 1
  [[ "$(docker container inspect --format '{{join .Config.Cmd " "}}' "$TUNNEL_CONTAINER")" == "$EXPECTED_COMMAND" ]] || return 1
  [[ -z "$(docker port "$TUNNEL_CONTAINER")" ]] || return 1

  actual_mount="$(docker container inspect --format '{{if eq (len .Mounts) 1}}{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}|{{.Type}}{{end}}{{end}}' "$TUNNEL_CONTAINER")"
  expected_mount="$TOKEN_FILE|/run/secrets/cloudflared-token|false|bind"
  [[ "$actual_mount" == "$expected_mount" ]] || return 1

  health_test="$(docker container inspect --format '{{json .Config.Healthcheck.Test}}' "$TUNNEL_CONTAINER")"
  [[ "$health_test" == "$EXPECTED_HEALTH" ]] || return 1
}

wait_until_healthy() {
  for _ in $(seq 1 30); do
    if [[ "$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$TUNNEL_CONTAINER")" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

create_tunnel() {
  docker run --detach \
    --name "$TUNNEL_CONTAINER" \
    --restart unless-stopped \
    --read-only \
    --user "$EXPECTED_USER" \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --cpus 0.25 \
    --memory 128m \
    --pids-limit 100 \
    --mount "type=bind,source=$TOKEN_FILE,target=/run/secrets/cloudflared-token,readonly" \
    "$CLOUDFLARED_IMAGE" \
    tunnel --no-autoupdate --metrics 0.0.0.0:2000 run \
    --token-file /run/secrets/cloudflared-token >/dev/null
}

if docker container inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
  if validate_contract; then
    if [[ "$MODE" != "validate-only" ]] \
      && [[ "$(docker container inspect --format '{{.State.Running}}' "$TUNNEL_CONTAINER")" != "true" ]]; then
      docker start "$TUNNEL_CONTAINER" >/dev/null
    fi

    if [[ "$(docker container inspect --format '{{.State.Running}}' "$TUNNEL_CONTAINER")" != "true" ]] \
      || ! wait_until_healthy; then
      echo "Tunnel container is not healthy." >&2
      exit 1
    fi

    echo "Pinned tunnel container contract and readiness verified."
    exit 0
  fi

  if [[ "$MODE" != "replace-existing" ]]; then
    echo "Existing tunnel container does not match the hardened contract." >&2
    echo "Review it, then rerun with --replace-existing to retain it as a stopped rollback container." >&2
    exit 1
  fi

  backup_container="${TUNNEL_CONTAINER}-backup-$(date +%Y%m%d%H%M%S)"
  backup_had_ingress=false
  if docker network inspect fcd-support-ingress >/dev/null 2>&1 \
    && docker container inspect --format '{{json .NetworkSettings.Networks}}' "$TUNNEL_CONTAINER" \
      | grep -q '"fcd-support-ingress"'; then
    backup_had_ingress=true
  fi
  docker stop "$TUNNEL_CONTAINER" >/dev/null
  docker rename "$TUNNEL_CONTAINER" "$backup_container"
  if [[ "$backup_had_ingress" == "true" ]]; then
    docker network disconnect fcd-support-ingress "$backup_container"
  fi

  if ! create_tunnel || ! validate_contract || ! wait_until_healthy; then
    docker rm --force "$TUNNEL_CONTAINER" >/dev/null 2>&1 || true
    docker rename "$backup_container" "$TUNNEL_CONTAINER"
    docker start "$TUNNEL_CONTAINER" >/dev/null
    if [[ "$backup_had_ingress" == "true" ]]; then
      docker network connect fcd-support-ingress "$TUNNEL_CONTAINER"
    fi
    echo "Hardened tunnel replacement failed; the original container was restored." >&2
    exit 1
  fi

  echo "Hardened tunnel is healthy; stopped rollback container retained as $backup_container."
  exit 0
fi

create_tunnel
if ! validate_contract || ! wait_until_healthy; then
  echo "New tunnel container failed contract or readiness validation." >&2
  exit 1
fi

echo "Created and verified the hardened fcd-support Cloudflare tunnel container."
