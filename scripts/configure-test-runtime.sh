#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${1:-/home/redwan/.config/fcd-support/runtime.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Runtime environment file not found: $ENV_FILE" >&2
  exit 1
fi

if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  echo "Refusing to edit $ENV_FILE because its mode is not 600." >&2
  exit 1
fi

set_setting() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$temporary"

  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 {
      if (updated == 0) {
        print key "=" value
        updated = 1
      }
      next
    }
    { print }
    END {
      if (updated == 0) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" > "$temporary"

  mv "$temporary" "$ENV_FILE"
}

set_setting HOST "0.0.0.0"
set_setting PORT "3003"
set_setting PUBLIC_WEBHOOK_BASE_URL "https://meta.fastcyberdefense.com"
set_setting MANIFEST_BASE_URL "http://manifest:2099/v1"
set_setting MANIFEST_MODEL "auto"

echo "Updated non-secret test runtime settings in $ENV_FILE."
