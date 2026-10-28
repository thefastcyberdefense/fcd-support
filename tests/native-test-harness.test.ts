import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['unit', 'checkpoint', 'invalid-project'])(
  'native harness %s builds its dependencies and keeps test project scope explicit',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-native-harness-'));
    try {
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
docker() {
  case "$1/$2" in
    build/*) printf '%s\\n' "build:$*" >>"$TASK_TRACE"; return 0 ;;
    compose/*) printf '%s\\n' "compose:$*" >>"$TASK_TRACE"; return 0 ;;
    volume/create) return 0 ;;
    volume/ls|ps/*|rm/*) return 0 ;;
    image/inspect) printf no; return 0 ;;
    create/*)
      printf '%s\\n' "create:$*" >>"$TASK_TRACE"
      if [[ "$*" == *-validator* ]]; then printf '%s' '${'a'.repeat(64)}'; else printf '%s' '${'b'.repeat(64)}'; fi
      return 0 ;;
    inspect/*)
      if [[ "$*" == *'{{len .Mounts}}'* ]]; then
        if [[ "$*" == *'${'a'.repeat(64)}'* ]]; then printf 0; else printf 1; fi
      else printf 'volume/%s/false' "$volume"; fi
      return 0 ;;
    network/inspect)
      if [[ "$*" == *'.Internal'* ]]; then printf true; elif [[ "$*" == *'com.docker.compose.project'* ]]; then printf '%s' "$FCD_SYNTHETIC_TEST_PROJECT"; fi; return 0 ;;
    run/*) printf '%s\\n' "run:$*" >>"$TASK_TRACE"; return 0 ;;
    *) return 1 ;;
  esac
}
export -f docker
git() { printf '%s' '${'a'.repeat(40)}'; }
export -f git
bash "$TASK_SCRIPT" "$TASK_MODE"
`,
        ],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_MODE: mode === 'invalid-project' ? 'unit' : mode,
            TASK_SCRIPT: resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/'),
            TASK_TRACE: join(root, 'trace').replaceAll('\\', '/'),
            FCD_SYNTHETIC_TEST_PROJECT:
              mode === 'invalid-project' ? 'fcd-support' : 'fcd-support-test-synthetic-iteration',
          },
        },
      );
      const trace = await readFile(join(root, 'trace'), 'utf8').catch(() => '');
      if (mode === 'invalid-project') {
        expect(result.status).toBe(1);
        expect(trace).toBe('');
        expect(result.stderr).toBe('backup_test_project_invalid\n');
      } else {
        expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
        expect(trace.indexOf('Dockerfile.integration')).toBeLessThan(
          trace.indexOf('Dockerfile.backup-test'),
        );
        expect(trace).toContain('-validator');
        expect(trace).toContain('-job');
        if (mode === 'unit') {
          expect(trace).not.toContain('compose:');
          expect(trace).toContain('--network none');
          expect(result.stdout).toContain('operations_unit_local=true');
        } else expect(trace).toContain('--project-name fcd-support-test-synthetic-iteration');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);
