import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const project = 'fcd-support-host-test-p6-aaaaaaa';

function inspect(fault: string, taskProject = project): number | null {
  return spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `
source "$TASK_LIBRARY"
docker() {
  local name role ordinal logical internal id subnet created driver scope options count fixture compose
  if [[ "$1 $2" == 'network inspect' ]]; then
    name="\${!#}"; role="\${name#"$TASK_PROJECT"-}"
    case "$role" in
      webhook-data) ordinal=1; logical=webhook_data;; admin-data) ordinal=2; logical=admin_data;;
      reply-data) ordinal=3; logical=reply_data;; outbound-data) ordinal=4; logical=outbound_data;;
      notification-data) ordinal=5; logical=notification_data;; operations-data) ordinal=6; logical=operations_data;;
      ingress) ordinal=7; logical=none;; egress) ordinal=8; logical=none;; *) return 1;;
    esac
    [[ "$TASK_FAULT" != missing || "$ordinal" != 1 ]] || return 1
    id="$(printf '%064d' "$ordinal")"; subnet="198.18.$((239+ordinal)).0/24"
    created=2030-04-01T00:00:00Z; driver=bridge; scope=local; options=default; count=0
    internal=true; [[ "$ordinal" != 8 ]] || internal=false
    fixture="$TASK_PROJECT"; compose="$TASK_PROJECT"; [[ "$ordinal" -le 6 ]] || compose=none
    if [[ "$ordinal" == 1 ]]; then
      case "$TASK_FAULT" in
        participant) count=1;; wrong_label) fixture=foreign;; wrong_project) compose=foreign;;
        wrong_logical) logical=foreign;; wrong_driver) driver=macvlan;; wrong_scope) scope=swarm;;
        wrong_internal) internal=false;; custom_options) options=custom;;
        multiple_subnets) subnet='198.18.240.0/24,198.18.241.0/24';;
        noncanonical) subnet='198.18.240.1/24';; ipv6) subnet='fd00::/64';;
        duplicate_id) id="$(printf '%064d' 2)";; overlap) subnet='198.18.241.0/25';;
        drift) [[ "\${TASK_PHASE:-before}" != after ]] || created=2030-04-02T00:00:00Z;;
      esac
    fi
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|default|1|%s\\n' "$id" "$name" "$created" "$driver" "$scope" "$internal" "$options" "$count" "$fixture" "$compose" "$logical" "$subnet"
  elif [[ "$1 $2" == 'network ls' ]]; then
    local maximum=8
    [[ "$*" != *'com.docker.compose.project='* ]] || maximum=6
    for ((i=1;i<=maximum;i++)); do printf '%064d\\n' "$i"; done
    if [[ "$TASK_FAULT" == extra_synthetic && "$maximum" == 8 || "$TASK_FAULT" == extra_project && "$maximum" == 6 ]]; then printf '%064d\\n' 9; fi
  else return 1; fi
}
snapshot="$(synthetic_precreated_network_snapshot "$TASK_PROJECT")" || exit 1
[[ "$TASK_FAULT" != drift ]] || export TASK_PHASE=after
synthetic_precreated_network_unchanged "$TASK_PROJECT" "$snapshot"
`,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_PROJECT: taskProject,
        TASK_FAULT: fault,
        TASK_LIBRARY: resolve('scripts/synthetic-host-networks.sh').replaceAll('\\', '/'),
      },
    },
  ).status;
}

test('accepts a stable set of exclusively owned synthetic bridges', () => {
  expect(inspect('none')).toBe(0);
});

test('accepts the dedicated disposable CI project namespace', () => {
  expect(inspect('none', 'fcd-support-host-test-ci-aaaaaaa')).toBe(0);
});

test.each(['network', 'volume', 'image'])(
  'an existing %s is refused before synthetic resource creation',
  (kind) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'source "$TASK_LIBRARY"; docker() { return 0; }; synthetic_host_require_absent "$TASK_KIND" synthetic-test',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_KIND: kind,
          TASK_LIBRARY: resolve('scripts/synthetic-host-networks.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('synthetic_host_resource_exists\n');
  },
);

test('an absent synthetic resource passes the collision check', () => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$TASK_LIBRARY"; docker() { [[ "$2" == ls ]]; }; synthetic_host_require_absent network synthetic-test',
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-networks.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});

test.each([
  {
    title: 'unavailable resource inventory',
    docker: 'return 1',
    error: 'synthetic_host_inventory_unavailable\n',
  },
  {
    title: 'resource listed despite a failed inspection',
    docker: 'if [[ "$2" == ls ]]; then printf "synthetic-test\\n"; else return 1; fi',
    error: 'synthetic_host_resource_exists\n',
  },
])('refuses an $title', ({ docker, error }) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `source "$TASK_LIBRARY"; docker() { ${docker}; }; synthetic_host_require_absent network synthetic-test`,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-networks.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(error);
});

test.each([
  'fcd-support-host-test-p6-aaaaaaa-extra',
  'fcd-support-host-test-p6-abcdefg',
  '../fcd-support-host-test-p6-aaaaaaa',
])('rejects an invalid synthetic project name: %s', (name) => {
  expect(inspect('none', name)).toBe(1);
});

test.each([
  'missing',
  'participant',
  'wrong_label',
  'wrong_project',
  'wrong_logical',
  'wrong_driver',
  'wrong_scope',
  'wrong_internal',
  'custom_options',
  'multiple_subnets',
  'noncanonical',
  'ipv6',
  'duplicate_id',
  'overlap',
  'extra_synthetic',
  'extra_project',
  'drift',
])('refuses unsafe precreated synthetic bridges: %s', (fault) => {
  expect(inspect(fault)).toBe(1);
});
