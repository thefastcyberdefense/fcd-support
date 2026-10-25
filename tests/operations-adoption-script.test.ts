import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  image = `sha256:${'d'.repeat(64)}`,
  postgresImage = `sha256:${'e'.repeat(64)}`,
  postgres = '1'.repeat(64);

test
  .runIf(native)
  .each([
    'valid',
    'pending-job',
    'existing-selection',
    'lost-pointer',
    'wrong-image-revision',
    'wrong-pg-image',
    'wrong-project',
    'root-user',
    'paused',
    'managed-revision',
    'duplicate-pg',
    'wrong-volume',
    'wrong-provenance',
    'invalid-control-id',
    'changed-instance',
    'changed-volume',
  ])('first admission adoption handles %s without starting or stopping actors', async (fault) => {
  const root = await mkdtemp('/var/lib/fcd-support/backups/adoption-script-test-');
  await chmod(root, 0o700);
  await mkdir(join(root, 'state'), { mode: 0o700 });
  await writeFile(join(root, 'state', 'deployment.lock'), '', { mode: 0o600 });
  await writeFile(join(root, 'fault'), fault, { mode: 0o600 });
  await writeFile(
    join(root, 'docker'),
    `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; fault="$(<"$scope/fault")"; last="\${!#}"
printf '%s\\n' read >> "$scope/trace"
case " $* " in
  *' image inspect '*)
    if [[ "$last" == '${image}' ]]; then
      revision='${revision}'; [[ "$fault" != wrong-image-revision ]] || revision='${'b'.repeat(40)}'
      printf '%s/%s/linux/amd64/node\\n' "$last" "$revision"
    else printf '%s/none/linux/amd64/none\\n' "$last"; fi ;;
  *' ps '*)
    printf '%s\\n' '${postgres}'
    [[ "$fault" != duplicate-pg ]] || printf '%s\\n' '${'2'.repeat(64)}' ;;
  *' volume inspect '*)
    if [[ " $* " == *'.CreatedAt'* ]]; then
      origin=fcd-support; created=2030-04-01T00:00:00Z
      [[ "$fault" != wrong-provenance ]] || origin=fcd-support-foreign
      [[ "$fault" != changed-volume || ! -e "$scope/executed" ]] || created=2030-04-02T00:00:00Z
      printf 'fcd-support-original/%s/local/local/default/%s/postgres-data\\n' "$created" "$origin"
    else exit 19; fi ;;
  *' container inspect '*)
    if [[ " $* " == *'.Mounts'* ]]; then
      volume=fcd-support-original; [[ "$fault" != wrong-volume ]] || volume=fcd-support-foreign
      printf '%s/var/lib/postgresql/true\\n' "$volume"
    else
      project=fcd-support; image='${postgresImage}'; user=postgres; paused=false; revision=none; started=2030-04-01T00:00:00Z
      [[ "$fault" != wrong-project ]] || project=fcd-support-foreign
      [[ "$fault" != wrong-pg-image ]] || image='sha256:${'9'.repeat(64)}'
      [[ "$fault" != root-user ]] || user=root
      [[ "$fault" != paused ]] || paused=true
      [[ "$fault" != managed-revision ]] || revision='${revision}'
      [[ "$fault" != changed-instance || ! -e "$scope/executed" ]] || started=2030-04-01T00:01:00Z
      printf '%s/%s/postgres/%s/%s/running/true/%s/false/false/%s/%s\\n' '${postgres}' "$project" "$revision" "$image" "$paused" "$user" "$started"
    fi ;;
  *' exec '*)
    touch "$scope/executed"
    if [[ "$fault" == invalid-control-id ]]; then printf '0\\n'; else printf '1111111111111111111\\n'; fi ;;
  *) printf '%s\\n' unexpected >> "$scope/trace"; exit 19 ;;
esac
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_STATE"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT/state" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public
[FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_POSTGRES_VOLUME]=fcd-support-original [FCD_SUPPORT_REVISION]=${'b'.repeat(40)})
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/state/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
${fault === 'pending-job' ? 'printf synthetic_uncertain_job > "$TASK_ROOT/state/active-job";' : ''}
${['existing-selection', 'lost-pointer'].includes(fault) ? `operations_selection_create selection_${'f'.repeat(32)} fcd-support-original fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${revision} 000000;` : ''}
${fault === 'lost-pointer' ? 'rm -- "$TASK_ROOT/state/deployment-state";' : ''}
operations_adopt_admission ${revision} ${image} ${postgresImage}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 8000,
        env: {
          PATH: root + ':' + (process.env.PATH ?? ''),
          TASK_ROOT: root,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_STATE: resolve('scripts/operations-deployment-state.sh'),
          TASK_LIBRARY: resolve('scripts/operations-adoption.sh'),
        },
      },
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: fault === 'valid' ? 0 : 1,
      stdout: '',
      stderr: fault === 'valid' ? '' : 'operations_admission_adoption_refused\n',
    });
    const trace = await readFile(join(root, 'trace'), 'utf8').catch(() => '');
    expect(trace).not.toContain('unexpected');
    if (['pending-job', 'existing-selection', 'lost-pointer'].includes(fault))
      expect(trace).toBe('');
    const names = await readdir(join(root, 'state'));
    const selection = await readFile(join(root, 'state', 'deployment-state'), 'utf8').catch(
      () => '',
    );
    if (fault === 'valid') {
      expect(selection).toContain('STATE_PHASE=draining\n');
      expect(selection).toContain('STATE_WRITES_POSSIBLE=yes\n');
      expect(selection).toContain(`STATE_REVISION=${revision}\n`);
      expect(selection).toContain('STATE_SCHEMA_REVISION=000000\n');
      expect(selection).toContain('STATE_SYSTEM_IDENTIFIER=1111111111111111111\n');
      expect(names.filter((name) => name.startsWith('volume-'))).toHaveLength(1);
      expect(names.some((name) => name.startsWith('retained-'))).toBe(false);
    } else if (fault === 'existing-selection') {
      expect(selection).toContain('STATE_PHASE=quiescent\n');
    } else expect(selection).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
