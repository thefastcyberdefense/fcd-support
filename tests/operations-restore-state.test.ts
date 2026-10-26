import { spawnSync } from 'node:child_process';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const ref = `restore_${'a'.repeat(32)}`,
  sourceRef = `selection_${'b'.repeat(32)}`;
const backupRef = `backup_${'c'.repeat(32)}`,
  checkpointRef = `checkpoint_${'d'.repeat(32)}`;
const revision = 'e'.repeat(40),
  app = `sha256:${'1'.repeat(64)}`,
  ops = `sha256:${'2'.repeat(64)}`,
  pg = `sha256:${'3'.repeat(64)}`;
const sourceId = '7300000000000000000';
const target = {
  projectName: 'fcd-support-restore-synthetic',
  volumeName: 'fcd-support-restore-synthetic-data',
  volumeCreatedAt: '2030-01-01T00:00:00.000Z',
  networkId: 'f'.repeat(64),
  postgresImageId: pg,
  runtimeImageId: app,
  systemIdentifier: '7300000000000000001',
  databaseName: 'fcd_support_test',
  schema: 'public',
  gitRevision: revision,
  schemaRevision: '000016',
};
const token = (material: unknown = target) =>
  Buffer.from(JSON.stringify(material)).toString('base64');
const begin = `restore_state_begin ${ref} ${backupRef} ${checkpointRef} ${sourceRef} fcd-support-original ${sourceId} ${target.projectName} ${target.volumeName} ${app} ${ops} ${pg} ${revision} 000016`;
const create = `operations_selection_create ${sourceRef} fcd-support-original fcd-support postgres-data 2030-01-01T00:00:00Z ${sourceId} fcd_support_test ${revision} 000016`;

function shell(body: string, extra: Record<string, string> = {}) {
  return spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      `source "$TASK_COMMON"\nsource "$TASK_LIBRARY"\ndeclare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public)\n${body}`,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/operations-restore-state.sh').replaceAll('\\', '/'),
        ...extra,
      },
    },
  );
}

test.each([
  ['RESTORE_VERSION', '1', true],
  ['RESTORE_PHASE', 'intent', true],
  ['RESTORE_PHASE', 'ready', false],
  ['RESTORE_REF', ref, true],
  ['RESTORE_REF', '../synthetic', false],
  ['RESTORE_PROJECT', 'fcd-support-foreign', false],
  ['RESTORE_DATABASE_NAME', 'fcd_support_test', true],
  ['RESTORE_DATABASE_NAME', 'fcd_support_other', false],
  ['RESTORE_SCHEMA', 'public', true],
  ['RESTORE_SCHEMA', 'public,pg_catalog', false],
  ['RESTORE_SOURCE_SYSTEM_IDENTIFIER', '18446744073709551615', true],
  ['RESTORE_SOURCE_SYSTEM_IDENTIFIER', '18446744073709551616', false],
  ['RESTORE_TARGET_PROJECT', 'fcd-support-restore-synthetic', true],
  ['RESTORE_TARGET_VOLUME', 'fcd-support-restore-synthetic-data', true],
  ['RESTORE_TARGET_VOLUME', 'fcd-support-original', false],
  ['RESTORE_APP_IMAGE', app, true],
  ['RESTORE_APP_IMAGE', 'synthetic:latest', false],
  ['RESTORE_TARGET_METADATA', 'QUJDRA==', true],
  ['RESTORE_TARGET_METADATA', 'QUJDRA_', false],
  ['SYNTHETIC_UNKNOWN', '1', false],
] as const)(
  'closed restore record field %s rejects unsafe or foreign values',
  (field, value, valid) => {
    const result = shell('restore_state_field "$TASK_FIELD" "$TASK_VALUE"', {
      TASK_FIELD: field,
      TASK_VALUE: value,
    });
    expect(result.status, result.stderr).toBe(valid ? 0 : 1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  },
);

async function fixture() {
  const root = await mkdtemp('/var/lib/fcd-support/backups/restore-state-test-');
  await chmod(root, 0o700);
  await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
  const run = (body: string, locked = true) =>
    spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000016)
${locked ? 'exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR";' : ''}
operations_restore_metadata_decode() { "$TASK_NODE" "$TASK_METADATA" decode-fields "$1"; }
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 12000,
        env: {
          PATH: process.env.PATH,
          TASK_ROOT: root,
          TASK_NODE: process.execPath,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_LIBRARY: resolve('scripts/operations-restore-state.sh'),
          TASK_METADATA: '/app/dist/operations/restore-metadata-main.js',
        },
      },
    );
  return {
    root,
    run,
    intent: join(root, `restore-${'a'.repeat(32)}.intent`),
    record: join(root, `restore-${'a'.repeat(32)}.record`),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
function success(result: ReturnType<typeof spawnSync>) {
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: '',
    stderr: '',
  });
}
function refused(result: ReturnType<typeof spawnSync>) {
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 1,
    stdout: '',
    stderr: 'operations_restore_state_invalid\n',
  });
}

test.runIf(native)(
  'intent precedes changes, survives completion and never changes the source pointer',
  async () => {
    const f = await fixture();
    try {
      success(
        f.run(
          `${create}; operations_selection_starting ${sourceRef} ${revision} 000016; operations_selection_ready ${sourceRef}; ${begin}; restore_state_read ${ref}; [[ "$` +
            `{OPS_RESTORE_STATE[RESTORE_PHASE]}" == intent ]]`,
        ),
      );
      const intent = await readFile(f.intent, 'utf8');
      refused(f.run(`restore_state_complete ${ref} '${token()}'`));
      success(f.run(`operations_selection_quiesce ${sourceRef}`));
      const pointer = await readFile(join(f.root, 'deployment-state'), 'utf8');
      success(
        f.run(
          `restore_state_complete ${ref} '${token()}'; restore_state_read ${ref}; [[ "$` +
            `{OPS_RESTORE_STATE[RESTORE_PHASE]}" == completed ]]`,
        ),
      );
      expect(await readFile(f.intent, 'utf8')).toBe(intent);
      expect(await readFile(join(f.root, 'deployment-state'), 'utf8')).toBe(pointer);
      const complete = await readFile(f.record, 'utf8');
      expect(complete).toContain(`RESTORE_TARGET_METADATA=${token()}\n`);
      expect((await stat(f.record)).mode & 0o777).toBe(0o600);
      expect((await stat(f.record)).nlink).toBe(1);
      refused(f.run(`restore_state_complete ${ref} '${token()}'`));
      refused(f.run(begin));
      expect(await readFile(f.record, 'utf8')).toBe(complete);
    } finally {
      await f.dispose();
    }
  },
  20000,
);

test.runIf(native)(
  'unfinished intent prevents another restore reference from bypassing uncertainty',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${begin}`));
      const intent = await readFile(f.intent, 'utf8');
      refused(
        f.run(
          begin
            .replace(ref, `restore_${'9'.repeat(32)}`)
            .replaceAll('restore-synthetic', 'restore-other'),
        ),
      );
      expect(await readFile(f.intent, 'utf8')).toBe(intent);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native).each([
  { ...target, systemIdentifier: sourceId },
  { ...target, projectName: 'fcd-support-restore-foreign' },
  { ...target, volumeName: 'fcd-support-restore-foreign' },
  { ...target, runtimeImageId: ops },
  { ...target, databaseName: 'fcd_support_other' },
  { ...target, schema: 'foreign' },
  { ...target, gitRevision: '9'.repeat(40) },
])('completion rejects substituted target material without changing intent', async (material) => {
  const f = await fixture();
  try {
    success(f.run(`${create}; ${begin}`));
    const intent = await readFile(f.intent, 'utf8');
    refused(f.run(`restore_state_complete ${ref} '${token(material)}'`));
    expect(await readFile(f.intent, 'utf8')).toBe(intent);
    await expect(stat(f.record)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});

test
  .runIf(native)
  .each(['symlink', 'hardlink', 'broad', 'duplicate', 'unknown', 'nul', 'next', 'source', 'scope'])(
  'read rejects %s while preserving immutable restore history',
  async (fault) => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${begin}; restore_state_complete ${ref} '${token()}'`));
      const body = await readFile(f.record, 'utf8');
      if (fault === 'symlink') {
        await rm(f.record);
        await writeFile(join(f.root, 'other'), body, { mode: 0o600 });
        await symlink(join(f.root, 'other'), f.record);
      }
      if (fault === 'hardlink') await link(f.record, join(f.root, 'alias'));
      if (fault === 'broad') await chmod(f.record, 0o644);
      if (fault === 'duplicate') await writeFile(f.record, body + 'RESTORE_VERSION=1\n');
      if (fault === 'unknown') await writeFile(f.record, body + 'SYNTHETIC_UNKNOWN=yes\n');
      if (fault === 'nul') await writeFile(f.record, body + '\0');
      if (fault === 'next')
        await writeFile(f.record + '.next', 'synthetic_pending\n', { mode: 0o600 });
      const actual = await readFile(f.record, 'utf8');
      const command =
        fault === 'source'
          ? `restore_state_read ${ref}`
          : fault === 'scope'
            ? `OPS_CONFIG[FCD_DATABASE_SCHEMA]=foreign; restore_state_read ${ref}`
            : `restore_state_read ${ref}`;
      if (fault === 'source') {
        const pointer = join(f.root, 'deployment-state');
        await writeFile(
          pointer,
          (await readFile(pointer, 'utf8')).replace(sourceRef, `selection_${'8'.repeat(32)}`),
        );
      }
      refused(f.run(command));
      expect(await readFile(f.record, 'utf8')).toBe(actual);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'completion checks original intent CAS after metadata validation and preserves unresolved next',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${begin}`));
      refused(
        f.run(
          `operations_restore_metadata_decode() { "$TASK_NODE" "$TASK_METADATA" decode-fields "$1"; printf '%s\\n' RESTORE_VERSION=1 >> '${f.intent}'; }; restore_state_complete ${ref} '${token()}'`,
        ),
      );
      await expect(stat(f.record)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(f.record + '.next')).mode & 0o777).toBe(0o600);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'intent refuses absent lock ownership before writing any restore file',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      refused(f.run(begin, false));
      await expect(stat(f.intent)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);
