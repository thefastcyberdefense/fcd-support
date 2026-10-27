import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('restore abandonment cannot treat a missing volume as proof of emptiness', () => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$TASK_COMMON"; source "$TASK_STATE"; restore_state_field RESTORE_EMPTY_VOLUME_CREATED_AT absent',
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_STATE: resolve('scripts/operations-restore-state.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 1,
    stdout: '',
    stderr: '',
  });
});
