import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  reapChildProcess,
  reapChildProcesses,
  waitForBarrier,
  waitForExit,
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
    spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("DESCENDANT_READY\\n");setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
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
