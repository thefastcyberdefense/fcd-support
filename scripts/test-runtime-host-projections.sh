#!/usr/bin/env bash
# Read-only shape checks against only the isolated local synthetic test DB.
# These are not a hardened runtime verification or a deployment gate.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || exit 1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
source scripts/operations-runtime-host.sh
ID="$(docker ps --quiet --no-trunc --filter label=com.docker.compose.project=fcd-support-test --filter label=com.docker.compose.service=postgres)"
[[ "$ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}/{{.Internal}}' fcd-support-test_data)" == fcd-support-test/true ]] || exit 1
check_json() {
  node --input-type=module -e '
    let raw="";for await(const chunk of process.stdin){raw+=chunk;if(raw.length>65536)process.exit(1)}
    try {
      const value=JSON.parse(raw),kind=process.argv[1];
      if(kind==="container") {
        for(const key of ["id","project","service","revision","imageId","running","paused","restarting","dead","healthy","startedAt","restartCount","readOnlyRootfs","privileged","init","user","networkMode","networks","hostPortBindings","publishedPortBindings","publishAllPorts","pidMode","ipcMode","utsMode","capAdd","capDrop","securityOpt","devices","deviceRequests","groupAdd","volumesFrom","extraHosts","sysctls","nanoCpus","memory","pidsLimit","stopTimeout","restartPolicy","tmpfs","command","entrypoint","environmentNames","executionFlags","mounts"])if(!(key in value))throw 0;
        if(value.project!=="fcd-support-test"||value.service!=="postgres"||!Array.isArray(value.networks)||!Array.isArray(value.mounts)||value.environmentNames.some(n=>n.includes("="))||value.executionFlags.some(f=>f!=="invalid"&&!/^(MODEL_EXECUTION_ENABLED|OUTBOUND_EXECUTION_ENABLED|N8N_EXECUTION_ENABLED)=(true|false)$/.test(f)))throw 0;
      }else if(kind==="image") {if(!/^sha256:[a-f0-9]{64}$/.test(value.id)||value.os!=="linux"||value.architecture!=="amd64")throw 0;}
      else if(kind==="network") {if(value.project!=="fcd-support-test"||value.logicalName!=="data"||value.internal!==true)throw 0;}
      else if(kind==="volume") {if(value.project!=="fcd-support-test"||value.logicalName!=="postgres_test_data"||value.driver!=="local"||value.scope!=="local")throw 0;}
      else throw 0;
      process.stdout.write("runtime_"+kind+"_projection=true\n");
    }catch{process.stderr.write("runtime_projection_invalid\n");process.exitCode=1}
  ' "$1"
}
docker container inspect --format "$OPERATIONS_RUNTIME_CONTAINER_FORMAT" "$ID" 2>/dev/null | check_json container
IMAGE="$(docker container inspect --format '{{.Image}}' "$ID")"
docker image inspect --format "$OPERATIONS_RUNTIME_IMAGE_FORMAT" "$IMAGE" 2>/dev/null | check_json image
{ docker network inspect --format "$OPERATIONS_RUNTIME_NETWORK_FORMAT" fcd-support-test_data 2>/dev/null; printf '}'; } | check_json network
VOLUME="$(docker container inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$ID")"
[[ "$VOLUME" == fcd-support-test_postgres_test_data ]] || exit 1
{ docker volume inspect --format "$OPERATIONS_RUNTIME_VOLUME_FORMAT" "$VOLUME" 2>/dev/null; printf '}'; } | check_json volume
