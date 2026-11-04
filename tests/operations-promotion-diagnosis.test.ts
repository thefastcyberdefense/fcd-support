import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const revision = 'a'.repeat(40);
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
const host = JSON.stringify({
  projectName: project,
  volumeName: targetVolume,
  volumeCreatedAt: '2030-04-01T00:00:00Z',
  networkId: '3'.repeat(64),
  postgresImageId: postgres,
  runtimeImageId: app,
});
const token = Buffer.from('{"synthetic":true}').toString('base64');

async function runScenario(scenario: 'inspection-failure' | 'subsequent-halt-on-uncertainty') {
  const root = await mkdtemp(join(tmpdir(), 'fcd-promotion-diag-'));
  await writeFile(join(root, 'phase'), 'quiescent');
  const script = join(root, 'scenario.sh');
  await writeFile(
    script,
    `
source "$TASK_COMMON"
source "$TASK_LIBRARY" || exit 1
source "$TASK_HOST" || exit 1
trace() { printf '%s\\n' "$1" >> "$TASK_ROOT/trace"; }
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${revision}
 [FCD_SCHEMA_REVISION]=000016 [FCD_POSTGRES_VOLUME]=fcd-support-source-data [FCD_POSTGRES_DB]=fcd_support_test
 [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_test [FCD_RESTORE_PROJECT]=${project}
 [FCD_RESTORE_VOLUME]=${targetVolume} [FCD_BACKUP_VOLUME]=fcd-support-backups [FCD_READY_TIMEOUT_SECONDS]=5
 [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000
 [FCD_SUPPORT_IMAGE]=${app} [FCD_OPERATIONS_IMAGE]=${operations} [FCD_POSTGRES_IMAGE]=${postgres})
OPS_RESTORE_REF=${original}
operations_controller_images() { trace images; OPS_CONTROLLER_APPLICATION=${app}; OPS_CONTROLLER_OPERATIONS=${operations}; OPS_CONTROLLER_POSTGRES=${postgres}; }
operations_job_state_root() { OPS_JOB_STATE_FILE=$TASK_ROOT/active-job; }
operations_selection_apply() {
 declare -gA OPS_SELECTION=([STATE_REF]=${selection} [STATE_PHASE]="$(cat "$TASK_ROOT/phase")"
 [STATE_VOLUME]=fcd-support-source-data [STATE_SYSTEM_IDENTIFIER]=${sourceSystem} [STATE_DATABASE_NAME]=fcd_support_test
 [STATE_SCHEMA_NAME]=public [STATE_REVISION]=${revision} [STATE_SCHEMA_REVISION]=000016
 [STATE_WRITES_POSSIBLE]=yes [STATE_RESTORE_REF]=none)
}
operations_selection_read() { operations_selection_apply; }
operations_selection_uncertain() { trace selection-uncertain; printf uncertain > "$TASK_ROOT/phase"; }
restore_state_read() {
 trace record
 declare -gA OPS_RESTORE_STATE=([RESTORE_VERSION]=1 [RESTORE_PROJECT]=fcd-support [RESTORE_REF]=${original}
 [RESTORE_PHASE]=completed [RESTORE_BACKUP_REF]=${backup} [RESTORE_CHECKPOINT_REF]=${oldCheckpoint}
 [RESTORE_SOURCE_SELECTION_REF]=${selection} [RESTORE_SOURCE_VOLUME]=fcd-support-source-data
 [RESTORE_SOURCE_SYSTEM_IDENTIFIER]=${sourceSystem} [RESTORE_DATABASE_NAME]=fcd_support_test [RESTORE_SCHEMA]=public
 [RESTORE_TARGET_PROJECT]=${project} [RESTORE_TARGET_VOLUME]=${targetVolume} [RESTORE_APP_IMAGE]=${app}
 [RESTORE_OPS_IMAGE]=${operations} [RESTORE_PG_IMAGE]=${postgres} [RESTORE_REVISION]=${revision}
 [RESTORE_SCHEMA_REVISION]=000016 [RESTORE_TARGET_METADATA]=${token})
}
operations_retained_read() { declare -gA OPS_RETAINED=([BUNDLE_APPLICATION_IMAGE]=${app} [BUNDLE_OPERATIONS_IMAGE]=${operations} [BUNDLE_POSTGRES_IMAGE]=${postgres} [BUNDLE_SCHEMA_REVISION]=000016 [BUNDLE_DATABASE_NAME]=fcd_support_test [BUNDLE_SCHEMA_NAME]=public); }
operations_controller_source_storage() { trace source-storage; }
operations_restore_source_quiescent() { trace source-proof; operations_selection_read; [[ "\${OPS_SELECTION[STATE_PHASE]}" == quiescent && "\${OPS_SELECTION[STATE_REF]}" == ${selection} ]]; }
operations_runtime_id() { printf '%s' ${sourceId}; }
operations_restore_source_alias() { [[ "$1" == ${sourceId} ]]; }
operations_restore_target_postgres() { trace target-proof; OPS_RESTORE_TARGET_POSTGRES=${targetId}; OPS_RESTORE_VOLUME_STAMP='${targetVolume}/2030-04-01T00:00:00Z/local/local/default/${project}/restore-data/${original}'; }
operations_read_database_control_identifier() { [[ "$1" != ${targetId} ]] || { printf '%s' ${targetSystem}; return; }; printf '%s' ${sourceSystem}; }
operations_inspect_restore_host() { trace host-proof; printf '%s' '${host}'; }
operations_restore_metadata_encode() { [[ "$1" == '${host}' && "$2" == ${targetSystem} ]] || return 1; printf '%s' '${token}'; }
operations_restore_metadata_matches() { [[ "$1" == '${token}' && "$2" == ${targetSystem} ]]; }
operations_export_promotion_checkpoint() { trace checkpoint; printf '%s' ${freshCheckpoint}; }

# Deterministic simulation of operations_execute_job from operations-job-lifecycle.sh
operations_execute_job() {
  local service="$1"
  operations_job_state_root
  if [[ -e "$OPS_JOB_STATE_FILE" || -L "$OPS_JOB_STATE_FILE" ]]; then
    operations_fail operations_job_pending
  fi
  printf 'JOB_SERVICE=%s\nJOB_PHASE=started\n' "$service" > "$OPS_JOB_STATE_FILE"
  if [[ "$service" == "promote" ]]; then
    if ! operations_promotion_host_check >/dev/null 2>&1; then
      printf 'JOB_SERVICE=%s\nJOB_PHASE=uncertain\n' "$service" > "$OPS_JOB_STATE_FILE"
      operations_fail operations_job_uncertain
    fi
  fi
  printf 'JOB_SERVICE=%s\nJOB_PHASE=completed\n' "$service" > "$OPS_JOB_STATE_FILE"
  printf '{"status":"completed","processed":1,"reasonCode":"ok"}'
}

# Real operations_promotion_host_check calls operations_inspect_promotion_host
operations_inspect_promotion_host() {
  trace inspect-promotion-host
  # Exactly reproduces line 161-167 of operations-promotion-host.sh:
  # The validator container returns non-zero exit status (previous=1)
  operations_promotion_host_diagnostic "synthetic_unhandled_failure"
  operations_fail promotion_host_invalid
}

# Execute promote
if [[ "$TASK_SCENARIO" == "inspection-failure" ]]; then
  operations_promote
elif [[ "$TASK_SCENARIO" == "subsequent-halt-on-uncertainty" ]]; then
  (operations_promote) || true
  trace subsequent-attempt
  # A subsequent execution attempt must halt immediately on existing active-job
  operations_execute_job promote promote "${original}" "restore_${'9'.repeat(32)}" "${backup}" "${freshCheckpoint}" "${token}"
fi
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
      TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
      TASK_LIBRARY: resolve('scripts/operations-promotion-controller.sh').replaceAll('\\', '/'),
      TASK_HOST: resolve('scripts/operations-promotion-host.sh').replaceAll('\\', '/'),
    },
  });

  const trace = (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean);
  const activeJob = await readFile(join(root, 'active-job'), 'utf8').catch(() => '');
  const phase = (await readFile(join(root, 'phase'), 'utf8').catch(() => '')).trim();
  await rm(root, { recursive: true, force: true });

  return { result, trace, activeJob, phase };
}

test('deterministic reproduction: inspection failure triggers uncertain transition and preserves active-job', async () => {
  const { result, trace, activeJob, phase } = await runScenario('inspection-failure');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('operations_promotion_refused');
  expect(trace).toContain('inspect-promotion-host');
  expect(trace).toContain('selection-uncertain');
  expect(phase).toBe('uncertain');
  expect(activeJob).toContain('JOB_SERVICE=promote');
  expect(activeJob).toContain('JOB_PHASE=uncertain');
});

test('deterministic reproduction: preserved uncertain active-job halts subsequent job executions', async () => {
  const { result, trace, activeJob, phase } = await runScenario('subsequent-halt-on-uncertainty');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('operations_job_pending');
  expect(trace).toContain('subsequent-attempt');
  expect(phase).toBe('uncertain');
  expect(activeJob).toContain('JOB_PHASE=uncertain');
});
