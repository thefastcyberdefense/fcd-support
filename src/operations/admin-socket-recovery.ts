import { lstat, realpath, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { createConnection } from 'node:net';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const integer = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const input = z.strictObject({
  socketPath: z.string().max(107),
  expectedDevice: integer,
  expectedInode: integer,
  timeoutMilliseconds: z.number().int().min(1).max(300000),
});
export type AdminSocketRecoveryOptions = z.infer<typeof input>;

function owned(metadata: BigIntStats, mode: bigint) {
  return metadata.uid === 1000n && metadata.gid === 1000n && (metadata.mode & 0o7777n) === mode;
}

async function connectionRefused(path: string, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const connection = createConnection({ path });
    const finish = (refused: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeout);
    connection.once('connect', () => {
      finish(false);
    });
    connection.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED');
    });
  });
}

/** Narrow filesystem leg only. The trusted host caller MUST retain its checked
 * deployment lock, protected ancestors and independently verified stopped owner
 * throughout this call. No HTTP/model input is accepted. This helper never
 * creates directories, widens permissions, stops services or repairs entries. */
export async function recoverStoppedAdminSocket(
  options: AdminSocketRecoveryOptions,
): Promise<{ status: 'recovered' }> {
  try {
    const command = input.parse(options);
    const startedAt = performance.now();
    const remainingTime = () => {
      const elapsed = performance.now() - startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= command.timeoutMilliseconds)
        throw new Error('invalid');
      return Math.ceil(command.timeoutMilliseconds - elapsed);
    };
    const path = command.socketPath;
    if (
      process.platform !== 'linux' ||
      process.geteuid?.() !== 1000 ||
      process.getegid?.() !== 1000 ||
      !/^\/[A-Za-z0-9._/-]+$/u.test(path) ||
      posix.normalize(path) !== path ||
      posix.basename(path) !== 'admin.sock' ||
      Buffer.byteLength(path) > 107
    )
      throw new Error('invalid');
    const directory = posix.dirname(path);
    const parent = await lstat(directory, { bigint: true });
    if (
      !parent.isDirectory() ||
      !owned(parent, 0o700n) ||
      (await realpath(directory)) !== directory
    )
      throw new Error('invalid');
    const sameSocket = (metadata: BigIntStats) =>
      metadata.isSocket() &&
      owned(metadata, 0o600n) &&
      metadata.dev === BigInt(command.expectedDevice) &&
      metadata.ino === BigInt(command.expectedInode);
    if (
      !sameSocket(await lstat(path, { bigint: true })) ||
      !(await connectionRefused(path, remainingTime()))
    )
      throw new Error('invalid');
    const after = await lstat(directory, { bigint: true });
    if (
      !after.isDirectory() ||
      !owned(after, 0o700n) ||
      after.dev !== parent.dev ||
      after.ino !== parent.ino ||
      (await realpath(directory)) !== directory ||
      !sameSocket(await lstat(path, { bigint: true }))
    )
      throw new Error('invalid');
    // The protected directory and retained host lock exclude other authorized
    // writers. Recheck the exact socket immediately before this one unlink.
    remainingTime();
    await unlink(path);
    return { status: 'recovered' };
  } catch {
    throw new Error('admin_socket_recovery_refused');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [socketPath, expectedDevice, expectedInode, timeout] = z
      .tuple([z.string(), integer, integer, z.string().regex(/^[1-9][0-9]{0,5}$/u)])
      .parse(process.argv.slice(2));
    const result = await recoverStoppedAdminSocket({
      socketPath,
      expectedDevice,
      expectedInode,
      timeoutMilliseconds: Number(timeout),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write('admin_socket_recovery_refused\n');
    process.exitCode = 1;
  }
}
