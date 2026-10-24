import { spawnSync } from 'node:child_process';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const reference = `operation_${'a'.repeat(32)}`;
const cid = 'b'.repeat(64);
const begin = `operations_job_state_begin ${reference} backup sha256:${'d'.repeat(64)} ${'e'.repeat(64)}`;
async function fixture(tmpfs = false) {
  const root = await mkdtemp(
    (tmpfs ? '/run/fcd-support/' : '/var/lib/fcd-support/backups/') + 'job-state-test-',
  );
  await chmod(root, 0o700);
  await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
  const run = (body: string, lock = true, selectedRoot = root) =>
    spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support-runtime [FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_COMMAND_TIMEOUT_SECONDS]=5)
${lock ? 'exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR";' : ''}
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 4000,
        env: {
          PATH: process.env.PATH,
          TASK_ROOT: selectedRoot,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_LIBRARY: resolve('scripts/operations-job-state.sh'),
        },
      },
    );
  return {
    root,
    run,
    file: join(root, 'active-job'),
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
    stderr: 'operations_job_state_invalid\n',
  });
}

test.runIf(native)(
  'job intent is persisted as a protected content-free record and round-trips',
  async () => {
    const f = await fixture();
    try {
      success(f.run(begin));
      success(f.run('operations_job_state_read'));
      const body = await readFile(f.file, 'utf8');
      expect(body).toContain(`JOB_REF=${reference}\n`);
      expect(body).toContain('JOB_PHASE=intent\n');
      expect(body).toContain('JOB_CONTAINER=pending\n');
      expect((await stat(f.file)).mode & 0o777).toBe(0o600);
      expect((await stat(f.file)).nlink).toBe(1);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'created started completed job state clears only after the terminal transition',
  async () => {
    const f = await fixture();
    try {
      success(
        f.run(
          `${begin}; operations_job_state_transition ${reference} created ${cid}; operations_job_state_transition ${reference} started ${cid}; operations_job_state_transition ${reference} completed ${cid}; operations_job_state_clear ${reference}`,
        ),
      );
      await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'an unstarted cancelled intent can clear without inventing a container identity',
  async () => {
    const f = await fixture();
    try {
      success(
        f.run(
          `${begin}; operations_job_state_transition ${reference} cancelled pending; operations_job_state_clear ${reference}`,
        ),
      );
      await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'uncertain state survives refusal and requires an explicit recorded resolution',
  async () => {
    const f = await fixture();
    try {
      success(
        f.run(
          `${begin}; operations_job_state_transition ${reference} created ${cid}; operations_job_state_transition ${reference} started ${cid}; operations_job_state_transition ${reference} uncertain ${cid}`,
        ),
      );
      const prior = await readFile(f.file, 'utf8');
      refused(f.run(`operations_job_state_clear ${reference}`));
      expect(await readFile(f.file, 'utf8')).toBe(prior);
      success(
        f.run(
          `operations_job_state_transition ${reference} resolved ${cid}; operations_job_state_clear ${reference}`,
        ),
      );
      await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);

test
  .runIf(native)
  .each(['duplicate-begin', 'wrong-ref', 'wrong-container', 'replay', 'premature-clear'] as const)(
  'job state refuses %s without changing the pending record',
  async (fault) => {
    const f = await fixture();
    try {
      success(f.run(`${begin}; operations_job_state_transition ${reference} created ${cid}`));
      const before = await readFile(f.file, 'utf8');
      const command =
        fault === 'duplicate-begin'
          ? begin
          : fault === 'wrong-ref'
            ? `operations_job_state_transition operation_${'c'.repeat(32)} started ${cid}`
            : fault === 'wrong-container'
              ? `operations_job_state_transition ${reference} started ${'c'.repeat(64)}`
              : fault === 'replay'
                ? `operations_job_state_transition ${reference} created ${cid}`
                : `operations_job_state_clear ${reference}`;
      refused(f.run(command));
      expect(await readFile(f.file, 'utf8')).toBe(before);
    } finally {
      await f.dispose();
    }
  },
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
    'bad-phase',
    'foreign-parent',
  ] as const)('job state rejects %s records without repair', async (fault) => {
  const f = await fixture();
  try {
    success(f.run(begin));
    let body = await readFile(f.file, 'utf8');
    if (fault === 'symlink') {
      const target = join(f.root, 'original');
      await writeFile(target, body, { mode: 0o600 });
      await rm(f.file);
      await symlink(target, f.file);
    } else if (fault === 'hardlink') await link(f.file, join(f.root, 'other'));
    else if (fault === 'broad') await chmod(f.file, 0o644);
    else {
      if (fault === 'unknown') body += 'UNDECLARED=1\n';
      if (fault === 'duplicate') body += 'JOB_VERSION=1\n';
      if (fault === 'nul') body += '\0ignored';
      if (fault === 'missing') body = body.replace(/^JOB_IMAGE=.*\n/mu, '');
      if (fault === 'bad-phase') body = body.replace('JOB_PHASE=intent', 'JOB_PHASE=started');
      if (fault === 'foreign-parent')
        body = body.replace('JOB_PARENT=fcd-support-runtime', 'JOB_PARENT=fcd-support-foreign');
      await writeFile(f.file, body, { mode: 0o600 });
    }
    refused(f.run('operations_job_state_read'));
    if (fault === 'broad') expect((await stat(f.file)).mode & 0o777).toBe(0o644);
    else expect(await readFile(f.file, 'utf8')).toBe(body);
  } finally {
    await f.dispose();
  }
});

test.runIf(native)('state mutation requires the actual deployment lock descriptor', async () => {
  const f = await fixture();
  try {
    refused(f.run(begin, false));
    await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});
test.runIf(native)('volatile state storage cannot authorize a durable job intent', async () => {
  const f = await fixture(true);
  try {
    refused(f.run(begin));
    await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});
test.runIf(native)('missing state roots are refused without creating directories', async () => {
  const f = await fixture();
  try {
    const missing = join(f.root, 'absent');
    refused(f.run(begin, false, missing));
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});
