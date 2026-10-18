import { lstat, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { FastifyInstance } from 'fastify';

export interface AdminSocketHandle {
  close(): Promise<'closed' | 'process_exit_required'>;
}

let startupQueue: Promise<void> = Promise.resolve();

async function assertAvailable(path: string): Promise<void> {
  if (
    process.platform !== 'linux' ||
    !path.isWellFormed() ||
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    posix.basename(path) !== 'admin.sock' ||
    Buffer.from(path, 'utf8').some((byte) => byte < 32 || byte === 127) ||
    Buffer.byteLength(path) > 107 ||
    process.geteuid === undefined ||
    process.getegid === undefined
  )
    throw new Error('admin_socket_invalid');
  const directory = posix.dirname(path);
  const parent = await lstat(directory, { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o7777n) !== 0o700n ||
    parent.uid !== BigInt(process.geteuid()) ||
    parent.gid !== BigInt(process.getegid()) ||
    (await realpath(directory)) !== directory
  )
    throw new Error('admin_socket_invalid');
  let absent = false;
  try {
    await lstat(path);
  } catch (error) {
    absent = error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
  if (absent) return;
  throw new Error('admin_socket_invalid');
}

function validSocket(metadata: BigIntStats) {
  return (
    metadata.isSocket() &&
    (metadata.mode & 0o7777n) === 0o600n &&
    metadata.uid === BigInt(process.geteuid?.() ?? -1) &&
    metadata.gid === BigInt(process.getegid?.() ?? -1)
  );
}

export async function startAdminSocket(
  app: FastifyInstance,
  path: string,
): Promise<AdminSocketHandle> {
  let bound = false;
  let identity: BigIntStats;
  try {
    if (app.server.listening) throw new Error('admin_socket_invalid');
    await assertAvailable(path);
    await app.ready();
    const previous = startupQueue;
    const gate = Promise.withResolvers<undefined>();
    startupQueue = gate.promise;
    await previous;
    try {
      await assertAvailable(path);
      const mask = process.umask(0o177);
      try {
        await app.listen({ path, readableAll: false, writableAll: false });
        bound = true;
        identity = await lstat(path, { bigint: true });
        if (!validSocket(identity)) throw new Error('admin_socket_invalid');
      } finally {
        process.umask(mask);
      }
    } finally {
      gate.resolve(undefined);
    }
  } catch {
    throw new Error(bound ? 'admin_socket_exit_required' : 'admin_socket_invalid');
  }
  let closing: Promise<'closed' | 'process_exit_required'> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        try {
          const current = await lstat(path, { bigint: true });
          if (!validSocket(current) || current.dev !== identity.dev || current.ino !== identity.ino)
            return 'process_exit_required';
        } catch {
          return 'process_exit_required';
        }
        await app.close();
        return 'closed';
      })()),
  };
}
