#!/bin/sh
set -eu

fail() { printf '%s\n' 'image_storage_contract_failed' >&2; exit 1; }
check_owned_directory() {
  [ -d "$1" ] && [ ! -L "$1" ] || fail
  [ "$(stat -c '%u' "$1")" = "$(id -u)" ] || fail
  [ "$(stat -c '%g' "$1")" = "$(id -g)" ] || fail
  [ "$(stat -c '%a' "$1")" = 700 ] || fail
  [ -x "$1" ] || fail
  [ "${2:-write}" = read ] || { [ -w "$1" ] || fail; }
}

[ "$(id -u)" = 1000 ] || fail
check_owned_directory /run/fcd-support
case "${1:-}" in
  application) ;;
  operations) check_owned_directory /var/lib/fcd-support/backups ;;
  operations-readonly) check_owned_directory /var/lib/fcd-support/backups read ;;
  *) fail ;;
esac
shift
[ "$#" -gt 0 ] || fail
umask 077
exec "$@"
