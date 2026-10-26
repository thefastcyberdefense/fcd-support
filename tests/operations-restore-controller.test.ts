import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const revision = 'a'.repeat(40),
  oldRevision = 'b'.repeat(40);
const app = `sha256:${'c'.repeat(64)}`,
  ops = `sha256:${'d'.repeat(64)}`,
  postgres = `sha256:${'e'.repeat(64)}`;
const oldApp = `sha256:${'f'.repeat(64)}`,
  oldOps = `sha256:${'9'.repeat(64)}`,
  oldPostgres = `sha256:${'8'.repeat(64)}`;
const sourceId = '1'.repeat(64),
  targetId = '2'.repeat(64),
  networkId = '3'.repeat(64);
const sourceSystem = '1111111111111111111',
  targetSystem = '2222222222222222222';
const reference = `restore_${'4'.repeat(32)}`,
  sourceReference = `selection_${'5'.repeat(32)}`;
const backup = `backup_${'6'.repeat(32)}`,
  checkpoint = `checkpoint_${'7'.repeat(32)}`;
const project = 'fcd-support-restore-synthetic',
  volume = 'fcd-support-restore-synthetic-data';
const token = Buffer.from('{"synthetic":true}').toString('base64');
const host = JSON.stringify({
  projectName: project,
  volumeName: volume,
  volumeCreatedAt: '2030-04-01T00:00:00Z',
  networkId,
  postgresImageId: postgres,
  runtimeImageId: app,
});
const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';

async function fixture(
  fault = 'none',
  phase = 'ready',
  current = false,
  nativeState = false,
  afterLeg = 'stream',
) {
  const root = await mkdtemp(
    nativeState
      ? '/var/lib/fcd-support/backups/restore-controller-test-'
      : join(tmpdir(), 'fcd-restore-controller-test-'),
  );
  if (nativeState) {
    await chmod(root, 0o700);
    await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
    await writeFile(join(root, 'deployment-state'), 'SYNTHETIC_SELECTION_POINTER=1\n', {
      mode: 0o600,
    });
  }
  await writeFile(join(root, 'phase'), phase);
  await writeFile(join(root, 'revision'), current ? revision : oldRevision);
  if (current) await writeFile(join(root, 'alias'), 'yes');
  const body = `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
${nativeState ? 'exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"' : ''}
trace() { printf '%s\\n' "$1" >> "$TASK_ROOT/trace"; }
after_job() { [[ -e "$TASK_ROOT/last-job" && "$(cat "$TASK_ROOT/last-job")" == "$TASK_CHANGE_AFTER" ]]; }
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${revision}
 [FCD_SCHEMA_REVISION]=000016 [FCD_POSTGRES_VOLUME]=fcd-support-source-data [FCD_POSTGRES_DB]=fcd_support_test
 [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_test [FCD_RESTORE_PROJECT]=${project}
 [FCD_RESTORE_VOLUME]=${volume} [FCD_BACKUP_VOLUME]=fcd-support-backups [FCD_READY_TIMEOUT_SECONDS]=5 [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000
 [FCD_SUPPORT_IMAGE]=${app} [FCD_OPERATIONS_IMAGE]=${ops} [FCD_POSTGRES_IMAGE]=${postgres})
OPS_BACKUP_REF=${backup}; OPS_CHECKPOINT_REF=${checkpoint}; OPS_REVISION=${revision}
operations_controller_images() { trace images; OPS_CONTROLLER_APPLICATION=${app}; OPS_CONTROLLER_OPERATIONS=${ops}; OPS_CONTROLLER_POSTGRES=${postgres}; }
operations_restore_validate_compose() { trace compose-contract; [[ "$TASK_FAULT" != compose-contract ]]; }
operations_job_state_root() { OPS_JOB_STATE_FILE=$TASK_ROOT/active-job; }
operations_selection_apply() {
 declare -gA OPS_SELECTION=([STATE_REF]=${sourceReference} [STATE_PHASE]="$(cat "$TASK_ROOT/phase")"
 [STATE_VOLUME]=fcd-support-source-data [STATE_SYSTEM_IDENTIFIER]=${sourceSystem} [STATE_DATABASE_NAME]=fcd_support_test
 [STATE_SCHEMA_NAME]=public [STATE_REVISION]="$(cat "$TASK_ROOT/revision")" [STATE_SCHEMA_REVISION]=000016)
 ${nativeState ? 'OPS_SELECTION_FILE_ID="$(stat -c \'%d:%i\' -- "$TASK_ROOT/deployment-state")"; OPS_SELECTION_FILE_SHA256="$(sha256sum -- "$TASK_ROOT/deployment-state")"; OPS_SELECTION_FILE_SHA256="${OPS_SELECTION_FILE_SHA256%% *}"' : ''}
 if [[ "$TASK_FAULT" == source-pointer-after ]] && after_job; then OPS_SELECTION[STATE_REF]=selection_${'a'.repeat(32)}; fi
}
operations_selection_read() { operations_selection_apply; }
operations_retained_read() {
 trace retained; local source_app=${oldApp} source_ops=${oldOps} source_pg=${oldPostgres}
 [[ "$1" != ${revision} ]] || { source_app=${app}; source_ops=${ops}; source_pg=${postgres}; }
 declare -gA OPS_RETAINED=([BUNDLE_APPLICATION_IMAGE]=$source_app [BUNDLE_OPERATIONS_IMAGE]=$source_ops [BUNDLE_POSTGRES_IMAGE]=$source_pg
 [BUNDLE_SCHEMA_REVISION]=000016 [BUNDLE_DATABASE_NAME]=fcd_support_test [BUNDLE_SCHEMA_NAME]=public)
 [[ "$TASK_FAULT" != retained ]] || OPS_RETAINED[BUNDLE_SCHEMA_REVISION]=000015
}
operations_controller_source_storage() { trace "storage:$1"; [[ "$TASK_FAULT" != storage ]]; }
operations_selection_draining() { trace draining; printf draining > "$TASK_ROOT/phase"; }
operations_drain_owned_applications() { trace drain; [[ "$TASK_FAULT" != drain ]] || return 1; printf quiescent > "$TASK_ROOT/phase"; }
operations_converge_postgres() { trace converge; test -s "$TASK_INTENT_FILE" || return 1; [[ "$TASK_FAULT" != converge ]] || return 1; printf ${revision} > "$TASK_ROOT/revision"; touch "$TASK_ROOT/alias"; }
operations_upgrade_database() { trace source-upgrade; [[ "$OPS_DATABASE_SYSTEM_IDENTIFIER" == ${sourceSystem} && ! -e "$TASK_ROOT/network" && ! -e "$TASK_ROOT/postgres" && "$TASK_FAULT" != source-upgrade ]] || return 1; touch "$TASK_ROOT/source-ready"; }
operations_runtime_id() { printf '%s\\n' ${sourceId}; }
operations_drain_boundaries() { trace boundaries; [[ "$TASK_FAULT" != source-boundaries ]]; }
operations_read_database_control_identifier() {
 if [[ "$1" == ${sourceId} ]]; then
  if [[ "$TASK_FAULT" == source-system-after ]] && after_job; then printf 3333333333333333333; return; fi
  printf ${sourceSystem}
 else
  [[ "$1" == ${targetId} ]] || return 1
  if [[ "$TASK_FAULT" == target-system-after ]] && after_job; then printf 3333333333333333333; return; fi
  printf ${targetSystem}
 fi
}
restore_state_begin() { trace intent; [[ "$#" == 13 && "$2" == ${backup} && "$3" == ${checkpoint} && "$4" == ${sourceReference} && "$5" == fcd-support-source-data && "$6" == ${sourceSystem} && "$7" == ${project} && "$8" == ${volume} && "$9" == ${app} && "\${10}" == ${ops} && "\${11}" == ${postgres} && "\${12}" == ${revision} && "\${13}" == 000016 ]] || return 1; [[ "$TASK_FAULT" != intent && ! -e "$TASK_ROOT/intent" ]] || return 1; printf '%s' "$1" > "$TASK_ROOT/intent"; }
restore_state_complete() { trace complete; [[ "$TASK_FAULT" != complete && "$1" == ${reference} && "$2" == '${token}' && "$(cat "$TASK_ROOT/phase")" == quiescent ]] || return 1; touch "$TASK_ROOT/completed"; }
restore_state_read() { test -s "$TASK_ROOT/intent" || return 1; declare -gA OPS_RESTORE_STATE=([RESTORE_PHASE]=intent); }
operations_restore_metadata_encode() { trace encode; [[ "$1" == '${host}' && "$2" == ${targetSystem} ]] || return 1; printf '%s' '${token}'; }
operations_restore_metadata_decode() {
 [[ "$1" == '${token}' ]] || return 1
 printf '%s\\n' TARGET_PROJECT=${project} TARGET_VOLUME=${volume} TARGET_SYSTEM_IDENTIFIER=${targetSystem} TARGET_DATABASE_NAME=fcd_support_test TARGET_SCHEMA=public TARGET_APP_IMAGE=${app} TARGET_PG_IMAGE=${postgres} TARGET_REVISION=${revision} TARGET_SCHEMA_REVISION=000016
 [[ "$TASK_FAULT" != metadata ]] || printf '%s\\n' TARGET_UNTRUSTED=synthetic
}
operations_inspect_restore_host() { trace inspect; test -e "$TASK_ROOT/postgres" || return 1; [[ "$TASK_FAULT" != host-before ]] || return 1; if [[ "$TASK_FAULT" == host-after ]] && after_job; then return 1; fi; [[ "$#" == 0 || "$1" == '${host}' ]] || return 1; printf '%s' '${host}'; }
operations_execute_job() {
 local leg
 case "$1/$2" in
  restore/restore) leg=stream; [[ "$*" == 'restore restore ${reference} ${backup} ${checkpoint} ${token}' ]] || return 1 ;;
  restore-bootstrap/prepare) leg=prepare; [[ "$*" == 'restore-bootstrap prepare ${targetSystem} /run/secrets' ]] || return 1 ;;
  restore-migrate/migrate) leg=migrate; [[ "$*" == 'restore-migrate migrate ${targetSystem}' ]] || return 1 ;;
  restore-bootstrap/converge) leg=converge; [[ "$*" == 'restore-bootstrap converge ${targetSystem} /run/secrets' ]] || return 1 ;;
  restore-reconcile/restore) leg=reconcile; [[ "$*" == 'restore-reconcile restore ${reference} ${backup} ${checkpoint} ${token}' ]] || return 1 ;;
  *) return 1 ;;
 esac
 trace "job:$leg"
 [[ "$OPS_DATABASE_SYSTEM_IDENTIFIER" == ${sourceSystem} && "$OPS_RESTORE_TARGET_SYSTEM_IDENTIFIER" == ${targetSystem} && -e "$TASK_ROOT/source-ready" ]] || return 1
 touch "$TASK_ROOT/job"; printf '%s' "$leg" > "$TASK_ROOT/last-job"
 if [[ "$TASK_FAULT" == job || "$TASK_FAULT" == "job-$leg" ]]; then printf synthetic_uncertain_transport > "$TASK_ROOT/active-job"; return 1; fi
 if [[ "$TASK_FAULT" == acknowledgement || "$TASK_FAULT" == "ack-$leg" ]]; then printf synthetic_unsafe_ack; else printf '%s\\n' '{"status":"completed","processed":1,"reasonCode":"ok"}'; fi
}
operations_compose() { trace target-start; [[ "$*" == 'restore --project-name ${project} up --detach --wait --wait-timeout 5 --no-deps --no-build --pull never postgres' && "\${OPS_CONFIG[FCD_RESTORE_REFERENCE]}" == ${reference} ]] || return 1; [[ "$TASK_FAULT" != start-failed ]] || return 1; touch "$TASK_ROOT/postgres"; [[ "$TASK_FAULT" != start-ack ]]; }
od() { printf '%s' '${'4'.repeat(32)}'; }
operations_docker() {
 local field last="\${!#}" count=0 ref="\${OPS_CONFIG[FCD_RESTORE_REFERENCE]:-${reference}}" created=2030-04-01T00:00:00Z
 case "$1 $2" in
  'image inspect')
   case "$last" in ${oldApp}|${oldOps}|${oldPostgres}) field=${oldRevision};; *) field=${revision};; esac
   [[ "$TASK_FAULT" != source-image ]] || field=${'a'.repeat(39)}b
   printf '%s/%s/linux/amd64\\n' "$last" "$field" ;;
  'ps --all')
   if [[ "$*" == *'volume=${volume}'* ]]; then [[ "$TASK_FAULT" != volume-user ]] || { printf '${'f'.repeat(64)}'; return; }; [[ ! -e "$TASK_ROOT/postgres" ]] || printf '${targetId}';
   elif [[ "$*" == *'com.docker.compose.project=${project}'* ]]; then [[ "$TASK_FAULT" != existing-project ]] || { printf '${targetId}'; return; }; [[ ! -e "$TASK_ROOT/postgres" ]] || printf '${targetId}';
   elif [[ "$*" == *'volume=fcd-support-source-data'* || "$*" == *'com.docker.compose.project=fcd-support'* ]]; then printf '${sourceId}'; if [[ "$TASK_FAULT" == source-actor-after ]] && after_job; then printf '\\n${'a'.repeat(64)}'; fi;
   else return 19; fi ;;
  'volume ls') [[ "$TASK_FAULT" != existing-volume && ! -e "$TASK_ROOT/volume" ]] || printf '${volume}' ;;
  'network ls') [[ "$TASK_FAULT" != existing-network && ! -e "$TASK_ROOT/network" ]] || printf '${networkId}' ;;
  'volume create')
   trace create-volume; test -s "$TASK_INTENT_FILE" || return 1; [[ "$*" == *'com.docker.compose.project=${project}'* && "$*" == *'com.docker.compose.volume=restore-data'* && "$*" == *"fcd-support.restore.ref=$ref"* ]] || return 1
   [[ "$TASK_FAULT" != volume-create-failed ]] || return 1; touch "$TASK_ROOT/volume"; [[ "$TASK_FAULT" != volume-create-ack ]] ;;
  'network create')
   trace create-network; test -s "$TASK_INTENT_FILE" || return 1; [[ "$*" == *'--internal'* && "$*" == *'com.docker.compose.project=${project}'* && "$*" == *'com.docker.compose.network=restore_data'* && "$*" == *"fcd-support.restore.ref=$ref"* ]] || return 1
   [[ "$TASK_FAULT" != network-create-failed ]] || return 1; touch "$TASK_ROOT/network"; [[ "$TASK_FAULT" != network-create-ack ]] ;;
  'volume inspect') test -e "$TASK_ROOT/volume" || return 1; [[ "$TASK_FAULT" != volume-ref ]] || ref=restore_${'f'.repeat(32)}; if [[ "$TASK_FAULT" == volume-after ]] && after_job; then created=2030-04-02T00:00:00Z; fi; printf '%s/%s/local/local/default/%s/restore-data/%s' '${volume}' "$created" '${project}' "$ref" ;;
  'network inspect') test -e "$TASK_ROOT/network" || return 1; [[ "$TASK_FAULT" != network-ref ]] || ref=restore_${'f'.repeat(32)}; [[ ! -e "$TASK_ROOT/postgres" ]] || count=1; printf '%s/%s/%s/bridge/true/%s/restore_data/%s/%s' '${networkId}' '${project}-data' "$created" '${project}' "$ref" "$count" ;;
  'container inspect')
   if [[ "$*" == *'fcd-support-source-postgres'* ]]; then [[ ! -e "$TASK_ROOT/alias" ]] || printf yes;
   elif [[ "$*" == *'fcd-support.restore.ref'* ]]; then [[ "$TASK_FAULT" != actor-ref ]] || ref=restore_${'f'.repeat(32)}; printf '%s' "$ref";
   else printf '%s' synthetic_actor_metadata; fi ;;
  *) trace unexpected-docker; return 19 ;;
 esac
}
${fault === 'bad-reference' ? 'OPS_BACKUP_REF=backup_invalid' : ''}
${fault === 'target-selected' ? 'OPS_CONFIG[FCD_RESTORE_VOLUME]=fcd-support-source-data' : ''}
operations_restore
`;
  const scenario = join(root, 'scenario.sh');
  const scenarioBody = nativeState
    ? body
        .split('\n')
        .filter(
          (line) =>
            ![
              'operations_job_state_root()',
              'restore_state_begin()',
              'restore_state_complete()',
              'restore_state_read()',
            ].some((prefix) => line.startsWith(prefix)),
        )
        .join('\n')
    : body;
  await writeFile(scenario, scenarioBody);
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['--noprofile', '--norc', scenario.replaceAll('\\', '/')],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_ROOT: root.replaceAll('\\', '/'),
        TASK_INTENT_FILE: join(
          root,
          nativeState ? `restore-${reference.slice('restore_'.length)}.intent` : 'intent',
        ).replaceAll('\\', '/'),
        TASK_CHANGE_AFTER: afterLeg,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/operations-restore-controller.sh').replaceAll('\\', '/'),
        TASK_FAULT: fault,
      },
    },
  );
  return {
    root,
    result,
    trace: (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test.each(['ready', 'quiescent'])(
  'restore from managed %s creates intent before outage/isolated target and seals only after fresh proof',
  async (phase) => {
    const f = await fixture('none', phase);
    try {
      expect({ status: f.result.status, stdout: f.result.stdout, stderr: f.result.stderr }).toEqual(
        { status: 0, stdout: `${reference}\n`, stderr: '' },
      );
      expect(f.trace.indexOf('storage:' + oldRevision)).toBeLessThan(f.trace.indexOf('intent'));
      expect(f.trace.indexOf('intent')).toBeLessThan(f.trace.indexOf('converge'));
      expect(f.trace.indexOf('intent')).toBeLessThan(f.trace.indexOf('create-volume'));
      expect(f.trace.indexOf('converge')).toBeLessThan(f.trace.indexOf('create-volume'));
      expect(f.trace.indexOf('create-network')).toBeLessThan(f.trace.indexOf('target-start'));
      expect(f.trace.indexOf('source-upgrade')).toBeGreaterThan(f.trace.indexOf('converge'));
      expect(f.trace.indexOf('source-upgrade')).toBeLessThan(f.trace.indexOf('create-volume'));
      const jobs = f.trace.filter((entry) => entry.startsWith('job:'));
      expect(jobs).toEqual([
        'job:stream',
        'job:prepare',
        'job:migrate',
        'job:converge',
        'job:reconcile',
      ]);
      for (const job of jobs) {
        const index = f.trace.indexOf(job);
        const next = f.trace.findIndex(
          (entry, entryIndex) =>
            entryIndex > index && (entry.startsWith('job:') || entry === 'complete'),
        );
        const previous = f.trace.findLastIndex(
          (entry, entryIndex) =>
            entryIndex < index && (entry.startsWith('job:') || entry === 'encode'),
        );
        expect(f.trace.slice(previous + 1, index)).toContain('inspect');
        expect(f.trace.slice(previous + 1, index)).toContain('boundaries');
        expect(f.trace.slice(index + 1, next)).toContain('inspect');
        expect(f.trace.slice(index + 1, next)).toContain('boundaries');
      }
      expect(f.trace.at(-1)).toBe('complete');
      expect(f.trace.filter((entry) => entry === 'drain')).toHaveLength(phase === 'ready' ? 1 : 0);
      expect(await readFile(join(f.root, 'phase'), 'utf8')).toBe('quiescent');
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test('current pinned PostgreSQL with its verified source alias avoids a replacement', async () => {
  const f = await fixture('none', 'quiescent', true);
  try {
    expect(f.result.status, f.result.stderr).toBe(0);
    expect(f.trace).not.toContain('converge');
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each([
  'bad-reference',
  'compose-contract',
  'target-selected',
  'retained',
  'source-image',
  'storage',
  'existing-project',
  'volume-user',
  'existing-volume',
  'existing-network',
  'intent',
])('pre-outage %s refusal preserves the source and creates no target', async (fault) => {
  const f = await fixture(fault);
  try {
    expect(f.result.status).toBe(1);
    expect(f.result.stdout).toBe('');
    expect(f.result.stderr).toBe('operations_restore_refused\n');
    expect(f.trace).not.toContain('drain');
    expect(f.trace).not.toContain('create-volume');
    expect(f.trace.some((entry) => entry.startsWith('job:'))).toBe(false);
    expect(await readFile(join(f.root, 'phase'), 'utf8')).toBe('ready');
  } finally {
    await f.dispose();
  }
});

test.each(['draining', 'database-changing', 'uncertain', 'starting', 'switching'])(
  'restore refuses source %s without changing it',
  async (phase) => {
    const f = await fixture('none', phase);
    try {
      expect(f.result.status).toBe(1);
      expect(f.trace).not.toContain('intent');
      expect(await readFile(join(f.root, 'phase'), 'utf8')).toBe(phase);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each(['volume-create-ack', 'network-create-ack', 'start-ack'])(
  'lost %s is accepted only after its exact independent postcondition',
  async (fault) => {
    const f = await fixture(fault);
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(f.trace.at(-1)).toBe('complete');
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each([
  'source-boundaries',
  'source-upgrade',
  'converge',
  'volume-create-failed',
  'volume-ref',
  'network-create-failed',
  'network-ref',
  'start-failed',
  'actor-ref',
  'host-before',
  'metadata',
  'job',
  'acknowledgement',
  'job-stream',
  'job-prepare',
  'job-migrate',
  'job-converge',
  'job-reconcile',
  'ack-stream',
  'ack-prepare',
  'ack-migrate',
  'ack-converge',
  'ack-reconcile',
  'host-after',
  'target-system-after',
  'source-system-after',
  'source-pointer-after',
  'source-actor-after',
  'volume-after',
  'complete',
])(
  'post-intent %s failure never restarts or destroys storage or publishes completion',
  async (fault) => {
    const f = await fixture(fault);
    try {
      expect(f.result.status, f.result.stderr).toBe(1);
      expect(f.result.stdout).toBe('');
      expect(f.result.stderr).toBe('operations_restore_refused\n');
      expect(await readFile(join(f.root, 'phase'), 'utf8')).toBe('quiescent');
      expect(await readdir(f.root)).toContain('intent');
      expect(await readdir(f.root)).not.toContain('completed');
      expect(f.trace).not.toContain('unexpected-docker');
      if (fault.startsWith('job-') || fault.startsWith('ack-')) {
        const sequence = ['stream', 'prepare', 'migrate', 'converge', 'reconcile'];
        const failed = fault.slice(fault.indexOf('-') + 1);
        expect(f.trace.filter((entry) => entry.startsWith('job:'))).toEqual(
          sequence.slice(0, sequence.indexOf(failed) + 1).map((leg) => `job:${leg}`),
        );
        const failedAt = f.trace.lastIndexOf(`job:${failed}`);
        expect(f.trace.slice(failedAt + 1)).toContain('inspect');
        expect(f.trace.slice(failedAt + 1)).toContain('boundaries');
      }
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each([
  ['source-system-after', 'prepare'],
  ['target-system-after', 'migrate'],
  ['source-pointer-after', 'converge'],
  ['volume-after', 'reconcile'],
] as const)(
  'fresh proof stops after %s at %s before any next job or completion',
  async (fault, leg) => {
    const f = await fixture(fault, 'ready', false, false, leg);
    try {
      expect(f.result.status, f.result.stderr).toBe(1);
      expect(f.result.stdout).toBe('');
      expect(f.result.stderr).toBe('operations_restore_refused\n');
      expect(f.trace.filter((entry) => entry.startsWith('job:')).at(-1)).toBe(`job:${leg}`);
      expect(f.trace).not.toContain('complete');
      expect(await readFile(join(f.root, 'phase'), 'utf8')).toBe('quiescent');
      expect(await readdir(f.root)).toEqual(
        expect.arrayContaining(['intent', 'volume', 'network', 'postgres']),
      );
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.runIf(native).each(['none', 'job-migrate'])(
  'native filesystem split restore %s retains real intent and seals only complete reconciliation',
  async (fault) => {
    // The transport/source-selection ports are synthetic; intent publication,
    // file protection, held lock and completion CAS use the actual state helpers.
    const f = await fixture(fault, 'ready', false, true);
    try {
      const stem = `restore-${reference.slice('restore_'.length)}`;
      const intent = await readFile(join(f.root, `${stem}.intent`), 'utf8');
      expect(intent).toContain('RESTORE_PHASE=intent\n');
      expect(intent).toContain(`RESTORE_SOURCE_VOLUME=fcd-support-source-data\n`);
      expect(f.result.status, f.result.stderr).toBe(fault === 'none' ? 0 : 1);
      if (fault === 'none') {
        expect(f.result.stdout).toBe(reference + '\n');
        expect(await readFile(join(f.root, `${stem}.record`), 'utf8')).toContain(
          `RESTORE_TARGET_METADATA=${token}\n`,
        );
      } else {
        expect(f.result.stdout).toBe('');
        expect(await readdir(f.root)).not.toContain(`${stem}.record`);
        expect(await readdir(f.root)).toContain('active-job');
      }
      expect(await readdir(f.root)).toEqual(
        expect.arrayContaining(['volume', 'network', 'postgres']),
      );
    } finally {
      await f.dispose();
    }
  },
  30_000,
);
