import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test('incomplete deployment installation refuses before Docker when the private verifier is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-script-capability-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const trace = join(root, 'trace');
  await writeFile(
    join(bin, 'docker'),
    '#!/usr/bin/env bash\nprintf mutation >> "$TASK_TRACE"\nexit 19\n',
    { mode: 0o700 },
  );
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const result = spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$TASK_COMMON"; unset -f operations_verify; operations_main deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --mode private-disabled /synthetic/absent.conf',
    ],
    {
      encoding: 'utf8',
      timeout: 2000,
      env: {
        PATH: bin + delimiter + (process.env.PATH ?? ''),
        SystemRoot: process.env.SystemRoot,
        TASK_TRACE: trace.replaceAll('\\', '/'),
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe('operations_action_unavailable');
  expect(existsSync(trace)).toBe(false);
});

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
test.runIf(native).each([
  ['valid', 'FCD_RUNTIME_PROJECT=fcd-support-test\n', true],
  [
    'duplicate',
    'FCD_RUNTIME_PROJECT=fcd-support-test\nFCD_RUNTIME_PROJECT=fcd-support-other\n',
    false,
  ],
  ['unknown', 'NODE_OPTIONS=--inspect\n', false],
  ['substitution', 'FCD_RUNTIME_PROJECT=$(touch forbidden)\n', false],
  ['quoted', 'FCD_RUNTIME_PROJECT="fcd-support-test"\n', false],
  ['relative', 'FCD_CONFIG_ROOT=relative/path\n', false],
  ['traversal', 'FCD_CONFIG_ROOT=/run/../etc\n', false],
  ['nul', 'FCD_RUNTIME_PROJECT=fcd-support-test\0ignored\n', false],
  ['broad', 'FCD_RUNTIME_PROJECT=fcd-support-test\n', false],
  ['symlink', 'FCD_RUNTIME_PROJECT=fcd-support-test\n', false],
] as const)(
  'protected configuration parser handles %s without executing configuration',
  async (kind, content, valid) => {
    const root = await mkdtemp('/run/fcd-support/script-test-');
    roots.push(root);
    await chmod(root, 0o700);
    const original = join(root, 'configuration');
    await writeFile(original, content, { mode: kind === 'broad' ? 0o644 : 0o600 });
    const file = kind === 'symlink' ? join(root, 'link') : original;
    if (kind === 'symlink') await symlink(original, file);
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'source "$TASK_COMMON"; operations_load_config "$TASK_CONFIG"; printf "%s\\n" configuration_valid',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          LANG: 'C',
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_CONFIG: file,
        },
      },
    );
    expect(result.status).toBe(valid ? 0 : 1);
    expect(result.stdout.trim()).toBe(valid ? 'configuration_valid' : '');
    expect(result.stderr.trim()).toBe(valid ? '' : 'operations_config_invalid');
    expect(existsSync(join(root, 'forbidden'))).toBe(false);
  },
);

test.runIf(native).each(['verify-backup', 'migrate', 'verify-runtime', 'ok'] as const)(
  'deployment orchestration stops at %s and never migrates before separate verification',
  async (failure) => {
    const root = await mkdtemp('/run/fcd-support/sequence-test-');
    roots.push(root);
    await chmod(root, 0o700);
    // The operations tmpfs is intentionally noexec. Executable PATH doubles
    // live only in this scoped, synthetic archive-volume directory.
    const bin = await mkdtemp('/var/lib/fcd-support/backups/sequence-bin-');
    roots.push(bin);
    await chmod(bin, 0o700);
    await writeFile(join(bin, 'failure'), failure, { mode: 0o600 });
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"
phase=''
for argument in "$@"; do
  case "$argument" in stop|pre-migration-backup|verify-backup|migrate|deployment-started|deployment-succeeded|deployment-failed|verify-runtime) phase="$argument";; esac
done
if [[ -z "$phase" ]]; then
  if [[ " $* " == *" postgres "* ]]; then phase=postgres; else phase=start; fi
fi
printf '%s\\n' "$phase" >> "$scope/trace"
[[ "$phase" != "$(<"$scope/failure")" ]] || exit 17
[[ "$phase" != pre-migration-backup ]] || printf '%s\\n' backup_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'source "$TASK_COMMON"; OPS_ROOT="$TASK_ROOT"; OPS_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; declare -A OPS_CONFIG=([FCD_COMMAND_TIMEOUT_SECONDS]=10 [FCD_READY_TIMEOUT_SECONDS]=10 [FCD_STOP_GRACE_MS]=1000); operations_deploy',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          LANG: 'C',
          TASK_ROOT: root,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
        },
      },
    );
    const trace = existsSync(join(bin, 'trace'))
      ? readFile(join(bin, 'trace'), 'utf8')
      : Promise.resolve('');
    const phases = (await trace).trim().split('\n').filter(Boolean);
    if (failure === 'verify-backup')
      expect(phases).toEqual(['stop', 'postgres', 'pre-migration-backup', 'verify-backup']);
    else if (failure === 'migrate')
      expect(phases).toEqual([
        'stop',
        'postgres',
        'pre-migration-backup',
        'verify-backup',
        'migrate',
      ]);
    else if (failure === 'verify-runtime')
      expect(phases).toEqual([
        'stop',
        'postgres',
        'pre-migration-backup',
        'verify-backup',
        'migrate',
        'verify-backup',
        'deployment-started',
        'start',
        'verify-runtime',
        'stop',
        'deployment-failed',
      ]);
    else
      expect(phases).toEqual([
        'stop',
        'postgres',
        'pre-migration-backup',
        'verify-backup',
        'migrate',
        'verify-backup',
        'deployment-started',
        'start',
        'verify-runtime',
        'deployment-succeeded',
      ]);
    expect(result.status).toBe(failure === 'ok' ? 0 : 1);
    expect(result.stderr.trim()).toBe(
      failure === 'ok'
        ? ''
        : failure === 'verify-backup'
          ? 'operations_backup_verification_failed'
          : failure === 'migrate'
            ? 'operations_migration_failed'
            : 'operations_verification_failed',
    );
    expect(result.stdout).toBe('');
  },
);

test.runIf(native).each([
  ['valid', ''],
  ['missing', 'operations_socket_root_invalid'],
  ['symlink', 'operations_socket_root_invalid'],
  ['broad', 'operations_socket_root_invalid'],
  ['writable-ancestor', 'operations_config_invalid'],
  ['config-overlap', 'operations_socket_root_invalid'],
  ['source-overlap', 'operations_socket_root_invalid'],
  ['active-socket', 'operations_socket_present'],
  ['revision', 'operations_revision_invalid'],
  ['dirty', 'operations_revision_invalid'],
  ['image', 'operations_image_invalid'],
  ['volume-overlap', 'operations_socket_root_invalid'],
  ['remote-daemon', 'operations_daemon_invalid'],
  ['volume-driver', 'operations_volume_invalid'],
  ['lock-symlink', 'operations_lock_invalid'],
  ['lock-conflict', 'operations_lock_conflict'],
] as const)('host preflight handles %s without repairs or data mutation', async (kind, error) => {
  const root = await mkdtemp('/run/fcd-support/preflight-test-');
  roots.push(root);
  await chmod(root, 0o700);
  for (const name of ['socket', 'config', 'secrets', 'state', 'workspace'])
    await mkdir(join(root, name), { mode: 0o700 });
  const lock = join(root, 'state', 'deployment.lock');
  await writeFile(lock, '', { mode: 0o600 });
  const bin = await mkdtemp('/var/lib/fcd-support/backups/preflight-bin-');
  roots.push(bin);
  await chmod(bin, 0o700);
  await writeFile(join(bin, 'root'), root, { mode: 0o600 });
  await writeFile(join(bin, 'kind'), kind, { mode: 0o600 });
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; root="$(<"$scope/root")"; kind="$(<"$scope/kind")"
case " $* " in
 *' --show-toplevel '*) printf '%s\\n' "$root/workspace";;
 *' rev-parse HEAD '*) if [[ "$kind" == revision ]]; then printf '%040d\\n' 0; else printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi;;
 *' status '*) [[ "$kind" != dirty ]] || printf '%s\\n' ' M synthetic.txt';;
 *) exit 19;;
esac
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; root="$(<"$scope/root")"; kind="$(<"$scope/kind")"
if [[ "$1" == --host ]]; then shift 2; fi
[[ "$1 $2" == 'image inspect' || "$1 $2" == 'volume inspect' || "$1 $2" == 'context inspect' ]] || { printf '%s\\n' mutation >> "$scope/mutations"; exit 19; }
if [[ "$1" == context ]]; then
  if [[ "$kind" == remote-daemon ]]; then printf '%s\\n' tcp://remote.invalid:2376; else printf '%s\\n' unix:///var/run/docker.sock; fi
  exit 0
fi
case "$4" in
 *org.opencontainers.image.revision*) if [[ "$kind" == image ]]; then printf '%040d\\n' 0; else printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi;;
 *Architecture*) printf '%s\\n' linux/amd64;;
 *Mountpoint*) if [[ "$kind" == volume-overlap ]]; then printf '%s\\n' "$root/socket"; else printf '%s\\n' /var/lib/docker/volumes/fcd-support-test/_data; fi;;
 *Driver*) if [[ "$kind" == volume-driver ]]; then printf '%s\\n' local/local/custom; else printf '%s\\n' local/local/default; fi;;
 *) exit 19;;
esac
`,
    { mode: 0o700 },
  );
  let socketRoot = join(root, 'socket');
  let configRoot = join(root, 'config');
  const server = createServer();
  let listening = false;
  let holder: ReturnType<typeof spawn> | undefined;
  if (kind === 'missing') socketRoot = join(root, 'absent');
  if (kind === 'symlink') {
    await symlink(socketRoot, join(root, 'socket-link'));
    socketRoot = join(root, 'socket-link');
  }
  if (kind === 'broad') await chmod(socketRoot, 0o755);
  if (kind === 'writable-ancestor') await chmod(root, 0o777);
  if (kind === 'config-overlap') configRoot = socketRoot;
  if (kind === 'source-overlap') socketRoot = join(root, 'workspace');
  if (kind === 'active-socket') {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(join(socketRoot, 'admin.sock'), done);
    });
    listening = true;
  }
  if (kind === 'lock-symlink') {
    await rm(lock);
    await symlink(join(root, 'config'), lock);
  }
  if (kind === 'lock-conflict') {
    holder = spawn('flock', ['--nonblock', lock, '/bin/bash', '-c', 'printf ready; read -r line'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const current = holder;
    await new Promise<void>((done, reject) => {
      current.once('error', reject);
      current.stdout?.once('data', () => {
        done();
      });
      current.once('exit', () => {
        reject(new Error('synthetic_lock_failed'));
      });
    });
  }
  try {
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `source "$TASK_COMMON"; OPS_ROOT="$TASK_ROOT/workspace"; OPS_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; OPS_ACTION=deploy;
declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]="$OPS_REVISION" [FCD_CONFIG_ROOT]="$TASK_CONFIG_ROOT" [FCD_SECRET_ROOT]="$TASK_ROOT/secrets" [FCD_STATE_ROOT]="$TASK_ROOT/state" [FCD_ADMIN_SOCKET_ROOT]="$TASK_SOCKET_ROOT"
[FCD_RUNTIME_PROJECT]=fcd-support-test [FCD_SUPPORT_IMAGE]=fcd-support-test-app:a [FCD_OPERATIONS_IMAGE]=fcd-support-test-ops:a [FCD_POSTGRES_IMAGE]=fcd-support-test-pg:a
[FCD_POSTGRES_DB]=fcd_support_test [FCD_POSTGRES_VOLUME]=fcd-support-test-db [FCD_BACKUP_VOLUME]=fcd-support-test-backup
[FCD_COMMAND_TIMEOUT_SECONDS]=10 [FCD_READY_TIMEOUT_SECONDS]=10 [FCD_STOP_GRACE_MS]=1000 [FCD_SCHEMA_REVISION]=000015);
operations_preflight; printf '%s\\n' preflight_valid`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          LANG: 'C',
          TASK_ROOT: root,
          TASK_SOCKET_ROOT: socketRoot,
          TASK_CONFIG_ROOT: configRoot,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
        },
      },
    );
    expect(result.status).toBe(error === '' ? 0 : 1);
    expect(result.stderr.trim()).toBe(error);
    expect(result.stdout.trim()).toBe(error === '' ? 'preflight_valid' : '');
    expect(existsSync(join(bin, 'mutations'))).toBe(false);
    expect(existsSync(join(root, 'socket'))).toBe(true);
  } finally {
    holder?.stdin?.end();
    if (holder !== undefined)
      await new Promise<void>((done) => {
        holder.once('close', () => {
          done();
        });
      });
    if (listening)
      await new Promise<void>((done, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else done();
        });
      });
  }
});
test.each([
  'deploy-runtime.sh',
  'verify-runtime.sh',
  'rollback-runtime.sh',
  'restore-runtime.sh',
  'promote-restore.sh',
  'recover-admin-socket.sh',
])('%s rejects invalid arguments before invoking any Docker operation', async (script) => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-script-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const trace = join(root, 'operations');
  await writeFile(
    join(bin, 'docker'),
    '#!/usr/bin/env bash\nprintf "%s\\n" unexpected_docker_operation >> "$TASK_TRACE"\nexit 99\n',
    { mode: 0o700 },
  );
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const result = spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      resolve('scripts', script).replaceAll('\\', '/'),
      'synthetic-invalid-revision',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
      env: {
        PATH: bin + delimiter + (process.env.PATH ?? ''),
        SystemRoot: process.env.SystemRoot,
        TASK_TRACE: trace.replaceAll('\\', '/'),
        LANG: 'C.UTF-8',
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe('operations_arguments_invalid');
  expect(existsSync(trace)).toBe(false);
});
