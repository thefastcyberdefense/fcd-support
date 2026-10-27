import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { posix } from 'node:path';

function identity(metadata: BigIntStats): string {
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o022n) !== 0n ||
    !(
      (metadata.uid === 0n && metadata.gid === 0n) ||
      (metadata.uid === 1000n && metadata.gid === 1000n)
    )
  )
    throw new Error('empty_restore_target_invalid');
  return [
    metadata.dev,
    metadata.ino,
    metadata.uid,
    metadata.gid,
    metadata.mode,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(':');
}

/** Filesystem leg only: the locked host controller independently checks the
 * volume's provenance and lack of users. No file contents or names leave here. */
export async function proveEmptyRestoreTarget(path: string): Promise<string> {
  try {
    if (
      !/^\/[A-Za-z0-9._/-]+$/u.test(path) ||
      posix.normalize(path) !== path ||
      path === '/' ||
      path.endsWith('/')
    )
      throw new Error('invalid');
    const before = identity(await lstat(path, { bigint: true }));
    if ((await realpath(path)) !== path) throw new Error('invalid');
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (identity(await handle.stat({ bigint: true })) !== before) throw new Error('invalid');
      const directory = await opendir(path);
      try {
        // One bounded read: any entry refuses, without reading or reporting it.
        if ((await directory.read()) !== null) throw new Error('invalid');
      } finally {
        await directory.close();
      }
      if (
        identity(await handle.stat({ bigint: true })) !== before ||
        identity(await lstat(path, { bigint: true })) !== before ||
        (await realpath(path)) !== path
      )
        throw new Error('invalid');
      return createHash('sha256').update(`empty-target-v1:${before}`).digest('hex');
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error('empty_restore_target_invalid');
  }
}
