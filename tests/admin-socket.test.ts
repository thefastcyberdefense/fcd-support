import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAdminRuntime } from '../src/admin/admin-runtime.js';
import { startAdminSocket } from '../src/admin/admin-socket.js';
import { probeAdminSocket } from '../src/admin/admin-socket-health.js';

describe.skipIf(process.platform !== 'linux')('private admin Unix transport', () => {
  let root: string;
  let path: string;
  const apps: FastifyInstance[] = [];
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fcd-admin-socket-test-'));
    await chmod(root, 0o700);
    path = join(root, 'admin.sock');
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (!root.startsWith(join(tmpdir(), 'fcd-admin-socket-test-')))
      throw new Error('test_scope_invalid');
    await rm(root, { recursive: true, force: true });
  });

  function application(status = 200, hang = false) {
    const app = fastify({ logger: false });
    app.get('/login', async (_request, reply) => {
      if (hang) await once(_request.raw.socket, 'close');
      return reply.code(status).send('Synthetic login');
    });
    apps.push(app);
    return app;
  }

  async function mainProcess() {
    const child = spawn(
      process.execPath,
      [resolve('tests/helpers/admin-socket-process.mjs'), root],
      {
        env: { PATH: process.env.PATH, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('synthetic_start_timeout'));
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('synthetic_start_failed'));
      });
      child.stdout.on('data', (bytes: Buffer) => {
        if (bytes.toString('utf8').includes('admin_service_started')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
    });
    return child;
  }

  test('serves HTTP only through a mode-0600 owned socket and closes idempotently', async () => {
    const app = application();
    const previousMask = process.umask(0o077);
    const listener = await startAdminSocket(app, path);
    const metadata = await lstat(path);
    expect(metadata.isSocket()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.uid).toBe(process.geteuid?.());
    expect(metadata.gid).toBe(process.getegid?.());
    expect(process.umask(0o077)).toBe(0o077);
    process.umask(previousMask);
    expect(app.server.address()).toBe(path);
    await expect(startAdminSocket(app, path)).rejects.toThrow('admin_socket_invalid');
    expect(await probeAdminSocket(path, 500)).toBe(true);
    expect(await listener.close()).toBe('closed');
    expect(await listener.close()).toBe('closed');
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each(['missing', 'unsafe-mode', 'symlink', 'file'] as const)(
    'refuses %s parent without touching another entry',
    async (kind) => {
      const parent = join(root, 'parent');
      if (kind === 'unsafe-mode') {
        await mkdir(parent, { mode: 0o755 });
      }
      if (kind === 'symlink') {
        await symlink(root, parent);
      }
      if (kind === 'file') {
        await writeFile(parent, 'Synthetic sentinel');
      }
      await expect(startAdminSocket(application(), join(parent, 'admin.sock'))).rejects.toThrow(
        'admin_socket_invalid',
      );
      if (kind === 'file') expect(await readFile(parent, 'utf8')).toBe('Synthetic sentinel');
    },
  );

  test.each(['normal', 'rejected'] as const)(
    'runtime %s startup closes its pool once through repeated stop',
    async (mode) => {
      const pool = new pg.Pool();
      const close = vi.spyOn(pool, 'end');
      const runtime = createAdminRuntime({
        environment: {
          ADMIN_LISTEN_MODE: 'unix',
          ADMIN_SOCKET_PATH: mode === 'normal' ? path : join(root, 'missing', 'admin.sock'),
          ADMIN_BROWSER_PORT: '4004',
          ADMIN_ORIGIN: 'http://127.0.0.1:4004',
          ADMIN_SESSION_HMAC_KEY: Buffer.alloc(32, 0x51).toString('base64url'),
          ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x52).toString('base64url'),
          DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test',
        },
        poolFactory: () => pool,
      });
      apps.push(runtime.app);
      if (mode === 'normal') {
        await runtime.start();
        await expect(runtime.start()).rejects.toThrow('admin_socket_invalid');
        expect(await probeAdminSocket(path, 500)).toBe(true);
      } else await expect(runtime.start()).rejects.toThrow('admin_socket_invalid');
      expect(await runtime.stop()).toBe('closed');
      expect(await runtime.stop()).toBe('closed');
      expect(close).toHaveBeenCalledOnce();
    },
  );

  test('refuses a regular file and a symlink at the listener path without removal', async () => {
    const sentinel = join(root, 'sentinel');
    await writeFile(sentinel, 'Synthetic sentinel');
    await symlink(sentinel, path);
    await expect(startAdminSocket(application(), path)).rejects.toThrow('admin_socket_invalid');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    await rm(path);
    await writeFile(path, 'Synthetic socket-path sentinel');
    await expect(startAdminSocket(application(), path)).rejects.toThrow('admin_socket_invalid');
    expect(await readFile(path, 'utf8')).toBe('Synthetic socket-path sentinel');
  });

  test('refuses an existing live socket and never unlinks its owner', async () => {
    const owner = createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((done) => owner.listen(path, done));
    try {
      await expect(startAdminSocket(application(), path)).rejects.toThrow('admin_socket_invalid');
      expect(owner.listening).toBe(true);
      expect((await lstat(path)).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((done) =>
        owner.close(() => {
          done();
        }),
      );
    }
  });

  test('real CLI graceful shutdown closes its socket', async () => {
    const child = await mainProcess();
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('real CLI exits nonzero without unlinking a substituted entry', async () => {
    const child = await mainProcess();
    await rm(path);
    await writeFile(path, 'Synthetic replacement must survive');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect(await exited).toEqual([1, null]);
    expect(await readFile(path, 'utf8')).toBe('Synthetic replacement must survive');
  });

  test('crash leaves a stale socket that a new listener refuses', async () => {
    const child = await mainProcess();
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect((await lstat(path)).isSocket()).toBe(true);
    await expect(startAdminSocket(application(), path)).rejects.toThrow('admin_socket_invalid');
    expect((await lstat(path)).isSocket()).toBe(true);
  });

  test('failed app startup restores the mask and creates no socket', async () => {
    const app = application();
    app.addHook('onReady', () => Promise.reject(new Error('SYNTHETIC_DETAIL_NOT_FOR_LOGS')));
    const previousMask = process.umask(0o077);
    await expect(startAdminSocket(app, path)).rejects.toThrow('admin_socket_invalid');
    expect(process.umask(0o077)).toBe(0o077);
    process.umask(previousMask);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each([302, 401, 503])(
    'health rejects HTTP %i without following a redirect',
    async (status) => {
      const listener = await startAdminSocket(application(status), path);
      expect(await probeAdminSocket(path, 500)).toBe(false);
      await listener.close();
    },
  );

  test('health times out and rejects a missing socket or invalid timeout', async () => {
    expect(await probeAdminSocket(path, 500)).toBe(false);
    const listener = await startAdminSocket(application(200, true), path);
    expect(await probeAdminSocket(path, 20)).toBe(false);
    expect(await probeAdminSocket(path, 0)).toBe(false);
    await listener.close();
  });
});
