import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  old = 'b'.repeat(40);
const app = `sha256:${'c'.repeat(64)}`,
  ops = `sha256:${'d'.repeat(64)}`,
  pg = `sha256:${'e'.repeat(64)}`;
const oldApp = `sha256:${'1'.repeat(64)}`,
  oldOps = `sha256:${'2'.repeat(64)}`,
  oldPg = `sha256:${'3'.repeat(64)}`;
const reference = `restore_${'4'.repeat(32)}`,
  selection = `selection_${'5'.repeat(32)}`;
const backup = `backup_${'6'.repeat(32)}`,
  checkpoint = `checkpoint_${'7'.repeat(32)}`;
const project = 'fcd-support-restore-synthetic',
  volume = `${project}-data`;
const identifier = '7300000000000000000',
  actor = '8'.repeat(64),
  network = '9'.repeat(64),
  proof = 'f'.repeat(64);

async function fixture(fault = 'none') {
  const root = await mkdtemp('/var/lib/fcd-support/backups/empty-restore-host-');
  await chmod(root, 0o700);
  await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
  await mkdir(join(root, 'volume'));
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
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support-synthetic [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_SUPPORT_REVISION]=${old} [FCD_SCHEMA_REVISION]=000016 [FCD_POSTGRES_VOLUME]=fcd-support-original [FCD_RESTORE_PROJECT]=${project} [FCD_RESTORE_VOLUME]=${volume} [FCD_SUPPORT_IMAGE]=${oldApp} [FCD_OPERATIONS_IMAGE]=${oldOps} [FCD_POSTGRES_IMAGE]=${oldPg} [FCD_ADMIN_CPUS]=0.25 [FCD_ADMIN_MEMORY_MIB]=128 [FCD_ADMIN_PIDS]=32)
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
OPS_RESTORE_REF=${reference}; OPS_REVISION=${revision}; OPS_ROOT=/synthetic/repository
operations_controller_images() { OPS_CONTROLLER_APPLICATION=${app}; OPS_CONTROLLER_OPERATIONS=${ops}; OPS_CONTROLLER_POSTGRES=${pg}; }
operations_restore_source_quiescent() {
  [[ "$OPS_RESTORE_SOURCE_REVISION/$OPS_RESTORE_SOURCE_POSTGRES/$OPS_RESTORE_SOURCE_REF/$OPS_RESTORE_SOURCE_SYSTEM" == '${old}/${oldPg}/${selection}/${identifier}' && "$TASK_FAULT" != source ]] || return 1
  if [[ "$TASK_FAULT" == scan-race || "$TASK_FAULT" == operation-late ]]; then
    local count=0; [[ ! -e "$TASK_ROOT/count" ]] || read -r count < "$TASK_ROOT/count"
    count=$((count + 1)); printf '%s\\n' "$count" > "$TASK_ROOT/count"
    if [[ "$TASK_FAULT" == scan-race ]] && (( count >= 3 )); then printf '%s\\n' synthetic_foreign_actor > "$TASK_ROOT/foreign"; fi
    if [[ "$TASK_FAULT" == operation-late ]] && (( count >= 4 )); then printf '%s\\n' synthetic_foreign_actor > "$TASK_ROOT/foreign-operation"; fi
  fi
}
operations_inspect_bootstrap_database() {
  [[ "\${OPS_CONFIG[FCD_SUPPORT_REVISION]}/\${OPS_CONFIG[FCD_SUPPORT_IMAGE]}/\${OPS_CONFIG[FCD_OPERATIONS_IMAGE]}/\${OPS_CONFIG[FCD_POSTGRES_IMAGE]}" == '${old}/${oldApp}/${oldApp}/${oldPg}' && "$TASK_FAULT" != metadata ]] || return 1
}
operations_docker() {
  printf '%s\\n' "$1 $2" >> "$TASK_ROOT/trace"
  case "$1 $2" in
    'ps --all')
      if [[ "$TASK_FAULT" == daemon ]]; then return 1; fi
      case "$*" in
        *"label=com.docker.compose.project=${project}"*) [[ "$TASK_FAULT" != target-actor && ! -e "$TASK_ROOT/foreign" ]] || printf '%s\\n' '${actor}';;
        *"label=fcd-support.restore.ref=${reference}"*) [[ "$TASK_FAULT" != ref-actor ]] || printf '%s\\n' '${actor}';;
        *"label=fcd-support.operation.parent=fcd-support-synthetic"*) [[ "$TASK_FAULT" != operation-actor && ! -e "$TASK_ROOT/foreign-operation" ]] || printf '%s\\n' '${actor}';;
        *"volume=${volume}"*) [[ "$TASK_FAULT" != volume-user ]] || printf '%s\\n' '${actor}';;
        *) printf '%s\\n' '${actor}';;
      esac; return 0 ;;
    'volume ls') [[ "$TASK_FAULT" == absent || "$TASK_FAULT" == absent-bind ]] || printf '%s\\n' '${volume}'; return 0 ;;
    'volume inspect')
      if [[ "$*" == *Mountpoint* ]]; then printf '%s\\n' '/usr/volumes/${volume}/_data'; return; fi
      local stamp=2030-01-01T00:00:00Z label=${reference}
      [[ "$TASK_FAULT" != labels ]] || label=restore_${'0'.repeat(32)}
      if [[ "$TASK_FAULT" == replacement && -e "$TASK_ROOT/probed" ]]; then stamp=2030-01-02T00:00:00Z; fi
      printf '%s\\n' '${volume}/'"$stamp"'/local/local/default/${project}/restore-data/'"$label" ;;
    'network ls') if [[ "$TASK_FAULT" == network || "$TASK_FAULT" == network-foreign ]]; then printf '%s\\n' '${network}'; fi ;;
    'network inspect')
      local internal=true; [[ "$TASK_FAULT" != network-foreign ]] || internal=false
      printf '%s\\n' '${network}/${project}-data/2030-01-01T00:00:00Z/bridge/'"$internal"'/${project}/restore_data/${reference}/0' ;;
    'container inspect')
      if [[ "$TASK_FAULT" == bind || "$TASK_FAULT" == absent-bind ]]; then printf '%s\\n' /usr; fi
      if [[ "$TASK_FAULT" == bind-invalid ]]; then printf '%s\\n' /synthetic-inaccessible; fi ;;
    'image inspect')
      if [[ ( "$TASK_FAULT" == image-volumes && "$*" == *'${app}'* ) || ( "$TASK_FAULT" == source-image-volumes && "$*" == *'${oldApp}'* ) ]]; then printf '%s\\n' has_volumes/node; else printf '%s\\n' none/node; fi ;;
    'info --format') if [[ "$TASK_FAULT" == root-foreign ]]; then printf '%s\\n' /synthetic-inaccessible; else printf '%s\\n' /usr; fi ;;
    'run --rm')
      local -a args=("$@"); local mounts=0 arg
      for arg in "\${args[@]}"; do [[ "$arg" != --mount ]] || (( mounts += 1 )); done
      [[ "$mounts" == 1 && "$*" == *'--network none'* && "$*" == *'--read-only --user 1000:1000'* && "$*" == *'--cap-drop ALL --security-opt no-new-privileges'* && "$*" == *'--pull never'* && "$*" == *'type=bind,src=/usr/volumes/${volume}/_data,dst=/target,readonly'* && "$*" == *'--entrypoint node ${app} dist/operations/empty-restore-target-main.js'* ]] || return 1
      [[ "$TASK_FAULT" != nonempty ]] || return 1
      [[ "$TASK_FAULT" != unknown-proof ]] || { printf '%s\\n' synthetic_private_content; return; }
      printf '%s\\n' yes > "$TASK_ROOT/probed"
      if [[ "$TASK_FAULT" == intent-race ]]; then printf '%s\\n' SYNTHETIC_CHANGED=yes >> "$TASK_ROOT/restore-${'4'.repeat(32)}.intent"; fi
      if [[ "$TASK_FAULT" == pending-race ]]; then printf '%s\\n' synthetic_uncertain > "$TASK_ROOT/active-job"; fi
      printf '%s\\n' '${proof}' ;;
    *) return 91 ;;
  esac
}
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          TASK_ROOT: root,
          TASK_FAULT: fault,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_LIBRARY: resolve('scripts/operations-empty-restore.sh'),
        },
      },
    );
  const setup = `operations_selection_create ${selection} fcd-support-original fcd-support-synthetic postgres-data 2030-01-01T00:00:00Z ${identifier} fcd_support_test ${old} 000016; operations_selection_starting ${selection} ${old} 000016; operations_selection_ready ${selection}; operations_retain_revision ${selection} ${oldApp} ${oldOps} ${oldPg}; operations_selection_quiesce ${selection}; restore_state_begin ${reference} ${backup} ${checkpoint} ${selection} fcd-support-original ${identifier} ${project} ${volume} ${oldApp} ${oldOps} ${oldPg} ${old} 000016`;
  const action = `OPS_CONFIG[FCD_SUPPORT_REVISION]=${revision}; OPS_CONFIG[FCD_SUPPORT_IMAGE]=${app}; OPS_CONFIG[FCD_OPERATIONS_IMAGE]=${ops}; OPS_CONFIG[FCD_POSTGRES_IMAGE]=${pg}; operations_abandon_empty_restore`;
  return {
    root,
    run,
    setup,
    action,
    intent: join(root, `restore-${'4'.repeat(32)}.intent`),
    terminal: join(root, `restore-${'4'.repeat(32)}.abandoned`),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test.runIf(native).each(['none', 'network'])(
  'locked empty-target abandonment seals %s target and preserves source/intent',
  async (fault) => {
    const f = await fixture(fault);
    try {
      const setup = f.run(f.setup);
      expect(setup.status, setup.stderr).toBe(0);
      const intent = await readFile(f.intent, 'utf8'),
        pointer = await readFile(join(f.root, 'deployment-state'), 'utf8');
      const result = f.run(f.action);
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: 'restore_abandoned=true\n',
        stderr: '',
      });
      expect(await readFile(f.intent, 'utf8')).toBe(intent);
      expect(await readFile(join(f.root, 'deployment-state'), 'utf8')).toBe(pointer);
      expect(await readFile(f.terminal, 'utf8')).toContain('RESTORE_PHASE=abandoned\n');
      const trace = await readFile(join(f.root, 'trace'), 'utf8');
      expect(trace).not.toMatch(/(?:create|start|stop|rm|exec|compose) /u);
      expect(trace.split('\n').filter((line) => line === 'run --rm')).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  },
  20000,
);

test
  .runIf(native)
  .each([
    'daemon',
    'absent',
    'target-actor',
    'ref-actor',
    'operation-actor',
    'operation-late',
    'volume-user',
    'labels',
    'network-foreign',
    'image-volumes',
    'source-image-volumes',
    'bind',
    'absent-bind',
    'bind-invalid',
    'root-foreign',
    'nonempty',
    'unknown-proof',
    'source',
    'metadata',
    'replacement',
    'intent-race',
    'pending-race',
    'scan-race',
    'pending',
    'orphan',
    'next',
    'used',
  ])(
  'empty abandonment refuses %s without a terminal record or resource mutation',
  async (fault) => {
    const f = await fixture(fault);
    try {
      const setup = f.run(f.setup);
      expect(setup.status, setup.stderr).toBe(0);
      if (fault === 'pending')
        await writeFile(join(f.root, 'active-job'), 'synthetic_uncertain', { mode: 0o600 });
      if (fault === 'orphan')
        await writeFile(join(f.root, `job-${'8'.repeat(32)}.json`), 'synthetic_uncertain', {
          mode: 0o600,
        });
      if (fault === 'next')
        await writeFile(join(f.root, 'deployment-state.next'), 'synthetic_uncertain', {
          mode: 0o600,
        });
      if (fault === 'used') {
        const found = f.run(`operations_deployment_record_path used ${volume}`);
        expect(found.status).toBe(0);
        await writeFile(found.stdout, 'synthetic_used_target', { mode: 0o600 });
      }
      const result = f.run(f.action);
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 1,
        stdout: '',
        stderr: 'operations_empty_restore_refused\n',
      });
      await expect(stat(f.terminal)).rejects.toMatchObject({ code: 'ENOENT' });
      if (fault === 'pending' || fault === 'orphan' || fault === 'next' || fault === 'used')
        await expect(stat(join(f.root, 'trace'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
  20000,
);

test.each([
  ['../synthetic', revision, '/synthetic/private'],
  [reference, 'latest', '/synthetic/private'],
  [reference, revision, '/synthetic/private', '--unexpected'],
])('private empty-target entry rejects malformed arguments before Docker', (...args) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [resolve('scripts/abandon-empty-restore.sh').replaceAll('\\', '/'), ...args],
    { encoding: 'utf8' },
  );
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 1,
    stdout: '',
    stderr: 'operations_arguments_invalid\n',
  });
});

test('private entry loads the real host handler before invoking common preflight', () => {
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `
source() {
  builtin source "$@" || return
  if [[ "$1" == *operations-common.sh ]]; then
    operations_main() {
      [[ "$1" == abandon-empty-restore && "$2" == "$TASK_REF" && "$3" == "$TASK_REVISION" && "$4" == /synthetic/private ]] || return 1
      declare -F operations_abandon_empty_restore operations_empty_source_proof operations_empty_snapshot >/dev/null || return 1
      printf '%s\\n' empty_entry_wired
    }
  fi
}
set -- "$TASK_REF" "$TASK_REVISION" /synthetic/private
builtin source "$TASK_ENTRY"
`,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_REF: reference,
        TASK_REVISION: revision,
        TASK_ENTRY: resolve('scripts/abandon-empty-restore.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: 'empty_entry_wired\n',
    stderr: '',
  });
});
