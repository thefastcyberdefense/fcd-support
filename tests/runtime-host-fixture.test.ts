import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadOperationsConfig } from '../src/operations/operations-config.js';
import { loadReplySettings } from '../src/operations/reply-config.js';
import { writeRuntimeHostFixture } from './helpers/runtime-host-fixture.js';

function environment(text: string) {
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
}

test('fresh host fixture supplies valid disabled runtime policy and distinct database capabilities', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fcd-host-fixture-test-'));
  const root = join(parent, 'fcd-support-host-test-synthetic');
  try {
    await writeRuntimeHostFixture(root, 'fcd-support-host-test-synthetic', 'b'.repeat(40));
    expect(existsSync(join(root, 'config/common.env'))).toBe(true);
    const common = environment(await readFile(join(root, 'config/common.env'), 'utf8'));
    const reply = environment(await readFile(join(root, 'config/reply.env'), 'utf8'));
    expect(loadOperationsConfig('reply', common).modelExecutionEnabled).toBe(false);
    expect(
      loadReplySettings({ ...common, ...reply, OPS_GIT_REVISION: 'b'.repeat(40) }, false)
        .schemaRevision,
    ).toBe('000016');
    const source = new URL(
      await readFile(join(root, 'secrets/bootstrap/bootstrap-database'), 'utf8'),
    );
    const target = new URL(await readFile(join(root, 'secrets/restore/restore-database'), 'utf8'));
    const reader = new URL(
      await readFile(join(root, 'secrets/restore/restore-archive-database'), 'utf8'),
    );
    expect(source.password !== target.password).toBe(true);
    expect(reader.username === 'fcd_synthetic_archive_reader').toBe(true);
    expect(reader.hostname === 'fcd-support-source-postgres').toBe(true);
    expect(target.hostname === 'fcd-support-restore-postgres').toBe(true);
    await expect(
      writeRuntimeHostFixture(root, 'fcd-support-host-test-synthetic', 'b'.repeat(40)),
    ).rejects.toThrow('synthetic_host_fixture_invalid');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('host fixture refuses a non-test project before creating files', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fcd-host-fixture-test-'));
  const root = join(parent, 'fcd-support-host-test-rejected');
  try {
    await expect(writeRuntimeHostFixture(root, 'fcd-support', 'b'.repeat(40))).rejects.toThrow(
      'synthetic_host_fixture_invalid',
    );
    expect(existsSync(root)).toBe(false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
