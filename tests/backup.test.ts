import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createEncryptedBackup,
  verifyEncryptedBackup,
  readBackupManifest,
  type BackupOptions,
  type BackupProcessPort,
} from '../src/operations/backup.js';
import { pruneEncryptedBackups } from '../src/operations/backup-retention.js';
import { parseBackupCommand } from '../src/operations/backup-command.js';
import {
  bindOperationConnectionString,
  operationApplicationName,
} from '../src/operations/operation-reference.js';

const collision = vi.hoisted(() => ({ uuid: undefined as string | undefined }));
vi.mock('node:crypto', async (load) => {
  const actual = await load<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => collision.uuid ?? actual.randomUUID() };
});

const roots: string[] = [];
afterEach(async () => {
  collision.uuid = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fcd-backup-test-'));
  roots.push(root);
  await chmod(root, 0o700);
  const archiveDirectory = join(root, 'archives');
  const temporaryDirectory = join(root, 'tmpfs');
  await mkdir(archiveDirectory, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  const recipientFile = join(root, 'recipient');
  const identityFile = join(root, 'identity');
  const manifestHmacFile = join(root, 'hmac');
  // Intentionally nonfunctional, checksum-invalid keys for the process-port tests.
  await writeFile(recipientFile, `age1${'q'.repeat(58)}`, { mode: 0o600 });
  await writeFile(identityFile, `AGE-SECRET-KEY-1${'Q'.repeat(58)}`, { mode: 0o600 });
  await writeFile(manifestHmacFile, 'synthetic_manifest_hmac_'.repeat(3), { mode: 0o600 });
  const calls: { file: string; args: readonly string[]; env: Readonly<NodeJS.ProcessEnv> }[] = [];
  let fail: string | undefined;
  const processes: BackupProcessPort = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const script =
      file === fail
        ? 'process.stderr.write("synthetic_hidden_error"); process.exit(2)'
        : file === 'pg_dump'
          ? 'process.stdout.write("synthetic_dump")'
          : file === 'pg_restore'
            ? 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("synthetic_private_listing"))'
            : 'process.stdin.pipe(process.stdout)';
    return spawn(process.execPath, ['-e', script], options);
  };
  const options: BackupOptions = {
    connectionString:
      'postgresql://synthetic_role:synthetic_password@127.0.0.1:5432/fcd_support_test',
    recipientFile,
    manifestHmacFile,
    archiveDirectory,
    temporaryDirectory,
    gitRevision: 'a'.repeat(40),
    schemaRevision: '000014',
    backupClass: 'daily',
    now: new Date('2030-01-01T00:00:00.000Z'),
    timeoutMilliseconds: 5000,
    processes,
  };
  return {
    root,
    options,
    identityFile,
    calls,
    fail: (name: string) => {
      fail = name;
    },
  };
}

test('tracked backup passes the canonical operation name to the external dump connection', async () => {
  const f = await fixture();
  const reference = `operation_${'a'.repeat(32)}`;
  await createEncryptedBackup({
    ...f.options,
    connectionString: bindOperationConnectionString(f.options.connectionString, reference),
  });
  const dump = f.calls.find((call) => call.file === 'pg_dump');
  expect(dump?.env.PGAPPNAME).toBe(operationApplicationName(reference));
  expect(dump?.args.join(' ')).not.toContain('application_name');
});
test('backup needs no identity and persists only ciphertext plus signed metadata', async () => {
  const f = await fixture();
  await rm(f.identityFile);
  const manifest = await createEncryptedBackup(f.options);
  expect(manifest.state).toBe('created');
  expect(await readdir(join(f.options.archiveDirectory, manifest.backupRef))).toEqual([
    'archive.age',
    'manifest.json',
  ]);
  expect(await readdir(f.options.temporaryDirectory)).toEqual([]);
  expect(f.calls.map((call) => call.file)).toEqual(['pg_dump', 'age']);
  expect(f.calls[0]?.args).toEqual(['--format=custom', '--no-owner', '--no-acl', '--no-password']);
  expect(f.calls[1]?.args).toEqual(['--encrypt', '--recipients-file', f.options.recipientFile]);
  expect(JSON.stringify(f.calls)).not.toContain('synthetic_password');
  expect(JSON.stringify(f.calls)).not.toContain('synthetic_private_identity');
  expect(
    await readBackupManifest(
      f.options.archiveDirectory,
      manifest.backupRef,
      f.options.manifestHmacFile,
    ),
  ).toEqual(manifest);
});
test.each(['pg_dump', 'age'])('a failed %s never publishes an eligible archive', async (file) => {
  const f = await fixture();
  f.fail(file);
  await expect(createEncryptedBackup(f.options)).rejects.toThrow(/^backup_failed$/u);
  expect(await readdir(f.options.archiveDirectory)).toEqual([]);
  expect(await readdir(f.options.temporaryDirectory)).toEqual([]);
});
test('verification drains the structural listing and never claims a full restore', async () => {
  const f = await fixture();
  const expectedManifest = await createEncryptedBackup(f.options);
  expect(
    await verifyEncryptedBackup({ ...f.options, identityFile: f.identityFile, expectedManifest }),
  ).toEqual({ status: 'verified' });
  expect(f.calls.slice(2).map((call) => [call.file, call.args])).toEqual([
    ['age', ['--decrypt', '--identity', f.identityFile]],
    ['pg_restore', ['--list']],
  ]);
  expect(await readdir(f.options.temporaryDirectory)).toEqual([]);
});

test.each([0, 2])(
  'an early successful listing still drains a large decrypt and checks its final exit %i',
  async (decryptExit) => {
    const f = await fixture();
    const expectedManifest = await createEncryptedBackup(f.options);
    const processes: BackupProcessPort = (file, _args, settings) =>
      spawn(
        process.execPath,
        [
          '-e',
          file === 'pg_restore'
            ? 'process.stdin.once("data",()=>process.exit(0))'
            : `process.stdin.resume();process.stdout.write(Buffer.alloc(2*1024*1024,0x53),()=>{process.exit(${String(decryptExit)})})`,
        ],
        settings,
      );
    const verification = verifyEncryptedBackup({
      ...f.options,
      processes,
      identityFile: f.identityFile,
      expectedManifest,
    });
    if (decryptExit === 0) await expect(verification).resolves.toEqual({ status: 'verified' });
    else await expect(verification).rejects.toThrow(/^backup_verification_failed$/u);
  },
);
test.each([
  'corruption',
  'signed_metadata',
  'expected_metadata',
  'missing_archive',
  'interrupted_commit',
])('rejects %s before structural verification', async (kind) => {
  const f = await fixture();
  const expectedManifest = await createEncryptedBackup(f.options);
  const directory = join(f.options.archiveDirectory, expectedManifest.backupRef);
  if (kind === 'corruption')
    await writeFile(join(directory, 'archive.age'), 'synthetic_corruption');
  if (kind === 'signed_metadata')
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ ...expectedManifest, schemaRevision: '000015' }),
    );
  if (kind === 'missing_archive') await rm(join(directory, 'archive.age'));
  if (kind === 'interrupted_commit') await rm(join(directory, 'manifest.json'));
  await expect(
    verifyEncryptedBackup({
      ...f.options,
      identityFile: f.identityFile,
      expectedManifest:
        kind === 'expected_metadata'
          ? { ...expectedManifest, ciphertextBytes: 1 }
          : expectedManifest,
    }),
  ).rejects.toThrow(/^backup_verification_failed$/u);
  expect(f.calls).toHaveLength(2);
});
test.each(['age', 'pg_restore'])('verification checks the %s exit code', async (file) => {
  const f = await fixture();
  const expectedManifest = await createEncryptedBackup(f.options);
  f.fail(file);
  await expect(
    verifyEncryptedBackup({ ...f.options, identityFile: f.identityFile, expectedManifest }),
  ).rejects.toThrow('backup_verification_failed');
});
test('timeout kills a stalled pipeline and cleans partial output', async () => {
  const f = await fixture();
  const stalled: BackupProcessPort = (_file, _args, options) =>
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
  await expect(
    createEncryptedBackup({ ...f.options, processes: stalled, timeoutMilliseconds: 50 }),
  ).rejects.toThrow('backup_failed');
  expect(await readdir(f.options.archiveDirectory)).toEqual([]);
});
test.each(['traversal', 'url_query', 'bad_revision', 'bad_timeout'])(
  'rejects invalid backup inputs: %s',
  async (kind) => {
    const f = await fixture();
    await expect(
      createEncryptedBackup({
        ...f.options,
        ...(kind === 'traversal'
          ? { archiveDirectory: join(f.root, 'archives', '..', 'archives') + '/..' }
          : {}),
        ...(kind === 'url_query'
          ? { connectionString: f.options.connectionString + '?options=synthetic' }
          : {}),
        ...(kind === 'bad_revision' ? { gitRevision: 'invalid' } : {}),
        ...(kind === 'bad_timeout' ? { timeoutMilliseconds: 0 } : {}),
      }),
    ).rejects.toThrow('backup_failed');
    expect(f.calls).toHaveLength(0);
  },
);
test.skipIf(process.platform === 'win32')(
  'rejects a symlink archive root without following it',
  async () => {
    const f = await fixture();
    const link = join(f.root, 'linked');
    await symlink(f.options.archiveDirectory, link);
    await expect(createEncryptedBackup({ ...f.options, archiveDirectory: link })).rejects.toThrow(
      'backup_failed',
    );
  },
);
test('manifest output contains no plaintext dump or connection material', async () => {
  const f = await fixture();
  const manifest = await createEncryptedBackup(f.options);
  const text = await readFile(
    join(f.options.archiveDirectory, manifest.backupRef, 'manifest.json'),
    'utf8',
  );
  expect(text).not.toContain('synthetic_dump');
  expect(text).not.toContain('synthetic_password');
  expect(text).not.toContain('synthetic_private_identity');
});
test.skipIf(process.platform === 'win32')(
  'readonly archive root fails before spawning a dump',
  async () => {
    const f = await fixture();
    await chmod(f.options.archiveDirectory, 0o500);
    await expect(createEncryptedBackup(f.options)).rejects.toThrow('backup_failed');
    expect(f.calls).toHaveLength(0);
    await chmod(f.options.archiveDirectory, 0o700);
  },
);
test('pruning refuses a missing latest archive and never deletes an older one', async () => {
  const f = await fixture();
  const manifest = await createEncryptedBackup(f.options);
  await rm(join(f.options.archiveDirectory, manifest.backupRef, 'archive.age'));
  await expect(
    pruneEncryptedBackups({
      ...f.options,
      manifests: [{ ...manifest, state: 'verified' }],
      policy: { daily: 45, monthly: 6 },
      evaluatedAt: new Date('2030-02-01T00:00:00.000Z'),
    }),
  ).rejects.toThrow('backup_prune_invalid');
  expect(await readdir(f.options.archiveDirectory)).toEqual([manifest.backupRef]);
});
test('backup CLI accepts only closed scheduled and bootstrap commands', () => {
  expect(parseBackupCommand(['pre-migration-backup', '2030-03-01T02:00:00.000Z'])).toEqual({
    job: 'backup',
    backupClass: 'pre_migration',
    scheduledAt: new Date('2030-03-01T02:00:00.000Z'),
    referenceOnly: true,
  });
  expect(parseBackupCommand(['backup', 'daily', '2030-03-01T02:00:00.000Z'])).toEqual({
    job: 'backup',
    backupClass: 'daily',
    scheduledAt: new Date('2030-03-01T02:00:00.000Z'),
  });
  expect(parseBackupCommand(['verify-backup', `backup_${'a'.repeat(32)}`])).toEqual({
    job: 'verify-backup',
    backupRef: `backup_${'a'.repeat(32)}`,
  });
  expect(parseBackupCommand(['prune-backups', '2030-03-01T02:00:00.000Z']).job).toBe(
    'prune-backups',
  );
  for (const input of [
    [],
    ['backup'],
    ['backup', 'arbitrary', '2030-03-01T02:00:00.000Z'],
    ['verify-backup', '../synthetic'],
    ['backup', 'daily', 'today'],
    ['backup', 'daily', '2030-03-01T02:00:00.000Z', 'extra'],
  ])
    expect(() => parseBackupCommand(input)).toThrow('operations_command_invalid');
});
test('rejects plugin or arbitrary recipients before spawning any tool', async () => {
  const f = await fixture();
  await writeFile(f.options.recipientFile, 'age1syntheticplugin1arbitrary');
  await expect(createEncryptedBackup(f.options)).rejects.toThrow('backup_failed');
  expect(f.calls).toHaveLength(0);
});
test('interrupted manifest rename never leaves an eligible archive', async () => {
  const f = await fixture();
  await expect(
    createEncryptedBackup({
      ...f.options,
      publish: (source, destination) =>
        destination.endsWith('manifest.json')
          ? Promise.reject(new Error('synthetic_rename_interrupted'))
          : rename(source, destination),
    }),
  ).rejects.toThrow('backup_failed');
  expect(await readdir(f.options.archiveDirectory)).toEqual([]);
});
test.skipIf(
  process.platform !== 'linux' ||
    process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only',
)('full tmpfs archive destination cleans ENOSPC partial ciphertext', async () => {
  const f = await fixture();
  const large: BackupProcessPort = (file, _args, options) =>
    spawn(
      process.execPath,
      [
        '-e',
        file === 'pg_dump'
          ? 'process.stdout.write("synthetic_dump")'
          : 'process.stdin.resume(); process.stdout.write(Buffer.alloc(80*1024*1024,0x73))',
      ],
      options,
    );
  await expect(createEncryptedBackup({ ...f.options, processes: large })).rejects.toThrow(
    'backup_failed',
  );
  expect(await readdir(f.options.archiveDirectory)).toEqual([]);
  expect(await readdir(f.options.temporaryDirectory)).toEqual([]);
});
test('a changed HMAC key invalidates a previously signed archive', async () => {
  const f = await fixture();
  const expectedManifest = await createEncryptedBackup(f.options);
  await writeFile(f.options.manifestHmacFile, 'synthetic_replacement_hmac_'.repeat(3));
  await expect(
    verifyEncryptedBackup({ ...f.options, identityFile: f.identityFile, expectedManifest }),
  ).rejects.toThrow('backup_verification_failed');
  expect(f.calls).toHaveLength(2);
});
test('prunes only excess signed copies after validating all replacement archives', async () => {
  const f = await fixture();
  const manifests = [];
  const cipher = Buffer.from('synthetic_ciphertext_fixture_only');
  const hmac = await readFile(f.options.manifestHmacFile);
  for (let index = 0; index < 53; index++) {
    const material = {
      backupRef: `backup_${index.toString(16).padStart(32, '0')}`,
      createdAt: (index < 46
        ? new Date(Date.UTC(2030, 6, 31 - index))
        : new Date(Date.UTC(2030, 6 - (index - 46), 1))
      ).toISOString(),
      class: index < 46 ? ('daily' as const) : ('monthly' as const),
      gitRevision: 'a'.repeat(40),
      schemaRevision: '000014',
      ciphertextBytes: cipher.length,
      ciphertextSha256: createHash('sha256').update(cipher).digest('hex'),
      state: 'created' as const,
    };
    const signature = createHmac('sha256', hmac)
      .update('fcd-support:backup:v1\n')
      .update(JSON.stringify(material))
      .digest('hex');
    const disk = { ...material, signature };
    const directory = join(f.options.archiveDirectory, material.backupRef);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'archive.age'), cipher, { mode: 0o600 });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(disk), { mode: 0o600 });
    manifests.push({
      ...disk,
      state: index === 44 ? ('restore_verified' as const) : ('verified' as const),
    });
  }
  const candidates = await pruneEncryptedBackups({
    ...f.options,
    manifests,
    policy: { daily: 45, monthly: 6 },
    evaluatedAt: new Date('2030-08-01T00:00:00.000Z'),
  });
  expect(candidates).toEqual([
    `backup_${(45).toString(16).padStart(32, '0')}`,
    `backup_${(52).toString(16).padStart(32, '0')}`,
  ]);
  expect(await readdir(f.options.archiveDirectory)).toHaveLength(51);
  expect(
    (
      await readBackupManifest(
        f.options.archiveDirectory,
        `backup_${(44).toString(16).padStart(32, '0')}`,
        f.options.manifestHmacFile,
      )
    ).state,
  ).toBe('created');
});
test('a reference collision preserves the preexisting archive directory', async () => {
  const f = await fixture();
  collision.uuid = '00000000-0000-4000-8000-000000000000';
  const existing = join(f.options.archiveDirectory, 'backup_00000000000040008000000000000000');
  await mkdir(existing, { mode: 0o700 });
  await writeFile(join(existing, 'synthetic-owned-file'), 'Synthetic preexisting archive marker');
  await expect(createEncryptedBackup(f.options)).rejects.toThrow('backup_failed');
  expect(await readFile(join(existing, 'synthetic-owned-file'), 'utf8')).toBe(
    'Synthetic preexisting archive marker',
  );
});
