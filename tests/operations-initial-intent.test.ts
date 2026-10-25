import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  image = `sha256:${'b'.repeat(64)}`,
  selectionRef = `selection_${'c'.repeat(32)}`;
const create = `operations_initial_intent_create ${image} ${image} ${image}`;
const select = `operations_selection_create ${selectionRef} fcd-support-initial fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${revision} 000000`;

async function fixture() {
  const root = await mkdtemp('/var/lib/fcd-support/backups/initial-intent-test-');
  await chmod(root, 0o700);
  await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
  const run = (body: string) =>
    spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support [FCD_POSTGRES_VOLUME]=fcd-support-initial [FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000016)
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 8000,
        env: {
          PATH: process.env.PATH,
          TASK_ROOT: root,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_LIBRARY: resolve('scripts/operations-deployment-state.sh'),
          TASK_RUNTIME: resolve('scripts/operations-runtime-host.sh'),
        },
      },
    );
  return {
    root,
    run,
    file: join(root, 'initial-deployment.record'),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
function expectSuccess(result: ReturnType<typeof spawnSync>) {
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: '',
    stderr: '',
  });
}
function expectRefused(result: ReturnType<typeof spawnSync>) {
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 1,
    stdout: '',
    stderr: 'operations_deployment_state_invalid\n',
  });
}

test.runIf(native)(
  'first-boot intent is private, immutable and binds scope/images without inventing a database system identifier',
  async () => {
    const f = await fixture();
    try {
      expectSuccess(f.run(create));
      const body = await readFile(f.file, 'utf8');
      expect(body).toMatch(
        /^INITIAL_VERSION=1\nINITIAL_PROJECT=fcd-support\nINITIAL_REF=selection_[a-f0-9]{32}\n/u,
      );
      expect(body).toContain('INITIAL_VOLUME=fcd-support-initial\n');
      expect(body).toContain(`INITIAL_REVISION=${revision}\n`);
      expect(body).not.toMatch(/SYSTEM_IDENTIFIER|WRITES_POSSIBLE|STATE_PHASE/u);
      expect((await stat(f.file)).mode & 0o777).toBe(0o600);
      expectSuccess(f.run(`operations_initial_intent_matches ${image} ${image} ${image}`));
      expectRefused(f.run(create));
      expect(await readFile(f.file, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native).each([
  ['FCD_POSTGRES_VOLUME', 'fcd-support-other'],
  ['FCD_SUPPORT_REVISION', 'd'.repeat(40)],
  ['FCD_DATABASE_ROLE_PREFIX', 'fcd_other'],
  ['FCD_SCHEMA_REVISION', '000015'],
  ['FCD_POSTGRES_DB', 'fcd_support_other'],
  ['FCD_DATABASE_SCHEMA', 'synthetic_other'],
])('first-boot intent refuses changed %s configuration', async (key, value) => {
  const f = await fixture();
  try {
    expectSuccess(f.run(create));
    const body = await readFile(f.file, 'utf8');
    expectRefused(
      f.run(
        `OPS_CONFIG[${key}]=${value}; operations_initial_intent_matches ${image} ${image} ${image}`,
      ),
    );
    expect(await readFile(f.file, 'utf8')).toBe(body);
  } finally {
    await f.dispose();
  }
});

test.runIf(native).each([0, 1, 2])(
  'first-boot intent refuses substituted image %s',
  async (index) => {
    const f = await fixture();
    try {
      expectSuccess(f.run(create));
      const images = [image, image, image];
      images[index] = `sha256:${'e'.repeat(64)}`;
      expectRefused(f.run(`operations_initial_intent_matches ${images.join(' ')}`));
    } finally {
      await f.dispose();
    }
  },
);

test
  .runIf(native)
  .each([
    'active-job',
    'volume-synthetic.record',
    `retained-${revision}.record`,
    'deployment-state.next',
    'initial-deployment.record.next',
  ])(
  'first-boot intent refuses existing %s evidence before creating a new intent',
  async (file) => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, file), 'synthetic_existing_evidence\n', { mode: 0o600 });
      expectRefused(f.run(create));
      await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native).each(['operations_selection_create', 'operations_selection_adopt_draining'])(
  'pending first-boot intent prevents %s from bypassing initialization evidence',
  async (method) => {
    const f = await fixture();
    try {
      expectSuccess(f.run(create));
      expectRefused(f.run(select.replace('operations_selection_create', method)));
      await expect(readFile(join(f.root, 'deployment-state'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'an existing selected deployment cannot acquire a first-boot intent',
  async () => {
    const f = await fixture();
    try {
      expectSuccess(f.run(select));
      expectRefused(f.run(create));
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'a pending intent replacement blocks reads without changing the original',
  async () => {
    const f = await fixture();
    try {
      expectSuccess(f.run(create));
      const body = await readFile(f.file, 'utf8');
      await writeFile(f.file + '.next', 'synthetic_pending\n', { mode: 0o600 });
      expectRefused(f.run(`operations_initial_intent_matches ${image} ${image} ${image}`));
      expect(await readFile(f.file, 'utf8')).toBe(body);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'a first-boot intent prevents the missing-pointer bootstrap inspection path',
  async () => {
    const f = await fixture();
    try {
      expectSuccess(f.run(create));
      const result = f.run(
        'source "$TASK_RUNTIME"; operations_runtime_selection_context bootstrap',
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 1,
        stdout: '',
        stderr: 'runtime_host_invalid\n',
      });
    } finally {
      await f.dispose();
    }
  },
);
