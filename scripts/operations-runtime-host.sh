#!/usr/bin/env bash
# Internal read-only inspection. Caller retains checked protected configuration,
# a local Docker endpoint and the deployment lock. No public handler is defined.
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-database.sh"
source "$(dirname -- "${BASH_SOURCE[0]}")/operations-deployment-state.sh"

OPERATIONS_RUNTIME_CONTAINER_FORMAT='{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"imageId":{{json .Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"healthy":{{if .State.Health}}{{eq .State.Health.Status "healthy"}}{{else}}false{{end}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"init":{{json (index .HostConfig "Init")}},"user":{{json .Config.User}},"networkMode":{{json .HostConfig.NetworkMode}},"networks":[{{$sep := ""}}{{range $name,$n := .NetworkSettings.Networks}}{{$sep}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{$sep = ","}}{{end}}],"hostPortBindings":{{len .HostConfig.PortBindings}},"publishedPortBindings":{{$count := 0}}{{range .NetworkSettings.Ports}}{{if .}}{{$count = 1}}{{end}}{{end}}{{$count}},"publishAllPorts":{{json .HostConfig.PublishAllPorts}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"utsMode":{{json .HostConfig.UTSMode}},"capAdd":{{json (index .HostConfig "CapAdd")}},"capDrop":{{json (index .HostConfig "CapDrop")}},"securityOpt":{{json (index .HostConfig "SecurityOpt")}},"devices":{{with index .HostConfig "Devices"}}{{len .}}{{else}}0{{end}},"deviceRequests":{{with index .HostConfig "DeviceRequests"}}{{len .}}{{else}}0{{end}},"groupAdd":{{json (index .HostConfig "GroupAdd")}},"volumesFrom":{{json (index .HostConfig "VolumesFrom")}},"extraHosts":{{json (index .HostConfig "ExtraHosts")}},"sysctls":{{json (index .HostConfig "Sysctls")}},"nanoCpus":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pidsLimit":{{json (index .HostConfig "PidsLimit")}},"stopTimeout":{{json (index .Config "StopTimeout")}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"tmpfs":{{json (index .HostConfig "Tmpfs")}},"command":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}},"environmentNames":[{{range $i,$entry := .Config.Env}}{{if $i}},{{end}}{{json (index (split $entry "=") 0)}}{{end}}],"executionFlags":[{{$sep := ""}}{{range $entry := .Config.Env}}{{$name := index (split $entry "=") 0}}{{if or (eq $name "MODEL_EXECUTION_ENABLED") (eq $name "OUTBOUND_EXECUTION_ENABLED") (eq $name "N8N_EXECUTION_ENABLED")}}{{$sep}}{{if or (eq $entry "MODEL_EXECUTION_ENABLED=false") (eq $entry "MODEL_EXECUTION_ENABLED=true") (eq $entry "OUTBOUND_EXECUTION_ENABLED=false") (eq $entry "OUTBOUND_EXECUTION_ENABLED=true") (eq $entry "N8N_EXECUTION_ENABLED=false") (eq $entry "N8N_EXECUTION_ENABLED=true")}}{{json $entry}}{{else}}"invalid"{{end}}{{$sep = ","}}{{end}}{{end}}],"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{if $m.Name}}{{json $m.Name}}{{else}}""{{end}},"source":{{json $m.Source}},"destination":{{json $m.Destination}},"readWrite":{{json $m.RW}},"propagation":{{with index $m "Propagation"}}{{json .}}{{else}}""{{end}}}{{end}}]}'
OPERATIONS_RUNTIME_IMAGE_FORMAT='{"id":{{json .Id}},"revision":{{with index .Config "Labels"}}{{json (index . "org.opencontainers.image.revision")}}{{else}}null{{end}},"os":{{json .Os}},"architecture":{{json .Architecture}},"user":{{json (index .Config "User")}}}'
OPERATIONS_RUNTIME_NETWORK_FORMAT='{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}},"project":{{with index .Labels "com.docker.compose.project"}}{{json .}}{{else}}""{{end}},"logicalName":{{with index .Labels "com.docker.compose.network"}}{{json .}}{{else}}""{{end}}'
OPERATIONS_RUNTIME_VOLUME_FORMAT='{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"project":{{json (index .Labels "com.docker.compose.project")}},"logicalName":{{json (index .Labels "com.docker.compose.volume")}},"createdAt":{{json .CreatedAt}},"mountpoint":{{json .Mountpoint}}'

operations_runtime_ids() {
  local raw="${1//$'\n'/ }" item separator=''
  local -a list=()
  read -r -a list <<<"$raw"
  (( ${#list[@]} <= 256 )) || return 1
  printf '['
  for item in "${list[@]}"; do
    [[ "$item" =~ ^[a-f0-9]{64}$ ]] || return 1
    printf '%s"%s"' "$separator" "$item"; separator=,
  done
  printf ']'
}

operations_runtime_id() {
  local value
  value="$(operations_docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --filter "label=com.docker.compose.service=$1")" || return 1
  [[ "$value" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s' "$value"
}

operations_runtime_snapshot() {
  local mode="${1:-runtime}" count=4
  [[ "$#" -le 1 && ( "$mode" == runtime || "$mode" == bootstrap ) ]] || return 1
  local project="${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" root="${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}"
  local ids id container containers='' separator='' role network members metadata networks='' pg_image runtime_image volume users
  local host_binds='' mounts source canonical socket root_stat device inode uid gid mode rdevice rinode ruid rgid rmode
  local -a list=() listing=(--all) data_roles=(webhook admin reply outbound notification operations ingress)
  if [[ "$mode" == bootstrap ]]; then listing=(); count=1; data_roles=(webhook admin reply outbound notification operations); fi
  ids="$(operations_docker ps "${listing[@]}" --quiet --no-trunc --filter "label=com.docker.compose.project=$project")" || return 1
  ids="${ids//$'\n'/ }"; read -r -a list <<<"$ids"
  (( ${#list[@]} == count )) || return 1
  for id in "${list[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    container="$(operations_docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$id")" || return 1
    containers+="$separator$container"; separator=,
  done
  separator=''
  for role in "${data_roles[@]}"; do
    network="$project-$role-data"
    [[ "$role" != ingress ]] || network="${OPS_CONFIG[FCD_INGRESS_NETWORK]}"
    members="$(operations_docker network inspect --format '{{range $id,$member := .Containers}}{{println $id}}{{end}}' "$network")" || return 1
    members="$(operations_runtime_ids "$members")" || return 1
    metadata="$(operations_docker network inspect --format "$OPERATIONS_RUNTIME_NETWORK_FORMAT" "$network")" || return 1
    networks+="$separator$metadata,\"members\":$members}"; separator=,
  done
  users="$(operations_docker ps --all --quiet --no-trunc --filter "volume=${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  users="$(operations_runtime_ids "$users")" || return 1
  volume="$(operations_docker volume inspect --format "$OPERATIONS_RUNTIME_VOLUME_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_VOLUME]}")" || return 1
  volume+=",\"users\":$users}"
  pg_image="$(operations_docker image inspect --format "$OPERATIONS_RUNTIME_IMAGE_FORMAT" "${OPS_CONFIG[FCD_POSTGRES_IMAGE]}")" || return 1
  runtime_image="$(operations_docker image inspect --format "$OPERATIONS_RUNTIME_IMAGE_FORMAT" "${OPS_CONFIG[FCD_SUPPORT_IMAGE]}")" || return 1
  ids="$(operations_docker ps --all --quiet --no-trunc)" || return 1
  ids="${ids//$'\n'/ }"; read -r -a list <<<"$ids"
  (( ${#list[@]} > 0 && ${#list[@]} <= 256 )) || return 1
  separator=''
  for id in "${list[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    mounts="$(operations_docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$id")" || return 1
    (( ${#mounts} <= 65536 )) || return 1
    while IFS= read -r source || [[ -n "$source" ]]; do
      [[ -n "$source" ]] || continue
      operations_absolute_path "$source" || return 1
      canonical="$(realpath -e -- "$source" 2>/dev/null)" || return 1
      operations_absolute_path "$canonical" || return 1
      host_binds+="$separator{\"containerId\":\"$id\",\"source\":\"$source\",\"canonicalSource\":\"$canonical\"}"; separator=,
      (( ${#host_binds} <= 262144 )) || return 1
    done <<<"$mounts"
  done
  operations_private_directory "$root" || return 1
  socket="$root/admin.sock"
  if [[ "$mode" == bootstrap ]]; then
    [[ ! -e "$socket" && ! -L "$socket" ]] || return 1
    printf '{"images":{"postgres":%s,"runtime":%s},"containers":[%s],"networks":[%s],"volume":%s,"hostBinds":[%s],"socket":null}' \
      "$pg_image" "$runtime_image" "$containers" "$networks" "$volume" "$host_binds"
    return 0
  fi
  [[ -S "$socket" && ! -L "$socket" ]] || return 1
  root_stat="$(stat -c '%d:%i:%u:%g:%a' -- "$root")" || return 1
  socket="$(stat -c '%d:%i:%u:%g:%a' -- "$socket")" || return 1
  [[ "$socket" =~ ^[0-9]{1,20}:[0-9]{1,20}:1000:1000:600$ && "$root_stat" =~ ^[0-9]{1,20}:[0-9]{1,20}:1000:1000:700$ ]] || return 1
  IFS=: read -r device inode uid gid mode <<<"$socket"
  IFS=: read -r rdevice rinode ruid rgid rmode <<<"$root_stat"
  printf '{"images":{"postgres":%s,"runtime":%s},"containers":[%s],"networks":[%s],"volume":%s,"hostBinds":[%s],"socket":{"device":"%s","inode":"%s","uid":%s,"gid":%s,"mode":%s,"rootDevice":"%s","rootInode":"%s","rootUid":%s,"rootGid":%s,"rootMode":%s}}' \
    "$pg_image" "$runtime_image" "$containers" "$networks" "$volume" "$host_binds" "$device" "$inode" "$uid" "$gid" "$((8#$mode))" "$rdevice" "$rinode" "$ruid" "$rgid" "$((8#$rmode))"
}

operations_runtime_probes() {
  local api admin reply timeout="${OPS_CONFIG[FCD_HEALTH_TIMEOUT_MS]}"
  api="$(operations_runtime_id fcd-support-api)" || return 1
  admin="$(operations_runtime_id fcd-support-admin)" || return 1
  reply="$(operations_runtime_id fcd-support-reply)" || return 1
  # The SQL job checks authoritative schema/deployment metadata. It is one leg,
  # never a replacement for the actual resource and process checks below.
  operations_job migrate verify-runtime >/dev/null || return 1
  operations_docker exec "$api" node --input-type=module -e 'try {const r=await fetch("http://127.0.0.1:3003/webhooks/meta",{redirect:"error",signal:AbortSignal.timeout(Number(process.argv[1]))});const ok=r.status===403;await r.body?.cancel();process.exit(ok?0:1)}catch{process.exit(1)}' "$timeout" >/dev/null || return 1
  operations_docker exec "$admin" node dist/admin/admin-socket-health.js /run/fcd-support-admin/admin.sock "$timeout" >/dev/null || return 1
  operations_docker exec "$admin" node --input-type=module -e 'import {readFile} from "node:fs/promises";for(const f of ["/proc/net/tcp","/proc/net/tcp6"]){const body=await readFile(f,"utf8");if(body.length>65536)process.exit(1);if(body.trim().split("\n").slice(1).some(l=>{const x=l.trim().split(/\s+/);return x[3]==="0A"&&!x[1]?.startsWith("0B00007F:")}))process.exit(1)}' >/dev/null || return 1
  operations_docker exec "$reply" node --input-type=module -e 'import {readRuntimeHeartbeat} from "./dist/operations/role-runtime.js";process.exit(readRuntimeHeartbeat("/run/fcd-support/heartbeat.json",new Date(),Number(process.env.OPS_HEALTH_STALE_MS))?0:1)' >/dev/null || return 1
}

operations_runtime_selection_context() {
  local mode="$1" root="${OPS_CONFIG[FCD_STATE_ROOT]:-}" file historical
  OPS_RUNTIME_VOLUME_IDENTITY=''; OPS_RUNTIME_SELECTED_IDENTIFIER=''; OPS_RUNTIME_SELECTION_STAMP=''
  [[ -n "$root" ]] || return 0
  operations_config_field FCD_STATE_ROOT "$root" || operations_fail runtime_host_invalid
  file="$root/deployment-state"
  if [[ -e "$file" || -L "$file" ]]; then
    operations_selection_read >/dev/null 2>&1 || operations_fail runtime_host_invalid
    [[ "${OPS_SELECTION[STATE_VOLUME]}" == "${OPS_CONFIG[FCD_POSTGRES_VOLUME]:-}" ]] || operations_fail runtime_host_invalid
    if [[ "$mode" == runtime ]]; then
      [[ ( "${OPS_SELECTION[STATE_PHASE]}" == starting || "${OPS_SELECTION[STATE_PHASE]}" == ready ) && "${OPS_SELECTION[STATE_WRITES_POSSIBLE]}" == yes && "${OPS_SELECTION[STATE_REVISION]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]:-}" && "${OPS_SELECTION[STATE_SCHEMA_REVISION]}" == "${OPS_CONFIG[FCD_SCHEMA_REVISION]:-}" ]] || operations_fail runtime_host_invalid
    fi
    OPS_RUNTIME_SELECTED_IDENTIFIER="${OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]}"
    OPS_RUNTIME_SELECTION_STAMP="${OPS_SELECTION[STATE_REF]}/${OPS_SELECTION[STATE_PHASE]}/${OPS_SELECTION[STATE_REVISION]}/${OPS_SELECTION[STATE_SCHEMA_REVISION]}/${OPS_SELECTION[STATE_WRITES_POSSIBLE]}"
    OPS_RUNTIME_VOLUME_IDENTITY="$(operations_selection_volume_identity 2>/dev/null)" || operations_fail runtime_host_invalid
  else
    [[ "$mode" == bootstrap && ! -e "$file.next" && ! -L "$file.next" ]] || operations_fail runtime_host_invalid
    for historical in "$root"/volume-*.record "$root"/retained-*.record; do
      [[ ! -e "$historical" && ! -L "$historical" ]] || operations_fail runtime_host_invalid
    done
  fi
}

operations_inspect_host() {
  local mode="$1" field model before after image validator_image result payload volume_identity selected_identifier selection_stamp binding=''
  local OPS_DATABASE_SYSTEM_IDENTIFIER=''
  local -a arguments=()
  [[ "$#" == 1 && ( "$mode" == runtime || "$mode" == bootstrap ) ]] || operations_fail runtime_host_invalid
  operations_runtime_selection_context "$mode"
  volume_identity="$OPS_RUNTIME_VOLUME_IDENTITY"; selected_identifier="$OPS_RUNTIME_SELECTED_IDENTIFIER"; selection_stamp="$OPS_RUNTIME_SELECTION_STAMP"
  for field in FCD_RUNTIME_PROJECT FCD_SUPPORT_REVISION FCD_SUPPORT_IMAGE FCD_POSTGRES_IMAGE FCD_OPERATIONS_IMAGE FCD_POSTGRES_VOLUME FCD_ADMIN_SOCKET_ROOT FCD_CONFIG_ROOT FCD_SECRET_ROOT FCD_HEALTH_TIMEOUT_MS FCD_ADMIN_CPUS FCD_ADMIN_MEMORY_MIB FCD_ADMIN_PIDS; do
    [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || operations_fail runtime_host_invalid
  done
  if [[ "$mode" == runtime ]]; then
    for field in FCD_INGRESS_NETWORK FCD_INGRESS_PEER_ID; do
      [[ -n "${OPS_CONFIG[$field]:-}" ]] && operations_config_field "$field" "${OPS_CONFIG[$field]}" || operations_fail runtime_host_invalid
    done
  fi
  (( ${OPS_CONFIG[FCD_HEALTH_TIMEOUT_MS]} <= 300000 )) || operations_fail runtime_host_invalid
  image="$(operations_docker image inspect --format '{{.Id}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Os}}/{{.Architecture}}/{{.Config.User}}' "${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}")" || operations_fail runtime_host_invalid
  [[ "$image" =~ ^(sha256:[a-f0-9]{64})/([a-f0-9]{40})/linux/amd64/(node|1000|1000:1000)$ && "${BASH_REMATCH[2]}" == "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" ]] || operations_fail runtime_host_invalid
  validator_image="${BASH_REMATCH[1]}"
  model="$(operations_compose runtime --profile '*' config --format json)" || operations_fail runtime_host_invalid
  (( ${#model} <= 1048576 )) || operations_fail runtime_host_invalid
  before="$(operations_runtime_snapshot "$mode")" || operations_fail runtime_host_invalid
  if [[ "$mode" == runtime || -n "$volume_identity" ]]; then
    OPS_DATABASE_SYSTEM_IDENTIFIER="$(operations_read_database_identity 2>/dev/null)" || operations_fail runtime_host_invalid
    [[ -z "$selected_identifier" || "$OPS_DATABASE_SYSTEM_IDENTIFIER" == "$selected_identifier" ]] || operations_fail runtime_host_invalid
    if [[ "$mode" == runtime ]]; then operations_runtime_probes || operations_fail runtime_host_invalid; fi
  fi
  after="$(operations_runtime_snapshot "$mode")" || operations_fail runtime_host_invalid
  operations_runtime_selection_context "$mode"
  [[ "$OPS_RUNTIME_VOLUME_IDENTITY" == "$volume_identity" && "$OPS_RUNTIME_SELECTED_IDENTIFIER" == "$selected_identifier" && "$OPS_RUNTIME_SELECTION_STAMP" == "$selection_stamp" ]] || operations_fail runtime_host_invalid
  [[ -z "$volume_identity" ]] || binding=",\"volumeIdentity\":$volume_identity"
  if [[ "$mode" == bootstrap ]]; then
    payload="$(printf '{"compose":%s,"samples":{"before":%s,"after":%s}%s}' "$model" "$before" "$after" "$binding")"
    arguments=(bootstrap "${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}" "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" "$OPS_ROOT")
  else
    payload="$(printf '{"compose":%s,"samples":{"before":%s,"after":%s,"probes":{"postgresSql":true,"apiHttp":true,"adminSocket":true,"adminNoTcp":true,"replyHeartbeat":true}}%s}' "$model" "$before" "$after" "$binding")"
    arguments=("${OPS_CONFIG[FCD_SUPPORT_REVISION]}" "${OPS_CONFIG[FCD_ADMIN_SOCKET_ROOT]}" "${OPS_CONFIG[FCD_CONFIG_ROOT]}" "${OPS_CONFIG[FCD_SECRET_ROOT]}" "$OPS_ROOT" "${OPS_CONFIG[FCD_INGRESS_PEER_ID]}")
  fi
  result="$({ printf '%s' "$payload" | \
    operations_docker run --rm --interactive --pull never --network none --read-only --user 1000:1000 \
      --label "fcd-support.runtime-inspection=${OPS_CONFIG[FCD_RUNTIME_PROJECT]}" --cap-drop ALL --security-opt no-new-privileges \
      --cpus "${OPS_CONFIG[FCD_ADMIN_CPUS]}" --memory "${OPS_CONFIG[FCD_ADMIN_MEMORY_MIB]}m" --pids-limit "${OPS_CONFIG[FCD_ADMIN_PIDS]}" \
      --entrypoint node "$validator_image" dist/operations/runtime-host-main.js "${arguments[@]}"; } 2>/dev/null)" || operations_fail runtime_host_invalid
  [[ "$result" == '{"status":"verified"}' ]] || operations_fail runtime_host_invalid
  if [[ "$mode" == bootstrap ]]; then printf '%s\n' bootstrap_database_verified; else printf '%s\n' runtime_host_verified; fi
}

operations_inspect_runtime_host() { [[ "$#" == 0 ]] || operations_fail runtime_host_invalid; operations_inspect_host runtime; }
operations_inspect_bootstrap_database() { [[ "$#" == 0 ]] || operations_fail runtime_host_invalid; operations_inspect_host bootstrap; }
