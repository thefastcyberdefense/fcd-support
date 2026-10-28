#!/usr/bin/env bash
# Read-only validation of explicitly prepared synthetic host bridges.
synthetic_precreated_network_invalid() { printf 'synthetic_precreated_network_invalid\n' >&2; return 1; }

synthetic_host_require_absent() {
  local format inventory entry
  [[ "$#" == 2 && ( "$1" == network || "$1" == volume || "$1" == image ) && -n "$2" ]] || { printf 'synthetic_host_resource_invalid\n' >&2; return 1; }
  case "$1" in
    network|volume) format='{{.Name}}' ;;
    image) format='{{.Repository}}:{{.Tag}}' ;;
  esac
  inventory="$(docker "$1" ls --format "$format" 2>/dev/null)" || { printf 'synthetic_host_inventory_unavailable\n' >&2; return 1; }
  while IFS= read -r entry; do
    if [[ "$entry" == "$2" ]]; then
      printf 'synthetic_host_resource_exists\n' >&2
      return 1
    fi
  done <<<"$inventory"
  if docker "$1" inspect "$2" >/dev/null 2>&1; then
    printf 'synthetic_host_resource_exists\n' >&2
    return 1
  fi
}

synthetic_ipv4_range() {
  local cidr="$1" a b c d prefix address mask first last
  [[ "$#" == 1 && "$cidr" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]})); b=$((10#${BASH_REMATCH[2]})); c=$((10#${BASH_REMATCH[3]})); d=$((10#${BASH_REMATCH[4]})); prefix=$((10#${BASH_REMATCH[5]}))
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 && prefix >= 1 && prefix <= 30 )) || return 1
  [[ "$cidr" == "$a.$b.$c.$d/$prefix" ]] || return 1
  address=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  mask=$(( (0xffffffff << (32 - prefix)) & 0xffffffff ))
  first=$(( address & mask )); last=$(( first | (0xffffffff ^ mask) ))
  (( address == first )) || return 1
  printf '%s:%s' "$first" "$last"
}

synthetic_precreated_network_snapshot() {
  local project="$1" role name logical internal compose row id actual_name created driver scope actual_internal options members fixture actual_compose actual_logical ipam count subnet extra range first last other list listed total
  local -a starts=() ends=() roles=(webhook admin reply outbound notification operations ingress egress)
  local -A ids=() compose_ids=() observed=()
  [[ "$#" == 1 && "$project" =~ ^fcd-support-host-test-(p6|ci)-[a-f0-9]{7}$ ]] || { synthetic_precreated_network_invalid; return 1; }
  for role in "${roles[@]}"; do
    name="$project-$role-data"; logical="${role}_data"; internal=true; compose="$project"
    if [[ "$role" == ingress || "$role" == egress ]]; then
      name="$project-$role"; logical=none; compose=none
      [[ "$role" != egress ]] || internal=false
    fi
    row="$(docker network inspect --format '{{.Id}}|{{.Name}}|{{.Created}}|{{.Driver}}|{{.Scope}}|{{.Internal}}|{{if .Options}}{{if eq (len .Options) 2}}{{if and (eq (index .Options "com.docker.network.enable_ipv4") "true") (eq (index .Options "com.docker.network.enable_ipv6") "false")}}default{{else}}custom{{end}}{{else}}custom{{end}}{{else}}default{{end}}|{{len .Containers}}|{{with index .Labels "fcd-support.synthetic-host-test"}}{{.}}{{else}}none{{end}}|{{with index .Labels "com.docker.compose.project"}}{{.}}{{else}}none{{end}}|{{with index .Labels "com.docker.compose.network"}}{{.}}{{else}}none{{end}}|{{.IPAM.Driver}}|{{len .IPAM.Config}}|{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$name" 2>/dev/null)" || { synthetic_precreated_network_invalid; return 1; }
    IFS='|' read -r id actual_name created driver scope actual_internal options members fixture actual_compose actual_logical ipam count subnet extra <<<"$row"
    [[ -z "$extra" && "$id" =~ ^[a-f0-9]{64}$ && "$actual_name" == "$name" &&
      "$created" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$ &&
      "$driver/$scope/$actual_internal/$options/$members" == "bridge/local/$internal/default/0" &&
      "$fixture/$actual_compose/$actual_logical/$ipam/$count" == "$project/$compose/$logical/default/1" && -z "${ids[$id]+present}" ]] || { synthetic_precreated_network_invalid; return 1; }
    range="$(synthetic_ipv4_range "$subnet")" || { synthetic_precreated_network_invalid; return 1; }
    first="${range%:*}"; last="${range#*:}"
    for other in "${!starts[@]}"; do
      (( last < starts[other] || first > ends[other] )) || { synthetic_precreated_network_invalid; return 1; }
    done
    starts+=("$first"); ends+=("$last"); ids[$id]=yes
    [[ "$compose" == none ]] || compose_ids[$id]=yes
    printf '%s\n' "$row"
  done
  for role in synthetic compose; do
    if [[ "$role" == synthetic ]]; then
      list="$(docker network ls --quiet --no-trunc --filter "label=fcd-support.synthetic-host-test=$project" 2>/dev/null)" || { synthetic_precreated_network_invalid; return 1; }
      count=8
    else
      list="$(docker network ls --quiet --no-trunc --filter "label=com.docker.compose.project=$project" 2>/dev/null)" || { synthetic_precreated_network_invalid; return 1; }
      count=6
    fi
    observed=(); total=0
    while IFS= read -r listed; do
      [[ -n "$listed" ]] || continue
      [[ "$listed" =~ ^[a-f0-9]{64}$ && -n "${ids[$listed]:-}" && -z "${observed[$listed]+present}" ]] || { synthetic_precreated_network_invalid; return 1; }
      [[ "$role" != compose || -n "${compose_ids[$listed]:-}" ]] || { synthetic_precreated_network_invalid; return 1; }
      observed[$listed]=yes; total=$((total + 1))
    done <<<"$list"
    [[ "$total" == "$count" ]] || { synthetic_precreated_network_invalid; return 1; }
  done
}

synthetic_precreated_network_unchanged() {
  local current
  [[ "$#" == 2 ]] || { synthetic_precreated_network_invalid; return 1; }
  current="$(synthetic_precreated_network_snapshot "$1")" || return 1
  [[ "$current" == "$2" ]] || { synthetic_precreated_network_invalid; return 1; }
}
