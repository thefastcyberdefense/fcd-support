import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

async function cleanup(fault: string) {
  const directory = await mkdtemp(join(tmpdir(), 'fcd-synthetic-cleanup-'));
  try {
    await mkdir(join(directory, 'state'));
    await writeFile(join(directory, 'state/deployment-state'), 'STATE_PHASE=ready\n');
    const script = `
set -Eeuo pipefail
source "$TASK_CLEANUP"
source "$TASK_NETWORKS"
ci_mode=true; fixture="$TASK_DIRECTORY"; before=''; project=fcd-support-host-test-ci-aaaaaaa
restore_project=fcd-support-restore-host-test-ci-aaaaaaa; revision=${'a'.repeat(40)}
peer=${'b'.repeat(64)}; actor=${'c'.repeat(64)}; net1=${'d'.repeat(64)}; net2=${'e'.repeat(64)}
TASK_IMAGE=sha256:${'f'.repeat(64)}
trace() { printf '%s\\n' "$1" >> "$fixture/trace"; }
snapshot() { :; }
docker() {
 local args="$*" name="" role
 case "$1 $2" in
  'container inspect')
   if [[ "$5" == "$peer" ]]; then printf '%s/%s' "$peer" "$project";
   else printf '%s/%s/postgres/%s/%s' "$actor" "$project" "$revision" "$TASK_IMAGE"; fi ;;
  'ps --all')
   if [[ "$args" == *"volume="* ]]; then [[ "$TASK_FAULT" != inventory ]]; return; fi
   if [[ "$args" == *"com.docker.compose.project=$project" && ! -e "$fixture/actor-removed" ]]; then printf '%s' "$actor"; [[ "$TASK_FAULT" != duplicate-service ]] || printf '\\n%s' "$actor"; fi
   if [[ "$args" == *"synthetic-host-test=$project" && ! -e "$fixture/peer-removed" ]]; then printf '%s' "$peer"; fi ;;
  'network ls')
   [[ "$TASK_FAULT" != query ]] || return 1
   if [[ "$args" == *"project=$restore_project" ]]; then [[ -e "$fixture/$net2" ]] || printf '%s' "$net2";
   else [[ -e "$fixture/$net1" ]] || printf '%s' "$net1"; fi ;;
  'network inspect')
   if [[ "$4" == '{{len .Containers}}' ]]; then printf 0;
   elif [[ "$5" == "$net2" ]]; then printf '%s/%s-data/bridge/local/%s/restore_data/none' "$net2" "$restore_project" "$restore_project";
   else name="$project-ingress"; [[ "$TASK_FAULT" != extra-network ]] || name=synthetic-foreign; printf '%s/%s/bridge/local/none/none/%s' "$net1" "$name" "$project"; fi ;;
  'network rm') trace network; touch "$fixture/$3" ;;
  'image inspect')
   name="\${5:-$3}"
   if [[ -e "$fixture/image-\${name%%:*}" ]]; then return 1; fi
   if [[ "$4" == '{{.Id}}' ]]; then printf '%s' "$TASK_IMAGE";
   elif [[ "$TASK_FAULT" == foreign ]]; then printf '%s/foreign' "$revision";
   else printf '%s/%s' "$revision" "$project"; fi ;;
  'image rm') trace image; touch "$fixture/image-\${3%%:*}" ;;
  'image ls')
   [[ "$args" != *'--filter'* ]] || return 0
   for role in application operations postgres; do
    name="$project-$role"; [[ -e "$fixture/image-$name" ]] || printf '%s:%s\\n' "$name" "$revision"
   done ;;
  'volume inspect')
   name="\${5:-$3}"; [[ ! -e "$fixture/volume-$name" ]] || return 1
   case "$name" in
    "$project-postgres") printf 'local/local/default/%s/postgres-data/none' "$project" ;;
    "$project-backups") printf 'local/local/default/none/none/%s' "$project" ;;
    "$restore_project-data") printf 'local/local/default/%s/restore-data/none' "$restore_project" ;;
    *) return 92 ;;
   esac ;;
  'volume rm') trace volume; [[ "$TASK_FAULT" != remove ]] || return 1; touch "$fixture/volume-$3" ;;
  'volume ls')
   if [[ "$args" != *'--filter'* ]]; then
    for name in "$project-postgres" "$project-backups" "$restore_project-data"; do
     [[ -e "$fixture/volume-$name" ]] || printf '%s\\n' "$name"
    done
   fi ;;
  'rm --force')
   if [[ "$3" == "$peer" ]]; then trace peer; touch "$fixture/peer-removed";
   else trace actor; touch "$fixture/actor-removed"; fi ;;
  *) return 93 ;;
 esac
 return 0
}
synthetic_host_cleanup
printf 'cleanup_completed\\n'
`;
    await writeFile(
      join(directory, 'exercise.sh'),
      script.replace('local args="$*" name="" role', 'local args="$*" name="" role'),
    );
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      ['--noprofile', '--norc', join(directory, 'exercise.sh').replaceAll('\\', '/')],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_DIRECTORY: directory.replaceAll('\\', '/'),
          TASK_FAULT: fault,
          TASK_CLEANUP: resolve('scripts/synthetic-host-cleanup.sh').replaceAll('\\', '/'),
          TASK_NETWORKS: resolve('scripts/synthetic-host-networks.sh').replaceAll('\\', '/'),
        },
      },
    );
    return {
      ...result,
      trace: (await readFile(join(directory, 'trace'), 'utf8').catch(() => '')).trim().split('\n'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('CI cleanup removes only exact owned actors, both network types, volumes and tags', async () => {
  const result = await cleanup('none');
  expect({ status: result.status, stderr: result.stderr }, result.trace.join(',')).toEqual({
    status: 0,
    stderr: '',
  });
  expect(result.stdout).toBe('cleanup_completed\n');
  expect(result.trace).toEqual([
    'peer',
    'actor',
    'volume',
    'volume',
    'volume',
    'network',
    'network',
    'image',
    'image',
    'image',
  ]);
});

test.each(['query', 'remove', 'foreign', 'inventory', 'extra-network', 'duplicate-service'])(
  'CI cleanup refuses %s without claiming success or ignoring failure',
  async (fault) => {
    const result = await cleanup(fault);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('cleanup_completed');
    if (fault === 'extra-network' || fault === 'duplicate-service')
      expect(result.trace).toEqual(['']);
    if (fault === 'query') expect(result.trace).toEqual(['']);
    if (fault === 'inventory') expect(result.trace).not.toContain('volume');
    if (fault === 'remove') expect(result.trace).not.toContain('network');
  },
);
