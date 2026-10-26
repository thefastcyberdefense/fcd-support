import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const completed = '{"status":"completed","processed":1,"reasonCode":"ok"}';
const unavailable = '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}';
const skipped = '{"status":"skipped","processed":0,"reasonCode":"not_due"}';
const backup = `backup_${'a'.repeat(32)}`;
function shell(body: string, extra: Record<string, string> = {}) {
  return spawnSync(
    bash,
    ['--noprofile', '--norc', '-c', `source "$TASK_COMMON"\nsource "$TASK_LIBRARY"\n${body}`],
    {
      encoding: 'utf8',
      timeout: 6000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
        ...extra,
      },
    },
  );
}

test.each(['health', 'maintenance', 'backup', 'bootstrap'])(
  'job %s selects its role-specific command and stdin policy',
  (service) => {
    const command =
      service === 'health'
        ? 'health'
        : service === 'bootstrap'
          ? 'bootstrap'
          : service === 'backup'
            ? 'prune-backups'
            : 'retention';
    const result = shell(
      `operations_job_command "$TASK_SERVICE" "$TASK_COMMAND"\nprintf '%s\\n' "$OPS_JOB_COMMAND_JSON"`,
      { TASK_SERVICE: service, TASK_COMMAND: command },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      'node',
      service === 'health'
        ? 'dist/operations/health-main.js'
        : service === 'bootstrap'
          ? 'dist/operations/bootstrap-main.js'
          : 'dist/operations-main.js',
      command,
    ]);
    const override = shell(
      `
declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_RUNTIME_PROJECT]=fcd-support-test)
declare -A OPS_JOB_TARGET=([OPS_DATABASE_SYSTEM_IDENTIFIER]=1111111111111111111 [OPS_DATABASE_NAME]=fcd_support_test [OPS_DATABASE_SCHEMA]=public [OPS_DATABASE_ROLE_PREFIX]=fcd_test [OPS_SCHEMA_REVISION]=000016)
OPS_JOB_SERVICE=$TASK_SERVICE; OPS_JOB_IMAGE=sha256:${'b'.repeat(64)}; OPS_JOB_REFERENCE=operation_${'c'.repeat(32)}; OPS_JOB_COMMAND_HASH=${'d'.repeat(64)}
operations_job_command "$TASK_SERVICE" "$TASK_COMMAND"
operations_job_override`,
      { TASK_SERVICE: service, TASK_COMMAND: command },
    );
    expect(override.status, override.stderr).toBe(0);
    const services = (
      JSON.parse(override.stdout) as { services: Record<string, { stdin_open?: boolean }> }
    ).services;
    expect(services[service]?.stdin_open ?? false).toBe(service === 'health');
  },
);

test.each(['', 'a'.repeat(16_385)])(
  'health rejects missing or oversized stdin before any job side effect',
  (input) => {
    const result = shell(
      'OPS_HEALTH_INPUT_JSON=$TASK_INPUT\noperations_job_state_root() { printf unsafe; }\noperations_execute_job health health',
      { TASK_INPUT: input },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('operations_job_arguments_invalid\n');
  },
);

test('health attaches bounded input through stdin while other jobs start without attachment', () => {
  for (const service of ['health', 'maintenance']) {
    const result = shell(
      `OPS_JOB_SERVICE=$TASK_SERVICE; OPS_JOB_CONTAINER=${'b'.repeat(64)}; OPS_HEALTH_INPUT_JSON='{"outageGap":{"startedAt":"2030-01-01T00:00:00.000Z","lastObservedAt":"2030-01-01T00:05:00.000Z"}}'
operations_docker() { printf 'args:%s\\n' "$*" >&2; if [[ "$OPS_JOB_SERVICE" == health ]]; then printf 'input:' >&2; cat >&2; fi; }
operations_job_start`,
      { TASK_SERVICE: service },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')[0]).toBe(
      `args:container start ${service === 'health' ? '--attach --interactive ' : ''}${'b'.repeat(64)}`,
    );
    expect(result.stderr.includes('input:{"outageGap":')).toBe(service === 'health');
  }
});

test.each([
  ['health', 'health', unavailable, true],
  ['maintenance', 'retention', unavailable, false],
  ['backup', 'prune-backups', unavailable, false],
  ['health', 'health', completed, true],
  ['maintenance', 'learning', skipped, true],
  ['backup', 'backup', skipped, true],
  ['migrate', 'migrate', skipped, false],
  ['health', 'health', skipped, false],
  ['backup', 'scheduled-backup', backup, true],
  ['backup', 'pre-migration-backup', backup, true],
  ['health', 'health', backup, false],
  ['maintenance', 'retention', completed, true],
  ['maintenance', 'retention', '{"status":"completed","processed":01,"reasonCode":"ok"}', false],
  ['maintenance', 'learning', '{"status":"skipped","processed":1,"reasonCode":"not_due"}', false],
  ['health', 'health', unavailable + '\n' + completed, false],
  [
    'health',
    'health',
    '{"status":"completed","processed":1,"reasonCode":"dependency_unavailable"}',
    false,
  ],
  ['migrate', 'migrate', completed + 'synthetic_diagnostic', false],
] as const)(
  '%s/%s accepts only its canonical acknowledgement',
  (service, command, acknowledgement, valid) => {
    const result = shell(
      'OPS_JOB_SERVICE=$TASK_SERVICE; OPS_JOB_COMMAND=$TASK_COMMAND\noperations_job_acknowledgement "$TASK_ACK"',
      { TASK_SERVICE: service, TASK_COMMAND: command, TASK_ACK: acknowledgement },
    );
    expect(result.status, result.stderr).toBe(valid ? 0 : 1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  },
);
