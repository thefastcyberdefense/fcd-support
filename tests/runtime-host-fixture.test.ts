import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadOperationsConfig } from '../src/operations/operations-config.js';
import { loadReplySettings } from '../src/operations/reply-config.js';
import { restoreTargetIdentitySchema } from '../src/persistence/postgres-restore-evidence.js';
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
    const settings = environment(await readFile(join(root, 'config/operations.env'), 'utf8'));
    expect(
      restoreTargetIdentitySchema.safeParse({
        projectName: settings.FCD_RESTORE_PROJECT,
        volumeName: settings.FCD_RESTORE_VOLUME,
        volumeCreatedAt: '2030-04-01T06:00:00+06:00',
        networkId: 'a'.repeat(64),
        postgresImageId: `sha256:${'b'.repeat(64)}`,
        runtimeImageId: `sha256:${'c'.repeat(64)}`,
        systemIdentifier: '7300000000000000001',
        databaseName: 'fcd_support_test',
        schema: 'public',
      }).success,
    ).toBe(true);
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

test.each(['backup', 'verify-backup', 'checkpoint', 'restore'])(
  'host %s fixture supplies container archive paths and bounded job settings',
  async (role) => {
    const parent = await mkdtemp(join(tmpdir(), 'fcd-host-fixture-test-'));
    const root = join(parent, 'fcd-support-host-test-synthetic');
    try {
      await writeRuntimeHostFixture(root, 'fcd-support-host-test-synthetic', 'b'.repeat(40));
      const settings = environment(await readFile(join(root, `config/${role}.env`), 'utf8'));
      if (role !== 'checkpoint' && role !== 'restore')
        expect(settings.BACKUP_ARCHIVE_DIRECTORY).toBe('/var/lib/fcd-support/backups');
      if (role === 'backup') expect(settings.BACKUP_TMPFS_DIRECTORY).toBe('/run/fcd-support');
      if (role === 'checkpoint' || role === 'restore') {
        if (role === 'checkpoint')
          expect(settings.CHECKPOINT_ARCHIVE_DIRECTORY).toBe('/var/lib/fcd-support/backups');
        expect(settings.CHECKPOINT_MAX_ROWS).toBe('1000');
        expect(settings.CHECKPOINT_MAX_PAYLOAD_BYTES).toBe('1048576');
      }
      if (role === 'restore') {
        for (const key of [
          'BACKUP_ARCHIVE_DIRECTORY',
          'BACKUP_TMPFS_DIRECTORY',
          'CHECKPOINT_ARCHIVE_DIRECTORY',
        ])
          expect(settings[key]).toBeUndefined();
        expect(settings.CHECKPOINT_MAX_AGE_MS).toBe('60000');
        expect(settings.RESTORE_BATCH_LIMIT).toBe('10');
        expect(settings.RESTORE_MAX_BATCHES).toBe('100');
        expect(settings.PROMOTION_HOST_CHECK_TIMEOUT_MS).toBe('10000');
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test('CI recovery fixture explicitly budgets checkpoint freshness without changing the standard fixture', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fcd-host-fixture-test-'));
  const root = join(parent, 'fcd-support-host-test-synthetic');
  try {
    await writeRuntimeHostFixture(
      root,
      'fcd-support-host-test-synthetic',
      'b'.repeat(40),
      'ci-recovery',
    );
    const settings = environment(await readFile(join(root, 'config/restore.env'), 'utf8'));
    expect(settings.CHECKPOINT_MAX_AGE_MS).toBe('600000');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
