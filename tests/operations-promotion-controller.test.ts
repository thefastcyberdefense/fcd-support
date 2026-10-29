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
const verification = `restore_${'a'.repeat(32)}`;
const selection = `selection_${'5'.repeat(32)}`;
const switched = `selection_${'b'.repeat(32)}`;
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

async function fixture(fault = 'none', initial = 'quiescent') {
  const root = await mkdtemp(join(tmpdir(), 'fcd-promotion-controller-test-'));
  await writeFile(join(root, 'phase'), initial);
  const script = join(root, 'scenario.sh');
  await writeFile(
    script,
    `
source "$TASK_COMMON"
source "$TASK_LIBRARY" || exit 1
trace() { printf '%s\\n' "$1" >> "$TASK_ROOT/trace"; }
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${revision}
 [FCD_SCHEMA_REVISION]=000016 [FCD_POSTGRES_VOLUME]=fcd-support-source-data [FCD_POSTGRES_DB]=fcd_support_test
 [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_test [FCD_RESTORE_PROJECT]=${project}
 [FCD_RESTORE_VOLUME]=${targetVolume} [FCD_BACKUP_VOLUME]=fcd-support-backups [FCD_READY_TIMEOUT_SECONDS]=5
 [FCD_COMMAND_TIMEOUT_SECONDS]=10 [FCD_STOP_GRACE_MS]=1000
 [FCD_SUPPORT_IMAGE]=${app} [FCD_OPERATIONS_IMAGE]=${operations} [FCD_POSTGRES_IMAGE]=${postgres})
OPS_RESTORE_REF=${original}
operations_controller_images() { trace images; OPS_CONTROLLER_APPLICATION=${app}; OPS_CONTROLLER_OPERATIONS=${operations}; OPS_CONTROLLER_POSTGRES=${postgres}; }
operations_job_state_root() { OPS_JOB_STATE_FILE=$TASK_ROOT/active-job; }
operations_selection_apply() {
 declare -gA OPS_SELECTION=([STATE_REF]=${selection} [STATE_PHASE]="$(cat "$TASK_ROOT/phase")"
 [STATE_VOLUME]=fcd-support-source-data [STATE_SYSTEM_IDENTIFIER]=${sourceSystem} [STATE_DATABASE_NAME]=fcd_support_test
 [STATE_SCHEMA_NAME]=public [STATE_REVISION]=${revision} [STATE_SCHEMA_REVISION]=000016
 [STATE_WRITES_POSSIBLE]=yes [STATE_RESTORE_REF]=none)
 if [[ -e "$TASK_ROOT/switched" ]]; then
  OPS_SELECTION[STATE_REF]=${switched}; OPS_SELECTION[STATE_VOLUME]=${targetVolume}; OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]=${targetSystem}
  OPS_SELECTION[STATE_WRITES_POSSIBLE]=no; OPS_SELECTION[STATE_RESTORE_REF]=${verification}
 fi
 if [[ "$TASK_FAULT" == source-pointer ]]; then OPS_SELECTION[STATE_REF]=selection_${'f'.repeat(32)}; fi
 if [[ "$TASK_FAULT" == live-source && -e "$TASK_ROOT/active-job" ]]; then OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]=3333333333333333333; fi
}
operations_selection_read() { operations_selection_apply; }
restore_state_read() {
 trace record
 declare -gA OPS_RESTORE_STATE=([RESTORE_VERSION]=1 [RESTORE_PROJECT]=fcd-support [RESTORE_REF]=${original}
 [RESTORE_PHASE]=completed [RESTORE_BACKUP_REF]=${backup} [RESTORE_CHECKPOINT_REF]=${oldCheckpoint}
 [RESTORE_SOURCE_SELECTION_REF]=${selection} [RESTORE_SOURCE_VOLUME]=fcd-support-source-data
 [RESTORE_SOURCE_SYSTEM_IDENTIFIER]=${sourceSystem} [RESTORE_DATABASE_NAME]=fcd_support_test [RESTORE_SCHEMA]=public
 [RESTORE_TARGET_PROJECT]=${project} [RESTORE_TARGET_VOLUME]=${targetVolume} [RESTORE_APP_IMAGE]=${app}
 [RESTORE_OPS_IMAGE]=${operations} [RESTORE_PG_IMAGE]=${postgres} [RESTORE_REVISION]=${revision}
 [RESTORE_SCHEMA_REVISION]=000016 [RESTORE_TARGET_METADATA]=${token})
 [[ "$TASK_FAULT" != incomplete ]] || OPS_RESTORE_STATE[RESTORE_PHASE]=intent
 [[ "$TASK_FAULT" != record-changed || ! -e "$TASK_ROOT/promoted" ]] || OPS_RESTORE_STATE[RESTORE_BACKUP_REF]=backup_${'f'.repeat(32)}
}
operations_retained_read() { declare -gA OPS_RETAINED=([BUNDLE_APPLICATION_IMAGE]=${app} [BUNDLE_OPERATIONS_IMAGE]=${operations} [BUNDLE_POSTGRES_IMAGE]=${postgres} [BUNDLE_SCHEMA_REVISION]=000016 [BUNDLE_DATABASE_NAME]=fcd_support_test [BUNDLE_SCHEMA_NAME]=public); }
operations_controller_source_storage() { trace source-storage; [[ "$TASK_FAULT" != storage ]]; }
operations_selection_draining() { trace draining; printf draining > "$TASK_ROOT/phase"; }
operations_drain_owned_applications() { trace drain; [[ "$TASK_FAULT" != drain ]] || return 1; printf quiescent > "$TASK_ROOT/phase"; }
operations_restore_source_quiescent() { trace source-proof; operations_selection_read; [[ "\${OPS_SELECTION[STATE_PHASE]}" == quiescent && "\${OPS_SELECTION[STATE_REF]}" == ${selection} && "$TASK_FAULT" != source-proof ]]; }
operations_runtime_id() { printf '%s' ${sourceId}; }
operations_restore_source_alias() { [[ "$1" == ${sourceId} ]]; }
operations_restore_target_postgres() { trace target-proof; [[ "$TASK_FAULT" != target-proof ]] || return 1; OPS_RESTORE_TARGET_POSTGRES=${targetId}; OPS_RESTORE_VOLUME_STAMP='${targetVolume}/2030-04-01T00:00:00Z/local/local/default/${project}/restore-data/${original}'; }
operations_read_database_control_identifier() { [[ "$1" != ${targetId} ]] || { printf '%s' ${targetSystem}; return; }; printf '%s' ${sourceSystem}; }
operations_inspect_restore_host() { trace host-proof; [[ "$TASK_FAULT" != host-after || ! -e "$TASK_ROOT/promoted" ]] || return 1; printf '%s' '${host}'; }
operations_restore_metadata_encode() { [[ "$1" == '${host}' && "$2" == ${targetSystem} ]] || return 1; printf '%s' '${token}'; }
operations_restore_metadata_decode() {
 [[ "$1" == '${token}' ]] || return 1
 printf '%s\\n' TARGET_PROJECT=${project} TARGET_VOLUME=${targetVolume} TARGET_SYSTEM_IDENTIFIER=${targetSystem} TARGET_DATABASE_NAME=fcd_support_test TARGET_SCHEMA=public TARGET_APP_IMAGE=${app} TARGET_PG_IMAGE=${postgres} TARGET_REVISION=${revision} TARGET_SCHEMA_REVISION=000016
 [[ "$TASK_FAULT" != metadata ]] || printf '%s\\n' TARGET_UNKNOWN=synthetic
}
operations_inspect_promotion_host() { trace live-proof; [[ "$#" == 7 && "$1" == '${host}' && "$2" == ${sourceId} && "$3" == fcd-support-source-data && "$4" == ${sourceSystem} && "$5" == ${selection} && "$6" == ${revision} && "$7" == ${postgres} && -e "$TASK_ROOT/active-job" && "$TASK_FAULT" != live-host ]] || return 1; printf '%s' '${host}'; }
operations_execute_job() {
 if [[ "$*" == 'checkpoint export-checkpoint-reference' ]]; then
  trace checkpoint; [[ "$TASK_FAULT" != checkpoint-fail ]] || return 1
  if [[ "$TASK_FAULT" == checkpoint-old ]]; then printf '%s' ${oldCheckpoint}; else printf '%s' ${freshCheckpoint}; fi
  return
 fi
 trace promote-job
 [[ "$*" == 'promote promote ${original} ${verification} ${backup} ${freshCheckpoint} ${token}' && "$OPS_DATABASE_SYSTEM_IDENTIFIER" == ${sourceSystem} && "$OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER" == ${targetSystem} ]] || return 1
 touch "$TASK_ROOT/active-job"
 operations_promotion_host_check || return 1
 trace challenge-one
 operations_promotion_host_check || return 1
 trace challenge-two
 [[ "$TASK_FAULT" != promote-fail ]] || return 1
 rm "$TASK_ROOT/active-job"; touch "$TASK_ROOT/promoted"
 if [[ "$TASK_FAULT" == acknowledgement ]]; then printf synthetic_invalid_ack; else printf '%s' '{"status":"completed","processed":1,"reasonCode":"ok"}'; fi
}
operations_promotion_capture_postgres() { trace "capture:$1"; [[ "$TASK_FAULT" != capture ]]; }
operations_selection_switch() {
 trace switching
 [[ "$*" == '${selection} ${switched} ${targetVolume} ${project} 2030-04-01T00:00:00Z ${targetSystem} fcd_support_test ${verification} ${revision} 000016' && "$TASK_FAULT" != switch-fail ]] || return 1
 touch "$TASK_ROOT/switched"; printf switching > "$TASK_ROOT/phase"
}
operations_promotion_remove_postgres() { trace "remove:$1"; [[ -e "$TASK_ROOT/switched" && "$TASK_FAULT" != stop-fail ]] || return 1; touch "$TASK_ROOT/removed-$1"; }
operations_compose() { trace runtime-postgres; [[ "$*" == 'runtime up --detach --wait --wait-timeout 5 --no-deps --no-build --pull never postgres' && -e "$TASK_ROOT/removed-${sourceId}" && -e "$TASK_ROOT/removed-${targetId}" && "$TASK_FAULT" != create-fail && "$TASK_FAULT" != create-lost-ack ]]; }
operations_inspect_bootstrap_database() { trace bootstrap-proof; [[ "$TASK_FAULT" != bootstrap-proof && "$TASK_FAULT" != create-fail ]]; }
operations_read_database_identity() { trace physical-proof; if [[ "$TASK_FAULT" == physical-proof ]]; then printf 3333333333333333333; else printf '%s' ${targetSystem}; fi; }
operations_start_private_runtime() { trace startup; [[ "$*" == '${app} ${operations} ${postgres}' && "\${OPS_CONFIG[FCD_POSTGRES_VOLUME]}" == ${targetVolume} && "$TASK_FAULT" != startup ]] || return 1; printf ready > "$TASK_ROOT/phase"; }
operations_selection_uncertain() { trace uncertain; printf uncertain > "$TASK_ROOT/phase"; }
operations_docker() { trace unexpected-docker; return 19; }
od() { if [[ ! -e "$TASK_ROOT/random-one" ]]; then touch "$TASK_ROOT/random-one"; printf '%s' '${'a'.repeat(32)}'; else printf '%s' '${'b'.repeat(32)}'; fi; }
${fault === 'reference' ? 'OPS_RESTORE_REF=restore_invalid' : ''}
operations_promote
`,
  );
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['--noprofile', '--norc', script.replaceAll('\\', '/')],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_ROOT: root.replaceAll('\\', '/'),
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/operations-promotion-controller.sh').replaceAll('\\', '/'),
        TASK_FAULT: fault,
      },
    },
  );
  return {
    result,
    trace: (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean),
    phase: await readFile(join(root, 'phase'), 'utf8'),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test.each(['quiescent', 'ready'])(
  'promotion from %s requires fresh live proofs before persisting a switch and replacing only PostgreSQL',
  async (phase) => {
    const f = await fixture('none', phase);
    try {
      expect(
        { status: f.result.status, stdout: f.result.stdout, stderr: f.result.stderr },
        f.trace.join(' -> '),
      ).toEqual({
        status: 0,
        stdout: '',
        stderr: '',
      });
      expect(f.phase).toBe('ready');
      expect(f.trace.indexOf('checkpoint')).toBeLessThan(f.trace.indexOf('promote-job'));
      expect(f.trace.filter((entry) => entry === 'live-proof')).toHaveLength(2);
      expect(f.trace.indexOf('challenge-two')).toBeLessThan(f.trace.indexOf('switching'));
      expect(f.trace.indexOf('switching')).toBeLessThan(f.trace.indexOf(`remove:${sourceId}`));
      expect(f.trace.indexOf(`remove:${targetId}`)).toBeLessThan(
        f.trace.indexOf('runtime-postgres'),
      );
      expect(f.trace.indexOf('physical-proof')).toBeLessThan(f.trace.indexOf('startup'));
      expect(f.trace.filter((entry) => entry === 'drain')).toHaveLength(phase === 'ready' ? 1 : 0);
      expect(f.trace).not.toContain('uncertain');
      expect(f.trace).not.toContain('unexpected-docker');
    } finally {
      await f.dispose();
    }
  },
);

test('lost PostgreSQL create acknowledgement requires a complete fresh postcondition and is never replayed', async () => {
  const f = await fixture('create-lost-ack', 'quiescent');
  try {
    expect({ code: f.result.status, stderr: f.result.stderr, phase: f.phase }).toEqual({
      code: 0,
      stderr: '',
      phase: 'ready',
    });
    expect(f.trace.filter((entry) => entry === 'runtime-postgres')).toHaveLength(1);
    expect(f.trace.indexOf('bootstrap-proof')).toBeLessThan(f.trace.indexOf('startup'));
    expect(f.trace).not.toContain('uncertain');
  } finally {
    await f.dispose();
  }
});

test.each(['reference', 'incomplete', 'metadata', 'source-pointer', 'storage', 'target-proof'])(
  'pre-outage %s refusal leaves the source selection and both PostgreSQL actors untouched',
  async (fault) => {
    const f = await fixture(fault, 'ready');
    try {
      expect(f.result.status).toBe(1);
      expect(f.result.stdout).toBe('');
      expect(f.result.stderr).toBe('operations_promotion_refused\n');
      expect(f.phase).toBe('ready');
      expect(f.trace).not.toContain('drain');
      expect(f.trace).not.toContain('checkpoint');
      expect(f.trace).not.toContain('switching');
      expect(f.trace.some((entry) => entry.startsWith('remove:'))).toBe(false);
    } finally {
      await f.dispose();
    }
  },
);

test.each([
  'drain',
  'checkpoint-fail',
  'checkpoint-old',
  'live-source',
  'live-host',
  'promote-fail',
  'acknowledgement',
  'record-changed',
  'host-after',
  'capture',
  'switch-fail',
  'stop-fail',
  'create-fail',
  'bootstrap-proof',
  'physical-proof',
  'startup',
])(
  'interrupted %s promotion preserves uncertainty without old-volume fallback or job replay',
  async (fault) => {
    const f = await fixture(fault, 'ready');
    try {
      expect(f.result.status).toBe(1);
      expect(f.result.stdout).toBe('');
      expect(f.result.stderr).toBe('operations_promotion_refused\n');
      expect(f.phase).toBe('uncertain');
      expect(f.trace.filter((entry) => entry === 'promote-job').length).toBeLessThanOrEqual(1);
      expect(f.trace.filter((entry) => entry === 'runtime-postgres').length).toBeLessThanOrEqual(1);
      expect(f.trace).not.toContain('unexpected-docker');
      if (
        [
          'drain',
          'checkpoint-fail',
          'checkpoint-old',
          'live-source',
          'live-host',
          'promote-fail',
          'acknowledgement',
          'record-changed',
          'host-after',
          'capture',
          'switch-fail',
        ].includes(fault)
      )
        expect(f.trace.some((entry) => entry.startsWith('remove:'))).toBe(false);
    } finally {
      await f.dispose();
    }
  },
);

async function actorFixture(fault: string) {
  const root = await mkdtemp(join(tmpdir(), 'fcd-promotion-actor-test-'));
  const script = join(root, 'actor.sh');
  await writeFile(
    script,
    `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
trace() { printf '%s\\n' "$1" >> "$TASK_ROOT/trace"; }
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support [FCD_RESTORE_PROJECT]=${project} [FCD_STOP_GRACE_MS]=1000)
declare -A OPS_PROMOTION_ACTORS=() OPS_PROMOTION_STATIC=() OPS_PROMOTION_VOLUMES=() OPS_PROMOTION_PROJECTS=() OPS_PROMOTION_SYSTEMS=() OPS_PROMOTION_IMAGES=() OPS_PROMOTION_NETWORKS=() OPS_PROMOTION_NETWORK_FACTS=() OPS_PROMOTION_VOLUME_FACTS=()
operations_promotion_switched() { [[ "$TASK_FAULT" != context && ! -e "$TASK_ROOT/active-job" ]]; }
operations_read_database_control_identifier() { if [[ "$TASK_FAULT" == physical ]]; then printf 3333333333333333333; else printf '%s' ${targetSystem}; fi; }
operations_docker() {
 local format="\${4:-}" status=running running=true image=${postgres} created=2030-04-01T00:00:00Z
 if [[ -e "$TASK_ROOT/stopped" ]]; then status=exited; running=false; fi
 if [[ -e "$TASK_ROOT/stopped" && "$TASK_FAULT" == volume ]]; then created=2030-04-02T00:00:00Z; fi
 if [[ -e "$TASK_ROOT/stopped" && "$TASK_FAULT" == image ]]; then image=sha256:${'f'.repeat(64)}; fi
 case "$1 $2" in
  'container inspect')
   if [[ "$format" == "$OPERATIONS_DRAIN_ACTOR_FORMAT" ]]; then printf '%s' '${targetId}/${project}/postgres/${revision}/'"$image/$status/$running/false/false/false/postgres/2030-04-01T00:00:00Z";
   elif [[ "$format" == "$OPERATIONS_PROMOTION_STATIC_FORMAT" ]]; then
     h="synthetic_header"
     m1='{"Destination":"/var/lib/postgresql","Driver":"local","Mode":"rw","Name":"data","Propagation":"","RW":true,"Source":"/data","Type":"volume"}'
     m2='{"Destination":"/run/secrets/pg","Driver":"local","Mode":"ro","Name":"","Propagation":"","RW":false,"Source":"/sec","Type":"bind"}'
     if [[ "$TASK_FAULT" == static && -e "$TASK_ROOT/stopped" ]]; then printf '%s\n' synthetic_changed_resource;
     elif [[ "$TASK_FAULT" == mount-order ]]; then
       if [[ -e "$TASK_ROOT/captured" ]]; then
         printf '%s\n%s\n%s\n' "$h" "$m2" "$m1";
       else
         touch "$TASK_ROOT/captured";
         printf '%s\n%s\n%s\n' "$h" "$m1" "$m2";
       fi
     else printf '%s\n%s\n%s\n' "$h" "$m1" "$m2"; fi
   elif [[ "$format" == '{{range $name,$network := .NetworkSettings.Networks}}{{println $name}}{{end}}' ]]; then printf '%s' '${project}-data';
   elif [[ "$format" == '{{.State.ExitCode}}/{{.State.OOMKilled}}' ]]; then printf 0/false;
   else trace unexpected; return 19; fi ;;
  'image inspect') printf '%s' '${postgres}/${revision}/linux/amd64/postgres' ;;
  'volume inspect') printf '%s' '${targetVolume}/'"$created/local/local/default/${project}/restore-data" ;;
  'ps --all')
   [[ ! -e "$TASK_ROOT/removed" ]] || return 0
   if [[ "$TASK_FAULT" == substitute && -e "$TASK_ROOT/stopped" ]]; then printf '%s' '${'e'.repeat(64)}'; else printf '%s' '${targetId}'; fi ;;
  'network inspect')
   if [[ "$format" == "$OPERATIONS_PROMOTION_NETWORK_FORMAT" ]]; then printf '%s' '${'3'.repeat(64)}/${project}-data/bridge/true/${project}/restore_data';
   elif [[ "$format" == '{{range $id,$member := .Containers}}{{println $id}}{{end}}' ]]; then
    if [[ -e "$TASK_ROOT/stopped" ]]; then [[ "$TASK_FAULT" != peer ]] || printf '%s' '${'e'.repeat(64)}'; else printf '%s' '${targetId}'; fi
   else trace unexpected; return 19; fi ;;
  'stop --time')
   trace stop; [[ "$*" == 'stop --time 1 ${targetId}' ]] || return 19
   [[ "$TASK_FAULT" == stop-no-effect ]] || touch "$TASK_ROOT/stopped"
   [[ "$TASK_FAULT" != active-job ]] || touch "$TASK_ROOT/active-job"
   [[ "$TASK_FAULT" != stop-lost-ack ]] ;;
  'rm ${targetId}') trace rm; touch "$TASK_ROOT/removed"; [[ "$TASK_FAULT" != rm-lost-ack ]] ;;
  *) trace unexpected; return 19 ;;
 esac
}
if operations_promotion_capture_postgres ${targetId} ${project} ${targetVolume} ${postgres} ${revision} ${targetSystem} && operations_promotion_remove_postgres ${targetId}; then exit 0; fi
printf '%s\\n' promotion_actor_refused >&2
exit 1
`,
  );
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['--noprofile', '--norc', script.replaceAll('\\', '/')],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_ROOT: root.replaceAll('\\', '/'),
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/operations-promotion-controller.sh').replaceAll('\\', '/'),
        TASK_FAULT: fault,
      },
    },
  );
  return {
    result,
    trace: (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test.each(['none', 'stop-lost-ack', 'rm-lost-ack', 'mount-order'])(
  'exact PostgreSQL actor retirement resolves %s once from fresh postconditions',
  async (fault) => {
    const f = await actorFixture(fault);
    try {
      expect({ status: f.result.status, stdout: f.result.stdout, stderr: f.result.stderr }).toEqual(
        {
          status: 0,
          stdout: '',
          stderr: '',
        },
      );
      expect(f.trace).toEqual(['stop', 'rm']);
    } finally {
      await f.dispose();
    }
  },
);

test.each([
  'context',
  'physical',
  'static',
  'image',
  'volume',
  'peer',
  'substitute',
  'active-job',
  'stop-no-effect',
])('changed %s facts prohibit PostgreSQL removal and volume operations', async (fault) => {
  const f = await actorFixture(fault);
  try {
    expect(f.result.status).toBe(1);
    expect(f.result.stderr).toBe('promotion_actor_refused\n');
    expect(f.trace).not.toContain('rm');
    expect(f.trace).not.toContain('unexpected');
    expect(f.trace.filter((entry) => entry === 'stop').length).toBeLessThanOrEqual(1);
  } finally {
    await f.dispose();
  }
});
