import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  image = `sha256:${'d'.repeat(64)}`;
const reference = `selection_${'a'.repeat(32)}`;

test
  .runIf(native)
  .each([
    'ok',
    'pending-job',
    'already-exited',
    'no-apps',
    'stop-ack',
    'wrong-image',
    'wrong-revision',
    'wrong-command',
    'wrong-entrypoint',
    'changed-actor',
    'stop-live',
    'ready-scope',
    'wrong-selection',
    'bad-admin-bind',
  ])(
  'partial-start containment handles %s without mutating PostgreSQL, storage or job evidence',
  async (fault) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/containment-test-');
    await chmod(root, 0o700);
    for (const name of ['state', 'socket', 'config', 'secrets', 'workspace', 'actors'])
      await mkdir(join(root, name), { mode: 0o700 });
    await writeFile(join(root, 'state', 'deployment.lock'), '', { mode: 0o600 });
    await writeFile(join(root, 'fault'), fault, { mode: 0o600 });
    const services =
      fault === 'no-apps'
        ? ['postgres']
        : ['postgres', 'fcd-support-api', 'fcd-support-admin', 'fcd-support-reply'];
    for (const [index, role] of services.entries()) {
      const id = String(index + 1).repeat(64);
      const row = [
        id,
        'fcd-support',
        role,
        fault === 'wrong-revision' && role === 'fcd-support-api' ? 'b'.repeat(40) : revision,
        role === 'postgres'
          ? `sha256:${'f'.repeat(64)}`
          : fault === 'wrong-image' && role === 'fcd-support-api'
            ? `sha256:${'9'.repeat(64)}`
            : image,
        fault === 'already-exited' && role !== 'postgres' ? 'exited/false' : 'running/true',
        'false/false/false',
        role === 'postgres' ? 'postgres' : 'node',
        '2030-04-01T00:00:00Z',
      ].join('/');
      await writeFile(join(root, 'actors', role), row, { mode: 0o600 });
    }
    const server = createServer((socket) => {
      socket.destroy();
    });
    let listening = false;
    let socketIdentity = '';
    try {
      if (services.includes('fcd-support-admin')) {
        await new Promise<void>((done, reject) => {
          server.once('error', reject);
          server.listen(join(root, 'socket', 'admin.sock'), done);
        });
        listening = true;
        await chmod(join(root, 'socket', 'admin.sock'), 0o600);
        const entry = await stat(join(root, 'socket', 'admin.sock'));
        socketIdentity = `${String(entry.dev)}:${String(entry.ino)}`;
      }
      await writeFile(
        join(root, 'docker'),
        `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"; fault="$(<"$scope/fault")"; last="\${!#}"
trace() { printf '%s\\n' "$1" >> "$scope/trace"; }
case " $* " in
  *' image inspect '*)
    if [[ " $* " == *Entrypoint* ]]; then printf '["application-entrypoint"]\\n'; else printf '${image}/${revision}/linux/amd64/node\\n'; fi ;;
  *' ps '*) for file in "$scope"/actors/*; do row="$(<"$file")"; printf '%s\\n' "\${row%%/*}"; done ;;
  *' container inspect '*|*' stop '*)
    file=''; for candidate in "$scope"/actors/*; do row="$(<"$candidate")"; [[ "\${row%%/*}" != "$last" ]] || { file="$candidate"; break; }; done
    [[ -n "$file" ]] || exit 19
    role="\${file##*/}"
    if [[ " $* " == *' stop '* ]]; then
      trace "stop:$role"; [[ "$role" != postgres ]] || { trace unexpected; exit 19; }
      [[ "$fault" != stop-live || "$role" != fcd-support-reply ]] || exit 19
      printf '%s' "$row" | sed 's@/running/true/@/exited/false/@' > "$file"
      if [[ "$fault" == changed-actor && "$role" == fcd-support-reply ]]; then sed -i 's/2030-04-01T00:00:00Z/2030-04-01T00:01:00Z/' "$scope/actors/fcd-support-api"; fi
      [[ "$fault" != stop-ack || "$role" != fcd-support-reply ]] || exit 19
    elif [[ " $* " == *'.Config.Cmd'* ]]; then
      if [[ "$fault" == wrong-command && "$role" == fcd-support-api ]]; then printf '["node","dist/worker-main.js","outbound"]\\n'
      elif [[ "$role" == fcd-support-api ]]; then printf '["node","dist/main.js"]\\n'
      elif [[ "$role" == fcd-support-admin ]]; then printf '["node","dist/admin-main.js"]\\n'
      else printf '["node","dist/worker-main.js","reply"]\\n'; fi
    elif [[ " $* " == *Entrypoint* ]]; then
      if [[ "$fault" == wrong-entrypoint && "$role" == fcd-support-api ]]; then printf '["foreign-entrypoint"]\\n'; else printf '["application-entrypoint"]\\n'; fi
    elif [[ " $* " == *'.Mounts'* ]]; then
      if [[ "$fault" == bad-admin-bind ]]; then printf invalid; else printf valid; fi
    else printf '%s\\n' "$row"; fi ;;
  *) trace unexpected; exit 19 ;;
esac
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
source "$TASK_STATE"
source "$TASK_LIBRARY"
OPS_ROOT="$TASK_ROOT/workspace"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT/state" [FCD_RUNTIME_PROJECT]=fcd-support [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public
[FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_ADMIN_SOCKET_ROOT]="$TASK_ROOT/socket" [FCD_CONFIG_ROOT]="$TASK_ROOT/config" [FCD_SECRET_ROOT]="$TASK_ROOT/secrets"
[FCD_POSTGRES_VOLUME]=fcd-support-selected [FCD_SUPPORT_REVISION]=${revision} [FCD_SUPPORT_IMAGE]=${image})
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/state/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
operations_selection_create ${reference} fcd-support-selected fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${fault === 'wrong-selection' ? 'b'.repeat(40) : revision} 000016
operations_selection_starting ${reference} ${fault === 'wrong-selection' ? 'b'.repeat(40) : revision} 000016
${fault === 'ready-scope' ? `operations_selection_ready ${reference}` : `operations_selection_uncertain ${reference}`}
${fault === 'pending-job' ? 'printf synthetic_unresolved_job > "$TASK_ROOT/state/active-job";' : ''}
operations_contain_private_runtime ${image}
`,
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            PATH: root + ':' + (process.env.PATH ?? ''),
            TASK_ROOT: root,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_STATE: resolve('scripts/operations-deployment-state.sh'),
            TASK_LIBRARY: resolve('scripts/operations-containment.sh'),
          },
        },
      );
      const success = ['ok', 'pending-job', 'already-exited', 'no-apps', 'stop-ack'].includes(
        fault,
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: success ? 0 : 1,
        stdout: '',
        stderr: success ? '' : 'operations_containment_refused\n',
      });
      const trace = (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(trace).not.toContain('unexpected');
      expect(trace).not.toContain('stop:postgres');
      if (fault === 'pending-job')
        expect(await readFile(join(root, 'state', 'active-job'), 'utf8')).toBe(
          'synthetic_unresolved_job',
        );
      if (['ready-scope', 'wrong-selection', 'already-exited', 'no-apps'].includes(fault))
        expect(trace).toEqual([]);
      const unknown = [
        'wrong-image',
        'wrong-revision',
        'wrong-command',
        'wrong-entrypoint',
        'changed-actor',
      ].includes(fault)
        ? 'fcd-support-api'
        : fault === 'bad-admin-bind'
          ? 'fcd-support-admin'
          : undefined;
      if (unknown) {
        expect(trace).not.toContain(`stop:${unknown}`);
        expect(await readFile(join(root, 'actors', unknown), 'utf8')).toContain('/running/true/');
        expect(trace).toContain('stop:fcd-support-reply');
      }
      if (success && fault !== 'no-apps')
        for (const role of services.filter((name) => name !== 'postgres'))
          expect(await readFile(join(root, 'actors', role), 'utf8')).toContain('/exited/false/');
      expect(await readFile(join(root, 'actors', 'postgres'), 'utf8')).toContain('/running/true/');
      if (listening) {
        const entry = await stat(join(root, 'socket', 'admin.sock'));
        expect(entry.isSocket()).toBe(true);
        expect(`${String(entry.dev)}:${String(entry.ino)}`).toBe(socketIdentity);
      }
    } finally {
      if (listening)
        await new Promise<void>((done, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else done();
          });
        });
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
