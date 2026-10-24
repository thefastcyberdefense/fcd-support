import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
test
  .runIf(native)
  .each([
    'valid',
    'maximum',
    'zero',
    'leading-zero',
    'too-large',
    'extra-output',
    'duplicate-output',
    'exec-error',
    'changed-container',
    'changed-postgres',
    'wrong-image',
    'wrong-revision',
    'not-running',
    'tool-warning',
    'tool-duplicate',
    'tool-error',
    'tool-garbage',
  ] as const)(
  'physical database identity handles %s without printing unrelated metadata',
  async (fault) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/database-id-test-');
    await chmod(root, 0o700);
    try {
      await writeFile(join(root, 'failure'), fault, { mode: 0o600 });
      await writeFile(
        join(root, 'pg_controldata'),
        `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; fault="$(<"$scope/failure")"
if [[ "$fault" == tool-garbage ]]; then printf '%s\\n' synthetic_invalid_control_output; exit 0; fi
printf '%s\\n' 'Database system identifier: 1111111111111111111'
case "$fault" in
  tool-warning) printf '%s\\n' 'pg_controldata: warning: synthetic_crc_failure' >&2 ;;
  tool-duplicate) printf '%s\\n' 'Database system identifier: 1111111111111111111' ;;
  tool-error) exit 19 ;;
esac
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(root, 'docker'),
        `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; fault="$(<"$scope/failure")"
pg='${'b'.repeat(64)}'; image='sha256:${'d'.repeat(64)}'; revision='${'a'.repeat(40)}'
if [[ " $* " == *" ps "* ]]; then
  printf '%s\\n' ps >> "$scope/trace"
  printf '%s\\n' "$pg"
  [[ "$fault" != changed-postgres || ! -f "$scope/executed" ]] || printf '%s\\n' '${'c'.repeat(64)}'
elif [[ " $* " == *" image inspect "* ]]; then
  printf '%s\\n' image >> "$scope/trace"
  [[ "$fault" != wrong-image ]] || image='sha256:${'e'.repeat(64)}'
  [[ "$fault" != wrong-revision ]] || revision='${'0'.repeat(40)}'
  printf '%s/%s/linux/amd64/postgres\\n' "$image" "$revision"
elif [[ " $* " == *" container inspect "* ]]; then
  printf '%s\\n' container >> "$scope/trace"
  running=true; time=2030-04-01T00:00:00Z
  [[ "$fault" != not-running ]] || running=false
  [[ "$fault" != changed-container || ! -f "$scope/executed" ]] || time=2030-04-01T00:01:00Z
  printf '%s/fcd-support-runtime/postgres/%s/%s/%s/false/false/false/%s\\n' "$pg" "$revision" "$image" "$running" "$time"
elif [[ " $* " == *" exec "* ]]; then
  printf '%s\\n' exec >> "$scope/trace"; touch "$scope/executed"
  if [[ "$fault" == tool-* ]]; then exec /bin/bash -o pipefail -c "\${!#}"; fi
  case "$fault" in
    maximum) printf '%s\\n' 18446744073709551615 ;;
    zero) printf '%s\\n' 0 ;;
    leading-zero) printf '%s\\n' 01111111111111111111 ;;
    too-large) printf '%s\\n' 18446744073709551616 ;;
    extra-output) printf '%s\\n' 1111111111111111111 unexpected ;;
    duplicate-output) printf '%s\\n' 1111111111111111111 1111111111111111111 ;;
    exec-error) printf '%s\\n' 1111111111111111111; exit 17 ;;
    *) printf '%s\\n' 1111111111111111111 ;;
  esac
else exit 19
fi
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"
source "$TASK_RUNTIME"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-runtime [FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_POSTGRES_IMAGE]=synthetic-pg
[FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000)
operations_read_database_identity
`,
        ],
        {
          encoding: 'utf8',
          timeout: 4000,
          env: {
            PATH: root + ':' + (process.env.PATH ?? ''),
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_RUNTIME: resolve('scripts/operations-runtime-host.sh'),
            TASK_LIBRARY: resolve('scripts/operations-database.sh'),
          },
        },
      );
      const success = fault === 'valid' || fault === 'maximum';
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
        success
          ? {
              status: 0,
              stdout: (fault === 'maximum' ? '18446744073709551615' : '1111111111111111111') + '\n',
              stderr: '',
            }
          : { status: 1, stdout: '', stderr: 'operations_database_identity_invalid\n' },
      );
      const phases = (await readFile(join(root, 'trace'), 'utf8')).trim().split('\n');
      expect(phases).toContain('image');
      if (['wrong-image', 'wrong-revision', 'not-running'].includes(fault))
        expect(phases).not.toContain('exec');
      else expect(phases).toContain('exec');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
