#!/usr/bin/env bash
# Real Docker + PostgreSQL + compose.operations.yml proof of the built health
# stdio contract, log-driver parity, TRACE safety, and durable journal/flock refusal.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1

init_defaults() {
  ops_image="${ops_image:-}"
  revision="${revision:-}"
  root="${root:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
  scope="${scope:-fcd-support-health-stdio-$$-$RANDOM}"
  network="${network:-$scope-operations-data}"
  backup_volume="${backup_volume:-$scope-backups}"
  pg_volume="${pg_volume:-$scope-postgres}"
  pg_container="${pg_container:-$scope-postgres}"
  postgres_image="${postgres_image:-postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636}"
  schema_revision="${schema_revision:-000016}"
  host_secret_marker="${host_secret_marker:-synthetic_docker_host_marker_do_not_echo}"
  precreation_passed="${precreation_passed:-0}"
  workdir="${workdir:-}"
  home_scope="${home_scope:-}"
  created_home_scope="${created_home_scope:-}"
  state_base="${state_base:-}"
  ops_root="${ops_root:-$root}"
  use_ci_operator="${use_ci_operator:-0}"
  task_operator="${task_operator:-}"
  pg_owner_password="${pg_owner_password:-}"
  system_identifier="${system_identifier:-}"
  ops_image_id="${ops_image_id:-}"
  created_network_id="${created_network_id:-}"
  created_backup_volume="${created_backup_volume:-}"
  created_pg_volume="${created_pg_volume:-}"
  if ! declare -p created_containers >/dev/null 2>&1; then created_containers=(); fi
  if ! declare -p declarable_secrets >/dev/null 2>&1; then declarable_secrets=(); fi
  before_containers="${before_containers:-}"
  before_networks="${before_networks:-}"
  before_volumes="${before_volumes:-}"
}

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

assert_clean_start() {
  local filter existing_items
  assert_absent_name container "$pg_container" || {
    echo health_stdio_docker_collision_detected >&2
    return 1
  }
  assert_absent_name network "$network" || {
    echo health_stdio_docker_collision_detected >&2
    return 1
  }
  assert_absent_name volume "$backup_volume" || {
    echo health_stdio_docker_collision_detected >&2
    return 1
  }
  assert_absent_name volume "$pg_volume" || {
    echo health_stdio_docker_collision_detected >&2
    return 1
  }
  for filter in "label=fcd-support.health-stdio-test=$scope" "label=fcd-support.operation.parent=$scope"; do
    existing_items="$(docker ps --all --quiet --no-trunc --filter "$filter" 2>/dev/null)" || {
      echo health_stdio_docker_collision_detected >&2
      return 1
    }
    [[ -z "$existing_items" ]] || {
      echo health_stdio_docker_collision_detected >&2
      return 1
    }
    existing_items="$(docker network ls --quiet --filter "$filter" 2>/dev/null)" || {
      echo health_stdio_docker_collision_detected >&2
      return 1
    }
    [[ -z "$existing_items" ]] || {
      echo health_stdio_docker_collision_detected >&2
      return 1
    }
    existing_items="$(docker volume ls --quiet --filter "$filter" 2>/dev/null)" || {
      echo health_stdio_docker_collision_detected >&2
      return 1
    }
    [[ -z "$existing_items" ]] || {
      echo health_stdio_docker_collision_detected >&2
      return 1
    }
  done
  if [[ -n "${home_scope:-}" ]]; then
    if [[ "${use_ci_operator:-0}" == 1 ]]; then
      if sudo -n test -e "$home_scope" || sudo -n test -L "$home_scope"; then
        echo health_stdio_docker_collision_detected >&2
        return 1
      fi
    elif [[ -e "$home_scope" || -L "$home_scope" ]]; then
      echo health_stdio_docker_collision_detected >&2
      return 1
    fi
  fi
}

verify_and_remove_container() {
  local id="$1" expected_kind="${2:-fixture}" meta expected_name
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  meta="$(docker container inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "fcd-support.health-stdio-test"}}|{{index .Config.Labels "fcd-support.operation.parent"}}|{{index .Config.Labels "fcd-support.operation.ref"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Image}}' "$id" 2>/dev/null)" || return 1
  if [[ "$expected_kind" == operation ]]; then
    local actual_id actual_name label_test label_parent label_ref label_rev actual_image
    IFS='|' read -r actual_id actual_name label_test label_parent label_ref label_rev actual_image <<<"$meta"
    [[ "$actual_id" == "$id" && "$label_parent" == "$scope" && "$label_ref" =~ ^operation_[a-f0-9]{32}$ && "$label_rev" == "$revision" && "$actual_image" == "$ops_image_id" ]] || return 1
  else
    expected_name="${3:-}"
    local actual_id actual_name label_test rest
    IFS='|' read -r actual_id actual_name label_test rest <<<"$meta"
    [[ "$actual_id" == "$id" && "$label_test" == "$scope" ]] || return 1
    if [[ -n "$expected_name" ]]; then
      [[ "$actual_name" == "/$expected_name" ]] || return 1
    fi
  fi
  docker rm --force --volumes "$id" >/dev/null 2>&1 || return 1
}

cleanup() {
  local cleanup_status=0 id remaining vol vol_meta net_meta users op_ids op_id
  if [[ "${precreation_passed:-0}" != 1 ]]; then
    if [[ -n "${workdir:-}" && -d "$workdir" ]]; then
      rm -rf -- "$workdir" || cleanup_status=1
    fi
    return "$cleanup_status"
  fi

  for id in "${created_containers[@]:-}"; do
    [[ -n "$id" ]] || continue
    if docker container inspect --format '{{.Id}}' "$id" >/dev/null 2>&1; then
      verify_and_remove_container "$id" fixture || cleanup_status=1
    fi
  done

  if op_ids="$(docker ps --all --quiet --no-trunc --filter "label=fcd-support.operation.parent=$scope" 2>/dev/null)"; then
    while IFS= read -r op_id; do
      [[ -n "$op_id" ]] || continue
      verify_and_remove_container "$op_id" operation || cleanup_status=1
    done <<<"$op_ids"
  else
    cleanup_status=1
  fi

  if [[ -n "${created_network_id:-}" ]]; then
    if net_meta="$(docker network inspect --format '{{.Id}}|{{.Name}}|{{index .Labels "fcd-support.health-stdio-test"}}' "$created_network_id" 2>/dev/null)"; then
      if [[ "$net_meta" == "$created_network_id|$network|$scope" ]]; then
        docker network rm "$created_network_id" >/dev/null 2>&1 || cleanup_status=1
      else
        cleanup_status=1
      fi
    elif docker network inspect --format '{{.Id}}' "$network" >/dev/null 2>&1; then
      cleanup_status=1
    fi
  fi

  for vol in "${created_backup_volume:-}" "${created_pg_volume:-}"; do
    [[ -n "$vol" ]] || continue
    if vol_meta="$(docker volume inspect --format '{{.Name}}|{{.Driver}}|{{.Scope}}|{{index .Labels "fcd-support.health-stdio-test"}}' "$vol" 2>/dev/null)"; then
      users="$(docker ps --all --quiet --filter "volume=$vol" 2>/dev/null)" || cleanup_status=1
      if [[ "$vol_meta" == "$vol|local|local|$scope" && -z "$users" ]]; then
        docker volume rm "$vol" >/dev/null 2>&1 || cleanup_status=1
      else
        cleanup_status=1
      fi
    fi
  done

  local filter
  for filter in "label=fcd-support.health-stdio-test=$scope" "label=fcd-support.operation.parent=$scope"; do
    remaining="$(docker ps --all --quiet --no-trunc --filter "$filter" 2>/dev/null)" || cleanup_status=1
    [[ -z "$remaining" ]] || cleanup_status=1
    remaining="$(docker network ls --quiet --filter "$filter" 2>/dev/null)" || cleanup_status=1
    [[ -z "$remaining" ]] || cleanup_status=1
    remaining="$(docker volume ls --quiet --filter "$filter" 2>/dev/null)" || cleanup_status=1
    [[ -z "$remaining" ]] || cleanup_status=1
  done
  assert_absent_name container "$pg_container" || cleanup_status=1
  assert_absent_name network "$network" || cleanup_status=1
  assert_absent_name volume "$backup_volume" || cleanup_status=1
  assert_absent_name volume "$pg_volume" || cleanup_status=1

  if [[ -n "${before_containers:-}" ]]; then
    local now_containers item
    now_containers="$(docker ps --all --quiet --no-trunc | sort)" || cleanup_status=1
    while IFS= read -r item; do
      [[ -z "$item" || $'\n'"$now_containers"$'\n' == *$'\n'"$item"$'\n'* ]] || cleanup_status=1
    done <<<"$before_containers"
  fi
  if [[ -n "${before_networks:-}" ]]; then
    local now_networks item
    now_networks="$(docker network ls --format '{{.ID}}' | sort)" || cleanup_status=1
    while IFS= read -r item; do
      [[ -z "$item" || $'\n'"$now_networks"$'\n' == *$'\n'"$item"$'\n'* ]] || cleanup_status=1
    done <<<"$before_networks"
  fi
  if [[ -n "${before_volumes:-}" ]]; then
    local now_volumes item
    now_volumes="$(docker volume ls --quiet | sort)" || cleanup_status=1
    while IFS= read -r item; do
      [[ -z "$item" || $'\n'"$now_volumes"$'\n' == *$'\n'"$item"$'\n'* ]] || cleanup_status=1
    done <<<"$before_volumes"
  fi

  if [[ -n "${workdir:-}" && -d "$workdir" ]]; then
    rm -rf -- "$workdir" || cleanup_status=1
  fi
  if [[ -n "${created_home_scope:-}" ]]; then
    if [[ "${use_ci_operator:-0}" == 1 ]]; then
      sudo -n rm -rf -- "$created_home_scope" || cleanup_status=1
    elif [[ -d "$created_home_scope" ]]; then
      rm -rf -- "$created_home_scope" || cleanup_status=1
    fi
  fi
  return "$cleanup_status"
}

run_as_operator() {
  if [[ "${use_ci_operator:-0}" == 1 ]]; then
    sudo -n --set-home --user "$task_operator" --group '#1000' "$@"
  else
    "$@"
  fi
}

read_state_file() {
  local file="$1"
  if [[ "${use_ci_operator:-0}" == 1 ]]; then
    sudo -n --user "$task_operator" --group '#1000' cat -- "$file" 2>/dev/null || true
  else
    [[ -f "$file" ]] || return 0
    cat -- "$file" 2>/dev/null || true
  fi
}

publish_allowed_stderr_lines() {
  local line filtered=0
  while IFS= read -r line; do
    case "$line" in
      operations_arguments_invalid|operations_revision_invalid|operations_config_invalid|operations_lock_conflict|operations_job_pending|operations_job_uncertain|operations_job_arguments_invalid|operations_image_invalid|operations_job_state_invalid|operations_docker_failed|health_stdio_docker_secret_leak|health_stdio_docker_native_uid1000_required|health_stdio_docker_collision_detected)
        printf '  err=%s\n' "$line" >&2
        ;;
      '') ;;
      *) ((filtered += 1)) || true ;;
    esac
  done
  if (( filtered > 0 )); then
    printf '  err_filtered_count=%s\n' "$filtered" >&2
  fi
}

publish_allowed_docker_calls() {
  local line
  while IFS= read -r line; do
    case "$line" in
      'image inspect '*) printf '  docker=image inspect\n' >&2 ;;
      'ps '*) printf '  docker=ps\n' >&2 ;;
      'compose '*) printf '  docker=compose create\n' >&2 ;;
      'container inspect '*) printf '  docker=container inspect\n' >&2 ;;
      'container start --attach --interactive '*) printf '  docker=container start_attach\n' >&2 ;;
      'container start '*) printf '  docker=container start\n' >&2 ;;
      'container wait '*) printf '  docker=container wait\n' >&2 ;;
      'container logs '*) printf '  docker=container logs\n' >&2 ;;
      'container stop '*) printf '  docker=container stop\n' >&2 ;;
      'container rm '*) printf '  docker=container rm\n' >&2 ;;
      *) ;;
    esac
  done
}

publish_allowed_trace_lines() {
  local line
  while IFS= read -r line; do
    case "$line" in
      synthetic_health_ack_diagnostic=completed|synthetic_health_ack_diagnostic=empty|synthetic_health_ack_diagnostic=dependency_unavailable|synthetic_health_ack_diagnostic=rejected|\
      synthetic_health_attach_diagnostic=ok|synthetic_health_attach_diagnostic=empty|synthetic_health_attach_diagnostic=nonzero|\
      synthetic_health_daemon_diagnostic=completed|synthetic_health_daemon_diagnostic=unobserved|synthetic_health_daemon_diagnostic=unavailable)
        printf '  trace=%s\n' "$line" >&2
        ;;
      *)
        if [[ "$line" =~ ^(operations-[a-z-]{1,32}\.sh:[0-9]{1,5}:previous=[1-9][0-9]{0,2})$ ]]; then
          printf '  trace=%s\n' "$line" >&2
        fi
        ;;
    esac
  done
}

report_failure_state() {
  local scan_root="${state_base:-${workdir:-}}" dir rel exit_val log_val
  local -a dirs=()
  [[ -n "$scan_root" ]] || return 0
  if [[ "${use_ci_operator:-0}" == 1 ]]; then
    while IFS= read -r dir; do
      [[ -n "$dir" ]] || continue
      dirs+=("$dir")
    done < <(sudo -n --user "$task_operator" --group '#1000' bash -c 'shopt -s nullglob; for d in "$1"/direct-*/state "$1"/cases/*/state; do [[ -d "$d" ]] && printf "%s\n" "$d"; done' bash "$scan_root" 2>/dev/null || true)
  else
    [[ -d "$scan_root" ]] || return 0
    local d
    for d in "$scan_root"/direct-*/state "$scan_root"/cases/*/state; do
      [[ -d "$d" ]] || continue
      dirs+=("$d")
    done
  fi

  for dir in "${dirs[@]:-}"; do
    [[ -n "$dir" ]] || continue
    rel="${dir#"$scan_root"/}"
    printf 'health_stdio_case_state=%s\n' "$rel" >&2

    exit_val="$(read_state_file "$dir/exit" | head -n 1)"
    if [[ "$exit_val" =~ ^[0-9]{1,3}$ ]] && (( 10#$exit_val <= 255 )); then
      printf '  exit=%s\n' "$exit_val" >&2
    fi

    log_val="$(read_state_file "$dir/log-driver" | head -n 1)"
    case "$log_val" in
      json-file|none) printf '  log_driver=%s\n' "$log_val" >&2 ;;
    esac

    local aj_line
    while IFS= read -r aj_line; do
      case "$aj_line" in
        JOB_SERVICE=bootstrap|JOB_SERVICE=migrate|JOB_SERVICE=health|\
        JOB_PHASE=intent|JOB_PHASE=created|JOB_PHASE=started|JOB_PHASE=completed|JOB_PHASE=cancelled|JOB_PHASE=uncertain|JOB_PHASE=resolved)
          printf '  %s\n' "$aj_line" >&2
          ;;
      esac
    done <<<"$(read_state_file "$dir/active-job")"

    read_state_file "$dir/stderr" | publish_allowed_stderr_lines
    read_state_file "$dir/docker.calls" | head -n 20 | publish_allowed_docker_calls
    read_state_file "$dir/trace3" | tail -n 20 | publish_allowed_trace_lines
  done
}

register_traps() {
  trap 'result=$?; cleanup || result=1; exit "$result"' EXIT
  trap 'result=$?; printf "health_stdio_docker_failed_line=%s status=%s\n" "$LINENO" "$result" >&2; report_failure_state' ERR
}

verify_created_container() {
  local cid="$1" expected_name="${2:-}" expected_image="$3" meta actual_id actual_name label_test actual_image
  [[ "$cid" =~ ^[a-f0-9]{64}$ ]] || return 1
  meta="$(docker container inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "fcd-support.health-stdio-test"}}|{{.Image}}' "$cid")" || return 1
  IFS='|' read -r actual_id actual_name label_test actual_image <<<"$meta"
  [[ "$actual_id" == "$cid" && "$label_test" == "$scope" && "$actual_image" == "$expected_image" ]] || return 1
  if [[ -n "$expected_name" ]]; then
    [[ "$actual_name" == "/$expected_name" ]] || return 1
  fi
}

setup_uid1000_environment() {
  [[ "$(uname -s)" == Linux ]] || {
    echo health_stdio_docker_native_uid1000_required >&2
    return 1
  }
  if [[ "$(id -u)" == 1000 && "$(id -g)" == 1000 ]]; then
    use_ci_operator=0
    local home_base="${HOME:-${TMPDIR:-/tmp}}"
    home_scope="/home/$scope"
    if [[ ! -w /home ]]; then
      home_scope="${home_base%/}/$scope"
    fi
    return 0
  fi
  if [[ "${GITHUB_ACTIONS:-}" == true && "$(id -u)" == 1001 ]] && sudo -n true >/dev/null 2>&1; then
    task_operator="$(getent passwd 1000 | cut -d: -f1)"
    [[ -n "$task_operator" && "$(id -g "$task_operator")" == 1000 ]] || {
      echo health_stdio_docker_native_uid1000_required >&2
      return 1
    }
    if ! id -nG "$task_operator" | grep -qw docker; then
      sudo -n usermod -aG docker "$task_operator" >/dev/null
    fi
    use_ci_operator=1
    home_scope="/home/$scope"
    return 0
  fi
  echo health_stdio_docker_native_uid1000_required >&2
  return 1
}

verify_active_job_record() {
  local active_file="$1" expected_service="$2" expected_phase="$3"
  local file_stat content_raw count=0 line key val
  file_stat="$(run_as_operator stat -c '%u:%g:%a:%h' -- "$active_file")"
  [[ "$file_stat" == 1000:1000:600:1 ]]
  content_raw="$(read_state_file "$active_file")"
  declare -A parsed=()
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    ((count += 1))
    [[ "$line" =~ ^(JOB_[A-Z0-9_]+)=([^=]+)$ ]]
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    [[ -z "${parsed[$key]+present}" ]]
    parsed["$key"]="$val"
  done <<<"$content_raw"
  (( count == 9 ))
  for key in JOB_VERSION JOB_REF JOB_PARENT JOB_SERVICE JOB_REVISION JOB_IMAGE JOB_COMMAND_SHA256 JOB_CONTAINER JOB_PHASE; do
    [[ -n "${parsed[$key]:-}" ]]
  done
  [[ "${parsed[JOB_VERSION]}" == 1 ]]
  [[ "${parsed[JOB_REF]}" =~ ^operation_[a-f0-9]{32}$ ]]
  [[ "${parsed[JOB_PARENT]}" == "$scope" ]]
  [[ "${parsed[JOB_SERVICE]}" == "$expected_service" ]]
  [[ "${parsed[JOB_REVISION]}" == "$revision" ]]
  [[ "${parsed[JOB_IMAGE]}" == "$ops_image_id" ]]
  [[ "${parsed[JOB_COMMAND_SHA256]}" =~ ^[a-f0-9]{64}$ ]]
  [[ "${parsed[JOB_CONTAINER]}" =~ ^[a-f0-9]{64}$ ]]
  [[ "${parsed[JOB_PHASE]}" == "$expected_phase" ]]
}

run_lifecycle_case() {
  local case_name="$1" log_driver="$2" trace_active="$3" drop_attached="$4" input_json="$5" second_attempt="$6"
  local extra_timeout_ms="${7:-}" override_schema_rev="${8:-}" omit_newline="${9:-0}"
  shift 9
  local case_dir="$state_base/cases/$case_name"
  local case_config="$case_dir/config"
  local case_state="$case_dir/state"

  run_as_operator bash -Eeuo pipefail -c '
    mkdir -p -m 0700 "$1" "$2" "$3"
    cp -a "$4/." "$2/"
    if [[ -n "$5" ]]; then printf "OPS_MAX_CALL_MS=%s\n" "$5" >"$2/health.env"; fi
    chmod 0600 "$2/"*
    (umask 077; : >"$3/deployment.lock")
    [[ "$(stat -c "%u:%g:%a:%h" -- "$3/deployment.lock")" == 1000:1000:600:1 ]]
  ' bash "$case_dir" "$case_config" "$case_state" "$state_base/config" "$extra_timeout_ms"

  if [[ "$trace_active" == 1 ]]; then
    run_as_operator bash -Eeuo pipefail -c '
      sed -n "/<<'\''TRACE'\''$/,/^TRACE$/{ /<<'\''TRACE'\''$/d; /^TRACE$/d; p; }" "$1/scripts/test-synthetic-runtime-deployment.sh" >"$2/trace-entry.bash"
      chmod 0600 "$2/trace-entry.bash"
    ' bash "$ops_root" "$case_state"
  fi

  local controller_env_diag=''
  if [[ "$trace_active" == 1 ]]; then
    controller_env_diag='closed-v1'
  fi

  local controller_script
  controller_script='
    set -Eeuo pipefail
    ops_root="$1"; case_config="$2"; secret_root="$3"; case_state="$4"
    log_driver="$5"; trace_active="$6"; drop_attached="$7"; override_schema_rev="$8"; omit_newline="$9"
    revision="${10}"; scope="${11}"; backup_volume="${12}"; ops_image_id="${13}"
    schema_revision="${14}"; system_identifier="${15}"
    shift 15

    source "$ops_root/scripts/operations-common.sh"
    source "$ops_root/scripts/operations-job-lifecycle.sh"

    eval "$(declare -f operations_job_override | sed '\''1s/operations_job_override/operations_job_override_real/'\'')"
    operations_job_override() {
      local raw
      raw="$(operations_job_override_real)" || return 1
      node -e '\''
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
      '\'' "$raw" "$OPS_JOB_SERVICE" "$log_driver" "$override_schema_rev"
    }

    eval "$(declare -f operations_docker | sed '\''1s/operations_docker/operations_docker_real/'\'')"
    operations_docker() {
      printf "%s\n" "$*" >>"$case_state/docker.calls"
      if [[ "${1:-}" == container && "${2:-}" == start && "${3:-}" == --attach ]]; then
        local actual_driver
        actual_driver="$(command docker container inspect --format '\''{{.HostConfig.LogConfig.Type}}'\'' "${@: -1}")" || return 1
        printf "%s\n" "$actual_driver" >"$case_state/log-driver"
        if [[ "$drop_attached" == 1 ]]; then
          operations_docker_real "$@" >/dev/null
          return $?
        fi
      fi
      operations_docker_real "$@"
    }

    if [[ "$omit_newline" == 1 ]]; then
      operations_job_health_exchange() {
        local health_read="" health_write="" health_original_read health_original_write health_pid health_status=0
        coproc OPS_HEALTH_PIPE { operations_docker container start --attach --interactive "$OPS_JOB_CONTAINER"; }
        health_pid="${OPS_HEALTH_PIPE_PID:-}"
        health_original_read="${OPS_HEALTH_PIPE[0]-}"; health_original_write="${OPS_HEALTH_PIPE[1]-}"
        if [[ ! "$health_pid" =~ ^[1-9][0-9]*$ || ! "$health_original_read" =~ ^[0-9]+$ || ! "$health_original_write" =~ ^[0-9]+$ ]]; then
          [[ ! "$health_pid" =~ ^[1-9][0-9]*$ ]] || { kill "$health_pid" 2>/dev/null || true; wait "$health_pid" 2>/dev/null || true; }
          return 1
        fi
        if ! exec {health_read}<&"$health_original_read" {health_write}>&"$health_original_write"; then
          exec {health_original_read}<&- {health_original_write}>&- || true
          [[ ! "$health_read" =~ ^[0-9]+$ ]] || exec {health_read}<&-
          kill "$health_pid" 2>/dev/null || true; wait "$health_pid" 2>/dev/null || true
          return 1
        fi
        exec {health_original_read}<&- {health_original_write}>&- || health_status=1
        if (( health_status == 0 )) && printf "%s" "$OPS_HEALTH_INPUT_JSON" >&"$health_write"; then
          cat <&"$health_read" || health_status=1
        else
          health_status=1
        fi
        exec {health_write}>&- {health_read}<&- || health_status=1
        wait "$health_pid" || health_status=$?
        return "$health_status"
      }
    fi

    OPS_ROOT="$ops_root"
    exec >"$case_state/stdout" 2>"$case_state/stderr"
    declare -A OPS_CONFIG=(
      [FCD_SUPPORT_REVISION]="$revision"
      [FCD_RUNTIME_PROJECT]="$scope"
      [FCD_CONFIG_ROOT]="$case_config"
      [FCD_SECRET_ROOT]="$secret_root"
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
    for cfg_key in "${!OPS_CONFIG[@]}"; do
      operations_config_field "$cfg_key" "${OPS_CONFIG[$cfg_key]}"
    done

    OPS_DATABASE_SYSTEM_IDENTIFIER="$system_identifier"
    export OPS_HEALTH_INPUT_JSON
    exec {ops_lock_fd}<>"$case_state/deployment.lock"
    flock --nonblock "$ops_lock_fd"
    export OPS_LOCK_DESCRIPTOR="$ops_lock_fd"

    exec 3>"$case_state/trace3" 4>"$case_state/out4"
    if [[ "$trace_active" == 1 ]]; then
      source "$case_state/trace-entry.bash"
      shopt -qo functrace
      [[ -n "$(trap -p DEBUG)" ]]
    else
      ! shopt -qo functrace
      [[ -z "$(trap -p DEBUG)" ]]
    fi
    {
      if shopt -qo functrace; then printf "functrace=on\n"; else printf "functrace=off\n"; fi
      if [[ -n "$(trap -p DEBUG)" ]]; then printf "debug_trap=present\n"; else printf "debug_trap=absent\n"; fi
    } >"$case_state/trace_state"

    if ack="$(operations_execute_job "${@}")"; then
      printf "%s\n" "$ack" >"$case_state/ack"
      printf "synthetic_schedule=successor\n" >&4
      exit 0
    else
      exit $?
    fi
  '

  local rc=0
  run_as_operator env \
    "PATH=$PATH" \
    LC_ALL=C \
    "FCD_RUNTIME_HOST_DIAGNOSTICS=$controller_env_diag" \
    "FCD_SYNTHETIC_TRACE=$case_state/trace3" \
    "FCD_SYNTHETIC_EVIDENCE_LIBRARY=$ops_root/scripts/synthetic-host-evidence.sh" \
    "OPS_HEALTH_INPUT_JSON=$input_json" \
    bash -c "$controller_script" bash \
      "$ops_root" "$case_config" "$state_base/secrets" "$case_state" \
      "$log_driver" "$trace_active" "$drop_attached" "$override_schema_rev" "$omit_newline" \
      "$revision" "$scope" "$backup_volume" "$ops_image_id" \
      "$schema_revision" "$system_identifier" "$@" || rc=$?

  run_as_operator bash -Eeuo pipefail -c 'printf "%s\n" "$1" >"$2/exit"' bash "$rc" "$case_state"

  if [[ "$second_attempt" == 1 ]]; then
    verify_active_job_record "$case_state/active-job" health uncertain
    local before_hash before_stat after_hash after_stat retry_rc=0
    before_hash="$(run_as_operator sha256sum -- "$case_state/active-job")"
    before_stat="$(run_as_operator stat -c '%u:%g:%a:%h' -- "$case_state/active-job")"

    # Spawn a brand-new separate second UID 1000 controller process acquiring its own flock.
    local second_script
    second_script='
      set -Eeuo pipefail
      ops_root="$1"; case_config="$2"; secret_root="$3"; case_state="$4"
      revision="$5"; scope="$6"; backup_volume="$7"; ops_image_id="$8"
      schema_revision="$9"; system_identifier="${10}"
      shift 10

      exec >"$case_state/retry_stdout" 2>"$case_state/retry_stderr"
      source "$ops_root/scripts/operations-common.sh"
      source "$ops_root/scripts/operations-job-lifecycle.sh"
      eval "$(declare -f operations_docker | sed '\''1s/operations_docker/operations_docker_real/'\'')"
      operations_docker() {
        printf "%s\n" "$*" >>"$case_state/docker.retry.calls"
        operations_docker_real "$@"
      }
      OPS_ROOT="$ops_root"
      declare -A OPS_CONFIG=(
        [FCD_SUPPORT_REVISION]="$revision"
        [FCD_RUNTIME_PROJECT]="$scope"
        [FCD_CONFIG_ROOT]="$case_config"
        [FCD_SECRET_ROOT]="$secret_root"
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
      for cfg_key in "${!OPS_CONFIG[@]}"; do
        operations_config_field "$cfg_key" "${OPS_CONFIG[$cfg_key]}"
      done
      OPS_DATABASE_SYSTEM_IDENTIFIER="$system_identifier"
      exec {ops_lock_fd}<>"$case_state/deployment.lock"
      flock --nonblock "$ops_lock_fd"
      export OPS_LOCK_DESCRIPTOR="$ops_lock_fd"
      operations_execute_job "$@"
    '

    run_as_operator env \
      "PATH=$PATH" \
      LC_ALL=C \
      bash -c "$second_script" bash \
        "$ops_root" "$case_config" "$state_base/secrets" "$case_state" \
        "$revision" "$scope" "$backup_volume" "$ops_image_id" \
        "$schema_revision" "$system_identifier" "$@" || retry_rc=$?

    run_as_operator bash -Eeuo pipefail -c 'printf "%s\n" "$1" >"$2/retry_exit"' bash "$retry_rc" "$case_state"
    after_hash="$(run_as_operator sha256sum -- "$case_state/active-job")"
    after_stat="$(run_as_operator stat -c '%u:%g:%a:%h' -- "$case_state/active-job")"
    [[ "$after_hash" == "$before_hash" && "$after_stat" == "$before_stat" ]]
  fi
}

run_direct_job() {
  local name="$1"; shift
  local dir="$state_base/direct-$name"
  run_as_operator bash -Eeuo pipefail -c '
    mkdir -p -m 0700 "$1/config" "$1/state"
    cp -a "$2/." "$1/config/"
    chmod 0600 "$1/config/"*
    (umask 077; : >"$1/state/deployment.lock")
    [[ "$(stat -c "%u:%g:%a:%h" -- "$1/state/deployment.lock")" == 1000:1000:600:1 ]]
  ' bash "$dir" "$state_base/config"

  local direct_script
  direct_script='
    set -Eeuo pipefail
    ops_root="$1"; dir="$2"; secret_root="$3"; revision="$4"; scope="$5"
    backup_volume="$6"; ops_image_id="$7"; schema_revision="$8"; system_identifier="$9"
    shift 9

    source "$ops_root/scripts/operations-common.sh"
    source "$ops_root/scripts/operations-job-lifecycle.sh"
    OPS_ROOT="$ops_root"
    declare -A OPS_CONFIG=(
      [FCD_SUPPORT_REVISION]="$revision"
      [FCD_RUNTIME_PROJECT]="$scope"
      [FCD_CONFIG_ROOT]="$dir/config"
      [FCD_SECRET_ROOT]="$secret_root"
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
    for cfg_key in "${!OPS_CONFIG[@]}"; do
      operations_config_field "$cfg_key" "${OPS_CONFIG[$cfg_key]}"
    done

    OPS_DATABASE_SYSTEM_IDENTIFIER="$system_identifier"
    exec {ops_lock_fd}<>"$dir/state/deployment.lock"
    flock --nonblock "$ops_lock_fd"
    export OPS_LOCK_DESCRIPTOR="$ops_lock_fd"
    operations_execute_job "$@" >"$dir/ack"
  '

  run_as_operator env "PATH=$PATH" LC_ALL=C bash -c "$direct_script" bash \
    "$ops_root" "$dir" "$state_base/secrets" "$revision" "$scope" \
    "$backup_volume" "$ops_image_id" "$schema_revision" "$system_identifier" "$@"
  [[ "$(read_state_file "$dir/ack")" == '{"status":"completed","processed":1,"reasonCode":"ok"}' ]]
  if [[ -e "$dir/state/active-job" ]] || run_as_operator test -e "$dir/state/active-job"; then
    return 1
  fi
}

pg_count() {
  docker exec -e "PGPASSWORD=$pg_owner_password" "$pg_container" \
    psql -U postgres -d fcd_support_test -At -c "$1"
}

assert_no_secrets_in_case() {
  local case_state="$1" file sec content
  for file in "$case_state/ack" "$case_state/out4" "$case_state/trace3" "$case_state/stdout" "$case_state/stderr" "$case_state/retry_stdout" "$case_state/retry_stderr"; do
    content="$(read_state_file "$file")"
    [[ -n "$content" ]] || continue
    for sec in "${declarable_secrets[@]}" "$host_secret_marker"; do
      if grep -Fq -- "$sec" <<<"$content"; then
        echo health_stdio_docker_secret_leak >&2
        exit 1
      fi
    done
  done
}

main() {
  [[ "$#" == 2 && "$2" =~ ^[a-f0-9]{40}$ ]] || {
    echo health_stdio_docker_arguments_invalid >&2
    exit 1
  }
  ops_image="$1"
  revision="$2"
  init_defaults
  register_traps

  local image_meta
  image_meta="$(docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}' "$ops_image")"
  [[ "$image_meta" =~ ^sha256:[a-f0-9]{64}/[a-f0-9]{40}/linux/amd64$ && "$image_meta" == */"$revision"/linux/amd64 ]]
  ops_image_id="${image_meta%%/*}"
  [[ "$(docker image inspect --format '{{if .Config.Volumes}}has_volumes{{else}}none{{end}}/{{.Config.User}}' "$ops_image_id")" == none/node ]]

  if [[ "$(uname -s)" == Linux ]]; then
    local home_base="${HOME:-${TMPDIR:-/tmp}}"
    home_scope="/home/$scope"
    if [[ "$(id -u)" == 1000 && ! -w /home ]]; then
      home_scope="${home_base%/}/$scope"
    fi
  fi
  assert_clean_start
  setup_uid1000_environment

  before_containers="$(docker ps --all --quiet --no-trunc | sort)"
  before_networks="$(docker network ls --format '{{.ID}}' | sort)"
  before_volumes="$(docker volume ls --quiet | sort)"
  precreation_passed=1

  workdir="$(mktemp -d "${TMPDIR:-/tmp}/fcd-health-stdio-docker.XXXXXXXX")"
  chmod 0700 "$workdir"

  if [[ "$use_ci_operator" == 1 ]]; then
    sudo -n install -d -m 0700 -o 1000 -g 1000 "$home_scope" "$home_scope/repo"
    created_home_scope="$home_scope"
    if command -v setfacl >/dev/null 2>&1; then
      sudo -n setfacl --remove-all --remove-default -- "$home_scope" "$home_scope/repo"
    fi
    sudo -n cp -a -- "$root/." "$home_scope/repo/"
    sudo -n chown -R --no-dereference 1000:1000 "$home_scope/repo"
    state_base="$home_scope"
    ops_root="$home_scope/repo"
  else
    mkdir -p -m 0700 "$home_scope"
    created_home_scope="$home_scope"
    state_base="$home_scope"
    ops_root="$root"
  fi
  run_as_operator bash -Eeuo pipefail -c '
    set -Eeuo pipefail
    [[ "$(id -u):$(id -g)" == 1000:1000 ]]
    [[ "$(stat -c "%u:%g:%a" -- "$1")" == 1000:1000:700 ]]
    fs="$(stat -f -c "%T" -- "$1")"
    case "$fs" in ext2/ext3|ext4|btrfs|xfs|zfs) ;; *) exit 1 ;; esac
    mkdir -p -m 0700 "$1/config" "$1/secrets" "$1/cases"
  ' bash "$state_base"

  created_network_id="$(docker network create --internal --label "fcd-support.health-stdio-test=$scope" "$network")"
  [[ "$created_network_id" =~ ^[a-f0-9]{64}$ ]]
  [[ "$(docker network inspect --format '{{.Id}}|{{.Name}}|{{.Driver}}|{{.Internal}}|{{index .Labels "fcd-support.health-stdio-test"}}' "$created_network_id")" == "$created_network_id|$network|bridge|true|$scope" ]]

  docker volume create --label "fcd-support.health-stdio-test=$scope" "$backup_volume" >/dev/null
  [[ "$(docker volume inspect --format '{{.Name}}|{{.Driver}}|{{.Scope}}|{{index .Labels "fcd-support.health-stdio-test"}}' "$backup_volume")" == "$backup_volume|local|local|$scope" ]]
  created_backup_volume="$backup_volume"

  docker volume create --label "fcd-support.health-stdio-test=$scope" "$pg_volume" >/dev/null
  [[ "$(docker volume inspect --format '{{.Name}}|{{.Driver}}|{{.Scope}}|{{index .Labels "fcd-support.health-stdio-test"}}' "$pg_volume")" == "$pg_volume|local|local|$scope" ]]
  created_pg_volume="$pg_volume"

  # Replace anonymous --rm initializers with tracked container creation, identity verification, and removal.
  local chown_backups_cid chown_exit
  chown_backups_cid="$(
    docker create --pull never --network none --read-only --user 0:0 \
      --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
      --security-opt no-new-privileges --cpus 0.25 --memory 128m --pids-limit 32 \
      --label "fcd-support.health-stdio-test=$scope" \
      --mount "type=volume,src=$backup_volume,dst=/var/lib/fcd-support/backups" \
      --entrypoint sh "$ops_image_id" -c 'chown 1000:1000 /var/lib/fcd-support/backups && chmod 0700 /var/lib/fcd-support/backups'
  )"
  verify_created_container "$chown_backups_cid" '' "$ops_image_id"
  created_containers+=("$chown_backups_cid")
  docker start --attach "$chown_backups_cid" >/dev/null
  chown_exit="$(docker container inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$chown_backups_cid")"
  [[ "$chown_exit" == 'exited|0' ]]
  verify_and_remove_container "$chown_backups_cid" fixture

  pg_owner_password="synthetic_pg_owner_$(hex32)"
  declarable_secrets+=("$pg_owner_password")

  local pg_cid
  pg_cid="$(
    docker create --name "$pg_container" \
      --label "fcd-support.health-stdio-test=$scope" \
      --network "$network" --network-alias postgres \
      --security-opt no-new-privileges --cpus 1 --memory 1g --pids-limit 128 \
      --mount "type=volume,src=$pg_volume,dst=/var/lib/postgresql" \
      --env POSTGRES_USER=postgres \
      --env POSTGRES_DB=fcd_support_test \
      --env "POSTGRES_PASSWORD=$pg_owner_password" \
      --health-cmd 'pg_isready -U postgres -d fcd_support_test' \
      --health-interval 1s --health-timeout 2s --health-retries 30 \
      "$postgres_image"
  )"
  [[ "$pg_cid" =~ ^[a-f0-9]{64}$ ]]
  [[ "$(docker container inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "fcd-support.health-stdio-test"}}|{{.Config.Image}}' "$pg_cid")" == "$pg_cid|/$pg_container|$scope|$postgres_image" ]]
  created_containers+=("$pg_cid")
  docker start "$pg_cid" >/dev/null

  local attempt
  for ((attempt = 0; attempt < 40; attempt++)); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$pg_cid")" == healthy ]] && break
    sleep 1
  done
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$pg_cid")" == healthy ]]

  system_identifier="$(
    docker exec -e "PGPASSWORD=$pg_owner_password" "$pg_cid" \
      psql -U postgres -d fcd_support_test -At -c 'select system_identifier::text from pg_control_system()'
  )"
  [[ "$system_identifier" =~ ^[1-9][0-9]{0,19}$ ]]

  # Generate config and secrets directly as UID 1000:1000 with strict mode 0600 (no root --rm container).
  run_as_operator env "PATH=$PATH" node --input-type=module -e '
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
  "health", "backup", "verify_backup", "checkpoint", "migrate", "restore",
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
' "$state_base" "$pg_owner_password"

  local sec
  while IFS= read -r sec; do
    [[ -z "$sec" ]] || declarable_secrets+=("$sec")
  done < <(read_state_file "$state_base/secrets-list.txt")

  run_as_operator bash -Eeuo pipefail -c '
    find "$1/secrets" -type f -exec bash -c '\''for f; do [[ "$(stat -c "%u:%g:%a:%h" -- "$f")" == 1000:1000:600:1 ]] || exit 1; done'\'' _ {} +
  ' bash "$state_base"

  # Bootstrap prepare -> migrate -> converge using the real compose.operations.yml services.
  run_direct_job prepare bootstrap prepare "$system_identifier" /run/secrets
  run_direct_job migrate migrate migrate
  run_direct_job converge bootstrap converge "$system_identifier" /run/secrets

  local valid_input
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
  local before_rows after_rows after_none_rows after_trace_off_rows
  before_rows="$(pg_count 'select count(*) from operations_health_checks')"
  run_lifecycle_case json-file json-file 1 0 "$valid_input" 0 '' '' 0 health health
  [[ "$(read_state_file "$state_base/cases/json-file/state/exit")" == 0 ]]
  [[ "$(read_state_file "$state_base/cases/json-file/state/log-driver")" == json-file ]]
  [[ "$(read_state_file "$state_base/cases/json-file/state/ack")" == '{"status":"completed","processed":11,"reasonCode":"ok"}' ]]
  [[ "$(read_state_file "$state_base/cases/json-file/state/out4")" == 'synthetic_schedule=successor' ]]
  [[ "$(read_state_file "$state_base/cases/json-file/state/trace_state")" == $'functrace=on\ndebug_trap=present' ]]
  ! run_as_operator test -e "$state_base/cases/json-file/state/active-job"
  ! grep -q 'container logs' <<<"$(read_state_file "$state_base/cases/json-file/state/docker.calls")"
  grep -qx 'synthetic_health_ack_diagnostic=completed' <<<"$(read_state_file "$state_base/cases/json-file/state/trace3")"
  assert_no_secrets_in_case "$state_base/cases/json-file/state"
  after_rows="$(pg_count 'select count(*) from operations_health_checks')"
  [[ $((after_rows - before_rows)) == 11 ]]
  [[ "$(pg_count "select state || '/' || reason_code from operations_health_checks where component='webhook' order by id desc limit 1")" == healthy/ok ]]

  run_lifecycle_case driver-none none 1 0 "$valid_input" 0 '' '' 0 health health
  [[ "$(read_state_file "$state_base/cases/driver-none/state/exit")" == 0 ]]
  [[ "$(read_state_file "$state_base/cases/driver-none/state/log-driver")" == none ]]
  [[ "$(read_state_file "$state_base/cases/driver-none/state/ack")" == '{"status":"completed","processed":11,"reasonCode":"ok"}' ]]
  [[ "$(read_state_file "$state_base/cases/driver-none/state/out4")" == 'synthetic_schedule=successor' ]]
  [[ "$(read_state_file "$state_base/cases/driver-none/state/trace_state")" == $'functrace=on\ndebug_trap=present' ]]
  ! run_as_operator test -e "$state_base/cases/driver-none/state/active-job"
  ! grep -q 'container logs' <<<"$(read_state_file "$state_base/cases/driver-none/state/docker.calls")"
  grep -qx 'synthetic_health_ack_diagnostic=completed' <<<"$(read_state_file "$state_base/cases/driver-none/state/trace3")"
  assert_no_secrets_in_case "$state_base/cases/driver-none/state"
  after_none_rows="$(pg_count 'select count(*) from operations_health_checks')"
  [[ $((after_none_rows - after_rows)) == 11 ]]

  # 3: Real TRACE inactive (trace-entry.bash omitted, functrace/DEBUG absent) vs active parity.
  run_lifecycle_case trace-inactive none 0 0 "$valid_input" 0 '' '' 0 health health
  [[ "$(read_state_file "$state_base/cases/trace-inactive/state/exit")" == 0 ]]
  [[ "$(read_state_file "$state_base/cases/trace-inactive/state/log-driver")" == none ]]
  [[ "$(read_state_file "$state_base/cases/trace-inactive/state/ack")" == "$(read_state_file "$state_base/cases/driver-none/state/ack")" ]]
  [[ "$(read_state_file "$state_base/cases/trace-inactive/state/out4")" == "$(read_state_file "$state_base/cases/driver-none/state/out4")" ]]
  [[ "$(read_state_file "$state_base/cases/trace-inactive/state/trace_state")" == $'functrace=off\ndebug_trap=absent' ]]
  [[ -z "$(read_state_file "$state_base/cases/trace-inactive/state/trace3")" ]]
  ! run_as_operator test -e "$state_base/cases/trace-inactive/state/active-job"
  ! grep -q 'container logs' <<<"$(read_state_file "$state_base/cases/trace-inactive/state/docker.calls")"
  assert_no_secrets_in_case "$state_base/cases/trace-inactive/state"
  after_trace_off_rows="$(pg_count 'select count(*) from operations_health_checks')"
  [[ $((after_trace_off_rows - after_none_rows)) == 11 ]]

  # 4: Narrow test-port fault (dropped attached stdout) on json-file and none,
  # plus genuine separate-process controller pending-job refusal over ext4 + flock.
  run_lifecycle_case drop-json-file json-file 1 1 "$valid_input" 1 '' '' 0 health health
  [[ "$(read_state_file "$state_base/cases/drop-json-file/state/exit")" == 1 ]]
  [[ -z "$(read_state_file "$state_base/cases/drop-json-file/state/ack")" && -z "$(read_state_file "$state_base/cases/drop-json-file/state/out4")" ]]
  verify_active_job_record "$state_base/cases/drop-json-file/state/active-job" health uncertain
  grep -qx 'synthetic_health_ack_diagnostic=empty' <<<"$(read_state_file "$state_base/cases/drop-json-file/state/trace3")"
  grep -qx 'synthetic_health_daemon_diagnostic=completed' <<<"$(read_state_file "$state_base/cases/drop-json-file/state/trace3")"
  [[ "$(read_state_file "$state_base/cases/drop-json-file/state/retry_exit")" == 1 ]]
  grep -q 'operations_job_pending' <<<"$(read_state_file "$state_base/cases/drop-json-file/state/retry_stderr")"
  [[ -z "$(read_state_file "$state_base/cases/drop-json-file/state/docker.retry.calls")" ]]
  assert_no_secrets_in_case "$state_base/cases/drop-json-file/state"

  run_lifecycle_case drop-none none 1 1 "$valid_input" 1 '' '' 0 health health
  [[ "$(read_state_file "$state_base/cases/drop-none/state/exit")" == 1 ]]
  [[ "$(read_state_file "$state_base/cases/drop-none/state/log-driver")" == none ]]
  verify_active_job_record "$state_base/cases/drop-none/state/active-job" health uncertain
  grep -qx 'synthetic_health_ack_diagnostic=empty' <<<"$(read_state_file "$state_base/cases/drop-none/state/trace3")"
  grep -qx 'synthetic_health_daemon_diagnostic=unobserved' <<<"$(read_state_file "$state_base/cases/drop-none/state/trace3")"
  [[ "$(read_state_file "$state_base/cases/drop-none/state/retry_exit")" == 1 ]]
  grep -q 'operations_job_pending' <<<"$(read_state_file "$state_base/cases/drop-none/state/retry_stderr")"
  [[ -z "$(read_state_file "$state_base/cases/drop-none/state/docker.retry.calls")" ]]
  assert_no_secrets_in_case "$state_base/cases/drop-none/state"

  # 5: Real container fault controls (malformed, oversized, stalled, nonzero-config).
  local oversized_input baseline_rows after_fault_rows fault
  oversized_input="$(node -e 'process.stdout.write(JSON.stringify({ x: "y".repeat(16376) }))')"
  [[ ${#oversized_input} == 16384 ]]

  baseline_rows="$(pg_count 'select count(*) from operations_health_checks')"
  run_lifecycle_case fault-malformed none 1 0 "{\"hostSnapshot\":\"$host_secret_marker\"" 1 200 '' 0 health health
  run_lifecycle_case fault-oversized none 1 0 "$oversized_input" 1 '' '' 0 health health
  run_lifecycle_case fault-stalled none 1 0 '{}' 1 200 '' 1 health health
  run_lifecycle_case fault-nonzero none 1 0 '{}' 1 '' 'bad_rev' 0 health health

  for fault in fault-malformed fault-oversized fault-stalled fault-nonzero; do
    [[ "$(read_state_file "$state_base/cases/$fault/state/exit")" == 1 ]]
    [[ -z "$(read_state_file "$state_base/cases/$fault/state/ack")" && -z "$(read_state_file "$state_base/cases/$fault/state/out4")" ]]
    verify_active_job_record "$state_base/cases/$fault/state/active-job" health uncertain
    [[ "$(read_state_file "$state_base/cases/$fault/state/retry_exit")" == 1 ]]
    grep -q 'operations_job_pending' <<<"$(read_state_file "$state_base/cases/$fault/state/retry_stderr")"
    [[ -z "$(read_state_file "$state_base/cases/$fault/state/docker.retry.calls")" ]]
    assert_no_secrets_in_case "$state_base/cases/$fault/state"
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
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
else
  init_defaults
fi
