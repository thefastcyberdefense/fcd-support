import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const actor = 'a'.repeat(64);
const reference = `restore_${'b'.repeat(32)}`;

function runGuard(kind: 'source' | 'target', source: string, target: string) {
  return spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `
source "$TASK_COMMON"
source "$TASK_CONTROLLER"
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support [FCD_RESTORE_PROJECT]=fcd-support-restore-test [FCD_RESTORE_VOLUME]=fcd-support-restore-test-data)
OPS_RESTORE_REFERENCE=${reference}; OPS_RESTORE_TARGET_POSTGRES=''
operations_restore_volume() { return 0; }
operations_restore_network() { return 0; }
operations_docker() {
  if [[ "$1" == ps ]]; then printf '%s' '${actor}'; return 0; fi
  if [[ "$*" == *fcd-support.restore.ref* ]]; then printf '%s' '${reference}'; return 0; fi
  if [[ "$*" == *fcd-support-source-postgres* && "$*" == *fcd-support-restore-postgres* ]]; then
    [[ "$TASK_SOURCE" != yes ]] || printf source
    [[ "$TASK_TARGET" != yes ]] || printf target
    return 0
  fi
  if [[ "$*" == *fcd-support-source-postgres* ]]; then printf '%s' "$TASK_SOURCE"; return 0; fi
  if [[ "$*" == *fcd-support-restore-postgres* ]]; then printf '%s' "$TASK_TARGET"; return 0; fi
  return 1
}
if [[ "$TASK_KIND" == source ]]; then operations_restore_source_alias '${actor}'; else operations_restore_target_postgres; fi
`,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_CONTROLLER: resolve('scripts/operations-restore-controller.sh').replaceAll('\\', '/'),
        TASK_KIND: kind,
        TASK_SOURCE: source,
        TASK_TARGET: target,
      },
    },
  ).status;
}

test.each([
  ['correct', 'yes', '', 0],
  ['missing source', '', '', 1],
  ['conflicting target', 'yes', 'yes', 1],
] as const)('source host alias guard rejects %s when unsafe', (_name, source, target, status) => {
  expect(runGuard('source', source, target)).toBe(status);
});

test.each([
  ['correct', '', 'yes', 0],
  ['missing target', '', '', 1],
  ['conflicting source', 'yes', 'yes', 1],
] as const)('target host alias guard rejects %s when unsafe', (_name, source, target, status) => {
  expect(runGuard('target', source, target)).toBe(status);
});
