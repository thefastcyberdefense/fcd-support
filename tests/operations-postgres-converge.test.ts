import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const sourceRevision = 'a'.repeat(40),
  targetRevision = 'b'.repeat(40),
  sourceImage = `sha256:${'e'.repeat(64)}`,
  targetImage = `sha256:${'f'.repeat(64)}`;
const reference = `selection_${'a'.repeat(32)}`,
  sourceId = '1'.repeat(64),
  targetId = '2'.repeat(64);

test
  .runIf(native)
  .each([
    'admission',
    'managed',
    'wrong-target-image',
    'applications-remain',
    'wrong-source',
    'source-system',
    'broad-volume',
    'wrong-volume-owner',
    'stop-live',
    'stop-ack',
    'remove-failed',
    'remove-ack',
    'start-failed',
    'start-ack',
    'target-system',
    'host-proof',
    'changed-volume',
    'pending-job',
    'stale-socket',
  ])(
  'PostgreSQL convergence handles %s with durable intent and no application start',
  async (fault) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/postgres-converge-test-');
    await chmod(root, 0o700);
    for (const name of ['state', 'socket', 'config', 'secrets', 'workspace', 'database'])
      await mkdir(join(root, name), { mode: 0o700 });
    await writeFile(join(root, 'state', 'deployment.lock'), '', { mode: 0o600 });
    await writeFile(join(root, 'phase'), 'source-running', { mode: 0o600 });
    await writeFile(join(root, 'fault'), fault, { mode: 0o600 });
    const sourceMode = fault === 'managed' ? 'managed' : 'admission';
    if (fault === 'stale-socket')
      await writeFile(join(root, 'socket', 'admin.sock'), 'synthetic_unresolved_entry', {
        mode: 0o600,
      });
    await writeFile(
      join(root, 'docker'),
      `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; fault="$(<"$scope/fault")"; phase="$(<"$scope/phase")"; last="\${!#}"
id='${sourceId}'; image='${sourceImage}'; revision=none; user=none
[[ '${sourceMode}' != managed ]] || { revision='${sourceRevision}'; user=postgres; }
[[ "$phase" != target ]] || { id='${targetId}'; image='${targetImage}'; revision='${targetRevision}'; user=postgres; }
trace() { printf '%s\\n' "$1" >> "$scope/trace"; }
intent() { grep -qx 'STATE_PHASE=database-changing' "$scope/state/deployment-state" || { trace mutation-before-intent; exit 19; }; }
case " $* " in
  *' compose '*)
    intent; trace create
    [[ "$phase" == absent && "$last" == postgres ]] || { trace unexpected; exit 19; }
    [[ "$fault" != start-failed ]] || exit 19
    printf target > "$scope/phase"; [[ "$fault" != start-ack ]] || exit 19 ;;
  *' image inspect '*)
    if [[ " $* " == *Entrypoint* ]]; then printf '["postgres-entrypoint"]\\n'
    elif [[ "$last" == '${targetImage}' ]]; then
      target='${targetImage}'; [[ "$fault" != wrong-target-image ]] || target='sha256:${'9'.repeat(64)}'
      printf '%s/${targetRevision}/linux/amd64/postgres\\n' "$target"
    else printf '${sourceImage}/%s/linux/amd64/%s\\n' "$revision" "$user"; fi ;;
  *' ps '*)
    if [[ "$phase" != absent ]]; then printf '%s\\n' "$id"; fi
    [[ "$fault" != applications-remain || " $* " == *'service=postgres'* || " $* " == *'volume='* ]] || printf '%s\\n' '${'3'.repeat(64)}' ;;
  *' network inspect '*)
    if [[ " $* " == *'.Containers'* ]]; then printf '%s\\n' "$id"
    else logical="\${last#fcd-support-}"; logical="\${logical//-/_}"; printf '%s/bridge/true/fcd-support/%s\\n' "$last" "$logical"; fi ;;
  *' volume inspect '*)
    if [[ " $* " == *'.CreatedAt'* ]]; then
      created=2030-04-01T00:00:00Z; [[ "$fault" != changed-volume || "$phase" != target ]] || created=2030-04-02T00:00:00Z
      printf 'fcd-support-original/%s/local/local/default/fcd-support/postgres-data\\n' "$created"
    else printf '%s/database\\n' "$scope"; fi ;;
  *' container inspect '*)
    [[ "$phase" != absent && "$last" == "$id" ]] || exit 19
    if [[ " $* " == *'.Config.Cmd'* ]]; then printf '["postgres"]\\n'
    elif [[ " $* " == *Entrypoint* ]]; then printf '["postgres-entrypoint"]\\n'
    elif [[ " $* " == *'.NetworkSettings.Networks'* ]]; then
      if [[ '${sourceMode}' == admission && "$phase" != target ]]; then printf 'fcd-support-data\\n'
      else printf 'fcd-support-%s-data\\n' webhook admin reply outbound notification operations; fi
    elif [[ " $* " == *'.HostConfig.PortBindings'* ]]; then printf '0/false\\n'
    elif [[ " $* " == *'.Mounts'* && " $* " == *'.Name'* ]]; then printf 'fcd-support-original/var/lib/postgresql/true\\n'
    elif [[ " $* " == *'.Mounts'* ]]; then :
    else
      status=running; running=true; [[ "$phase" != source-stopped ]] || { status=exited; running=false; }
      [[ "$fault" != wrong-source ]] || image='sha256:${'9'.repeat(64)}'
      printf '%s/fcd-support/postgres/%s/%s/%s/%s/false/false/false/postgres/2030-04-01T00:00:00Z\\n' "$id" "$revision" "$image" "$status" "$running"
    fi ;;
  *' exec '*)
    if [[ " $* " == *'/usr/bin/stat'* ]]; then
      owner=999; mode=700; [[ "$fault" != broad-volume ]] || mode=1777; [[ "$fault" != wrong-volume-owner ]] || owner=1000
      printf '%s:999:%s\\n999:999:700\\n999:999:700\\n' "$owner" "$mode"
    elif [[ "$fault" == source-system && "$phase" != target || "$fault" == target-system && "$phase" == target ]]; then printf '2222222222222222222\\n'; else printf '1111111111111111111\\n'; fi ;;
  *' stop '*)
    intent; trace stop; [[ "$last" == '${sourceId}' ]] || { trace unexpected; exit 19; }
    [[ "$fault" != stop-live ]] || exit 19
    printf source-stopped > "$scope/phase"; [[ "$fault" != stop-ack ]] || exit 19 ;;
  *' rm '*)
    intent; trace remove; [[ "$last" == '${sourceId}' && "$phase" == source-stopped ]] || { trace unexpected; exit 19; }
    [[ "$fault" != remove-failed ]] || exit 19
    printf absent > "$scope/phase"; [[ "$fault" != remove-ack ]] || exit 19 ;;
  *) trace unexpected; exit 19 ;;
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
OPS_ROOT="$TASK_ROOT/workspace"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT/state" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public
[FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_READY_TIMEOUT_SECONDS]=5 [FCD_ADMIN_SOCKET_ROOT]="$TASK_ROOT/socket"
[FCD_CONFIG_ROOT]="$TASK_ROOT/config" [FCD_SECRET_ROOT]="$TASK_ROOT/secrets" [FCD_POSTGRES_VOLUME]=fcd-support-original
[FCD_SUPPORT_REVISION]=${targetRevision} [FCD_POSTGRES_IMAGE]=${targetImage})
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/state/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
operations_selection_adopt_draining ${reference} fcd-support-original fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${sourceRevision} 000016
operations_selection_quiesce ${reference}
${fault === 'pending-job' ? 'printf synthetic_uncertain_job > "$TASK_ROOT/state/active-job";' : ''}
operations_inspect_bootstrap_database() {
  printf 'proof\\n' >> "$TASK_ROOT/trace"
  [[ "$(<"$TASK_ROOT/phase")" == target && '${fault}' != host-proof && "\${OPS_CONFIG[FCD_POSTGRES_IMAGE]}" == '${targetImage}' ]]
}
operations_converge_postgres ${sourceRevision} ${sourceImage} ${sourceMode} ${targetImage}
`,
        ],
        {
          encoding: 'utf8',
          timeout: 12000,
          env: {
            PATH: root + ':' + (process.env.PATH ?? ''),
            TASK_ROOT: root,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_STATE: resolve('scripts/operations-deployment-state.sh'),
            TASK_LIBRARY: resolve('scripts/operations-postgres.sh'),
          },
        },
      );
      const success = ['admission', 'managed', 'stop-ack', 'remove-ack', 'start-ack'].includes(
        fault,
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: success ? 0 : 1,
        stdout: '',
        stderr: success ? '' : 'operations_postgres_convergence_refused\n',
      });
      const trace = (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(trace).not.toContain('unexpected');
      expect(trace).not.toContain('mutation-before-intent');
      const preflightFault = [
        'wrong-target-image',
        'applications-remain',
        'wrong-source',
        'source-system',
        'broad-volume',
        'wrong-volume-owner',
        'pending-job',
        'stale-socket',
      ].includes(fault);
      if (preflightFault) expect(trace).toEqual([]);
      else expect(trace).toContain('stop');
      const selection = await readFile(join(root, 'state', 'deployment-state'), 'utf8');
      expect(selection).toContain(
        `STATE_PHASE=${success || preflightFault ? 'quiescent' : 'uncertain'}\n`,
      );
      expect(selection).toContain('STATE_VOLUME=fcd-support-original\n');
      expect(selection).toContain('STATE_SYSTEM_IDENTIFIER=1111111111111111111\n');
      expect(selection).toContain('STATE_WRITES_POSSIBLE=yes\n');
      expect(selection).toContain('STATE_SCHEMA_REVISION=000016\n');
      if (success) {
        expect(selection).toContain(`STATE_REVISION=${targetRevision}\n`);
        expect(trace).toEqual(['stop', 'remove', 'create', 'proof', 'proof']);
        expect(await readFile(join(root, 'phase'), 'utf8')).toBe('target');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
