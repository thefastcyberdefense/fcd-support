import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BarrierOptions {
  timeoutMs?: number;
}

export interface ExitOptions {
  timeoutMs?: number;
}

export interface MsysProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  winPid: number;
  uid: number;
}

export interface Win32ProcessRow {
  pid: number;
  parentPid: number;
  creationUs: bigint;
}

export interface ProcessTreeOwnership {
  observedRoot: boolean;
  rootPid: number;
  rootCreationUs: bigint | null;
  ownedWinNodes: Map<number, bigint>;
  ownedMsysPgids: Set<number>;
  ownedMsysUids: Set<number>;
  capturedAtMs?: number;
  recentWmiRows?: Win32ProcessRow[];
  initialMsysRows?: Map<number, MsysProcessRow>;
}

export interface WinTreeTestOps {
  readMsysSnapshot: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; rows: MsysProcessRow[] }>;
  readWmiSnapshot: (
    timeoutMs: number,
    filterPids?: readonly number[],
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; rows: Win32ProcessRow[] }>;
  killWinPid: (winPid: number, timeoutMs: number) => Promise<void>;
  killWinPids?: (winPids: number[], timeoutMs: number) => Promise<void>;
  killMsysTargets: (
    targets: { msysPids: number[]; pgids: number[] },
    timeoutMs: number,
  ) => Promise<void>;
}

export interface CaptureOwnershipOptions {
  timeoutMs?: number;
  _winTreeOps?: WinTreeTestOps;
}

export interface ReapOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  /** Only for a test child spawned with detached: true on Unix, or tree cleanup on Windows. */
  processGroup?: boolean;
  /** Shared wall-clock deadline across execution, inspection, signals, and confirmation. */
  deadlineAtMs?: number;
  /** Internal shared graceful-phase deadline when drain and reap share one budget. */
  termDeadlineAtMs?: number;
  /** Internal deterministic test seam for Windows tree inspection/kill behavior. */
  _winTreeOps?: WinTreeTestOps;
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

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const WIN32_SNAPSHOT_SCRIPT = join(HELPER_DIR, 'win32-process-snapshot.vbs');

interface ActiveCaptureControl {
  abortController: AbortController;
  clampDeadline: (maxDeadlineMs: number) => void;
}

const ownershipByChild = new WeakMap<ChildProcess, Promise<ProcessTreeOwnership | null>>();
const activeCaptureControls = new WeakMap<ChildProcess, ActiveCaptureControl>();
const confirmedDirectReapSet = new WeakSet<ChildProcess>();
const confirmedTreeReapSet = new WeakSet<ChildProcess>();

const AUTO_CAPTURE_MIN_TIMEOUT_MS = 1200;

function startAutoOwnershipCapture(
  child: ChildProcess,
  timeoutMs: number,
  maxCallerBudgetMs?: number,
): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const requestedFloorMs = Math.max(timeoutMs, AUTO_CAPTURE_MIN_TIMEOUT_MS);
    const boundedCaptureMs =
      maxCallerBudgetMs !== undefined
        ? Math.min(Math.max(0, maxCallerBudgetMs), requestedFloorMs)
        : requestedFloorMs;
    void captureProcessTreeOwnership(child, {
      timeoutMs: boundedCaptureMs,
    }).catch(() => null);
  }
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
  startAutoOwnershipCapture(child, timeoutMs);

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
  startAutoOwnershipCapture(child, timeoutMs);

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

function systemToolPath(exe: string): string {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return join(sysRoot, 'System32', exe);
}

async function execBounded(
  file: string,
  args: string[],
  timeoutMs: number,
  captureStdout = false,
  signal?: AbortSignal,
): Promise<{ status: number | null; stdout: string; timedOut: boolean }> {
  if (timeoutMs <= 0 || signal?.aborted) {
    return { status: null, stdout: '', timedOut: true };
  }
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
    const finish = (status: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ status, stdout, timedOut });
    };
    const killHard = () => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore termination failure after expiry/abort.
      }
      finish(null, true);
    };
    const onAbort = () => {
      killHard();
    };
    const timer = setTimeout(killHard, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.once('error', () => {
      finish(null, false);
    });
    proc.once('close', (code) => {
      finish(code, false);
    });
  });
}

async function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  fallback: T,
): Promise<T> {
  if (signal.aborted) {
    return fallback;
  }
  return new Promise<T>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(fallback);
      },
    );
  });
}

function parseMsysSnapshot(stdout: string): MsysProcessRow[] {
  const rows: MsysProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    // Capture strictly numeric process identifiers; ignore command lines/paths.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(\d+)\s+/u.exec(line);
    if (match !== null) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        winPid: Number(match[4]),
        uid: Number(match[5]),
      });
    }
  }
  return rows;
}

function parseWmiCreationUs(raw: string): bigint | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/u.exec(
    raw.trim(),
  );
  if (match === null) return null;
  const utcMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  const offsetMinutes = Number(match[8]);
  return BigInt(utcMs - offsetMinutes * 60_000) * 1000n + BigInt(Number(match[7]));
}

function parseWmiSnapshot(stdout: string): Win32ProcessRow[] {
  const rows: Win32ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(',');
    if (parts.length !== 3) continue;
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    const creationUs = parseWmiCreationUs(parts[2] ?? '');
    if (
      Number.isSafeInteger(pid) &&
      pid > 4 &&
      Number.isSafeInteger(parentPid) &&
      parentPid >= 0 &&
      creationUs !== null
    ) {
      rows.push({ pid, parentPid, creationUs });
    }
  }
  return rows;
}

const defaultWinTreeOps: WinTreeTestOps = {
  async readMsysSnapshot(timeoutMs: number, signal?: AbortSignal) {
    const tools = findGitUsrBin();
    if (tools === null) return { ok: false, rows: [] };
    const result = await execBounded(tools.psPath, ['-lW'], timeoutMs, true, signal);
    if (result.timedOut || result.status !== 0) {
      return { ok: false, rows: [] };
    }
    return { ok: true, rows: parseMsysSnapshot(result.stdout) };
  },
  async readWmiSnapshot(timeoutMs: number, filterPids?: readonly number[], signal?: AbortSignal) {
    if (!existsSync(WIN32_SNAPSHOT_SCRIPT)) {
      return { ok: false, rows: [] };
    }
    const validFilterArgs =
      filterPids !== undefined && filterPids.length > 0 && filterPids.length <= 24
        ? [...new Set(filterPids)].filter((pid) => Number.isSafeInteger(pid) && pid > 4).map(String)
        : [];
    const result = await execBounded(
      systemToolPath('cscript.exe'),
      ['//Nologo', WIN32_SNAPSHOT_SCRIPT, ...validFilterArgs],
      timeoutMs,
      true,
      signal,
    );
    if (result.timedOut || result.status !== 0) {
      return { ok: false, rows: [] };
    }
    return { ok: true, rows: parseWmiSnapshot(result.stdout) };
  },
  async killWinPid(winPid: number, timeoutMs: number) {
    await defaultWinTreeOps.killWinPids?.([winPid], timeoutMs);
  },
  async killWinPids(winPids: number[], timeoutMs: number) {
    const fallbackPids: number[] = [];
    for (const winPid of winPids) {
      if (!Number.isSafeInteger(winPid) || winPid <= 4) continue;
      try {
        process.kill(winPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          fallbackPids.push(winPid);
        }
      }
    }
    if (fallbackPids.length > 0) {
      await execBounded(
        systemToolPath('taskkill.exe'),
        ['/T', '/F', ...fallbackPids.flatMap((winPid) => ['/PID', String(winPid)])],
        timeoutMs,
        false,
      );
    }
  },
  async killMsysTargets(targets, timeoutMs: number) {
    const tools = findGitUsrBin();
    if (tools === null) return;
    const args = [...targets.msysPids.map(String), ...targets.pgids.map((g) => `-${String(g)}`)];
    if (args.length === 0) return;
    await execBounded(tools.killPath, ['-s', 'KILL', '--', ...args], timeoutMs);
  },
};

function expandOwnedWinNodes(
  ownedWinNodes: Map<number, bigint>,
  wmiRows: readonly Win32ProcessRow[],
  wmiByPid: ReadonlyMap<number, Win32ProcessRow>,
): void {
  let added = true;
  while (added) {
    added = false;
    for (const row of wmiRows) {
      if (row.pid <= 4 || ownedWinNodes.has(row.pid)) continue;
      const parentCreationUs = ownedWinNodes.get(row.parentPid);
      if (parentCreationUs === undefined) continue;
      const liveParent = wmiByPid.get(row.parentPid);
      // Traverse only while the captured parent still matches its CreationDate.
      if (liveParent?.creationUs === parentCreationUs && row.creationUs >= parentCreationUs) {
        ownedWinNodes.set(row.pid, row.creationUs);
        added = true;
      }
    }
  }
}

function sameMsysIdentity(a: MsysProcessRow, b: MsysProcessRow): boolean {
  return (
    a.pid === b.pid &&
    a.ppid === b.ppid &&
    a.pgid === b.pgid &&
    a.winPid === b.winPid &&
    a.uid === b.uid
  );
}

/**
 * Capture verifiable Windows/MSYS2 process-tree ownership while a test child is still alive.
 * Uses strictly numeric process IDs, parent links, creation timestamps, PGIDs, and UIDs.
 */
export async function captureProcessTreeOwnership(
  child: ChildProcess,
  options?: CaptureOwnershipOptions,
): Promise<ProcessTreeOwnership | null> {
  if (process.platform !== 'win32' && options?._winTreeOps === undefined) {
    return null;
  }
  const pid = child.pid;
  if (pid === undefined) return null;

  const existing = ownershipByChild.get(child);
  if (existing !== undefined) {
    return existing;
  }

  const timeoutMs = Math.max(0, options?.timeoutMs ?? 1500);
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  let effectiveDeadlineMs = Date.now() + timeoutMs;
  let deadlineTimer: NodeJS.Timeout | null = null;

  const rearmAbortTimer = () => {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (abortSignal.aborted) return;
    const rem = Math.max(0, effectiveDeadlineMs - Date.now());
    if (rem <= 0) {
      abortController.abort();
      return;
    }
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      abortController.abort();
    }, rem);
  };

  const captureControl: ActiveCaptureControl = {
    abortController,
    clampDeadline: (maxDeadlineMs: number) => {
      if (maxDeadlineMs < effectiveDeadlineMs) {
        effectiveDeadlineMs = maxDeadlineMs;
        rearmAbortTimer();
      }
    },
  };
  activeCaptureControls.set(child, captureControl);
  rearmAbortTimer();

  const getRemainingMs = () =>
    abortSignal.aborted ? 0 : Math.max(0, effectiveDeadlineMs - Date.now());

  const runCapture = async (): Promise<ProcessTreeOwnership | null> => {
    const ops = options?._winTreeOps ?? defaultWinTreeOps;
    const emptyOwnership: ProcessTreeOwnership = {
      observedRoot: false,
      rootPid: pid,
      rootCreationUs: null,
      ownedWinNodes: new Map<number, bigint>(),
      ownedMsysPgids: new Set<number>(),
      ownedMsysUids: new Set<number>(),
    };

    const isRootAlive = () => child.exitCode === null && child.signalCode === null;
    const isAborted = () => abortSignal.aborted;
    if (!isRootAlive() || isAborted()) {
      return emptyOwnership;
    }

    const [wmiResult, msysResult] = await awaitAbortable(
      Promise.all([
        ops.readWmiSnapshot(getRemainingMs(), undefined, abortSignal),
        ops.readMsysSnapshot(getRemainingMs(), abortSignal),
      ]),
      abortSignal,
      [
        { ok: false, rows: [] },
        { ok: false, rows: [] },
      ],
    );
    if (!wmiResult.ok || !msysResult.ok || isAborted()) {
      return emptyOwnership;
    }

    const wmiByPid = new Map<number, Win32ProcessRow>();
    for (const row of wmiResult.rows) {
      wmiByPid.set(row.pid, row);
    }
    const rootRow = wmiByPid.get(pid);
    if (rootRow === undefined) {
      return emptyOwnership;
    }

    const ownedWinNodes = new Map<number, bigint>([[pid, rootRow.creationUs]]);
    expandOwnedWinNodes(ownedWinNodes, wmiResult.rows, wmiByPid);

    const ownedMsysPgids = new Set<number>();
    const ownedMsysUids = new Set<number>();
    const ownedMsysPids = new Set<number>();
    const verifiedMsysByPid = new Map<number, MsysProcessRow>();

    const recordVerifiedMsys = (row: MsysProcessRow) => {
      ownedMsysPids.add(row.pid);
      verifiedMsysByPid.set(row.pid, row);
      if (row.pgid > 1) {
        ownedMsysPgids.add(row.pgid);
        ownedMsysUids.add(row.uid);
      }
    };

    for (const row of msysResult.rows) {
      const capturedCreation = ownedWinNodes.get(row.winPid);
      if (capturedCreation === undefined) continue;
      recordVerifiedMsys(row);
    }

    const unresolvedByMsysPid = new Map<number, MsysProcessRow>();
    let addedMsys = true;
    while (addedMsys) {
      addedMsys = false;
      for (const row of msysResult.rows) {
        if (ownedMsysPids.has(row.pid)) continue;
        const matchesLineage =
          ownedMsysPids.has(row.ppid) ||
          unresolvedByMsysPid.has(row.ppid) ||
          (row.pgid > 1 && ownedMsysPgids.has(row.pgid) && ownedMsysUids.has(row.uid));
        if (!matchesLineage) continue;

        const liveWmi = wmiByPid.get(row.winPid);
        const parentCreation =
          liveWmi !== undefined ? ownedWinNodes.get(liveWmi.parentPid) : undefined;
        const parentCompatible =
          parentCreation === undefined ||
          (liveWmi !== undefined && liveWmi.creationUs >= parentCreation);

        if (liveWmi !== undefined && liveWmi.creationUs >= rootRow.creationUs && parentCompatible) {
          ownedWinNodes.set(row.winPid, liveWmi.creationUs);
          recordVerifiedMsys(row);
          unresolvedByMsysPid.delete(row.pid);
          addedMsys = true;
        } else if (
          liveWmi === undefined &&
          Number.isSafeInteger(row.winPid) &&
          row.winPid > 4 &&
          !unresolvedByMsysPid.has(row.pid)
        ) {
          unresolvedByMsysPid.set(row.pid, row);
          addedMsys = true;
        }
      }
    }

    // Coherent t1 -> t2 -> t3 verification for MSYS children absent from t1 WMI:
    // require an unchanged post-WMI MSYS identity and continuously live MSYS anchors
    // before adopting any newly returned WinPID, preventing WinPID recycle adoption.
    if (unresolvedByMsysPid.size > 0 && isRootAlive() && getRemainingMs() > 0 && !isAborted()) {
      const unresolvedWinPids = new Set<number>();
      for (const row of unresolvedByMsysPid.values()) {
        unresolvedWinPids.add(row.winPid);
      }
      const followUpFilterPids = [...new Set([...ownedWinNodes.keys(), ...unresolvedWinPids])];
      const missingWmi = await awaitAbortable(
        ops.readWmiSnapshot(getRemainingMs(), followUpFilterPids, abortSignal),
        abortSignal,
        { ok: false, rows: [] },
      );

      if (
        missingWmi.ok &&
        missingWmi.rows.length > 0 &&
        isRootAlive() &&
        getRemainingMs() > 0 &&
        !isAborted()
      ) {
        const missingWmiByPid = new Map<number, Win32ProcessRow>();
        for (const row of missingWmi.rows) {
          missingWmiByPid.set(row.pid, row);
        }
        const missingRoot = missingWmiByPid.get(pid);
        const hasLiveUnresolvedCandidate = missingWmi.rows.some(
          (row) => unresolvedWinPids.has(row.pid) && row.creationUs >= rootRow.creationUs,
        );
        if (missingRoot?.creationUs === rootRow.creationUs && hasLiveUnresolvedCandidate) {
          const confirmMsys = await awaitAbortable(
            ops.readMsysSnapshot(getRemainingMs(), abortSignal),
            abortSignal,
            { ok: false, rows: [] },
          );
          if (confirmMsys.ok && isRootAlive() && !isAborted()) {
            const confirmByPid = new Map<number, MsysProcessRow>();
            for (const row of confirmMsys.rows) {
              confirmByPid.set(row.pid, row);
            }

            const liveAnchorMsysPids = new Set<number>();
            const liveAnchorGroupKeys = new Set<string>();
            let rootAnchorFailed = false;

            for (const [anchorPid, initRow] of verifiedMsysByPid.entries()) {
              const confirmRow = confirmByPid.get(anchorPid);
              const expectedCreation = ownedWinNodes.get(initRow.winPid);
              const t2Win = missingWmiByPid.get(initRow.winPid);
              const anchorIntact =
                confirmRow !== undefined &&
                sameMsysIdentity(initRow, confirmRow) &&
                expectedCreation !== undefined &&
                t2Win?.creationUs === expectedCreation;
              if (anchorIntact) {
                liveAnchorMsysPids.add(anchorPid);
                if (initRow.pgid > 1) {
                  liveAnchorGroupKeys.add(`${String(initRow.pgid)}:${String(initRow.uid)}`);
                }
              } else if (initRow.winPid === pid) {
                rootAnchorFailed = true;
              }
            }

            if (!rootAnchorFailed && liveAnchorMsysPids.size > 0) {
              let adoptedAny = false;
              let adoptedThisRound = true;
              while (adoptedThisRound) {
                adoptedThisRound = false;
                for (const [msysPid, t1Row] of unresolvedByMsysPid.entries()) {
                  const t3Row = confirmByPid.get(msysPid);
                  const t2Win = missingWmiByPid.get(t1Row.winPid);
                  if (t3Row === undefined || !sameMsysIdentity(t1Row, t3Row)) continue;
                  if (t2Win === undefined || t2Win.creationUs < rootRow.creationUs) continue;

                  const expectedParentCreation = ownedWinNodes.get(t2Win.parentPid);
                  if (expectedParentCreation !== undefined) {
                    const t2Parent = missingWmiByPid.get(t2Win.parentPid);
                    if (
                      t2Win.creationUs < expectedParentCreation ||
                      (t2Parent !== undefined && t2Parent.creationUs !== expectedParentCreation)
                    ) {
                      continue;
                    }
                  }

                  const hasLiveAnchor =
                    liveAnchorMsysPids.has(t3Row.ppid) ||
                    (t3Row.pgid > 1 &&
                      liveAnchorGroupKeys.has(`${String(t3Row.pgid)}:${String(t3Row.uid)}`));
                  if (!hasLiveAnchor) continue;

                  if (!wmiByPid.has(t2Win.pid)) {
                    wmiResult.rows.push(t2Win);
                    wmiByPid.set(t2Win.pid, t2Win);
                  }
                  ownedWinNodes.set(t1Row.winPid, t2Win.creationUs);
                  recordVerifiedMsys(t3Row);
                  liveAnchorMsysPids.add(t3Row.pid);
                  if (t3Row.pgid > 1) {
                    liveAnchorGroupKeys.add(`${String(t3Row.pgid)}:${String(t3Row.uid)}`);
                  }
                  unresolvedByMsysPid.delete(msysPid);
                  adoptedAny = true;
                  adoptedThisRound = true;
                }
              }
              if (adoptedAny) {
                expandOwnedWinNodes(ownedWinNodes, wmiResult.rows, wmiByPid);
              }
            }
          }
        }
      }
    }

    const initialMsysRows = new Map<number, MsysProcessRow>();
    for (const [msysPid, row] of verifiedMsysByPid.entries()) {
      initialMsysRows.set(msysPid, row);
    }

    return {
      observedRoot: true,
      rootPid: pid,
      rootCreationUs: rootRow.creationUs,
      ownedWinNodes,
      ownedMsysPgids,
      ownedMsysUids,
      capturedAtMs: Date.now(),
      recentWmiRows: wmiResult.rows,
      initialMsysRows,
    };
  };

  const promise = runCapture()
    .then((result) => {
      if (!result?.observedRoot) {
        if (ownershipByChild.get(child) === promise) {
          ownershipByChild.delete(child);
        }
      }
      return result;
    })
    .finally(() => {
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (activeCaptureControls.get(child) === captureControl) {
        activeCaptureControls.delete(child);
      }
    });
  ownershipByChild.set(child, promise);
  return promise;
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function awaitWithDeadline<T>(promise: Promise<T>, deadlineMs: number, fallback: T): Promise<T> {
  const rem = remainingMs(deadlineMs);
  if (rem <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, rem);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

function isPosixGroupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (process.platform !== 'linux') {
    return false;
  }
  // In Linux containers without an init reaper (--init), killed descendants
  // reparented to PID 1 remain in state Z/X with FDs/locks closed while
  // kill(-pgid, 0) still returns 0. Inspect /proc/<pid>/stat so only live
  // non-zombie members keep the process group considered active.
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return false;
  }
  let sawReadableStat = false;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    const rparen = raw.lastIndexOf(')');
    if (rparen === -1) continue;
    sawReadableStat = true;
    const fields = raw
      .slice(rparen + 2)
      .trimStart()
      .split(/\s+/u);
    const state = fields[0];
    const taskPgrp = Number(fields[2]);
    if (taskPgrp === pgid && state !== 'Z' && state !== 'X') {
      return false;
    }
  }
  return sawReadableStat;
}

async function waitForPosixGroupGone(pgid: number, deadlineMs: number): Promise<boolean> {
  if (isPosixGroupGone(pgid)) {
    return true;
  }
  while (remainingMs(deadlineMs) > 0) {
    const stepMs = Math.min(15, remainingMs(deadlineMs));
    if (stepMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (isPosixGroupGone(pgid)) {
      return true;
    }
  }
  return false;
}

function collectCandidateMsys(
  rows: readonly MsysProcessRow[],
  ownership: ProcessTreeOwnership,
): Map<number, MsysProcessRow> {
  const isCandidateMsys = (row: MsysProcessRow) =>
    ownership.ownedWinNodes.has(row.winPid) ||
    (row.pgid > 1 &&
      ownership.ownedMsysPgids.has(row.pgid) &&
      ownership.ownedMsysUids.has(row.uid));

  const candidates = new Map<number, MsysProcessRow>();
  for (const row of rows) {
    if (isCandidateMsys(row)) {
      candidates.set(row.pid, row);
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      if (!candidates.has(row.pid) && candidates.has(row.ppid)) {
        candidates.set(row.pid, row);
        added = true;
      }
    }
  }
  return candidates;
}

async function inspectAndOptionallyReapWinTree(
  child: ChildProcess,
  ownership: ProcessTreeOwnership,
  winOps: WinTreeTestOps,
  rootClosed: () => boolean,
  deadlineMs: number,
  performKill: boolean,
  waitClosureUntilMs: (untilMs: number) => Promise<boolean>,
  requireWmiConfirmation = false,
): Promise<boolean> {
  const rootStillRunning = child.exitCode === null && child.signalCode === null;

  const canReuseRecentWmiWindow =
    performKill &&
    rootStillRunning &&
    ownership.recentWmiRows !== undefined &&
    ownership.capturedAtMs !== undefined &&
    Date.now() - ownership.capturedAtMs < 250;

  const knownOwnedWinPids = [...ownership.ownedWinNodes.keys()].filter(
    (winPid) => Number.isSafeInteger(winPid) && winPid > 4,
  );
  const prefetchFilterPids =
    knownOwnedWinPids.length > 0 && knownOwnedWinPids.length <= 24 ? knownOwnedWinPids : undefined;

  // Overlap MSYS and filtered WMI for closed-root reap (where children stopped spawning),
  // or confirmation that inspects non-MSYS native descendants.
  // For an older still-running tree, read MSYS first so one filtered WMI query covers new children.
  const shouldOverlapClosedWmi =
    (performKill && !canReuseRecentWmiWindow && !rootStillRunning) ||
    (!performKill && rootClosed() && requireWmiConfirmation);
  const [msysInitial, prefetchedWmi] = shouldOverlapClosedWmi
    ? await Promise.all([
        winOps.readMsysSnapshot(remainingMs(deadlineMs)),
        winOps.readWmiSnapshot(remainingMs(deadlineMs), prefetchFilterPids),
      ])
    : [await winOps.readMsysSnapshot(remainingMs(deadlineMs)), null];

  let msysResult = msysInitial;
  if (!msysResult.ok) return false;

  let candidateMsys = collectCandidateMsys(msysResult.rows, ownership);

  const prefetchedShowsOwnedOrChild = (): boolean => {
    if (prefetchedWmi === null) return false;
    if (!prefetchedWmi.ok) return true;
    return prefetchedWmi.rows.some((row) => {
      const knownSelf = ownership.ownedWinNodes.get(row.pid);
      if (
        row.pid !== ownership.rootPid &&
        knownSelf !== undefined &&
        row.creationUs === knownSelf
      ) {
        return true;
      }
      const knownParent = ownership.ownedWinNodes.get(row.parentPid);
      if (knownParent !== undefined && row.creationUs >= knownParent) {
        return true;
      }
      return false;
    });
  };

  const canFastConfirmOnEmptyMsys = (): boolean => {
    if (candidateMsys.size > 0 || !rootClosed()) {
      return false;
    }
    if (prefetchedWmi !== null) {
      return prefetchedWmi.ok && !prefetchedShowsOwnedOrChild();
    }
    return !requireWmiConfirmation;
  };

  // Fast confirmed exit path: root and stdio are closed and no tracked WinPID, PGID, or native descendant remains.
  if (canFastConfirmOnEmptyMsys()) {
    return true;
  }

  // Right after hard kills complete on MSYS-only trees, Windows/MSYS2 teardown may clear a few ms later.
  // Poll ps.exe once before spending a full WMI snapshot on confirmation.
  if (
    !performKill &&
    rootClosed() &&
    !requireWmiConfirmation &&
    prefetchedWmi === null &&
    remainingMs(deadlineMs) > 40
  ) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(35, remainingMs(deadlineMs))));
    const retryMsys = await winOps.readMsysSnapshot(remainingMs(deadlineMs));
    if (!retryMsys.ok) return false;
    msysResult = retryMsys;
    candidateMsys = collectCandidateMsys(msysResult.rows, ownership);
    if (canFastConfirmOnEmptyMsys()) {
      return true;
    }
  }

  if (remainingMs(deadlineMs) <= 0) {
    return false;
  }

  const candidateMsysWinPids = new Set<number>(
    [...candidateMsys.values()].map((row) => row.winPid),
  );

  const allLiveCandidatesUnchanged =
    performKill &&
    canReuseRecentWmiWindow &&
    prefetchedWmi === null &&
    winOps === defaultWinTreeOps &&
    ownership.initialMsysRows !== undefined &&
    candidateMsys.size > 0 &&
    knownOwnedWinPids.every(
      (winPid) => winPid === ownership.rootPid || candidateMsysWinPids.has(winPid),
    ) &&
    [...candidateMsys.values()].every((row) => {
      if (row.winPid === ownership.rootPid) return true;
      const initial = ownership.initialMsysRows?.get(row.pid);
      return (
        initial?.ppid === row.ppid &&
        initial.pgid === row.pgid &&
        initial.winPid === row.winPid &&
        initial.uid === row.uid
      );
    });

  if (allLiveCandidatesUnchanged) {
    const fastWinPids = [...new Set([ownership.rootPid, ...candidateMsysWinPids])];
    const fastMsysPids = [...candidateMsys.keys()];
    const fastPgids = [...ownership.ownedMsysPgids];
    const fastBudgetMs = remainingMs(deadlineMs);
    const fastTasks: Promise<unknown>[] = [
      winOps.killWinPids !== undefined
        ? winOps.killWinPids(fastWinPids, fastBudgetMs)
        : Promise.all(fastWinPids.map((wp) => winOps.killWinPid(wp, fastBudgetMs))),
    ];
    if (fastMsysPids.length > 0 || fastPgids.length > 0) {
      fastTasks.push(
        winOps.killMsysTargets({ msysPids: fastMsysPids, pgids: fastPgids }, fastBudgetMs),
      );
    }
    await Promise.all(fastTasks);
    await waitClosureUntilMs(deadlineMs);
    if (!rootClosed() || remainingMs(deadlineMs) <= 0) {
      return false;
    }
    return inspectAndOptionallyReapWinTree(
      child,
      ownership,
      winOps,
      rootClosed,
      deadlineMs,
      false,
      waitClosureUntilMs,
      false,
    );
  }

  const filterPids = [
    ...new Set([
      ...ownership.ownedWinNodes.keys(),
      ...[...candidateMsys.values()].map((row) => row.winPid),
    ]),
  ];
  const queriedWmiPidSet = new Set(
    filterPids.filter((winPid) => Number.isSafeInteger(winPid) && winPid > 4),
  );
  const queriedParentPids = new Set<number>();

  const recentWmiRows = ownership.recentWmiRows ?? [];
  const recentWmiPidSet = new Set(recentWmiRows.map((row) => row.pid));
  const candidateWinPidsOwned = [...candidateMsys.values()].every((row) =>
    ownership.ownedWinNodes.has(row.winPid),
  );
  const canReuseRecentWmi =
    canReuseRecentWmiWindow &&
    candidateWinPidsOwned &&
    filterPids.every((winPid) => recentWmiPidSet.has(winPid));

  let skippedFreshWmi = false;
  let wmiResult: { ok: boolean; rows: Win32ProcessRow[] };
  if (canReuseRecentWmi) {
    skippedFreshWmi = true;
    wmiResult = { ok: true, rows: [...recentWmiRows] };
    for (const qPid of queriedWmiPidSet) {
      queriedParentPids.add(qPid);
    }
  } else if (prefetchedWmi !== null) {
    if (!prefetchedWmi.ok) return false;
    const wmiRows = [...prefetchedWmi.rows];
    if (prefetchFilterPids !== undefined) {
      for (const qPid of prefetchFilterPids) {
        if (Number.isSafeInteger(qPid) && qPid > 4) {
          queriedParentPids.add(qPid);
        }
      }
      const prefetchFilterSet = new Set(prefetchFilterPids);
      const prefetchedRowPidSet = new Set(wmiRows.map((row) => row.pid));
      const missingFilterPids = filterPids.filter(
        (winPid) =>
          Number.isSafeInteger(winPid) &&
          winPid > 4 &&
          !prefetchFilterSet.has(winPid) &&
          !prefetchedRowPidSet.has(winPid),
      );
      if (missingFilterPids.length > 0) {
        const missingSet = new Set(missingFilterPids);
        const extraUnqueriedChildren = wmiRows
          .map((row) => row.pid)
          .filter(
            (winPid) =>
              Number.isSafeInteger(winPid) &&
              winPid > 4 &&
              !prefetchFilterSet.has(winPid) &&
              !missingSet.has(winPid),
          );
        const batchPids =
          missingFilterPids.length + extraUnqueriedChildren.length <= 24
            ? [...missingFilterPids, ...extraUnqueriedChildren]
            : missingFilterPids;
        const missingWmi = await winOps.readWmiSnapshot(remainingMs(deadlineMs), batchPids);
        if (!missingWmi.ok) return false;
        for (const qPid of batchPids) {
          queriedParentPids.add(qPid);
        }
        for (const row of missingWmi.rows) {
          if (!prefetchedRowPidSet.has(row.pid)) {
            prefetchedRowPidSet.add(row.pid);
            wmiRows.push(row);
          }
        }
      }
    } else {
      for (const qPid of queriedWmiPidSet) {
        queriedParentPids.add(qPid);
      }
      for (const row of wmiRows) {
        queriedParentPids.add(row.pid);
      }
    }
    wmiResult = { ok: true, rows: wmiRows };
  } else {
    wmiResult = await winOps.readWmiSnapshot(remainingMs(deadlineMs), filterPids);
    if (!wmiResult.ok) return false;
    for (const qPid of queriedWmiPidSet) {
      queriedParentPids.add(qPid);
    }
    if ((filterPids.length === 0 || filterPids.length > 24) && winOps === defaultWinTreeOps) {
      for (const row of wmiResult.rows) {
        queriedParentPids.add(row.pid);
      }
    }
  }
  if (!wmiResult.ok) return false;

  const wmiByPid = new Map<number, Win32ProcessRow>();
  const verifiedWinPids = new Set<number>();
  const liveCapturedGroups = new Set<string>();
  const verifiedMsysPids: number[] = [];
  const verifiedMsysPidSet = new Set<number>();
  const candidatePgidsWithUnownedMember = new Set<number>();
  const verifiedCandidatePgids = new Set<number>();
  const rootCreationUs = ownership.rootCreationUs;

  const recomputeVerifiedTree = () => {
    wmiByPid.clear();
    for (const row of wmiResult.rows) {
      wmiByPid.set(row.pid, row);
    }

    verifiedWinPids.clear();
    for (const [winPid, capturedCreationUs] of ownership.ownedWinNodes.entries()) {
      const liveRow = wmiByPid.get(winPid);
      if (liveRow?.creationUs === capturedCreationUs) {
        verifiedWinPids.add(winPid);
      }
    }

    // Freeze group anchors before admitting any new candidate. A group number and
    // later birth alone do not establish ownership after all captured actors exit.
    liveCapturedGroups.clear();
    for (const row of msysResult.rows) {
      const captured = ownership.ownedWinNodes.get(row.winPid);
      if (
        captured !== undefined &&
        wmiByPid.get(row.winPid)?.creationUs === captured &&
        ownership.ownedMsysPgids.has(row.pgid) &&
        ownership.ownedMsysUids.has(row.uid)
      ) {
        liveCapturedGroups.add(`${String(row.pgid)}:${String(row.uid)}`);
      }
    }

    let converged = true;
    while (converged) {
      converged = false;
      // Expand newly spawned Win32 children of verified live nodes without crossing reused PIDs.
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const row of wmiResult.rows) {
          if (row.pid <= 4 || verifiedWinPids.has(row.pid)) continue;
          if (!verifiedWinPids.has(row.parentPid)) continue;
          const parentRow = wmiByPid.get(row.parentPid);
          if (parentRow === undefined || row.creationUs < parentRow.creationUs) continue;
          const previouslyCaptured = ownership.ownedWinNodes.get(row.pid);
          if (previouslyCaptured !== undefined && previouslyCaptured !== row.creationUs) continue;
          ownership.ownedWinNodes.set(row.pid, row.creationUs);
          verifiedWinPids.add(row.pid);
          expanded = true;
          converged = true;
        }
      }

      for (const row of candidateMsys.values()) {
        const liveWmi = wmiByPid.get(row.winPid);
        const knownCreation = ownership.ownedWinNodes.get(row.winPid);
        const isVerified =
          liveWmi !== undefined &&
          (knownCreation !== undefined
            ? liveWmi.creationUs === knownCreation
            : liveCapturedGroups.has(`${String(row.pgid)}:${String(row.uid)}`) &&
              rootCreationUs !== null &&
              liveWmi.creationUs >= rootCreationUs);

        if (isVerified) {
          const wasVerified = verifiedWinPids.has(row.winPid);
          ownership.ownedWinNodes.set(row.winPid, liveWmi.creationUs);
          verifiedWinPids.add(row.winPid);
          if (!wasVerified) {
            converged = true;
          }
          if (row.pgid > 1) {
            if (!verifiedMsysPidSet.has(row.pid)) {
              verifiedMsysPidSet.add(row.pid);
              verifiedMsysPids.push(row.pid);
            }
            verifiedCandidatePgids.add(row.pgid);
          }
        }
      }
    }

    candidatePgidsWithUnownedMember.clear();
    for (const row of candidateMsys.values()) {
      const liveWmi = wmiByPid.get(row.winPid);
      const knownCreation = ownership.ownedWinNodes.get(row.winPid);
      const isVerified =
        liveWmi !== undefined &&
        (knownCreation !== undefined
          ? liveWmi.creationUs === knownCreation
          : liveCapturedGroups.has(`${String(row.pgid)}:${String(row.uid)}`) &&
            rootCreationUs !== null &&
            liveWmi.creationUs >= rootCreationUs);
      if (
        !isVerified &&
        row.pgid > 1 &&
        (liveWmi !== undefined || !queriedWmiPidSet.has(row.winPid))
      ) {
        // Do not poison a live owned PGID merely because a queried candidate exited before WMI ran.
        candidatePgidsWithUnownedMember.add(row.pgid);
      }
    }

    // Also check any unrelated MSYS row sharing a candidate PGID that failed ownership check.
    for (const row of msysResult.rows) {
      if (verifiedCandidatePgids.has(row.pgid)) {
        const liveWmi = wmiByPid.get(row.winPid);
        if (
          !ownership.ownedMsysUids.has(row.uid) ||
          (liveWmi === undefined && !queriedWmiPidSet.has(row.winPid)) ||
          (liveWmi !== undefined && rootCreationUs !== null && liveWmi.creationUs < rootCreationUs)
        ) {
          candidatePgidsWithUnownedMember.add(row.pgid);
        }
      }
    }
  };

  recomputeVerifiedTree();

  // Expand the Win32 discovery frontier recursively before killing any ancestor
  // so multi-generation native descendants are discovered and never orphaned.
  const getUnqueriedVerifiedPids = () =>
    [...verifiedWinPids].filter(
      (winPid) => Number.isSafeInteger(winPid) && winPid > 4 && !queriedParentPids.has(winPid),
    );
  for (
    let unqueriedVerifiedPids = getUnqueriedVerifiedPids();
    unqueriedVerifiedPids.length > 0;
    unqueriedVerifiedPids = getUnqueriedVerifiedPids()
  ) {
    if (remainingMs(deadlineMs) <= 0) {
      return false;
    }
    const frontierArgs = unqueriedVerifiedPids.length > 24 ? undefined : unqueriedVerifiedPids;
    const frontierWmi = await winOps.readWmiSnapshot(remainingMs(deadlineMs), frontierArgs);
    if (!frontierWmi.ok) {
      return false;
    }
    for (const qPid of unqueriedVerifiedPids) {
      queriedParentPids.add(qPid);
      queriedWmiPidSet.add(qPid);
    }
    if (unqueriedVerifiedPids.length > 24 && winOps === defaultWinTreeOps) {
      for (const row of frontierWmi.rows) {
        queriedParentPids.add(row.pid);
      }
    }
    for (const row of frontierWmi.rows) {
      if (!wmiByPid.has(row.pid)) {
        wmiResult.rows.push(row);
        wmiByPid.set(row.pid, row);
      }
    }
    recomputeVerifiedTree();
  }

  if (verifiedWinPids.size === 0 && verifiedMsysPids.length === 0) {
    return rootClosed();
  }

  if (!performKill) {
    return false;
  }

  const verifiedPgids = [...verifiedCandidatePgids].filter(
    (pgid) => !candidatePgidsWithUnownedMember.has(pgid),
  );
  const killBudgetMs = remainingMs(deadlineMs);
  if (killBudgetMs <= 0) {
    return false;
  }

  const depthMemo = new Map<number, number>();
  const computeDepth = (targetPid: number, visiting = new Set<number>()): number => {
    const cached = depthMemo.get(targetPid);
    if (cached !== undefined) return cached;
    if (targetPid === ownership.rootPid || visiting.has(targetPid)) {
      depthMemo.set(targetPid, 0);
      return 0;
    }
    const row = wmiByPid.get(targetPid);
    if (row === undefined || !verifiedWinPids.has(row.parentPid)) {
      depthMemo.set(targetPid, 0);
      return 0;
    }
    visiting.add(targetPid);
    const depth = 1 + computeDepth(row.parentPid, visiting);
    visiting.delete(targetPid);
    depthMemo.set(targetPid, depth);
    return depth;
  };
  const winPidsToKill = [...verifiedWinPids].sort((a, b) => computeDepth(b) - computeDepth(a));

  const killTasks: Promise<unknown>[] =
    winOps.killWinPids !== undefined
      ? [winOps.killWinPids(winPidsToKill, killBudgetMs)]
      : winPidsToKill.map((winPid) => winOps.killWinPid(winPid, killBudgetMs));
  if (verifiedMsysPids.length > 0 || verifiedPgids.length > 0) {
    killTasks.push(
      winOps.killMsysTargets({ msysPids: verifiedMsysPids, pgids: verifiedPgids }, killBudgetMs),
    );
  }
  await Promise.all(killTasks);
  await waitClosureUntilMs(deadlineMs);
  if (!rootClosed() || remainingMs(deadlineMs) <= 0) {
    return false;
  }

  const killedNonMsysNativeDescendant = [...verifiedWinPids].some(
    (winPid) => winPid !== ownership.rootPid && !candidateMsysWinPids.has(winPid),
  );

  return inspectAndOptionallyReapWinTree(
    child,
    ownership,
    winOps,
    rootClosed,
    deadlineMs,
    false,
    waitClosureUntilMs,
    skippedFreshWmi || killedNonMsysNativeDescendant,
  );
}

/**
 * Boundedly terminate and reap a test-owned child process.
 * Handles never-spawned children, graceful SIGTERM, SIGKILL escalation,
 * and confirms stdio closure and process-tree exit.
 */
export async function reapChildProcess(child: ChildProcess, options?: ReapOptions): Promise<void> {
  const termTimeoutMs = options?.termTimeoutMs ?? 1500;
  const killTimeoutMs = options?.killTimeoutMs ?? 1500;
  const winOps = options?._winTreeOps;
  const winProcessTree =
    options?.processGroup === true && (process.platform === 'win32' || winOps !== undefined);
  const posixProcessGroup =
    options?.processGroup === true && process.platform !== 'win32' && winOps === undefined;

  if (confirmedTreeReapSet.has(child)) {
    return;
  }
  if (!winProcessTree && !posixProcessGroup && confirmedDirectReapSet.has(child)) {
    return;
  }

  const reapStart = Date.now();
  const totalBudgetMs = termTimeoutMs + killTimeoutMs;
  const overallDeadline =
    options?.deadlineAtMs !== undefined
      ? Math.min(options.deadlineAtMs, reapStart + totalBudgetMs)
      : reapStart + totalBudgetMs;
  const termDeadline =
    options?.termDeadlineAtMs !== undefined
      ? Math.min(overallDeadline, options.termDeadlineAtMs)
      : Math.min(overallDeadline, reapStart + termTimeoutMs);

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

  const waitForClosureUntil = (untilMs: number) =>
    new Promise<boolean>((resolve) => {
      if (closed()) {
        resolve(true);
        return;
      }
      const waitMs = remainingMs(untilMs);
      if (waitMs <= 0) {
        resolve(closed());
        return;
      }
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('close', onClose);
        resolve(closed());
      }, waitMs);
      child.once('close', onClose);
    });

  const signal = (value: NodeJS.Signals): boolean => {
    try {
      if (posixProcessGroup) {
        process.kill(-pid, value);
        return true;
      }
      return child.kill(value);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };

  const captureControl = activeCaptureControls.get(child);
  captureControl?.clampDeadline(overallDeadline);
  let captureAbortTimer: NodeJS.Timeout | null = null;
  if (captureControl !== undefined) {
    const abortDelayMs = remainingMs(overallDeadline);
    if (abortDelayMs <= 0) {
      captureControl.abortController.abort();
    } else {
      captureAbortTimer = setTimeout(() => {
        captureAbortTimer = null;
        captureControl.abortController.abort();
      }, abortDelayMs);
    }
  }

  try {
    if (!posixProcessGroup && !winProcessTree && closed()) {
      confirmedDirectReapSet.add(child);
      return;
    }

    if (winProcessTree) {
      const effectiveOps = winOps ?? defaultWinTreeOps;
      let ownershipPromise = ownershipByChild.get(child);
      if (ownershipPromise === undefined && closed()) {
        throw new Error('test_child_reap_unconfirmed');
      }
      ownershipPromise ??= captureProcessTreeOwnership(child, {
        timeoutMs: remainingMs(overallDeadline),
        ...(winOps !== undefined ? { _winTreeOps: winOps } : {}),
      });

      const ownership = await awaitWithDeadline(ownershipPromise, overallDeadline, null);
      if (!ownership?.observedRoot) {
        if (!closed()) {
          signal('SIGKILL');
          await waitForClosureUntil(overallDeadline);
        }
        throw new Error('test_child_reap_unconfirmed');
      }

      while (remainingMs(overallDeadline) > 0) {
        const reaped = await inspectAndOptionallyReapWinTree(
          child,
          ownership,
          effectiveOps,
          closed,
          overallDeadline,
          true,
          waitForClosureUntil,
        );
        if (reaped) {
          confirmedTreeReapSet.add(child);
          closeStdio();
          return;
        }
        // Prevent hot-spinning if snapshot calls fail immediately while budget remains.
        await waitForClosureUntil(Math.min(overallDeadline, Date.now() + 25));
        if (winOps !== undefined) {
          break;
        }
      }

      throw new Error('test_child_reap_unconfirmed');
    }

    signal('SIGTERM');
    let confirmed = await waitForClosureUntil(termDeadline);
    // A group member can retain the lock even after its shell exits or closes
    // stdio. Kill only the explicitly detached, test-owned process group.
    if (posixProcessGroup || !confirmed) {
      const signaled = signal('SIGKILL');
      confirmed = await waitForClosureUntil(overallDeadline);
      if (posixProcessGroup) {
        if (!signaled || !(await waitForPosixGroupGone(pid, overallDeadline))) {
          confirmed = false;
        }
      }
    }
    if (!confirmed) throw new Error('test_child_reap_unconfirmed');
    if (posixProcessGroup) {
      confirmedTreeReapSet.add(child);
    } else {
      confirmedDirectReapSet.add(child);
    }
    closeStdio();
  } finally {
    if (captureAbortTimer !== null) {
      clearTimeout(captureAbortTimer);
    }
    activeCaptureControls.get(child)?.abortController.abort();
  }
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
  const totalStartMs = Date.now();
  const timeoutMs = options?.timeoutMs ?? 3500;
  const termTimeoutMs = options?.termTimeoutMs ?? 500;
  const killTimeoutMs = options?.killTimeoutMs ?? 500;
  const cleanupBudgetMs = termTimeoutMs + killTimeoutMs;
  const overallDeadlineMs = totalStartMs + timeoutMs + cleanupBudgetMs;

  const child = spawn(command, args, {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const totalCallerBudgetMs = Math.max(0, timeoutMs) + cleanupBudgetMs;
  startAutoOwnershipCapture(child, Math.max(0, timeoutMs), totalCallerBudgetMs);

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

  let drainStartedAt: number | null = null;
  try {
    const exit = await waitForExit(child, { timeoutMs });
    if (![child.stdout, child.stderr].every((s) => s.closed || s.readableEnded)) {
      drainStartedAt = Date.now();
      const maxDrainMs = Math.min(termTimeoutMs, 150);
      const drainBudgetMs = Math.max(0, Math.min(maxDrainMs, overallDeadlineMs - drainStartedAt));
      if (drainBudgetMs > 0) {
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout | null = null;
          const done = () => {
            if (timer !== null) clearTimeout(timer);
            child.off('close', done);
            resolve();
          };
          timer = setTimeout(done, drainBudgetMs);
          child.once('close', done);
        });
      }
    }
    return { status: exit.code, signal: exit.signal, stdout, stderr, child };
  } finally {
    const cleanupAnchorMs = drainStartedAt ?? Date.now();
    const cleanupDeadlineMs = Math.min(overallDeadlineMs, cleanupAnchorMs + cleanupBudgetMs);
    const termDeadlineMs = Math.min(cleanupDeadlineMs, cleanupAnchorMs + termTimeoutMs);
    try {
      await reapChildProcess(child, {
        termTimeoutMs,
        killTimeoutMs,
        processGroup: true,
        deadlineAtMs: cleanupDeadlineMs,
        termDeadlineAtMs: termDeadlineMs,
      });
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
    }
  }
}
