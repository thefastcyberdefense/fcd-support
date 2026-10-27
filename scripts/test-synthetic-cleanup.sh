#!/usr/bin/env bash
# Verify the real native harness cleanup against one owned anonymous volume.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 2 && "$2" =~ ^[a-f0-9]{40}$ ]] || { echo synthetic_cleanup_arguments_invalid >&2; exit 1; }
fixture_image="$1"; REVISION="$2"; root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCOPE="fcd-support-cleanup-proof-$$-$RANDOM"; VOLUME="$SCOPE-backups"; RESTORE_VOLUME="$SCOPE-restore"; RESTORE_NETWORK="$SCOPE-network"
OPS="$SCOPE-unused-ops:$REVISION"; RUNNER="$SCOPE-unused-runner:$REVISION"; APP="$SCOPE-unused-app:$REVISION"
actor="$SCOPE-unit"; anonymous=''
cleanup_fixture() {
  local identity users
  identity="$(docker inspect --format '{{index .Config.Labels "fcd-support.backup-test"}}' "$actor" 2>/dev/null || true)"
  if [[ "$identity" == "$SCOPE" ]]; then docker rm --force --volumes "$actor" >/dev/null || return 1; fi
  if [[ -n "$anonymous" ]] && docker volume inspect "$anonymous" >/dev/null 2>&1; then
    [[ "$anonymous" =~ ^[a-f0-9]{64}$ ]] || return 1
    users="$(docker ps --all --quiet --filter "volume=$anonymous")" || return 1
    [[ -z "$users" ]] || return 1
    docker volume rm "$anonymous" >/dev/null || return 1
  fi
}
trap 'result=$?; cleanup_fixture || result=1; exit "$result"' EXIT
[[ -z "$(docker ps --all --quiet --filter "name=^/$actor$")" ]]
id="$(docker create --pull never --name "$actor" --label "fcd-support.backup-test=$SCOPE" --network none --read-only "$fixture_image" --version)"
[[ "$id" =~ ^[a-f0-9]{64}$ ]]
anonymous="$(docker inspect --format '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/var/lib/postgresql")}}{{.Name}}{{end}}{{end}}' "$id")"
[[ "$anonymous" =~ ^[a-f0-9]{64}$ && "$(docker ps --all --quiet --no-trunc --filter "volume=$anonymous")" == "$id" ]]
# Extract and execute the actual harness cleanup, with this script's exact scope.
source <(sed -n '/^cleanup() {/,/^}/p' "$root/scripts/test-encrypted-backup.sh")
declare -F cleanup >/dev/null
cleanup
if docker volume inspect "$anonymous" >/dev/null 2>&1; then
  echo synthetic_cleanup_anonymous_volume_retained >&2
  exit 1
fi
[[ -z "$(docker ps --all --quiet --filter "name=^/$actor$")" ]]
anonymous=''
printf '%s\n' synthetic_cleanup_anonymous_volume_removed=true
