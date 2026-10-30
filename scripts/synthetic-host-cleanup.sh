#!/usr/bin/env bash
# Success-only cleanup for the disposable CI fixture. Never used on a server.
synthetic_host_cleanup() {
  local id owner service revision_label image name facts inventory role source_networks target_networks fixture_networks actual_name driver scope compose logical fixture_label extra expected_compose expected_logical
  local -A seen_services=()
  local -a actors=() networks=()
  [[ "$ci_mode" == true && ! -e "$fixture/state/active-job" && ! -L "$fixture/state/active-job" ]]
  grep -qx STATE_PHASE=ready "$fixture/state/deployment-state"
  [[ "$(docker container inspect --format '{{.Id}}/{{index .Config.Labels "fcd-support.synthetic-host-test"}}' "$peer")" == "$peer/$project" ]]
  # Bind all actor removals to exact IDs, expected services, images and revision.
  for owner in "$project" "$restore_project"; do
    inventory="$(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$owner")"
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      [[ "$id" =~ ^[a-f0-9]{64}$ && ${#actors[@]} -lt 8 ]]
      facts="$(docker container inspect --format '{{.Id}}/{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Image}}' "$id")"
      IFS=/ read -r name image service revision_label facts <<<"$facts"
      [[ "$name" == "$id" && "$image" == "$owner" && "$revision_label" == "$revision" ]]
      [[ -z "${seen_services[$owner/$service]:-}" ]]
      seen_services[$owner/$service]=yes
      case "$owner/$service" in
        "$project/fcd-support-api"|"$project/fcd-support-admin"|"$project/fcd-support-reply"|"$project/fcd-support-outbound"|"$project/fcd-support-notification") role=application ;;
        "$project/postgres"|"$restore_project/postgres") role=postgres ;;
        *) return 1 ;;
      esac
      image="$(docker image inspect --format '{{.Id}}' "$project-$role:$revision")"
      [[ "$facts" == "$image" && "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
      actors+=("$id")
    done <<<"$inventory"
  done
  # Collect only this run's labelled bridges, including CI-precreated bridges.
  source_networks="$(docker network ls --quiet --no-trunc --filter "label=com.docker.compose.project=$project")"
  target_networks="$(docker network ls --quiet --no-trunc --filter "label=com.docker.compose.project=$restore_project")"
  fixture_networks="$(docker network ls --quiet --no-trunc --filter "label=fcd-support.synthetic-host-test=$project")"
  inventory="$(printf '%s\n%s\n%s\n' "$source_networks" "$target_networks" "$fixture_networks" | LC_ALL=C sort -u)"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[a-f0-9]{64}$ && ${#networks[@]} -lt 16 ]]
    facts="$(docker network inspect --format '{{.Id}}/{{.Name}}/{{.Driver}}/{{.Scope}}/{{with index .Labels "com.docker.compose.project"}}{{.}}{{else}}none{{end}}/{{with index .Labels "com.docker.compose.network"}}{{.}}{{else}}none{{end}}/{{with index .Labels "fcd-support.synthetic-host-test"}}{{.}}{{else}}none{{end}}' "$id")"
    IFS=/ read -r name actual_name driver scope compose logical fixture_label extra <<<"$facts"
    [[ "$name" == "$id" && "$driver/$scope" == bridge/local && -z "$extra" ]]
    expected_compose="$project"
    case "$actual_name" in
      "$project-webhook-data") expected_logical=webhook_data ;;
      "$project-admin-data") expected_logical=admin_data ;;
      "$project-reply-data") expected_logical=reply_data ;;
      "$project-outbound-data") expected_logical=outbound_data ;;
      "$project-notification-data") expected_logical=notification_data ;;
      "$project-operations-data") expected_logical=operations_data ;;
      "$project-provider-egress") expected_logical=provider_egress ;;
      "$project-ingress"|"$project-egress") expected_compose=none; expected_logical=none; [[ "$fixture_label" == "$project" ]] ;;
      "$restore_project-data") expected_compose="$restore_project"; expected_logical=restore_data ;;
      *) return 1 ;;
    esac
    [[ "$compose/$logical" == "$expected_compose/$expected_logical" && ( "$fixture_label" == none || "$fixture_label" == "$project" ) ]]
    networks+=("$id")
  done <<<"$inventory"
  docker rm --force "$peer" >/dev/null
  for id in "${actors[@]}"; do docker rm --force "$id" >/dev/null; done
  for name in "$project-postgres" "$project-backups" "$restore_project-data"; do
    facts="$(docker volume inspect --format '{{.Driver}}/{{.Scope}}/{{if .Options}}custom{{else}}default{{end}}/{{with index .Labels "com.docker.compose.project"}}{{.}}{{else}}none{{end}}/{{with index .Labels "com.docker.compose.volume"}}{{.}}{{else}}none{{end}}/{{with index .Labels "fcd-support.synthetic-host-test"}}{{.}}{{else}}none{{end}}' "$name")"
    case "$name" in
      "$project-postgres") [[ "$facts" == "local/local/default/$project/postgres-data/"* ]] ;;
      "$project-backups") [[ "$facts" == "local/local/default/none/none/$project" ]] ;;
      "$restore_project-data") [[ "$facts" == "local/local/default/$restore_project/restore-data/"* ]] ;;
    esac
    inventory="$(docker ps --all --quiet --no-trunc --filter "volume=$name")"
    [[ -z "$inventory" ]]
    docker volume rm "$name" >/dev/null
  done
  for id in "${networks[@]}"; do
    [[ "$(docker network inspect --format '{{len .Containers}}' "$id")" == 0 ]]
    docker network rm "$id" >/dev/null
  done
  for role in application operations postgres; do
    image="$project-$role:$revision"
    [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}/{{index .Config.Labels "fcd-support.synthetic-host-test"}}' "$image")" == "$revision/$project" ]]
    docker image rm "$image" >/dev/null
    synthetic_host_require_absent image "$image"
  done
  for owner in "$project" "$restore_project"; do
    inventory="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$owner")"
    [[ -z "$inventory" ]]
    inventory="$(docker network ls --quiet --filter "label=com.docker.compose.project=$owner")"
    [[ -z "$inventory" ]]
    inventory="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$owner")"
    [[ -z "$inventory" ]]
  done
  inventory="$(docker ps --all --quiet --filter "label=fcd-support.synthetic-host-test=$project")"
    [[ -z "$inventory" ]]
  inventory="$(docker network ls --quiet --filter "label=fcd-support.synthetic-host-test=$project")"
    [[ -z "$inventory" ]]
  inventory="$(docker volume ls --quiet --filter "label=fcd-support.synthetic-host-test=$project")"
    [[ -z "$inventory" ]]
  inventory="$(docker image ls --quiet --filter "label=fcd-support.synthetic-host-test=$project")"
  [[ -z "$inventory" ]]
  for name in "$project-postgres" "$project-backups" "$restore_project-data"; do synthetic_host_require_absent volume "$name"; done
  inventory="$(snapshot)"
  [[ "$inventory" == "$before" ]]
  # Protected journals/logs remain on this disposable runner for diagnosis.
}
