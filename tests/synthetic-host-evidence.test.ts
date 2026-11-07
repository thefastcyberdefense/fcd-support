import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('health observer preserves the caller regex captures used by the owning lifecycle', () => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '-c',
      `source "$TASK_LIBRARY"
[[ synthetic_before =~ ^(synthetic)_(before)$ ]]
synthetic_host_health_ack_diagnostic '{"status":"completed","processed":10,"reasonCode":"ok"}'
printf 'captures:%s:%s:%s\\n' "$` +
        `{BASH_REMATCH[0]-}" "$` +
        `{BASH_REMATCH[1]-}" "$` +
        `{BASH_REMATCH[2]-}"`,
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    'synthetic_health_ack_diagnostic=completed\ncaptures:synthetic_before:synthetic:before\n',
  );
  expect(result.stderr).toBe('');
});

test.each([
  ['', 'empty'],
  ['log_read_failed', 'log_read_failed'],
  ['{"status":"completed","processed":10,"reasonCode":"ok"}', 'completed'],
  [
    '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}',
    'dependency_unavailable',
  ],
  ['synthetic_private_value\r', 'carriage_return'],
  ['synthetic_private_value\nsynthetic_second_value', 'multiple_lines'],
  ['synthetic_private_value', 'unexpected'],
])('health acknowledgement diagnostics publish only the closed class %s', (value, category) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['-c', 'source "$TASK_LIBRARY"; synthetic_host_health_ack_diagnostic "$TASK_VALUE"'],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
        TASK_VALUE: value,
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`synthetic_health_ack_diagnostic=${category}\n`);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain('synthetic_private_value');
});

test.each([
  'deploy',
  'restore',
  'maintenance',
  'health',
  'health-1',
  'health-10',
  'untrusted_stage_value',
])('synthetic host report emits only closed evidence for %s', async (stage) => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
  try {
    await writeFile(
      join(root, 'active-job'),
      'JOB_SERVICE=restore-reconcile\nJOB_PHASE=uncertain\nJOB_REF=synthetic_private_reference\n',
    );
    await writeFile(
      join(root, 'deployment-state'),
      'STATE_PHASE=quiescent\nSTATE_SYSTEM_IDENTIFIER=synthetic_private_identifier\n',
    );
    const log = join(root, 'diagnostic.log');
    await writeFile(
      log,
      'synthetic_untrusted_diagnostic\noperations_restore_refused\noperations_untrusted_value\n',
    );
    const trace = join(root, 'trace.log');
    await writeFile(
      trace,
      'operations-restore-controller.sh:71:previous=1\nsynthetic_untrusted_value:3:previous=1\n' +
        'runtime_host_diagnostic=samples.healthy\n' +
        'runtime_host_diagnostic=samples.synthetic_private_key\n' +
        'runtime_host_diagnostic=synthetic_private_value\n',
    );
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '-c',
        'source "$TASK_LIBRARY" && synthetic_host_report_failure "$TASK_STAGE" "$TASK_LOG" "$TASK_TRACE" "$TASK_STATE"',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
          TASK_LOG: log.replaceAll('\\', '/'),
          TASK_STAGE: stage,
          TASK_STATE: root.replaceAll('\\', '/'),
          TASK_TRACE: trace.replaceAll('\\', '/'),
        },
      },
    );
    const expectedStage = stage === 'untrusted_stage_value' ? 'unknown' : stage;
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr:
        `synthetic_host_failed=${expectedStage}\n` +
        'synthetic_host_job_service=restore-reconcile\nsynthetic_host_job_phase=uncertain\nsynthetic_host_selection_phase=quiescent\n' +
        'operations_restore_refused\noperations-restore-controller.sh:71:previous=1\n' +
        'runtime_host_diagnostic=samples.healthy\n',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CI trace retains a closed validator refusal through nested stderr suppression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
  try {
    const runner = await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8');
    const entry = /<<'TRACE'\r?\n([\s\S]*?)\r?\nTRACE/u.exec(runner)?.[1];
    if (entry === undefined) throw new Error('synthetic_trace_entry_missing');
    const init = join(root, 'entry.bash');
    const trace = join(root, 'trace.log');
    const log = join(root, 'deployment.log');
    await writeFile(init, entry.replaceAll('\r\n', '\n'));
    await writeFile(log, '');
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '-c',
        `
inspect() {
  local result
  result="$(printf '%s\\n' runtime_host_diagnostic=samples.healthy; exit 1)" || return 1
}
(inspect) >/dev/null 2>&1 || true
synthetic_host_report_failure deploy "$TASK_LOG" "$FCD_SYNTHETIC_TRACE"
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BASH_ENV: init.replaceAll('\\', '/'),
          FCD_SYNTHETIC_TRACE: trace.replaceAll('\\', '/'),
          TASK_LOG: log.replaceAll('\\', '/'),
          FCD_SYNTHETIC_EVIDENCE_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll(
            '\\',
            '/',
          ),
        },
      },
    );
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: '' });
    expect(result.stderr).toContain('runtime_host_diagnostic=samples.healthy\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['promote', 'cleanup'])(
  'a failed %s stage emits only closed evidence outside its log',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
    try {
      await mkdir(join(root, 'logs'));
      const source = (
        await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8')
      ).replaceAll('\r\n', '\n');
      const helpers = source.slice(
        source.indexOf('# Closed trace/state evidence'),
        source.indexOf('stage=preflight'),
      );
      const trap = source
        .split('\n')
        .find((line) => line.startsWith('trap ') && line.endsWith(' ERR'));
      const operation = source
        .split('\n')
        .find((line) =>
          stage === 'promote'
            ? line.startsWith('  synthetic_host_run scripts/promote-restore.sh')
            : /^ {2}(?:\( )?synthetic_host_cleanup(?: |$)/u.test(line),
        );
      if (trap === undefined || operation === undefined) throw new Error('synthetic_stage_missing');
      const script = `set -Eeuo pipefail
source "$TASK_LIBRARY"
ci_mode=true; fixture="$TASK_DIRECTORY"; root="$TASK_DIRECTORY"; stage=${stage}
restore_ref=restore_${'a'.repeat(32)}; revision=${'b'.repeat(40)}
bash() { printf 'operations_promotion_refused\\n' >&2; return 1; }
synthetic_host_cleanup() { printf 'synthetic_sensitive_sentinel\\n' >&2; return 1; }
${helpers}
${trap}
${operation}
printf synthetic_unsafe_advancement
`;
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        ['--noprofile', '--norc', '-c', script],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
            TASK_DIRECTORY: root.replaceAll('\\', '/'),
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`synthetic_host_failed=${stage}\n`);
      if (stage === 'promote') expect(result.stderr).toContain('operations_promotion_refused\n');
      expect(result.stderr).not.toContain('synthetic_sensitive_sentinel');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('prioritizes trusted transport failure frames displaced by common or state frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-host-evidence-test-'));
  try {
    const log = join(root, 'diagnostic.log');
    await writeFile(log, 'operations_promotion_refused\n');
    const trace = join(root, 'trace.log');
    const noise = Array.from(
      { length: 70 },
      (_, i) =>
        `operations-common.sh:${String(i + 1)}:previous=1\noperations-deployment-state.sh:${String(i + 1)}:previous=1\n`,
    ).join('');
    await writeFile(
      trace,
      'operations-job-lifecycle.sh:137:previous=1\n' +
        'synthetic_sentinel_file.sh:1:previous=1\n' +
        'operationRef=operation_0123456789abcdef0123456789abcdef\n' +
        'challenge=0123456789abcdef0123456789abcdef\n' +
        'runtime_host_diagnostic=samples.networks\n'.repeat(80) +
        noise,
    );
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '-c',
        'source "$TASK_LIBRARY" && synthetic_host_report_failure "$TASK_STAGE" "$TASK_LOG" "$TASK_TRACE" "$TASK_STATE"',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
          TASK_LOG: log.replaceAll('\\', '/'),
          TASK_STAGE: 'promote',
          TASK_STATE: root.replaceAll('\\', '/'),
          TASK_TRACE: trace.replaceAll('\\', '/'),
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('synthetic_host_failed=promote\n');
    expect(result.stderr).toContain('operations_promotion_refused\n');
    expect(result.stderr).toContain('operations-job-lifecycle.sh:137:previous=1\n');
    expect(result.stderr).not.toContain('synthetic_sentinel_file');
    expect(result.stderr).not.toContain('operationRef');
    expect(result.stderr).not.toContain('challenge');
    const lines = result.stderr.trim().split('\n');
    expect(
      lines.filter((line) => line === 'runtime_host_diagnostic=samples.networks'),
    ).toHaveLength(1);
    expect(lines.length).toBeLessThanOrEqual(70);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('promotion command observer preserves caller regex captures and exit status', () => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '-c',
      `source "$TASK_LIBRARY"
[[ synthetic_before =~ ^(synthetic)_(before)$ ]]
(exit 42)
synthetic_host_promotion_cmd_diagnostic 0 '{"status":"ok"}' '{"status":"ok"}'
caller_status=$?
printf 'status:%s:captures:%s:%s:%s\\n' "$caller_status" "$` +
        `{BASH_REMATCH[0]-}" "$` +
        `{BASH_REMATCH[1]-}" "$` +
        `{BASH_REMATCH[2]-}"`,
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    'synthetic_promotion_cmd_diagnostic=canonical_success\nstatus:42:captures:synthetic_before:synthetic:before\n',
  );
  expect(result.stderr).toBe('');
});

const productionSampleFields = [
  'capAdd',
  'capDrop',
  'securityOpt',
  'groupAdd',
  'volumesFrom',
  'extraHosts',
  'sysctls',
  'nanoCpus',
  'memory',
  'pidsLimit',
  'stopTimeout',
  'environmentNames',
  'mounts',
  'tmpfs',
  'service',
  'healthy',
  'user',
  'restartPolicy',
  'command',
  'entrypoint',
  'volume',
  'id',
  'systemIdentifier',
  'project',
  'revision',
  'imageId',
  'reference',
  'projectActors',
  'users',
  'name',
  'createdAt',
  'logicalName',
  'networks',
  'hostBinds',
  'stability',
  'target',
];

test.each(productionSampleFields)(
  'synthetic consumer exposes accepted production diagnostic token samples.%s unchanged',
  (field) => {
    const token = `runtime_host_diagnostic=samples.${field}`;
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      ['-c', `source "$TASK_LIBRARY"; synthetic_host_runtime_diagnostic "$TASK_TOKEN"`],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
          TASK_TOKEN: token,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${token}\n`);
    expect(result.stderr).toBe('');
  },
);

test.each([
  ['18446744073709551616', 'huge decimal wraps in 64-bit arithmetic'],
  ['00', 'leading zero double zero'],
  ['01', 'leading zero single digit'],
  ['007', 'leading zero octal style'],
  ['-1', 'negative status -1'],
  ['-42', 'negative status -42'],
  ['', 'empty status'],
  ['invalid', 'nondecimal text'],
  [' 1', 'leading space'],
  ['1 ', 'trailing space'],
  ['1.0', 'decimal point'],
  ['1a', 'alphanumeric'],
  ['256', 'value above 255'],
  ['300', 'value above 255'],
  ['999', 'value above 255'],
])('promotion command observer rejects malformed status %s (%s) as unobserved', (status) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '-c',
      `source "$TASK_LIBRARY"; synthetic_host_promotion_cmd_diagnostic "$TASK_STATUS" '{"status":"ok"}' '{"status":"ok"}'`,
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
        TASK_STATUS: status,
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('synthetic_promotion_cmd_diagnostic=unobserved\n');
  expect(result.stderr).toBe('');
});

test.each([
  ['18446744073709551616', false],
  ['00', false],
  ['01', false],
  ['-1', false],
  ['256', false],
  ['invalid', false],
  ['0', true],
  ['1', true],
  ['42', true],
  ['255', true],
])(
  'runtime diagnostic validator verifies lexical bounds for status=%s (valid=%s)',
  (status, isValid) => {
    const line = `synthetic_promotion_cmd_diagnostic=empty_output:${status}`;
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      ['-c', `source "$TASK_LIBRARY"; synthetic_host_runtime_diagnostic "$TASK_LINE"`],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
          TASK_LINE: line,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(isValid ? `${line}\n` : '');
    expect(result.stderr).toBe('');
  },
);

test.each([
  [0, '{"bound":true}', '{"bound":true}', 'canonical_success', ''],
  [0, '', '{"bound":true}', 'empty_output:0', ''],
  [0, 'unexpected', '{"bound":true}', 'unallowlisted_output:0', ''],
  [0, '{"bound":true}', '', 'unallowlisted_output:0', ''],
  [1, '', '', 'empty_output:1', ''],
  [1, 'SENSITIVE_SECRET_STACK_TRACE_112233', '', 'unallowlisted_output:1', ''],
  [
    1,
    'runtime_host_diagnostic=samples.reference',
    '',
    'allowlisted_diagnostic',
    'runtime_host_diagnostic=samples.reference\n',
  ],
  [
    1,
    'runtime_host_diagnostic=samples.systemIdentifier',
    '',
    'allowlisted_diagnostic',
    'runtime_host_diagnostic=samples.systemIdentifier\n',
  ],
  [125, '', '', 'empty_output:125', ''],
  [127, '', '', 'empty_output:127', ''],
  [125, 'unallowlisted_transport_msg', '', 'unallowlisted_output:125', ''],
  [255, '', '', 'empty_output:255', ''],
])(
  'promotion command observer classifies status=%s result=%s expected=%s neutrally as %s without leaking sentinels',
  (status, resultVal, expectedVal, expectedCategory, expectedDiagnostic) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      [
        '-c',
        `source "$TASK_LIBRARY"; synthetic_host_promotion_cmd_diagnostic "$TASK_STATUS" "$TASK_RESULT" "$TASK_EXPECTED"`,
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
          TASK_STATUS: String(status),
          TASK_RESULT: resultVal,
          TASK_EXPECTED: expectedVal,
        },
      },
    );
    expect(result.status).toBe(0);
    const expectedOut = `synthetic_promotion_cmd_diagnostic=${expectedCategory}\n${expectedDiagnostic}`;
    expect(result.stdout).toBe(expectedOut);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('SENSITIVE_SECRET_STACK_TRACE_112233');
  },
);

test('runtime diagnostic validator preserves historical unavailable_transport tokens', () => {
  const line = 'synthetic_promotion_cmd_diagnostic=unavailable_transport:127';
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['-c', `source "$TASK_LIBRARY"; synthetic_host_runtime_diagnostic "$TASK_LINE"`],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
        TASK_LINE: line,
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${line}\n`);
  expect(result.stderr).toBe('');
});

const inspectionRevision = 'a'.repeat(40);
const inspectionSourceRevision = 'b'.repeat(40);
const inspectionApp = `sha256:${'b'.repeat(64)}`;
const inspectionOperations = `sha256:${'c'.repeat(64)}`;
const inspectionPostgres = `sha256:${'d'.repeat(64)}`;
const inspectionSelection = `selection_${'5'.repeat(32)}`;
const inspectionSourceId = '1'.repeat(64);
const inspectionSourceSystem = '1111111111111111111';
const inspectionTargetSystem = '2222222222222222222';
const inspectionProject = 'fcd-support-restore-synthetic';
const inspectionTargetVolume = 'fcd-support-restore-synthetic-data';
const inspectionBound = JSON.stringify({
  projectName: inspectionProject,
  volumeName: inspectionTargetVolume,
  volumeCreatedAt: '2030-04-01T00:00:00Z',
  networkId: '3'.repeat(64),
  postgresImageId: inspectionPostgres,
  runtimeImageId: inspectionApp,
});

async function runRealHostInspectionTrace(
  scenario:
    | 'success'
    | 'allowlisted-diagnostic'
    | 'empty-output'
    | 'unallowlisted-sentinels'
    | 'transport-failure',
  diagnosticsMode?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'fcd-host-trace-'));
  try {
    const runner = await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8');
    const entry = /<<'TRACE'\r?\n([\s\S]*?)\r?\nTRACE/u.exec(runner)?.[1];
    if (entry === undefined) throw new Error('synthetic_trace_entry_missing');
    const init = join(root, 'entry.bash');
    const trace = join(root, 'trace.log');
    const log = join(root, 'promote.log');
    const testScript = join(root, 'run-inspect.sh');
    await writeFile(init, entry.replaceAll('\r\n', '\n'));
    await writeFile(log, 'operations_promotion_refused\n');

    await writeFile(
      testScript,
      `
source "$TASK_COMMON"
source "$TASK_JOBS"
source "$TASK_HOST"

declare -A OPS_CONFIG=(
  [FCD_RUNTIME_PROJECT]=fcd-support-synthetic
  [FCD_RESTORE_PROJECT]=${inspectionProject}
  [FCD_POSTGRES_VOLUME]=fcd-support-synthetic-source
  [FCD_RESTORE_VOLUME]=${inspectionTargetVolume}
  [FCD_BACKUP_VOLUME]=fcd-support-synthetic-backups
  [FCD_SUPPORT_REVISION]=${inspectionRevision}
  [FCD_SUPPORT_IMAGE]=${inspectionApp}
  [FCD_POSTGRES_IMAGE]=${inspectionPostgres}
  [FCD_OPERATIONS_IMAGE]=${inspectionOperations}
  [FCD_SECRET_ROOT]=/synthetic/secrets
  [FCD_POSTGRES_DB]=fcd_support_test
  [FCD_DATABASE_SCHEMA]=public
  [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic
  [FCD_SCHEMA_REVISION]=000016
  [FCD_STOP_GRACE_MS]=2000
  [FCD_RESTORE_CPUS]=1
  [FCD_RESTORE_MEMORY_MIB]=256
  [FCD_RESTORE_PIDS]=64
  [FCD_RESTORE_TMPFS_MIB]=32
  [FCD_POSTGRES_CPUS]=1
  [FCD_POSTGRES_MEMORY_MIB]=256
  [FCD_POSTGRES_PIDS]=64
  [FCD_POSTGRES_TMPFS_MIB]=16
)

OPS_JOB_SERVICE=promote
OPS_JOB_CONTAINER=${inspectionSourceId}
OPS_JOB_IMAGE=${inspectionOperations}
OPS_JOB_REFERENCE=operation_${'f'.repeat(32)}
OPS_JOB_PROJECT=fcd-support-operation-${'f'.repeat(32)}
OPS_JOB_COMMAND_HASH=${'3'.repeat(64)}
OPS_JOB_COMMAND_JSON='["node","synthetic"]'
OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER=${inspectionTargetSystem}

operations_job_state_read() {
  declare -gA OPS_JOB_STATE=(
    [JOB_PHASE]=started
    [JOB_REF]=$OPS_JOB_REFERENCE
    [JOB_CONTAINER]=$OPS_JOB_CONTAINER
    [JOB_SERVICE]=promote
    [JOB_IMAGE]=$OPS_JOB_IMAGE
    [JOB_COMMAND_SHA256]=$OPS_JOB_COMMAND_HASH
    [JOB_REVISION]=${inspectionRevision}
  )
}
operations_job_state_same_file() { return 0; }
operations_job_assert_container() { return 0; }
operations_selection_same_file() { return 0; }
operations_protected_ancestors() { return 0; }
operations_job_discover() { printf '%s' "$OPS_JOB_CONTAINER"; }
operations_selection_read() {
  declare -gA OPS_SELECTION=(
    [STATE_PHASE]=quiescent
    [STATE_REF]=${inspectionSelection}
    [STATE_VOLUME]=fcd-support-synthetic-source
    [STATE_SYSTEM_IDENTIFIER]=${inspectionSourceSystem}
    [STATE_REVISION]=${inspectionSourceRevision}
    [STATE_DATABASE_NAME]=fcd_support_test
    [STATE_SCHEMA_NAME]=public
    [STATE_VOLUME_ORIGIN]=fcd-support-synthetic
    [STATE_VOLUME_LOGICAL]=postgres-data
    [STATE_VOLUME_CREATED_AT]=2030-01-01T00:00:00Z
  )
  OPS_SELECTION_FILE_ID=synthetic_inode
  OPS_SELECTION_FILE_SHA256=synthetic_hash
}
operations_selection_body() { printf synthetic_protected_selection; }
operations_promotion_host_secrets() { return 0; }
operations_promotion_host_snapshot() { operations_promotion_host_context || return 1; printf '{}'; }

operations_docker() {
  if [[ "$1/$2" == image/inspect ]]; then
    printf '%s\\n' "${inspectionOperations}/${inspectionRevision}/linux/amd64/node"
    return 0
  fi
  if [[ "$*" == *'dist/operations/promotion-host-main.js'* ]]; then
    cat >/dev/null
    case "$TASK_SCENARIO" in
      success)
        printf '%s\\n' "$TASK_BOUND"
        return 0
        ;;
      allowlisted-diagnostic)
        printf 'SENSITIVE_STDERR_ERR\\n' >&2
        printf 'runtime_host_diagnostic=samples.reference\\n'
        return 1
        ;;
      empty-output)
        return 1
        ;;
      unallowlisted-sentinels)
        printf 'SENSITIVE_STDERR_ERR\\n' >&2
        printf 'SENSITIVE_STDOUT_ERR\\n'
        return 1
        ;;
      transport-failure)
        return 127
        ;;
    esac
  fi
  return 125
}

(operations_inspect_promotion_host "$TASK_BOUND" "${inspectionSourceId}" fcd-support-synthetic-source "${inspectionSourceSystem}" "${inspectionSelection}" "${inspectionSourceRevision}" "${inspectionOperations}") >/dev/null 2>&1 || true
synthetic_host_report_failure promote "$TASK_LOG" "$FCD_SYNTHETIC_TRACE"
`,
    );

    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
    const result = spawnSync(bash, ['--noprofile', '--norc', testScript], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        BASH_ENV: init.replaceAll('\\', '/'),
        FCD_SYNTHETIC_TRACE: trace.replaceAll('\\', '/'),
        TASK_LOG: log.replaceAll('\\', '/'),
        TASK_BOUND: inspectionBound,
        TASK_SCENARIO: scenario,
        FCD_RUNTIME_HOST_DIAGNOSTICS: diagnosticsMode,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_JOBS: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
        TASK_HOST: resolve('scripts/operations-promotion-host.sh').replaceAll('\\', '/'),
        FCD_SYNTHETIC_EVIDENCE_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll(
          '\\',
          '/',
        ),
      },
    });

    const traceContent = await readFile(trace, 'utf8').catch(() => '');
    return { result, traceContent };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('real operations_inspect_promotion_host under CI trace: success emits canonical_success', async () => {
  const { result, traceContent } = await runRealHostInspectionTrace('success', 'closed-v1');
  expect(result.status).toBe(0);
  expect(traceContent).toContain('synthetic_promotion_cmd_diagnostic=canonical_success\n');
});

test('real operations_inspect_promotion_host under CI trace: allowlisted diagnostic samples.reference reaches descriptor 3', async () => {
  const { result, traceContent } = await runRealHostInspectionTrace(
    'allowlisted-diagnostic',
    'closed-v1',
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('synthetic_host_failed=promote\n');
  expect(result.stderr).toContain('runtime_host_diagnostic=samples.reference\n');
  expect(traceContent).toContain('synthetic_promotion_cmd_diagnostic=allowlisted_diagnostic\n');
  expect(traceContent).toContain('runtime_host_diagnostic=samples.reference\n');
  expect(result.stderr).not.toContain('SENSITIVE_STDERR_ERR');
  expect(traceContent).not.toContain('SENSITIVE_STDERR_ERR');
});

test('real operations_inspect_promotion_host under CI trace: empty output emits empty_output:1', async () => {
  const { result, traceContent } = await runRealHostInspectionTrace('empty-output', 'closed-v1');
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('synthetic_host_failed=promote\n');
  expect(result.stderr).toContain('synthetic_promotion_cmd_diagnostic=empty_output:1\n');
  expect(traceContent).toContain('synthetic_promotion_cmd_diagnostic=empty_output:1\n');
});

test('real operations_inspect_promotion_host under CI trace: unallowlisted output with sentinels suppresses leaks', async () => {
  const { result, traceContent } = await runRealHostInspectionTrace(
    'unallowlisted-sentinels',
    'closed-v1',
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('synthetic_host_failed=promote\n');
  expect(result.stderr).toContain('synthetic_promotion_cmd_diagnostic=unallowlisted_output:1\n');
  expect(traceContent).toContain('synthetic_promotion_cmd_diagnostic=unallowlisted_output:1\n');
  expect(result.stderr).not.toContain('SENSITIVE_STDERR_ERR');
  expect(result.stderr).not.toContain('SENSITIVE_STDOUT_ERR');
  expect(traceContent).not.toContain('SENSITIVE_STDERR_ERR');
  expect(traceContent).not.toContain('SENSITIVE_STDOUT_ERR');
});

test('real operations_inspect_promotion_host under CI trace: transport failure 127 emits empty_output:127 without asserting unmeasured cause', async () => {
  const { result, traceContent } = await runRealHostInspectionTrace(
    'transport-failure',
    'closed-v1',
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('synthetic_host_failed=promote\n');
  expect(result.stderr).toContain('synthetic_promotion_cmd_diagnostic=empty_output:127\n');
  expect(traceContent).toContain('synthetic_promotion_cmd_diagnostic=empty_output:127\n');
});

test('real operations_inspect_promotion_host under CI trace: closed diagnostics suppressed when closed-v1 inactive', async () => {
  const { result, traceContent } = await runRealHostInspectionTrace('empty-output', undefined);
  expect(result.status).toBe(0);
  expect(traceContent).not.toContain('synthetic_promotion_cmd_diagnostic=');
  expect(traceContent).not.toContain('runtime_host_diagnostic=');
  expect(result.stderr).not.toContain('runtime_host_diagnostic=');
  expect(result.stderr).not.toContain('synthetic_promotion_cmd_diagnostic=');
});
