#!/usr/bin/env bash
# Bounded host probe checking external webhook reachability and private-route isolation.
# Writes only $STATE_ROOT/public-route-check using host curl/coreutils (no host Node).
set -Eeuo pipefail

if ! declare -F operations_probe_fetch_status >/dev/null; then
  operations_probe_fetch_status() {
    local url="$1" timeout_ms="$2" timeout_s
    timeout_s="$(( (10#$timeout_ms + 999) / 1000 ))"
    curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout "$timeout_s" --max-time "$timeout_s" \
      --proto '=https' --tlsv1.2 -- "$url" 2>/dev/null
  }
fi

operations_probe_public_route_main() {
  local raw_url="${1:-${FCD_PUBLIC_WEBHOOK_CHECK_URL:-}}"
  local state_root="${2:-${FCD_STATE_ROOT:-}}"
  local timeout_ms="${3:-${FCD_HEALTH_TIMEOUT_MS:-5000}}"
  local stamp='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z'

  [[ -n "$raw_url" && ${#raw_url} -le 512 && "$raw_url" =~ ^https://[^/@[:space:]?#]+/webhooks/meta$ ]] || {
    printf 'public_route_probe_url_invalid\n' >&2
    return 1
  }
  [[ -n "$state_root" && -d "$state_root" && ! -L "$state_root" ]] || {
    printf 'public_route_probe_state_root_invalid\n' >&2
    return 1
  }
  [[ "$timeout_ms" =~ ^[1-9][0-9]{0,5}$ ]] && (( 10#$timeout_ms >= 500 && 10#$timeout_ms <= 30000 )) || {
    printf 'public_route_probe_timeout_invalid\n' >&2
    return 1
  }

  local origin="${raw_url%/webhooks/meta}"
  local webhook_status='' health_status='' login_status='' state='failed' checked_at=''
  checked_at="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" || return 1
  [[ "$checked_at" =~ ^${stamp}$ ]] || return 1

  webhook_status="$(operations_probe_fetch_status "${origin}/webhooks/meta" "$timeout_ms" || true)"
  health_status="$(operations_probe_fetch_status "${origin}/health" "$timeout_ms" || true)"
  login_status="$(operations_probe_fetch_status "${origin}/login" "$timeout_ms" || true)"

  if [[ "$webhook_status" == 403 && "$health_status" == 404 && "$login_status" == 404 ]]; then
    state='passed'
  fi

  local payload tmp=''
  payload="$(printf '{"state":"%s","checkedAt":"%s"}' "$state" "$checked_at")"

  tmp="$(umask 077 && mktemp -- "$state_root/.public-route-check.XXXXXXXX")" 2>/dev/null || {
    printf 'public_route_probe_write_failed\n' >&2
    return 1
  }
  if [[ -L "$tmp" || ! -f "$tmp" ]]; then
    rm -f -- "$tmp" 2>/dev/null || true
    printf 'public_route_probe_write_failed\n' >&2
    return 1
  fi
  chmod 0600 -- "$tmp" 2>/dev/null || true
  if ! printf '%s' "$payload" >"$tmp"; then
    rm -f -- "$tmp" 2>/dev/null || true
    printf 'public_route_probe_write_failed\n' >&2
    return 1
  fi
  sync "$tmp" 2>/dev/null || true
  if ! mv -f -T -- "$tmp" "$state_root/public-route-check"; then
    rm -f -- "$tmp" 2>/dev/null || true
    printf 'public_route_probe_write_failed\n' >&2
    return 1
  fi

  printf '%s\n' "$payload"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  operations_probe_public_route_main "$@"
fi
