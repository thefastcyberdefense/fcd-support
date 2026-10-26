import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

function run(fault: string) {
  const revision = 'a'.repeat(40),
    sourceRevision = 'b'.repeat(40),
    job = 'c'.repeat(64),
    source = 'd'.repeat(64),
    image = `sha256:${'e'.repeat(64)}`,
    reference = `operation_${'f'.repeat(32)}`,
    selection = `selection_${'1'.repeat(32)}`;
  const bound = JSON.stringify({
    projectName: 'fcd-support-restore-synthetic',
    volumeName: 'fcd-support-synthetic-target',
    volumeCreatedAt: '2030-01-01T00:00:00Z',
    networkId: '2'.repeat(64),
    postgresImageId: image,
    runtimeImageId: image,
  });
  const script = `
 source ./scripts/operations-common.sh
 source ./scripts/operations-job-lifecycle.sh
 source ./scripts/operations-promotion-host.sh
 declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-synthetic [FCD_RESTORE_PROJECT]=fcd-support-restore-synthetic [FCD_POSTGRES_VOLUME]=fcd-support-synthetic-source [FCD_RESTORE_VOLUME]=fcd-support-synthetic-target [FCD_BACKUP_VOLUME]=fcd-support-synthetic-backups [FCD_SUPPORT_REVISION]=${revision} [FCD_SUPPORT_IMAGE]=${image} [FCD_POSTGRES_IMAGE]=${image} [FCD_OPERATIONS_IMAGE]=${image} [FCD_SECRET_ROOT]=/synthetic/secrets [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic [FCD_SCHEMA_REVISION]=000016 [FCD_STOP_GRACE_MS]=2000 [FCD_RESTORE_CPUS]=1 [FCD_RESTORE_MEMORY_MIB]=256 [FCD_RESTORE_PIDS]=64 [FCD_RESTORE_TMPFS_MIB]=32 [FCD_POSTGRES_CPUS]=1 [FCD_POSTGRES_MEMORY_MIB]=256 [FCD_POSTGRES_PIDS]=64 [FCD_POSTGRES_TMPFS_MIB]=16)
 OPS_JOB_SERVICE=promote; OPS_JOB_CONTAINER=${job}; OPS_JOB_IMAGE=${image}; OPS_JOB_REFERENCE=${reference}; OPS_JOB_PROJECT=fcd-support-operation-${'f'.repeat(32)}; OPS_JOB_COMMAND_HASH=${'3'.repeat(64)}; OPS_JOB_COMMAND_JSON='["node","synthetic"]'; OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER=7300000000000000002
 operations_job_state_read() { declare -gA OPS_JOB_STATE=([JOB_PHASE]=started [JOB_REF]=$OPS_JOB_REFERENCE [JOB_CONTAINER]=$OPS_JOB_CONTAINER [JOB_SERVICE]=promote [JOB_IMAGE]=$OPS_JOB_IMAGE [JOB_COMMAND_SHA256]=$OPS_JOB_COMMAND_HASH [JOB_REVISION]=${revision}); [[ "$TASK_FAULT" != journal-unstarted ]] || OPS_JOB_STATE[JOB_PHASE]=created; }
 operations_job_state_same_file() { [[ "$TASK_FAULT" != journal-replaced ]]; }
 operations_job_assert_container() { [[ "$1" == running && "$TASK_FAULT" != job-changed ]]; }
 operations_job_discover() { printf '%s' "$OPS_JOB_CONTAINER"; }
 operations_selection_read() { declare -gA OPS_SELECTION=([STATE_PHASE]=quiescent [STATE_REF]=${selection} [STATE_VOLUME]=fcd-support-synthetic-source [STATE_SYSTEM_IDENTIFIER]=7300000000000000001 [STATE_REVISION]=${sourceRevision} [STATE_DATABASE_NAME]=fcd_support_test [STATE_SCHEMA_NAME]=public [STATE_VOLUME_ORIGIN]=fcd-support-synthetic [STATE_VOLUME_LOGICAL]=postgres-data [STATE_VOLUME_CREATED_AT]=2030-01-01T00:00:00Z); OPS_SELECTION_FILE_ID=synthetic_inode; OPS_SELECTION_FILE_SHA256=synthetic_hash; [[ "$TASK_FAULT" != selection-changed ]] || OPS_SELECTION[STATE_REF]=selection_${'9'.repeat(32)}; [[ "$TASK_FAULT" != source-writes ]] || OPS_SELECTION[STATE_PHASE]=ready; }
 operations_selection_body() { printf synthetic_protected_selection; }
 operations_promotion_host_secrets() { [[ "$TASK_FAULT" != secret-path ]]; }
 operations_promotion_host_snapshot() { operations_promotion_host_context || return 1; [[ "$TASK_FAULT" != sample-refused ]] || return 1; printf '{}'; }
 operations_docker() {
   if [[ "$1/$2" == image/inspect ]]; then printf '%s' '${image}/${revision}/linux/amd64/node'; return; fi
   [[ "$*" == *'--network none --read-only --user 1000:1000'* && "$*" == *'--cap-drop ALL --security-opt no-new-privileges'* && "$*" == *'--entrypoint node ${image} dist/operations/promotion-host-main.js' && "$*" != *'--volume'* && "$*" != *'--mount'* ]] || return 125
   local payload; payload=$(cat); [[ "$payload" == *'"before":{},"after":{}'* ]] || return 125
   [[ "$TASK_FAULT" != validator-refused ]] || { printf synthetic_untrusted_output; return 125; }
   [[ "$TASK_FAULT" != validator-substitute ]] || { printf '{}'; return; }
   printf '%s' '${bound}'
 }
 operations_inspect_promotion_host '${bound}' ${source} fcd-support-synthetic-source 7300000000000000001 ${selection} ${sourceRevision} ${image}
 `;
  return spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash',
    ['--noprofile', '--norc', '-c', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, TASK_FAULT: fault },
    },
  );
}

test('live host port delegates only to a pinned networkless bounded validator and returns the same canonical identity', () => {
  const result = run('none');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({
    projectName: 'fcd-support-restore-synthetic',
  });
  expect(result.stderr).toBe('');
});
test.each([
  'journal-unstarted',
  'journal-replaced',
  'job-changed',
  'selection-changed',
  'source-writes',
  'secret-path',
  'sample-refused',
  'validator-refused',
  'validator-substitute',
])('live host port refuses %s without returning target authorization', (fault) => {
  const result = run(fault);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('promotion_host_invalid\n');
});
