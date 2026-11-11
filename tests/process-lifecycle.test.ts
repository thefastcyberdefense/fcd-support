import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureProcessTreeOwnership,
  reapChildProcess,
  reapChildProcesses,
  runBoundedCommand,
  waitForBarrier,
  waitForExit,
  type WinTreeTestOps,
} from './helpers/process-lifecycle.js';

describe('process-lifecycle helper', () => {
  it('resolves when barrier is emitted in a single chunk', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      await waitForBarrier(child, 'READY\n', { timeoutMs: 2000 });
      expect(child.exitCode).toBeNull();
    } finally {
      await reapChildProcess(child);
    }
  });

  it('resolves when barrier is split across multiple chunks', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write("REA"); setTimeout(() => process.stdout.write("DY\\n"), 50); setInterval(() => {}, 1000);',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      await waitForBarrier(child, 'READY\n', { timeoutMs: 2000 });
      expect(child.exitCode).toBeNull();
    } finally {
      await reapChildProcess(child);
    }
  });

  it('rejects with timeout when child is silent within internal deadline', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const start = Date.now();
    try {
      await expect(waitForBarrier(child, 'READY\n', { timeoutMs: 200 })).rejects.toThrow(
        /Process barrier timed out/i,
      );
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1500);
    } finally {
      await reapChildProcess(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  });

  it('rejects when child exits prematurely before emitting barrier', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0);'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await expect(waitForBarrier(child, 'READY\n', { timeoutMs: 2000 })).rejects.toThrow(
        /Process exited prematurely/i,
      );
    } finally {
      await reapChildProcess(child);
    }
  });

  it('rejects when child exits prematurely with error code before barrier', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'console.error("fatal failure"); process.exit(42);'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      await expect(waitForBarrier(child, 'READY\n', { timeoutMs: 2000 })).rejects.toThrow(
        /Process exited prematurely with code 42/i,
      );
    } finally {
      await reapChildProcess(child);
    }
  });

  it('handles failed spawn gracefully without waiting for exit in reap', async () => {
    const child = spawn('synthetic-nonexistent-command-fail-spawn-xyz');
    try {
      await expect(waitForBarrier(child, 'READY\n', { timeoutMs: 500 })).rejects.toThrow();
    } finally {
      const reapStart = Date.now();
      await reapChildProcess(child, { termTimeoutMs: 500, killTimeoutMs: 500 });
      expect(Date.now() - reapStart).toBeLessThan(500);
    }
  });

  it('waits for process exit and returns exit code within deadline', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50);'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const result = await waitForExit(child, { timeoutMs: 2000 });
      expect(result.code).toBe(0);
    } finally {
      await reapChildProcess(child);
    }
  });

  it('waitForExit rejects if child exceeds deadline', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await expect(waitForExit(child, { timeoutMs: 200 })).rejects.toThrow(
        /Process exit timed out/i,
      );
    } finally {
      await reapChildProcess(child);
    }
  });

  it('reaps a child that ignores SIGTERM by escalating to SIGKILL', async () => {
    // Child ignores SIGTERM
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Wait briefly for child to be up
    await new Promise((r) => setTimeout(r, 100));
    const start = Date.now();
    await reapChildProcess(child, { termTimeoutMs: 200, killTimeoutMs: 500 });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('reapChildProcesses reaps multiple children in parallel', async () => {
    const children: ChildProcess[] = [
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ];
    await reapChildProcesses(children, { termTimeoutMs: 300, killTimeoutMs: 300 });
    for (const child of children) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  });
});

function unreapableChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 99999999,
    exitCode: null,
    signalCode: null,
    kill: () => false,
    stdin: { destroy: () => undefined },
    stdout: { destroy: () => undefined },
    stderr: { destroy: () => undefined },
  }) as unknown as ChildProcess;
}

it('refuses cleanup success when the owned child survives both termination deadlines', async () => {
  await expect(
    reapChildProcess(unreapableChild(), { termTimeoutMs: 1, killTimeoutMs: 1 }),
  ).rejects.toThrow('test_child_reap_unconfirmed');
});

it('propagates a failed reap after attempting every owned child', async () => {
  await expect(
    reapChildProcesses([unreapableChild(), unreapableChild()], {
      termTimeoutMs: 1,
      killTimeoutMs: 1,
    }),
  ).rejects.toThrow('test_child_reap_unconfirmed');
});

it.skipIf(process.platform === 'win32')(
  'reaps an owned descendant retaining stdio after its parent exits',
  async () => {
    const code = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("DESCENDANT_READY"+String.fromCharCode(10));setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await waitForBarrier(child, 'DESCENDANT_READY\n', { timeoutMs: 2000 });
    } finally {
      await reapChildProcess(child, {
        termTimeoutMs: 100,
        killTimeoutMs: 1000,
        processGroup: true,
      });
    }
    expect(child.stdout.closed).toBe(true);
    expect(child.stderr.closed).toBe(true);
  },
);

it('reaps an owned shell process tree retaining stdio on stall within bounded deadline', async () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const child = spawn(bash, ['--noprofile', '--norc', '-c', 'sleep 10'], {
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const start = Date.now();
  await expect(waitForExit(child, { timeoutMs: 200 })).rejects.toThrow(/Process exit timed out/);
  await reapChildProcess(child, {
    termTimeoutMs: 500,
    killTimeoutMs: 500,
    processGroup: true,
  });
  expect(Date.now() - start).toBeLessThan(2000);
  expect(child.stdout.closed).toBe(true);
  expect(child.stderr.closed).toBe(true);
});

it('reaps an owned shell process tree retaining stdio after fork/exec under set -Eeuo pipefail', async () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const child = spawn(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      'set -Eeuo pipefail\nx="$(printf ok)"\nprintf "READY\\n"\nsleep 10\n',
    ],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const start = Date.now();
  try {
    await waitForBarrier(child, 'READY\n', { timeoutMs: 1500 });
    await expect(waitForExit(child, { timeoutMs: 150 })).rejects.toThrow(/Process exit timed out/);
  } finally {
    await reapChildProcess(child, {
      termTimeoutMs: 500,
      killTimeoutMs: 500,
      processGroup: true,
    });
  }
  expect(Date.now() - start).toBeLessThan(3000);
  expect(child.stdout.closed).toBe(true);
  expect(child.stderr.closed).toBe(true);
});

function findTestMsysTools(): { psPath: string; killPath: string } | null {
  const dirs = [
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files (x86)\\Git\\usr\\bin',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry.length > 0)
      .flatMap((entry) => [entry, join(entry, '..', 'usr', 'bin')]),
  ];
  for (const dir of dirs) {
    const psPath = join(dir, 'ps.exe');
    const killPath = join(dir, 'kill.exe');
    if (existsSync(psPath) && existsSync(killPath)) return { psPath, killPath };
  }
  return null;
}

function readNumericMsysRows(psPath: string): { pid: number; pgid: number; winPid: number }[] {
  const stdout = execFileSync(psPath, ['-lW'], { encoding: 'utf8', windowsHide: true });
  const rows: { pid: number; pgid: number; winPid: number }[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+\d+\s+(\d+)\s+(\d+)\s+/u.exec(line);
    if (match !== null) {
      rows.push({
        pid: Number(match[1]),
        pgid: Number(match[2]),
        winPid: Number(match[3]),
      });
    }
  }
  return rows;
}

function forceKillMsysPids(killPath: string, pids: number[]) {
  if (pids.length === 0) return;
  try {
    execFileSync(killPath, ['-f', '-s', 'KILL', '--', ...pids.map(String)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // Already exited.
  }
}

it.skipIf(process.platform !== 'win32')(
  'enforces one shared cleanup deadline across tree inspection, signal waits, and escalation',
  async () => {
    const start = Date.now();
    await expect(
      reapChildProcess(unreapableChild(), {
        termTimeoutMs: 350,
        killTimeoutMs: 350,
        processGroup: true,
      }),
    ).rejects.toThrow('test_child_reap_unconfirmed');
    expect(Date.now() - start).toBeLessThan(760);
  },
);

it('shares one cleanup budget across runBoundedCommand post-exit drain and process-group reap', async () => {
  const start = Date.now();
  const descendantCode = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  const rootCode = `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: ["ignore", "inherit", "inherit"] });
setTimeout(() => process.exit(0), 500);`;
  const result = await runBoundedCommand(process.execPath, ['-e', rootCode], {
    timeoutMs: 750,
    termTimeoutMs: 350,
    killTimeoutMs: 600,
  });
  expect(result.status).toBe(0);
  expect(Date.now() - start).toBeLessThan(1480);
});

it('enforces shared term+kill budget even when Windows snapshot/kill steps pause', async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: 44444,
    exitCode: 0,
    signalCode: null,
    kill: () => false,
    stdin: { closed: true, destroy: () => undefined },
    stdout: { closed: true, destroy: () => undefined },
    stderr: { closed: true, destroy: () => undefined },
  }) as unknown as ChildProcess;
  const mutableChild = fakeChild as unknown as { exitCode: number | null };
  mutableChild.exitCode = null;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const slowOps: WinTreeTestOps = {
    async readMsysSnapshot(timeoutMs) {
      await delay(Math.min(180, timeoutMs));
      return {
        ok: true,
        rows: [{ pid: 901, ppid: 1, pgid: 901, winPid: 44444, uid: 1000 }],
      };
    },
    async readWmiSnapshot(timeoutMs) {
      await delay(Math.min(180, timeoutMs));
      return {
        ok: true,
        rows: [{ pid: 44444, parentPid: 1, creationUs: 1000n }],
      };
    },
    async killWinPid(_winPid, timeoutMs) {
      await delay(Math.min(180, timeoutMs));
    },
    async killMsysTargets(_targets, timeoutMs) {
      await delay(Math.min(180, timeoutMs));
    },
  };
  // Re-run reap without pre-cached ownership so reap itself starts capture under the 500ms budget.
  const start = Date.now();
  await expect(
    reapChildProcess(fakeChild, {
      termTimeoutMs: 250,
      killTimeoutMs: 250,
      processGroup: true,
      _winTreeOps: slowOps,
    }),
  ).rejects.toThrow('test_child_reap_unconfirmed');
  expect(Date.now() - start).toBeLessThan(580);
});

it('keeps default 3500/500/500 runBoundedCommand stalled bash and fixture cleanup under 5000ms', async () => {
  const start = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'fcd-lifecycle-default-'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  try {
    await expect(
      runBoundedCommand(bash, ['--noprofile', '--norc', '-c', 'sleep 10'], { cwd: dir }),
    ).rejects.toThrow(/Process exit timed out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(Date.now() - start).toBeLessThan(4800);
});

it.skipIf(process.platform !== 'win32')(
  'reaps closed-stdio MSYS2 background descendants after clean root exit while preserving canaries',
  async () => {
    const tools = findTestMsysTools();
    expect(tools).not.toBeNull();
    if (tools === null) return;

    const bash = 'C:/Program Files/Git/bin/bash.exe';
    let targetBgPid: number | null = null;
    let targetRootPgid: number | null = null;
    let canaryBgPid: number | null = null;

    const targetScript = [
      'sleep 15 </dev/null >/dev/null 2>&1 &',
      'bg=$!',
      'printf "READY %s %s\\n" "$$" "$bg"',
      'IFS= read -r _ || exit 0',
      'exit 0',
    ].join('\n');
    const canaryScript = [
      'sleep 15 </dev/null >/dev/null 2>&1 &',
      'bg=$!',
      'printf "CANARY %s\\n" "$bg"',
      'IFS= read -r _ || exit 0',
      'exit 0',
    ].join('\n');

    const canaryChild = spawn(bash, ['--noprofile', '--norc', '-c', canaryScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = spawn(bash, ['--noprofile', '--norc', '-c', targetScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const waitLine = (proc: ChildProcess, prefix: string) =>
      new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => {
          reject(new Error(`timeout_${prefix}`));
        }, 3000);
        const onData = (chunk: Buffer | string) => {
          buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          const line = buf.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
          if (line !== undefined) {
            clearTimeout(timer);
            proc.stdout?.off('data', onData);
            resolve(line);
          }
        };
        proc.stdout?.on('data', onData);
        proc.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

    try {
      const [canaryLine, targetLine] = await Promise.all([
        waitLine(canaryChild, 'CANARY '),
        waitLine(child, 'READY '),
      ]);
      canaryBgPid = Number(canaryLine.split(' ')[1]);
      const [, pgidText, bgText] = targetLine.split(' ');
      targetRootPgid = Number(pgidText);
      targetBgPid = Number(bgText);

      const ownership = await captureProcessTreeOwnership(child);
      expect(ownership?.observedRoot).toBe(true);
      child.stdin.write('GO\n');
      child.stdin.end();
      const exit = await waitForExit(child, { timeoutMs: 2000 });
      expect(exit).toEqual({ code: 0, signal: null });
      await new Promise<void>((resolve) => {
        if (child.stdout.closed && child.stderr.closed) {
          resolve();
          return;
        }
        child.once('close', () => {
          resolve();
        });
      });

      await reapChildProcess(child, {
        termTimeoutMs: 500,
        killTimeoutMs: 500,
        processGroup: true,
      });

      const remaining = readNumericMsysRows(tools.psPath);
      expect(remaining.some((row) => row.pid === targetBgPid)).toBe(false);
      expect(remaining.some((row) => row.pgid === targetRootPgid)).toBe(false);
      expect(remaining.some((row) => row.pid === canaryBgPid)).toBe(true);
    } finally {
      forceKillMsysPids(
        tools.killPath,
        [targetBgPid, canaryBgPid].filter((value): value is number => value !== null),
      );
      await reapChildProcesses([child, canaryChild], {
        termTimeoutMs: 500,
        killTimeoutMs: 500,
        processGroup: true,
      });
    }
  },
);

it.skipIf(process.platform !== 'win32')(
  'paired normal control: confirms clean exit of captured child with closed stdio and no descendants',
  async () => {
    const bash = 'C:/Program Files/Git/bin/bash.exe';
    const child = spawn(
      bash,
      ['--noprofile', '--norc', '-c', 'printf "READY\\n"; IFS= read -r _ || exit 0; exit 0'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    try {
      await waitForBarrier(child, 'READY\n', { timeoutMs: 2000 });
      const ownership = await captureProcessTreeOwnership(child);
      expect(ownership?.observedRoot).toBe(true);
      child.stdin.write('GO\n');
      child.stdin.end();
      await expect(waitForExit(child, { timeoutMs: 2000 })).resolves.toEqual({
        code: 0,
        signal: null,
      });
    } finally {
      await expect(
        reapChildProcess(child, { termTimeoutMs: 500, killTimeoutMs: 500, processGroup: true }),
      ).resolves.toBeUndefined();
    }
  },
);

it('never kills a reused WinPID whose CreationDate mismatches captured ownership', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 55555,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
    stdin: { closed: false, destroy: () => undefined },
    stdout: { closed: false, destroy: () => undefined },
    stderr: { closed: false, destroy: () => undefined },
  }) as unknown as ChildProcess & {
    exitCode: number | null;
    stdin: { closed: boolean };
    stdout: { closed: boolean };
    stderr: { closed: boolean };
  };

  let phase: 'capture' | 'after-exit' = 'capture';
  const killedWinPids: number[] = [];
  const killedMsys: { msysPids: number[]; pgids: number[] }[] = [];
  const fakeOps: WinTreeTestOps = {
    readMsysSnapshot() {
      if (phase === 'capture') {
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 100, ppid: 1, pgid: 100, winPid: 55555, uid: 1000 },
            { pid: 101, ppid: 100, pgid: 100, winPid: 55556, uid: 1000 },
          ],
        });
      }
      // After exit, OS recycled WinPID 55556 to a brand-new unrelated process.
      return Promise.resolve({
        ok: true,
        rows: [{ pid: 9999, ppid: 1, pgid: 100, winPid: 55556, uid: 1000 }],
      });
    },
    readWmiSnapshot() {
      if (phase === 'capture') {
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 55555, parentPid: 1, creationUs: 2000n },
            { pid: 55556, parentPid: 55555, creationUs: 2010n },
          ],
        });
      }
      return Promise.resolve({
        ok: true,
        rows: [{ pid: 55556, parentPid: 1, creationUs: 999999n }],
      });
    },
    killWinPid(winPid) {
      killedWinPids.push(winPid);
      return Promise.resolve();
    },
    killMsysTargets(targets) {
      killedMsys.push(targets);
      return Promise.resolve();
    },
  };

  const captured = await captureProcessTreeOwnership(child, {
    timeoutMs: 500,
    _winTreeOps: fakeOps,
  });
  expect(captured?.observedRoot).toBe(true);
  phase = 'after-exit';
  child.exitCode = 0;
  child.stdin.closed = true;
  child.stdout.closed = true;
  child.stderr.closed = true;

  await expect(
    reapChildProcess(child, {
      termTimeoutMs: 250,
      killTimeoutMs: 250,
      processGroup: true,
      _winTreeOps: fakeOps,
    }),
  ).resolves.toBeUndefined();
  expect(killedWinPids).toEqual([]);
  expect(killedMsys).toEqual([]);
});

it('never kills an unknown WinPID in a recycled MSYS group after all captured actors exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 55555,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
    stdin: { closed: false, destroy: () => undefined },
    stdout: { closed: false, destroy: () => undefined },
    stderr: { closed: false, destroy: () => undefined },
  }) as unknown as ChildProcess & {
    exitCode: number | null;
    stdin: { closed: boolean };
    stdout: { closed: boolean };
    stderr: { closed: boolean };
  };

  let phase: 'capture' | 'after-exit' = 'capture';
  const killedWinPids: number[] = [];
  const killedMsys: { msysPids: number[]; pgids: number[] }[] = [];
  const fakeOps: WinTreeTestOps = {
    readMsysSnapshot() {
      if (phase === 'capture') {
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 100, ppid: 1, pgid: 100, winPid: 55555, uid: 1000 },
            { pid: 101, ppid: 100, pgid: 100, winPid: 55556, uid: 1000 },
          ],
        });
      }
      // All captured actors are gone; only the numeric MSYS group has been recycled.
      return Promise.resolve({
        ok: true,
        rows: [{ pid: 9999, ppid: 1, pgid: 100, winPid: 55557, uid: 1000 }],
      });
    },
    readWmiSnapshot() {
      if (phase === 'capture') {
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 55555, parentPid: 1, creationUs: 2000n },
            { pid: 55556, parentPid: 55555, creationUs: 2010n },
          ],
        });
      }
      return Promise.resolve({
        ok: true,
        rows: [{ pid: 55557, parentPid: 1, creationUs: 999999n }],
      });
    },
    killWinPid(winPid) {
      killedWinPids.push(winPid);
      return Promise.resolve();
    },
    killMsysTargets(targets) {
      killedMsys.push(targets);
      return Promise.resolve();
    },
  };

  const captured = await captureProcessTreeOwnership(child, {
    timeoutMs: 500,
    _winTreeOps: fakeOps,
  });
  expect(captured?.observedRoot).toBe(true);
  phase = 'after-exit';
  child.exitCode = 0;
  child.stdin.closed = true;
  child.stdout.closed = true;
  child.stderr.closed = true;

  await expect(
    reapChildProcess(child, {
      termTimeoutMs: 250,
      killTimeoutMs: 250,
      processGroup: true,
      _winTreeOps: fakeOps,
    }),
  ).resolves.toBeUndefined();
  expect(killedWinPids).toEqual([]);
  expect(killedMsys).toEqual([]);
});

it('fails closed if an owned descendant with matching CreationDate survives after closed stdio', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 66666,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
    stdin: { closed: false, destroy: () => undefined },
    stdout: { closed: false, destroy: () => undefined },
    stderr: { closed: false, destroy: () => undefined },
  }) as unknown as ChildProcess & {
    exitCode: number | null;
    stdin: { closed: boolean };
    stdout: { closed: boolean };
    stderr: { closed: boolean };
  };
  let phase: 'capture' | 'survivor' = 'capture';
  const unkillableOps: WinTreeTestOps = {
    readMsysSnapshot() {
      if (phase === 'capture') {
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 200, ppid: 1, pgid: 200, winPid: 66666, uid: 1000 },
            { pid: 201, ppid: 200, pgid: 200, winPid: 66667, uid: 1000 },
          ],
        });
      }
      return Promise.resolve({
        ok: true,
        rows: [{ pid: 201, ppid: 1, pgid: 200, winPid: 66667, uid: 1000 }],
      });
    },
    readWmiSnapshot() {
      if (phase === 'capture') {
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 66666, parentPid: 1, creationUs: 3000n },
            { pid: 66667, parentPid: 66666, creationUs: 3010n },
          ],
        });
      }
      return Promise.resolve({
        ok: true,
        rows: [{ pid: 66667, parentPid: 66666, creationUs: 3010n }],
      });
    },
    killWinPid: () => Promise.resolve(),
    killMsysTargets: () => Promise.resolve(),
  };
  await captureProcessTreeOwnership(child, { timeoutMs: 500, _winTreeOps: unkillableOps });
  phase = 'survivor';
  child.exitCode = 0;
  child.stdin.closed = true;
  child.stdout.closed = true;
  child.stderr.closed = true;

  await expect(
    reapChildProcess(child, {
      termTimeoutMs: 100,
      killTimeoutMs: 100,
      processGroup: true,
      _winTreeOps: unkillableOps,
    }),
  ).rejects.toThrow('test_child_reap_unconfirmed');
});

it.skipIf(process.platform !== 'win32')(
  'fails closed when processGroup cleanup runs on a closed child whose ownership was never captured',
  async () => {
    const child = spawn(
      'C:/Program Files/Git/bin/bash.exe',
      ['--noprofile', '--norc', '-c', 'exit 0'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null && child.stdout.closed && child.stderr.closed) {
        resolve();
        return;
      }
      child.once('close', () => {
        resolve();
      });
    });
    await expect(
      reapChildProcess(child, { termTimeoutMs: 200, killTimeoutMs: 200, processGroup: true }),
    ).rejects.toThrow('test_child_reap_unconfirmed');
  },
);
