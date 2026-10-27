import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { proveEmptyRestoreTarget } from '../src/operations/empty-restore-target.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof filesystem>();
  return { ...real, open: vi.fn(real.open), readFile: vi.fn(real.readFile) };
});

const native = process.platform === 'linux' && process.geteuid?.() === 1000;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp('/var/lib/fcd-support/backups/empty-target-test-');
  roots.push(root);
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o755 });
  return { root, target };
}

test.runIf(native)(
  'an empty root produces a stable content-free proof without file reads or writes',
  async () => {
    const f = await fixture();
    const before = await lstat(f.target, { bigint: true });
    vi.mocked(filesystem.readFile).mockClear();
    const first = await proveEmptyRestoreTarget(f.target);
    const second = await proveEmptyRestoreTarget(f.target);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(filesystem.readFile).not.toHaveBeenCalled();
    const after = await lstat(f.target, { bigint: true });
    expect([
      after.dev,
      after.ino,
      after.mode,
      after.uid,
      after.gid,
      after.mtimeNs,
      after.ctimeNs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.uid,
      before.gid,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(await readdir(f.target)).toEqual([]);
  },
);

test
  .runIf(native)
  .each(['file', 'directory', 'hidden', 'link', 'broad', 'root-link', 'missing', 'regular'])(
  'empty proof refuses %s with a closed error and no content reads',
  async (fault) => {
    const f = await fixture();
    if (fault === 'file' || fault === 'hidden')
      await writeFile(
        join(f.target, fault === 'hidden' ? '.synthetic-private' : 'synthetic-private'),
        'synthetic_content_never_read',
      );
    if (fault === 'directory') await mkdir(join(f.target, 'synthetic-private'));
    if (fault === 'link')
      await symlink('/synthetic-private-missing', join(f.target, 'synthetic-private'));
    if (fault === 'broad') await chmod(f.target, 0o777);
    if (fault === 'root-link') {
      await rename(f.target, join(f.root, 'original'));
      await symlink(join(f.root, 'original'), f.target);
    }
    if (fault === 'missing' || fault === 'regular') await rm(f.target, { recursive: true });
    if (fault === 'regular') await writeFile(f.target, 'synthetic_content_never_read');
    vi.mocked(filesystem.readFile).mockClear();
    await expect(proveEmptyRestoreTarget(f.target)).rejects.toThrow(
      /^empty_restore_target_invalid$/u,
    );
    expect(filesystem.readFile).not.toHaveBeenCalled();
  },
);

test.runIf(native)('a root replaced after open cannot seal an empty proof', async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
  vi.mocked(filesystem.open).mockImplementationOnce(
    async (...args: Parameters<typeof filesystem.open>) => {
      const descriptor = await actual.open(...args);
      await rename(f.target, join(f.root, 'original'));
      await mkdir(f.target);
      return descriptor;
    },
  );
  await expect(proveEmptyRestoreTarget(f.target)).rejects.toThrow(
    /^empty_restore_target_invalid$/u,
  );
  expect(await readdir(f.target)).toEqual([]);
  expect(await readdir(join(f.root, 'original'))).toEqual([]);
});

test.each(['relative', '/synthetic/../target', '/synthetic//target', '/synthetic/target/'])(
  'probe refuses unsafe root %s',
  async (path) => {
    await expect(proveEmptyRestoreTarget(path)).rejects.toThrow(/^empty_restore_target_invalid$/u);
  },
);

test('compiled empty probe refuses arguments with only a generic failure', () => {
  const result = spawnSync(
    process.execPath,
    [resolve('dist/operations/empty-restore-target-main.js'), '/synthetic/private'],
    { encoding: 'utf8' },
  );
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 1,
    stdout: '',
    stderr: 'empty_restore_target_invalid\n',
  });
});
