import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const ref = 'a'.repeat(32);

async function recovery(fault: string, healthInvocations = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'fcd-synthetic-recovery-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'state'));
    await mkdir(join(directory, 'logs'));
    await mkdir(join(directory, 'config'));
    await writeFile(
      join(directory, 'scripts/synthetic-host-cleanup.sh'),
      await readFile('scripts/synthetic-host-cleanup.sh'),
    );
    const source = (
      await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8')
    ).replaceAll('\r\n', '\n');
    const maintenance = source.indexOf('\n  stage=maintenance\n');
    expect(maintenance).toBeGreaterThan(0);
    const start = source.lastIndexOf('if [[ "$ci_mode" == true ]]; then\n', maintenance);
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, source.indexOf('# Keep this explicitly synthetic', start));
    // Test ports stand in for external processes; execute the production orchestration unchanged.
    const scheduled = `
operations_scheduled_arguments() { OPS_REVISION="$2"; OPS_CONFIG_FILE="$3"; }
operations_load_config() { trace load; }
operations_preflight() { [[ "$OPS_REVISION" == "$revision" && "$OPS_ROOT" == "$root" && "$OPS_ACTION" == verify ]]; trace preflight; }
operations_selection_apply() { declare -gA OPS_SELECTION=([STATE_SYSTEM_IDENTIFIER]=1111111111111111111); }
operations_scheduled_ready() { operations_selection_apply; trace ready; }
operations_scheduled_images() { trace images; }
operations_execute_job() { [[ "$1 $2" == 'checkpoint export-checkpoint-reference' ]]; trace checkpoint; [[ "$TASK_FAULT" != checkpoint ]] || return 1; printf 'checkpoint_${ref}'; }
`;
    for (const file of [
      'run-operation.sh',
      'operations-common.sh',
      'operations-deployment-state.sh',
      'operations-job-lifecycle.sh',
    ])
      await writeFile(join(directory, 'scripts', file), scheduled);
    const prefix = `
set -Eeuo pipefail
root="$TASK_DIRECTORY"; fixture="$root"; revision=${'b'.repeat(40)}
project=fcd-support-host-test-ci-bbbbbbb; restore_project=fcd-support-restore-host-test-ci-bbbbbbb
synthetic_host_run() { bash "$@"; }
synthetic_host_stage_failed() { exit 1; }
ci_mode=true; precreated_mode=false; peer=${'c'.repeat(64)}; before=''; safe=()
trace() { printf '%s\\n' "$1" >> "$root/trace"; }
export -f trace
export root revision
selection() { printf 'STATE_PHASE=%s\\nSTATE_VOLUME=%s\\nSTATE_SYSTEM_IDENTIFIER=%s\\n' "$1" "$2" "$3" > "$root/state/deployment-state"; }
selection ready "$project-postgres" 1111111111111111111
bash() {
 case "$1" in
  -c) command bash "$@" ;;
  scripts/run-operation.sh)
   case "$2" in
    maintenance) trace maintenance; [[ "$TASK_FAULT" != maintenance ]] ;;
    backup) trace backup; [[ "$TASK_FAULT" != backup ]] ;;
    health)
     trace health
     [[ "$TASK_FAULT" != health ]] || return 1
     if [[ "$TASK_FAULT" == health-uncertain && "$health_idx" == 2 ]]; then
       printf 'JOB_SERVICE=health\\nJOB_PHASE=uncertain\\n' > "$root/state/active-job"
       return 1
     fi
     if [[ "$TASK_FAULT" == health-leftover-after && "$health_idx" == 2 ]]; then
       touch "$root/state/synthetic-leftover"
     fi ;;
    *) return 91 ;;
   esac ;;
  scripts/restore-runtime.sh)
   trace restore
   [[ "$TASK_FAULT" != restore ]] || return 1
   printf 'RESTORE_PHASE=completed\\nRESTORE_REF=restore_${ref}\\nRESTORE_BACKUP_REF=backup_${ref}\\nRESTORE_CHECKPOINT_REF=checkpoint_${ref}\\n' > "$root/state/restore-${ref}.record"
   [[ "$TASK_FAULT" != missing-record ]] || command rm "$root/state/restore-${ref}.record"
   selection quiescent "$project-postgres" 1111111111111111111
   printf restore_${ref} ;;
  scripts/promote-restore.sh)
   trace promote
   if [[ "$TASK_FAULT" == promote ]]; then return 1; fi
   system=2222222222222222222
   [[ "$TASK_FAULT" != same-identity ]] || system=1111111111111111111
   selection ready "$restore_project-data" "$system" ;;
  scripts/rollback-runtime.sh)
   trace rollback
   if [[ "$TASK_FAULT" == rollback ]]; then return 1; fi
   if [[ "$TASK_FAULT" == old-volume ]]; then selection ready "$project-postgres" 1111111111111111111; fi ;;
  scripts/verify-runtime.sh) trace verify ;;
  *) return 91 ;;
 esac
}
docker() {
 case "$1 $2" in
  run*) printf backup_${ref} ;;
  'container inspect') trace cleanup-guard; return 1 ;;
  'volume inspect') [[ "$TASK_FAULT" != cleanup ]] || [[ "$stage" != cleanup ]] ;;
  exec*) [[ "$TASK_FAULT" != health-no-persistence ]] || { printf 0; return; }; printf '%s\n' "$(( \${health_idx:-0} ))" ;;
  'rm --force') trace cleanup-peer ;;
  compose*) trace invalid-compose; return 1 ;;
  'ps -aq')
   [[ "$*" == "ps -aq --filter label=fcd-support.operation.service=health --filter label=fcd-support.operation.parent=$project" ]] || return 95
   if [[ "$TASK_FAULT" == health-leftover-before || -e "$root/state/synthetic-leftover" ]]; then printf '%s' "${ref}${ref}"; fi ;;
  'volume ls'|'network ls') : ;;
  'ps --all'*|'ps -q'*) if [[ "$*" == *"service=postgres"* ]]; then printf '%s\n' "${ref}${ref}"; fi ;;
  rmi*) trace cleanup-image ;;
  *) return 92 ;;
 esac
}
curl() { printf 200; }
rm() { trace premature-evidence-removal; }
snapshot() { :; }
cd "$root"
root="$PWD"; fixture="$root"; export root
`;
    await writeFile(join(directory, 'exercise.sh'), prefix + block);
    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', join(directory, 'exercise.sh').replaceAll('\\', '/')],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_DIRECTORY: directory.replaceAll('\\', '/'),
          TASK_FAULT: fault,
          TASK_HEALTH_STRESS: String(healthInvocations),
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      activeJob: await readFile(join(directory, 'state/active-job'), 'utf8').catch(() => ''),
      trace: (await readFile(join(directory, 'trace'), 'utf8').catch(() => '')).trim().split('\n'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('checkpoint uses revision, managed READY selection and retained-image guards before a job', async () => {
  const result = await recovery('checkpoint');
  expect(result.status).toBe(1);
  expect(result.trace).toEqual([
    'maintenance',
    'backup',
    'health',
    'load',
    'preflight',
    'ready',
    'images',
    'checkpoint',
  ]);
  expect(result.stdout).not.toContain('synthetic_host_checkpoint_passed');
});

test.each(['promote', 'same-identity', 'rollback', 'old-volume'])(
  'recovery refuses %s without proceeding or deleting evidence',
  async (fault) => {
    const result = await recovery(fault);
    expect(result.status, result.stderr).toBe(1);
    expect(result.trace).toContain(
      fault === 'promote' || fault === 'same-identity' ? 'promote' : 'rollback',
    );
    expect(result.trace).not.toContain('premature-evidence-removal');
    expect(result.stdout).not.toContain('synthetic_host_recovery_passed');
    if (fault === 'promote' || fault === 'same-identity')
      expect(result.trace).not.toContain('rollback');
  },
);

test('cleanup guard refusal preserves protected evidence', async () => {
  const result = await recovery('cleanup');
  expect(result.status).toBe(1);
  expect(result.trace).toContain('rollback');
  expect(result.trace).toContain('cleanup-guard');
  expect(result.stderr).not.toContain('No such file');
  expect(result.trace).not.toContain('premature-evidence-removal');
  expect(result.stdout).not.toContain('synthetic_host_cleanup_passed');
});

test.each(['maintenance', 'backup', 'health', 'restore', 'missing-record'])(
  'a failed or missing %s proof cannot reach promotion or cleanup',
  async (fault) => {
    const result = await recovery(fault);
    expect(result.status).not.toBe(0);
    expect(result.trace).not.toContain('promote');
    expect(result.trace).not.toContain('rollback');
    expect(result.trace).not.toContain('premature-evidence-removal');
    expect(result.stdout).not.toContain('synthetic_host_recovery_passed');
    if (fault === 'backup' || fault === 'health') expect(result.trace).not.toContain('checkpoint');
    if (fault === 'maintenance') expect(result.trace).toEqual(['maintenance']);
  },
);

test('actual stress harness stops on the second uncertain operation and preserves its journal', async () => {
  const result = await recovery('health-uncertain', 10);
  expect(result.status).toBe(1);
  expect(result.trace.filter((step) => step === 'health')).toHaveLength(2);
  expect(result.stdout).toContain('synthetic_host_health_iteration=1\n');
  expect(result.stdout).not.toContain('synthetic_host_health_iteration=2\n');
  expect(result.trace).not.toContain('checkpoint');
  expect(result.trace).not.toContain('promote');
  expect(result.activeJob).toBe('JOB_SERVICE=health\nJOB_PHASE=uncertain\n');
});

test.each([
  ['health-leftover-before', 0],
  ['health-leftover-after', 2],
  ['health-no-persistence', 1],
] as const)(
  'actual stress harness refuses %s before any later invocation',
  async (fault, calls) => {
    const result = await recovery(fault, 10);
    expect(result.status).toBe(1);
    expect(result.trace.filter((step) => step === 'health')).toHaveLength(calls);
    expect(result.trace).not.toContain('checkpoint');
    expect(result.trace).not.toContain('promote');
    expect(result.trace).not.toContain('premature-evidence-removal');
  },
);

test('actual stress harness completes ten persisted health operations before reaching checkpoint', async () => {
  const result = await recovery('checkpoint', 10);
  expect(result.status).toBe(1);
  expect(result.trace.filter((step) => step === 'health')).toHaveLength(10);
  expect(result.stdout).toContain('synthetic_host_health_iteration=10\n');
  expect(result.stdout).toContain('synthetic_host_health_passed=true');
  expect(result.trace).toContain('checkpoint');
});
