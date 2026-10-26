import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
const revision = 'a'.repeat(40);
const cid = 'b'.repeat(64);
const image = `sha256:${'d'.repeat(64)}`;
const ack = '{"status":"completed","processed":1,"reasonCode":"ok"}';

async function fixture(fault = 'none') {
  const root = await mkdtemp('/var/lib/fcd-support/backups/job-lifecycle-test-');
  await chmod(root, 0o700);
  await writeFile(join(root, 'deployment.lock'), '', { mode: 0o600 });
  await writeFile(join(root, 'fault'), fault, { mode: 0o600 });
  await writeFile(
    join(root, 'docker'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root=path.dirname(process.argv[1]);
const args=process.argv.slice(2), fault=fs.readFileSync(path.join(root,'fault'),'utf8');
const trace=(s)=>fs.appendFileSync(path.join(root,'trace'),s+'\\n');
const file=path.join(root,'container');
const load=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const save=(c)=>fs.writeFileSync(file,JSON.stringify(c));
if(args.includes('compose')) {
  trace('create');
  const files=args.flatMap((a,i)=>a==='--file'?[args[i+1]]:[]);
  const override=JSON.parse(fs.readFileSync(files.at(-1),'utf8'));
  const [service,s]=Object.entries(override.services)[0];
  const c={id:'${cid}',image:s.image,service,project:args[args.indexOf('--project-name')+1],labels:s.labels,command:s.command,environment:s.environment,stdin_open:s.stdin_open??false,phase:'created',exit:0};
  fs.writeFileSync(path.join(root,'created-contract'),JSON.stringify({command:c.command,stdin_open:c.stdin_open}));
  if(fault==='wrong-owner') c.labels['fcd-support.operation.parent']='fcd-support-foreign';
  if(fault==='wrong-command') c.command=['node','dist/operations-main.js','foreign'];
  if(fault==='wrong-image') c.image='sha256:${'e'.repeat(64)}';
  if(fault==='wrong-project') c.project='fcd-support-foreign';
  if(fault==='wrong-service') c.service='foreign';
  if(fault==='already-running') c.phase='running';
  if(fault!=='create-before') save(c);
  if(fault.startsWith('create-')) process.exit(19);
} else if(args.includes('image')) {
  trace('image'); console.log('${image}/${revision}/linux/amd64');
} else if(args.includes('ps')) {
  trace('discover');
  if(fs.existsSync(file)) console.log('${cid}');
  if(fault==='duplicate') console.log('${'c'.repeat(64)}');
  if(fault==='absence-error'&&!fs.existsSync(file)) process.exit(19);
} else if(args.includes('inspect')) {
  if(!fs.existsSync(file)) process.exit(19);
  const c=load(), format=args[args.indexOf('--format')+1];
  if(format.includes('.Config.Cmd')) { trace('command'); console.log(JSON.stringify(c.command)); }
  else if(format.includes('.State.ExitCode')) { trace('exit'); console.log(c.phase+'/'+c.exit); }
  else {
    trace('inspect');
    const l=c.labels;
    const fields=[c.id,c.image,l['org.opencontainers.image.revision'],l['fcd-support.operation.ref'],l['fcd-support.operation.parent'],l['fcd-support.operation.service'],l['fcd-support.operation.command'],c.phase,'false','false','false'];
    if(format.includes('com.docker.compose.project')) fields.push(c.project,c.service);
    console.log(fields.join('/'));
  }
} else if(args.includes('start')) {
  trace('start'); const c=load(); c.phase='running'; save(c);
  fs.writeFileSync(path.join(root,'start-contract'),JSON.stringify({args,input:args.includes('--interactive')?fs.readFileSync(0,'utf8'):''}));
  if(fault==='start-ack') process.exit(19);
  if(fault==='controller-killed') process.kill(Number(fs.readFileSync(path.join(root,'controller-pid'),'utf8')),'SIGKILL');
} else if(args.includes('wait')) {
  trace('wait'); const c=load();
  if(['wait-ack','cannot-stop'].includes(fault)) process.exit(19);
  c.phase='exited'; c.exit=fault==='job-failed'?1:0; save(c); console.log(c.exit);
} else if(args.includes('logs')) {
  trace('logs');
  console.log(fault==='unsafe-output'?'synthetic_unexpected_diagnostic':fault==='database-down'?'{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}':fault==='not-due'?'{"status":"skipped","processed":0,"reasonCode":"not_due"}':'${ack}');
} else if(args.includes('stop')) {
  trace('stop'); if(fault==='cannot-stop') process.exit(19);
  const c=load(); c.phase='exited'; save(c);
} else if(args.includes('rm')) {
  trace('remove'); if(fault==='remove-ack') process.exit(19);
  fs.unlinkSync(file);
} else process.exit(19);
`,
    { mode: 0o700 },
  );
  const run = (body = 'operations_execute_job migrate migrate') =>
    spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
declare -A OPS_CONFIG=([FCD_STATE_ROOT]="$TASK_ROOT" [FCD_RUNTIME_PROJECT]=fcd-support-runtime [FCD_SUPPORT_REVISION]=${revision}
[FCD_OPERATIONS_IMAGE]=synthetic-operations [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000
[FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_test [FCD_SCHEMA_REVISION]=000001)
OPS_ROOT=/workspace; OPS_DATABASE_SYSTEM_IDENTIFIER=1111111111111111111
printf '%s' "$BASHPID" > "$TASK_ROOT/controller-pid"
exec {OPS_LOCK_DESCRIPTOR}<>"$TASK_ROOT/deployment.lock"; flock --nonblock "$OPS_LOCK_DESCRIPTOR"
${body}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 12000,
        env: {
          PATH: root + ':' + (process.env.PATH ?? ''),
          TASK_ROOT: root,
          TASK_COMMON: resolve('scripts/operations-common.sh'),
          TASK_LIBRARY: resolve('scripts/operations-job-lifecycle.sh'),
        },
      },
    );
  return {
    root,
    run,
    trace: async () => (await readFile(join(root, 'trace'), 'utf8')).trim().split('\n'),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test.runIf(native)(
  'a stopped owned job is recorded before start and acknowledged only after verified removal',
  async () => {
    const f = await fixture();
    try {
      const result = f.run();
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: ack + '\n',
        stderr: '',
      });
      const trace = await f.trace();
      expect(trace.indexOf('inspect')).toBeLessThan(trace.indexOf('start'));
      expect(trace.indexOf('command')).toBeLessThan(trace.indexOf('start'));
      expect(trace.indexOf('exit')).toBeLessThan(trace.indexOf('remove'));
      expect(trace.at(-1)).toBe('discover');
      expect(await readdir(f.root)).not.toContain('active-job');
      expect((await readdir(f.root)).filter((n) => n.endsWith('.json'))).toEqual([]);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'health uses its standalone entry and interactive stdin through the complete owned-job lifecycle',
  async () => {
    const f = await fixture('database-down');
    try {
      const input =
        '{"outageGap":{"startedAt":"2030-01-01T00:00:00.000Z","lastObservedAt":"2030-01-01T00:05:00.000Z"}}';
      const result = f.run(
        `OPS_HEALTH_INPUT_JSON='${input}'\noperations_execute_job health health`,
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}\n',
        stderr: '',
      });
      expect(JSON.parse(await readFile(join(f.root, 'created-contract'), 'utf8'))).toEqual({
        command: ['node', 'dist/operations/health-main.js', 'health'],
        stdin_open: true,
      });
      expect(JSON.parse(await readFile(join(f.root, 'start-contract'), 'utf8'))).toEqual({
        args: ['container', 'start', '--attach', '--interactive', cid],
        input,
      });
      expect(await readdir(f.root)).not.toContain('active-job');
      expect(await readdir(f.root)).not.toContain('container');
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native).each(['migrate', 'maintenance'])(
  'dependency_unavailable from %s preserves uncertainty',
  async (service) => {
    const f = await fixture('database-down');
    try {
      const result = f.run(
        `operations_execute_job ${service} ${service === 'migrate' ? 'migrate' : 'retention'}`,
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 1,
        stdout: '',
        stderr: 'operations_job_uncertain\n',
      });
      expect(await readFile(join(f.root, 'active-job'), 'utf8')).toContain('JOB_PHASE=uncertain\n');
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'already-completed maintenance slots accept only their fixed skipped acknowledgement',
  async () => {
    const f = await fixture('not-due');
    try {
      const result = f.run(
        'operations_execute_job maintenance learning scheduled:learning:1900000000 2030-03-17T17:46:40.000Z',
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: '{"status":"skipped","processed":0,"reasonCode":"not_due"}\n',
        stderr: '',
      });
      expect(await readdir(f.root)).not.toContain('active-job');
      expect(JSON.parse(await readFile(join(f.root, 'start-contract'), 'utf8'))).toEqual({
        args: ['container', 'start', cid],
        input: '',
      });
    } finally {
      await f.dispose();
    }
  },
);

test
  .runIf(native)
  .each([
    'create-before',
    'create-after',
    'wrong-owner',
    'wrong-command',
    'wrong-image',
    'wrong-project',
    'wrong-service',
    'already-running',
    'duplicate',
    'start-ack',
    'wait-ack',
    'job-failed',
    'unsafe-output',
    'remove-ack',
    'absence-error',
    'cannot-stop',
  ])(
  'job failure %s preserves uncertainty without a success acknowledgement or replay',
  async (fault) => {
    const f = await fixture(fault);
    try {
      const result = f.run();
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 1,
        stdout: '',
        stderr: 'operations_job_uncertain\n',
      });
      const before = await f.trace();
      const marker = await readFile(join(f.root, 'active-job'), 'utf8');
      expect(marker).toContain('JOB_PHASE=uncertain\n');
      if (
        [
          'create-before',
          'create-after',
          'wrong-owner',
          'wrong-command',
          'wrong-image',
          'wrong-project',
          'wrong-service',
          'already-running',
          'duplicate',
        ].includes(fault)
      )
        expect(before).not.toContain('start');
      if (
        [
          'wrong-owner',
          'wrong-command',
          'wrong-image',
          'wrong-project',
          'wrong-service',
          'already-running',
          'duplicate',
        ].includes(fault)
      )
        expect(before).not.toContain('remove');
      if (['start-ack', 'wait-ack'].includes(fault)) expect(before).toContain('stop');
      if (fault === 'cannot-stop') {
        expect(before).toContain('stop');
        expect(before).not.toContain('remove');
        expect(await readFile(join(f.root, 'container'), 'utf8')).toContain('"phase":"running"');
      }
      expect(f.run().status).toBe(1);
      expect(await f.trace()).toEqual(before);
      expect(await readFile(join(f.root, 'active-job'), 'utf8')).toBe(marker);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'a killed controller leaves the started job recorded and blocks a new mutating attempt',
  async () => {
    const f = await fixture('controller-killed');
    try {
      const result = f.run();
      expect(result.signal).toBe('SIGKILL');
      expect(result.stdout).toBe('');
      const marker = await readFile(join(f.root, 'active-job'), 'utf8');
      expect(marker).toContain('JOB_PHASE=started\n');
      expect(marker).toContain(`JOB_CONTAINER=${cid}\n`);
      const before = await f.trace();
      expect(f.run().status).toBe(1);
      expect(await f.trace()).toEqual(before);
    } finally {
      await f.dispose();
    }
  },
);

test.runIf(native)(
  'untrusted command arguments are refused before journal or Docker access',
  async () => {
    const f = await fixture();
    try {
      const result = f.run('operations_execute_job migrate "$(printf \'unsafe;argument\')"');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('operations_job_arguments_invalid\n');
      expect(await readdir(f.root)).not.toContain('trace');
      expect(await readdir(f.root)).not.toContain('active-job');
    } finally {
      await f.dispose();
    }
  },
);
