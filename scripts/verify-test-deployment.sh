#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPROVED_REVISION="${1:-}"
ENV_FILE="${2:-/home/redwan/.config/fcd-support/runtime.env}"
COMPOSE_FILE="$REPOSITORY_ROOT/infra/compose.deploy.yml"
DATA_NETWORK="fcd-support-data"
INGRESS_NETWORK="fcd-support-ingress"
TUNNEL_CONTAINER="fcd-support-cloudflared"
CALLBACK_URL="https://meta.fastcyberdefense.com/webhooks/meta"
NEGATIVE_URL="https://meta.fastcyberdefense.com/health"

if [[ ! "$APPROVED_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "First argument must be the full approved 40-character Git revision." >&2
  exit 1
fi

export FCD_SUPPORT_REVISION="$APPROVED_REVISION"
export FCD_SUPPORT_IMAGE="fcd-support-api:$APPROVED_REVISION"

compose() {
  docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"
}

read_setting() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "$ENV_FILE"
}

is_attached() {
  local container="$1"
  local network="$2"
  docker container inspect --format '{{json .NetworkSettings.Networks}}' "$container" \
    | grep -q "\"$network\""
}

network_names() {
  docker container inspect \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' \
    "$1"
}

assert_only_networks() {
  local container="$1"
  shift
  local actual
  local allowed
  local expected

  while IFS= read -r actual; do
    [[ -z "$actual" ]] && continue
    allowed=false
    for expected in "$@"; do
      if [[ "$actual" == "$expected" ]]; then
        allowed=true
        break
      fi
    done
    if [[ "$allowed" != "true" ]]; then
      echo "$container has an unexpected Docker network attachment." >&2
      exit 1
    fi
  done < <(network_names "$container")

  for expected in "$@"; do
    if ! is_attached "$container" "$expected"; then
      echo "$container is not attached to required network $expected." >&2
      exit 1
    fi
  done
}

network_endpoint_ids() {
  docker network inspect \
    --format '{{range $id, $_ := .Containers}}{{$id}}{{"\n"}}{{end}}' \
    "$1"
}

assert_network_endpoints() {
  local network="$1"
  shift
  local actual
  local allowed
  local expected
  local found

  while IFS= read -r actual; do
    [[ -z "$actual" ]] && continue
    allowed=false
    for expected in "$@"; do
      if [[ "$actual" == "$expected" ]]; then
        allowed=true
        break
      fi
    done
    if [[ "$allowed" != "true" ]]; then
      echo "$network has an unexpected container endpoint." >&2
      exit 1
    fi
  done < <(network_endpoint_ids "$network")

  for expected in "$@"; do
    found=false
    while IFS= read -r actual; do
      if [[ "$actual" == "$expected" ]]; then
        found=true
        break
      fi
    done < <(network_endpoint_ids "$network")
    if [[ "$found" != "true" ]]; then
      echo "$network is missing a required container endpoint." >&2
      exit 1
    fi
  done
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Runtime environment file not found: $ENV_FILE" >&2
  exit 1
fi

if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  echo "Refusing to verify because $ENV_FILE is not mode 600." >&2
  exit 1
fi

verify_token="$(read_setting META_VERIFY_TOKEN)"
if [[ -z "$verify_token" ]]; then
  echo "META_VERIFY_TOKEN is blank or missing." >&2
  exit 1
fi


tunnel_revision="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)"
"$REPOSITORY_ROOT/scripts/start-cloudflared.sh" --validate-only "$tunnel_revision"
compose config --quiet
api_id="$(compose ps --quiet fcd-support-api)"
postgres_id="$(compose ps --quiet postgres)"
tunnel_id="$(docker container inspect --format '{{.Id}}' "$TUNNEL_CONTAINER")"

if [[ -z "$api_id" || -z "$postgres_id" ]]; then
  echo "The API or PostgreSQL container is not running." >&2
  exit 1
fi

if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$api_id")" != "healthy" ]]; then
  echo "fcd-support-api is not healthy." >&2
  exit 1
fi

if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$postgres_id")" != "healthy" ]]; then
  echo "PostgreSQL is not healthy." >&2
  exit 1
fi

if [[ "$(docker inspect --format '{{.Config.Image}}' "$api_id")" != "$FCD_SUPPORT_IMAGE" ]]; then
  echo "Running API image does not match the approved revision tag." >&2
  exit 1
fi

image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$FCD_SUPPORT_IMAGE")"
if [[ "$image_revision" != "$APPROVED_REVISION" ]]; then
  echo "Running API image revision label does not match the approved revision." >&2
  exit 1
fi

if [[ -n "$(docker port "$api_id")" || -n "$(docker port "$postgres_id")" ]]; then
  echo "The API or PostgreSQL unexpectedly publishes a host port." >&2
  exit 1
fi

for network in "$DATA_NETWORK" "$INGRESS_NETWORK"; do
  if [[ "$(docker network inspect --format '{{.Internal}}' "$network")" != "true" ]]; then
    echo "$network is not private/internal." >&2
    exit 1
  fi
done

assert_only_networks "$api_id" "$DATA_NETWORK" "$INGRESS_NETWORK"
assert_only_networks "$postgres_id" "$DATA_NETWORK"
assert_network_endpoints "$DATA_NETWORK" "$api_id" "$postgres_id"
assert_network_endpoints "$INGRESS_NETWORK" "$api_id" "$tunnel_id"

if ! is_attached "$TUNNEL_CONTAINER" "$INGRESS_NETWORK"; then
  echo "$TUNNEL_CONTAINER is not attached to $INGRESS_NETWORK." >&2
  exit 1
fi

for forbidden_network in "$DATA_NETWORK" mnfst_internal; do
  if is_attached "$TUNNEL_CONTAINER" "$forbidden_network"; then
    echo "$TUNNEL_CONTAINER has a forbidden private-network attachment." >&2
    exit 1
  fi
done

while IFS= read -r tunnel_network; do
  if [[ -n "$tunnel_network" && "$tunnel_network" != "$INGRESS_NETWORK" ]] \
    && is_attached "$api_id" "$tunnel_network"; then
    echo "The API and tunnel share an unexpected Docker network." >&2
    exit 1
  fi
done < <(network_names "$TUNNEL_CONTAINER")

challenge="fcd-public-check-$(date +%s)"
curl_config="$(mktemp)"
negative_headers="$(mktemp)"
trap 'rm -f "$curl_config" "$negative_headers"' EXIT
chmod 600 "$curl_config" "$negative_headers"

escape_curl_config() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

{
  printf 'url = "%s"\n' "$CALLBACK_URL"
  printf 'get\n'
  printf 'data-urlencode = "hub.mode=subscribe"\n'
  printf 'data-urlencode = "hub.verify_token=%s"\n' "$(escape_curl_config "$verify_token")"
  printf 'data-urlencode = "hub.challenge=%s"\n' "$challenge"
  printf 'silent\nshow-error\n'
} > "$curl_config"

public_output=""
public_status=""
for _ in $(seq 1 15); do
  if public_output="$(curl --connect-timeout 5 --max-time 15 \
    --config "$curl_config" --write-out $'\n%{http_code}')"; then
    public_status="${public_output##*$'\n'}"
  else
    public_output=""
    public_status="transport_error"
  fi
  if [[ "$public_status" == "200" ]]; then
    break
  fi
  sleep 2
done

public_body="${public_output%$'\n'*}"
if [[ "$public_status" != "200" || "$public_body" != "$challenge" ]]; then
  echo "Public Meta verification failed (HTTP $public_status)." >&2
  exit 1
fi

negative_status="$(curl --connect-timeout 5 --max-time 15 \
  --silent --show-error --output /dev/null \
  --dump-header "$negative_headers" --write-out '%{http_code}' "$NEGATIVE_URL")"
if [[ "$negative_status" != "404" ]]; then
  echo "Non-webhook public path must return 404; received HTTP $negative_status." >&2
  exit 1
fi

if grep -qi '^x-fcd-route-scope:[[:space:]]*application' "$negative_headers"; then
  echo "Non-webhook path reached the application; the Cloudflare path rule is too broad." >&2
  exit 1
fi

unsigned_status="$(curl --connect-timeout 5 --max-time 15 \
  --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data '{"object":"page","entry":[]}' \
  "$CALLBACK_URL")"
if [[ "$unsigned_status" != "401" ]]; then
  echo "Unsigned webhook must return 401; received HTTP $unsigned_status." >&2
  exit 1
fi

echo "Verified: SHA-pinned containers healthy, no host ports, private networks exact."
echo "Verified: public callback returns the challenge; non-webhook path stops at ingress."
echo "Verified: unsigned webhook events are rejected."
