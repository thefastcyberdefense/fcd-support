import type { ChildProcess } from 'node:child_process';

export interface BarrierOptions {
  timeoutMs?: number;
}

export interface ExitOptions {
  timeoutMs?: number;
}

export interface ReapOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
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

/**
 * Boundedly terminate and reap a test-owned child process.
 * Handles never-spawned children, graceful SIGTERM, SIGKILL escalation,
 * and confirms stdio closure.
 */
export async function reapChildProcess(
  child: ChildProcess,
  options?: ReapOptions,
): Promise<void> {
  const termTimeoutMs = options?.termTimeoutMs ?? 1500;
  const killTimeoutMs = options?.killTimeoutMs ?? 1500;

  const closeStdio = () => {
    try {
      child.stdin?.destroy();
    } catch {
      // ignore
    }
    try {
      child.stdout?.destroy();
    } catch {
      // ignore
    }
    try {
      child.stderr?.destroy();
    } catch {
      // ignore
    }
  };

  // If process never successfully spawned (e.g. invalid binary, EACCES, ENOENT)
  if (child.pid === undefined) {
    closeStdio();
    return;
  }

  // If process has already exited
  if (child.exitCode !== null || child.signalCode !== null) {
    closeStdio();
    return;
  }

  // Helper to wait boundedly for exit
  const waitForTermination = (timeoutMs: number): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }

      let timer: NodeJS.Timeout | null = null;
      const onExit = () => {
        cleanup();
        resolve(true);
      };

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        child.off('exit', onExit);
        child.off('close', onExit);
      };

      timer = setTimeout(() => {
        cleanup();
        resolve(child.exitCode !== null || child.signalCode !== null);
      }, timeoutMs);

      child.once('exit', onExit);
      child.once('close', onExit);
    });
  };

  // Step 1: Send SIGTERM
  try {
    child.kill('SIGTERM');
  } catch {
    // Process may have already exited
  }

  const termExited = await waitForTermination(termTimeoutMs);
  if (!termExited) {
    // Step 2: Escalate to SIGKILL if SIGTERM did not reap child
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    await waitForTermination(killTimeoutMs);
  }

  closeStdio();
}

/**
 * Reap multiple children in parallel with bounded timeouts.
 */
export async function reapChildProcesses(
  children: ChildProcess[],
  options?: ReapOptions,
): Promise<void> {
  await Promise.allSettled(children.map((child) => reapChildProcess(child, options)));
}
