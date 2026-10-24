import { chmod, lstat, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { recoverStoppedAdminSocket } from '../src/operations/admin-socket-recovery.js';

describe.skipIf(process.platform !== 'linux')('explicit stopped-admin socket recovery', () => {
  let root: string;
  let path: string;
  const servers: Server[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fcd-socket-recovery-test-'));
    await chmod(root, 0o700);
    path = join(root, 'admin.sock');
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
    }
    if (!root.startsWith(join(tmpdir(), 'fcd-socket-recovery-test-')))
      throw new Error('synthetic_scope_invalid');
    await rm(root, { recursive: true, force: true });
  });
  async function listen() {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    return server;
  }
  async function stale() {
    const server = await listen();
    const parked = join(root, 'synthetic-parked.sock');
    await rename(path, parked);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await rename(parked, path);
  }
  async function options() {
    const metadata = await lstat(path, { bigint: true });
    return {
      socketPath: path,
      expectedDevice: String(metadata.dev),
      expectedInode: String(metadata.ino),
      timeoutMilliseconds: 100,
    };
  }

  test('removes only the exact owned 0600 socket after real ECONNREFUSED', async () => {
    await stale();
    const command = await options();
    await expect(recoverStoppedAdminSocket(command)).resolves.toEqual({ status: 'recovered' });
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(recoverStoppedAdminSocket(command)).rejects.toThrow(
      /^admin_socket_recovery_refused$/u,
    );
  });
  test('an active non-HTTP listener is not mistaken for a stale socket', async () => {
    const server = await listen();
    const before = await lstat(path, { bigint: true });
    await expect(recoverStoppedAdminSocket(await options())).rejects.toThrow(
      /^admin_socket_recovery_refused$/u,
    );
    expect(server.listening).toBe(true);
    expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
  });
  test.each(['regular', 'symlink', 'directory'] as const)('preserves a %s entry', async (kind) => {
    if (kind === 'directory') {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path, { mode: 0o700 });
    } else if (kind === 'symlink') {
      const target = join(root, 'synthetic-evidence');
      await writeFile(target, 'Synthetic evidence must remain', { mode: 0o600 });
      await symlink(target, path);
    } else await writeFile(path, 'Synthetic evidence must remain', { mode: 0o600 });
    const before = await lstat(path, { bigint: true });
    await expect(recoverStoppedAdminSocket(await options())).rejects.toThrow(
      /^admin_socket_recovery_refused$/u,
    );
    expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
  });
  test('refuses a substituted socket inode without deleting either entry', async () => {
    await stale();
    const command = await options();
    const retained = join(root, 'synthetic-retained.sock');
    await rename(path, retained);
    await stale();
    const replacement = await lstat(path, { bigint: true });
    await expect(recoverStoppedAdminSocket(command)).rejects.toThrow(
      /^admin_socket_recovery_refused$/u,
    );
    expect((await lstat(path, { bigint: true })).ino).toBe(replacement.ino);
    expect(String((await lstat(retained, { bigint: true })).ino)).toBe(command.expectedInode);
  });
  test('refuses broad directory or socket modes rather than repairing them', async () => {
    await stale();
    const command = await options();
    await chmod(path, 0o640);
    await expect(recoverStoppedAdminSocket(command)).rejects.toThrow(
      /^admin_socket_recovery_refused$/u,
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
    await chmod(path, 0o600);
    await chmod(root, 0o750);
    await expect(recoverStoppedAdminSocket(command)).rejects.toThrow(
      /^admin_socket_recovery_refused$/u,
    );
    expect((await lstat(root)).mode & 0o777).toBe(0o750);
  });
  test('refuses a symlinked parent even when its resolved socket identity matches', async () => {
    await stale();
    const command = await options();
    const alias = join(root, 'synthetic-alias');
    await symlink(root, alias);
    await expect(
      recoverStoppedAdminSocket({ ...command, socketPath: join(alias, 'admin.sock') }),
    ).rejects.toThrow(/^admin_socket_recovery_refused$/u);
    expect(String((await lstat(path, { bigint: true })).ino)).toBe(command.expectedInode);
  });
  test('a slow filesystem/probe cannot unlink after the operation deadline', async () => {
    await stale();
    const command = await options();
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1000);
    try {
      await expect(recoverStoppedAdminSocket(command)).rejects.toThrow(
        /^admin_socket_recovery_refused$/u,
      );
      expect(String((await lstat(path, { bigint: true })).ino)).toBe(command.expectedInode);
    } finally {
      clock.mockRestore();
    }
  });
  test.each([0, -1, 300001, Number.NaN])(
    'refuses invalid probe deadline %s without unlink',
    async (timeoutMilliseconds) => {
      await stale();
      const command = await options();
      await expect(recoverStoppedAdminSocket({ ...command, timeoutMilliseconds })).rejects.toThrow(
        /^admin_socket_recovery_refused$/u,
      );
      expect(String((await lstat(path, { bigint: true })).ino)).toBe(command.expectedInode);
    },
  );
});
