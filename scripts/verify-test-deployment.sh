#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-/home/redwan/.config/fcd-support/runtime.env}"
COMPOSE_FILE="$REPOSITORY_ROOT/infra/compose.deploy.yml"
INGRESS_NETWORK="fcd-support-ingress"
TUNNEL_CONTAINER="fcd-support-cloudflared"
CALLBACK_URL="https://meta.fastcyberdefense.com/webhooks/meta"
NEGATIVE_URL="https://meta.fastcyberdefense.com/health"

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

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Runtime environment file not found: $ENV_FILE" >&2
  exit 1
fi

verify_token="$(read_setting META_VERIFY_TOKEN)"
if [[ -z "$verify_token" ]]; then
  echo "META_VERIFY_TOKEN is blank or missing." >&2
  exit 1
fi

api_id="$(compose ps --quiet fcd-support-api)"
postgres_id="$(compose ps --quiet postgres)"

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

if [[ -n "$(docker port "$api_id")" || -n "$(docker port "$postgres_id")" ]]; then
  echo "The API or PostgreSQL unexpectedly publishes a host port." >&2
  exit 1
fi

for network in fcd-support-data "$INGRESS_NETWORK" mnfst_internal; do
  if ! is_attached "$api_id" "$network"; then
    echo "fcd-support-api is not attached to $network." >&2
    exit 1
  fi
done

if ! is_attached "$TUNNEL_CONTAINER" "$INGRESS_NETWORK"; then
  echo "$TUNNEL_CONTAINER is not attached to $INGRESS_NETWORK." >&2
  exit 1
fi

if is_attached "$postgres_id" "$INGRESS_NETWORK"; then
  echo "PostgreSQL must not be attached to the ingress network." >&2
  exit 1
fi

if [[ "$(docker network inspect --format '{{.Internal}}' "$INGRESS_NETWORK")" != "true" ]]; then
  echo "$INGRESS_NETWORK is not private/internal." >&2
  exit 1
fi

challenge="fcd-public-check-$(date +%s)"
curl_config="$(mktemp)"
trap 'rm -f "$curl_config"' EXIT
chmod 600 "$curl_config"

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
  public_output="$(curl --config "$curl_config" --write-out $'\n%{http_code}')"
  public_status="${public_output##*$'\n'}"
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

negative_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$NEGATIVE_URL")"
if [[ "$negative_status" != "404" ]]; then
  echo "Non-webhook public path must return 404; received HTTP $negative_status." >&2
  exit 1
fi

unsigned_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data '{"object":"page","entry":[]}' \
  "$CALLBACK_URL")"
if [[ "$unsigned_status" != "401" ]]; then
  echo "Unsigned webhook must return 401; received HTTP $unsigned_status." >&2
  exit 1
fi

echo "Verified: containers healthy, no host ports, private ingress attached."
echo "Verified: public callback returns the challenge; non-webhook path is 404."
echo "Verified: unsigned webhook events are rejected."
