import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('an orphaned operation override blocks empty-target abandonment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-synthetic-orphan-'));
  try {
    await writeFile(join(root, `job-${'a'.repeat(32)}.json`), 'synthetic_job_evidence', {
      mode: 0o600,
    });
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'source "$TASK_COMMON"; source "$TASK_EMPTY"; declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT"); operations_empty_pending_clear',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_ROOT: root.replaceAll('\\', '/'),
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_EMPTY: resolve('scripts/operations-empty-restore.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: '',
      stderr: '',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
