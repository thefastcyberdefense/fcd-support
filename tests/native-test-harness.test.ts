import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { createMockDocker } from './helpers/backup-harness-fixture.js';

test.each(['unit', 'checkpoint', 'invalid-project'])(
  'native harness %s builds its dependencies and keeps test project scope explicit',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-native-harness-'));
    try {
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });
      await writeFile(
        join(bin, 'git'),
        '#!/usr/bin/env bash\nprintf aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
        { mode: 0o700 },
      );
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        [
          '--noprofile',
          '--norc',
          resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/'),
          mode === 'invalid-project' ? 'unit' : mode,
        ],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            PATH: bin + delimiter + (process.env.PATH ?? ''),
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
