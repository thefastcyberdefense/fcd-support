import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('host collector runs its validator by checked immutable image ID, not a mutable tag', () => {
  const script = `
    source ./scripts/operations-common.sh
    source ./scripts/operations-restore-host.sh
    declare -A OPS_CONFIG=([FCD_RESTORE_PROJECT]=fcd-support-restore-synthetic [FCD_RESTORE_VOLUME]=fcd-support-restore-synthetic-data
      [FCD_POSTGRES_VOLUME]=fcd-support-runtime-data [FCD_SUPPORT_REVISION]=${'a'.repeat(40)}
      [FCD_POSTGRES_IMAGE]=synthetic-postgres [FCD_SUPPORT_IMAGE]=synthetic-runtime [FCD_OPERATIONS_IMAGE]=synthetic-operations
      [FCD_RESTORE_CPUS]=1 [FCD_RESTORE_MEMORY_MIB]=256 [FCD_RESTORE_PIDS]=64)
    operations_restore_host_snapshot() { printf '{}'; }
    operations_docker() {
      if [[ "$1" == image && "$2" == inspect ]]; then printf 'sha256:${'b'.repeat(64)}/${'a'.repeat(40)}/linux/amd64/node'; return 0; fi
      [[ "$*" == *'--entrypoint node sha256:${'b'.repeat(64)} dist/operations/restore-host-main.js'* ]] || return 125
      [[ "$*" == *'--network none --read-only --user 1000:1000'* && "$*" == *'--cap-drop ALL --security-opt no-new-privileges'* ]] || return 125
      [[ "$*" != *'--mount'* && "$*" != *'--volume'* ]] || return 125
      printf 'synthetic_validated_identity'
    }
    operations_inspect_restore_host
  `;
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash',
    ['-c', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('synthetic_validated_identity\n');
  expect(result.stderr).toBe('');
});

test('host collector discards ambiguous validator output on transport failure', () => {
  const script = `
    source ./scripts/operations-common.sh
    source ./scripts/operations-restore-host.sh
    declare -A OPS_CONFIG=([FCD_RESTORE_PROJECT]=fcd-support-restore-synthetic [FCD_RESTORE_VOLUME]=fcd-support-restore-synthetic-data
      [FCD_POSTGRES_VOLUME]=fcd-support-runtime-data [FCD_SUPPORT_REVISION]=${'a'.repeat(40)}
      [FCD_POSTGRES_IMAGE]=synthetic-postgres [FCD_SUPPORT_IMAGE]=synthetic-runtime [FCD_OPERATIONS_IMAGE]=synthetic-operations
      [FCD_RESTORE_CPUS]=1 [FCD_RESTORE_MEMORY_MIB]=256 [FCD_RESTORE_PIDS]=64)
    operations_restore_host_snapshot() { printf '{}'; }
    operations_docker() {
      if [[ "$1" == image && "$2" == inspect ]]; then printf 'sha256:${'b'.repeat(64)}/${'a'.repeat(40)}/linux/amd64/node'; return 0; fi
      printf 'synthetic_untrusted_stdout'; printf 'synthetic_untrusted_stderr' >&2; return 125;
    }
    operations_inspect_restore_host
  `;
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash',
    ['-c', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('restore_host_invalid\n');
});
