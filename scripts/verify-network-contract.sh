#!/usr/bin/env bash
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
PROJECT="${1:-}"
PROBE_ALLOWED=0
PROBE_DENIED=0
[[ "$#" == 1 && "$PROJECT" =~ ^fcd-support-phase6-test-[a-z0-9-]+$ ]] || { echo 'network_test_scope_invalid' >&2; exit 1; }
container() {
  local ids
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1")"
  [[ -n "$ids" && "$ids" != *$'\n'* ]] || return 1
  printf '%s' "$ids"
}
ip() {
  docker inspect --format "{{with index .NetworkSettings.Networks \"$PROJECT-$2\"}}{{.IPAddress}}{{end}}" "$(container "$1")"
}
probe() {
  local service="$1" host="$2" port="$3" expected="$4" result=denied
  [[ -n "$host" ]] || { echo 'network_probe_target_missing' >&2; exit 1; }
  if docker exec "$(container "$service")" node -e 'const s=require("net").connect({host:process.argv[1],port:Number(process.argv[2])}); s.on("connect",()=>{s.destroy();process.exit(0)}).on("error",()=>process.exit(1)).setTimeout(1000,()=>{s.destroy();process.exit(1)});' "$host" "$port" >/dev/null 2>&1; then result=allowed; fi
  [[ "$result" == "$expected" ]] || { echo "network_probe_failed=$service:$port:expected-$expected:actual-$result" >&2; exit 1; }
  if [[ "$expected" == allowed ]]; then PROBE_ALLOWED=$((PROBE_ALLOWED + 1)); else PROBE_DENIED=$((PROBE_DENIED + 1)); fi
}
probe fcd-support-api "$(ip postgres webhook-data)" 5432 allowed
probe fcd-support-reply "$(ip postgres reply-data)" 5432 allowed
probe fcd-support-outbound "$(ip postgres outbound-data)" 5432 allowed
probe fcd-support-notification "$(ip postgres notification-data)" 5432 allowed
probe fcd-support-admin "$(ip postgres admin-data)" 5432 allowed
probe fcd-support-reply "$(ip manifest-fake model)" 8080 allowed
probe fcd-support-outbound "$(ip meta-fake provider-egress)" 8080 allowed
probe fcd-support-notification "$(ip n8n-fake notification)" 8080 allowed
probe ingress-probe "$(ip fcd-support-api ingress)" 3003 allowed
probe ingress-probe "$(ip fcd-support-admin management)" 3004 denied
for fake in manifest-fake meta-fake n8n-fake; do
  case "$fake" in manifest-fake) network=model ;; meta-fake) network=provider-egress ;; n8n-fake) network=notification ;; esac
  probe fcd-support-api "$(ip "$fake" "$network")" 8080 denied
done
for worker in fcd-support-reply fcd-support-outbound fcd-support-notification; do
  probe "$worker" "$(ip ingress-probe ingress)" 8080 denied
  probe "$worker" "$(ip fcd-support-api ingress)" 3003 denied
  probe "$worker" "$(ip fcd-support-admin management)" 3004 denied
done
probe ingress-probe "$(ip fcd-support-admin admin-data)" 3004 denied
probe ingress-probe "$(ip fcd-support-admin management)" 3004 denied
probe fcd-support-outbound "$(ip manifest-fake model)" 8080 denied
probe fcd-support-outbound "$(ip n8n-fake notification)" 8080 denied
probe restore-probe "$(ip postgres webhook-data)" 5432 denied
probe restore-probe "$(ip fcd-support-api webhook-data)" 3003 denied
probe restore-probe "$(ip fcd-support-admin management)" 3004 denied
for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
  service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
  bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$id")"
  if [[ "$service" == fcd-support-admin ]]; then
    printf '%s' "$bindings" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const p=JSON.parse(s);if(Object.keys(p).length!==1||p["3004/tcp"]?.length!==1||p["3004/tcp"][0].HostIp!=="127.0.0.1")process.exit(1);});'
    actual="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$id")"
    port="$(printf '%s' "$actual" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const p=JSON.parse(s);if(p["3004/tcp"]?.length!==1||p["3004/tcp"][0].HostIp!=="127.0.0.1"||!/^\d+$/.test(p["3004/tcp"][0].HostPort))process.exit(1);process.stdout.write(p["3004/tcp"][0].HostPort);});')"
    node -e 'fetch("http://127.0.0.1:"+process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));' "$port"
  else
    [[ "$bindings" == '{}' || "$bindings" == null ]] || { echo 'unintended_host_port' >&2; exit 1; }
  fi
done
echo 'network_contract=true'
echo "allowed_paths=$PROBE_ALLOWED"
echo "denied_paths=$PROBE_DENIED"
