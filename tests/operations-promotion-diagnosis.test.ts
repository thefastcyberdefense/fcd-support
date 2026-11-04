import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const revision = 'a'.repeat(40);
const sourceRevision = 'b'.repeat(40);
const app = `sha256:${'b'.repeat(64)}`;
const operations = `sha256:${'c'.repeat(64)}`;
const postgres = `sha256:${'d'.repeat(64)}`;
const original = `restore_${'4'.repeat(32)}`;
const selection = `selection_${'5'.repeat(32)}`;
const backup = `backup_${'6'.repeat(32)}`;
const oldCheckpoint = `checkpoint_${'7'.repeat(32)}`;
const freshCheckpoint = `checkpoint_${'8'.repeat(32)}`;
const sourceId = '1'.repeat(64);
const targetId = '2'.repeat(64);
const sourceSystem = '1111111111111111111';
const targetSystem = '2222222222222222222';
const project = 'fcd-support-restore-synthetic';
const targetVolume = 'fcd-support-restore-synthetic-data';
const bound = JSON.stringify({
  projectName: project,
  volumeName: targetVolume,
  volumeCreatedAt: '2030-04-01T00:00:00Z',
  networkId: '3'.repeat(64),
  postgresImageId: postgres,
  runtimeImageId: app,
});
const token = Buffer.from('{"synthetic":true}').toString('base64');

const SENSITIVE_STDERR_SENTINEL = 'SENSITIVE_SECRET_TOKEN_LEAK_STDERR_998877';
const SENSITIVE_STDOUT_SENTINEL = 'SENSITIVE_RAW_STACK_TRACE_STDOUT_112233';

async function runHostInspection(
  scenario:
    | 'unhandled-error-with-sentinels'
    | 'closed-diagnostic-allowlisted'
    | 'unallowlisted-stdout-diagnostic',
  diagnosticsMode?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'fcd-inspect-diag-'));
  const script = join(root, 'inspect.sh');
  await writeFile(
    script,
    `
source "$TASK_COMMON"
source "$TASK_JOBS"
source "$TASK_HOST"

declare -A OPS_CONFIG=(
  [FCD_RUNTIME_PROJECT]=fcd-support-synthetic
  [FCD_RESTORE_PROJECT]=${project}
  [FCD_POSTGRES_VOLUME]=fcd-support-synthetic-source
  [FCD_RESTORE_VOLUME]=${targetVolume}
  [FCD_BACKUP_VOLUME]=fcd-support-synthetic-backups
  [FCD_SUPPORT_REVISION]=${revision}
  [FCD_SUPPORT_IMAGE]=${app}
  [FCD_POSTGRES_IMAGE]=${postgres}
  [FCD_OPERATIONS_IMAGE]=${operations}
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
OPS_JOB_CONTAINER=${sourceId}
OPS_JOB_IMAGE=${operations}
OPS_JOB_REFERENCE=operation_${'f'.repeat(32)}
OPS_JOB_PROJECT=fcd-support-operation-${'f'.repeat(32)}
OPS_JOB_COMMAND_HASH=${'3'.repeat(64)}
OPS_JOB_COMMAND_JSON='["node","synthetic"]'
OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER=${targetSystem}

operations_job_state_read() {
  declare -gA OPS_JOB_STATE=(
    [JOB_PHASE]=started
    [JOB_REF]=$OPS_JOB_REFERENCE
    [JOB_CONTAINER]=$OPS_JOB_CONTAINER
    [JOB_SERVICE]=promote
    [JOB_IMAGE]=$OPS_JOB_IMAGE
    [JOB_COMMAND_SHA256]=$OPS_JOB_COMMAND_HASH
    [JOB_REVISION]=${revision}
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
    [STATE_REF]=${selection}
    [STATE_VOLUME]=fcd-support-synthetic-source
    [STATE_SYSTEM_IDENTIFIER]=${sourceSystem}
    [STATE_REVISION]=${sourceRevision}
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
    printf '%s\\n' "${operations}/${revision}/linux/amd64/node"
    return 0
  fi
  if [[ "$*" == *'dist/operations/promotion-host-main.js'* ]]; then
    local payload
    payload="$(cat)"
    printf '%s\\n' "$payload" > "$TASK_ROOT/captured_payload"
    case "$TASK_SCENARIO" in
      unhandled-error-with-sentinels)
        printf '%s\\n' "${SENSITIVE_STDERR_SENTINEL}" >&2
        printf '%s\\n' "${SENSITIVE_STDOUT_SENTINEL}"
        return 1
        ;;
      closed-diagnostic-allowlisted)
        printf '%s\\n' "${SENSITIVE_STDERR_SENTINEL}" >&2
        printf '%s\\n' "runtime_host_diagnostic=samples.memory"
        return 1
        ;;
      unallowlisted-stdout-diagnostic)
        printf '%s\\n' "runtime_host_diagnostic=unallowlisted_sample_field"
        return 1
        ;;
    esac
  fi
  return 125
}

exec 3>"$TASK_ROOT/diagnostics"
operations_inspect_promotion_host '${bound}' ${sourceId} fcd-support-synthetic-source ${sourceSystem} ${selection} ${sourceRevision} ${operations}
`,
  );

  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TASK_ROOT: root.replaceAll('\\', '/'),
      TASK_SCENARIO: scenario,
      FCD_RUNTIME_HOST_DIAGNOSTICS: diagnosticsMode,
      TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
      TASK_JOBS: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
      TASK_HOST: resolve('scripts/operations-promotion-host.sh').replaceAll('\\', '/'),
    },
  });

  const diagnostics = await readFile(join(root, 'diagnostics'), 'utf8').catch(() => '');
  const capturedPayload = await readFile(join(root, 'captured_payload'), 'utf8').catch(() => '');
  await rm(root, { recursive: true, force: true });

  return { result, diagnostics, capturedPayload };
}

test('host inspection wrapper: unhandled validator exit discards raw stderr and unallowlisted stdout without leaking sentinels', async () => {
  const { result, diagnostics, capturedPayload } = await runHostInspection(
    'unhandled-error-with-sentinels',
    'closed-v1',
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('promotion_host_invalid\n');
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(SENSITIVE_STDERR_SENTINEL);
  expect(result.stderr).not.toContain(SENSITIVE_STDOUT_SENTINEL);
  expect(diagnostics).toBe('');
  expect(diagnostics).not.toContain(SENSITIVE_STDERR_SENTINEL);
  expect(diagnostics).not.toContain(SENSITIVE_STDOUT_SENTINEL);
  expect(capturedPayload).toContain('"runtimeProject":"fcd-support-synthetic"');
});

test('host inspection wrapper: allowlisted closed diagnostic is delivered to descriptor 3 under closed-v1 without leaking stderr sentinels', async () => {
  const { result, diagnostics } = await runHostInspection(
    'closed-diagnostic-allowlisted',
    'closed-v1',
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('promotion_host_invalid\n');
  expect(result.stdout).toBe('');
  expect(diagnostics).toBe('runtime_host_diagnostic=samples.memory\n');
  expect(diagnostics).not.toContain(SENSITIVE_STDERR_SENTINEL);
});

test('host inspection wrapper: closed diagnostics are suppressed when closed-v1 is inactive', async () => {
  const { result, diagnostics } = await runHostInspection(
    'closed-diagnostic-allowlisted',
    undefined,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('promotion_host_invalid\n');
  expect(result.stdout).toBe('');
  expect(diagnostics).toBe('');
});

test('host inspection wrapper: unallowlisted diagnostic string on stdout is dropped by closed filter', async () => {
  const { result, diagnostics } = await runHostInspection(
    'unallowlisted-stdout-diagnostic',
    'closed-v1',
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('promotion_host_invalid\n');
  expect(result.stdout).toBe('');
  expect(diagnostics).toBe('');
});

test('controller simulation: unhandled job execution failure triggers EXIT trap operations_promotion_uncertain and updates selection state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-ctrl-sim-'));
  await writeFile(join(root, 'phase'), 'quiescent');
  const script = join(root, 'controller.sh');
  await writeFile(
    script,
    `
source "$TASK_COMMON"
source "$TASK_CONTROLLER" || exit 1
source "$TASK_HOST" || exit 1

declare -A OPS_CONFIG=(
  [FCD_STATE_ROOT]="$TASK_ROOT"
  [FCD_RUNTIME_PROJECT]=fcd-support
  [FCD_SUPPORT_REVISION]=${revision}
  [FCD_SCHEMA_REVISION]=000016
  [FCD_POSTGRES_VOLUME]=fcd-support-source-data
  [FCD_POSTGRES_DB]=fcd_support_test
  [FCD_DATABASE_SCHEMA]=public
  [FCD_DATABASE_ROLE_PREFIX]=fcd_test
  [FCD_RESTORE_PROJECT]=${project}
  [FCD_RESTORE_VOLUME]=${targetVolume}
  [FCD_BACKUP_VOLUME]=fcd-support-backups
  [FCD_READY_TIMEOUT_SECONDS]=5
  [FCD_COMMAND_TIMEOUT_SECONDS]=5
  [FCD_STOP_GRACE_MS]=1000
  [FCD_SUPPORT_IMAGE]=${app}
  [FCD_OPERATIONS_IMAGE]=${operations}
  [FCD_POSTGRES_IMAGE]=${postgres}
)
OPS_RESTORE_REF=${original}
operations_controller_images() { OPS_CONTROLLER_APPLICATION=${app}; OPS_CONTROLLER_OPERATIONS=${operations}; OPS_CONTROLLER_POSTGRES=${postgres}; }
operations_job_state_root() { OPS_JOB_STATE_FILE=$TASK_ROOT/active-job; }
operations_selection_apply() {
  declare -gA OPS_SELECTION=(
    [STATE_REF]=${selection}
    [STATE_PHASE]="$(cat "$TASK_ROOT/phase")"
    [STATE_VOLUME]=fcd-support-source-data
    [STATE_SYSTEM_IDENTIFIER]=${sourceSystem}
    [STATE_DATABASE_NAME]=fcd_support_test
    [STATE_SCHEMA_NAME]=public
    [STATE_REVISION]=${revision}
    [STATE_SCHEMA_REVISION]=000016
    [STATE_WRITES_POSSIBLE]=yes
    [STATE_RESTORE_REF]=none
  )
}
operations_selection_read() { operations_selection_apply; }
operations_selection_uncertain() { printf uncertain > "$TASK_ROOT/phase"; }
restore_state_read() {
  declare -gA OPS_RESTORE_STATE=(
    [RESTORE_VERSION]=1
    [RESTORE_PROJECT]=fcd-support
    [RESTORE_REF]=${original}
    [RESTORE_PHASE]=completed
    [RESTORE_BACKUP_REF]=${backup}
    [RESTORE_CHECKPOINT_REF]=${oldCheckpoint}
    [RESTORE_SOURCE_SELECTION_REF]=${selection}
    [RESTORE_SOURCE_VOLUME]=fcd-support-source-data
    [RESTORE_SOURCE_SYSTEM_IDENTIFIER]=${sourceSystem}
    [RESTORE_DATABASE_NAME]=fcd_support_test
    [RESTORE_SCHEMA]=public
    [RESTORE_TARGET_PROJECT]=${project}
    [RESTORE_TARGET_VOLUME]=${targetVolume}
    [RESTORE_APP_IMAGE]=${app}
    [RESTORE_OPS_IMAGE]=${operations}
    [RESTORE_PG_IMAGE]=${postgres}
    [RESTORE_REVISION]=${revision}
    [RESTORE_SCHEMA_REVISION]=000016
    [RESTORE_TARGET_METADATA]=${token}
  )
}
operations_retained_read() {
  declare -gA OPS_RETAINED=(
    [BUNDLE_APPLICATION_IMAGE]=${app}
    [BUNDLE_OPERATIONS_IMAGE]=${operations}
    [BUNDLE_POSTGRES_IMAGE]=${postgres}
    [BUNDLE_SCHEMA_REVISION]=000016
    [BUNDLE_DATABASE_NAME]=fcd_support_test
    [BUNDLE_SCHEMA_NAME]=public
  )
}
operations_controller_source_storage() { return 0; }
operations_restore_source_quiescent() {
  operations_selection_read
  [[ "\${OPS_SELECTION[STATE_PHASE]}" == quiescent && "\${OPS_SELECTION[STATE_REF]}" == ${selection} ]]
}
operations_runtime_id() { printf '%s' ${sourceId}; }
operations_restore_source_alias() { [[ "$1" == ${sourceId} ]]; }
operations_restore_target_postgres() {
  OPS_RESTORE_TARGET_POSTGRES=${targetId}
  OPS_RESTORE_VOLUME_STAMP='${targetVolume}/2030-04-01T00:00:00Z/local/local/default/${project}/restore-data/${original}'
}
operations_read_database_control_identifier() {
  [[ "$1" != ${targetId} ]] || { printf '%s' ${targetSystem}; return; }
  printf '%s' ${sourceSystem}
}
operations_inspect_restore_host() { printf '%s' '${bound}'; }
operations_restore_metadata_encode() {
  [[ "$1" == '${bound}' && "$2" == ${targetSystem} ]] || return 1
  printf '%s' '${token}'
}
operations_restore_metadata_matches() { [[ "$1" == '${token}' && "$2" == ${targetSystem} ]]; }
operations_export_promotion_checkpoint() { printf '%s' ${freshCheckpoint}; }

# Simulate failing job execution to test controller containment
operations_execute_job() {
  return 1
}

operations_promote
`,
  );

  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TASK_ROOT: root.replaceAll('\\', '/'),
      TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
      TASK_CONTROLLER: resolve('scripts/operations-promotion-controller.sh').replaceAll('\\', '/'),
      TASK_HOST: resolve('scripts/operations-promotion-host.sh').replaceAll('\\', '/'),
    },
  });

  const phase = (await readFile(join(root, 'phase'), 'utf8').catch(() => '')).trim();
  await rm(root, { recursive: true, force: true });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('operations_promotion_refused');
  expect(phase).toBe('uncertain');
});

test('lifecycle containment: real operations_execute_job refuses execution when active-job is preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-lifecycle-refusal-'));
  // Populate active-job with an uncertain job record
  await writeFile(
    join(root, 'active-job'),
    `JOB_VERSION=1
JOB_REF=operation_${'e'.repeat(32)}
JOB_PARENT=fcd-support-runtime
JOB_SERVICE=promote
JOB_REVISION=${revision}
JOB_IMAGE=${operations}
JOB_COMMAND_SHA256=${'9'.repeat(64)}
JOB_CONTAINER=${sourceId}
JOB_PHASE=uncertain
`,
  );

  const script = join(root, 'lifecycle.sh');
  await writeFile(
    script,
    `
source "$TASK_COMMON"
source "$TASK_JOBS"

declare -A OPS_CONFIG=(
  [FCD_STATE_ROOT]="$TASK_ROOT"
  [FCD_COMMAND_TIMEOUT_SECONDS]=5
  [FCD_RUNTIME_PROJECT]=fcd-support-runtime
  [FCD_SUPPORT_REVISION]=${revision}
  [FCD_POSTGRES_DB]=fcd_support_test
  [FCD_DATABASE_SCHEMA]=public
  [FCD_DATABASE_ROLE_PREFIX]=fcd_test
  [FCD_SCHEMA_REVISION]=000016
)

# Bind state root to the test temporary directory
operations_job_state_root() {
  OPS_JOB_STATE_FILE="$TASK_ROOT/active-job"
}
operations_promotion_host_check() { return 0; }

# The real operations_execute_job checks for active-job at line 211
operations_execute_job promote promote "${original}" "restore_${'9'.repeat(32)}" "${backup}" "${freshCheckpoint}" "${token}"
`,
  );

  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TASK_ROOT: root.replaceAll('\\', '/'),
      TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
      TASK_JOBS: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
    },
  });

  const activeJobAfter = await readFile(join(root, 'active-job'), 'utf8');
  await rm(root, { recursive: true, force: true });

  expect(result.status).toBe(1);
  expect(result.stderr).toBe('operations_job_pending\n');
  expect(activeJobAfter).toContain('JOB_PHASE=uncertain');
});
