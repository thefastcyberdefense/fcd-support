import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const backupRef = `backup_${'c'.repeat(32)}`;
const jobs = [
  'bootstrap:prepare',
  'backup:pre-migration-backup',
  'verify-backup:verify-backup',
  'migrate:migrate',
  'bootstrap:converge',
  'verify-backup:verify-backup',
];

test.each([
  'ok',
  'pending',
  'metadata',
  'metadata-after',
  'invalid-identity',
  'clock',
  'prepare',
  'backup',
  'bad-reference',
  'verify-before',
  'migrate',
  'converge',
  'verify-after',
  'changed-cluster',
  'changed-container',
  'restarted-postgres',
  'arguments',
])(
  'database bootstrap ordering handles %s without starting applications or replaying a failed phase',
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-bootstrap-order-'));
    const slash = (value: string) => value.replaceAll('\\', '/');
    try {
      if (fault === 'pending')
        await writeFile(join(root, 'active-job'), 'synthetic_unresolved_job\n');
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${'a'.repeat(40)})
OPS_DATABASE_SYSTEM_IDENTIFIER=9999999999999999999
operations_job_state_root() { OPS_JOB_STATE_FILE="$TASK_ROOT/active-job"; }
operations_inspect_bootstrap_database() { printf '%s\\n' metadata >> "$TASK_ROOT/trace"; [[ "$TASK_FAULT" != metadata && ( "$TASK_FAULT" != metadata-after || ! -e "$TASK_ROOT/prepared" ) ]]; }
operations_runtime_id() { if [[ "$TASK_FAULT" == changed-container && -e "$TASK_ROOT/prepared" ]]; then printf '%s\\n' '${'d'.repeat(64)}'; else printf '%s\\n' '${'b'.repeat(64)}'; fi; }
operations_docker() {
  [[ "$#" == 5 && "$1 $2 $3" == 'container inspect --format' ]] || { printf '%s\\n' unexpected_docker >> "$TASK_ROOT/trace"; return 19; }
  if [[ "$TASK_FAULT" == restarted-postgres && -e "$TASK_ROOT/prepared" ]]; then printf '%s/2030-04-01T00:01:00Z\\n' "\${!#}";
  else printf '%s/2030-04-01T00:00:00Z\\n' "\${!#}"; fi
}
operations_compose() { printf '%s\\n' unexpected_compose >> "$TASK_ROOT/trace"; return 19; }
operations_read_database_identity() {
  printf '%s\\n' identity >> "$TASK_ROOT/trace"
  if [[ "$TASK_FAULT" == invalid-identity ]]; then printf '%s\\n' 0;
  elif [[ "$TASK_FAULT" == changed-cluster && -e "$TASK_ROOT/prepared" ]]; then printf '%s\\n' 2222222222222222222; else printf '%s\\n' 1111111111111111111; fi
}
date() { if [[ "$TASK_FAULT" == clock ]]; then printf '%s\\n' synthetic_invalid_clock; else printf '%s\\n' 2030-04-01T00:00:00.000Z; fi; }
operations_execute_job() {
  local service="$1" phase="$2"; shift 2
  printf '%s:%s\\n' "$service" "$phase" >> "$TASK_ROOT/trace"
  [[ "$OPS_DATABASE_SYSTEM_IDENTIFIER" == 1111111111111111111 ]] || return 19
  if [[ "$service:$phase" == bootstrap:prepare ]]; then
    [[ "$#" == 2 && "$1" == 1111111111111111111 && "$2" == /run/secrets ]] || return 19
    [[ "$TASK_FAULT" != prepare ]] || return 19
    : > "$TASK_ROOT/prepared"
  elif [[ "$service" == backup ]]; then
    [[ "$#" == 1 && "$1" == 2030-04-01T00:00:00.000Z ]] || return 19
    [[ "$TASK_FAULT" != backup ]] || return 19
    if [[ "$TASK_FAULT" == bad-reference ]]; then printf '%s\\n' synthetic_invalid_reference; else printf '%s\\n' '${backupRef}'; fi
  elif [[ "$service" == verify-backup ]]; then
    [[ "$#" == 1 && "$1" == '${backupRef}' ]] || return 19
    if [[ -e "$TASK_ROOT/migrated" ]]; then [[ "$TASK_FAULT" != verify-after ]] || return 19;
    else [[ "$TASK_FAULT" != verify-before ]] || return 19; fi
  elif [[ "$service:$phase" == migrate:migrate ]]; then
    [[ "$#" == 0 ]] || return 19
    [[ "$TASK_FAULT" != migrate ]] || return 19
    : > "$TASK_ROOT/migrated"
  elif [[ "$service:$phase" == bootstrap:converge ]]; then
    [[ "$#" == 2 && "$1" == 1111111111111111111 && "$2" == /run/secrets ]] || return 19
    [[ "$TASK_FAULT" != converge ]] || return 19
  else return 19; fi
}
operations_upgrade_database ${fault === 'arguments' ? 'unexpected' : ''}
[[ "$OPS_PRE_MIGRATION_BACKUP_REF" == '${backupRef}' ]] || exit 19
printf '%s\\n' bootstrap_ready
`,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_COMMON: slash(resolve('scripts/operations-common.sh')),
            TASK_LIBRARY: slash(resolve('scripts/operations-bootstrap.sh')),
            TASK_ROOT: slash(root),
            TASK_FAULT: fault,
          },
        },
      );
      expect(result.status).toBe(fault === 'ok' ? 0 : 1);
      expect(result.stdout).toBe(fault === 'ok' ? 'bootstrap_ready\n' : '');
      if (fault === 'ok') expect(result.stderr).toBe('');
      else expect(result.stderr.trim()).toMatch(/^operations_bootstrap_[a-z_]+$/u);
      const trace = await readFile(join(root, 'trace'), 'utf8').catch(() => '');
      expect(trace).not.toContain('unexpected_');
      const actualJobs = trace
        .trim()
        .split('\n')
        .filter((line) => line.includes(':'));
      const prefixCount: Readonly<Record<string, number>> = {
        ok: 6,
        pending: 0,
        metadata: 0,
        'metadata-after': 1,
        'invalid-identity': 0,
        clock: 1,
        prepare: 1,
        backup: 2,
        'bad-reference': 2,
        'verify-before': 3,
        migrate: 4,
        converge: 5,
        'verify-after': 6,
        'changed-cluster': 1,
        'changed-container': 1,
        'restarted-postgres': 1,
        arguments: 0,
      };
      expect(actualJobs).toEqual(jobs.slice(0, prefixCount[fault]));
      if (fault === 'pending' || fault === 'arguments') expect(trace).toBe('');
      if (fault === 'ok') {
        const lines = trace.trim().split('\n');
        for (const [index, line] of lines.entries())
          if (line.includes(':')) expect(lines[index - 1]).toBe('identity');
        expect(lines.at(-1)).toBe('identity');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
