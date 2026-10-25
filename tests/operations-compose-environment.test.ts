import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['ambient', 'memory'] as const)(
  'private Compose explicitly disables provider execution despite %s flags',
  async (source) => {
    const nativeRoot =
      process.platform === 'linux' &&
      process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only'
        ? '/var/lib/fcd-support/backups'
        : tmpdir();
    const root = await mkdtemp(join(nativeRoot, 'fcd-compose-environment-'));
    try {
      await writeFile(
        join(root, 'docker'),
        `#!/usr/bin/env bash
set -eu
[[ "\${MODEL_EXECUTION_ENABLED:-missing}/\${OUTBOUND_EXECUTION_ENABLED:-missing}/\${N8N_EXECUTION_ENABLED:-missing}" == false/false/false ]] || { printf 'private_execution_flags_missing\\n' >&2; exit 19; }
printf 'private_execution_disabled\\n'
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"
OPS_ROOT=/synthetic/workspace
declare -A OPS_CONFIG=([FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000)
${source === 'memory' ? 'OPS_CONFIG[MODEL_EXECUTION_ENABLED]=true; OPS_CONFIG[OUTBOUND_EXECUTION_ENABLED]=true; OPS_CONFIG[N8N_EXECUTION_ENABLED]=true' : ''}
operations_compose runtime --profile '*' config --format json
`,
        ],
        {
          encoding: 'utf8',
          timeout: 4000,
          env: {
            PATH: root + delimiter + (process.env.PATH ?? ''),
            SystemRoot: process.env.SystemRoot,
            MODEL_EXECUTION_ENABLED: 'true',
            OUTBOUND_EXECUTION_ENABLED: 'true',
            N8N_EXECUTION_ENABLED: 'true',
            TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          },
        },
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: 'private_execution_disabled\n',
        stderr: '',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
