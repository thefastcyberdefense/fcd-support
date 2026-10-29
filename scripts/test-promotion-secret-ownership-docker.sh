#!/usr/bin/env bash
# Real ownership proof on one fresh, labelled synthetic volume only.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 1 && "$1" =~ ^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+(@sha256:[a-f0-9]{64})?$ ]] || { printf 'promotion_secret_test_arguments_invalid\n' >&2; exit 1; }
image="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
native_root="$root"
if command -v cygpath >/dev/null 2>&1; then native_root="$(cygpath -m "$root")"; fi
token="$(od -An -N8 -tx1 /dev/urandom)"; token="${token//[[:space:]]/}"
[[ "$token" =~ ^[a-f0-9]{16}$ ]]
volume="fcd-support-promotion-secret-test-$token"
existing="$(docker volume ls --quiet --filter "name=^$volume$")"
[[ -z "$existing" ]]
if docker volume inspect "$volume" >/dev/null 2>&1; then printf 'promotion_secret_test_volume_exists\n' >&2; exit 1; fi
[[ "$(docker image inspect --format '{{if .Config.Volumes}}volume{{else}}none{{end}}' "$image")" == none ]]
created="$(docker volume create --label "fcd-support.promotion-secret-test=$volume" "$volume")"
[[ "$created" == "$volume" && "$(docker volume inspect --format '{{index .Labels "fcd-support.promotion-secret-test"}}' "$volume")" == "$volume" ]]
cleanup() {
  local users
  [[ "$(docker volume inspect --format '{{.Name}}/{{.Driver}}/{{.Scope}}/{{index .Labels "fcd-support.promotion-secret-test"}}' "$volume")" == "$volume/local/local/$volume" ]] || return 1
  users="$(docker ps --all --quiet --filter "volume=$volume")" || return 1
  [[ -z "$users" ]] || return 1
  docker volume rm "$volume" >/dev/null
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
root_fixture() {
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 \
    --label "fcd-support.promotion-secret-test=$volume" --mount "type=volume,src=$volume,dst=/proof" \
    --entrypoint bash "$image" -c '
      set -Eeuo pipefail
      root=/proof/secrets
      case "$1" in
        create)
          mkdir -p "$root"/{restore,verify-backup,backup,postgres}
          for file in restore/restore-checkpoint-database restore/restore-database restore/restore-keyring verify-backup/restore-identity backup/recovery-hmac postgres/postgres-password restore/restore-postgres-password; do
            printf synthetic-test-only >"$root/$file"
            chmod 600 "$root/$file"
            chown 1000:1000 "$root/$file"
          done
          chown 999:999 "$root/postgres/postgres-password" "$root/restore/restore-postgres-password"
          chmod 700 "$root" "$root/restore" "$root/verify-backup" "$root/backup" "$root/postgres"
          chown 1000:1000 "$root" "$root/restore" "$root/verify-backup" "$root/backup" "$root/postgres" ;;
        wrong-source-owner) chown 1000:1000 "$root/postgres/postgres-password" ;;
        wrong-source-group) chown 999:1000 "$root/postgres/postgres-password" ;;
        restore-source-owner) chown 999:999 "$root/postgres/postgres-password" ;;
        wrong-target-owner) chown 1000:1000 "$root/restore/restore-postgres-password" ;;
        wrong-target-group) chown 999:1000 "$root/restore/restore-postgres-password" ;;
        restore-target-owner) chown 999:999 "$root/restore/restore-postgres-password" ;;
        wrong-job-owner) chown 999:999 "$root/restore/restore-keyring" ;;
        wrong-job-group) chown 1000:999 "$root/restore/restore-keyring" ;;
        restore-job-owner) chown 1000:1000 "$root/restore/restore-keyring" ;;
        postgres-read-only) chmod 400 "$root/postgres/postgres-password" "$root/restore/restore-postgres-password" ;;
        postgres-read-write) chmod 600 "$root/postgres/postgres-password" "$root/restore/restore-postgres-password" ;;
        unsafe-mode) chmod 644 "$root/backup/recovery-hmac" ;;
        restore-mode) chmod 600 "$root/backup/recovery-hmac" ;;
        hardlink) ln "$root/backup/recovery-hmac" "$root/backup/extra" ;;
        remove-hardlink) rm -- "$root/backup/extra" ;;
        symlink) rm -- "$root/restore/restore-keyring"; ln -s "$root/backup/recovery-hmac" "$root/restore/restore-keyring" ;;
        remove-symlink) rm -- "$root/restore/restore-keyring"; printf synthetic-test-only >"$root/restore/restore-keyring"; chmod 600 "$root/restore/restore-keyring"; chown 1000:1000 "$root/restore/restore-keyring" ;;
        *) exit 1 ;;
      esac
    ' bash "$1" >/dev/null
}
guard() {
  docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
    --cpus 0.25 --memory 128m --pids-limit 32 --label "fcd-support.promotion-secret-test=$volume" \
    --mount "type=volume,src=$volume,dst=/proof,readonly" \
    --mount "type=bind,src=$native_root/scripts,dst=/workspace/scripts,readonly" \
    --entrypoint bash "$image" -c '
      set -Eeuo pipefail
      source /workspace/scripts/operations-common.sh
      source /workspace/scripts/operations-promotion-host.sh
      declare -A OPS_CONFIG=([FCD_SECRET_ROOT]=/proof/secrets)
      operations_promotion_host_secrets
    ' >/dev/null 2>&1
}
root_fixture create
if ! guard; then printf 'promotion_secret_valid_ownership_refused\n' >&2; exit 1; fi
root_fixture postgres-read-only
guard
root_fixture postgres-read-write
guard
for pair in 'wrong-source-owner restore-source-owner' 'wrong-source-group restore-source-owner' 'wrong-target-owner restore-target-owner' 'wrong-target-group restore-target-owner' 'wrong-job-owner restore-job-owner' 'wrong-job-group restore-job-owner' 'unsafe-mode restore-mode' 'hardlink remove-hardlink' 'symlink remove-symlink'; do
  read -r bad restore <<<"$pair"
  root_fixture "$bad"
  if guard; then printf 'promotion_secret_invalid_ownership_accepted\n' >&2; exit 1; fi
  root_fixture "$restore"
  guard
done
printf 'promotion_secret_real_ownership_passed=true\npromotion_secret_invalid_metadata_refused=true\n'
