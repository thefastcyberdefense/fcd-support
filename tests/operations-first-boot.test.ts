import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  app = `sha256:${'b'.repeat(64)}`,
  ops = `sha256:${'c'.repeat(64)}`,
  pg = `sha256:${'d'.repeat(64)}`;

test
  .runIf(native)
  .each([
    'ok',
    'existing-volume',
    'existing-actor',
    'wrong-image',
    'create-failed',
    'create-ack',
    'wrong-volume-ref',
    'start-failed',
    'start-ack',
    'host-proof',
    'changed-system',
    'changed-volume',
    'pending-job',
    'pending-intent',
  ])(
  'first database initialization handles %s with durable intent before creation and no application start',
  async (fault) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/first-boot-test-');
    await chmod(root, 0o700);
    await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
    if (fault === 'pending-job')
      await writeFile(join(root, 'active-job'), 'synthetic_pending', { mode: 0o600 });
    if (fault === 'pending-intent')
      await writeFile(join(root, 'initial-deployment.record'), 'synthetic_pending', {
        mode: 0o600,
      });
    await writeFile(
      join(root, 'docker'),
      `#!/usr/bin/env bash
set -eu
root="$(dirname -- "$0")"
printf '%s\\n' "$1 $2" >> "$root/trace"
case "$1 $2" in
 'image inspect')
  last="\${!#}"; user=node; [[ "$last" != '${pg}' ]] || user=postgres
  printf '%s/%s/linux/amd64/%s\\n' "$last" '${fault === 'wrong-image' ? 'e'.repeat(40) : revision}' "$user" ;;
 'ps --all')
  if [[ '${fault}' == existing-actor || -e "$root/started" ]]; then printf '${'f'.repeat(64)}\\n'; fi ;;
 'volume ls') [[ '${fault}' != existing-volume && ! -e "$root/volume" ]] || printf fcd-support-fresh ;;
 'volume create')
  test -s "$root/initial-deployment.record"
  [[ '${fault}' != create-failed ]] || exit 19
  touch "$root/volume"
  [[ '${fault}' != create-ack ]] || exit 19 ;;
 'volume inspect')
  test -e "$root/volume"
  ref="$(sed -n 's/^INITIAL_REF=//p' "$root/initial-deployment.record")"
  [[ '${fault}' != wrong-volume-ref ]] || ref=selection_${'e'.repeat(32)}
  created=2030-04-01T00:00:00Z
  [[ '${fault}' != changed-volume || ! -e "$root/probed" ]] || created=2030-04-02T00:00:00Z
  printf 'fcd-support-fresh/%s/local/local/default/fcd-support/postgres-data/%s\\n' "$created" "$ref" ;;
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
source "$TASK_LIBRARY"
OPS_ROOT="$TASK_ROOT"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_READY_TIMEOUT_SECONDS]=5 [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support [FCD_POSTGRES_VOLUME]=fcd-support-fresh [FCD_BACKUP_VOLUME]=fcd-support-backups [FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000016 [FCD_SUPPORT_IMAGE]=${app} [FCD_OPERATIONS_IMAGE]=${ops} [FCD_POSTGRES_IMAGE]=${pg})
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
operations_socket_root() { return 0; }
operations_compose() {
  [[ "$*" == 'runtime up --detach --wait --wait-timeout 5 --no-deps --no-build --pull never postgres' ]] || return 1
  printf 'postgres-start\\n' >> "$TASK_ROOT/trace"
  [[ '${fault}' != start-failed ]] || return 1
  touch "$TASK_ROOT/started"
  [[ '${fault}' != start-ack ]]
}
operations_inspect_bootstrap_database() {
  operations_runtime_selection_context bootstrap || return 1
  test -e "$TASK_ROOT/started" && [[ '${fault}' != host-proof ]] || return 1
  touch "$TASK_ROOT/probed"
}
operations_read_database_identity() {
  if [[ '${fault}' == changed-system && -e "$TASK_ROOT/identity-read" ]]; then printf 2222222222222222222;
  else touch "$TASK_ROOT/identity-read"; printf 1111111111111111111; fi
}
operations_initialize_private_database ${app} ${ops} ${pg}
`,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            PATH: root + ':' + (process.env.PATH ?? ''),
            TASK_ROOT: root,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_LIBRARY: resolve('scripts/operations-first-boot.sh'),
          },
        },
      );
      const success = ['ok', 'create-ack', 'start-ack'].includes(fault);
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: success ? 0 : 1,
        stdout: '',
        stderr: success ? '' : 'operations_initialization_refused\n',
      });
      const trace = await readFile(join(root, 'trace'), 'utf8').catch(() => '');
      expect(trace).not.toMatch(/container (start|stop|rm)|volume rm/u);
      if (success) {
        const state = await readFile(join(root, 'deployment-state'), 'utf8');
        expect(state).toContain('STATE_PHASE=quiescent\n');
        expect(state).toContain('STATE_WRITES_POSSIBLE=no\n');
        expect(state).toContain('STATE_SYSTEM_IDENTIFIER=1111111111111111111\n');
        expect(state).toContain('STATE_SCHEMA_REVISION=000000\n');
      } else
        await expect(readFile(join(root, 'deployment-state'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      if (
        [
          'existing-volume',
          'existing-actor',
          'wrong-image',
          'pending-job',
          'pending-intent',
        ].includes(fault)
      )
        expect(trace).not.toContain('volume create');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
