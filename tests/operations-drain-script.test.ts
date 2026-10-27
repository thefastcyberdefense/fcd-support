import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40),
  appImage = `sha256:${'d'.repeat(64)}`,
  pgImage = `sha256:${'e'.repeat(64)}`;
const ref = `selection_${'a'.repeat(32)}`;
const roles = [
  'postgres',
  'fcd-support-api',
  'fcd-support-admin',
  'fcd-support-reply',
  'fcd-support-outbound',
  'fcd-support-notification',
];

test
  .runIf(native)
  .each([
    'ok',
    'admission',
    'admission-adoption',
    'admission-root-container',
    'no-apps',
    'wrong-image',
    'wrong-revision',
    'wrong-entrypoint',
    'foreign-project',
    'duplicate-role',
    'foreign-network',
    'foreign-bind',
    'wrong-admin-mount',
    'wrong-volume',
    'application-volume',
    'volume-recreated',
    'volume-origin',
    'shared-database-bind',
    'wrong-system',
    'changed-after-stop',
    'volume-changed-after-stop',
    'stale-socket',
    'stop-live',
    'stop-ack',
    'remove-failed',
    'remove-ack',
    'no-marker',
    'pending-job',
  ])(
  'owned application drain handles %s with protected state and real Unix filesystem boundaries',
  async (fault) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/drain-script-test-');
    await chmod(root, 0o700);
    for (const name of ['state', 'socket', 'config', 'secrets', 'workspace', 'database'])
      await mkdir(join(root, name), { mode: 0o700 });
    await writeFile(join(root, 'state', 'deployment.lock'), '', { mode: 0o600 });
    const sourceMode = fault.startsWith('admission') ? 'admission' : 'managed';
    const actors = roles
      .filter(
        (role) => sourceMode !== 'admission' || ['postgres', 'fcd-support-api'].includes(role),
      )
      .filter((role) => fault !== 'no-apps' || role === 'postgres')
      .map((service, index) => ({
        id: String(index + 1).repeat(64),
        project: 'fcd-support',
        service,
        revision: service === 'postgres' && sourceMode === 'admission' ? 'none' : revision,
        image: service === 'postgres' ? pgImage : appImage,
        status: 'running',
        running: true,
        paused: false,
        restarting: false,
        dead: false,
        user: service === 'postgres' ? 'postgres' : 'node',
        startedAt: '2030-04-01T00:00:00Z',
        removed: false,
      }));
    const api = actors.find((actor) => actor.service === 'fcd-support-api');
    if (fault !== 'no-apps' && !api) throw new Error('synthetic_api_missing');
    if (fault === 'wrong-image' && api) api.image = `sha256:${'9'.repeat(64)}`;
    if (fault === 'wrong-revision' && api) api.revision = 'b'.repeat(40);
    if (fault === 'foreign-project' && api) api.project = 'fcd-support-foreign';
    if (fault === 'duplicate-role' && api) actors.push({ ...api, id: '7'.repeat(64) });
    const postgres = actors.find((actor) => actor.service === 'postgres');
    if (fault === 'admission-root-container' && postgres) postgres.user = 'root';
    const server = createServer((socket) => socket.destroy());
    let listening = false;
    const socketPath = join(root, 'socket', 'admin.sock');
    try {
      if (actors.some((a) => a.service === 'fcd-support-admin')) {
        await new Promise<void>((done, reject) => {
          server.once('error', reject);
          server.listen(socketPath, done);
        });
        listening = true;
        await chmod(socketPath, 0o600);
      }
      await writeFile(join(root, 'actors.json'), JSON.stringify(actors), { mode: 0o600 });
      await writeFile(join(root, 'fault'), fault, { mode: 0o600 });
      await writeFile(
        join(root, 'docker'),
        `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const root=path.dirname(process.argv[1]),args=process.argv.slice(2),fault=fs.readFileSync(path.join(root,'fault'),'utf8');
const file=path.join(root,'actors.json'),actors=JSON.parse(fs.readFileSync(file,'utf8'));
const save=()=>fs.writeFileSync(file,JSON.stringify(actors));
const trace=s=>fs.appendFileSync(path.join(root,'trace'),s+'\\n');
const last=args.at(-1),format=args[args.indexOf('--format')+1]||'';
const output=v=>process.stdout.write(String(v)+'\\n');
if(args.includes('image')) {
  trace('image');const pg=last==='${pgImage}';if(format.includes('Entrypoint'))output(JSON.stringify([pg?'postgres-entrypoint':'application-entrypoint']));
  else output(last+'/'+(pg&&'${sourceMode}'==='admission'?'none':'${revision}')+'/linux/amd64/'+(pg?('${sourceMode}'==='admission'?'none':'postgres'):'node'));
} else if(args.includes('ps')) {
  trace('list');let list=actors.filter(a=>!a.removed);
  const project=args.find(a=>a.startsWith('label=com.docker.compose.project='))?.split('=').at(-1),service=args.find(a=>a.startsWith('label=com.docker.compose.service='))?.split('=').at(-1);
  if(project)list=list.filter(a=>a.project===project);if(service)list=list.filter(a=>a.service===service);
  if(args.some(a=>a.startsWith('volume=')))list=list.filter(a=>a.service==='postgres');
  output(list.map(a=>a.id).join('\\n')+(['foreign-bind','shared-database-bind'].includes(fault)&&!project&&!service&&!args.some(a=>a.startsWith('volume='))?'\\n'+'f'.repeat(64):''));
} else if(args.includes('network')) {
  trace('network');
  if(format.includes('.Containers'))output(actors.filter(a=>!a.removed&&a.running).map(a=>a.id).join('\\n')+(fault==='foreign-network'?'\\n'+'f'.repeat(64):''));
  else {const key=last.endsWith('-data')?last.slice('fcd-support-'.length,-'-data'.length):'data';output(last+'/bridge/true/fcd-support/'+('${sourceMode}'==='admission'?'data':key+'_data'));}
} else if(args.includes('volume')) {
  trace('volume');if(format.includes('.CreatedAt'))output('fcd-support-original/'+(fault==='volume-recreated'||(fault==='volume-changed-after-stop'&&actors.some(a=>a.removed))?'2030-04-02T00:00:00Z':'2030-04-01T00:00:00Z')+'/local/local/default/'+(fault==='volume-origin'?'fcd-support-foreign':'fcd-support')+'/postgres-data');else output(root+'/database');
} else if(args.includes('inspect')) {
  const a=actors.find(a=>a.id===last&&!a.removed);
  if(!a){if(['foreign-bind','shared-database-bind'].includes(fault)&&last==='f'.repeat(64)){output(root+(fault==='foreign-bind'?'/socket':'/database'));process.exit(0)}process.exit(19)}
  trace('inspect:'+a.service);
  if(format.includes('.Config.Cmd'))output(JSON.stringify(a.service==='postgres'?['postgres']:a.service==='fcd-support-api'?['node','dist/main.js']:a.service==='fcd-support-admin'?['node','dist/admin-main.js']:['node','dist/worker-main.js',a.service.slice('fcd-support-'.length)]));
  else if(format.includes('Entrypoint'))output(JSON.stringify([fault==='wrong-entrypoint'&&a.service==='fcd-support-api'?'foreign-entrypoint':a.service==='postgres'?'postgres-entrypoint':'application-entrypoint']));
  else if(format.includes('.NetworkSettings.Networks'))output('${sourceMode}'==='admission'?'fcd-support-data':['webhook','admin','reply','outbound','notification','operations'].map(k=>'fcd-support-'+k+'-data').join('\\n'));
  else if(format.includes('.HostConfig.PortBindings'))output('0/false');
  else if(format.includes('.Mounts')&&format.includes('.Name'))output(a.service==='postgres'?(fault==='wrong-volume'?'fcd-support-foreign':'fcd-support-original')+' /var/lib/postgresql true':fault==='application-volume'&&a.service==='fcd-support-api'?'fcd-support-foreign /data true':'');
  else if(format.includes('.Mounts')&&format.includes('.Destination'))output(a.service==='fcd-support-admin'&&fault!=='wrong-admin-mount'?'valid':'invalid');
  else if(format.includes('.Mounts'))output(a.service==='fcd-support-admin'?root+'/socket':'');
  else output([a.id,a.project,a.service,a.revision,a.image,a.status,a.running,a.paused,a.restarting,a.dead,a.user,a.startedAt].join('/'));
} else if(args.includes('exec')) {trace('control');output(fault==='wrong-system'?'2222222222222222222':'1111111111111111111');}
else if(args.includes('stop')) {
  const a=actors.find(a=>a.id===last&&!a.removed);if(!a)process.exit(19);trace('stop:'+a.service);
  if(fault==='stop-live'&&a.service==='fcd-support-reply')process.exit(19);
  a.status='exited';a.running=false;
  if(a.service==='fcd-support-admin'&&fault!=='stale-socket')fs.unlinkSync(path.join(root,'socket','admin.sock'));
  if(fault==='changed-after-stop'&&a.service==='fcd-support-reply')actors.find(a=>a.service==='fcd-support-api').id='8'.repeat(64);
  save();if(fault==='stop-ack'&&a.service==='fcd-support-reply')process.exit(19);
} else if(args.includes('rm')) {
  const a=actors.find(a=>a.id===last&&!a.removed);if(!a)process.exit(19);trace('remove:'+a.service);
  if(fault==='remove-failed')process.exit(19);a.removed=true;save();if(fault==='remove-ack')process.exit(19);
} else {trace('unexpected');process.exit(19)}
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
[FCD_POSTGRES_VOLUME]=fcd-support-original [FCD_SUPPORT_REVISION]=${'b'.repeat(40)})
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/state/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
${fault === 'admission-adoption' ? `source "$TASK_ADOPTION"; operations_adopt_admission ${revision} ${appImage} ${pgImage}` : `${fault === 'no-marker' ? 'operations_selection_create' : 'operations_selection_adopt_draining'} ${ref} fcd-support-original fcd-support postgres-data 2030-04-01T00:00:00Z 1111111111111111111 fcd_support ${revision} 000016`}
${fault === 'pending-job' ? 'printf synthetic_uncertain_job > "$TASK_ROOT/state/active-job";' : ''}
operations_drain_owned_applications ${revision} ${appImage} ${pgImage} ${sourceMode}
`,
        ],
        {
          encoding: 'utf8',
          // This matrix starts many separately bounded native subprocesses.
          // Allow host scheduling overhead without changing command deadlines.
          timeout: 30000,
          env: {
            PATH: root + ':' + (process.env.PATH ?? ''),
            TASK_ROOT: root,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_STATE: resolve('scripts/operations-deployment-state.sh'),
            TASK_LIBRARY: resolve('scripts/operations-drain.sh'),
            TASK_ADOPTION: resolve('scripts/operations-adoption.sh'),
          },
        },
      );
      const success = [
        'ok',
        'admission',
        'admission-adoption',
        'no-apps',
        'stop-ack',
        'remove-ack',
      ].includes(fault);
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: success ? 0 : 1,
        stdout: '',
        stderr: success ? '' : 'operations_drain_refused\n',
      });
      const trace = (await readFile(join(root, 'trace'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(trace).not.toContain('unexpected');
      expect(trace).not.toContain('stop:postgres');
      expect(trace).not.toContain('remove:postgres');
      const current = JSON.parse(
        await readFile(join(root, 'actors.json'), 'utf8'),
      ) as typeof actors;
      if (success) {
        const drained =
          sourceMode === 'admission'
            ? ['api']
            : fault === 'no-apps'
              ? []
              : ['reply', 'outbound', 'notification', 'admin', 'api'];
        expect(trace.filter((p) => p.startsWith('stop:') || p.startsWith('remove:'))).toEqual([
          ...drained.map((role) => `stop:fcd-support-${role}`),
          ...drained.map((role) => `remove:fcd-support-${role}`),
        ]);
        expect(current.filter((a) => !a.removed).map((a) => a.service)).toEqual(['postgres']);
        expect(await readFile(join(root, 'state', 'deployment-state'), 'utf8')).toContain(
          'STATE_PHASE=quiescent\n',
        );
      } else {
        expect(await readFile(join(root, 'state', 'deployment-state'), 'utf8')).toContain(
          `STATE_PHASE=${fault === 'no-marker' ? 'quiescent' : 'uncertain'}\n`,
        );
        if (['no-marker', 'pending-job'].includes(fault)) expect(trace).toEqual([]);
        if (
          ![
            'changed-after-stop',
            'volume-changed-after-stop',
            'stale-socket',
            'stop-live',
            'remove-failed',
          ].includes(fault)
        )
          expect(trace.filter((p) => p.startsWith('stop:') || p.startsWith('remove:'))).toEqual([]);
        else expect(trace).toContain('stop:fcd-support-reply');
        if (fault === 'stale-socket') {
          expect(trace.filter((p) => p.startsWith('remove:'))).toEqual([]);
          expect(
            current.some((a) => a.service === 'fcd-support-admin' && !a.removed && !a.running),
          ).toBe(true);
        }
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
  35000,
);
