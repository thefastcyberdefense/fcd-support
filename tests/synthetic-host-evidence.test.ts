import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['deploy', 'untrusted_stage_value'])(
  'synthetic host report emits only closed evidence for %s',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
    try {
      const log = join(root, 'diagnostic.log');
      await writeFile(
        log,
        'synthetic_untrusted_diagnostic\noperations_revision_invalid\noperations_untrusted_value\n',
      );
      const trace = join(root, 'trace.log');
      await writeFile(
        trace,
        'operations-startup.sh:71:previous=1\nsynthetic_untrusted_value:3:previous=1\n',
      );
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        [
          '-c',
          'source "$TASK_LIBRARY" && synthetic_host_report_failure "$TASK_STAGE" "$TASK_LOG" "$TASK_TRACE"',
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
            TASK_LOG: log.replaceAll('\\', '/'),
            TASK_STAGE: stage,
            TASK_TRACE: trace.replaceAll('\\', '/'),
          },
        },
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: '',
        stderr:
          `synthetic_host_failed=${stage === 'deploy' ? 'deploy' : 'unknown'}\n` +
          'operations_revision_invalid\noperations-startup.sh:71:previous=1\n',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
