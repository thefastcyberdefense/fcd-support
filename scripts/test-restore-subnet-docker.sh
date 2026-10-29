#!/usr/bin/env bash
# Own only two short-lived, labelled bridges; never prune or alter Docker pools.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/operations-common.sh"
source "$root/scripts/synthetic-host-networks.sh"
source "$root/scripts/operations-restore-controller.sh"
# The deployed controller runs on Linux. Git Bash otherwise rewrites slashes
# inside Docker's Go format arguments after the controller clears the ambient
# environment; retain only this path-conversion flag for the local proof.
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
  operations_docker() {
    local -a endpoint=()
    [[ -z "${OPS_DOCKER_ENDPOINT:-}" ]] || endpoint=(--host "$OPS_DOCKER_ENDPOINT")
    env -i "PATH=$PATH" LC_ALL=C MSYS_NO_PATHCONV=1 timeout --signal=TERM \
      --kill-after="$(( (${OPS_CONFIG[FCD_STOP_GRACE_MS]} + 999) / 1000 ))s" \
      "${OPS_CONFIG[FCD_COMMAND_TIMEOUT_SECONDS]}s" docker "${endpoint[@]}" "$@" 2>/dev/null
  }
fi
scope="fcd-support-restore-subnet-test-$$-$RANDOM"
seed="$scope-seed"
target="$scope-data"
conflict="$scope-conflict"
seed_id=''; target_id=''; conflict_id=''
reference=restore_0123456789abcdef0123456789abcdef
stage=preflight
trap 'printf "restore_subnet_test_failure_stage=%s\n" "$stage" >&2' ERR

remove_owned_empty() {
  local id="$1" name="$2" row
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  row="$(docker network inspect --format '{{.Id}}/{{.Name}}/{{.Driver}}/{{.Internal}}/{{len .Containers}}/{{index .Labels "fcd-support.restore-subnet-test"}}' "$id")" || return 1
  [[ "$row" == "$id/$name/bridge/true/0/$scope" ]] || return 1
  docker network rm "$id" >/dev/null || return 1
  synthetic_host_require_absent network "$name"
}

cleanup() {
  if [[ -n "$conflict_id" ]]; then remove_owned_empty "$conflict_id" "$conflict" || echo restore_subnet_test_cleanup_refused >&2; fi
  if [[ -n "$target_id" ]]; then remove_owned_empty "$target_id" "$target" || echo restore_subnet_test_cleanup_refused >&2; fi
  if [[ -n "$seed_id" ]]; then remove_owned_empty "$seed_id" "$seed" || echo restore_subnet_test_cleanup_refused >&2; fi
}
trap cleanup EXIT

for name in "$seed" "$target" "$conflict"; do synthetic_host_require_absent network "$name"; done
stage=seed
seed_id="$(docker network create --driver bridge --internal --label "fcd-support.restore-subnet-test=$scope" "$seed")"
[[ "$seed_id" =~ ^[a-f0-9]{64}$ ]]
row="$(docker network inspect --format '{{.Id}}/{{.Name}}/{{.Driver}}/{{.Internal}}/{{len .Containers}}/{{index .Labels "fcd-support.restore-subnet-test"}}/{{.IPAM.Driver}}/{{len .IPAM.Config}}/{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$seed_id")"
prefix="$seed_id/$seed/bridge/true/0/$scope/default/1/"
[[ "$row" == "$prefix"* ]]
subnet="${row#"$prefix"}"
operations_restore_subnet_valid "$subnet"
remove_owned_empty "$seed_id" "$seed"
seed_id=''

stage=target
target_id="$(docker network create --driver bridge --internal --subnet "$subnet" --label "fcd-support.restore-subnet-test=$scope" \
  --label "com.docker.compose.project=$scope" --label com.docker.compose.network=restore_data --label "fcd-support.restore.ref=$reference" "$target")"
[[ "$target_id" =~ ^[a-f0-9]{64}$ ]]
row="$(docker network inspect --format '{{.Id}}/{{.Name}}/{{.Driver}}/{{.Internal}}/{{len .Containers}}/{{index .Labels "fcd-support.restore-subnet-test"}}/{{.IPAM.Driver}}/{{len .IPAM.Config}}/{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$target_id")"
[[ "$row" == "$target_id/$target/bridge/true/0/$scope/default/1/$subnet" ]]
stage=controller-proof
declare -A OPS_CONFIG=([FCD_RESTORE_PROJECT]="$scope" [FCD_RESTORE_SUBNET]="$subnet" [FCD_COMMAND_TIMEOUT_SECONDS]=30 [FCD_STOP_GRACE_MS]=1000)
OPS_RESTORE_REFERENCE="$reference"; OPS_RESTORE_NETWORK_STAMP=''
stage=controller-first-proof
operations_restore_network 0
wrong=10.0.0.0/8
[[ "$wrong" != "$subnet" ]] || wrong=192.168.0.0/16
OPS_CONFIG[FCD_RESTORE_SUBNET]="$wrong"
stage=controller-negative-proof
if operations_restore_network 0; then echo restore_subnet_wrong_ipam_accepted >&2; exit 1; fi
OPS_CONFIG[FCD_RESTORE_SUBNET]="$subnet"
stage=controller-repeat-proof
operations_restore_network 0
stage=overlap
if result="$(docker network create --driver bridge --internal --subnet "$subnet" --label "fcd-support.restore-subnet-test=$scope" "$conflict" 2>&1)"; then
  [[ ! "$result" =~ ^[a-f0-9]{64}$ ]] || conflict_id="$result"
  echo restore_subnet_overlap_accepted >&2
  exit 1
fi
[[ "${result,,}" == *overlap* ]]
synthetic_host_require_absent network "$conflict"
stage=cleanup
remove_owned_empty "$target_id" "$target"
target_id=''
printf '%s\n' restore_explicit_subnet_docker=true restore_subnet_controller_proof=true restore_overlapping_subnet_refused=true
