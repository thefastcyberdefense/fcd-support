import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const oldApp = `sha256:${'1'.repeat(64)}`;
const oldOps = `sha256:${'2'.repeat(64)}`;
const oldPg = `sha256:${'3'.repeat(64)}`;
const oldRevision = 'a'.repeat(40);
const currentImage = `sha256:${'b'.repeat(64)}`;

test.each([
  ['none/node', 0],
  ['has_volumes/node', 1],
])(
  'source metadata proof uses the retained application image and refuses image policy %s',
  (policy, status) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_EMPTY"
declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=current [FCD_SUPPORT_IMAGE]=current-app [FCD_OPERATIONS_IMAGE]=${currentImage} [FCD_POSTGRES_IMAGE]=current-pg)
OPS_RESTORE_SOURCE_REVISION=${oldRevision}; OPS_EMPTY_SOURCE_APPLICATION=${oldApp}; OPS_EMPTY_SOURCE_OPERATIONS=${oldOps}; OPS_RESTORE_SOURCE_POSTGRES=${oldPg}
operations_restore_source_quiescent() { return 0; }
operations_docker() { [[ "$1 $2" == 'image inspect' && "$*" == *'${oldApp}'* ]] || return 1; printf '%s\\n' "$TASK_POLICY"; }
operations_inspect_bootstrap_database() { [[ "\${OPS_CONFIG[FCD_SUPPORT_REVISION]}/\${OPS_CONFIG[FCD_SUPPORT_IMAGE]}/\${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}/\${OPS_CONFIG[FCD_POSTGRES_IMAGE]}" == '${oldRevision}/${oldApp}/${oldApp}/${oldPg}' ]]; }
operations_empty_source_proof
[[ "\${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}" == '${currentImage}' ]]
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_EMPTY: resolve('scripts/operations-empty-restore.sh').replaceAll('\\', '/'),
          TASK_POLICY: policy,
        },
      },
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status,
      stdout: '',
      stderr: '',
    });
  },
);
