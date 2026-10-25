import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const revision = 'a'.repeat(40),
  app = `sha256:${'d'.repeat(64)}`,
  operations = `sha256:${'e'.repeat(64)}`,
  postgres = `sha256:${'f'.repeat(64)}`;
const backup = `backup_${'b'.repeat(32)}`;

test.each([
  'ok',
  'arguments',
  'ready-input',
  'image',
  'pending',
  'selection',
  'schema',
  'socket',
  'database-proof',
  'identity-before',
  'upgrade',
  'bad-backup',
  'identity-after',
  'started',
  'compose-failed',
  'compose-ack',
  'runtime-proof',
  'containment-failed',
  'sql-proof',
  'succeeded',
  'post-proof',
  'retain',
])('private startup handles %s without bypassing backup, metadata or host proof', async (fault) => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-startup-script-'));
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
OPS_ROOT="$TASK_ROOT"
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000016
[FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support
[FCD_POSTGRES_VOLUME]=fcd-support-selected [FCD_SUPPORT_IMAGE]=${app} [FCD_OPERATIONS_IMAGE]=${operations} [FCD_POSTGRES_IMAGE]=${postgres}
[FCD_READY_TIMEOUT_SECONDS]=5 [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000)
printf quiescent > "$TASK_ROOT/phase"; printf no > "$TASK_ROOT/writes"; printf 000015 > "$TASK_ROOT/schema"
[[ "$TASK_FAULT" != schema ]] || printf 000017 > "$TASK_ROOT/schema"
[[ "$TASK_FAULT" != ready-input ]] || { printf ready > "$TASK_ROOT/phase"; printf yes > "$TASK_ROOT/writes"; }
operations_job_state_root() { OPS_JOB_STATE_FILE="$TASK_ROOT/active-job"; }
operations_selection_read() {
  declare -gA OPS_SELECTION=([STATE_REF]=selection_${'c'.repeat(32)} [STATE_PHASE]="$(<"$TASK_ROOT/phase")" [STATE_VOLUME]=fcd-support-selected
[STATE_SYSTEM_IDENTIFIER]=1111111111111111111 [STATE_REVISION]=${revision} [STATE_SCHEMA_REVISION]="$(<"$TASK_ROOT/schema")" [STATE_WRITES_POSSIBLE]="$(<"$TASK_ROOT/writes")")
  OPS_SELECTION[STATE_DATABASE_NAME]=fcd_support; OPS_SELECTION[STATE_SCHEMA_NAME]=public
  [[ "$TASK_FAULT" != selection ]] || OPS_SELECTION[STATE_REVISION]=${'b'.repeat(40)}
}
operations_selection_starting() {
  [[ "$1/$2/$3" == 'selection_${'c'.repeat(32)}/${revision}/000016' ]] || return 19
  printf starting > "$TASK_ROOT/phase"; printf yes > "$TASK_ROOT/writes"; printf 000016 > "$TASK_ROOT/schema"
  printf 'starting\\n' >> "$TASK_ROOT/trace"
}
operations_selection_ready() { printf ready > "$TASK_ROOT/phase"; printf 'ready\\n' >> "$TASK_ROOT/trace"; }
operations_selection_uncertain() { printf uncertain > "$TASK_ROOT/phase"; }
operations_retain_revision() {
  printf 'retain\\n' >> "$TASK_ROOT/trace"
  [[ "$TASK_FAULT" != retain && "$(<"$TASK_ROOT/phase")" == ready && "$1/$2/$3/$4" == 'selection_${'c'.repeat(32)}/${app}/${operations}/${postgres}' ]]
}
operations_socket_root() { [[ "$TASK_FAULT" != socket ]]; }
operations_docker() {
  [[ "$1 $2" == 'image inspect' ]] || { printf 'unsafe-docker\\n' >> "$TASK_ROOT/trace"; return 19; }
  local ref="\${!#}" role=node; [[ "$ref" != '${postgres}' ]] || role=postgres
  [[ "$TASK_FAULT" != image ]] || return 19
  printf '%s/${revision}/linux/amd64/%s\\n' "$ref" "$role"
}
operations_inspect_bootstrap_database() { printf 'database-proof\\n' >> "$TASK_ROOT/trace"; [[ "$TASK_FAULT" != database-proof ]]; }
operations_read_database_identity() {
  if [[ "$TASK_FAULT" == identity-before || "$TASK_FAULT" == identity-after && -e "$TASK_ROOT/upgraded" ]]; then printf '2222222222222222222\\n'; else printf '1111111111111111111\\n'; fi
}
operations_upgrade_database() {
  printf 'upgrade\\n' >> "$TASK_ROOT/trace"
  [[ "$TASK_FAULT" != upgrade ]] || return 19
  touch "$TASK_ROOT/upgraded"
  OPS_DATABASE_SYSTEM_IDENTIFIER=1111111111111111111; OPS_PRE_MIGRATION_BACKUP_REF='${backup}'
  [[ "$TASK_FAULT" != bad-backup ]] || OPS_PRE_MIGRATION_BACKUP_REF=synthetic_invalid_reference
}
operations_execute_job() {
  [[ "$OPS_DATABASE_SYSTEM_IDENTIFIER" == 1111111111111111111 ]] || return 19
  printf '%s:%s\\n' "$1" "$2" >> "$TASK_ROOT/trace"
  case "$2" in
    deployment-started) [[ "$TASK_FAULT" != started ]] || return 19; touch "$TASK_ROOT/started" ;;
    verify-runtime) [[ "$TASK_FAULT" != sql-proof ]] || return 19 ;;
    deployment-succeeded) [[ "$TASK_FAULT" != succeeded ]] || return 19; touch "$TASK_ROOT/succeeded" ;;
    *) return 19 ;;
  esac
}
operations_job() { printf 'unsafe-untracked-job\\n' >> "$TASK_ROOT/trace"; return 19; }
operations_compose() {
  [[ "\${!#}" == fcd-support-reply && " $* " == *'--no-deps'* && " $* " == *'--no-build'* && " $* " == *'--pull never'* && " $* " != *'outbound'* && " $* " != *'notification'* ]] || return 19
  [[ "$(<"$TASK_ROOT/phase")" == starting && "$(<"$TASK_ROOT/writes")" == yes && -e "$TASK_ROOT/started" ]] || { printf 'unsafe-start\\n' >> "$TASK_ROOT/trace"; return 19; }
  printf 'start\\n' >> "$TASK_ROOT/trace"; touch "$TASK_ROOT/apps"
  [[ "$TASK_FAULT" != compose-failed && "$TASK_FAULT" != compose-ack ]]
}
operations_inspect_runtime_host() {
  printf 'runtime-proof\\n' >> "$TASK_ROOT/trace"
  [[ -e "$TASK_ROOT/apps" && "$TASK_FAULT" != runtime-proof && "$TASK_FAULT" != compose-failed && "$TASK_FAULT" != containment-failed ]] || return 19
  [[ "$TASK_FAULT" != post-proof || ! -e "$TASK_ROOT/succeeded" ]] || return 19
  operations_job migrate verify-runtime
}
operations_contain_private_runtime() {
  [[ "$(<"$TASK_ROOT/phase")" == uncertain && "$1" == '${app}' ]] || return 19
  printf 'contain\\n' >> "$TASK_ROOT/trace"
  [[ "$TASK_FAULT" != containment-failed ]] || return 19
  if [[ -e "$TASK_ROOT/apps" ]]; then touch "$TASK_ROOT/contained"; fi
}
${fault === 'pending' ? 'touch "$TASK_ROOT/active-job";' : ''}
operations_start_private_runtime ${app} ${operations} ${fault === 'arguments' ? '' : postgres}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 6000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_FAULT: fault,
          TASK_ROOT: root.replaceAll('\\', '/'),
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_LIBRARY: resolve('scripts/operations-startup.sh').replaceAll('\\', '/'),
        },
      },
    );
    const success = fault === 'ok' || fault === 'compose-ack';
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: success ? 0 : 1,
      stdout: '',
      stderr: success ? '' : 'operations_startup_refused\n',
    });
    const phases = (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(phases).not.toContain('unsafe-start');
    expect(phases).not.toContain('unsafe-docker');
    expect(phases).not.toContain('unsafe-untracked-job');
    if (success) {
      expect(phases.indexOf('upgrade')).toBeLessThan(phases.indexOf('migrate:deployment-started'));
      expect(phases.indexOf('migrate:deployment-started')).toBeLessThan(phases.indexOf('starting'));
      expect(phases.indexOf('starting')).toBeLessThan(phases.indexOf('start'));
      expect(phases.filter((phase) => phase === 'runtime-proof')).toHaveLength(2);
      expect(phases.filter((phase) => phase === 'migrate:verify-runtime')).toHaveLength(2);
      expect(phases.slice(-2)).toEqual(['ready', 'retain']);
      expect(await readFile(join(root, 'phase'), 'utf8')).toBe('ready');
    } else if (
      ![
        'image',
        'arguments',
        'ready-input',
        'pending',
        'selection',
        'schema',
        'socket',
        'database-proof',
        'identity-before',
        'upgrade',
        'bad-backup',
        'identity-after',
        'started',
      ].includes(fault)
    ) {
      expect(phases).toContain('start');
      expect(await readFile(join(root, 'phase'), 'utf8')).not.toBe('ready');
      expect(phases).toContain('contain');
      expect(
        await readFile(join(root, 'contained'), 'utf8').then(
          () => true,
          () => false,
        ),
      ).toBe(fault !== 'containment-failed');
    } else expect(phases).not.toContain('start');
    if (fault === 'schema') expect(phases).not.toContain('upgrade');
    if (fault === 'ready-input') expect(await readFile(join(root, 'phase'), 'utf8')).toBe('ready');
    if (fault === 'arguments')
      expect(await readFile(join(root, 'phase'), 'utf8')).toBe('quiescent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
