export function createMockDocker() {
  return `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TASK_TRACE"
volumes="$TASK_TRACE.volumes"; initializer="$TASK_TRACE.initializer"
case "$1/$2" in
  build/*|compose/*) exit 0 ;;
  network/inspect)
    if [[ "$*" == *Internal* ]]; then printf true;
    elif [[ "$*" == *com.docker.compose.project* ]]; then printf '%s' "$FCD_SYNTHETIC_TEST_PROJECT"; fi; exit 0 ;;
  image/ls|network/ls) exit 0 ;;
  image/inspect)
    if [[ "$*" == *Config.Volumes* ]]; then printf 'no\\n';
    elif [[ "$*" == *'{{.Id}}'* ]]; then printf 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\\n';
    elif [[ "$*" == *revision* ]]; then printf 'a%.0s' {1..40}; printf '\\n'; fi; exit 0 ;;
  create/*)
    if [[ "$*" == *ro-initializer* ]]; then
      previous=''; name=''
      for arg in "$@"; do [[ "$previous" != --name ]] || name="$arg"; previous="$arg"; done
      printf '%s\\n' "$name" > "$initializer"
      printf 'INITIALIZER_CREATE:%s\\n' "$*" >> "$TASK_TRACE"
      printf 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n'
    elif [[ "$*" == *validator* ]]; then printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n';
    elif [[ "$*" == *job* ]]; then printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n';
    else printf 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n'; fi; exit 0 ;;
  start/*)
    : > "$TASK_TRACE.started"
    printf 'INITIALIZER_START\\n' >> "$TASK_TRACE"
    [[ "\${SIMULATE_INITIALIZER_FAILURE:-0}" != 1 ]]; exit $? ;;
  inspect/*)
    if [[ "$*" == *HostConfig.NetworkMode* && -f "$initializer" ]]; then
      name="$(cat "$initializer")"; scope="\${name%-ro-initializer}"; vol="$scope-ro-backups"
      printf 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc//%s/sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/%s/none/true/1/volume/%s//var/lib/fcd-support/ro-backups/true\\n' "$name" "$scope" "$vol"
    elif [[ "$*" == *len\\ .Mounts* ]]; then
      if [[ "$*" == *bbbbbbbb* ]]; then printf '1\\n'; else printf '0\\n'; fi
    elif [[ "$*" == *range\\ .Mounts* ]]; then
      last_vol="$(grep -E '^volume create .* fcd-support-operations-mount-proof' "$TASK_TRACE" | tail -n 1 | awk '{print $NF}')"
      printf 'volume/%s/false\\n' "$last_vol"
    elif [[ "$*" == *fcd-support.operations-mount-proof* ]]; then printf 'fcd-support-operations-mount-proof\\n';
    else exit 1; fi; exit 0 ;;
  volume/create)
    vol="\${!#}"; printf '%s\\n' "$vol" >> "$volumes"; printf '%s\\n' "$vol"; exit 0 ;;
  volume/ls)
    if [[ "\${SIMULATE_COLLISION:-0}" == 1 && "$*" == *ro-backups* ]]; then printf 'synthetic_collision\\n'; exit 0; fi
    [[ -f "$volumes" ]] || exit 0
    if [[ "$*" == *--filter* ]]; then
      pattern="\${!#}"; name="\${pattern#name=^}"; name="\${name%$}"
      grep -Fx -- "$name" "$volumes" || true
    else cat "$volumes"; fi; exit 0 ;;
  volume/inspect)
    vol="\${!#}"
    [[ -f "$volumes" ]] && grep -Fxq -- "$vol" "$volumes" || exit 1
    if [[ "\${SIMULATE_BAD_METADATA:-0}" == 1 && "$vol" == *ro-backups ]]; then printf 'synthetic_wrong_metadata\\n'; exit 0; fi
    scope="\${vol%-ro-backups}"; scope="\${scope%-backups}"; scope="\${scope%-postgres}"
    if [[ "$*" == *fcd-support.operations-mount-proof* ]]; then printf '%s\\n' "\${vol%-archive}";
    elif [[ "$*" == *Options* ]]; then printf '%s/local/local/default/%s\\n' "$vol" "$scope";
    elif [[ "$*" == *Name*Driver*Scope* ]]; then printf '%s/local/local/%s\\n' "$vol" "$scope"; fi; exit 0 ;;
  volume/rm)
    grep -Fvx -- "\${!#}" "$volumes" > "$volumes.next" || true
    mv "$volumes.next" "$volumes"; exit 0 ;;
  ps/--all)
    if [[ "$*" == *--format* ]]; then
      if [[ "\${SIMULATE_INITIALIZER_COLLISION:-0}" == 1 && "$*" == *--filter* ]]; then
        vol="$(tail -n 1 "$volumes")"; printf '%s-ro-initializer\\n' "\${vol%-ro-backups}"
      elif [[ -f "$initializer" ]]; then cat "$initializer"; fi
    elif [[ "$*" == *volume=* ]]; then
      if [[ "\${SIMULATE_CONSUMER:-0}" == 1 && "$*" == *ro-backups* ]]; then printf 'synthetic_foreign_consumer\\n'; fi
      if [[ "\${SIMULATE_CLEANUP_FAILURE:-0}" == 1 && -f "$TASK_TRACE.started" ]]; then printf 'synthetic_cleanup_consumer\\n'; fi
    fi; exit 0 ;;
  rm/*)
    if [[ "$*" == *cccccccc* ]]; then rm -f -- "$initializer"; fi; exit 0 ;;
  run/*) exit 0 ;;
  *) exit 1 ;;
esac
`;
}
