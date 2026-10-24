import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Only the external Docker transport is replaced. The shell guards, host file
// metadata, canonical paths, compiled helper and its real unlink are exercised.
test
  .runIf(process.platform === 'linux')
  .each([
    'stopped',
    'running',
    'wrong_revision',
    'wrong_image',
    'ambiguous',
    'foreign_mount',
    'alias_mount',
    'wrong_destination',
    'transport_failure',
  ] as const)('recovery host controller handles %s without widening capabilities', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-recovery-host-test-'));
  if (!root.startsWith(join(tmpdir(), 'fcd-recovery-host-test-')))
    throw new Error('synthetic_scope_invalid');
  await chmod(root, 0o700);
  const path = join(root, 'admin.sock');
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(path, resolveReady);
  });
  await chmod(path, 0o600);
  await rename(path, join(root, 'parked.sock'));
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClosed();
    });
  });
  await rename(join(root, 'parked.sock'), path);
  const before = await lstat(path, { bigint: true });
  await symlink(root, join(root, 'synthetic-alias'));
  try {
    const script = `
      source ./scripts/operations-common.sh
      source ./scripts/operations-admin-socket.sh
      declare -A OPS_CONFIG=([FCD_ADMIN_SOCKET_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support-synthetic
        [FCD_SUPPORT_REVISION]=${'a'.repeat(40)} [FCD_SUPPORT_IMAGE]=synthetic-runtime [FCD_OPERATIONS_IMAGE]=synthetic-operations
        [FCD_ADMIN_CPUS]=1 [FCD_ADMIN_MEMORY_MIB]=256 [FCD_ADMIN_PIDS]=64 [FCD_HEALTH_TIMEOUT_MS]=100)
      OPS_ACTION=recover-admin-socket
      fixture_owner=${'b'.repeat(64)}; fixture_foreign=${'c'.repeat(64)}
      operations_docker() {
        local last="\${!#}" state=exited revision=${'a'.repeat(40)} image=sha256:${'d'.repeat(64)}
        if [[ "$1" == ps ]]; then
          printf '%s\\n' "$fixture_owner"
          if [[ "$*" != *'--filter'* || "$TASK_MODE" == ambiguous ]]; then printf '%s\\n' "$fixture_foreign"; fi
          return 0
        fi
        if [[ "$1" == image && "$2" == inspect ]]; then
          if [[ "$last" == synthetic-operations ]]; then image=sha256:${'e'.repeat(64)}; fi
          if [[ "$TASK_MODE" == wrong_image && "$last" == synthetic-runtime ]]; then image=sha256:${'f'.repeat(64)}; fi
          printf '%s/${'a'.repeat(40)}/linux/amd64/node' "$image"; return 0
        fi
        if [[ "$1" == container && "$2" == inspect ]]; then
          if [[ "$*" == *'.Destination'* ]]; then
            if [[ "$TASK_MODE" == wrong_destination ]]; then printf invalid; else printf valid; fi
          elif [[ "$*" == *'.Source'* ]]; then
            if [[ "$last" == "$fixture_owner" ]]; then printf '%s\\n' "$TASK_ROOT"
            elif [[ "$TASK_MODE" == foreign_mount ]]; then printf '%s\\n' "$(dirname "$TASK_ROOT")"
            elif [[ "$TASK_MODE" == alias_mount ]]; then printf '%s/synthetic-alias\\n' "$TASK_ROOT"
            else printf '/etc/hosts\\n'; fi
          else
            [[ "$TASK_MODE" != running ]] || state=running
            [[ "$TASK_MODE" != wrong_revision ]] || revision=${'f'.repeat(40)}
            printf 'fcd-support-synthetic/fcd-support-admin/%s/%s/%s/false/false/false/false' "$revision" "$image" "$state"
          fi
          return 0
        fi
        if [[ "$1" == run ]]; then
          [[ "$*" == *'--network none --read-only --user 1000:1000'* && "$*" == *'--cap-drop ALL --security-opt no-new-privileges'* ]] || return 125
          [[ "$*" == *"type=bind,src=$TASK_ROOT,dst=/run/fcd-support-admin"* && "$*" == *'--entrypoint node sha256:${'e'.repeat(64)} dist/operations/admin-socket-recovery.js'* ]] || return 125
          [[ "$*" != *'docker.sock'* && "$*" != *'--privileged'* && "$*" != *'--env'* ]] || return 125
          if [[ "$TASK_MODE" == transport_failure ]]; then printf synthetic_untrusted_output; return 125; fi
          node "$TASK_HELPER" "$TASK_ROOT/admin.sock" "\${@: -3:1}" "\${@: -2:1}" "\${@: -1}"
          return
        fi
        return 125
      }
      operations_recover_socket
    `;
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        TASK_MODE: mode,
        TASK_ROOT: root,
        TASK_HELPER: existsSync('/app/dist/operations/admin-socket-recovery.js')
          ? '/app/dist/operations/admin-socket-recovery.js'
          : resolve('dist/operations/admin-socket-recovery.js'),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(mode === 'stopped' ? 0 : 1);
    expect(result.stdout).toBe(mode === 'stopped' ? 'admin_socket_recovered\n' : '');
    expect(result.stderr).toBe(mode === 'stopped' ? '' : 'operations_socket_recovery_refused\n');
    if (mode === 'stopped') await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
