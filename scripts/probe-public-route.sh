#!/usr/bin/env bash
# Bounded host probe checking external webhook reachability and private-route isolation.
# Writes only $STATE_ROOT/public-route-check without touching secrets or Docker.
set -Eeuo pipefail

if ! declare -F operations_probe_fetch_status >/dev/null; then
  operations_probe_fetch_status() {
    local url="$1" timeout_ms="$2"
    node --input-type=module -e '
try {
  const response = await fetch(process.argv[1], {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(Number(process.argv[2])),
  });
  await response.body?.cancel();
  process.stdout.write(String(response.status));
} catch {
  process.exit(1);
}' "$url" "$timeout_ms" 2>/dev/null
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

  local payload
  payload="$(printf '{"state":"%s","checkedAt":"%s"}' "$state" "$checked_at")"

  node --input-type=module -e '
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const stateRoot = process.argv[1];
const payload = process.argv[2];
const rootStat = lstatSync(stateRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error("state_root_invalid");
}
const tmpPath = join(stateRoot, `.public-route-check.${process.pid}.${randomBytes(6).toString("hex")}`);
const finalPath = join(stateRoot, "public-route-check");
let fd;
try {
  fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  if (process.platform !== "win32") {
    fchmodSync(fd, 0o600);
  }
  writeSync(fd, payload, 0, "utf8");
  fsyncSync(fd);
  closeSync(fd);
  fd = undefined;
  renameSync(tmpPath, finalPath);
} catch (error) {
  if (fd !== undefined) {
    try { closeSync(fd); } catch {}
  }
  try { unlinkSync(tmpPath); } catch {}
  throw error;
}
' "$state_root" "$payload" >/dev/null 2>&1 || {
    printf 'public_route_probe_write_failed\n' >&2
    return 1
  }

  printf '%s\n' "$payload"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  operations_probe_public_route_main "$@"
fi
