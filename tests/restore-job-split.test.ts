import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const reference = `restore_${'a'.repeat(32)}`;
const verification = `restore_${'b'.repeat(32)}`;
const backup = `backup_${'c'.repeat(32)}`;
const checkpoint = `checkpoint_${'d'.repeat(32)}`;
const system = '7300000000000000001';
function run(body: string) {
  return spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      `source "$TASK_COMMON"; source "$TASK_JOBS"; operations_promotion_host_check() { return 0; }; ${body}`,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_JOBS: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
      },
    },
  );
}
const jobs = [
  ['restore', ['restore', reference, backup, checkpoint, 'e30='], 'restore-stream-main'],
  ['restore-bootstrap', ['prepare', system, '/run/secrets'], 'bootstrap-main'],
  ['restore-bootstrap', ['converge', system, '/run/secrets'], 'bootstrap-main'],
  ['restore-migrate', ['migrate', system], 'restore-migrate-main'],
  [
    'restore-reconcile',
    ['restore', reference, backup, checkpoint, 'e30='],
    'restore-reconcile-main',
  ],
  ['promote', ['promote', reference, verification, backup, checkpoint, 'e30='], 'promotion-main'],
] as const;
test.each(jobs)(
  'split %s job invokes its sole approved program with closed arguments',
  (service, args, program) => {
    const value = run(
      `operations_job_command ${service} ${args.join(' ')}; printf '%s' "$OPS_JOB_COMMAND_JSON"`,
    );
    expect({ code: value.status, stderr: value.stderr, stdout: value.stdout }).toEqual({
      code: 0,
      stderr: '',
      stdout: JSON.stringify(['node', `dist/operations/${program}.js`, ...args]),
    });
  },
);
test.each([
  ['restore', 'restore bad bad bad e30='],
  ['restore-reconcile', `restore ${reference} ${backup} ${checkpoint} e30= extra`],
  ['restore-bootstrap', `prepare ${system} /unsafe`],
  ['restore-migrate', 'migrate 0'],
  ['promote', `promote ${reference} ${reference} ${backup} ${checkpoint} e30=`],
  ['promote', `promote ${reference} ${verification} ${backup} ${checkpoint} e30`],
])('split %s job refuses malformed or excessive arguments', (service, args) => {
  expect(run(`operations_job_command ${service} ${args}`).status).not.toBe(0);
});
test.each(['restore', 'restore-bootstrap', 'restore-migrate', 'restore-reconcile', 'promote'])(
  'split %s override carries only its required source metadata',
  (service) => {
    const value =
      run(`declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_RUNTIME_PROJECT]=fcd-support);
OPS_JOB_SERVICE=${service}; OPS_JOB_IMAGE=sha256:${'b'.repeat(64)}; OPS_JOB_COMMAND_JSON='["node","synthetic"]'; OPS_JOB_REFERENCE=operation_${'c'.repeat(32)}; OPS_JOB_COMMAND_HASH=${'d'.repeat(64)};
declare -A OPS_JOB_TARGET=([OPS_DATABASE_SYSTEM_IDENTIFIER]=${system} [OPS_DATABASE_NAME]=fcd_support_test [OPS_DATABASE_SCHEMA]=public [OPS_DATABASE_ROLE_PREFIX]=fcd_synthetic [OPS_SCHEMA_REVISION]=000016 [OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER]=7300000000000000099 [OPS_SOURCE_DATABASE_NAME]=fcd_support_test);
operations_job_override`);
    expect(value.status).toBe(0);
    const parsed = JSON.parse(value.stdout) as {
      services: Record<string, { environment: Record<string, string>; stdin_open?: boolean }>;
    };
    const job = parsed.services[service];
    if (job === undefined) throw new Error('synthetic_job_missing');
    const sourceConnected = ['restore', 'restore-reconcile', 'promote'].includes(service);
    expect(job.environment.OPS_DATABASE_SYSTEM_IDENTIFIER).toBe(system);
    expect(job.environment.OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER).toBe(
      sourceConnected ? '7300000000000000099' : undefined,
    );
    expect(job.stdin_open).toBe(service === 'promote' ? true : undefined);
    expect(
      Object.keys(job.environment).some((key) => /PASSWORD|DATABASE_URL|KEYRING/u.test(key)),
    ).toBe(false);
  },
);
test('ordinary bootstrap uses the distinct restored owner only for a protected restored selection', () => {
  const value =
    run(`declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_VOLUME]=fcd-support-restored [FCD_SECRET_ROOT]=/protected/secrets);
OPS_JOB_SERVICE=bootstrap; OPS_JOB_IMAGE=sha256:${'b'.repeat(64)}; OPS_JOB_COMMAND_JSON='["node","synthetic"]'; OPS_JOB_REFERENCE=operation_${'c'.repeat(32)}; OPS_JOB_COMMAND_HASH=${'d'.repeat(64)};
declare -A OPS_JOB_TARGET=([OPS_DATABASE_SYSTEM_IDENTIFIER]=${system} [OPS_DATABASE_NAME]=fcd_support_test [OPS_DATABASE_SCHEMA]=public [OPS_DATABASE_ROLE_PREFIX]=fcd_synthetic [OPS_SCHEMA_REVISION]=000016);
operations_selection_read() { declare -gA OPS_SELECTION=([STATE_VOLUME]=fcd-support-restored [STATE_VOLUME_ORIGIN]=fcd-support-restore-synthetic [STATE_RESTORE_REF]=restore_${'a'.repeat(32)} [STATE_SYSTEM_IDENTIFIER]=${system}); }
operations_job_override`);
  expect(value.status).toBe(0);
  const parsed = JSON.parse(value.stdout) as { secrets?: Record<string, { file: string }> };
  expect(parsed.secrets?.['bootstrap-database']?.file).toBe(
    '/protected/secrets/restore/restore-database',
  );
});
test.each(['restore', 'restore-bootstrap', 'restore-migrate', 'restore-reconcile', 'promote'])(
  'split %s is a closed durable journal service',
  (service) => {
    expect(run(`operations_job_state_field JOB_SERVICE ${service}`).status).toBe(0);
  },
);
