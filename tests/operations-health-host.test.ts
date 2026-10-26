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
