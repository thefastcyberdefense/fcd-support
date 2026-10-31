import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each([
  'ok',
  'wrong-reference',
  'replay',
  'extra',
  'bad-json',
  'host-refused',
  'host-refused-diagnostics',
  'incomplete',
  'bad-final',
])(
  'live promotion host transport handles %s without accepting stale authority',
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-promotion-pipe-'));
    try {
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"; source "$TASK_JOBS"
declare -A OPS_CONFIG=([FCD_COMMAND_TIMEOUT_SECONDS]=2)
OPS_JOB_REFERENCE=operation_${'a'.repeat(32)}; OPS_JOB_CONTAINER=${'b'.repeat(64)}; OPS_JOB_SERVICE=promote
operations_promotion_host_check() { printf '%s\\n' checked >>"$TASK_ROOT/checks"; [[ "$TASK_FAULT" != host-refused ]]; }
operations_docker() {
  local sequence challenge actual expected reference="$OPS_JOB_REFERENCE" line
  if [[ "$1/$2" == container/logs ]]; then
    printf 'synthetic_sensitive_job_log\\n'
    printf 'logs-requested\\n' >>"$TASK_ROOT/reads"
    return 0
  fi
  [[ "$TASK_FAULT" != wrong-reference ]] || reference=operation_${'c'.repeat(32)}
  for sequence in 1 2; do
    challenge=${'d'.repeat(32)}; [[ "$sequence" == 1 || "$TASK_FAULT" == replay ]] || challenge=${'e'.repeat(32)}
    line="{\\"event\\":\\"promotion_host_check\\",\\"operationRef\\":\\"$reference\\",\\"sequence\\":$sequence,\\"challenge\\":\\"$challenge\\"}"
    [[ "$TASK_FAULT" != extra ]] || line="$line extra"
    [[ "$TASK_FAULT" != bad-json ]] || line=synthetic_bad_json
    printf '%s\\n' "$line"
    IFS= read -r -t 2 actual || return 1
    expected="{\\"event\\":\\"promotion_host_verified\\",\\"operationRef\\":\\"$reference\\",\\"sequence\\":$sequence,\\"challenge\\":\\"$challenge\\"}"
    [[ "$actual" == "$expected" ]] || return 1
    [[ "$TASK_FAULT" != incomplete ]] || return 0
  done
  if [[ "$TASK_FAULT" == bad-final ]]; then printf '%s\\n' '{"status":"completed","processed":0,"reasonCode":"ok"}'; else printf '%s\\n' '{"status":"completed","processed":1,"reasonCode":"ok"}'; fi
}
exec 3>"$TASK_ROOT/diagnostics"
operations_job_start; printf '%s' "$OPS_PROMOTION_ACK"
`,
        ],
        {
          encoding: 'utf8',
          timeout: 12000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_FAULT: fault === 'host-refused-diagnostics' ? 'host-refused' : fault,
            FCD_RUNTIME_HOST_DIAGNOSTICS:
              fault === 'host-refused-diagnostics' ? 'closed-v1' : undefined,
            TASK_ROOT: root.replaceAll('\\', '/'),
            TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
            TASK_JOBS: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
          },
        },
      );
      expect(await readFile(join(root, 'diagnostics'), 'utf8')).toBe('');
      expect(await readFile(join(root, 'reads'), 'utf8').catch(() => '')).toBe('');
      if (fault === 'ok') {
        expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
          code: 0,
          stdout: '{"status":"completed","processed":1,"reasonCode":"ok"}',
          stderr: '',
        });
        expect((await readFile(join(root, 'checks'), 'utf8')).trim().split('\n')).toHaveLength(2);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
