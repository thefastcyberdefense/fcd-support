import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const source = readFileSync('scripts/test-encrypted-backup.sh', 'utf8');
function extractCleanup(text: string): string {
  const match = /^cleanup\(\) \{[\s\S]*?^\}/mu.exec(text);
  if (match === null) throw new Error('synthetic_cleanup_missing');
  return match[0];
}
const cleanup = extractCleanup(source);
const admissionStart = source.includes('# Backup fixture admission.')
  ? source.indexOf('# Backup fixture admission.')
  : source.indexOf('[[ -z "$(docker volume ls');
const admissionEnd = source.includes('created_initializer=')
  ? source.indexOf('created_initializer=')
  : source.indexOf('docker run --rm --name "$RO_INITIALIZER"');
const admission = source.slice(admissionStart, admissionEnd);
const fake = `
SCOPE=synthetic_scope; REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
VOLUME=$SCOPE-backups; RO_VOLUME=$SCOPE-ro-backups; RESTORE_VOLUME=$SCOPE-postgres; RESTORE_NETWORK=$SCOPE-restore
RO_INITIALIZER=$SCOPE-ro-initializer; RO_INITIALIZER_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RO_INITIALIZER_IMAGE=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
RUNNER=synthetic_runner; OPS=synthetic_ops; APP=synthetic_app
CREATED_VOLUMES=("$RO_VOLUME")
docker() {
  printf '%s\\n' "$*" >> "$TASK_TRACE"
  case "$1/$2" in
    ps/--all)
      [[ "\${FAIL_PS:-0}" != 1 ]] || return 13
      if [[ "$*" == *--format* && "\${ACTOR:-0}" == 1 && ! -e "$TASK_TRACE.actor_removed" ]]; then printf '%s\\n' "$RO_INITIALIZER"; fi
      if [[ "$*" == *volume=* && "\${CONSUMER:-0}" == 1 ]]; then printf 'synthetic_foreign_consumer\\n'; fi ;;
    volume/ls)
      [[ "\${FAIL_LIST:-0}" != 1 ]] || return 13
      if [[ "\${VOLUME_PRESENT:-0}" == 1 && ! -e "$TASK_TRACE.volume_removed" ]]; then printf '%s\\n' "$RO_VOLUME"; fi ;;
    volume/create) printf '%s\\n' "\${!#}" ;;
    volume/inspect)
      [[ "\${FAIL_INSPECT:-0}" != 1 ]] || return 13
      if [[ "$*" != *--format* ]]; then [[ "\${VOLUME_PRESENT:-0}" == 1 && "\${!#}" == "$RO_VOLUME" ]] || return 1; fi
      local vol="\${!#}" options=default
      [[ "\${CUSTOM_OPTIONS:-0}" != 1 ]] || options=custom
      if [[ "$*" == *Options* ]]; then printf '%s/local/local/%s/%s\\n' "$vol" "$options" "$SCOPE";
      else printf '%s/local/local/%s\\n' "$vol" "$SCOPE"; fi ;;
    inspect/--format)
      [[ "\${FAIL_INSPECT:-0}" != 1 ]] || return 13
      if [[ "$*" == *'.Image'* ]]; then
        local id="$RO_INITIALIZER_ID" image="$RO_INITIALIZER_IMAGE" mount="$RO_VOLUME"
        [[ "\${BAD_ID:-0}" != 1 ]] || id=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
        [[ "\${BAD_IMAGE:-0}" != 1 ]] || image=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
        [[ "\${BAD_MOUNT:-0}" != 1 ]] || mount=synthetic_foreign_volume
        printf '%s//%s/%s/%s/none/true/1/volume/%s//var/lib/fcd-support/ro-backups/true\\n' "$id" "$RO_INITIALIZER" "$image" "$SCOPE" "$mount"
      elif [[ "$*" == *'.Id'* ]]; then printf '%s/%s\\n' "$RO_INITIALIZER_ID" "$SCOPE";
      else printf '%s\\n' "$SCOPE"; fi ;;
    inspect/*) return 1 ;;
    rm/*) [[ "\${FAIL_RM:-0}" != 1 ]] || return 13; : > "$TASK_TRACE.actor_removed" ;;
    volume/rm) [[ "\${FAIL_RM:-0}" != 1 ]] || return 13; : > "$TASK_TRACE.volume_removed" ;;
    network/ls|image/ls) : ;;
    network/inspect) return 1 ;;
    image/inspect) printf '%s\\n' "$RO_INITIALIZER_IMAGE" ;;
    *) return 1 ;;
  esac
}
`;
async function run(body: string, flags: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'fcd-cleanup-regression-'));
  roots.push(root);
  const trace = join(root, 'trace').replaceAll(String.fromCharCode(92), '/');
  const result = spawnSync(
    bash,
    ['--noprofile', '--norc', '-c', `set -Eeuo pipefail\n${fake}\n${cleanup}\n${body}`],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_TRACE: trace,
        ...flags,
      },
    },
  );
  return { result, trace: await readFile(trace, 'utf8').catch(() => '') };
}

test('Docker inventory failure refuses admission before any initializer write', async () => {
  const { result, trace } = await run(`${admission}\nprintf 'UNSAFE_ROOT_WRITE\\n'`, {
    FAIL_LIST: '1',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('UNSAFE_ROOT_WRITE');
  expect(trace).not.toContain('volume create');
});
test('custom volume options refuse admission before root initialization', async () => {
  const { result } = await run(`${admission}\nprintf 'UNSAFE_ROOT_WRITE\\n'`, {
    CUSTOM_OPTIONS: '1',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('UNSAFE_ROOT_WRITE');
});
test.each(['FAIL_LIST', 'FAIL_PS', 'FAIL_INSPECT'])(
  'cleanup fails closed on %s rather than assuming absence',
  async (flag) => {
    const { result, trace } = await run('cleanup', {
      ACTOR: '1',
      VOLUME_PRESENT: '1',
      [flag]: '1',
    });
    expect(result.status).toBe(1);
    expect(trace).not.toMatch(/^rm /mu);
    expect(trace).not.toMatch(/^volume rm /mu);
  },
);
test.each(['BAD_ID', 'BAD_IMAGE', 'BAD_MOUNT'])(
  'cleanup preserves a substituted initializer: %s',
  async (flag) => {
    const { result, trace } = await run('cleanup', {
      ACTOR: '1',
      VOLUME_PRESENT: '1',
      CONSUMER: '1',
      [flag]: '1',
    });
    expect(result.status).toBe(1);
    expect(trace).not.toMatch(/^rm /mu);
    expect(trace).not.toMatch(/^volume rm /mu);
  },
);
test('cleanup really reaches removal and propagates its failure', async () => {
  const { result, trace } = await run('cleanup', { ACTOR: '1', VOLUME_PRESENT: '1', FAIL_RM: '1' });
  expect(trace).toMatch(/^rm /mu);
  expect(result.status).toBe(1);
});
test('successful cleanup removes only the exact owned initializer and volume', async () => {
  const { result, trace } = await run('cleanup', { ACTOR: '1', VOLUME_PRESENT: '1' });
  expect(result.status, result.stderr).toBe(0);
  expect(trace).toContain(
    'rm --force --volumes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  expect(trace).toContain('volume rm synthetic_scope-ro-backups');
});
