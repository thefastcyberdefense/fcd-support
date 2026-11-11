import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockDocker } from './helpers/backup-harness-fixture.js';
import {
  reapChildProcess,
  reapChildProcesses,
  runBoundedCommand,
  waitForBarrier,
} from './helpers/process-lifecycle.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const CHILD_DEADLINE_MS = 3500;
const CHILD_TERM_GRACE_MS = 500;
const CHILD_KILL_GRACE_MS = 500;
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await reapChildProcesses(children.splice(0), {
    termTimeoutMs: CHILD_TERM_GRACE_MS,
    killTimeoutMs: CHILD_KILL_GRACE_MS,
    processGroup: true,
  });
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setupBin(bin: string) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });
  await writeFile(join(bin, 'git'), `#!/bin/bash\nprintf '%s\\n' "${'a'.repeat(40)}"\n`, {
    mode: 0o700,
  });
}

async function runBackupHarness(
  bin: string,
  trace: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = CHILD_DEADLINE_MS,
) {
  const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
  return runBoundedCommand(bash, ['--noprofile', '--norc', scriptPath, 'unit'], {
    timeoutMs,
    termTimeoutMs: CHILD_TERM_GRACE_MS,
    killTimeoutMs: CHILD_KILL_GRACE_MS,
    env: {
      PATH: bin + delimiter + (process.env.PATH ?? ''),
      SystemRoot: process.env.SystemRoot,
      TASK_TRACE: trace.replaceAll('\\', '/'),
      ...extraEnv,
    },
  });
}

describe('test-encrypted-backup harness containment', () => {
  it('refuses before root writes when ro volume name already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const trace = join(root, 'trace');

    await setupBin(bin);

    const result = await runBackupHarness(bin, trace, { SIMULATE_COLLISION: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_backup_volume_collision');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_CREATE:');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_START');
  });

  it('refuses before root writes when ro volume has a foreign consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const trace = join(root, 'trace');

    await setupBin(bin);

    const result = await runBackupHarness(bin, trace, { SIMULATE_CONSUMER: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_backup_volume_foreign_consumer');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_CREATE:');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_START');
  });

  it('refuses before root writes when ro initializer container name collision occurs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const trace = join(root, 'trace');

    await setupBin(bin);

    const result = await runBackupHarness(bin, trace, { SIMULATE_INITIALIZER_COLLISION: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_initializer_collision');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_CREATE:');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_START');
  });

  it('refuses before root writes when volume has invalid metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const trace = join(root, 'trace');

    await setupBin(bin);

    const result = await runBackupHarness(bin, trace, { SIMULATE_BAD_METADATA: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_backup_volume_metadata_invalid');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_CREATE:');
    expect(await readFile(trace, 'utf8')).not.toContain('INITIALIZER_START');
  });

  it('verifies that the ro initializer container uses strict containment flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const trace = join(root, 'trace');

    await setupBin(bin);

    const result = await runBackupHarness(bin, trace);
    expect(result.status).toBe(0);

    const log = await readFile(trace, 'utf8');
    const initializerLine = log.split('\n').find((l) => l.startsWith('INITIALIZER_CREATE:'));
    expect(initializerLine).toBeDefined();
    expect(initializerLine).toContain('--network none');
    expect(initializerLine).toContain('--read-only');
    expect(initializerLine).toContain('--cap-drop ALL');
    expect(initializerLine).toContain('--cap-add CHOWN');
    expect(initializerLine).toContain('--cap-add FOWNER');
    expect(initializerLine).toContain('--cap-add DAC_OVERRIDE');
    expect(initializerLine).toContain('--security-opt no-new-privileges');
    expect(initializerLine).toContain('--cpus 0.25');
    expect(initializerLine).toContain('--memory 128m');
    expect(initializerLine).toContain('--pids-limit 32');
    expect(initializerLine).toMatch(/--name \S+-ro-initializer/);
  });

  it('propagates cleanup failure to gate exit when leftover consumers prevent volume deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const trace = join(root, 'trace');

    await setupBin(bin);

    const result = await runBackupHarness(bin, trace, { SIMULATE_CLEANUP_FAILURE: '1' });

    // Admission and initialization succeeded; only cleanup now sees a consumer.
    expect(result.stderr).not.toContain('volume_foreign_consumer');
    expect(await readFile(trace, 'utf8')).toContain('INITIALIZER_START');
    expect(result.status).toBe(1);
  });
});

it('failed initializer is removed by its exact ID before owned volume cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-failed-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const trace = join(root, 'trace');
  await setupBin(bin);
  const result = await runBackupHarness(bin, trace, { SIMULATE_INITIALIZER_FAILURE: '1' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ro_initializer_failed');
  const log = await readFile(trace, 'utf8');
  expect(log).toContain('INITIALIZER_START');
  expect(log).toContain(
    'rm --force --volumes cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  );
  expect(log).toMatch(/^volume rm .*ro-backups$/mu);
});

it('stalled child harness execution hits bounded deadline and reaps before fixture cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-stall-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const trace = join(root, 'trace');
  await setupBin(bin);
  const start = Date.now();
  await expect(runBackupHarness(bin, trace, { SIMULATE_STALL: '1' }, 1500)).rejects.toThrow(
    /Process exit timed out after 1500ms/u,
  );
  expect(Date.now() - start).toBeLessThan(3500);
  const log = await readFile(trace, 'utf8');
  expect(log).toContain('INITIALIZER_START');
});

it('failed initialization and interrupted barrier paths reap children before fixture cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-reap-'));
  roots.push(root);
  const failedSpawn = spawn('synthetic-missing-harness-bin-xyz', [], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(failedSpawn);
  await expect(waitForBarrier(failedSpawn, 'READY\n', { timeoutMs: 500 })).rejects.toThrow();
  await expect(reapChildProcess(failedSpawn)).resolves.toBeUndefined();

  const hanging = spawn(bash, ['--noprofile', '--norc', '-c', 'sleep 10'], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(hanging);
  const start = Date.now();
  try {
    await expect(waitForBarrier(hanging, 'READY\n', { timeoutMs: 300 })).rejects.toThrow(
      /Process barrier timed out after 300ms/u,
    );
  } finally {
    await reapChildProcess(hanging, {
      termTimeoutMs: CHILD_TERM_GRACE_MS,
      killTimeoutMs: CHILD_KILL_GRACE_MS,
      processGroup: true,
    });
  }
  expect(Date.now() - start).toBeLessThan(2000);
  expect(hanging.stdout.closed).toBe(true);
  expect(hanging.stderr.closed).toBe(true);
  await expect(rm(root, { recursive: true })).resolves.toBeUndefined();
});
