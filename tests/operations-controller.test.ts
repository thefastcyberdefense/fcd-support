import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const revision = 'a'.repeat(40),
  old = 'b'.repeat(40),
  image = `sha256:${'c'.repeat(64)}`,
  oldImage = `sha256:${'d'.repeat(64)}`;
test.each([
  'fresh',
  'managed',
  'admission',
  'quiescent',
  'uncertain',
  'storage-refused',
  'startup-refused',
  'verify',
  'verify-refused',
  'rollback',
  'rollback-incompatible',
  'rollback-uncertain',
  'rollback-draining',
  'rollback-quiescent',
  'rollback-switching',
])('public controller sequences %s through the verified private primitives', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-controller-test-'));
  const slash = root.replaceAll('\\', '/');
  await writeFile(
    join(root, 'phase'),
    kind.startsWith('rollback-') && kind !== 'rollback-incompatible'
      ? kind.slice('rollback-'.length)
      : kind === 'quiescent'
        ? 'quiescent'
        : kind === 'uncertain'
          ? 'uncertain'
          : 'ready',
  );
  try {
    const script = `
source "$TASK_COMMON"
source "$TASK_CONTROLLER"
trace() { printf '%s\\n' "$1" >> "$TASK_ROOT/trace"; }
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000016 [FCD_POSTGRES_VOLUME]=fcd-support-data [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support [FCD_SUPPORT_IMAGE]=${image} [FCD_OPERATIONS_IMAGE]=${image} [FCD_POSTGRES_IMAGE]=${image} [FCD_ADMISSION_REVISION]=${old} [FCD_ADMISSION_IMAGE]=${oldImage} [FCD_ADMISSION_POSTGRES_IMAGE]=${oldImage})
OPS_REVISION=${revision}
operations_controller_images() { OPS_CONTROLLER_APPLICATION=${image}; OPS_CONTROLLER_OPERATIONS=${image}; OPS_CONTROLLER_POSTGRES=${image}; }
operations_selection_read() { declare -gA OPS_SELECTION=([STATE_REF]=selection_${'f'.repeat(32)} [STATE_PHASE]="$(cat "$TASK_ROOT/phase")" [STATE_VOLUME]=fcd-support-data [STATE_REVISION]=${kind === 'quiescent' || kind.startsWith('verify') ? revision : old} [STATE_SCHEMA_REVISION]=000016 [STATE_SYSTEM_IDENTIFIER]=1111111111111111111); }
operations_selection_apply() { operations_selection_read; }
operations_retained_read() { local selected=${oldImage}; [[ "$1" != '${revision}' ]] || selected=${image}; declare -gA OPS_RETAINED=([BUNDLE_APPLICATION_IMAGE]="$selected" [BUNDLE_POSTGRES_IMAGE]="$selected" [BUNDLE_OPERATIONS_IMAGE]="$selected" [BUNDLE_SCHEMA_REVISION]=${kind === 'rollback-incompatible' ? '000015' : '000016'}); trace retained; }
operations_controller_source_storage() { trace storage; [[ '${kind}' != storage-refused ]]; }
operations_selection_draining() { trace draining; printf draining > "$TASK_ROOT/phase"; }
operations_adopt_admission() { trace adopt; printf draining > "$TASK_ROOT/phase"; }
operations_drain_owned_applications() { trace drain; printf quiescent > "$TASK_ROOT/phase"; }
operations_converge_postgres() { trace postgres; }
operations_initialize_private_database() { trace initial; touch "$TASK_ROOT/deployment-state"; }
operations_start_private_runtime() { trace startup; [[ '${kind}' != startup-refused ]]; }
operations_job_state_root() { OPS_JOB_STATE_FILE="$TASK_ROOT/active-job"; }
operations_job_state_pending() { return 1; }
operations_inspect_runtime_host() { trace verify; [[ '${kind}' != verify-refused ]]; }
operations_read_database_identity() { printf 1111111111111111111; }
operations_docker() { if [[ "$1" == ps ]]; then [[ '${kind}' != admission ]] || printf '${'e'.repeat(64)}'; else return 19; fi; }
${!['fresh', 'admission'].includes(kind) ? 'touch "$TASK_ROOT/deployment-state";' : ''}
${kind.startsWith('verify') ? 'operations_verify' : kind.startsWith('rollback') ? 'operations_rollback' : 'operations_deploy'}
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
          TASK_ROOT: slash,
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_CONTROLLER: resolve('scripts/operations-controller.sh').replaceAll('\\', '/'),
        },
      },
    );
    const refused = [
      'uncertain',
      'storage-refused',
      'startup-refused',
      'verify-refused',
      'rollback-incompatible',
      'rollback-uncertain',
      'rollback-draining',
      'rollback-quiescent',
      'rollback-switching',
    ].includes(kind);
    expect(result.status, result.stderr).toBe(refused ? 1 : 0);
    const trace = (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean);
    if (kind === 'fresh') expect(trace).toEqual(['initial', 'startup']);
    if (kind === 'managed')
      expect(trace).toEqual(['retained', 'storage', 'draining', 'drain', 'postgres', 'startup']);
    if (kind === 'admission')
      expect(trace).toEqual(['storage', 'adopt', 'drain', 'postgres', 'startup']);
    if (kind === 'quiescent') expect(trace).toEqual(['startup']);
    if (kind === 'uncertain') expect(trace).toEqual([]);
    if (
      [
        'rollback-uncertain',
        'rollback-draining',
        'rollback-quiescent',
        'rollback-switching',
      ].includes(kind)
    ) {
      expect(trace).toEqual([]);
      expect(await readFile(join(root, 'phase'), 'utf8')).toBe(kind.slice('rollback-'.length));
    }
    if (kind === 'storage-refused') expect(trace).toEqual(['retained', 'storage']);
    if (kind.startsWith('verify')) expect(trace).toEqual(['verify']);
    if (kind === 'rollback-incompatible') expect(trace).toEqual(['retained']);
    if (kind === 'rollback')
      expect(trace).toEqual([
        'retained',
        'retained',
        'storage',
        'draining',
        'drain',
        'postgres',
        'startup',
      ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
