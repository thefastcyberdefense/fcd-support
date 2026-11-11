import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { reapChildProcesses, waitForExit } from './helpers/process-lifecycle.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const scriptPath = resolve('scripts/test-health-stdio-docker.sh').replaceAll('\\', '/');
const imageId = `sha256:${'b'.repeat(64)}`;
const revision = 'a'.repeat(40);
const postgresImage =
  'postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await reapChildProcesses(children.splice(0), {
    termTimeoutMs: 500,
    killTimeoutMs: 500,
    processGroup: process.platform !== 'win32',
  });
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function runBoundedHarness(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 3500,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(bash, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const onStdout = (chunk: Buffer | string) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  };
  const onStderr = (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  try {
    const exit = await waitForExit(child, { timeoutMs });
    return { status: exit.code, stdout, stderr };
  } finally {
    child.stdout.off('data', onStdout);
    child.stderr.off('data', onStderr);
  }
}

async function createHermeticDockerFixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'fcd-health-docker-harness-'));
  roots.push(root);
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const bin = join(root, 'bin');
  const tmp = join(root, 'tmp');
  const stateDir = join(root, 'fake-docker');
  const stateFile = join(stateDir, 'state.json');
  await mkdir(bin, { mode: 0o755 });
  await mkdir(tmp, { mode: 0o755 });
  await mkdir(stateDir, { mode: 0o755 });

  const statePosix = stateDir.replaceAll('\\', '/');
  const mockJsPath = join(root, 'fake-docker.mjs').replaceAll('\\', '/');
  const nodePosix = process.execPath.replaceAll('\\', '/');

  await writeFile(
    mockJsPath,
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = ${JSON.stringify(statePosix)};
const mode = ${JSON.stringify(mode)};
function resolveHostPath(p) {
  return process.platform === 'win32' && typeof p === 'string' && p.startsWith('/tmp/')
    ? path.join(os.tmpdir(), p.slice(5))
    : p;
}
const expectedOpsImage = ${JSON.stringify(imageId)};
const expectedRevision = ${JSON.stringify(revision)};
const expectedPgImage = ${JSON.stringify(postgresImage)};
const canaryContainerId = 'e'.repeat(64);
const canaryNetworkId = 'f'.repeat(64);
const canaryVolume = 'canary_unrelated_volume';

const stateFile = path.join(stateDir, 'state.json');
function loadState() {
  if (!fs.existsSync(stateFile)) {
    return {
      seq: 0,
      containers: {
        [canaryContainerId]: {
          id: canaryContainerId,
          name: 'canary-container',
          image: expectedPgImage,
          labels: { 'fcd-support.canary': 'keep' },
          status: 'running',
          exitCode: 0,
          cmd: ['sleep'],
        },
      },
      networks: {
        [canaryNetworkId]: {
          id: canaryNetworkId,
          name: 'canary-net',
          labels: { 'fcd-support.canary': 'keep' },
        },
      },
      volumes: {
        [canaryVolume]: {
          name: canaryVolume,
          driver: 'local',
          scope: 'local',
          labels: { 'fcd-support.canary': 'keep' },
        },
      },
      mutations: [],
    };
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}
function saveState(s) {
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}
function recordMutation(s, entry) {
  s.mutations.push(entry);
  fs.appendFileSync(path.join(stateDir, 'mutations.log'), entry + '\\n');
}
function parseLabels(args) {
  const labels = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--label' && args[i + 1]) {
      const kv = args[i + 1];
      const eq = kv.indexOf('=');
      if (eq > 0) labels[kv.slice(0, eq)] = kv.slice(eq + 1);
      i += 1;
    }
  }
  return labels;
}
function getFilters(args) {
  const filters = [];
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--filter' || args[i] === '-f') && args[i + 1]) {
      filters.push(args[i + 1]);
      i += 1;
    }
  }
  return filters;
}
function seedCollisionIfNeeded(s, scope) {
  if (mode !== 'collision' || s.collisionSeeded || !scope) return;
  s.collisionSeeded = true;
  const colCid = 'a'.repeat(64);
  s.containers[colCid] = {
    id: colCid,
    name: scope + '-postgres',
    image: expectedPgImage,
    labels: { 'fcd-support.health-stdio-test': scope },
    status: 'running',
    exitCode: 0,
    cmd: ['postgres'],
  };
  const colNid = 'b'.repeat(64);
  s.networks[colNid] = {
    id: colNid,
    name: scope + '-operations-data',
    labels: { 'fcd-support.health-stdio-test': scope },
  };
  s.volumes[scope + '-backups'] = {
    name: scope + '-backups',
    driver: 'local',
    scope: 'local',
    labels: { 'fcd-support.health-stdio-test': scope },
  };
  saveState(s);
}

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--host' ? rawArgs.slice(2) : rawArgs;
const s = loadState();

if (args[0] === 'image' && args[1] === 'inspect') {
  const fmt = args[args.indexOf('--format') + 1] ?? '';
  if (fmt.includes('.Os')) {
    process.stdout.write(expectedOpsImage + '/' + expectedRevision + '/linux/amd64\\n');
  } else {
    process.stdout.write('none/node\\n');
  }
  process.exit(0);
}

if (args[0] === 'ps') {
  const filters = getFilters(args);
  for (const f of filters) {
    const m = /^name=\\^\\/(.+)-postgres\\$$/u.exec(f);
    if (m) seedCollisionIfNeeded(s, m[1]);
    const lm = /^label=fcd-support\\.(?:health-stdio-test|operation\\.parent)=(.+)$/u.exec(f);
    if (lm) seedCollisionIfNeeded(s, lm[1]);
  }
  const formatIdx = args.indexOf('--format');
  const format = formatIdx >= 0 ? args[formatIdx + 1] : '';
  const list = Object.values(s.containers).filter((c) =>
    filters.every((f) => {
      if (f.startsWith('name=')) {
        const pat = f.slice(5).replace(/^\\^\\/?|\\$$/g, '');
        return c.name === pat;
      }
      if (f.startsWith('label=')) {
        const kv = f.slice(6);
        const eq = kv.indexOf('=');
        return c.labels[kv.slice(0, eq)] === kv.slice(eq + 1);
      }
      if (f.startsWith('volume=')) {
        return c.volume === f.slice(7);
      }
      return true;
    }),
  );
  for (const c of list) {
    process.stdout.write((format === '{{.Names}}' ? c.name : c.id) + '\\n');
  }
  process.exit(0);
}

if (args[0] === 'network') {
  const sub = args[1];
  const filters = getFilters(args);
  for (const f of filters) {
    const m = /^name=\\^(.+)-operations-data\\$$/u.exec(f);
    if (m) seedCollisionIfNeeded(s, m[1]);
  }
  if (sub === 'ls') {
    const fmtIdx = args.indexOf('--format');
    const fmt = fmtIdx >= 0 ? args[fmtIdx + 1] : '{{.ID}}';
    const list = Object.values(s.networks).filter((n) =>
      filters.every((f) => {
        if (f.startsWith('name=')) {
          const pat = f.slice(5).replace(/^\\^|\\$$/g, '');
          return n.name === pat;
        }
        if (f.startsWith('label=')) {
          const kv = f.slice(6);
          const eq = kv.indexOf('=');
          return n.labels[kv.slice(0, eq)] === kv.slice(eq + 1);
        }
        return true;
      }),
    );
    for (const n of list) {
      process.stdout.write((fmt === '{{.Name}}' ? n.name : n.id) + '\\n');
    }
    process.exit(0);
  }
  if (sub === 'inspect') {
    const target = args[args.length - 1];
    const found = s.networks[target] ?? Object.values(s.networks).find((n) => n.name === target);
    if (!found) process.exit(1);
    const fmtIdx = args.indexOf('--format');
    const fmt = fmtIdx >= 0 ? args[fmtIdx + 1] : '{{.Id}}';
    const sep = fmt.includes('|') ? '|' : '/';
    if (fmt.includes('.Id') && fmt.includes('.Name')) {
      process.stdout.write(
        [found.id, found.name, found.labels['fcd-support.health-stdio-test'] ?? ''].join(sep) + '\\n',
      );
    } else if (fmt.includes('.Id')) {
      process.stdout.write(found.id + '\\n');
    } else {
      process.stdout.write((found.labels['fcd-support.health-stdio-test'] ?? '') + '\\n');
    }
    process.exit(0);
  }
  if (sub === 'rm') {
    for (const target of args.slice(2).filter((a) => !a.startsWith('-'))) {
      recordMutation(s, 'network/rm ' + target);
      const entry = s.networks[target] ?? Object.values(s.networks).find((n) => n.name === target);
      if (entry) delete s.networks[entry.id];
    }
    saveState(s);
    process.exit(0);
  }
}

if (args[0] === 'volume') {
  const sub = args[1];
  const filters = getFilters(args);
  for (const f of filters) {
    const m = /^name=\\^(.+)-(?:backups|postgres)\\$$/u.exec(f);
    if (m) seedCollisionIfNeeded(s, m[1]);
  }
  if (sub === 'ls') {
    const list = Object.values(s.volumes).filter((v) =>
      filters.every((f) => {
        if (f.startsWith('name=')) {
          const pat = f.slice(5).replace(/^\\^|\\$$/g, '');
          return v.name === pat;
        }
        if (f.startsWith('label=')) {
          const kv = f.slice(6);
          const eq = kv.indexOf('=');
          return v.labels[kv.slice(0, eq)] === kv.slice(eq + 1);
        }
        return true;
      }),
    );
    for (const v of list) process.stdout.write(v.name + '\\n');
    process.exit(0);
  }
  if (sub === 'inspect') {
    const target = args[args.length - 1];
    const found = s.volumes[target];
    if (!found) process.exit(1);
    const fmt = args[args.indexOf('--format') + 1] ?? '';
    const sep = fmt.includes('|') ? '|' : '/';
    process.stdout.write(
      [found.name, found.driver, found.scope, found.labels['fcd-support.health-stdio-test'] ?? '', ...(fmt.includes('.CreatedAt') ? [found.createdAt ?? '2026-11-11T00:00:01Z'] : [])].join(sep) + '\\n',
    );
    process.exit(0);
  }
  if (sub === 'rm') {
    for (const target of args.slice(2).filter((a) => !a.startsWith('-'))) {
      recordMutation(s, 'volume/rm ' + target);
      delete s.volumes[target];
    }
    saveState(s);
    process.exit(0);
  }
}

if (args[0] === 'container' && args[1] === 'inspect') {
  const target = args[args.length - 1];
  const c = s.containers[target];
  if (!c) process.exit(1);
  const fmt = args[args.indexOf('--format') + 1] ?? '';
  const sep = fmt.includes('|') ? '|' : '/';
  if (fmt.includes('.Id') && fmt.includes('operation.parent')) {
    process.stdout.write(
      [
        c.id,
        '/' + c.name,
        c.labels['fcd-support.health-stdio-test'] ?? '',
        c.labels['fcd-support.operation.parent'] ?? '',
        c.labels['fcd-support.operation.ref'] ?? '',
        c.labels['org.opencontainers.image.revision'] ?? '',
        c.image,
        ...(fmt.includes('operation.service') ? [c.labels['fcd-support.operation.service'] ?? '', c.labels['fcd-support.operation.command'] ?? '', c.configImage ?? c.image] : []),
      ].join(sep) + '\\n',
    );
  } else {
    process.stdout.write(c.id + '\\n');
  }
  process.exit(0);
}

if (args[0] === 'rm') {
  for (const target of args.slice(1).filter((a) => !a.startsWith('-'))) {
    recordMutation(s, 'container/rm ' + target);
    if (!s.stickyContainers || !s.stickyContainers.includes(target)) {
      delete s.containers[target];
    }
  }
  saveState(s);
  process.exit(0);
}

process.stderr.write('unexpected_fake_docker_call ' + args.join(' ') + '\\n');
process.exit(1);
`,
    { mode: 0o600 },
  );

  const osTmpPosix = tmpdir().replaceAll('\\', '/');
  const sysRootPosix = (process.env.SystemRoot ?? 'C:\\Windows').replaceAll('\\', '/');
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/bash
export SystemRoot='${sysRootPosix}' TEMP='${osTmpPosix}' TMP='${osTmpPosix}'
exec '${nodePosix}' '${mockJsPath}' "$@"
`,
    { mode: 0o700 },
  );

  return { root, bin, tmp, stateDir, stateFile };
}

async function seedFakeDockerState(
  stateFile: string,
  mutate: (state: Record<string, unknown>) => void,
) {
  const raw = await readFile(stateFile, 'utf8').catch(() => '');
  const state: Record<string, unknown> =
    raw.length > 0
      ? (JSON.parse(raw) as Record<string, unknown>)
      : {
          seq: 0,
          containers: {
            ['e'.repeat(64)]: {
              id: 'e'.repeat(64),
              name: 'canary-container',
              image: postgresImage,
              labels: { 'fcd-support.canary': 'keep' },
              status: 'running',
              exitCode: 0,
            },
          },
          networks: {
            ['f'.repeat(64)]: {
              id: 'f'.repeat(64),
              name: 'canary-net',
              labels: { 'fcd-support.canary': 'keep' },
            },
          },
          volumes: {
            canary_unrelated_volume: {
              name: 'canary_unrelated_volume',
              driver: 'local',
              scope: 'local',
              labels: { 'fcd-support.canary': 'keep' },
            },
          },
          mutations: [],
        };
  mutate(state);
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

describe('scripts/test-health-stdio-docker.sh harness controls', () => {
  test('passes bash syntax check and contains no mocked state/config/stat stubs or --rm initializers', async () => {
    execFileSync(bash, ['-n', scriptPath], { stdio: 'pipe' });
    const src = await readFile(scriptPath, 'utf8');
    expect(src).not.toMatch(/operations_config_field\s*\(\)/u);
    expect(src).not.toMatch(
      /operations_job_state_(?:root|begin|sync|transition|read|clear)\s*\(\)/u,
    );
    expect(src).not.toMatch(/^\s*stat\s*\(\)/mu);
    expect(src).not.toMatch(/docker\s+run\s+--rm/u);
  });

  test('refuses pre-existing colliding resources with zero cleanup mutations and preserves canaries', async () => {
    const f = await createHermeticDockerFixture('collision');
    const result = await runBoundedHarness(
      ['--noprofile', '--norc', scriptPath, imageId, revision],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        HOME: f.tmp,
        TMPDIR: f.tmp,
        SystemRoot: process.env.SystemRoot,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('health_stdio_docker_collision_detected');
    const mutations = await readFile(join(f.stateDir, 'mutations.log'), 'utf8').catch(() => '');
    expect(mutations).toBe('');
    const state = JSON.parse(await readFile(f.stateFile, 'utf8')) as {
      containers: Record<string, unknown>;
      networks: Record<string, unknown>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(state.containers).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(state.networks).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(state.volumes).length).toBeGreaterThanOrEqual(2);
  });

  test('cleanup preserves pre-creation resources and removes only exact ledger and owned child resources while keeping canaries', async () => {
    const f = await createHermeticDockerFixture('ledger');
    const scope = 'fcd-support-health-stdio-synthetic-scope';
    const pgId = '1'.repeat(64);
    const opChildId = '2'.repeat(64);
    const netId = '3'.repeat(64);

    // 1. Even with matching-label resources, cleanup when precreation_passed=0 does zero Docker removals.
    await seedFakeDockerState(f.stateFile, (s) => {
      const containers = s.containers as Record<string, unknown>;
      containers[pgId] = {
        id: pgId,
        name: `${scope}-postgres`,
        image: postgresImage,
        labels: { 'fcd-support.health-stdio-test': scope },
      };
      const networks = s.networks as Record<string, unknown>;
      networks[netId] = {
        id: netId,
        name: `${scope}-operations-data`,
        labels: { 'fcd-support.health-stdio-test': scope },
      };
      const volumes = s.volumes as Record<string, unknown>;
      volumes[`${scope}-backups`] = {
        name: `${scope}-backups`,
        driver: 'local',
        scope: 'local',
        labels: { 'fcd-support.health-stdio-test': scope },
      };
    });

    const preCreationRes = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; scope="${scope}"; precreation_passed=0; cleanup`,
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(preCreationRes.status).toBe(0);
    expect(await readFile(join(f.stateDir, 'mutations.log'), 'utf8').catch(() => '')).toBe('');

    // 2. With precreation_passed=1 and matching ledger IDs, owned resources are removed cleanly while canary stays intact.
    await seedFakeDockerState(f.stateFile, (s) => {
      const containers = s.containers as Record<string, unknown>;
      containers[opChildId] = {
        id: opChildId,
        name: `fcd-support-operation-${'c'.repeat(32)}-health-1`,
        image: imageId,
        labels: {
          'fcd-support.operation.parent': scope,
          'fcd-support.operation.ref': `operation_${'c'.repeat(32)}`,
          'fcd-support.operation.service': 'health',
          'fcd-support.operation.command': 'd'.repeat(64),
          'org.opencontainers.image.revision': revision,
        },
      };
      const volumes = s.volumes as Record<string, unknown>;
      volumes[`${scope}-postgres`] = {
        name: `${scope}-postgres`,
        driver: 'local',
        scope: 'local',
        labels: { 'fcd-support.health-stdio-test': scope },
      };
    });

    const fullLedgerRes = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        [
          'set -Eeuo pipefail',
          `source "${scriptPath}"`,
          `scope="${scope}"`,
          `network="${scope}-operations-data"`,
          `backup_volume="${scope}-backups"`,
          `pg_volume="${scope}-postgres"`,
          `pg_container="${scope}-postgres"`,
          `revision="${revision}"`,
          `ops_image_id="${imageId}"`,
          'precreation_passed=1',
          `created_containers=("${pgId}")`,
          `created_container_images["${pgId}"]="${postgresImage}"`,
          `created_network_id="${netId}"`,
          `created_operation_records["${opChildId}"]="operation_${'c'.repeat(32)}|health|${'d'.repeat(64)}"`,
          `created_backup_volume="${scope}-backups"`,
          `created_pg_volume="${scope}-postgres"`,
          `created_backup_volume_meta="${scope}-backups|local|local|${scope}|2026-11-11T00:00:01Z"`,
          `created_pg_volume_meta="${scope}-postgres|local|local|${scope}|2026-11-11T00:00:01Z"`,
          `before_containers="${'e'.repeat(64)}"`,
          `before_networks="${'f'.repeat(64)}"`,
          'before_volumes="canary_unrelated_volume"',
          'cleanup',
        ].join('; '),
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(fullLedgerRes.status, fullLedgerRes.stderr).toBe(0);
    const stateAfterClean = JSON.parse(await readFile(f.stateFile, 'utf8')) as {
      containers: Record<string, unknown>;
      networks: Record<string, unknown>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(stateAfterClean.containers)).toEqual(['e'.repeat(64)]);
    expect(Object.keys(stateAfterClean.networks)).toEqual(['f'.repeat(64)]);
    expect(Object.keys(stateAfterClean.volumes)).toEqual(['canary_unrelated_volume']);
  });

  test('cleanup refuses foreign-labeled containers and replaced network IDs without deleting them', async () => {
    const f = await createHermeticDockerFixture('ledger-refusal');
    const scope = 'fcd-support-health-stdio-synthetic-scope';
    const netId = '3'.repeat(64);
    const foreignContainerId = '4'.repeat(64);
    const replacedNetId = '5'.repeat(64);

    await seedFakeDockerState(f.stateFile, (s) => {
      s.mutations = [];
      const containers = s.containers as Record<string, unknown>;
      containers[foreignContainerId] = {
        id: foreignContainerId,
        name: 'foreign-actor',
        image: postgresImage,
        labels: { 'fcd-support.health-stdio-test': 'unrelated-other-scope' },
      };
      const networks = s.networks as Record<string, unknown>;
      networks[replacedNetId] = {
        id: replacedNetId,
        name: `${scope}-operations-data`,
        labels: { 'fcd-support.health-stdio-test': scope },
      };
    });

    const foreignRefuseRes = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        [
          'set -Eeuo pipefail',
          `source "${scriptPath}"`,
          `scope="${scope}"`,
          `network="${scope}-operations-data"`,
          `backup_volume="${scope}-backups"`,
          `pg_volume="${scope}-postgres"`,
          `pg_container="${scope}-postgres"`,
          `revision="${revision}"`,
          `ops_image_id="${imageId}"`,
          'precreation_passed=1',
          `created_containers=("${foreignContainerId}")`,
          `created_network_id="${netId}"`, // Expected netId != replacedNetId
          `before_containers="${'e'.repeat(64)}"`,
          `before_networks="${'f'.repeat(64)}"`,
          'before_volumes="canary_unrelated_volume"',
          'cleanup',
        ].join('; '),
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(foreignRefuseRes.status).not.toBe(0);
    expect(await readFile(join(f.stateDir, 'mutations.log'), 'utf8').catch(() => '')).toBe('');
    const stateAfterRefusal = JSON.parse(await readFile(f.stateFile, 'utf8')) as {
      containers: Record<string, unknown>;
      networks: Record<string, unknown>;
    };
    expect(stateAfterRefusal.containers[foreignContainerId]).toBeDefined();
    expect(stateAfterRefusal.networks[replacedNetId]).toBeDefined();
  });

  test('cleanup fails nonzero when an owned resource remains after removal attempt', async () => {
    const f = await createHermeticDockerFixture('ledger-leftover');
    const scope = 'fcd-support-health-stdio-synthetic-scope';
    const pgId = '1'.repeat(64);

    await seedFakeDockerState(f.stateFile, (s) => {
      s.stickyContainers = [pgId];
      const containers = s.containers as Record<string, unknown>;
      containers[pgId] = {
        id: pgId,
        name: `${scope}-postgres`,
        image: postgresImage,
        labels: { 'fcd-support.health-stdio-test': scope },
      };
    });

    const stickyFailRes = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        [
          'set -Eeuo pipefail',
          `source "${scriptPath}"`,
          `scope="${scope}"`,
          `network="${scope}-operations-data"`,
          `backup_volume="${scope}-backups"`,
          `pg_volume="${scope}-postgres"`,
          `pg_container="${scope}-postgres"`,
          `revision="${revision}"`,
          `ops_image_id="${imageId}"`,
          'precreation_passed=1',
          `created_containers=("${pgId}")`,
          `created_container_images["${pgId}"]="${postgresImage}"`,
          'cleanup',
        ].join('; '),
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(stickyFailRes.status).not.toBe(0);
  });

  test('closed failure publication blocks arbitrary valid-looking stderr tokens and secret sentinels on ERR/EXIT', async () => {
    const f = await createHermeticDockerFixture('closed-reporting');
    const caseDir = join(f.root, 'work', 'cases', 'json-file', 'state');
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, 'exit'), '1\n', 'utf8');
    await writeFile(join(caseDir, 'log-driver'), 'none\n', 'utf8');
    await writeFile(
      join(caseDir, 'active-job'),
      'JOB_SERVICE=health\nJOB_PHASE=uncertain\nJOB_CONTAINER=' + 'c'.repeat(64) + '\n',
      'utf8',
    );
    await writeFile(
      join(caseDir, 'stderr'),
      [
        'arbitrary_valid_looking_stderr_token_99',
        'synthetic_leak_host_token:1',
        'SYNTHETIC_HOST_SENTINEL_XYZ',
        'postgresql://postgres:synthetic_secret_pw@postgres:5432/fcd_support_test',
        'operations_job_uncertain',
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      join(caseDir, 'docker.calls'),
      [
        `container start --attach --interactive ${'c'.repeat(64)}`,
        'arbitrary unallowlisted docker arg secret_value_here',
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      join(caseDir, 'trace3'),
      [
        'operations-job-lifecycle.sh:291:previous=1',
        'synthetic_health_ack_diagnostic=empty',
        'synthetic_health_unallowlisted_diagnostic=secret_leak_value',
      ].join('\n') + '\n',
      'utf8',
    );

    const workPosix = join(f.root, 'work').replaceAll('\\', '/');
    const result = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; precreation_passed=0; workdir="${workPosix}"; state_base="${workPosix}"; register_traps; false`,
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('health_stdio_case_state=cases/json-file/state');
    expect(result.stderr).toContain('  exit=1');
    expect(result.stderr).toContain('  log_driver=none');
    expect(result.stderr).toContain('  JOB_SERVICE=health');
    expect(result.stderr).toContain('  JOB_PHASE=uncertain');
    expect(result.stderr).toContain('  err=operations_job_uncertain');
    expect(result.stderr).toContain('  err_filtered_count=4');
    expect(result.stderr).toContain('  docker=container start_attach');
    expect(result.stderr).toContain('  trace=operations-job-lifecycle.sh:291:previous=1');
    expect(result.stderr).toContain('  trace=synthetic_health_ack_diagnostic=empty');

    expect(result.stderr).not.toContain('arbitrary_valid_looking_stderr_token_99');
    expect(result.stderr).not.toContain('synthetic_leak_host_token:1');
    expect(result.stderr).not.toContain('SYNTHETIC_HOST_SENTINEL_XYZ');
    expect(result.stderr).not.toContain('synthetic_secret_pw');
    expect(result.stderr).not.toContain('c'.repeat(64));
    expect(result.stderr).not.toContain('secret_value_here');
    expect(result.stderr).not.toContain('secret_leak_value');
  });
  test('cleanup refuses an unrecorded same-label operation actor', async () => {
    const f = await createHermeticDockerFixture('unrecorded-operation');
    const scope = 'fcd-support-health-stdio-synthetic-scope';
    const operationId = '2'.repeat(64);
    await seedFakeDockerState(f.stateFile, (state) => {
      (state.containers as Record<string, unknown>)[operationId] = {
        id: operationId,
        name: `${scope}-unrecorded`,
        image: imageId,
        labels: {
          'fcd-support.operation.parent': scope,
          'fcd-support.operation.ref': `operation_${'a'.repeat(32)}`,
          'org.opencontainers.image.revision': revision,
        },
      };
    });
    const result = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; scope="${scope}"; revision="${revision}"; ops_image_id="${imageId}"; precreation_passed=1; cleanup`,
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(result.status).not.toBe(0);
    expect(await readFile(join(f.stateDir, 'mutations.log'), 'utf8').catch(() => '')).toBe('');
  });

  test('cleanup refuses a same-name volume with changed creation metadata', async () => {
    const f = await createHermeticDockerFixture('replaced-volume');
    const scope = 'fcd-support-health-stdio-synthetic-scope';
    const name = `${scope}-backups`;
    await seedFakeDockerState(f.stateFile, (state) => {
      (state.volumes as Record<string, unknown>)[name] = {
        name,
        driver: 'local',
        scope: 'local',
        createdAt: '2026-11-11T00:00:02Z',
        labels: { 'fcd-support.health-stdio-test': scope },
      };
    });
    const result = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; scope="${scope}"; precreation_passed=1; created_backup_volume="${name}"; created_backup_volume_meta="${name}|local|local|${scope}|2026-11-11T00:00:01Z"; cleanup`,
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(result.status).not.toBe(0);
    expect(await readFile(join(f.stateDir, 'mutations.log'), 'utf8').catch(() => '')).toBe('');
  });

  test('cleanup refuses provisional metadata carrying a foreign ownership label', async () => {
    const f = await createHermeticDockerFixture('replaced-volume');
    const scope = 'fcd-support-health-stdio-synthetic-scope';
    const name = `${scope}-backups`;
    await seedFakeDockerState(f.stateFile, (state) => {
      (state.volumes as Record<string, unknown>)[name] = {
        name,
        driver: 'local',
        scope: 'local',
        createdAt: '2026-11-11T00:00:02Z',
        labels: { 'fcd-support.health-stdio-test': 'synthetic-foreign-scope' },
      };
    });
    const result = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; scope="${scope}"; precreation_passed=1; created_backup_volume="${name}"; created_backup_volume_meta="${name}|local|local|synthetic-foreign-scope|2026-11-11T00:00:02Z"; cleanup`,
      ],
      {
        PATH: f.bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
        SystemRoot: process.env.SystemRoot,
      },
    );
    expect(result.status).not.toBe(0);
    expect(await readFile(join(f.stateDir, 'mutations.log'), 'utf8').catch(() => '')).toBe('');
  });

  test('outer setup refusal never publishes Docker stderr bodies', async () => {
    const result = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; docker() { printf '%s\\n' SYNTHETIC_SETUP_OUTPUT_MUST_STAY_PRIVATE >&2; return 1; }; main "${imageId}" "${revision}"`,
      ],
      { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('SYNTHETIC_SETUP_OUTPUT_MUST_STAY_PRIVATE');
    expect(result.stderr).toContain('health_stdio_docker_failed_line=');
  });
  test('final cleanup refusal never publishes stderr bodies', async () => {
    const result = await runBoundedHarness(
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -Eeuo pipefail; source "${scriptPath}"; cleanup() { printf '%s\\n' SYNTHETIC_SETUP_OUTPUT_MUST_STAY_PRIVATE >&2; return 1; }; synthetic_success() { register_traps; }; health_stdio_closed_run synthetic_success`,
      ],
      { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('SYNTHETIC_SETUP_OUTPUT_MUST_STAY_PRIVATE');
    expect(result.stderr).toContain('health_stdio_docker_output_redacted=true');
  });
});
