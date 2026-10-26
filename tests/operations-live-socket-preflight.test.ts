import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  selection = `selection_${'b'.repeat(32)}`;
const common = resolve('scripts/operations-common.sh').replaceAll('\\', '/');

test('preflight holds the lock and loads the selected source before checking its socket or using Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcd-socket-order-test-'));
  const trace = join(root, 'trace');
  await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
  try {
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=$TASK_REVISION [FCD_SCHEMA_REVISION]=000016 [FCD_CONFIG_ROOT]=/synthetic/config [FCD_SECRET_ROOT]=/synthetic/secret [FCD_STATE_ROOT]="$TASK_ROOT" [FCD_ADMIN_SOCKET_ROOT]=/synthetic/socket [FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_IMAGE]=synthetic-app [FCD_OPERATIONS_IMAGE]=synthetic-ops [FCD_POSTGRES_IMAGE]=synthetic-pg [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic [FCD_POSTGRES_VOLUME]=fcd-support-original [FCD_BACKUP_VOLUME]=fcd-support-backups [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_READY_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000)
OPS_ROOT=/synthetic/source; OPS_ACTION=deploy; OPS_REVISION=$TASK_REVISION
trace() { printf '%s\\n' "$1" >>"$TASK_TRACE"; }
operations_private_directory() { return 0; }; operations_disjoint() { return 0; }
operations_exact_revision() { trace revision; }
stat() { case "$*" in *%u:%g:%a*) printf '1000:1000:600\\n' ;; *) printf '10:11\\n' ;; esac; }
flock() { trace lock; }
operations_preflight_selection() { [[ -n "$` +
          `{OPS_LOCK_DESCRIPTOR:-}" ]] || exit 21; trace selection; OPS_DEPLOYMENT_HAS_SELECTION=yes; }
operations_socket_root() { [[ "$` +
          `{OPS_DEPLOYMENT_HAS_SELECTION:-no}" == yes && -n "$` +
          `{OPS_LOCK_DESCRIPTOR:-}" ]] || operations_fail synthetic_socket_before_selection; trace socket; OPS_SOCKET_ALLOWED=yes; }
operations_image_revisions() { trace images; }
operations_docker() {
  [[ "$` +
          `{OPS_SOCKET_ALLOWED:-no}" == yes ]] || exit 22
  trace docker
  case "$1 $2" in
    'context inspect') printf 'unix:///var/run/docker.sock\\n' ;;
    'volume inspect') case "$*" in *Mountpoint*) printf '/var/lib/docker/volumes/synthetic/_data\\n' ;; *) printf 'local/local/default\\n' ;; esac ;;
    *) exit 23 ;;
  esac
}
operations_preflight
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_COMMON: common,
          TASK_ROOT: root.replaceAll('\\', '/'),
          TASK_TRACE: trace.replaceAll('\\', '/'),
          TASK_REVISION: revision,
        },
      },
    );
    expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const events = (await readFile(trace, 'utf8')).trim().split('\n');
    expect(events.slice(0, 4)).toEqual(['revision', 'lock', 'selection', 'socket']);
    expect(events.indexOf('docker')).toBeGreaterThan(events.indexOf('socket'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['deploy', 'rollback', 'restore', 'promote', 'verify', 'recover-admin-socket'])(
  'socket preflight preserves %s entry refusal or existing verify/recovery semantics',
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-socket-refusal-test-'));
    await writeFile(join(root, 'admin.sock'), 'synthetic_regular_file', { mode: 0o600 });
    try {
      const result = spawnSync(
        bash,
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"
declare -A OPS_CONFIG=([FCD_ADMIN_SOCKET_ROOT]="$TASK_ROOT" [FCD_CONFIG_ROOT]=/synthetic/config [FCD_SECRET_ROOT]=/synthetic/secret [FCD_STATE_ROOT]=/synthetic/state)
OPS_ROOT=/synthetic/source; OPS_ACTION=$TASK_ACTION; OPS_DEPLOYMENT_HAS_SELECTION=no
id() { printf '1000\\n'; }; operations_private_directory() { return 0; }; operations_disjoint() { return 0; }
operations_socket_root
`,
        ],
        {
          encoding: 'utf8',
          timeout: 4000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TASK_COMMON: common,
            TASK_ROOT: root.replaceAll('\\', '/'),
            TASK_ACTION: action,
          },
        },
      );
      const permitted = action === 'verify' || action === 'recover-admin-socket';
      expect(result.status).toBe(permitted ? 0 : 1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(permitted ? '' : 'operations_socket_present\n');
      expect(await readFile(join(root, 'admin.sock'), 'utf8')).toBe('synthetic_regular_file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function socketFixture(phase = 'ready') {
  const root = await mkdtemp('/var/lib/fcd-support/backups/live-socket-test-');
  await chmod(root, 0o700);
  for (const part of ['admin', 'state', 'config', 'secret', 'source']) {
    await mkdir(join(root, part), { mode: 0o700 });
  }
  await writeFile(join(root, 'state', 'deployment.lock'), '', { mode: 0o600 });
  const socket = join(root, 'admin', 'admin.sock');
  const server = createServer();
  const priorMask = process.umask(0o177);
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(socket, done);
    });
  } finally {
    process.umask(priorMask);
  }
  await chmod(socket, 0o600);
  const run = (action: string, body = '', locked = true) =>
    spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_SELECTION"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT/state" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_POSTGRES_VOLUME]=fcd-support-original [FCD_ADMIN_SOCKET_ROOT]="$TASK_ROOT/admin" [FCD_CONFIG_ROOT]="$TASK_ROOT/config" [FCD_SECRET_ROOT]="$TASK_ROOT/secret")
OPS_ROOT="$TASK_ROOT/source"; OPS_ACTION=$TASK_ACTION; OPS_DEPLOYMENT_HAS_SELECTION=yes
${locked ? 'exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/state/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR";' : ''}
operations_docker() { printf forbidden >"$TASK_ROOT/docker-used"; return 19; }
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 12000,
        env: {
          PATH: process.env.PATH,
          TASK_COMMON: common,
          TASK_ROOT: root,
          TASK_ACTION: action,
          TASK_SELECTION: resolve('scripts/operations-deployment-state.sh'),
        },
      },
    );
  if (phase !== 'missing') {
    const initialize = `operations_selection_create ${selection} fcd-support-original fcd-support postgres-data 2030-01-01T00:00:00Z 7300000000000000000 fcd_support_test ${revision} 000016`;
    const ready = `operations_selection_starting ${selection} ${revision} 000016; operations_selection_ready ${selection}`;
    const transition =
      phase === 'ready'
        ? ''
        : phase === 'quiescent'
          ? `operations_selection_quiesce ${selection}`
          : phase === 'draining'
            ? `operations_selection_draining ${selection}`
            : `operations_selection_uncertain ${selection}`;
    const result = run('deploy', `${initialize}; ${ready}; ${transition || ':'}`);
    expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  }
  return {
    root,
    run,
    socket,
    dispose: async () => {
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.runIf(native).each(['deploy', 'rollback', 'restore', 'promote'])(
  'managed READY %s accepts the protected live Unix socket without changing it or using Docker',
  async (action) => {
    const f = await socketFixture();
    try {
      const before = await stat(f.socket);
      const pointer = await readFile(join(f.root, 'state', 'deployment-state'), 'utf8');
      const result = f.run(action, 'operations_socket_root');
      expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        code: 0,
        stdout: '',
        stderr: '',
      });
      const after = await stat(f.socket);
      expect({
        ino: after.ino,
        mode: after.mode,
        uid: after.uid,
        gid: after.gid,
        nlink: after.nlink,
      }).toEqual({
        ino: before.ino,
        mode: before.mode,
        uid: before.uid,
        gid: before.gid,
        nlink: before.nlink,
      });
      expect(await readFile(join(f.root, 'state', 'deployment-state'), 'utf8')).toBe(pointer);
      await expect(stat(join(f.root, 'docker-used'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.dispose();
    }
  },
);

test
  .runIf(native)
  .each([
    'quiescent',
    'draining',
    'uncertain',
    'missing',
    'symlink',
    'hardlink',
    'broad',
    'scope',
    'volume',
    'no-lock',
  ])('present Unix socket refuses %s source evidence without removing it', async (fault) => {
  const f = await socketFixture(
    ['quiescent', 'draining', 'uncertain', 'missing'].includes(fault) ? fault : 'ready',
  );
  try {
    if (fault === 'symlink') {
      await rename(f.socket, f.socket + '.actual');
      await symlink(f.socket + '.actual', f.socket);
    }
    if (fault === 'hardlink') await link(f.socket, f.socket + '.alias');
    if (fault === 'broad') await chmod(f.socket, 0o660);
    const prefix =
      fault === 'scope'
        ? 'OPS_CONFIG[FCD_DATABASE_SCHEMA]=foreign; '
        : fault === 'volume'
          ? 'OPS_CONFIG[FCD_POSTGRES_VOLUME]=fcd-support-other; '
          : fault === 'missing'
            ? 'OPS_DEPLOYMENT_HAS_SELECTION=no; '
            : '';
    const result = f.run('deploy', prefix + 'operations_socket_root', fault !== 'no-lock');
    expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: 'operations_socket_present\n',
    });
    expect((await stat(f.socket)).isSocket()).toBe(true);
    await expect(stat(join(f.root, 'docker-used'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});
