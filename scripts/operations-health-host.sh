#!/usr/bin/env bash
# Read-only host evidence, never deployment authority. The caller retains checked
# configuration and supplies the bounded local operations_docker wrapper.
# Emits one HostHealthSnapshot, or returns 1 with no output for uncertain facts.
operations_collect_health_host() (
  [[ "$#" == 0 ]] || return 1
  declare -F operations_docker >/dev/null || return 1
  if ! declare -F operations_runtime_id >/dev/null; then
    source "$(dirname -- "${BASH_SOURCE[0]}")/operations-runtime-host.sh" || return 1
  fi
  local project="${OPS_CONFIG[FCD_RUNTIME_PROJECT]:-}" expected="${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}"
  local timeout="${OPS_CONFIG[FCD_HEALTH_TIMEOUT_MS]:-}" peer="${OPS_CONFIG[FCD_INGRESS_PEER_ID]:-}"
  [[ "$project" =~ ^fcd-support([-a-z0-9_]{1,100})?$ && "$expected" =~ ^[a-f0-9]{40}$ && "$peer" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$timeout" =~ ^[1-9][0-9]{0,5}$ ]] && (( 10#$timeout <= 300000 )) || return 1
  local checked_at stamp='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z'
  checked_at="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" || return 1
  [[ "$checked_at" =~ ^${stamp}$ ]] || return 1
  local app_format='{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}|{{.State.Dead}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}'
  local tunnel_format='{{.Id}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}|{{.State.Dead}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}'
  local -A services=([api]=fcd-support-api [admin]=fcd-support-admin [reply]=fcd-support-reply)
  local -A actors=() before=() running=() health=() revisions=() seen=()
  local -a check_keys=(api admin reply tunnel)
  local key id raw ignored_project ignored_service paused restarting dead state started revision has_outbound=false outbound_id=''
  for key in api admin reply; do
    id="$(operations_runtime_id "${services[$key]}")" || return 1
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    actors[$key]="$id"
  done
  if [[ "${OPS_RUNTIME_MODE:-private-disabled}" == private-enabled || -n "${OPS_CONFIG[FCD_MODEL_NETWORK]:-}" ]]; then
    if outbound_id="$(operations_runtime_id fcd-support-outbound 2>/dev/null)" && [[ "$outbound_id" =~ ^[a-f0-9]{64}$ ]]; then
      has_outbound=true
      services[outbound]=fcd-support-outbound
      actors[outbound]="$outbound_id"
      check_keys=(api admin reply outbound tunnel)
    fi
  fi
  actors[tunnel]="$peer"
  for key in "${check_keys[@]}"; do
    id="${actors[$key]}"
    [[ -z "${seen[$id]:-}" ]] || return 1
    seen[$id]=yes
  done
  operations_health_host_metadata() {
    local role="$1" value pattern format="$app_format"
    if [[ "$role" == tunnel ]]; then
      format="$tunnel_format"
      pattern="^${actors[$role]}[|](true|false)[|](true|false)[|](true|false)[|](true|false)[|](healthy|unhealthy|starting|none)[|]${stamp}$"
    else
      pattern="^${actors[$role]}[|]${project}[|]${services[$role]}[|][a-f0-9]{40}[|](true|false)[|](true|false)[|](true|false)[|](true|false)[|](healthy|unhealthy|starting|none)[|]${stamp}$"
    fi
    value="$(operations_docker container inspect --format "$format" "${actors[$role]}")" || return 1
    (( ${#value} <= 1024 )) && [[ "$value" =~ $pattern ]] || return 1
    printf '%s' "$value"
  }
  for key in "${check_keys[@]}"; do
    raw="$(operations_health_host_metadata "$key")" || return 1
    before[$key]="$raw"
    if [[ "$key" == tunnel ]]; then
      IFS='|' read -r id state paused restarting dead "health[$key]" started <<<"$raw"
      revision="$expected"
    else
      IFS='|' read -r id ignored_project ignored_service revision state paused restarting dead "health[$key]" started <<<"$raw"
    fi
    running[$key]="$state"; revisions[$key]="$revision"
    if [[ "$state/$paused/$restarting/$dead" != true/false/false/false ]]; then
      health[$key]=unavailable
    else
      case "${health[$key]}" in
        healthy) health[$key]=healthy ;;
        unhealthy) health[$key]=unavailable ;;
        starting) health[$key]=degraded ;;
        none) health[$key]=unknown ;;
      esac
    fi
  done
  if [[ "${health[api]}" == healthy && "${revisions[api]}" == "$expected" ]]; then
    if ! operations_docker exec "${actors[api]}" node --input-type=module -e 'try {const r=await fetch("http://127.0.0.1:3003/webhooks/meta",{redirect:"error",signal:AbortSignal.timeout(Number(process.argv[1]))});const ok=r.status===403;await r.body?.cancel();process.exit(ok?0:1)}catch{process.exit(1)}' "$timeout" >/dev/null; then
      health[api]=unavailable
    fi
  fi
  local admin_socket=unknown heartbeat='' outbound_heartbeat='' outbound_json='' heartbeat_state heartbeat_at
  if [[ "${health[admin]}" == healthy && "${revisions[admin]}" == "$expected" ]]; then
    if operations_docker exec "${actors[admin]}" node dist/admin/admin-socket-health.js /run/fcd-support-admin/admin.sock "$timeout" >/dev/null; then
      admin_socket=healthy
    else
      admin_socket=unavailable
    fi
  elif [[ "${health[admin]}" == unavailable ]]; then
    admin_socket=unavailable
  fi
  if [[ "${health[reply]}" == healthy && "${revisions[reply]}" == "$expected" ]]; then
    # The installed reader proves freshness. The second bounded, non-following
    # read returns only validated state/time; raw heartbeat bytes never leave it.
    if raw="$(operations_docker exec "${actors[reply]}" node --input-type=module -e 'import {constants,openSync,closeSync,fstatSync,readSync} from "node:fs";import {readRuntimeHeartbeat} from "./dist/operations/role-runtime.js";import {parseRuntimeHeartbeat} from "./dist/operations/runtime-readiness.js";let fd;try{const p="/run/fcd-support/heartbeat.json",now=new Date(),limit=Number(process.env.OPS_HEALTH_STALE_MS);if(!Number.isSafeInteger(limit)||limit<1||limit>86400000||!readRuntimeHeartbeat(p,now,limit))throw 0;fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.size>1024)throw 0;const b=Buffer.alloc(1025),n=readSync(fd,b,0,b.length,0);if(n<1||n>1024)throw 0;const h=parseRuntimeHeartbeat(JSON.parse(b.subarray(0,n).toString("utf8")));if(!h||!["healthy","disabled"].includes(h.state))throw 0;const age=now.getTime()-Date.parse(h.checkedAt);if(!Number.isFinite(age)||age<0||age>limit)throw 0;process.stdout.write(h.state+"|"+h.checkedAt)}catch{process.exitCode=1}finally{if(fd!==undefined)closeSync(fd)}')"; then
      [[ "$raw" =~ ^(healthy|disabled)[|]${stamp}$ ]] || return 1
      IFS='|' read -r heartbeat_state heartbeat_at <<<"$raw"
      heartbeat=",\"heartbeat\":{\"state\":\"$heartbeat_state\",\"checkedAt\":\"$heartbeat_at\"}"
    fi
  fi
  if [[ "$has_outbound" == true && "${health[outbound]}" == healthy && "${revisions[outbound]}" == "$expected" ]]; then
    if raw="$(operations_docker exec "${actors[outbound]}" node --input-type=module -e 'import {constants,openSync,closeSync,fstatSync,readSync} from "node:fs";import {readRuntimeHeartbeat} from "./dist/operations/role-runtime.js";import {parseRuntimeHeartbeat} from "./dist/operations/runtime-readiness.js";let fd;try{const p="/run/fcd-support/heartbeat.json",now=new Date(),limit=Number(process.env.OPS_HEALTH_STALE_MS);if(!Number.isSafeInteger(limit)||limit<1||limit>86400000||!readRuntimeHeartbeat(p,now,limit))throw 0;fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.size>1024)throw 0;const b=Buffer.alloc(1025),n=readSync(fd,b,0,b.length,0);if(n<1||n>1024)throw 0;const h=parseRuntimeHeartbeat(JSON.parse(b.subarray(0,n).toString("utf8")));if(!h||!["healthy","disabled"].includes(h.state))throw 0;const age=now.getTime()-Date.parse(h.checkedAt);if(!Number.isFinite(age)||age<0||age>limit)throw 0;process.stdout.write(h.state+"|"+h.checkedAt)}catch{process.exitCode=1}finally{if(fd!==undefined)closeSync(fd)}')"; then
      [[ "$raw" =~ ^(healthy|disabled)[|]${stamp}$ ]] || return 1
      IFS='|' read -r heartbeat_state heartbeat_at <<<"$raw"
      outbound_heartbeat=",\"heartbeat\":{\"state\":\"$heartbeat_state\",\"checkedAt\":\"$heartbeat_at\"}"
    fi
  fi
  # No evidence escapes until every sampled physical actor is still the same.
  for key in "${check_keys[@]}"; do
    raw="$(operations_health_host_metadata "$key")" || return 1
    [[ "$raw" == "${before[$key]}" ]] || return 1
  done
  for key in api admin reply; do
    id="$(operations_runtime_id "${services[$key]}")" || return 1
    [[ "$id" == "${actors[$key]}" ]] || return 1
  done
  if [[ "$has_outbound" == true ]]; then
    id="$(operations_runtime_id fcd-support-outbound)" || return 1
    [[ "$id" == "${actors[outbound]}" ]] || return 1
    outbound_json="$(printf ',{"component":"outbound","running":%s,"health":"%s","gitRevision":"%s"%s}' "${running[outbound]}" "${health[outbound]}" "${revisions[outbound]}" "$outbound_heartbeat")"
  fi
  local public_route_json='"publicRouteCheck":{"state":"not_verified"}'
  local state_root="${OPS_CONFIG[FCD_STATE_ROOT]:-}" stale_ms="${OPS_HEALTH_STALE_MS:-60000}"
  if [[ -n "$state_root" && -d "$state_root" && ! -L "$state_root" && "$stale_ms" =~ ^[1-9][0-9]{0,7}$ ]] && (( 10#$stale_ms >= 500 && 10#$stale_ms <= 86400000 )); then
    local route_file="$state_root/public-route-check" route_body='' stat_meta='' route_state='' route_at='' now_ms='' route_ms=''
    if [[ -f "$route_file" && ! -L "$route_file" ]]; then
      local readable=true
      if [[ "$(uname -s)" == Linux ]]; then
        stat_meta="$(stat -c '%u:%a:%s' -- "$route_file" 2>/dev/null || true)"
        if [[ "$stat_meta" =~ ^([0-9]+):600:([0-9]+)$ && "${BASH_REMATCH[1]}" == "$(id -u)" ]] && (( 10#${BASH_REMATCH[2]} >= 2 && 10#${BASH_REMATCH[2]} <= 512 )); then
          route_body="$(dd if="$route_file" iflag=nofollow bs=513 count=1 status=none 2>/dev/null || true)"
        else
          readable=false
        fi
      else
        local byte_count
        byte_count="$(wc -c <"$route_file" 2>/dev/null || printf 999)"
        if [[ "${byte_count//[[:space:]]/}" =~ ^[0-9]+$ ]] && (( 10#${byte_count//[[:space:]]/} >= 2 && 10#${byte_count//[[:space:]]/} <= 512 )); then
          route_body="$(head -c 513 "$route_file" 2>/dev/null || true)"
        else
          readable=false
        fi
      fi
      if [[ "$readable" == true ]]; then
        route_body="${route_body%$'\n'}"
        route_body="${route_body%$'\r'}"
        if (( ${#route_body} <= 512 )) && [[ "$route_body" =~ ^\{\"state\":\"(passed|failed)\",\"checkedAt\":\"(${stamp})\"\}$ ]]; then
          route_state="${BASH_REMATCH[1]}"
          route_at="${BASH_REMATCH[2]}"
          now_ms="$(command date -u -d "$checked_at" '+%s%3N' 2>/dev/null || true)"
          route_ms="$(command date -u -d "$route_at" '+%s%3N' 2>/dev/null || true)"
          if [[ "$now_ms" =~ ^[0-9]+$ && "$route_ms" =~ ^[0-9]+$ ]]; then
            local age_ms=$(( now_ms - route_ms ))
            if (( age_ms >= 0 && age_ms <= 10#$stale_ms )); then
              public_route_json="\"publicRouteCheck\":{\"state\":\"$route_state\",\"checkedAt\":\"$route_at\"}"
            fi
          fi
        fi
      fi
    fi
  fi
  printf '{"checkedAt":"%s","services":[{"component":"webhook","running":%s,"health":"%s","gitRevision":"%s"},{"component":"reply","running":%s,"health":"%s","gitRevision":"%s"%s}%s,{"component":"tunnel","running":%s,"health":"%s","gitRevision":"%s"}],"adminSocket":"%s","manifestAttestation":"not_verified",%s}' \
    "$checked_at" "${running[api]}" "${health[api]}" "${revisions[api]}" "${running[reply]}" "${health[reply]}" "${revisions[reply]}" "$heartbeat" "$outbound_json" "${running[tunnel]}" "${health[tunnel]}" "$expected" "$admin_socket" "$public_route_json"
) 2>/dev/null
