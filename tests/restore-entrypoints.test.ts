import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['restore', 'promote'])(
  '%s entry loads real controllers and proof ports before entering host preflight',
  (action) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source() {
  builtin source "$@" || return
  if [[ "$1" == *operations-common.sh ]]; then
    operations_main() {
      [[ "$1" == "$TASK_ACTION" ]] || return 1
      declare -F operations_restore operations_restore_metadata_encode operations_restore_metadata_decode >/dev/null || return 1
      [[ "$TASK_ACTION" != promote ]] || declare -F operations_promote operations_inspect_promotion_host operations_verify >/dev/null || return 1
      printf '%s\\n' entry_wired
    }
  fi
}
if [[ "$TASK_ACTION" == restore ]]; then set -- backup_${'a'.repeat(32)} checkpoint_${'b'.repeat(32)} ${'c'.repeat(40)} /synthetic/operations.conf;
else set -- restore_${'a'.repeat(32)} ${'c'.repeat(40)} /synthetic/operations.conf; fi
builtin source "$TASK_ENTRY"
`,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_ACTION: action,
          TASK_ENTRY: resolve(
            'scripts',
            action === 'restore' ? 'restore-runtime.sh' : 'promote-restore.sh',
          ).replaceAll('\\', '/'),
        },
      },
    );
    expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 0,
      stdout: 'entry_wired\n',
      stderr: '',
    });
  },
  20000,
);
