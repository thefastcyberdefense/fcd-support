import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['deploy', 'restore', 'untrusted_stage_value'])(
  'synthetic host report emits only closed evidence for %s',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
    try {
      const log = join(root, 'diagnostic.log');
      await writeFile(
        log,
        'synthetic_untrusted_diagnostic\noperations_restore_refused\noperations_untrusted_value\n',
      );
      const trace = join(root, 'trace.log');
      await writeFile(
        trace,
        'operations-restore-controller.sh:71:previous=1\nsynthetic_untrusted_value:3:previous=1\n' +
          'runtime_host_diagnostic=samples.healthy\n' +
          'runtime_host_diagnostic=samples.synthetic_private_key\n' +
          'runtime_host_diagnostic=synthetic_private_value\n',
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
      const expectedStage = stage === 'untrusted_stage_value' ? 'unknown' : stage;
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: '',
        stderr:
          `synthetic_host_failed=${expectedStage}\n` +
          'operations_restore_refused\noperations-restore-controller.sh:71:previous=1\n' +
          'runtime_host_diagnostic=samples.healthy\n',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('CI trace retains a closed validator refusal through nested stderr suppression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
  try {
    const runner = await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8');
    const entry = /<<'TRACE'\r?\n([\s\S]*?)\r?\nTRACE/u.exec(runner)?.[1];
    if (entry === undefined) throw new Error('synthetic_trace_entry_missing');
    const init = join(root, 'entry.bash');
    const trace = join(root, 'trace.log');
    const log = join(root, 'deployment.log');
    await writeFile(init, entry.replaceAll('\r\n', '\n'));
    await writeFile(log, '');
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '-c',
        `
inspect() {
  local result
  result="$(printf '%s\\n' runtime_host_diagnostic=samples.healthy; exit 1)" || return 1
}
(inspect) >/dev/null 2>&1 || true
synthetic_host_report_failure deploy "$TASK_LOG" "$FCD_SYNTHETIC_TRACE"
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BASH_ENV: init.replaceAll('\\', '/'),
          FCD_SYNTHETIC_TRACE: trace.replaceAll('\\', '/'),
          TASK_LOG: log.replaceAll('\\', '/'),
          FCD_SYNTHETIC_EVIDENCE_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll(
            '\\',
            '/',
          ),
        },
      },
    );
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: '' });
    expect(result.stderr).toContain('runtime_host_diagnostic=samples.healthy\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
