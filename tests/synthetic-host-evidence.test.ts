import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['deploy', 'restore', 'untrusted_stage_value'])(
  'synthetic host report emits only closed evidence for %s',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
    try {
      await writeFile(
        join(root, 'active-job'),
        'JOB_SERVICE=restore-reconcile\nJOB_PHASE=uncertain\nJOB_REF=synthetic_private_reference\n',
      );
      await writeFile(
        join(root, 'deployment-state'),
        'STATE_PHASE=quiescent\nSTATE_SYSTEM_IDENTIFIER=synthetic_private_identifier\n',
      );
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
          'source "$TASK_LIBRARY" && synthetic_host_report_failure "$TASK_STAGE" "$TASK_LOG" "$TASK_TRACE" "$TASK_STATE"',
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
            TASK_LOG: log.replaceAll('\\', '/'),
            TASK_STAGE: stage,
            TASK_STATE: root.replaceAll('\\', '/'),
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
          'synthetic_host_job_service=restore-reconcile\nsynthetic_host_job_phase=uncertain\nsynthetic_host_selection_phase=quiescent\n' +
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

test.each(['promote', 'cleanup'])(
  'a failed %s stage emits only closed evidence outside its log',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
    try {
      await mkdir(join(root, 'logs'));
      const source = (
        await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8')
      ).replaceAll('\r\n', '\n');
      const helpers = source.slice(
        source.indexOf('# Closed trace/state evidence'),
        source.indexOf('stage=preflight'),
      );
      const trap = source
        .split('\n')
        .find((line) => line.startsWith('trap ') && line.endsWith(' ERR'));
      const operation = source
        .split('\n')
        .find((line) =>
          stage === 'promote'
            ? line.startsWith('  synthetic_host_run scripts/promote-restore.sh')
            : /^ {2}(?:\( )?synthetic_host_cleanup(?: |$)/u.test(line),
        );
      if (trap === undefined || operation === undefined) throw new Error('synthetic_stage_missing');
      const script = `set -Eeuo pipefail
source "$TASK_LIBRARY"
ci_mode=true; fixture="$TASK_DIRECTORY"; root="$TASK_DIRECTORY"; stage=${stage}
restore_ref=restore_${'a'.repeat(32)}; revision=${'b'.repeat(40)}
bash() { printf 'operations_promotion_refused\\n' >&2; return 1; }
synthetic_host_cleanup() { printf 'synthetic_sensitive_sentinel\\n' >&2; return 1; }
${helpers}
${trap}
${operation}
printf synthetic_unsafe_advancement
`;
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        ['--noprofile', '--norc', '-c', script],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
            TASK_DIRECTORY: root.replaceAll('\\', '/'),
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`synthetic_host_failed=${stage}\n`);
      if (stage === 'promote') expect(result.stderr).toContain('operations_promotion_refused\n');
      expect(result.stderr).not.toContain('synthetic_sensitive_sentinel');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('prioritizes trusted transport failure frames displaced by common or state frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
  try {
    const log = join(root, 'diagnostic.log');
    await writeFile(log, 'operations_promotion_refused\n');
    const trace = join(root, 'trace.log');
    const noise = Array.from(
      { length: 70 },
      (_, i) =>
        `operations-common.sh:${String(i + 1)}:previous=1\noperations-deployment-state.sh:${String(i + 1)}:previous=1\n`,
    ).join('');
    await writeFile(
      trace,
      'operations-job-lifecycle.sh:137:previous=1\n' +
        'synthetic_sentinel_file.sh:1:previous=1\n' +
        'operationRef=operation_0123456789abcdef0123456789abcdef\n' +
        'challenge=0123456789abcdef0123456789abcdef\n' +
        'runtime_host_diagnostic=samples.networks\n'.repeat(80) +
        noise,
    );
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '-c',
        'source "$TASK_LIBRARY" && synthetic_host_report_failure "$TASK_STAGE" "$TASK_LOG" "$TASK_TRACE" "$TASK_STATE"',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
          TASK_LOG: log.replaceAll('\\', '/'),
          TASK_STAGE: 'promote',
          TASK_STATE: root.replaceAll('\\', '/'),
          TASK_TRACE: trace.replaceAll('\\', '/'),
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('synthetic_host_failed=promote\n');
    expect(result.stderr).toContain('operations_promotion_refused\n');
    expect(result.stderr).toContain('operations-job-lifecycle.sh:137:previous=1\n');
    expect(result.stderr).not.toContain('synthetic_sentinel_file');
    expect(result.stderr).not.toContain('operationRef');
    expect(result.stderr).not.toContain('challenge');
    const lines = result.stderr.trim().split('\n');
    expect(
      lines.filter((line) => line === 'runtime_host_diagnostic=samples.networks'),
    ).toHaveLength(1);
    expect(lines.length).toBeLessThanOrEqual(70);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
