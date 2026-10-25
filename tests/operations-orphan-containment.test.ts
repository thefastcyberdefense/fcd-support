import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  image = `sha256:${'d'.repeat(64)}`,
  cid = 'b'.repeat(64),
  ref = `operation_${'c'.repeat(32)}`;
const command = '["node","dist/operations-main.js","migrate"]';

test
  .runIf(native)
  .each([
    'running',
    'created',
    'exited',
    'stop-ack',
    'remove-ack',
    'wrong-image',
    'wrong-command',
    'wrong-reference',
    'wrong-target',
    'duplicate-field',
    'legacy-image',
    'wrong-user',
    'privileged',
    'host-port',
    'duplicate-actor',
    'stop-live',
    'changed-cookie',
    'journal-changed',
    'selection-changed',
    'wrong-entrypoint',
    'pending',
    'next',
    'missing-actor',
  ])(
  'interrupted job containment handles %s without replay, SQL, journal clear, or application startup',
  async (fault) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/orphan-containment-test-');
    await chmod(root, 0o700);
    await mkdir(join(root, 'state'), { mode: 0o700 });
    await writeFile(join(root, 'state', 'deployment.lock'), '', { mode: 0o600 });
    await writeFile(
      join(root, 'phase'),
      ['created', 'exited'].includes(fault) ? fault : 'running',
      { mode: 0o600 },
    );
    await writeFile(
      join(root, 'docker'),
      `#!/usr/bin/env bash
set -eu
root="$(dirname -- "$0")"
printf '%s\\n' "$*" >> "$root/trace"
case "$1 $2" in
  'image inspect')
    if [[ "$*" == *Entrypoint* ]]; then printf '["docker-entrypoint.sh"]\\n';
    else printf '%s/${revision}/linux/amd64/node/%s\\n' '${image}' '${fault === 'legacy-image' ? '0' : '1'}'; fi ;;
  'ps --all')
    [[ ! -e "$root/removed" && '${fault}' != missing-actor ]] || exit 0
    printf '${cid}\\n'
    [[ '${fault}' != duplicate-actor ]] || printf '${'e'.repeat(64)}\\n' ;;
  'container inspect')
    [[ ! -e "$root/removed" ]] || exit 19
    if [[ "$*" == *Config.Cmd* ]]; then printf '%s\\n' '${fault === 'wrong-command' ? '["node","foreign.js"]' : command}'
    elif [[ "$*" == *Config.Env* ]]; then
      printf '%s\\n' 'OPS_OPERATION_REFERENCE=${fault === 'wrong-reference' ? `operation_${'e'.repeat(32)}` : ref}' 'OPS_DATABASE_SYSTEM_IDENTIFIER=${fault === 'wrong-target' ? '2222222222222222222' : '1111111111111111111'}' 'OPS_DATABASE_NAME=fcd_support' 'OPS_DATABASE_SCHEMA=public' 'OPS_DATABASE_ROLE_PREFIX=fcd_support' 'OPS_SCHEMA_REVISION=000016'
      [[ '${fault}' != duplicate-field ]] || printf 'OPS_OPERATION_REFERENCE=${ref}\\n'
    elif [[ "$*" == *Entrypoint* ]]; then printf '${fault === 'wrong-entrypoint' ? '["foreign-entrypoint"]' : '["docker-entrypoint.sh"]'}\\n'
    elif [[ "$*" == *ReadonlyRootfs* ]]; then
      started=2030-04-01T00:00:00Z
      [[ '${fault}' != changed-cookie || ! -e "$root/stopped" ]] || started=2030-04-02T00:00:00Z
      printf '%s/0/${fault === 'wrong-user' ? 'root' : 'node'}/true/${fault === 'privileged' ? 'true' : 'false'}/${fault === 'host-port' ? '1' : '0'}\\n' "$started"
    else phase="$(cat "$root/phase")"; printf '%s/%s/${revision}/${ref}/fcd-support/migrate/%s/%s/false/false/false/fcd-support-operation-${'c'.repeat(32)}/migrate\\n' '${cid}' '${fault === 'wrong-image' ? `sha256:${'e'.repeat(64)}` : image}' "$(printf '%s' '${command}' | sha256sum | cut -d' ' -f1)" "$phase"; fi ;;
  'container stop')
    touch "$root/stopped"
    [[ '${fault}' != journal-changed ]] || printf 'UNEXPECTED=synthetic\\n' >> "$root/state/active-job"
    [[ '${fault}' != selection-changed ]] || sed -i 's/STATE_SCHEMA_REVISION=000016/STATE_SCHEMA_REVISION=000015/' "$root/state/deployment-state"
    [[ '${fault}' != stop-live ]] || exit 19
    printf exited > "$root/phase"
    [[ '${fault}' != stop-ack ]] || exit 19 ;;
  'container rm')
    touch "$root/removed"
    [[ '${fault}' != remove-ack ]] || exit 19 ;;
  *) exit 29 ;;
esac
`,
      { mode: 0o700 },
    );
    try {
      const result = spawnSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"
source "$TASK_STATE"
source "$TASK_LIBRARY"
OPS_ROOT="$TASK_ROOT"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT/state" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support [FCD_SCHEMA_REVISION]=000016 [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_POSTGRES_VOLUME]=fcd-support-original [FCD_SUPPORT_REVISION]=${revision} [FCD_OPERATIONS_IMAGE]=${image})
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/state/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
operations_selection_adopt_draining selection_${'f'.repeat(32)} fcd-support-original fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${revision} 000016
hash="$(printf '%s' '${command}' | sha256sum | cut -d' ' -f1)"
operations_job_state_begin ${ref} migrate ${image} "$hash"
${fault === 'pending' ? '' : `operations_job_state_transition ${ref} created ${cid}; operations_job_state_transition ${ref} started ${cid}`}
${fault === 'next' ? `printf synthetic_pending > "$TASK_ROOT/state/active-job-${'c'.repeat(32)}.next"` : ''}
operations_contain_interrupted_job
`,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            PATH: root + ':' + (process.env.PATH ?? ''),
            TASK_ROOT: root,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_STATE: resolve('scripts/operations-deployment-state.sh'),
            TASK_LIBRARY: resolve('scripts/operations-orphan-containment.sh'),
          },
        },
      );
      const success = ['running', 'created', 'exited', 'stop-ack', 'remove-ack'].includes(fault);
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: success ? 0 : 1,
        stdout: '',
        stderr: success ? '' : 'operations_job_containment_refused\n',
      });
      const journal = await readFile(join(root, 'state', 'active-job'), 'utf8');
      expect(journal).toContain(`JOB_REF=${ref}\n`);
      expect(journal).toContain(
        `JOB_PHASE=${success || ['stop-live', 'changed-cookie', 'journal-changed', 'selection-changed'].includes(fault) ? 'uncertain' : fault === 'pending' ? 'intent' : 'started'}\n`,
      );
      const trace = await readFile(join(root, 'trace'), 'utf8').catch(() => '');
      expect(trace).not.toMatch(/\b(start|create|exec|logs)\b/u);
      if (success) expect(await readFile(join(root, 'removed'), 'utf8')).toBe('');
      if (
        !success &&
        !['stop-live', 'changed-cookie', 'journal-changed', 'selection-changed'].includes(fault)
      )
        expect(trace).not.toContain('container stop');
      if (['stop-live', 'changed-cookie', 'journal-changed', 'selection-changed'].includes(fault))
        expect(trace).not.toContain('container rm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
