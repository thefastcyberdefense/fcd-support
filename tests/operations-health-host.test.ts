import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { parseHostHealthSnapshot } from '../src/operations/health-collector.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const revision = 'a'.repeat(40);
const at = '2030-01-01T00:00:00.000Z';
const ids = {
  api: 'a'.repeat(64),
  admin: 'b'.repeat(64),
  reply: 'c'.repeat(64),
  tunnel: 'd'.repeat(64),
};

function collect(fault = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'fcd-health-host-test-'));
  const trace = join(root, 'calls');
  try {
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-test [FCD_SUPPORT_REVISION]=$TASK_REVISION [FCD_INGRESS_PEER_ID]=$TASK_TUNNEL [FCD_HEALTH_TIMEOUT_MS]=6000)
[[ "$TASK_FAULT" != config ]] || OPS_CONFIG[FCD_RUNTIME_PROJECT]='synthetic"injected'
[[ "$TASK_FAULT" != timeout ]] || OPS_CONFIG[FCD_HEALTH_TIMEOUT_MS]=300001
date() { printf '%s\\n' '2030-01-01T00:00:00.000Z'; }
operations_job() { printf 'forbidden-job\\n' >>"$TASK_TRACE"; return 1; }
operations_docker() {
  printf '%s\\n' "$*" >>"$TASK_TRACE"
  local id service key last count=0 state=healthy is_running=true revision="$TASK_REVISION" started=2029-12-31T23:00:00.000Z
  for last; do :; done
  if [[ "$1" == ps ]]; then
    case "$last" in
      *fcd-support-api) service=api; id=$TASK_API ;;
      *fcd-support-admin) service=admin; id=$TASK_ADMIN ;;
      *fcd-support-reply) service=reply; id=$TASK_REPLY ;;
      *) return 1 ;;
    esac
    key="$TASK_ROOT/ps-$service"; [[ ! -f "$key" ]] || read -r count <"$key"
    printf '%s\\n' "$((count+1))" >"$key"
    [[ "$TASK_FAULT" != missing-actor || "$service" != reply ]] || { printf 'synthetic_private_docker_error' >&2; return 1; }
    [[ "$TASK_FAULT" != replaced-actor || "$service" != reply || "$count" == 0 ]] || id=$TASK_OTHER
    printf '%s\\n' "$id"; return 0
  fi
  if [[ "$1 $2" == 'container inspect' ]]; then
    id="$last"; key="$TASK_ROOT/inspect-$id"; [[ ! -f "$key" ]] || read -r count <"$key"
    printf '%s\\n' "$((count+1))" >"$key"
    case "$id" in
      "$TASK_API") service=fcd-support-api ;;
      "$TASK_ADMIN") service=fcd-support-admin ;;
      "$TASK_REPLY") service=fcd-support-reply ;;
      "$TASK_TUNNEL") service=tunnel ;;
      *) return 1 ;;
    esac
    [[ "$TASK_FAULT" != malformed-metadata || "$service" != fcd-support-api ]] || { printf 'synthetic_private_docker_payload'; return 0; }
    [[ "$TASK_FAULT" != missing-health ]] || state=none
    [[ "$TASK_FAULT" != stopped-actor || "$service" != fcd-support-reply ]] || is_running=false
    [[ "$TASK_FAULT" != unhealthy-actor || "$service" != fcd-support-reply ]] || state=unhealthy
    [[ "$TASK_FAULT" != stale-revision || "$service" != fcd-support-reply ]] || revision=$TASK_OLD_REVISION
    [[ "$TASK_FAULT" != changed-metadata || "$service" != fcd-support-api || "$count" == 0 ]] || state=unhealthy
    [[ "$TASK_FAULT" != tunnel-restarted || "$service" != tunnel || "$count" == 0 ]] || started=2030-01-01T00:00:00.000Z
    if [[ "$service" == tunnel ]]; then
      printf '%s|true|false|false|false|%s|%s\\n' "$id" "$state" "$started"
    else
      [[ "$TASK_FAULT" != foreign-service || "$service" != fcd-support-api ]] || service=fcd-support-foreign
      printf '%s|fcd-support-test|%s|%s|%s|false|false|false|%s|%s\\n' "$id" "$service" "$revision" "$is_running" "$state" "$started"
    fi
    return 0
  fi
  if [[ "$1" == exec ]]; then
    case "$2" in
      "$TASK_API") [[ "$TASK_FAULT" != api-unavailable ]] ;;
      "$TASK_ADMIN") [[ "$TASK_FAULT" != socket-unavailable ]] ;;
      "$TASK_REPLY")
        [[ "$TASK_FAULT" != heartbeat-missing ]] || { printf 'synthetic_private_heartbeat' >&2; return 1; }
        [[ "$TASK_FAULT" != heartbeat-invalid ]] || { printf 'healthy|synthetic_private_heartbeat'; return 0; }
        printf 'healthy|2029-12-31T23:59:59.000Z\\n' ;;
      *) return 1 ;;
    esac
    return
  fi
  return 1
}
source "$TASK_LIBRARY"
operations_collect_health_host
`,
      ],
      {
        encoding: 'utf8',
        timeout: 6000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: resolve('scripts/operations-health-host.sh').replaceAll('\\', '/'),
          TASK_TRACE: trace.replaceAll('\\', '/'),
          TASK_ROOT: root.replaceAll('\\', '/'),
          TASK_FAULT: fault,
          TASK_REVISION: revision,
          TASK_OLD_REVISION: 'b'.repeat(40),
          TASK_API: ids.api,
          TASK_ADMIN: ids.admin,
          TASK_REPLY: ids.reply,
          TASK_TUNNEL: ids.tunnel,
          TASK_OTHER: 'e'.repeat(64),
        },
      },
    );
    let calls = '';
    try {
      calls = readFileSync(trace, 'utf8');
    } catch {
      /* Rejected config need not call Docker. */
    }
    return { ...result, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('collects strict host facts from stable exact actors without SQL or provider calls', () => {
  const result = collect();
  expect(result.status, result.stderr).toBe(0);
  const host = parseHostHealthSnapshot(JSON.parse(result.stdout));
  expect(host).toEqual({
    checkedAt: at,
    services: [
      { component: 'webhook', running: true, health: 'healthy', gitRevision: revision },
      {
        component: 'reply',
        running: true,
        health: 'healthy',
        gitRevision: revision,
        heartbeat: { state: 'healthy', checkedAt: '2029-12-31T23:59:59.000Z' },
      },
      { component: 'tunnel', running: true, health: 'healthy', gitRevision: revision },
    ],
    adminSocket: 'healthy',
    manifestAttestation: 'not_verified',
    publicRouteCheck: { state: 'not_verified' },
  });
  expect(result.stderr).toBe('');
  const calls = result.calls.trim().split('\n');
  expect(calls.filter((line) => line.startsWith('ps '))).toHaveLength(6);
  expect(calls.filter((line) => line.startsWith('container inspect '))).toHaveLength(8);
  expect(calls.filter((line) => line.startsWith('exec '))).toHaveLength(3);
  expect(
    calls
      .filter((line) => line.startsWith('ps '))
      .every((line) => line.includes('label=com.docker.compose.project=fcd-support-test')),
  ).toBe(true);
  expect(result.calls).not.toMatch(
    /forbidden-job|\.Config\.Env|\.Mounts|\.HostConfig|pg_|database|manifest|n8n|curl|https:\/\//u,
  );
  expect(result.calls).toContain('readRuntimeHeartbeat');
  expect(result.calls).toContain('admin-socket-health.js');
  expect(result.calls).toContain('6000');
});

test.each([
  'config',
  'timeout',
  'foreign-service',
  'missing-actor',
  'replaced-actor',
  'malformed-metadata',
  'changed-metadata',
  'tunnel-restarted',
  'heartbeat-invalid',
])('omits host evidence safely for %s without exposing transport data', (fault) => {
  const result = collect(fault);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(result.calls).not.toContain('forbidden-job');
});

test.each([
  'api-unavailable',
  'socket-unavailable',
  'heartbeat-missing',
  'missing-health',
  'stale-revision',
  'stopped-actor',
  'unhealthy-actor',
])('reports closed evidence for %s without inventing health', (fault) => {
  const result = collect(fault);
  expect(result.status, result.stderr).toBe(0);
  const host = parseHostHealthSnapshot(JSON.parse(result.stdout));
  expect(host).toBeDefined();
  expect(host?.manifestAttestation).toBe('not_verified');
  expect(host?.publicRouteCheck).toEqual({ state: 'not_verified' });
  if (fault === 'api-unavailable')
    expect(host?.services.find((service) => service.component === 'webhook')?.health).toBe(
      'unavailable',
    );
  if (fault === 'socket-unavailable') expect(host?.adminSocket).toBe('unavailable');
  if (fault === 'heartbeat-missing')
    expect(
      host?.services.find((service) => service.component === 'reply')?.heartbeat,
    ).toBeUndefined();
  if (fault === 'missing-health') {
    expect(host?.services.every((service) => service.health === 'unknown')).toBe(true);
    expect(host?.adminSocket).toBe('unknown');
  }
  if (fault === 'stale-revision') {
    expect(host?.services.find((service) => service.component === 'reply')).toMatchObject({
      gitRevision: 'b'.repeat(40),
    });
    expect(result.calls).not.toContain(`exec ${ids.reply}`);
  }
  if (fault === 'stopped-actor' || fault === 'unhealthy-actor') {
    expect(host?.services.find((service) => service.component === 'reply')).toMatchObject({
      health: 'unavailable',
    });
    expect(result.calls).not.toContain(`exec ${ids.reply}`);
  }
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain('synthetic_private');
});

function collectWithStateRoot(
  setup: (stateRoot: string) => void,
  extraEnv: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'fcd-health-route-test-'));
  const stateRoot = join(root, 'state');
  const scriptDir = root.replaceAll('\\', '/');
  const stateUnix = stateRoot.replaceAll('\\', '/');
  try {
    spawnSync('node', [
      '-e',
      'require("node:fs").mkdirSync(process.argv[1], { mode: 0o700 })',
      stateRoot,
    ]);
    setup(stateRoot);
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-test [FCD_SUPPORT_REVISION]=$TASK_REVISION [FCD_INGRESS_PEER_ID]=$TASK_TUNNEL [FCD_HEALTH_TIMEOUT_MS]=6000 [FCD_STATE_ROOT]="$TASK_STATE")
date() { printf '%s\\n' '2030-01-01T00:00:00.000Z'; }
operations_docker() {
  local last; for last; do :; done
  if [[ "$1" == ps ]]; then
    case "$last" in
      *fcd-support-api) printf '%s\\n' "$TASK_API" ;;
      *fcd-support-admin) printf '%s\\n' "$TASK_ADMIN" ;;
      *fcd-support-reply) printf '%s\\n' "$TASK_REPLY" ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [[ "$1 $2" == 'container inspect' ]]; then
    case "$last" in
      "$TASK_API") printf '%s|fcd-support-test|fcd-support-api|%s|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' "$last" "$TASK_REVISION" ;;
      "$TASK_ADMIN") printf '%s|fcd-support-test|fcd-support-admin|%s|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' "$last" "$TASK_REVISION" ;;
      "$TASK_REPLY") printf '%s|fcd-support-test|fcd-support-reply|%s|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' "$last" "$TASK_REVISION" ;;
      "$TASK_TUNNEL") printf '%s|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' "$last" ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [[ "$1" == exec ]]; then
    [[ "$2" != "$TASK_REPLY" ]] || printf 'healthy|2029-12-31T23:59:59.000Z\\n'
    return 0
  fi
  return 1
}
source "$TASK_LIBRARY"
operations_collect_health_host
`,
      ],
      {
        encoding: 'utf8',
        timeout: 6000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: resolve('scripts/operations-health-host.sh').replaceAll('\\', '/'),
          TASK_STATE: stateUnix,
          TASK_ROOT: scriptDir,
          TASK_REVISION: revision,
          TASK_API: ids.api,
          TASK_ADMIN: ids.admin,
          TASK_REPLY: ids.reply,
          TASK_TUNNEL: ids.tunnel,
          ...extraEnv,
        },
      },
    );
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reads fresh passed or failed publicRouteCheck from state root without network calls', () => {
  for (const [state, checkedAt] of [
    ['passed', '2029-12-31T23:59:30.000Z'],
    ['failed', '2029-12-31T23:59:45.000Z'],
  ] as const) {
    const result = collectWithStateRoot((stateRoot) => {
      spawnSync('node', [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2], { mode: 0o600 })',
        join(stateRoot, 'public-route-check'),
        JSON.stringify({ state, checkedAt }),
      ]);
    });
    expect(result.status, result.stderr).toBe(0);
    const host = parseHostHealthSnapshot(JSON.parse(result.stdout));
    expect(host?.publicRouteCheck).toEqual({ state, checkedAt });
  }
});

test.each([
  ['missing', () => undefined],
  [
    'stale',
    (stateRoot: string) => {
      spawnSync('node', [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2], { mode: 0o600 })',
        join(stateRoot, 'public-route-check'),
        JSON.stringify({ state: 'passed', checkedAt: '2029-12-31T23:58:00.000Z' }),
      ]);
    },
  ],
  [
    'future-skew',
    (stateRoot: string) => {
      spawnSync('node', [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2], { mode: 0o600 })',
        join(stateRoot, 'public-route-check'),
        JSON.stringify({ state: 'passed', checkedAt: '2030-01-01T00:05:00.000Z' }),
      ]);
    },
  ],
  [
    'malformed-json',
    (stateRoot: string) => {
      spawnSync('node', [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "not-json", { mode: 0o600 })',
        join(stateRoot, 'public-route-check'),
      ]);
    },
  ],
  [
    'unknown-field',
    (stateRoot: string) => {
      spawnSync('node', [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2], { mode: 0o600 })',
        join(stateRoot, 'public-route-check'),
        JSON.stringify({ state: 'passed', checkedAt: '2029-12-31T23:59:30.000Z', extra: true }),
      ]);
    },
  ],
] as const)('falls back to publicRouteCheck not_verified when file is %s', (_caseName, setup) => {
  const result = collectWithStateRoot(setup, { OPS_HEALTH_STALE_MS: '60000' });
  expect(result.status, result.stderr).toBe(0);
  const host = parseHostHealthSnapshot(JSON.parse(result.stdout));
  expect(host?.publicRouteCheck).toEqual({ state: 'not_verified' });
});

test('probe-public-route checks webhook reachability and private-route isolation atomically', () => {
  const cases = [
    { statuses: '403,404,404', expected: 'passed' },
    { statuses: '502,404,404', expected: 'failed' },
    { statuses: '403,200,404', expected: 'failed' },
    { statuses: '403,404,302', expected: 'failed' },
  ] as const;

  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), 'fcd-route-probe-test-'));
    try {
      const [wh = '', hl = '', lg = ''] = item.statuses.split(',');
      const res = spawnSync(
        bash,
        [
          '--noprofile',
          '--norc',
          '-c',
          `
date() { printf '%s\\n' '2030-01-01T00:00:00.000Z'; }
operations_probe_fetch_status() {
  case "$1" in
    https://meta.example.invalid/webhooks/meta) printf '%s' '${wh}' ;;
    https://meta.example.invalid/health) printf '%s' '${hl}' ;;
    https://meta.example.invalid/login) printf '%s' '${lg}' ;;
    *) return 1 ;;
  esac
}
source "$TASK_PROBE"
operations_probe_public_route_main https://meta.example.invalid/webhooks/meta "$TASK_STATE" 5000
`,
        ],
        {
          encoding: 'utf8',
          timeout: 6000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_PROBE: resolve('scripts/probe-public-route.sh').replaceAll('\\', '/'),
            TASK_STATE: root.replaceAll('\\', '/'),
          },
        },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'public-route-check'), 'utf8'))).toEqual({
        state: item.expected,
        checkedAt: '2030-01-01T00:00:00.000Z',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('probe-public-route rejects non-https or query-bearing URLs and systemd AF_UNIX stays intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcd-route-probe-reject-'));
  try {
    for (const badUrl of [
      'http://meta.example.invalid/webhooks/meta',
      'https://meta.example.invalid/webhooks/meta?hub.verify_token=secret',
      'https://meta.example.invalid/health',
    ]) {
      const res = spawnSync(
        bash,
        [
          resolve('scripts/probe-public-route.sh').replaceAll('\\', '/'),
          badUrl,
          root.replaceAll('\\', '/'),
          '5000',
        ],
        { encoding: 'utf8', timeout: 6000 },
      );
      expect(res.status).toBe(1);
    }
    const opUnit = readFileSync('infra/systemd/fcd-support-operation@.service', 'utf8');
    expect(opUnit).toContain('RestrictAddressFamilies=AF_UNIX');
    const probeUnit = readFileSync('infra/systemd/fcd-support-route-probe.service', 'utf8');
    expect(probeUnit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6');
    expect(probeUnit).toContain('User=1000');
    expect(probeUnit).not.toMatch(/docker\.sock/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
