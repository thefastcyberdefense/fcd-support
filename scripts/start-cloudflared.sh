#!/usr/bin/env bash
set -Eeuo pipefail

TUNNEL_CONTAINER="fcd-support-cloudflared"
TOKEN_FILE="${1:-/home/redwan/.config/fcd-support/cloudflared.token}"
CLOUDFLARED_IMAGE="cloudflare/cloudflared:latest@sha256:0aa26e284f05e6c77ae375b8c9c11d9eb6a448fb7bcd8d40f31cb6176189eb38"

if [[ ! -f "$TOKEN_FILE" || "$(stat -c '%a' "$TOKEN_FILE")" != "600" ]]; then
  echo "Protected Cloudflare token file is missing or not mode 600." >&2
  exit 1
fi

docker pull "$CLOUDFLARED_IMAGE" >/dev/null
expected_image_id="$(docker image inspect --format '{{.Id}}' "$CLOUDFLARED_IMAGE")"

if docker container inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
  actual_image_id="$(docker container inspect --format '{{.Image}}' "$TUNNEL_CONTAINER")"
  if [[ "$actual_image_id" != "$expected_image_id" ]]; then
    echo "Existing tunnel container does not use the pinned image; refusing to replace it automatically." >&2
    exit 1
  fi

  if [[ "$(docker container inspect --format '{{.State.Running}}' "$TUNNEL_CONTAINER")" != "true" ]]; then
    docker start "$TUNNEL_CONTAINER" >/dev/null
  fi

  echo "Pinned tunnel container is running."
  exit 0
fi

docker run --detach \
  --name "$TUNNEL_CONTAINER" \
  --restart unless-stopped \
  --read-only \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,source=$TOKEN_FILE,target=/run/secrets/cloudflared-token,readonly" \
  "$CLOUDFLARED_IMAGE" \
  tunnel --no-autoupdate run --token-file /run/secrets/cloudflared-token >/dev/null

echo "Created the pinned fcd-support Cloudflare tunnel container."
