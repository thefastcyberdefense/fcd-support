import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['encode', 'decode', 'bad-image', 'bad-output', 'arguments'])(
  'networkless restore metadata port handles %s with no credentials or writable mounts',
  (mode) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_PORT"
declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_OPERATIONS_IMAGE]=sha256:${'b'.repeat(64)} [FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_SCHEMA_REVISION]=000016 [FCD_RESTORE_CPUS]=0.5 [FCD_RESTORE_MEMORY_MIB]=256 [FCD_RESTORE_PIDS]=64)
operations_docker() {
  if [[ "$1 $2" == 'image inspect' ]]; then [[ "$TASK_MODE" != bad-image ]] || return 19; printf '%s\\n' 'sha256:${'b'.repeat(64)}/${'a'.repeat(40)}/linux/amd64/node'; return; fi
  [[ "$1" == run && "$*" == *'--network none'* && "$*" == *'--read-only'* && "$*" == *'--user 1000:1000'* && "$*" == *'--cap-drop ALL'* && "$*" == *'--security-opt no-new-privileges'* && "$*" != *--mount* && "$*" != *--volume* && "$*" != *--env* && "$*" == *'dist/operations/restore-metadata-main.js'* ]] || return 19
  local input; input="$(cat)"
  [[ "$TASK_MODE" != bad-output ]] || { printf 'unsafe output\\n'; return; }
  if [[ "$TASK_MODE" == decode ]]; then [[ -z "$input" && "$*" == *'decode-fields e30=' ]] || return 19; printf '%s\\n' 'TARGET_SCHEMA=public';
  else [[ "$input" == '{"synthetic":true}' && "$*" == *'encode 7300000000000000001 fcd_support_test public ${'a'.repeat(40)} 000016' ]] || return 19; printf 'e30=\\n'; fi
}
if [[ "$TASK_MODE" == decode ]]; then operations_restore_metadata_decode e30=;
elif [[ "$TASK_MODE" == arguments ]]; then operations_restore_metadata_encode '{}';
else operations_restore_metadata_encode '{"synthetic":true}' 7300000000000000001; fi
`,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_MODE: mode,
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_PORT: resolve('scripts/operations-restore-metadata.sh').replaceAll('\\', '/'),
        },
      },
    );
    if (mode === 'encode' || mode === 'decode')
      expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        code: 0,
        stdout: mode === 'encode' ? 'e30=\n' : 'TARGET_SCHEMA=public\n',
        stderr: '',
      });
    else {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    }
  },
);
