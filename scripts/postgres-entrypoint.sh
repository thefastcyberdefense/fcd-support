#!/bin/sh
set -eu

fail() { printf '%s\n' 'postgres_storage_contract_failed' >&2; exit 1; }
[ "$(id -u)" = 999 ] || fail
[ "${PGDATA:-}" = /var/lib/postgresql/18/docker ] || fail
for directory in /var/lib/postgresql /var/lib/postgresql/18 /var/lib/postgresql/18/docker /var/run/postgresql; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail
  [ "$(stat -c '%u' "$directory")" = "$(id -u)" ] || fail
  [ "$(stat -c '%g' "$directory")" = "$(id -g)" ] || fail
  if [ "$directory" = /var/run/postgresql ]; then
    [ "$(stat -c '%a' "$directory")" = 770 ] || fail
  else
    [ "$(stat -c '%a' "$directory")" = 700 ] || fail
  fi
  [ -w "$directory" ] && [ -x "$directory" ] || fail
done
umask 077
exec /usr/local/bin/docker-entrypoint.sh "$@"
