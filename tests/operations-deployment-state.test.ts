import { spawnSync } from 'node:child_process';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const ref = `selection_${'a'.repeat(32)}`,
  nextRef = `selection_${'b'.repeat(32)}`;
const revision = 'a'.repeat(40);
const image = `sha256:${'d'.repeat(64)}`;
const create = `operations_selection_create ${ref} fcd-support-original fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${revision} 000016`;
const start = `operations_selection_starting ${ref} ${revision} 000016`;
const ready = `${start}; operations_selection_ready ${ref}`;
const retain = `operations_retain_revision ${ref} ${image} sha256:${'e'.repeat(64)} sha256:${'f'.repeat(64)}`;
const select = `operations_selection_switch ${ref} ${nextRef} fcd-support-restored fcd-support-restore-synthetic 2030-04-02T00:00:00Z 2222222222222222222 fcd_support restore_${'c'.repeat(32)} ${revision} 000016`;
async function fixture() {
  const root = await mkdtemp('/var/lib/fcd-support/backups/deployment-state-test-');
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
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public)
${locked ? 'exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR";' : ''}
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 7000,
        env: {
          PATH: process.env.PATH,
          TASK_ROOT: root,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_LIBRARY: resolve('scripts/operations-deployment-state.sh'),
        },
      },
    );
  return {
    root,
    run,
    file: join(root, 'deployment-state'),
    manifest: join(root, `retained-${revision}.record`),
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
    stderr: 'operations_deployment_state_invalid\n',
  });
}

test.runIf(native)(
  'selection records a protected quiescent pointer and cannot be initialized twice',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      const body = await readFile(f.file, 'utf8');
      expect(body).toContain('STATE_PHASE=quiescent\n');
      expect(body).toContain('STATE_WRITES_POSSIBLE=no\n');
      expect((await stat(f.file)).mode & 0o777).toBe(0o600);
      expect((await stat(f.file)).nlink).toBe(1);
      success(f.run('operations_selection_read'));
      refused(f.run(create));
      expect(await readFile(f.file, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'write exposure is recorded before startup and uncertainty cannot silently become ready',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${start}`));
      expect(await readFile(f.file, 'utf8')).toContain('STATE_WRITES_POSSIBLE=yes\n');
      success(f.run(`operations_selection_uncertain ${ref}`));
      const body = await readFile(f.file, 'utf8');
      refused(f.run(`operations_selection_ready ${ref}`));
      refused(f.run(`operations_selection_quiesce ${ref}`));
      expect(await readFile(f.file, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'only ready images are retained immutably and schema/revision are read from the selection',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      refused(f.run(retain));
      success(f.run(`${ready}; ${retain}; ${retain}`));
      success(f.run(`operations_retained_read ${revision}`));
      const body = await readFile(f.manifest, 'utf8');
      expect(body).toContain(`BUNDLE_REVISION=${revision}\n`);
      expect(body).toContain('BUNDLE_SCHEMA_REVISION=000016\n');
      refused(f.run(retain.replace(image, `sha256:${'9'.repeat(64)}`)));
      expect(await readFile(f.manifest, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'switch selects a new unused restore volume durably and preserves the previous pointer',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${ready}`));
      refused(f.run(select));
      success(f.run(`operations_selection_quiesce ${ref}; ${select}`));
      const body = await readFile(f.file, 'utf8');
      expect(body).toContain('STATE_PHASE=switching\n');
      expect(body).toContain('STATE_VOLUME=fcd-support-restored\n');
      expect(body).toContain('STATE_PREVIOUS_VOLUME=fcd-support-original\n');
      expect(body).toContain('STATE_WRITES_POSSIBLE=no\n');
      success(
        f.run(
          `operations_selection_starting ${nextRef} ${revision} 000016; operations_selection_ready ${nextRef}; operations_selection_quiesce ${nextRef}`,
        ),
      );
      const before = await readFile(f.file, 'utf8');
      refused(
        f.run(
          `operations_selection_switch ${nextRef} selection_${'d'.repeat(32)} fcd-support-original fcd-support-restore-other 2030-04-03T00:00:00Z 3333333333333333333 fcd_support restore_${'d'.repeat(32)} ${revision} 000016`,
        ),
      );
      expect(await readFile(f.file, 'utf8')).toBe(before);
    } finally {
      await f.dispose();
    }
  },
  // Several separately bounded subprocesses and fsyncs share one test case.
  20000,
);
test
  .runIf(native)
  .each([
    'symlink',
    'hardlink',
    'broad',
    'unknown',
    'duplicate',
    'nul',
    'missing',
    'phase',
    'foreign-project',
    'restore-origin',
    'unsafe-ready',
    'stale-next',
  ])('selection refuses %s without changing the record or permissions', async (fault) => {
  const f = await fixture();
  try {
    success(f.run(create));
    let body = await readFile(f.file, 'utf8');
    if (fault === 'symlink') {
      await rm(f.file);
      await writeFile(join(f.root, 'other'), body, { mode: 0o600 });
      await symlink(join(f.root, 'other'), f.file);
    } else if (fault === 'hardlink') await link(f.file, join(f.root, 'alias'));
    else if (fault === 'broad') await chmod(f.file, 0o644);
    else if (fault === 'stale-next')
      await writeFile(f.file + '.next', 'synthetic_pending_replace\n', { mode: 0o600 });
    else {
      if (fault === 'unknown') body += 'UNEXPECTED=yes\n';
      if (fault === 'duplicate') body += 'STATE_VERSION=1\n';
      if (fault === 'nul') body += '\0';
      if (fault === 'missing') body = body.replace('STATE_VERSION=1\n', '');
      if (fault === 'phase') body = body.replace('STATE_PHASE=quiescent', 'STATE_PHASE=forged');
      if (fault === 'foreign-project')
        body = body.replace('STATE_PROJECT=fcd-support', 'STATE_PROJECT=fcd-support-foreign');
      if (fault === 'restore-origin')
        body = body.replace(
          'STATE_VOLUME_LOGICAL=postgres-data',
          'STATE_VOLUME_LOGICAL=restore-data',
        );
      if (fault === 'unsafe-ready')
        body = body.replace('STATE_PHASE=quiescent', 'STATE_PHASE=ready');
      await writeFile(f.file, body);
    }
    const before = await readFile(f.file, 'utf8');
    const mode = (await stat(f.file)).mode;
    refused(f.run('operations_selection_read'));
    expect(await readFile(f.file, 'utf8')).toBe(before);
    expect((await stat(f.file)).mode).toBe(mode);
  } finally {
    await f.dispose();
  }
});
test.runIf(native)(
  'a missing pointer cannot be re-created over the immutable used-volume history',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      await rm(f.file);
      refused(f.run(create));
      refused(f.run(create.replace('fcd-support-original', 'fcd-support-different')));
      await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'a substituted selected-volume creation identity is refused against immutable history',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      const body = await readFile(f.file, 'utf8');
      await writeFile(
        f.file,
        body.replace(
          'STATE_SYSTEM_IDENTIFIER=1111111111111111111',
          'STATE_SYSTEM_IDENTIFIER=2222222222222222222',
        ),
      );
      refused(f.run('operations_selection_read'));
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'a rejected transition or source cluster reuse leaves the selection unchanged',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      const before = await readFile(f.file, 'utf8');
      refused(f.run(`operations_selection_ready ${ref}`));
      refused(f.run(select.replace('2222222222222222222', '1111111111111111111')));
      refused(f.run(start.replace(ref, nextRef)));
      refused(f.run(start.replace('000016', '000015')));
      expect(await readFile(f.file, 'utf8')).toBe(before);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'selection replacement refuses a changed file and preserves the unresolved replacement',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      const before = await readFile(f.file, 'utf8');
      refused(
        f.run(
          `operations_selection_read; OPS_SELECTION[STATE_PHASE]=starting; OPS_SELECTION[STATE_WRITES_POSSIBLE]=yes; printf '%s\\n' STATE_SCHEMA_REVISION=000017 >> "$TASK_ROOT/deployment-state"; operations_selection_replace`,
        ),
      );
      expect(await readFile(f.file, 'utf8')).toBe(before + 'STATE_SCHEMA_REVISION=000017\n');
      expect((await stat(f.file + '.next')).mode & 0o777).toBe(0o600);
      refused(f.run('operations_selection_read'));
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'a retained bundle cannot be replayed under a different revision filename',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${ready}; ${retain}`));
      const body = await readFile(f.manifest, 'utf8');
      const other = 'b'.repeat(40);
      await writeFile(join(f.root, `retained-${other}.record`), body, { mode: 0o600 });
      refused(f.run(`operations_retained_read ${other}`));
      expect(await readFile(f.manifest, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'a deployment record cannot be written without the matching held lock descriptor',
  async () => {
    const f = await fixture();
    try {
      refused(f.run(create, false));
      await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'selection refuses a different configured database or schema namespace',
  async () => {
    const f = await fixture();
    try {
      success(f.run(create));
      const body = await readFile(f.file, 'utf8');
      refused(f.run('OPS_CONFIG[FCD_POSTGRES_DB]=fcd_support_foreign; operations_selection_read'));
      refused(f.run('OPS_CONFIG[FCD_DATABASE_SCHEMA]=foreign_schema; operations_selection_read'));
      expect(await readFile(f.file, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'restored volume provenance remains bound to its immutable used-volume record',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${ready}; operations_selection_quiesce ${ref}; ${select}`));
      const body = await readFile(f.file, 'utf8');
      await writeFile(
        f.file,
        body.replace(
          'STATE_VOLUME_ORIGIN=fcd-support-restore-synthetic',
          'STATE_VOLUME_ORIGIN=fcd-support-restore-foreign',
        ),
      );
      refused(f.run('operations_selection_read'));
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'retained bundles also refuse a substituted database or schema namespace',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${ready}; ${retain}`));
      refused(
        f.run(
          `OPS_CONFIG[FCD_POSTGRES_DB]=fcd_support_foreign; operations_retained_read ${revision}`,
        ),
      );
      refused(
        f.run(
          `OPS_CONFIG[FCD_DATABASE_SCHEMA]=foreign_schema; operations_retained_read ${revision}`,
        ),
      );
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'Compose volume selection uses the protected pointer and never a stale configured fallback',
  async () => {
    const f = await fixture();
    try {
      success(
        f.run(
          `${create}; OPS_CONFIG[FCD_POSTGRES_VOLUME]=fcd-support-stale; operations_selection_apply; [[ "\${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" == fcd-support-original ]]`,
        ),
      );
      success(
        f.run(
          `${ready}; operations_selection_quiesce ${ref}; ${select}; OPS_CONFIG[FCD_POSTGRES_VOLUME]=fcd-support-original; operations_selection_apply; [[ "\${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" == fcd-support-restored ]]`,
        ),
      );
      const result = f.run('operations_selection_volume_identity');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        name: 'fcd-support-restored',
        project: 'fcd-support-restore-synthetic',
        logicalName: 'restore-data',
        createdAt: '2030-04-02T00:00:00Z',
      });
      await rm(f.file);
      refused(f.run('operations_selection_apply'));
    } finally {
      await f.dispose();
    }
  },
  20000,
);

test.runIf(native)(
  'a managed drain has a durable non-ready phase before any shutdown',
  async () => {
    const f = await fixture();
    try {
      success(f.run(`${create}; ${ready}; operations_selection_draining ${ref}`));
      const body = await readFile(f.file, 'utf8');
      expect(body).toContain('STATE_PHASE=draining\n');
      expect(body).toContain('STATE_WRITES_POSSIBLE=yes\n');
      refused(f.run(`operations_selection_ready ${ref}`));
      success(f.run(`operations_selection_quiesce ${ref}`));
    } finally {
      await f.dispose();
    }
  },
);
test.runIf(native)(
  'initial admission adoption records drain intent and possible writes in its first pointer',
  async () => {
    const f = await fixture();
    try {
      success(
        f.run(create.replace('operations_selection_create', 'operations_selection_adopt_draining')),
      );
      const body = await readFile(f.file, 'utf8');
      expect(body).toContain('STATE_PHASE=draining\n');
      expect(body).toContain('STATE_WRITES_POSSIBLE=yes\n');
      refused(f.run(retain));
      success(f.run(`operations_selection_uncertain ${ref}`));
      refused(f.run(`operations_selection_quiesce ${ref}`));
    } finally {
      await f.dispose();
    }
  },
);
