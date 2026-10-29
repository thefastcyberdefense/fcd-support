import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('operations_promotion_host_snapshot handles reordered mounts between initial and terminal inspect', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fcd-support-promotion-snapshot-'));
  const counter = join(directory, 'counter');
  writeFileSync(counter, '0');
  const revision = 'a'.repeat(40),
    source = 'd'.repeat(64),
    target = '2'.repeat(64),
    job = 'c'.repeat(64),
    image = `sha256:${'e'.repeat(64)}`,
    selection = `selection_${'1'.repeat(32)}`;
  const mount1 =
    '{"type":"volume","name":"fcd-support-synthetic-target","source":"/synthetic/target","destination":"/var/lib/postgresql","readWrite":true,"propagation":""}';
  const mount2 =
    '{"type":"bind","name":"","source":"/synthetic/secrets/restore/restore-postgres-password","destination":"/run/secrets/restore-postgres-password","readWrite":false,"propagation":"rprivate"}';
  const containerPrefix = `{"id":"${target}","project":"fcd-support-restore-synthetic","service":"postgres","revision":"${revision}","imageId":"${image}","running":true,"paused":false,"restarting":false,"dead":false,"healthy":true,"startedAt":"2030-01-01T00:00:00Z","restartCount":0,"readOnlyRootfs":true,"privileged":false,"init":true,"user":"postgres","networkMode":"fcd-support-restore-synthetic-data","networks":[{"name":"fcd-support-restore-synthetic-data","id":"${'3'.repeat(64)}"}],"hostPortBindings":0,"publishedPortBindings":0,"publishAllPorts":false,"pidMode":"","ipcMode":"private","utsMode":"","capAdd":null,"capDrop":["ALL"],"securityOpt":["no-new-privileges:true"],"devices":0,"deviceRequests":0,"groupAdd":null,"volumesFrom":null,"extraHosts":null,"sysctls":null,"nanoCpus":1000000000,"memory":268435456,"pidsLimit":64,"stopTimeout":2,"restartPolicy":"no","tmpfs":{"/tmp":"rw,noexec,nosuid,nodev,mode=1777,size=16m","/var/run/postgresql":"rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=16m"},"command":["postgres"],"entrypoint":["/usr/local/bin/fcd-postgres-entrypoint.sh"],"environmentNames":["POSTGRES_PASSWORD_FILE"],"executionFlags":[],"mounts":`;
  const target1 = `${containerPrefix}[${mount1},${mount2}]}`;
  const target2 = `${containerPrefix}[${mount2},${mount1}]}`;
  const sourceContainer =
    containerPrefix
      .replace(target, source)
      .replace('fcd-support-restore-synthetic', 'fcd-support-synthetic') + `[${mount1},${mount2}]}`;
  const cmdHash = '3'.repeat(64);
  const netId = '4'.repeat(64);
  const script = `
 source ./scripts/operations-common.sh
 source ./scripts/operations-job-lifecycle.sh
 source ./scripts/operations-promotion-host.sh
 declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-synthetic [FCD_RESTORE_PROJECT]=fcd-support-restore-synthetic [FCD_POSTGRES_VOLUME]=fcd-support-synthetic-source [FCD_RESTORE_VOLUME]=fcd-support-synthetic-target [FCD_BACKUP_VOLUME]=fcd-support-synthetic-backups [FCD_SUPPORT_REVISION]=${revision} [FCD_SUPPORT_IMAGE]=${image} [FCD_POSTGRES_IMAGE]=${image} [FCD_OPERATIONS_IMAGE]=${image} [FCD_SECRET_ROOT]=/synthetic/secrets [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic [FCD_SCHEMA_REVISION]=000016 [FCD_STOP_GRACE_MS]=2000 [FCD_RESTORE_CPUS]=1 [FCD_RESTORE_MEMORY_MIB]=256 [FCD_RESTORE_PIDS]=64 [FCD_RESTORE_TMPFS_MIB]=32 [FCD_POSTGRES_CPUS]=1 [FCD_POSTGRES_MEMORY_MIB]=256 [FCD_POSTGRES_PIDS]=64 [FCD_POSTGRES_TMPFS_MIB]=16)
 OPS_PH_SOURCE=${source}; OPS_PH_VOLUME=fcd-support-synthetic-source; OPS_PH_IMAGE=${image}; OPS_PH_SELECTION=${selection}; OPS_JOB_CONTAINER=${job}
 operations_promotion_host_context() { return 0; }
 operations_job_discover() { printf '%s' "$OPS_JOB_CONTAINER"; }
 operations_read_database_control_identifier() { printf '7300000000000000001'; }
 operations_promotion_host_network() { printf '{"id":"${netId}","name":"%s","driver":"bridge","scope":"local","internal":true,"project":"fcd-support-synthetic","logicalName":"synthetic","members":["${source}"]} ' "$1"; }
 operations_promotion_host_volume() { printf '{"name":"%s","driver":"local","scope":"local","options":null,"project":"fcd-support-synthetic","logicalName":"postgres-data","createdAt":"2030-01-01T00:00:00Z","mountpoint":"/var/lib/docker/volumes/%s/_data","users":["${source}"]}' "$1" "$1"; }
 operations_promotion_host_environment() { printf '{"NODE_ENV":"production"}'; }
 operations_promotion_host_binds() { printf '[]'; }
 operations_docker() {
   if [[ "$1/$2" == ps/--all ]]; then
     if [[ "$*" == *"\${OPS_CONFIG[FCD_RUNTIME_PROJECT]}"* ]]; then printf '%s' "${source}"; return 0; fi
     if [[ "$*" == *"\${OPS_CONFIG[FCD_RESTORE_PROJECT]}"* ]]; then printf '%s' "${target}"; return 0; fi
   fi
   if [[ "$1/$2" == image/inspect ]]; then printf '{"id":"${image}","revision":"${revision}","os":"linux","architecture":"amd64","user":"postgres"}'; return 0; fi
   if [[ "$1/$2" == volume/inspect ]]; then printf '{"name":"\${OPS_CONFIG[FCD_BACKUP_VOLUME]}","driver":"local","scope":"local","options":null,"mountpoint":"/synthetic/backups"}'; return 0; fi
   if [[ "$1/$2" == container/inspect ]]; then
     if [[ "$*" == *reference* ]]; then printf '{"reference":"ref","parent":"par","service":"promote","commandHash":"%s"}' "${cmdHash}"; return 0; fi
     if [[ "$*" == *"${source}"* || "$*" == *"${job}"* ]]; then printf '%s' "$SOURCE_CONTAINER"; return 0; fi
     if [[ "$*" == *"${target}"* ]]; then
       local target_inspect_count
       target_inspect_count=$(cat "$TASK_COUNTER")
       (( target_inspect_count += 1 ))
       printf "%s" "$target_inspect_count" > "$TASK_COUNTER"
       if [[ "$target_inspect_count" -eq 1 ]]; then printf '%s' "$TARGET1"; return 0; fi
       printf '%s' "$TARGET2"; return 0
     fi
   fi
   return 1
 }
 operations_promotion_host_snapshot
 `;
  if (resolve(counter) !== join(resolve(directory), 'counter'))
    throw new Error('fixture_path_invalid');
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash',
      ['--noprofile', '--norc', '-c', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          TASK_COUNTER: counter,
          SOURCE_CONTAINER: sourceContainer,
          TARGET1: target1,
          TARGET2: target2,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      target: { postgres: unknown; terminal: unknown };
    };
    expect(parsed.target.terminal).toBeDefined();
    expect(parsed.target.terminal).not.toEqual(parsed.target.postgres);
    expect(readFileSync(counter, 'utf8')).toBe('2');
  } finally {
    rmSync(counter);
    rmdirSync(directory);
  }
});
