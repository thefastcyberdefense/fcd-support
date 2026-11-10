import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface BarrierOptions {
  timeoutMs?: number;
}

export interface ExitOptions {
  timeoutMs?: number;
}

export interface ReapOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  /** Only for a test child spawned with detached: true on Unix, or tree cleanup on Windows. */
  processGroup?: boolean;
}

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface BoundedCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}

export interface BoundedCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  child: ChildProcess;
}

/**
 * Await a deterministic barrier string on child.stdout with bounded internal timeout.
 * Rejects promptly on internal timeout, premature exit, or child error, ensuring
 * that the caller enters cleanup before any outer test harness deadline.
 */
export async function waitForBarrier(
  child: ChildProcess,
  barrier: string,
  options?: BarrierOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5000;

  return new Promise<void>((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      child.stdout?.off('data', onStdoutData);
      child.stderr?.off('data', onStderrData);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const settleReject = (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const settleResolve = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onStdoutData = (chunk: Buffer | string) => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stdoutBuffer.includes(barrier)) {
        settleResolve();
      }
    };

    const onStderrData = (chunk: Buffer | string) => {
      stderrBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    };

    const onError = (err: Error) => {
      settleReject(err);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const exitDesc = code !== null ? `code ${String(code)}` : `signal ${String(signal)}`;
      const detail = stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : '';
      settleReject(new Error(`Process exited prematurely with ${exitDesc}${detail}`));
    };

    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
    child.once('error', onError);
    child.once('exit', onExit);

    // Check if child has already exited or failed spawn before listeners were attached
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }

    timer = setTimeout(() => {
      const detail = stderrBuffer.trim() ? ` (stderr: ${stderrBuffer.trim()})` : '';
      settleReject(
        new Error(
          `Process barrier timed out after ${String(timeoutMs)}ms waiting for ${JSON.stringify(barrier)}${detail}`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Await child process exit with an internal bounded deadline.
 */
export async function waitForExit(
  child: ChildProcess,
  options?: ExitOptions,
): Promise<ProcessExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const timeoutMs = options?.timeoutMs ?? 5000;

  return new Promise<ProcessExitResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const settleReject = (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const settleResolve = (result: ProcessExitResult) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(result);
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settleResolve({ code, signal });
    };

    const onError = (err: Error) => {
      settleReject(err);
    };

    child.once('exit', onExit);
    child.once('error', onError);

    if (child.exitCode !== null || child.signalCode !== null) {
      settleResolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    timer = setTimeout(() => {
      settleReject(new Error(`Process exit timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
}

interface GitUsrBinTools {
  psPath: string;
  killPath: string;
}

interface MsysProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  winPid: number;
}

interface WinTreeContext {
  snapshot?: MsysProcessRow[];
  seedWinPids?: Set<number>;
}

let cachedGitUsrBin: GitUsrBinTools | null | undefined;

function findGitUsrBin(): GitUsrBinTools | null {
  if (cachedGitUsrBin !== undefined) return cachedGitUsrBin;
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files (x86)\\Git\\usr\\bin',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry.length > 0)
      .flatMap((entry) => [entry, join(entry, '..', 'usr', 'bin')]),
  ];
  for (const dir of candidates) {
    const psPath = join(dir, 'ps.exe');
    const killPath = join(dir, 'kill.exe');
    if (existsSync(psPath) && existsSync(killPath)) {
      cachedGitUsrBin = { psPath, killPath };
      return cachedGitUsrBin;
    }
  }
  cachedGitUsrBin = null;
  return null;
}

async function execBounded(
  file: string,
  args: string[],
  timeoutMs: number,
  captureStdout = false,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(file, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    if (captureStdout && proc.stdout !== null) {
      proc.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
    }
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout });
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    proc.once('error', () => {
      finish(null);
    });
    proc.once('close', (code) => {
      finish(code);
    });
  });
}

async function readMsysProcessSnapshot(
  psPath: string,
  timeoutMs: number,
): Promise<MsysProcessRow[]> {
  const result = await execBounded(psPath, ['-lW'], timeoutMs, true);
  const rows: MsysProcessRow[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+/u.exec(line);
    if (match !== null) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        winPid: Number(match[4]),
      });
    }
  }
  return rows;
}

function collectMsysTargets(
  rows: readonly MsysProcessRow[],
  seedWinPids: ReadonlySet<number>,
): { msysPids: number[]; pgids: number[] } {
  const roots = rows.filter((row) => seedWinPids.has(row.winPid) && row.pgid > 1);
  if (roots.length === 0) return { msysPids: [], pgids: [] };
  const pgids = new Set(roots.map((row) => row.pgid));
  const msysPids = new Set(roots.map((row) => row.pid));
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      if (
        !msysPids.has(row.pid) &&
        (msysPids.has(row.ppid) || (row.pgid > 1 && pgids.has(row.pgid)))
      ) {
        msysPids.add(row.pid);
        if (row.pgid > 1) pgids.add(row.pgid);
        added = true;
      }
    }
  }
  return { msysPids: [...msysPids], pgids: [...pgids] };
}

async function killMsysTargets(
  gitTools: GitUsrBinTools,
  targets: { msysPids: number[]; pgids: number[] },
  timeoutMs: number,
): Promise<void> {
  if (targets.msysPids.length === 0) return;
  const tasks: Promise<unknown>[] = [
    execBounded(
      gitTools.killPath,
      ['-f', '-s', 'KILL', '--', ...targets.msysPids.map(String)],
      timeoutMs,
    ),
  ];
  if (targets.pgids.length > 0) {
    tasks.push(
      execBounded(
        gitTools.killPath,
        ['-s', 'KILL', '--', ...targets.pgids.map((g) => `-${String(g)}`)],
        timeoutMs,
      ),
    );
  }
  await Promise.all(tasks);
}

async function killWindowsProcessTree(
  pid: number,
  timeoutMs: number,
  context: WinTreeContext = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(25, deadline - Date.now());
  const gitTools = findGitUsrBin();
  if (context.snapshot === undefined && gitTools !== null) {
    context.snapshot = await readMsysProcessSnapshot(gitTools.psPath, remaining());
  }
  const seedWinPids = context.seedWinPids ?? new Set<number>([pid]);
  context.seedWinPids = seedWinPids;

  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  let targets =
    context.snapshot !== undefined
      ? collectMsysTargets(context.snapshot, seedWinPids)
      : { msysPids: [], pgids: [] };

  if (targets.msysPids.length > 0 && gitTools !== null) {
    const [tk] = await Promise.all([
      execBounded(taskkill, ['/PID', String(pid), '/T', '/F'], remaining(), false),
      killMsysTargets(gitTools, targets, remaining()),
    ]);
    return tk.status === 0 || targets.msysPids.length > 0;
  }

  const tk = await execBounded(taskkill, ['/PID', String(pid), '/T', '/F'], remaining(), true);
  for (const match of tk.stdout.matchAll(/\b(\d+)\b/gu)) {
    seedWinPids.add(Number(match[1]));
  }
  if (context.snapshot !== undefined && gitTools !== null) {
    targets = collectMsysTargets(context.snapshot, seedWinPids);
    await killMsysTargets(gitTools, targets, remaining());
  }
  return tk.status === 0 || targets.msysPids.length > 0;
}

/**
 * Boundedly terminate and reap a test-owned child process.
 * Handles never-spawned children, graceful SIGTERM, SIGKILL escalation,
 * and confirms stdio closure.
 */
export async function reapChildProcess(child: ChildProcess, options?: ReapOptions): Promise<void> {
  const termTimeoutMs = options?.termTimeoutMs ?? 1500;
  const killTimeoutMs = options?.killTimeoutMs ?? 1500;
  const processGroup = options?.processGroup === true && process.platform !== 'win32';
  const winProcessTree = options?.processGroup === true && process.platform === 'win32';
  const closeStdio = () => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const pid = child.pid;
  if (pid === undefined) {
    // Failed spawn has no OS actor and never emits exit. Consume a pending
    // spawn error when cleanup was called before the caller observed it.
    const ignoreError = () => undefined;
    child.once('error', ignoreError);
    child.once('close', () => child.off('error', ignoreError));
    closeStdio();
    return;
  }
  const closed = () =>
    (child.exitCode !== null || child.signalCode !== null) &&
    [child.stdin, child.stdout, child.stderr].every((stream) => stream === null || stream.closed);
  const waitForClosure = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (closed()) {
        resolve(true);
        return;
      }
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('close', onClose);
        resolve(closed());
      }, timeoutMs);
      child.once('close', onClose);
    });
  const signal = (value: NodeJS.Signals): boolean => {
    try {
      if (processGroup) {
        process.kill(-pid, value);
        return true;
      }
      return child.kill(value);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  if (!processGroup && closed()) return;
  const winTreeContext: WinTreeContext = {};
  if (winProcessTree && !closed()) {
    const killed = await killWindowsProcessTree(pid, termTimeoutMs, winTreeContext);
    if (!killed && child.exitCode === null && child.signalCode === null) {
      signal('SIGTERM');
    }
  } else {
    signal('SIGTERM');
  }
  let confirmed = await waitForClosure(termTimeoutMs);
  // A group member can retain the lock even after its shell exits or closes
  // stdio. Kill only the explicitly detached, test-owned process group.
  if (processGroup || !confirmed) {
    if (winProcessTree && !closed()) {
      await killWindowsProcessTree(pid, killTimeoutMs, winTreeContext);
    }
    const signaled = signal('SIGKILL');
    confirmed = await waitForClosure(killTimeoutMs);
    if (processGroup && !signaled) confirmed = false;
  }
  if (!confirmed) throw new Error('test_child_reap_unconfirmed');
  closeStdio();
}

/** Attempt every owned cleanup, then propagate any unresolved child. */
export async function reapChildProcesses(
  children: ChildProcess[],
  options?: ReapOptions,
): Promise<void> {
  const results = await Promise.allSettled(
    children.map((child) => reapChildProcess(child, options)),
  );
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('test_child_reap_unconfirmed');
}

/**
 * Run a child command with bounded execution timeout and guaranteed process-tree reaping.
 * Ensures stdio drainage completes on exit and reaps descendants before returning.
 */
export async function runBoundedCommand(
  command: string,
  args: string[],
  options?: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const timeoutMs = options?.timeoutMs ?? 3500;
  const termTimeoutMs = options?.termTimeoutMs ?? 500;
  const killTimeoutMs = options?.killTimeoutMs ?? 500;
  const child = spawn(command, args, {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const onStdout = (chunk: Buffer | string) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  };
  const onStderr = (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  try {
    const exit = await waitForExit(child, { timeoutMs });
    if (![child.stdout, child.stderr].every((s) => s.closed || s.readableEnded)) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const done = () => {
          if (timer !== null) clearTimeout(timer);
          child.off('close', done);
          resolve();
        };
        timer = setTimeout(done, termTimeoutMs);
        child.once('close', done);
      });
    }
    return { status: exit.code, signal: exit.signal, stdout, stderr, child };
  } finally {
    try {
      await reapChildProcess(child, {
        termTimeoutMs,
        killTimeoutMs,
        processGroup: true,
      });
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
    }
  }
}
