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

type FakeChild = ChildProcess & {
  exitCode: number | null;
  stdin: { closed: boolean; destroy: () => void };
  stdout: { closed: boolean; destroy: () => void };
  stderr: { closed: boolean; destroy: () => void };
};
interface MsysRow {
  pid: number;
  ppid: number;
  pgid: number;
  winPid: number;
  uid: number;
}
interface WmiRow {
  pid: number;
  parentPid: number;
  creationUs: bigint;
}

const delayMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const msys = (pid: number, winPid: number, ppid = 1, pgid = pid, uid = 1000): MsysRow => ({
  pid,
  ppid,
  pgid,
  winPid,
  uid,
});
const wmi = (pid: number, parentPid: number, creationUs: bigint): WmiRow => ({
  pid,
  parentPid,
  creationUs,
});
const okRows = <T>(rows: T[]) => Promise.resolve({ ok: true, rows });
const filterWmi = (rows: WmiRow[], filterPids?: readonly number[], byParent = false) =>
  rows.filter(
    (r) =>
      filterPids === undefined ||
      filterPids.includes(r.pid) ||
      (byParent && filterPids.includes(r.parentPid)),
  );
const waitWork = async (workMs: number, timeoutMs: number): Promise<boolean> => {
  if (workMs <= 0) return true;
  await delayMs(Math.min(workMs, Math.max(0, timeoutMs)));
  return workMs <= timeoutMs;
};
const makeFakeChild = (winPid: number, killResult = false): FakeChild =>
  Object.assign(new EventEmitter(), {
    pid: winPid,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => killResult,
    stdin: { closed: false, destroy: () => undefined },
    stdout: { closed: false, destroy: () => undefined },
    stderr: { closed: false, destroy: () => undefined },
  }) as unknown as FakeChild;
const closeFakeChild = (child: FakeChild): void => {
  child.exitCode = 0;
  child.stdin.closed = true;
  child.stdout.closed = true;
  child.stderr.closed = true;
};
const noopKill = () => Promise.resolve();
const captureFake = (child: FakeChild, ops: WinTreeTestOps) =>
  captureProcessTreeOwnership(child, { timeoutMs: 500, _winTreeOps: ops });
const reapFake = (child: FakeChild, ops: WinTreeTestOps, termMs = 150) =>
  reapChildProcess(child, {
    termTimeoutMs: termMs,
    killTimeoutMs: termMs,
    processGroup: true,
    _winTreeOps: ops,
  });
const recordKills = () => {
  const killedWinPids: number[] = [];
  const killedMsys: { msysPids: number[]; pgids: number[] }[] = [];
  return {
    killedWinPids,
    killedMsys,
    killWinPid: (winPid: number) => {
      killedWinPids.push(winPid);
      return noopKill();
    },
    killMsysTargets: (targets: { msysPids: number[]; pgids: number[] }) => {
      killedMsys.push(targets);
      return noopKill();
    },
  };
};
const wmiFromMap = (
  liveWin: Map<number, { parentPid: number; creationUs: bigint }>,
  filterPids?: readonly number[],
) =>
  okRows(
    filterWmi(
      [...liveWin.entries()].map(([pid, info]) => wmi(pid, info.parentPid, info.creationUs)),
      filterPids,
      true,
    ),
  );

it('never kills a reused WinPID whose CreationDate mismatches captured ownership', async () => {
  const child = makeFakeChild(55555);
  let phase: 'capture' | 'after-exit' = 'capture';
  const rec = recordKills();
  const fakeOps: WinTreeTestOps = {
    readMsysSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [msys(100, 55555), msys(101, 55556, 100, 100)]
          : [msys(9999, 55556, 1, 100)],
      ),
    readWmiSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [wmi(55555, 1, 2000n), wmi(55556, 55555, 2010n)]
          : [wmi(55556, 1, 999999n)],
      ),
    killWinPid: rec.killWinPid,
    killMsysTargets: rec.killMsysTargets,
  };

  expect((await captureFake(child, fakeOps))?.observedRoot).toBe(true);
  phase = 'after-exit';
  closeFakeChild(child);

  await expect(reapFake(child, fakeOps, 250)).resolves.toBeUndefined();
  expect(rec.killedWinPids).toEqual([]);
  expect(rec.killedMsys).toEqual([]);
});

it('never kills an unknown WinPID in a recycled MSYS group after all captured actors exit', async () => {
  const child = makeFakeChild(55555);
  let phase: 'capture' | 'after-exit' = 'capture';
  const rec = recordKills();
  const fakeOps: WinTreeTestOps = {
    readMsysSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [msys(100, 55555), msys(101, 55556, 100, 100)]
          : [msys(9999, 55557, 1, 100)],
      ),
    readWmiSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [wmi(55555, 1, 2000n), wmi(55556, 55555, 2010n)]
          : [wmi(55557, 1, 999999n)],
      ),
    killWinPid: rec.killWinPid,
    killMsysTargets: rec.killMsysTargets,
  };

  expect((await captureFake(child, fakeOps))?.observedRoot).toBe(true);
  phase = 'after-exit';
  closeFakeChild(child);

  await expect(reapFake(child, fakeOps, 250)).resolves.toBeUndefined();
  expect(rec.killedWinPids).toEqual([]);
  expect(rec.killedMsys).toEqual([]);
});

it('fails closed if an owned descendant with matching CreationDate survives after closed stdio', async () => {
  const child = makeFakeChild(66666);
  let phase: 'capture' | 'survivor' = 'capture';
  const unkillableOps: WinTreeTestOps = {
    readMsysSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [msys(200, 66666), msys(201, 66667, 200, 200)]
          : [msys(201, 66667, 1, 200)],
      ),
    readWmiSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [wmi(66666, 1, 3000n), wmi(66667, 66666, 3010n)]
          : [wmi(66667, 66666, 3010n)],
      ),
    killWinPid: noopKill,
    killMsysTargets: noopKill,
  };
  await captureFake(child, unkillableOps);
  phase = 'survivor';
  closeFakeChild(child);

  await expect(reapFake(child, unkillableOps, 100)).rejects.toThrow('test_child_reap_unconfirmed');
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

it('captures newly spawned MSYS descendants born between WMI and MSYS capture before closed-root reap', async () => {
  const fakeChild = makeFakeChild(77771, true);
  let wmiCallCount = 0;
  let descendantAlive = true;
  const killedWinPids: number[] = [];

  const raceOps: WinTreeTestOps = {
    readMsysSnapshot: () =>
      okRows(
        descendantAlive
          ? [...(fakeChild.exitCode === null ? [msys(910, 77771)] : []), msys(920, 77772, 910, 910)]
          : [],
      ),
    readWmiSnapshot: (_timeoutMs, filterPids) => {
      wmiCallCount += 1;
      if (wmiCallCount === 1) return okRows([wmi(77771, 1, 1000n)]);
      return okRows(
        filterWmi(
          [
            ...(fakeChild.exitCode === null ? [wmi(77771, 1, 1000n)] : []),
            ...(descendantAlive ? [wmi(77772, 1, 1050n)] : []),
          ],
          filterPids,
        ),
      );
    },
    killWinPid: (winPid) => {
      killedWinPids.push(winPid);
      if (winPid === 77772) descendantAlive = false;
      return noopKill();
    },
    killMsysTargets: (targets) => {
      if (targets.msysPids.includes(920) || targets.pgids.includes(910)) descendantAlive = false;
      return noopKill();
    },
  };

  const ownership = await captureFake(fakeChild, raceOps);
  expect(ownership?.observedRoot).toBe(true);
  expect(ownership?.ownedWinNodes.has(77772)).toBe(true);

  closeFakeChild(fakeChild);
  await reapFake(fakeChild, raceOps);

  expect(killedWinPids).toContain(77772);
  expect(descendantAlive).toBe(false);
});

it('does not reuse stale recent WMI rows or poison owned PGIDs when a child spawns after capture', async () => {
  const fakeChild = makeFakeChild(77781, true);
  let phase: 'capture' | 'reap' = 'capture';
  let childAlive = true;
  const killedWinPids: number[] = [];

  const birthOps: WinTreeTestOps = {
    readMsysSnapshot: () =>
      okRows(
        phase === 'capture'
          ? [msys(930, 77781)]
          : [
              ...(fakeChild.exitCode === null ? [msys(930, 77781)] : []),
              ...(childAlive ? [msys(931, 77782, 930, 930)] : []),
            ],
      ),
    readWmiSnapshot: (_timeoutMs, filterPids) =>
      okRows(
        phase === 'capture'
          ? [wmi(77781, 1, 2000n)]
          : filterWmi(
              [
                ...(fakeChild.exitCode === null ? [wmi(77781, 1, 2000n)] : []),
                ...(childAlive ? [wmi(77782, 77781, 2050n)] : []),
              ],
              filterPids,
            ),
      ),
    killWinPid: (winPid) => {
      killedWinPids.push(winPid);
      if (winPid === 77781) closeFakeChild(fakeChild);
      if (winPid === 77782) childAlive = false;
      return noopKill();
    },
    killMsysTargets: (targets) => {
      if (targets.msysPids.includes(931) || targets.pgids.includes(930)) childAlive = false;
      return noopKill();
    },
  };

  await captureFake(fakeChild, birthOps);
  phase = 'reap';
  await reapFake(fakeChild, birthOps);

  expect(killedWinPids).toContain(77782);
  expect(childAlive).toBe(false);
});

it('overlaps closed-root MSYS and filtered WMI inspection within shared reap budget', async () => {
  const fakeChild = makeFakeChild(77791);
  let bgAlive = true;
  let phase: 'capture' | 'reap' = 'capture';

  const overlapOps: WinTreeTestOps = {
    async readMsysSnapshot(timeoutMs) {
      if (phase === 'reap' && !(await waitWork(bgAlive ? 180 : 80, timeoutMs))) {
        return { ok: false, rows: [] };
      }
      return {
        ok: true,
        rows: [
          ...(fakeChild.exitCode === null ? [msys(940, 77791)] : []),
          ...(bgAlive ? [msys(941, 77792, 940, 940)] : []),
        ],
      };
    },
    async readWmiSnapshot(timeoutMs, filterPids) {
      if (phase === 'reap' && !(await waitWork(340, timeoutMs))) {
        return { ok: false, rows: [] };
      }
      return {
        ok: true,
        rows: filterWmi(
          [
            ...(fakeChild.exitCode === null ? [wmi(77791, 1, 3000n)] : []),
            ...(bgAlive ? [wmi(77792, 1, 3010n)] : []),
          ],
          filterPids,
        ),
      };
    },
    killWinPid: (winPid) => {
      if (winPid === 77792) bgAlive = false;
      return noopKill();
    },
    killMsysTargets: (targets) => {
      if (targets.msysPids.includes(941) || targets.pgids.includes(940)) bgAlive = false;
      return noopKill();
    },
  };

  await captureFake(fakeChild, overlapOps);
  phase = 'reap';
  closeFakeChild(fakeChild);

  const start = Date.now();
  await reapFake(fakeChild, overlapOps, 250);

  expect(Date.now() - start).toBeLessThan(480);
  expect(bgAlive).toBe(false);
});

it('avoids duplicate sequential WMI calls when an older live root spawns a descendant before reap', async () => {
  const fakeChild = makeFakeChild(77801, true);
  let phase: 'capture' | 'reap' = 'capture';
  let childAlive = true;
  const reapWmiFilters: (readonly number[] | undefined)[] = [];

  const liveOps: WinTreeTestOps = {
    async readMsysSnapshot(timeoutMs) {
      if (phase === 'reap' && !(await waitWork(childAlive ? 80 : 60, timeoutMs))) {
        return { ok: false, rows: [] };
      }
      return {
        ok: true,
        rows:
          phase === 'capture'
            ? [msys(950, 77801)]
            : [
                ...(fakeChild.exitCode === null ? [msys(950, 77801)] : []),
                ...(childAlive ? [msys(951, 77802, 950, 950)] : []),
              ],
      };
    },
    async readWmiSnapshot(timeoutMs, filterPids) {
      if (phase === 'capture') return { ok: true, rows: [wmi(77801, 1, 4000n)] };
      reapWmiFilters.push(filterPids);
      if (!(await waitWork(460, timeoutMs))) return { ok: false, rows: [] };
      return {
        ok: true,
        rows: filterWmi(
          [
            ...(fakeChild.exitCode === null ? [wmi(77801, 1, 4000n)] : []),
            ...(childAlive ? [wmi(77802, 77801, 4050n)] : []),
          ],
          filterPids,
        ),
      };
    },
    killWinPid: (winPid) => {
      if (winPid === 77801) closeFakeChild(fakeChild);
      if (winPid === 77802) childAlive = false;
      return noopKill();
    },
    killMsysTargets: (targets) => {
      if (targets.msysPids.includes(951) || targets.pgids.includes(950)) childAlive = false;
      return noopKill();
    },
  };

  await captureFake(fakeChild, liveOps);
  await delayMs(270);
  phase = 'reap';
  await reapFake(fakeChild, liveOps, 450);

  expect(reapWmiFilters).toHaveLength(1);
  expect(reapWmiFilters[0]).toEqual(expect.arrayContaining([77801, 77802]));
  expect(childAlive).toBe(false);
});

it('does not let an exited transient child in an owned PGID block group signaling', async () => {
  const fakeChild = makeFakeChild(77811, true);
  let phase: 'capture' | 'reap' = 'capture';
  let reapMsysCalls = 0;
  let descendantAlive = true;
  const recordedPgids: number[] = [];

  const pgidOps: WinTreeTestOps = {
    readMsysSnapshot: () => {
      if (phase === 'capture') return okRows([msys(960, 77811)]);
      reapMsysCalls += 1;
      if (reapMsysCalls === 1) {
        // Transient owned child present in MSYS snapshot that exits before WMI runs.
        return okRows([msys(960, 77811), msys(961, 77812, 960, 960)]);
      }
      return okRows([
        ...(fakeChild.exitCode === null ? [msys(960, 77811)] : []),
        ...(descendantAlive ? [msys(962, 77813, 960, 960)] : []),
      ]);
    },
    readWmiSnapshot: (_timeoutMs, filterPids) => {
      if (phase === 'capture') return okRows([wmi(77811, 1, 2000n)]);
      // 77812 already exited before WMI ran; late sibling 77813 was not in filterPids yet.
      return okRows(
        filterWmi(fakeChild.exitCode === null ? [wmi(77811, 1, 2000n)] : [], filterPids),
      );
    },
    killWinPid: (winPid) => {
      if (winPid === 77811) closeFakeChild(fakeChild);
      return noopKill();
    },
    killMsysTargets: (targets) => {
      recordedPgids.push(...targets.pgids);
      if (targets.pgids.includes(960)) descendantAlive = false;
      return noopKill();
    },
  };

  await captureFake(fakeChild, pgidOps);
  phase = 'reap';
  await reapFake(fakeChild, pgidOps, 250);

  expect(recordedPgids).toContain(960);
  expect(descendantAlive).toBe(false);
});

it('never adopts or signals an unrelated recycled WinPID when root exits during unresolved MSYS follow-up', async () => {
  const fakeChild = makeFakeChild(77821);
  let msysCall = 0;
  let wmiCall = 0;
  const rec = recordKills();

  const recycleOps: WinTreeTestOps = {
    readMsysSnapshot: () => {
      msysCall += 1;
      return okRows(
        msysCall === 1
          ? [msys(910, 77821, 1, 910, 197609), msys(920, 77822, 910, 910, 197609)]
          : // Child 920 exited and unrelated process 9999 reused WinPID 77822.
            [msys(9999, 77822, 1, 9999, 197609)],
      );
    },
    readWmiSnapshot: (_timeoutMs, filterPids) => {
      wmiCall += 1;
      if (wmiCall === 1) return okRows([wmi(77821, 4000, 100000n)]);
      // Root exits during follow-up WMI and WinPID 77822 is recycled by an unrelated process.
      if (wmiCall === 2) closeFakeChild(fakeChild);
      return okRows(filterWmi([wmi(77822, 1, 999999n)], filterPids));
    },
    killWinPid: rec.killWinPid,
    killMsysTargets: rec.killMsysTargets,
  };

  const ownership = await captureFake(fakeChild, recycleOps);
  expect(ownership?.observedRoot).toBe(true);
  expect(ownership?.ownedWinNodes.has(77822)).toBe(false);

  closeFakeChild(fakeChild);
  await expect(reapFake(fakeChild, recycleOps)).resolves.toBeUndefined();
  expect(rec.killedWinPids).toEqual([]);
  expect(rec.killedMsys).toEqual([]);
});

it('never adopts or signals an unrelated recycled WinPID while root remains alive', async () => {
  // Sub-case A: post-WMI MSYS snapshot shows child 920 gone and unrelated 9999 reusing 77832.
  {
    const fakeChild = makeFakeChild(77831);
    let msysCall = 0;
    let wmiCall = 0;
    const rec = recordKills();

    const liveRecycleOps: WinTreeTestOps = {
      readMsysSnapshot: () => {
        msysCall += 1;
        return okRows(
          msysCall === 1
            ? [msys(910, 77831, 1, 910, 197609), msys(920, 77832, 910, 910, 197609)]
            : [
                ...(fakeChild.exitCode === null ? [msys(910, 77831, 1, 910, 197609)] : []),
                msys(9999, 77832, 1, 9999, 197609),
              ],
        );
      },
      readWmiSnapshot: (_timeoutMs, filterPids) => {
        wmiCall += 1;
        if (wmiCall === 1) return okRows([wmi(77831, 4000, 100000n)]);
        return okRows(
          filterWmi(
            [
              ...(fakeChild.exitCode === null ? [wmi(77831, 4000, 100000n)] : []),
              wmi(77832, 1, 999999n),
            ],
            filterPids,
          ),
        );
      },
      killWinPid: rec.killWinPid,
      killMsysTargets: rec.killMsysTargets,
    };

    const ownership = await captureFake(fakeChild, liveRecycleOps);
    expect(ownership?.observedRoot).toBe(true);
    expect(ownership?.ownedWinNodes.has(77832)).toBe(false);

    closeFakeChild(fakeChild);
    await expect(reapFake(fakeChild, liveRecycleOps)).resolves.toBeUndefined();
    expect(rec.killedWinPids).toEqual([]);
    expect(rec.killedMsys).toEqual([]);
  }

  // Sub-case B: post-WMI MSYS confirmation snapshot fails -> unresolved 77834 is NOT adopted.
  {
    const fakeChild = makeFakeChild(77833);
    let msysCall = 0;
    let wmiCall = 0;

    const failedConfirmOps: WinTreeTestOps = {
      readMsysSnapshot: () => {
        msysCall += 1;
        return msysCall === 1
          ? okRows([msys(910, 77833, 1, 910, 197609), msys(920, 77834, 910, 910, 197609)])
          : Promise.resolve({ ok: false, rows: [] });
      },
      readWmiSnapshot: (_timeoutMs, filterPids) => {
        wmiCall += 1;
        if (wmiCall === 1) return okRows([wmi(77833, 4000, 100000n)]);
        return okRows(filterWmi([wmi(77833, 4000, 100000n), wmi(77834, 1, 999999n)], filterPids));
      },
      killWinPid: noopKill,
      killMsysTargets: noopKill,
    };

    const ownership = await captureFake(fakeChild, failedConfirmOps);
    expect(ownership?.observedRoot).toBe(true);
    expect(ownership?.ownedWinNodes.has(77834)).toBe(false);
  }
});

it('adopts unresolved MSYS child only when post-WMI MSYS snapshot confirms unchanged live identity', async () => {
  const fakeChild = makeFakeChild(77841);
  let captureMsysCalls = 0;
  let wmiCall = 0;

  const coherentOps: WinTreeTestOps = {
    readMsysSnapshot: () => {
      captureMsysCalls += 1;
      return okRows([msys(910, 77841, 1, 910, 197609), msys(920, 77842, 910, 910, 197609)]);
    },
    readWmiSnapshot: (_timeoutMs, filterPids) => {
      wmiCall += 1;
      if (wmiCall === 1) return okRows([wmi(77841, 4000, 100000n)]);
      return okRows(filterWmi([wmi(77841, 4000, 100000n), wmi(77842, 77841, 100050n)], filterPids));
    },
    killWinPid: noopKill,
    killMsysTargets: noopKill,
  };

  const ownership = await captureFake(fakeChild, coherentOps);
  expect(captureMsysCalls).toBeGreaterThanOrEqual(2);
  expect(ownership?.observedRoot).toBe(true);
  expect(ownership?.ownedWinNodes.get(77842)).toBe(100050n);
});

it('discovers and kills multi-generation post-capture native descendants before confirming exit', async () => {
  const fakeChild = makeFakeChild(77851);
  let phase: 'capture' | 'reap' = 'capture';
  const liveWin = new Map<number, { parentPid: number; creationUs: bigint }>([
    [77851, { parentPid: 4000, creationUs: 100000n }],
  ]);
  const reapWmiFilters: (readonly number[] | undefined)[] = [];
  const killedWinPids: number[] = [];

  const multiHopOps: WinTreeTestOps = {
    readMsysSnapshot: () =>
      // Only MSYS root exists in ps.exe; 77852 and 77853 are native Win32 descendants.
      okRows(liveWin.has(77851) ? [msys(910, 77851, 1, 910, 197609)] : []),
    readWmiSnapshot: (_timeoutMs, filterPids) => {
      if (phase === 'reap') reapWmiFilters.push(filterPids);
      return wmiFromMap(liveWin, filterPids);
    },
    killWinPid: (winPid) => {
      killedWinPids.push(winPid);
      liveWin.delete(winPid);
      if (winPid === 77851) closeFakeChild(fakeChild);
      return noopKill();
    },
    killMsysTargets: noopKill,
  };

  expect((await captureFake(fakeChild, multiHopOps))?.observedRoot).toBe(true);

  await delayMs(270);
  liveWin.set(77852, { parentPid: 77851, creationUs: 100010n });
  liveWin.set(77853, { parentPid: 77852, creationUs: 100020n });
  phase = 'reap';

  await expect(reapFake(fakeChild, multiHopOps, 400)).resolves.toBeUndefined();
  expect([...liveWin.keys()]).toEqual([]);
  expect(killedWinPids).toEqual([77853, 77852, 77851]);
  // Confirmation WMI must have run even though ps.exe is empty once 77851 exited.
  expect(reapWmiFilters.length).toBeGreaterThanOrEqual(4);
});

it('fails closed without killing ancestors if native frontier fails or if a native grandchild survives', async () => {
  // Case A: Native grandchild 77863 refuses to die even after root 77861 and child 77862 exit.
  {
    const fakeChild = makeFakeChild(77861);
    const liveWin = new Map<number, { parentPid: number; creationUs: bigint }>([
      [77861, { parentPid: 4000, creationUs: 100000n }],
    ]);

    const survivorOps: WinTreeTestOps = {
      readMsysSnapshot: () => okRows(liveWin.has(77861) ? [msys(910, 77861, 1, 910, 197609)] : []),
      readWmiSnapshot: (_timeoutMs, filterPids) => wmiFromMap(liveWin, filterPids),
      killWinPid: (winPid) => {
        if (winPid !== 77863) liveWin.delete(winPid);
        if (winPid === 77861) closeFakeChild(fakeChild);
        return noopKill();
      },
      killMsysTargets: noopKill,
    };

    await captureFake(fakeChild, survivorOps);
    await delayMs(270);
    liveWin.set(77862, { parentPid: 77861, creationUs: 100010n });
    liveWin.set(77863, { parentPid: 77862, creationUs: 100020n });

    await expect(reapFake(fakeChild, survivorOps, 400)).rejects.toThrow(
      'test_child_reap_unconfirmed',
    );
    expect(liveWin.has(77863)).toBe(true);
  }

  // Case B: Frontier WMI lookup fails before closing -> must not kill ancestors 77871/77872.
  {
    const fakeChild = makeFakeChild(77871);
    let phase: 'capture' | 'reap' = 'capture';
    let reapWmiCount = 0;
    const killedWinPids: number[] = [];

    const frontierFailOps: WinTreeTestOps = {
      readMsysSnapshot: () => okRows([msys(910, 77871, 1, 910, 197609)]),
      readWmiSnapshot: (_timeoutMs, filterPids) => {
        if (phase === 'capture') return okRows([wmi(77871, 4000, 100000n)]);
        reapWmiCount += 1;
        if (reapWmiCount >= 2) return Promise.resolve({ ok: false, rows: [] });
        return okRows(
          filterWmi([wmi(77871, 4000, 100000n), wmi(77872, 77871, 100010n)], filterPids, true),
        );
      },
      killWinPid: (winPid) => {
        killedWinPids.push(winPid);
        return noopKill();
      },
      killMsysTargets: noopKill,
    };

    await captureFake(fakeChild, frontierFailOps);
    await delayMs(270);
    phase = 'reap';

    await expect(reapFake(fakeChild, frontierFailOps, 400)).rejects.toThrow(
      'test_child_reap_unconfirmed',
    );
    expect(killedWinPids).toEqual([]);
  }
});

it('bounds auto-capture observer lifecycle inside short custom caller budgets', async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: 77881,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
    stdin: { closed: false, destroy: () => undefined },
    stdout: { closed: false, destroy: () => undefined },
    stderr: { closed: false, destroy: () => undefined },
  });
  const child = fakeChild as unknown as ChildProcess;

  const observedSignals: (AbortSignal | undefined)[] = [];

  const stallingOps: WinTreeTestOps = {
    readMsysSnapshot(timeoutMs: number, signal?: AbortSignal) {
      observedSignals.push(signal);
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ ok: false, rows: [] });
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ ok: false, rows: [] });
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve({ ok: false, rows: [] });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    readWmiSnapshot(timeoutMs: number, _filterPids?: readonly number[], signal?: AbortSignal) {
      observedSignals.push(signal);
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ ok: false, rows: [] });
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ ok: false, rows: [] });
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve({ ok: false, rows: [] });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    killWinPid: () => Promise.resolve(),
    killMsysTargets: () => Promise.resolve(),
  };

  const startedAt = Date.now();
  // Simulates startAutoOwnershipCapture using the 1,200 ms floor alongside a short caller reap budget.
  const capturePromise = captureProcessTreeOwnership(child, {
    timeoutMs: 1200,
    _winTreeOps: stallingOps,
  }).then((ownership) => ({ ownership, settledAtMs: Date.now() }));

  const reapPromise = reapChildProcess(child, {
    termTimeoutMs: 60,
    killTimeoutMs: 60,
    processGroup: true,
    _winTreeOps: stallingOps,
  });

  await expect(reapPromise).rejects.toThrow('test_child_reap_unconfirmed');
  const settledCapture = await capturePromise;

  expect(settledCapture.ownership).toMatchObject({ observedRoot: false });
  expect(settledCapture.settledAtMs - startedAt).toBeLessThan(400);
  expect(observedSignals.length).toBeGreaterThanOrEqual(2);
  expect(observedSignals.every((s) => s?.aborted === true)).toBe(true);
});

it('discovers and kills native children born immediately after recent capture (< 250 ms) and rejects closed-root unverified orphans', async () => {
  const makeChild = (winPid: number) =>
    Object.assign(new EventEmitter(), {
      pid: winPid,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => false,
      stdin: { closed: false, destroy: () => undefined },
      stdout: { closed: false, destroy: () => undefined },
      stderr: { closed: false, destroy: () => undefined },
    });

  // Case A: Native child born immediately after capture (< 250 ms) is discovered and killed before root.
  {
    const fakeChild = makeChild(77901);
    const child = fakeChild as unknown as ChildProcess;
    let phase: 'capture' | 'reap' = 'capture';
    const liveWin = new Map<number, { parentPid: number; creationUs: bigint }>([
      [77901, { parentPid: 4000, creationUs: 100000n }],
    ]);
    const reapWmiFilters: (readonly number[] | undefined)[] = [];
    const killedWinPids: number[] = [];

    const recentOps: WinTreeTestOps = {
      readMsysSnapshot() {
        const rows = liveWin.has(77901)
          ? [{ pid: 910, ppid: 1, pgid: 910, winPid: 77901, uid: 197609 }]
          : [];
        return Promise.resolve({ ok: true, rows });
      },
      readWmiSnapshot(_timeoutMs, filterPids) {
        if (phase === 'reap') {
          reapWmiFilters.push(filterPids);
        }
        const rows = [...liveWin.entries()]
          .map(([pid, info]) => ({ pid, parentPid: info.parentPid, creationUs: info.creationUs }))
          .filter(
            (row) =>
              filterPids === undefined ||
              filterPids.includes(row.pid) ||
              filterPids.includes(row.parentPid),
          );
        return Promise.resolve({ ok: true, rows });
      },
      killWinPid(winPid) {
        killedWinPids.push(winPid);
        liveWin.delete(winPid);
        if (winPid === 77901) {
          fakeChild.exitCode = 0;
          fakeChild.stdin.closed = true;
          fakeChild.stdout.closed = true;
          fakeChild.stderr.closed = true;
        }
        return Promise.resolve();
      },
      killMsysTargets: () => Promise.resolve(),
    };

    const ownership = await captureProcessTreeOwnership(child, {
      timeoutMs: 500,
      _winTreeOps: recentOps,
    });
    expect(ownership?.observedRoot).toBe(true);

    // Zero delay (< 250 ms recent-capture window): spawn non-MSYS native child + grandchild.
    liveWin.set(77902, { parentPid: 77901, creationUs: 100010n });
    liveWin.set(77903, { parentPid: 77902, creationUs: 100020n });
    phase = 'reap';

    await expect(
      reapChildProcess(child, {
        termTimeoutMs: 400,
        killTimeoutMs: 400,
        processGroup: true,
        _winTreeOps: recentOps,
      }),
    ).resolves.toBeUndefined();

    expect([...liveWin.keys()]).toEqual([]);
    expect(killedWinPids).toEqual([77903, 77902, 77901]);
    expect(reapWmiFilters.length).toBeGreaterThanOrEqual(4);
  }

  // Case B: If captured root exits leaving an unverified potential native child, fail closed without false resolution or signaling.
  {
    const fakeChild = makeChild(77911);
    const child = fakeChild as unknown as ChildProcess;
    let phase: 'capture' | 'reap' = 'capture';
    const liveWin = new Map<number, { parentPid: number; creationUs: bigint }>([
      [77911, { parentPid: 4000, creationUs: 100000n }],
    ]);
    const killedWinPids: number[] = [];

    const orphanOps: WinTreeTestOps = {
      readMsysSnapshot() {
        const rows =
          phase === 'capture' ? [{ pid: 910, ppid: 1, pgid: 910, winPid: 77911, uid: 197609 }] : [];
        return Promise.resolve({ ok: true, rows });
      },
      readWmiSnapshot(_timeoutMs, filterPids) {
        const rows = [...liveWin.entries()]
          .map(([pid, info]) => ({ pid, parentPid: info.parentPid, creationUs: info.creationUs }))
          .filter(
            (row) =>
              filterPids === undefined ||
              filterPids.includes(row.pid) ||
              filterPids.includes(row.parentPid),
          );
        return Promise.resolve({ ok: true, rows });
      },
      killWinPid(winPid) {
        killedWinPids.push(winPid);
        return Promise.resolve();
      },
      killMsysTargets: () => Promise.resolve(),
    };

    const ownership = await captureProcessTreeOwnership(child, {
      timeoutMs: 500,
      _winTreeOps: orphanOps,
    });
    expect(ownership?.observedRoot).toBe(true);

    // Native child remains while root exits before reap runs.
    liveWin.delete(77911);
    liveWin.set(77912, { parentPid: 77911, creationUs: 100010n });
    fakeChild.exitCode = 0;
    fakeChild.stdin.closed = true;
    fakeChild.stdout.closed = true;
    fakeChild.stderr.closed = true;
    phase = 'reap';

    await expect(
      reapChildProcess(child, {
        termTimeoutMs: 400,
        killTimeoutMs: 400,
        processGroup: true,
        _winTreeOps: orphanOps,
      }),
    ).rejects.toThrow('test_child_reap_unconfirmed');

    expect(killedWinPids).toEqual([]);
    expect(liveWin.has(77912)).toBe(true);
  }
});

it('invalidates stale WMI rows and never adopts or signals unrelated processes when a parent PID recycles during frontier or prefetch', async () => {
  const makeChild = (winPid: number) =>
    Object.assign(new EventEmitter(), {
      pid: winPid,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => false,
      stdin: { closed: false, destroy: () => undefined },
      stdout: { closed: false, destroy: () => undefined },
      stderr: { closed: false, destroy: () => undefined },
    });

  // Case A: Frontier WMI detects recycled native parent 77952 -> must invalidate proof, fail closed, and never adopt/signal 77952 or 77953.
  {
    const fakeChild = makeChild(77951);
    const child = fakeChild as unknown as ChildProcess;
    let phase: 'capture' | 'reap' = 'capture';
    let reapWmiCall = 0;
    const killedWinPids: number[] = [];

    const frontierRecycleOps: WinTreeTestOps = {
      readMsysSnapshot() {
        return Promise.resolve({
          ok: true,
          rows: [{ pid: 910, ppid: 1, pgid: 910, winPid: 77951, uid: 197609 }],
        });
      },
      readWmiSnapshot(_timeoutMs, filterPids) {
        if (phase === 'capture') {
          return Promise.resolve({
            ok: true,
            rows: [{ pid: 77951, parentPid: 4000, creationUs: 100000n }],
          });
        }
        reapWmiCall += 1;
        const rows =
          reapWmiCall === 1
            ? [
                { pid: 77951, parentPid: 4000, creationUs: 100000n },
                { pid: 77952, parentPid: 77951, creationUs: 100010n },
              ]
            : [
                // 77952 exited and PID recycled to unrelated process (999999n) with unrelated child 77953.
                { pid: 77952, parentPid: 1, creationUs: 999999n },
                { pid: 77953, parentPid: 77952, creationUs: 1000000n },
              ];
        return Promise.resolve({
          ok: true,
          rows: rows.filter(
            (row) =>
              filterPids === undefined ||
              filterPids.includes(row.pid) ||
              filterPids.includes(row.parentPid),
          ),
        });
      },
      killWinPid(winPid) {
        killedWinPids.push(winPid);
        return Promise.resolve();
      },
      killMsysTargets: () => Promise.resolve(),
    };

    const ownership = await captureProcessTreeOwnership(child, {
      timeoutMs: 500,
      _winTreeOps: frontierRecycleOps,
    });
    phase = 'reap';

    await expect(
      reapChildProcess(child, {
        termTimeoutMs: 400,
        killTimeoutMs: 400,
        processGroup: true,
        _winTreeOps: frontierRecycleOps,
      }),
    ).rejects.toThrow('test_child_reap_unconfirmed');

    expect(killedWinPids).toEqual([]);
    expect(ownership?.ownedWinNodes.has(77952)).toBe(false);
    expect(ownership?.ownedWinNodes.has(77953)).toBe(false);
  }

  // Case B: Missing-filter WMI batch after closed-root prefetch observes recycled 77962 and new unrelated child 77964 -> never adopt/signal.
  {
    const fakeChild = makeChild(77961);
    const child = fakeChild as unknown as ChildProcess;
    let phase: 'capture' | 'reap' = 'capture';
    let reapWmiCall = 0;
    const killedWinPids: number[] = [];

    const prefetchRecycleOps: WinTreeTestOps = {
      readMsysSnapshot() {
        if (phase === 'capture') {
          return Promise.resolve({
            ok: true,
            rows: [
              { pid: 910, ppid: 1, pgid: 910, winPid: 77961, uid: 197609 },
              { pid: 920, ppid: 910, pgid: 910, winPid: 77962, uid: 197609 },
            ],
          });
        }
        return Promise.resolve({
          ok: true,
          rows: [
            { pid: 920, ppid: 910, pgid: 910, winPid: 77962, uid: 197609 },
            { pid: 921, ppid: 920, pgid: 910, winPid: 77964, uid: 197609 },
          ],
        });
      },
      readWmiSnapshot(_timeoutMs, filterPids) {
        if (phase === 'capture') {
          return Promise.resolve({
            ok: true,
            rows: [
              { pid: 77961, parentPid: 4000, creationUs: 100000n },
              { pid: 77962, parentPid: 77961, creationUs: 100010n },
            ],
          });
        }
        reapWmiCall += 1;
        const rows =
          reapWmiCall === 1
            ? [{ pid: 77962, parentPid: 77961, creationUs: 100010n }]
            : [
                { pid: 77962, parentPid: 1, creationUs: 999999n },
                { pid: 77964, parentPid: 77962, creationUs: 1000000n },
              ];
        return Promise.resolve({
          ok: true,
          rows: rows.filter(
            (row) =>
              filterPids === undefined ||
              filterPids.includes(row.pid) ||
              filterPids.includes(row.parentPid),
          ),
        });
      },
      killWinPid(winPid) {
        killedWinPids.push(winPid);
        return Promise.resolve();
      },
      killMsysTargets: () => Promise.resolve(),
    };

    const ownership = await captureProcessTreeOwnership(child, {
      timeoutMs: 500,
      _winTreeOps: prefetchRecycleOps,
    });
    expect(ownership?.ownedWinNodes.has(77962)).toBe(true);

    fakeChild.exitCode = 0;
    fakeChild.stdin.closed = true;
    fakeChild.stdout.closed = true;
    fakeChild.stderr.closed = true;
    phase = 'reap';

    await expect(
      reapChildProcess(child, {
        termTimeoutMs: 400,
        killTimeoutMs: 400,
        processGroup: true,
        _winTreeOps: prefetchRecycleOps,
      }),
    ).rejects.toThrow('test_child_reap_unconfirmed');

    expect(killedWinPids).toEqual([]);
    expect(ownership?.ownedWinNodes.has(77964)).toBe(false);
  }
});
