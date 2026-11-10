#!/usr/bin/env bash
# Real Docker + PostgreSQL + compose.operations.yml proof of the built health
# stdio contract, log-driver parity, TRACE safety, and fault/uncertainty refusal.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1

[[ "$#" == 2 && "$2" =~ ^[a-f0-9]{40}$ ]] || {
  echo health_stdio_docker_arguments_invalid >&2
  exit 1
}

ops_image="$1"
revision="$2"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
scope="fcd-support-health-stdio-$$-$RANDOM"
network="$scope-operations-data"
backup_volume="$scope-backups"
pg_volume="$scope-postgres"
pg_container="$scope-postgres"
postgres_image='postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636'
schema_revision='000016'
host_secret_marker='synthetic_docker_host_marker_do_not_echo'
workdir=''
pg_owner_password=''
declarable_secrets=()
before_containers=''
before_networks=''
before_volumes=''

hex32() {
  local raw
  raw="$(od -An -N16 -tx1 /dev/urandom)"
  raw="${raw//[[:space:]]/}"
  [[ "$raw" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf '%s' "$raw"
}

assert_absent_name() {
  local kind="$1" name="$2" existing
  case "$kind" in
    container)
      existing="$(docker ps --all --format '{{.Names}}' --filter "name=^/${name}$" 2>/dev/null)" || return 1
      [[ -z "$existing" ]]
      ;;
    network)
      existing="$(docker network ls --format '{{.Name}}' --filter "name=^${name}$" 2>/dev/null)" || return 1
      [[ -z "$existing" ]]
      ;;
    volume)
      existing="$(docker volume ls --quiet --filter "name=^${name}$" 2>/dev/null)" || return 1
      [[ -z "$existing" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

cleanup() {
  local cleanup_status=0 filter ids id label net vol users remaining
  for filter in "label=fcd-support.health-stdio-test=$scope" "label=fcd-support.operation.parent=$scope"; do
    ids="$(docker ps --all --quiet --no-trunc --filter "$filter" 2>/dev/null)" || {
      cleanup_status=1
      continue
    }
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      [[ "$id" =~ ^[a-f0-9]{64}$ ]] || {
        cleanup_status=1
        continue
      }
      label="$(docker inspect --format '{{or (index .Config.Labels "fcd-support.health-stdio-test") (index .Config.Labels "fcd-support.operation.parent")}}' "$id" 2>/dev/null)" || {
        cleanup_status=1
        continue
      }
      [[ "$label" == "$scope" ]] || {
        cleanup_status=1
        continue
      }
      docker rm --force --volumes "$id" >/dev/null 2>&1 || cleanup_status=1
    done <<<"$ids"
  done

  if net="$(docker network ls --format '{{.Name}}' --filter "name=^${network}$" 2>/dev/null)" && [[ -n "$net" ]]; then
    label="$(docker network inspect --format '{{index .Labels "fcd-support.health-stdio-test"}}' "$network" 2>/dev/null)" || cleanup_status=1
    if [[ "$label" == "$scope" ]]; then
      docker network rm "$network" >/dev/null 2>&1 || cleanup_status=1
    else
      cleanup_status=1
    fi
  fi

  for named_vol in "$backup_volume" "$pg_volume"; do
    if vol="$(docker volume ls --quiet --filter "name=^${named_vol}$" 2>/dev/null)" && [[ -n "$vol" ]]; then
      label="$(docker volume inspect --format '{{.Name}}/{{.Driver}}/{{.Scope}}/{{index .Labels "fcd-support.health-stdio-test"}}' "$named_vol" 2>/dev/null)" || cleanup_status=1
      users="$(docker ps --all --quiet --filter "volume=$named_vol" 2>/dev/null)" || cleanup_status=1
      if [[ "$label" == "$named_vol/local/local/$scope" && -z "$users" ]]; then
        docker volume rm "$named_vol" >/dev/null 2>&1 || cleanup_status=1
      else
        cleanup_status=1
      fi
    fi
  done

  for filter in "label=fcd-support.health-stdio-test=$scope" "label=fcd-support.operation.parent=$scope"; do
    remaining="$(docker ps --all --quiet --no-trunc --filter "$filter" 2>/dev/null)" || cleanup_status=1
    [[ -z "$remaining" ]] || cleanup_status=1
  done
  assert_absent_name network "$network" || cleanup_status=1
  assert_absent_name volume "$backup_volume" || cleanup_status=1
  assert_absent_name volume "$pg_volume" || cleanup_status=1

  if [[ -n "$before_containers" ]]; then
    local now_containers now_networks now_volumes item
    now_containers="$(docker ps --all --quiet --no-trunc | sort)" || cleanup_status=1
    now_networks="$(docker network ls --format '{{.ID}}' | sort)" || cleanup_status=1
    now_volumes="$(docker volume ls --quiet | sort)" || cleanup_status=1
    while IFS= read -r item; do
      [[ -z "$item" || $'\n'"$now_containers"$'\n' == *$'\n'"$item"$'\n'* ]] || cleanup_status=1
    done <<<"$before_containers"
    while IFS= read -r item; do
      [[ -z "$item" || $'\n'"$now_networks"$'\n' == *$'\n'"$item"$'\n'* ]] || cleanup_status=1
    done <<<"$before_networks"
    while IFS= read -r item; do
      [[ -z "$item" || $'\n'"$now_volumes"$'\n' == *$'\n'"$item"$'\n'* ]] || cleanup_status=1
    done <<<"$before_volumes"
  fi

  if [[ -n "$workdir" && -d "$workdir" ]]; then
    rm -rf -- "$workdir" || cleanup_status=1
  fi
  return "$cleanup_status"
}
trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
trap 'result=$?; printf "health_stdio_docker_failed_line=%s status=%s\n" "$LINENO" "$result" >&2' ERR

image_meta="$(docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "$ops_image")"
[[ "$image_meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64$ && "$image_meta" == */"$revision"/linux/amd64 ]]
ops_image_id="${image_meta%%/*}"
[[ "$(docker image inspect --format '{{if .Config.Volumes}}has_volumes{{else}}none{{end}}/{{.Config.User}}' "$ops_image_id")" == none/node ]]

before_containers="$(docker ps --all --quiet --no-trunc | sort)"
before_networks="$(docker network ls --format '{{.ID}}' | sort)"
before_volumes="$(docker volume ls --quiet | sort)"

assert_absent_name container "$pg_container"
assert_absent_name network "$network"
assert_absent_name volume "$backup_volume"
assert_absent_name volume "$pg_volume"
for filter in "label=fcd-support.health-stdio-test=$scope" "label=fcd-support.operation.parent=$scope"; do
  [[ -z "$(docker ps --all --quiet --no-trunc --filter "$filter")" ]]
done

workdir="$(mktemp -d "${TMPDIR:-/tmp}/fcd-health-stdio-docker.XXXXXXXX")"
chmod 0700 "$workdir"
mkdir -p -m 0700 "$workdir/config" "$workdir/secrets" "$workdir/state"

docker network create --internal --label "fcd-support.health-stdio-test=$scope" "$network" >/dev/null
docker volume create --label "fcd-support.health-stdio-test=$scope" "$backup_volume" >/dev/null
docker volume create --label "fcd-support.health-stdio-test=$scope" "$pg_volume" >/dev/null
docker run --rm --pull never --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 \
  --label "fcd-support.health-stdio-test=$scope" \
  --mount "type=volume,src=$backup_volume,dst=/var/lib/fcd-support/backups" \
  --entrypoint sh "$ops_image_id" -c 'chown 1000:1000 /var/lib/fcd-support/backups && chmod 0700 /var/lib/fcd-support/backups' >/dev/null

pg_owner_password="synthetic_pg_owner_$(hex32)"
declarable_secrets+=("$pg_owner_password")

docker run --detach --name "$pg_container" \
  --label "fcd-support.health-stdio-test=$scope" \
  --network "$network" --network-alias postgres \
  --security-opt no-new-privileges --cpus 1 --memory 1g --pids-limit 128 \
  --mount "type=volume,src=$pg_volume,dst=/var/lib/postgresql" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_DB=fcd_support_test \
  --env "POSTGRES_PASSWORD=$pg_owner_password" \
  --health-cmd 'pg_isready -U postgres -d fcd_support_test' \
  --health-interval 1s --health-timeout 2s --health-retries 30 \
  "$postgres_image" >/dev/null

for ((attempt = 0; attempt < 40; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$pg_container")" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$pg_container")" == healthy ]]

system_identifier="$(
  docker exec -e "PGPASSWORD=$pg_owner_password" "$pg_container" \
    psql -U postgres -d fcd_support_test -At -c 'select system_identifier::text from pg_control_system()'
)"
[[ "$system_identifier" =~ ^[1-9][0-9]{0,19}$ ]]

node --input-type=module -e '
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [work, ownerPassword] = process.argv.slice(1);
const roles = [
  "webhook", "admin", "reply", "outbound", "notification", "maintenance",
  "health", "backup", "verify_backup", "checkpoint", "archive_reader", "migrator",
];
const composeRoles = [
  "webhook", "admin", "reply", "outbound", "notification", "maintenance",
  "health", "backup", "verify-backup", "checkpoint", "migrate", "restore",
];
const put = (rel, val) => {
  const full = join(work, rel);
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  writeFileSync(full, val, { mode: 0o600 });
  chmodSync(full, 0o600);
};
const resources = Object.fromEntries(
  composeRoles.map((r) => [r, { cpus: 0.5, memoryMiB: 512, pids: 128, tmpfsMiB: 64 }]),
);
const serialize = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}\n`).join("");
put("config/common.env", serialize({
  MODEL_EXECUTION_ENABLED: "false",
  OUTBOUND_EXECUTION_ENABLED: "false",
  N8N_EXECUTION_ENABLED: "false",
  OPS_POLL_MS: "1000",
  OPS_BATCH_SIZE: "5",
  OPS_LEASE_MS: "60000",
  OPS_MAX_CALL_MS: "20000",
  OPS_SHUTDOWN_GRACE_MS: "5000",
  OPS_STOP_GRACE_MS: "30000",
  OPS_HEALTH_STALE_MS: "60000",
  OPS_HOST_CPUS: "4",
  OPS_HOST_MEMORY_MIB: "8192",
  OPS_RESOURCE_LIMITS_JSON: JSON.stringify(resources),
  OPS_RESOURCE_BOUNDS_JSON: JSON.stringify({
    minimum: { cpus: 0.05, memoryMiB: 32, pids: 16, tmpfsMiB: 1 },
    maximum: { cpus: 2, memoryMiB: 2048, pids: 512, tmpfsMiB: 128 },
  }),
  BACKUP_DAILY_RETENTION: "45",
  BACKUP_MONTHLY_RETENTION: "6",
  BACKUP_CALENDAR: "*-*-* 02:00:00 UTC",
  MAINTENANCE_CALENDAR: "*-*-* *:00/5:00 UTC",
}));
for (const name of ["migrate", "health", "backup", "verify-backup", "checkpoint", "maintenance"]) {
  put(`config/${name}.env`, "# synthetic health stdio docker fixture\n");
}
const secretVal = () => `synthetic_${randomBytes(16).toString("hex")}`;
const passwords = Object.fromEntries(roles.map((r) => [r, secretVal()]));
const uri = (u, p) => `postgresql://${u}:${p}@postgres:5432/fcd_support_test`;
const placeholders = {
  "bootstrap/bootstrap-database": uri("postgres", ownerPassword),
  "migrate/migrate-database": uri("fcd_synthetic_migrator", passwords.migrator),
  "health/health-database": uri("fcd_synthetic_health", passwords.health),
  "backup/backup-database": uri("fcd_synthetic_backup", passwords.backup),
  "backup/backup-recipient": "age1syntheticplaceholder00000000000000000000000000000000000000",
  "backup/recovery-hmac": secretVal(),
  "verify-backup/verify-database": uri("fcd_synthetic_verify_backup", passwords.verify_backup),
  "verify-backup/restore-identity": "AGE-SECRET-KEY-SYNTHETICPLACEHOLDER0000000000000000000000000000",
  "checkpoint/checkpoint-database": uri("fcd_synthetic_checkpoint", passwords.checkpoint),
  "maintenance/maintenance-database": uri("fcd_synthetic_maintenance", passwords.maintenance),
  "maintenance/maintenance-keyring": JSON.stringify({
    activeVersion: "synthetic_v1",
    keys: [{ version: "synthetic_v1", keyBase64url: randomBytes(32).toString("base64url") }],
  }),
};
for (const role of roles) {
  placeholders[`bootstrap/passwords/bootstrap-${role.replaceAll("_", "-")}-password`] = passwords[role];
}
for (const [rel, val] of Object.entries(placeholders)) {
  put(`secrets/${rel}`, val);
}
writeFileSync(join(work, "secrets-list.txt"), [passwords.health, passwords.migrator].join("\n") + "\n", { mode: 0o600 });
' "$workdir" "$pg_owner_password"

while IFS= read -r sec; do
  [[ -z "$sec" ]] || declarable_secrets+=("$sec")
done <"$workdir/secrets-list.txt"

docker run --rm --pull never --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 \
  --label "fcd-support.health-stdio-test=$scope" \
  --mount "type=bind,src=$workdir/secrets,dst=/secrets" \
  --entrypoint sh "$ops_image_id" -c 'find /secrets -type f -exec chown 1000:1000 {} + -exec chmod 0600 {} +' >/dev/null

run_lifecycle_case() {
  local case_name="$1" log_driver="$2" trace_active="$3" drop_attached="$4" input_json="$5" second_attempt="$6"
  local extra_timeout_ms="${7:-}" override_schema_rev="${8:-}" omit_newline="${9:-0}"
  local case_dir="$workdir/cases/$case_name"
  local case_config="$case_dir/config"
  local case_state="$case_dir/state"
  mkdir -p -m 0700 "$case_config" "$case_state"
  cp -a "$workdir/config/." "$case_config/"
  if [[ -n "$extra_timeout_ms" ]]; then
    printf 'OPS_MAX_CALL_MS=%s\n' "$extra_timeout_ms" >"$case_config/health.env"
  fi
  chmod 0600 "$case_config/"*

  sed -n "/<<'TRACE'$/,/^TRACE$/{ /<<'TRACE'$/d; /^TRACE$/d; p; }" "$root/scripts/test-synthetic-runtime-deployment.sh" >"$case_state/trace-entry.bash"
  if [[ "$trace_active" == 1 ]]; then
    export FCD_RUNTIME_HOST_DIAGNOSTICS=closed-v1
  else
    export FCD_RUNTIME_HOST_DIAGNOSTICS=''
  fi
  export FCD_SYNTHETIC_TRACE="$case_state/trace3"
  export FCD_SYNTHETIC_EVIDENCE_LIBRARY="$root/scripts/synthetic-host-evidence.sh"
  export OPS_HEALTH_INPUT_JSON="$input_json"

  local rc=0
  (
    set -Eeuo pipefail
    source "$root/scripts/operations-common.sh"
    source "$root/scripts/operations-job-lifecycle.sh"

    operations_config_field() { return 0; }
    operations_job_state_root() { OPS_JOB_STATE_FILE="$case_state/active-job"; }
    operations_job_state_begin() {
      printf 'JOB_REF=%s\nJOB_SERVICE=%s\nJOB_PHASE=intent\nJOB_CONTAINER=pending\n' "$1" "$2" >"$case_state/active-job"
    }
    operations_job_state_sync() { return 0; }
    operations_job_state_transition() {
      printf 'JOB_REF=%s\nJOB_PHASE=%s\nJOB_CONTAINER=%s\n' "$1" "$2" "$3" >"$case_state/active-job"
    }
    operations_job_state_read() { declare -gA OPS_JOB_STATE=([JOB_CONTAINER]="$OPS_JOB_CONTAINER"); }
    operations_job_state_clear() { rm -f "$case_state/active-job"; }

    stat() {
      if [[ "${1:-}" == -c && "${2:-}" == '%u:%g:%a:%h' && "${3:-}" == -- && "${4:-}" == "$case_state/"* ]]; then
        local actual expected_uid expected_gid
        actual="$(command stat -c '%u:%g:%a:%h' -- "$4")" || return 1
        expected_uid="$(id -u)"
        expected_gid="$(id -g)"
        if [[ "$actual" == "$expected_uid:$expected_gid:"* ]]; then
          printf '1000:1000:%s\n' "${actual#"$expected_uid:$expected_gid:"}"
          return 0
        fi
        printf '%s\n' "$actual"
        return 0
      fi
      command stat "$@"
    }

    eval "$(declare -f operations_job_override | sed '1s/operations_job_override/operations_job_override_real/')"
    operations_job_override() {
      local raw
      raw="$(operations_job_override_real)" || return 1
      node -e '
        const raw = process.argv[1];
        const service = process.argv[2];
        const driver = process.argv[3];
        const revOverride = process.argv[4];
        const obj = JSON.parse(raw);
        if (service === "health" && driver === "none") {
          obj.services.health.logging = { driver: "none" };
        }
        if (revOverride) {
          obj.services[service].environment.OPS_SCHEMA_REVISION = revOverride;
        }
        process.stdout.write(JSON.stringify(obj) + "\n");
      ' "$raw" "$OPS_JOB_SERVICE" "$log_driver" "$override_schema_rev"
    }

    eval "$(declare -f operations_docker | sed '1s/operations_docker/operations_docker_real/')"
    operations_docker() {
      printf '%s\n' "$*" >>"$case_state/docker.calls"
      if [[ "${1:-}" == container && "${2:-}" == start && "${3:-}" == --attach ]]; then
        local actual_driver
        actual_driver="$(command docker container inspect --format '{{.HostConfig.LogConfig.Type}}' "${@: -1}")" || return 1
        printf '%s\n' "$actual_driver" >"$case_state/log-driver"
        if [[ "$drop_attached" == 1 ]]; then
          operations_docker_real "$@" >/dev/null
          return $?
        fi
      fi
      operations_docker_real "$@"
    }

    if [[ "$omit_newline" == 1 ]]; then
      operations_job_health_exchange() {
        local health_read='' health_write='' health_pid health_status=0
        coproc OPS_HEALTH_PIPE { operations_docker container start --attach --interactive "$OPS_JOB_CONTAINER"; }
        health_pid="${OPS_HEALTH_PIPE_PID:-}"
        exec {health_read}<&"${OPS_HEALTH_PIPE[0]}" {health_write}>&"${OPS_HEALTH_PIPE[1]}"
        exec {OPS_HEALTH_PIPE[0]}<&- {OPS_HEALTH_PIPE[1]}>&-
        printf '%s' "$OPS_HEALTH_INPUT_JSON" >&"$health_write"
        cat <&"$health_read" || health_status=1
        exec {health_write}>&- {health_read}<&-
        wait "$health_pid" || health_status=$?
        return "$health_status"
      }
    fi

    OPS_ROOT="$root"
    declare -A OPS_CONFIG=(
      [FCD_SUPPORT_REVISION]="$revision"
      [FCD_RUNTIME_PROJECT]="$scope"
      [FCD_CONFIG_ROOT]="$case_config"
      [FCD_SECRET_ROOT]="$workdir/secrets"
      [FCD_STATE_ROOT]="$case_state"
      [FCD_BACKUP_VOLUME]="$backup_volume"
      [FCD_OPERATIONS_IMAGE]="$ops_image_id"
      [FCD_COMMAND_TIMEOUT_SECONDS]=30
      [FCD_STOP_GRACE_MS]=1000
      [FCD_POSTGRES_DB]=fcd_support_test
      [FCD_DATABASE_SCHEMA]=public
      [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic
      [FCD_SCHEMA_REVISION]="$schema_revision"
      [FCD_HEALTH_INTERVAL_MS]=2000
      [FCD_HEALTH_TIMEOUT_MS]=1000
      [FCD_HEALTH_RETRIES]=10
      [FCD_HEALTH_START_MS]=1000
      [FCD_MIGRATE_CPUS]=0.5
      [FCD_MIGRATE_MEMORY_MIB]=512
      [FCD_MIGRATE_PIDS]=128
      [FCD_MIGRATE_TMPFS_MIB]=64
      [FCD_BACKUP_CPUS]=0.5
      [FCD_BACKUP_MEMORY_MIB]=512
      [FCD_BACKUP_PIDS]=128
      [FCD_BACKUP_TMPFS_MIB]=64
      [FCD_VERIFY_BACKUP_CPUS]=0.5
      [FCD_VERIFY_BACKUP_MEMORY_MIB]=512
      [FCD_VERIFY_BACKUP_PIDS]=128
      [FCD_VERIFY_BACKUP_TMPFS_MIB]=64
      [FCD_CHECKPOINT_CPUS]=0.5
      [FCD_CHECKPOINT_MEMORY_MIB]=512
      [FCD_CHECKPOINT_PIDS]=128
      [FCD_CHECKPOINT_TMPFS_MIB]=64
      [FCD_HEALTH_CPUS]=0.5
      [FCD_HEALTH_MEMORY_MIB]=512
      [FCD_HEALTH_PIDS]=128
      [FCD_HEALTH_TMPFS_MIB]=64
      [FCD_MAINTENANCE_CPUS]=0.5
      [FCD_MAINTENANCE_MEMORY_MIB]=512
      [FCD_MAINTENANCE_PIDS]=128
      [FCD_MAINTENANCE_TMPFS_MIB]=64
    )
    OPS_DATABASE_SYSTEM_IDENTIFIER="$system_identifier"
    export OPS_HEALTH_INPUT_JSON
    exec 3>"$case_state/trace3" 4>"$case_state/out4"
    source "$case_state/trace-entry.bash"
    if ack="$(operations_execute_job "${@}")"; then
      printf '%s\n' "$ack" >"$case_state/ack"
      printf 'synthetic_schedule=successor\n' >&4
      exit 0
    else
      rc_sub=$?
      if [[ "$second_attempt" == 1 ]]; then
        : >"$case_state/docker.retry.calls"
        mv "$case_state/docker.calls" "$case_state/docker.first.calls"
        : >"$case_state/docker.calls"
        if ( operations_execute_job "${@}" ) 2>"$case_state/retry_stderr"; then
          retry_rc=0
        else
          retry_rc=$?
        fi
        printf '%s\n' "$retry_rc" >"$case_state/retry_exit"
        mv "$case_state/docker.calls" "$case_state/docker.retry.calls"
        mv "$case_state/docker.first.calls" "$case_state/docker.calls"
      fi
      exit "$rc_sub"
    fi
  ) >"$case_state/stdout" 2>"$case_state/stderr" || rc=$?
  printf '%s\n' "$rc" >"$case_state/exit"
}

run_direct_job() {
  local name="$1"; shift
  local dir="$workdir/direct-$name"
  mkdir -p -m 0700 "$dir/config" "$dir/state"
  cp -a "$workdir/config/." "$dir/config/"
  chmod 0600 "$dir/config/"*
  (
    set -Eeuo pipefail
    source "$root/scripts/operations-common.sh"
    source "$root/scripts/operations-job-lifecycle.sh"
    operations_config_field() { return 0; }
    operations_job_state_root() { OPS_JOB_STATE_FILE="$dir/state/active-job"; }
    operations_job_state_begin() { : >"$dir/state/active-job"; }
    operations_job_state_sync() { return 0; }
    operations_job_state_transition() { :; }
    operations_job_state_read() { declare -gA OPS_JOB_STATE=([JOB_CONTAINER]="$OPS_JOB_CONTAINER"); }
    operations_job_state_clear() { rm -f "$dir/state/active-job"; }
    stat() {
      if [[ "${1:-}" == -c && "${2:-}" == '%u:%g:%a:%h' && "${3:-}" == -- && "${4:-}" == "$dir/state/"* ]]; then
        local actual expected_uid expected_gid
        actual="$(command stat -c '%u:%g:%a:%h' -- "$4")" || return 1
        expected_uid="$(id -u)"
        expected_gid="$(id -g)"
        if [[ "$actual" == "$expected_uid:$expected_gid:"* ]]; then
          printf '1000:1000:%s\n' "${actual#"$expected_uid:$expected_gid:"}"
          return 0
        fi
        printf '%s\n' "$actual"
        return 0
      fi
      command stat "$@"
    }
    OPS_ROOT="$root"
    declare -A OPS_CONFIG=(
      [FCD_SUPPORT_REVISION]="$revision"
      [FCD_RUNTIME_PROJECT]="$scope"
      [FCD_CONFIG_ROOT]="$dir/config"
      [FCD_SECRET_ROOT]="$workdir/secrets"
      [FCD_STATE_ROOT]="$dir/state"
      [FCD_BACKUP_VOLUME]="$backup_volume"
      [FCD_OPERATIONS_IMAGE]="$ops_image_id"
      [FCD_COMMAND_TIMEOUT_SECONDS]=30
      [FCD_STOP_GRACE_MS]=1000
      [FCD_POSTGRES_DB]=fcd_support_test
      [FCD_DATABASE_SCHEMA]=public
      [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic
      [FCD_SCHEMA_REVISION]="$schema_revision"
      [FCD_HEALTH_INTERVAL_MS]=2000
      [FCD_HEALTH_TIMEOUT_MS]=1000
      [FCD_HEALTH_RETRIES]=10
      [FCD_HEALTH_START_MS]=1000
      [FCD_MIGRATE_CPUS]=0.5
      [FCD_MIGRATE_MEMORY_MIB]=512
      [FCD_MIGRATE_PIDS]=128
      [FCD_MIGRATE_TMPFS_MIB]=64
      [FCD_BACKUP_CPUS]=0.5
      [FCD_BACKUP_MEMORY_MIB]=512
      [FCD_BACKUP_PIDS]=128
      [FCD_BACKUP_TMPFS_MIB]=64
      [FCD_VERIFY_BACKUP_CPUS]=0.5
      [FCD_VERIFY_BACKUP_MEMORY_MIB]=512
      [FCD_VERIFY_BACKUP_PIDS]=128
      [FCD_VERIFY_BACKUP_TMPFS_MIB]=64
      [FCD_CHECKPOINT_CPUS]=0.5
      [FCD_CHECKPOINT_MEMORY_MIB]=512
      [FCD_CHECKPOINT_PIDS]=128
      [FCD_CHECKPOINT_TMPFS_MIB]=64
      [FCD_HEALTH_CPUS]=0.5
      [FCD_HEALTH_MEMORY_MIB]=512
      [FCD_HEALTH_PIDS]=128
      [FCD_HEALTH_TMPFS_MIB]=64
      [FCD_MAINTENANCE_CPUS]=0.5
      [FCD_MAINTENANCE_MEMORY_MIB]=512
      [FCD_MAINTENANCE_PIDS]=128
      [FCD_MAINTENANCE_TMPFS_MIB]=64
    )
    OPS_DATABASE_SYSTEM_IDENTIFIER="$system_identifier"
    operations_execute_job "$@"
  ) >"$dir/ack"
  [[ "$(cat "$dir/ack")" == '{"status":"completed","processed":1,"reasonCode":"ok"}' ]]
}

pg_count() {
  docker exec -e "PGPASSWORD=$pg_owner_password" "$pg_container" \
    psql -U postgres -d fcd_support_test -At -c "$1"
}

assert_no_secrets_in_case() {
  local case_state="$1" file sec
  for file in "$case_state/ack" "$case_state/out4" "$case_state/trace3" "$case_state/stdout" "$case_state/stderr" "$case_state/retry_stderr"; do
    [[ -f "$file" ]] || continue
    for sec in "${declarable_secrets[@]}" "$host_secret_marker"; do
      if grep -Fq -- "$sec" "$file"; then
        echo health_stdio_secret_leak >&2
        exit 1
      fi
    done
  done
}

# Bootstrap prepare -> migrate -> converge using the real compose.operations.yml services.
run_direct_job prepare bootstrap prepare "$system_identifier" /run/secrets
run_direct_job migrate migrate migrate
run_direct_job converge bootstrap converge "$system_identifier" /run/secrets

valid_input="$(
  node -e '
    process.stdout.write(JSON.stringify({
      hostSnapshot: {
        checkedAt: new Date().toISOString(),
        services: [{ component: "webhook", running: true, health: "healthy", gitRevision: process.argv[1] }],
        adminSocket: "healthy",
        manifestAttestation: "not_verified",
        publicRouteCheck: { state: "not_verified" },
      },
      availability: { manifest: "healthy", n8n: "unavailable" },
    }));
  ' "$revision"
)"

# 1 & 2: Paired json-file vs --log-driver=none with active TRACE.
before_rows="$(pg_count 'select count(*) from operations_health_checks')"
run_lifecycle_case json-file json-file 1 0 "$valid_input" 0 '' '' 0 health health
[[ "$(cat "$workdir/cases/json-file/state/exit")" == 0 ]]
[[ "$(cat "$workdir/cases/json-file/state/log-driver")" == json-file ]]
[[ "$(cat "$workdir/cases/json-file/state/ack")" == '{"status":"completed","processed":11,"reasonCode":"ok"}' ]]
[[ "$(cat "$workdir/cases/json-file/state/out4")" == 'synthetic_schedule=successor' ]]
[[ ! -e "$workdir/cases/json-file/state/active-job" ]]
! grep -q 'container logs' "$workdir/cases/json-file/state/docker.calls"
grep -qx 'synthetic_health_ack_diagnostic=completed' "$workdir/cases/json-file/state/trace3"
assert_no_secrets_in_case "$workdir/cases/json-file/state"
after_rows="$(pg_count 'select count(*) from operations_health_checks')"
[[ $((after_rows - before_rows)) == 11 ]]
[[ "$(pg_count "select state || '/' || reason_code from operations_health_checks where component='webhook' order by id desc limit 1")" == healthy/ok ]]

run_lifecycle_case driver-none none 1 0 "$valid_input" 0 '' '' 0 health health
[[ "$(cat "$workdir/cases/driver-none/state/exit")" == 0 ]]
[[ "$(cat "$workdir/cases/driver-none/state/log-driver")" == none ]]
[[ "$(cat "$workdir/cases/driver-none/state/ack")" == '{"status":"completed","processed":11,"reasonCode":"ok"}' ]]
[[ "$(cat "$workdir/cases/driver-none/state/out4")" == 'synthetic_schedule=successor' ]]
[[ ! -e "$workdir/cases/driver-none/state/active-job" ]]
! grep -q 'container logs' "$workdir/cases/driver-none/state/docker.calls"
grep -qx 'synthetic_health_ack_diagnostic=completed' "$workdir/cases/driver-none/state/trace3"
assert_no_secrets_in_case "$workdir/cases/driver-none/state"
after_none_rows="$(pg_count 'select count(*) from operations_health_checks')"
[[ $((after_none_rows - after_rows)) == 11 ]]

# 3: TRACE inactive vs active parity on --log-driver=none.
run_lifecycle_case trace-inactive none 0 0 "$valid_input" 0 '' '' 0 health health
[[ "$(cat "$workdir/cases/trace-inactive/state/exit")" == 0 ]]
[[ "$(cat "$workdir/cases/trace-inactive/state/ack")" == "$(cat "$workdir/cases/driver-none/state/ack")" ]]
[[ "$(cat "$workdir/cases/trace-inactive/state/out4")" == "$(cat "$workdir/cases/driver-none/state/out4")" ]]
! grep -q 'synthetic_health_' "$workdir/cases/trace-inactive/state/trace3"
assert_no_secrets_in_case "$workdir/cases/trace-inactive/state"

# 4: Narrow test-port fault (dropped attached stdout) on json-file and none.
run_lifecycle_case drop-json-file json-file 1 1 "$valid_input" 1 '' '' 0 health health
[[ "$(cat "$workdir/cases/drop-json-file/state/exit")" == 1 ]]
[[ ! -s "$workdir/cases/drop-json-file/state/ack" && ! -s "$workdir/cases/drop-json-file/state/out4" ]]
grep -qx 'JOB_PHASE=uncertain' "$workdir/cases/drop-json-file/state/active-job"
grep -qx 'synthetic_health_ack_diagnostic=empty' "$workdir/cases/drop-json-file/state/trace3"
grep -qx 'synthetic_health_daemon_diagnostic=completed' "$workdir/cases/drop-json-file/state/trace3"
[[ "$(cat "$workdir/cases/drop-json-file/state/retry_exit")" == 1 ]]
grep -q 'operations_job_pending' "$workdir/cases/drop-json-file/state/retry_stderr"
[[ ! -s "$workdir/cases/drop-json-file/state/docker.retry.calls" ]]
assert_no_secrets_in_case "$workdir/cases/drop-json-file/state"

run_lifecycle_case drop-none none 1 1 "$valid_input" 1 '' '' 0 health health
[[ "$(cat "$workdir/cases/drop-none/state/exit")" == 1 ]]
[[ "$(cat "$workdir/cases/drop-none/state/log-driver")" == none ]]
grep -qx 'JOB_PHASE=uncertain' "$workdir/cases/drop-none/state/active-job"
grep -qx 'synthetic_health_ack_diagnostic=empty' "$workdir/cases/drop-none/state/trace3"
grep -qx 'synthetic_health_daemon_diagnostic=unobserved' "$workdir/cases/drop-none/state/trace3"
[[ "$(cat "$workdir/cases/drop-none/state/retry_exit")" == 1 ]]
grep -q 'operations_job_pending' "$workdir/cases/drop-none/state/retry_stderr"
[[ ! -s "$workdir/cases/drop-none/state/docker.retry.calls" ]]
assert_no_secrets_in_case "$workdir/cases/drop-none/state"

# 5: Real container fault controls (malformed, oversized, stalled, nonzero-config).
oversized_input="$(node -e 'process.stdout.write(JSON.stringify({ x: "y".repeat(16376) }))')"
[[ ${#oversized_input} == 16384 ]]

baseline_rows="$(pg_count 'select count(*) from operations_health_checks')"
run_lifecycle_case fault-malformed none 1 0 "{\"hostSnapshot\":\"$host_secret_marker\"" 1 200 '' 0 health health
run_lifecycle_case fault-oversized none 1 0 "$oversized_input" 1 '' '' 0 health health
run_lifecycle_case fault-stalled none 1 0 '{}' 1 200 '' 1 health health
run_lifecycle_case fault-nonzero none 1 0 '{}' 1 '' 'bad_rev' 0 health health

for fault in fault-malformed fault-oversized fault-stalled fault-nonzero; do
  [[ "$(cat "$workdir/cases/$fault/state/exit")" == 1 ]]
  [[ ! -s "$workdir/cases/$fault/state/ack" && ! -s "$workdir/cases/$fault/state/out4" ]]
  grep -qx 'JOB_PHASE=uncertain' "$workdir/cases/$fault/state/active-job"
  [[ "$(cat "$workdir/cases/$fault/state/retry_exit")" == 1 ]]
  grep -q 'operations_job_pending' "$workdir/cases/$fault/state/retry_stderr"
  [[ ! -s "$workdir/cases/$fault/state/docker.retry.calls" ]]
  assert_no_secrets_in_case "$workdir/cases/$fault/state"
done

after_fault_rows="$(pg_count 'select count(*) from operations_health_checks')"
[[ "$after_fault_rows" == "$baseline_rows" ]]
[[ "$(pg_count 'select count(*) from outbound_intents')" == 0 ]]

for filter in "label=fcd-support.health-stdio-test=$scope" "label=fcd-support.operation.parent=$scope"; do
  [[ -z "$(docker ps --all --quiet --no-trunc --filter "$filter" --filter "label=fcd-support.operation.service=health")" ]]
done

printf '%s\n' \
  health_stdio_docker_bootstrap_converge=true \
  health_stdio_docker_log_driver_parity=true \
  health_stdio_docker_trace_parity=true \
  health_stdio_docker_fault_uncertainty=true
