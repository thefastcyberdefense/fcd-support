import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { operationsEnvironment } from './helpers/operations-fixtures.js';
import { writeRuntimeHostFixture } from './helpers/runtime-host-fixture.js';
import {
  assertRuntimeCompose,
  readPrivateRuntimeCompose,
} from '../src/operations/compose-contract.js';
import { inspectRuntimeHostSamples } from '../src/operations/runtime-host.js';
import { parseRuntimeHostCliArguments } from '../src/operations/runtime-host-main.js';
import { parseHostHealthSnapshot } from '../src/operations/health-collector.js';
import { loadModelConfig } from '../src/model/model-config.js';
import { loadReplySettings } from '../src/operations/reply-config.js';
import { loadOutboundConfig } from '../src/outbound/outbound-config.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const revision = 'a'.repeat(40);
const peerId = 'e'.repeat(64);
const manifestPeerId = '9'.repeat(64);
const paths = {
  adminSocketRoot: '/run/synthetic-admin-socket',
  configRoot: '/protected/config',
  secretRoot: '/protected/secrets',
  workspaceRoot: '/workspace/source',
};

const tempRoots: string[] = [];
afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function enabledService(
  role: string,
  networks: readonly string[],
  secrets: readonly string[],
  flags: { model: 'true' | 'false'; outbound: 'true' | 'false'; n8n: 'true' | 'false' },
) {
  const limits = Object.fromEntries(
    [
      'webhook',
      'admin',
      'reply',
      'outbound',
      'notification',
      'migrate',
      'backup',
      'verify_backup',
      'checkpoint',
      'health',
      'maintenance',
      'restore',
    ].map((name) => [name, { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 }]),
  );
  return {
    image: `fcd-support-api:${revision}`,
    labels: { 'org.opencontainers.image.revision': revision },
    user: role === 'postgres' ? 'postgres' : 'node',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    init: true,
    pids_limit: 64,
    cpus: 0.5,
    mem_limit: '268435456',
    stop_grace_period: '30s',
    restart: 'unless-stopped',
    healthcheck: { test: ['CMD', 'node', '--version'], interval: '10s', timeout: '3s', retries: 3 },
    networks: Object.fromEntries(networks.map((name) => [name, {}])),
    environment: {
      ...operationsEnvironment(),
      OPS_RESOURCE_LIMITS_JSON: JSON.stringify(limits),
      NODE_ENV: 'production',
      MODEL_EXECUTION_ENABLED: flags.model,
      OUTBOUND_EXECUTION_ENABLED: flags.outbound,
      N8N_EXECUTION_ENABLED: flags.n8n,
    },
    secrets: secrets.map((source) => ({ source, target: `/run/secrets/${source}` })),
    tmpfs: ['/run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m'],
  };
}

function enabledHostFixture() {
  const services = {
    postgres: {
      ...enabledService(
        'postgres',
        [
          'webhook_data',
          'admin_data',
          'reply_data',
          'outbound_data',
          'notification_data',
          'operations_data',
        ],
        ['postgres-password'],
        { model: 'false', outbound: 'false', n8n: 'false' },
      ),
      volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }],
      tmpfs: [
        '/var/run/postgresql:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=16m',
        '/tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m',
      ],
    },
    'fcd-support-api': enabledService(
      'webhook',
      ['webhook_data', 'ingress'],
      ['webhook-database', 'meta-app-secret', 'meta-verify-token', 'webhook-keyring'],
      { model: 'false', outbound: 'false', n8n: 'false' },
    ),
    'fcd-support-admin': {
      ...enabledService(
        'admin',
        ['admin_data'],
        ['admin-database', 'admin-session', 'admin-mfa', 'admin-keyring'],
        {
          model: 'false',
          outbound: 'false',
          n8n: 'false',
        },
      ),
      environment: {
        ...enabledService('admin', [], [], { model: 'false', outbound: 'false', n8n: 'false' })
          .environment,
        ADMIN_LISTEN_MODE: 'unix',
        ADMIN_SOCKET_PATH: '/run/fcd-support-admin/admin.sock',
        ADMIN_ORIGIN: 'http://127.0.0.1:3004',
        ADMIN_BROWSER_PORT: '3004',
      },
      ports: [] as Record<string, unknown>[],
      volumes: [
        {
          type: 'bind',
          source: paths.adminSocketRoot,
          target: '/run/fcd-support-admin',
          read_only: false,
          bind: { create_host_path: false },
        },
      ],
    },
    'fcd-support-reply': {
      ...enabledService(
        'reply',
        ['reply_data', 'model'],
        ['reply-database', 'reply-keyring', 'manifest-key'],
        { model: 'true', outbound: 'false', n8n: 'false' },
      ),
      profiles: ['model-execution'],
    },
    'fcd-support-outbound': {
      ...enabledService(
        'outbound',
        ['outbound_data', 'provider_egress'],
        [
          'outbound-database',
          'outbound-keyring',
          'meta-page-token',
          'meta-whatsapp-token',
          'meta-page-id',
          'meta-phone-id',
        ],
        { model: 'false', outbound: 'true', n8n: 'false' },
      ),
      profiles: ['outbound-execution'],
    },
    'fcd-support-notification': {
      ...enabledService(
        'notification',
        ['notification_data', 'notification'],
        ['notification-database', 'n8n-secret'],
        { model: 'false', outbound: 'false', n8n: 'false' },
      ),
      profiles: ['notification-execution'],
    },
  };
  services.postgres.networks.operations_data = { aliases: ['fcd-support-source-postgres'] };
  const networkNames = [
    'webhook_data',
    'admin_data',
    'reply_data',
    'outbound_data',
    'notification_data',
    'operations_data',
    'ingress',
    'provider_egress',
    'notification',
    'model',
  ];
  const secretEntries: Record<string, { file: string }> = {};
  for (const [serviceName, service] of Object.entries(services)) {
    const dir =
      serviceName === 'postgres'
        ? 'postgres'
        : serviceName === 'fcd-support-api'
          ? 'webhook'
          : serviceName.slice('fcd-support-'.length);
    for (const secret of service.secrets) {
      secretEntries[secret.source] = { file: `${paths.secretRoot}/${dir}/${secret.source}` };
    }
  }
  const compose = {
    name: 'fcd-support',
    services,
    networks: Object.fromEntries(
      networkNames.map((name) => [
        name,
        {
          name: `fcd-support-${name}`,
          internal: !['ingress', 'provider_egress', 'notification', 'model'].includes(name),
          ...(['ingress', 'notification', 'model'].includes(name) ? { external: true } : {}),
        },
      ]),
    ),
    secrets: secretEntries,
    volumes: { 'postgres-data': { name: 'postgres-data' } },
  };

  const roles = [
    'postgres',
    'fcd-support-api',
    'fcd-support-admin',
    'fcd-support-reply',
    'fcd-support-outbound',
  ] as const;
  const networkIds = Object.fromEntries(
    networkNames.map((name, index) => [name, (index + 1).toString(16).repeat(64)]),
  );
  const images = {
    postgres: {
      id: `sha256:${'b'.repeat(64)}`,
      revision,
      os: 'linux' as const,
      architecture: 'amd64' as const,
      user: 'postgres',
    },
    runtime: {
      id: `sha256:${'c'.repeat(64)}`,
      revision,
      os: 'linux' as const,
      architecture: 'amd64' as const,
      user: 'node',
    },
  };
  const containers = roles.map((role, index) => {
    const service = compose.services[role];
    const cid = String(index + 1).repeat(64);
    const mounts: unknown[] = service.secrets.map((secret) => ({
      type: 'bind',
      name: '',
      source: compose.secrets[secret.source]?.file ?? '',
      destination: `/run/secrets/${secret.source}`,
      readWrite: false,
      propagation: 'rprivate',
    }));
    if (role === 'postgres') {
      mounts.push({
        type: 'volume',
        name: 'postgres-data',
        source: '/var/lib/docker/volumes/postgres-data/_data',
        destination: '/var/lib/postgresql',
        readWrite: true,
        propagation: '',
      });
    }
    if (role === 'fcd-support-admin') {
      mounts.push({
        type: 'bind',
        name: '',
        source: paths.adminSocketRoot,
        destination: '/run/fcd-support-admin',
        readWrite: true,
        propagation: 'rprivate',
      });
    }
    for (const t of service.tmpfs) {
      mounts.push({
        type: 'tmpfs',
        name: '',
        source: '',
        destination: t.split(':')[0] ?? '',
        readWrite: true,
        propagation: '',
      });
    }
    const flags =
      role === 'fcd-support-reply'
        ? [
            'MODEL_EXECUTION_ENABLED=true',
            'OUTBOUND_EXECUTION_ENABLED=false',
            'N8N_EXECUTION_ENABLED=false',
          ]
        : role === 'fcd-support-outbound'
          ? [
              'MODEL_EXECUTION_ENABLED=false',
              'OUTBOUND_EXECUTION_ENABLED=true',
              'N8N_EXECUTION_ENABLED=false',
            ]
          : [
              'MODEL_EXECUTION_ENABLED=false',
              'OUTBOUND_EXECUTION_ENABLED=false',
              'N8N_EXECUTION_ENABLED=false',
            ];
    return {
      id: cid,
      project: compose.name,
      service: role,
      revision,
      imageId: role === 'postgres' ? images.postgres.id : images.runtime.id,
      running: true as const,
      paused: false as const,
      restarting: false as const,
      dead: false as const,
      healthy: true as const,
      startedAt: '2030-04-01T00:00:00Z',
      restartCount: 0,
      readOnlyRootfs: true as const,
      privileged: false as const,
      init: true as const,
      user: service.user,
      networkMode: compose.networks[Object.keys(service.networks)[0] ?? '']?.name ?? '',
      networks: Object.keys(service.networks).map((key) => ({
        name: compose.networks[key]?.name ?? '',
        id: networkIds[key] ?? '',
      })),
      hostPortBindings: 0 as const,
      publishedPortBindings: 0 as const,
      publishAllPorts: false as const,
      pidMode: '' as const,
      ipcMode: 'private' as const,
      utsMode: '' as const,
      capAdd: [],
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      devices: 0 as const,
      deviceRequests: 0 as const,
      groupAdd: [],
      volumesFrom: [],
      extraHosts: [],
      sysctls: {},
      nanoCpus: 500000000,
      memory: 268435456,
      pidsLimit: 64,
      stopTimeout: 30,
      restartPolicy: 'unless-stopped' as const,
      tmpfs: Object.fromEntries<string>(
        service.tmpfs.map((entry) => {
          const [path, options] = entry.split(':');
          return [path ?? '', options ?? ''] as const;
        }),
      ),
      command:
        role === 'postgres'
          ? ['postgres']
          : role === 'fcd-support-api'
            ? ['node', 'dist/main.js']
            : role === 'fcd-support-admin'
              ? ['node', 'dist/admin-main.js']
              : role === 'fcd-support-reply'
                ? ['node', 'dist/worker-main.js', 'reply']
                : ['node', 'dist/worker-main.js', 'outbound'],
      entrypoint:
        role === 'postgres'
          ? ['/usr/local/bin/fcd-postgres-entrypoint.sh']
          : ['/usr/local/bin/container-entrypoint.sh', 'application'],
      environmentNames: [
        'NODE_ENV',
        'DATABASE_URL_FILE',
        'MODEL_EXECUTION_ENABLED',
        'OUTBOUND_EXECUTION_ENABLED',
        'N8N_EXECUTION_ENABLED',
      ],
      executionFlags: flags,
      mounts,
    };
  });

  const keys = [...new Set(roles.flatMap((role) => Object.keys(compose.services[role].networks)))];
  const networks = keys.map((key) => ({
    id: networkIds[key] ?? '',
    name: compose.networks[key]?.name ?? '',
    driver: 'bridge' as const,
    scope: 'local' as const,
    // Existing upstream Manifest external network keeps its own internal=false attribute
    internal: key !== 'provider_egress' && key !== 'model',
    project: key === 'ingress' || key === 'model' ? '' : compose.name,
    logicalName: key === 'ingress' || key === 'model' ? '' : key,
    members: [
      ...containers
        .filter((c) => c.networks.some((n) => n.id === networkIds[key]))
        .map((c) => c.id),
      ...(key === 'ingress' ? [peerId] : key === 'model' ? [manifestPeerId] : []),
    ],
  }));

  const volume = {
    name: 'postgres-data',
    driver: 'local' as const,
    scope: 'local' as const,
    options: null,
    project: compose.name,
    logicalName: 'postgres-data' as const,
    createdAt: '2030-04-01T00:00:00Z',
    mountpoint: '/var/lib/docker/volumes/postgres-data/_data',
    users: [containers[0]?.id ?? ''],
  };

  const snapshot = {
    images,
    containers,
    networks,
    volume,
    socket: {
      device: '12',
      inode: '34',
      uid: 1000,
      gid: 1000,
      mode: 384,
      rootDevice: '12',
      rootInode: '33',
      rootMode: 448,
      rootUid: 1000,
      rootGid: 1000,
    },
    hostBinds: containers.flatMap((c) =>
      c.mounts
        .filter(
          (m): m is { type: 'bind'; source: string } => (m as { type: string }).type === 'bind',
        )
        .map((m) => ({ containerId: c.id, source: m.source, canonicalSource: m.source })),
    ),
  };

  return {
    compose,
    options: { revision, paths, ingressPeerId: peerId, mode: 'private-enabled' as const },
    samples: {
      before: snapshot,
      after: structuredClone(snapshot),
      probes: {
        postgresSql: true,
        apiHttp: true,
        adminSocket: true,
        adminNoTcp: true,
        replyHeartbeat: true,
        outboundHeartbeat: true,
      },
    },
  };
}

describe('--mode private-enabled runtime support (Gap G-4)', () => {
  test('readPrivateRuntimeCompose and inspectRuntimeHostSamples validate enabled reply+outbound workers and preserve upstream model network peers', () => {
    const f = enabledHostFixture();
    expect(() => {
      assertRuntimeCompose(f.compose, revision, true, paths);
    }).not.toThrow();
    expect(() => readPrivateRuntimeCompose(f.compose, revision, paths, true)).not.toThrow();
    expect(inspectRuntimeHostSamples(f.samples, f.compose, f.options)).toEqual({
      status: 'verified',
    });

    // Disabled mode strictly refuses enabled workers
    expect(() =>
      inspectRuntimeHostSamples(f.samples, f.compose, {
        ...f.options,
        mode: 'private-disabled',
      }),
    ).toThrow();

    // Missing outboundHeartbeat refuses in private-enabled mode
    const badProbes = enabledHostFixture();
    expect(() =>
      inspectRuntimeHostSamples(
        {
          ...badProbes.samples,
          probes: {
            ...badProbes.samples.probes,
            outboundHeartbeat: false,
          },
        },
        badProbes.compose,
        badProbes.options,
      ),
    ).toThrow();

    // Foreign peer on provider_egress refuses cleanly
    const badEgress = enabledHostFixture();
    const egress = badEgress.samples.before.networks.find(
      (n) => n.logicalName === 'provider_egress',
    );
    egress?.members.push('8'.repeat(64));
    badEgress.samples.after = structuredClone(badEgress.samples.before);
    expect(() =>
      inspectRuntimeHostSamples(badEgress.samples, badEgress.compose, badEgress.options),
    ).toThrow();
  });

  test('operations_parse_arguments and operations_compose enable reply+outbound in private-enabled while keeping ops false/false/false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-private-enabled-ops-'));
    tempRoots.push(root);
    await writeFile(
      join(root, 'docker'),
      `#!/usr/bin/env bash
set -eu
printf 'MODEL=%s OUTBOUND=%s N8N=%s FILES=%s\\n' \\
  "\${MODEL_EXECUTION_ENABLED:-}" "\${OUTBOUND_EXECUTION_ENABLED:-}" "\${N8N_EXECUTION_ENABLED:-}" "$*"
`,
      { mode: 0o700 },
    );

    const enabledResult = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
operations_parse_arguments deploy ${revision} --mode private-enabled /synthetic/ops.conf
[[ "$OPS_RUNTIME_MODE" == private-enabled ]]
OPS_ROOT=/synthetic/root
declare -A OPS_CONFIG=([FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_MODEL_NETWORK]=manifest_private_net [N8N_EXECUTION_ENABLED]=true)
operations_compose runtime config
operations_compose operations config
operations_parse_arguments verify ${revision} --mode private-enabled /synthetic/ops.conf
[[ "$OPS_RUNTIME_MODE" == private-enabled ]]
operations_parse_arguments verify ${revision} /synthetic/ops.conf
[[ "$OPS_RUNTIME_MODE" == private-disabled ]]
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: root + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect(enabledResult.status, enabledResult.stderr).toBe(0);
    const lines = enabledResult.stdout.trim().split('\n');
    expect(lines[0]).toContain('MODEL=true OUTBOUND=true N8N=false');
    expect(lines[0]).toContain('/synthetic/root/infra/compose.model.yml');
    expect(lines[1]).toContain('MODEL=false OUTBOUND=false N8N=false');
    expect(lines[1]).not.toContain('compose.model.yml');
  });

  test('operations_start_private_runtime starts reply and outbound with profiles under private-enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-startup-enabled-'));
    tempRoots.push(root);
    const app = `sha256:${'d'.repeat(64)}`;
    const operations = `sha256:${'e'.repeat(64)}`;
    const postgres = `sha256:${'f'.repeat(64)}`;

    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_STARTUP"
OPS_ROOT="$TASK_ROOT"
OPS_RUNTIME_MODE=private-enabled
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support [FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000019 [FCD_POSTGRES_DB]=fcd_support [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support [FCD_POSTGRES_VOLUME]=fcd-support-selected [FCD_SUPPORT_IMAGE]=${app} [FCD_OPERATIONS_IMAGE]=${operations} [FCD_POSTGRES_IMAGE]=${postgres} [FCD_READY_TIMEOUT_SECONDS]=5 [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=1000 [FCD_MODEL_NETWORK]=manifest_net)
printf quiescent > "$TASK_ROOT/phase"; printf no > "$TASK_ROOT/writes"; printf 000018 > "$TASK_ROOT/schema"
operations_job_state_root() { OPS_JOB_STATE_FILE="$TASK_ROOT/active-job"; }
operations_selection_read() { declare -gA OPS_SELECTION=([STATE_REF]=selection_${'c'.repeat(32)} [STATE_PHASE]="$(<"$TASK_ROOT/phase")" [STATE_VOLUME]=fcd-support-selected [STATE_SYSTEM_IDENTIFIER]=1111111111111111111 [STATE_REVISION]=${revision} [STATE_SCHEMA_REVISION]="$(<"$TASK_ROOT/schema")" [STATE_WRITES_POSSIBLE]="$(<"$TASK_ROOT/writes")" [STATE_DATABASE_NAME]=fcd_support [STATE_SCHEMA_NAME]=public); }
operations_selection_starting() { printf starting > "$TASK_ROOT/phase"; printf yes > "$TASK_ROOT/writes"; printf 000019 > "$TASK_ROOT/schema"; }
operations_selection_ready() { printf ready > "$TASK_ROOT/phase"; }
operations_selection_uncertain() { printf uncertain > "$TASK_ROOT/phase"; }
operations_retain_revision() { :; }
operations_socket_root() { :; }
operations_docker() { local ref="\${!#}" role=node; [[ "$ref" != '${postgres}' ]] || role=postgres; printf '%s/${revision}/linux/amd64/%s\\n' "$ref" "$role"; }
operations_inspect_bootstrap_database() { :; }
operations_read_database_identity() { printf '1111111111111111111\\n'; }
operations_upgrade_database() { OPS_DATABASE_SYSTEM_IDENTIFIER=1111111111111111111; OPS_PRE_MIGRATION_BACKUP_REF=backup_${'b'.repeat(32)}; }
operations_execute_job() { :; }
operations_compose() { printf '%s\\n' "$*" > "$TASK_ROOT/compose-args"; }
operations_inspect_runtime_host() { :; }
operations_start_private_runtime ${app} ${operations} ${postgres}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_ROOT: root.replaceAll('\\', '/'),
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_STARTUP: resolve('scripts/operations-startup.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const composeArgs = await readFile(join(root, 'compose-args'), 'utf8');
    expect(composeArgs).toContain('--profile model-execution');
    expect(composeArgs).toContain('--profile outbound-execution');
    expect(composeArgs).toContain('fcd-support-reply fcd-support-outbound');
  });

  test('operations_collect_health_host includes outbound component when fcd-support-outbound is running', () => {
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
OPS_RUNTIME_MODE=private-enabled
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-test [FCD_SUPPORT_REVISION]=${revision} [FCD_INGRESS_PEER_ID]=${'d'.repeat(64)} [FCD_HEALTH_TIMEOUT_MS]=6000)
date() { printf '2030-01-01T00:00:00.000Z\\n'; }
operations_docker() {
  local last; for last; do :; done
  if [[ "$1" == ps ]]; then
    case "$last" in
      *fcd-support-api) printf '${'a'.repeat(64)}\\n' ;;
      *fcd-support-admin) printf '${'b'.repeat(64)}\\n' ;;
      *fcd-support-reply) printf '${'c'.repeat(64)}\\n' ;;
      *fcd-support-outbound) printf '${'e'.repeat(64)}\\n' ;;
      *) return 1 ;;
    esac
  elif [[ "$1 $2" == 'container inspect' ]]; then
    case "$last" in
      ${'d'.repeat(64)}) printf '${'d'.repeat(64)}|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' ;;
      ${'a'.repeat(64)}) printf '${'a'.repeat(64)}|fcd-support-test|fcd-support-api|${revision}|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' ;;
      ${'b'.repeat(64)}) printf '${'b'.repeat(64)}|fcd-support-test|fcd-support-admin|${revision}|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' ;;
      ${'c'.repeat(64)}) printf '${'c'.repeat(64)}|fcd-support-test|fcd-support-reply|${revision}|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' ;;
      ${'e'.repeat(64)}) printf '${'e'.repeat(64)}|fcd-support-test|fcd-support-outbound|${revision}|true|false|false|false|healthy|2029-12-31T23:00:00.000Z\\n' ;;
      *) return 1 ;;
    esac
  elif [[ "$1" == exec ]]; then
    case "$2" in
      ${'c'.repeat(64)}|${'e'.repeat(64)}) printf 'healthy|2029-12-31T23:59:59.000Z\\n' ;;
      *) return 0 ;;
    esac
  else
    return 1
  fi
}
source "$TASK_LIBRARY"
operations_collect_health_host
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: resolve('scripts/operations-health-host.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const parsed = parseHostHealthSnapshot(JSON.parse(result.stdout));
    expect(parsed?.services.map((s) => s.component)).toEqual([
      'webhook',
      'reply',
      'outbound',
      'tunnel',
    ]);
  });

  test('writeRuntimeHostFixture private-enabled profile creates model.env, outbound secrets, FCD_MODEL_NETWORK, and timer defaults', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fcd-fixture-enabled-'));
    tempRoots.push(parent);
    const root = join(parent, 'fcd-support-host-test-v1env');
    await writeRuntimeHostFixture(root, 'fcd-support-host-test-v1env', revision, 'v1-enabled');
    const opsEnv = await readFile(join(root, 'config/operations.env'), 'utf8');
    const modelEnv = await readFile(join(root, 'config/model.env'), 'utf8');
    const restoreEnv = await readFile(join(root, 'config/restore.env'), 'utf8');
    const manifestKey = await readFile(join(root, 'secrets/reply/manifest-key'), 'utf8');
    const waToken = await readFile(join(root, 'secrets/outbound/meta-whatsapp-token'), 'utf8');
    expect(opsEnv).toContain('FCD_MODEL_NETWORK=');
    expect(opsEnv).toContain('FCD_MAINTENANCE_SLOT_SECONDS=');
    expect(opsEnv).toContain('FCD_BACKUP_CALENDAR=');
    expect(modelEnv).toContain('MANIFEST_BASE_URL=');
    expect(restoreEnv).toContain('CHECKPOINT_MAX_AGE_MS=600000');
    expect(manifestKey.length).toBeGreaterThan(10);
    expect(waToken.length).toBeGreaterThan(10);
  });

  test('runtime-host-main CLI accepts --mode private-enabled and rejects malformed mode args', () => {
    const okArgs = [
      revision,
      paths.adminSocketRoot,
      paths.configRoot,
      paths.secretRoot,
      paths.workspaceRoot,
      peerId,
      '--mode',
      'private-enabled',
    ];
    expect(parseRuntimeHostCliArguments(okArgs)).toMatchObject({
      bootstrap: false,
      mode: 'private-enabled',
      revision,
      ingressPeerId: peerId,
    });
    expect(() =>
      parseRuntimeHostCliArguments([...okArgs.slice(0, 7), 'private-invalid']),
    ).toThrow();

    const entry = existsSync('/app/dist/operations/runtime-host-main.js')
      ? '/app/dist/operations/runtime-host-main.js'
      : resolve('dist/operations/runtime-host-main.js');
    if (existsSync(entry)) {
      const f = enabledHostFixture();
      const ok = spawnSync(process.execPath, [entry, ...okArgs], {
        encoding: 'utf8',
        timeout: 10_000,
        input: JSON.stringify({ compose: f.compose, samples: f.samples }),
      });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout.trim()).toBe('{"status":"verified"}');

      const bad = spawnSync(process.execPath, [entry, ...okArgs.slice(0, 7), 'private-invalid'], {
        encoding: 'utf8',
        timeout: 10_000,
        input: JSON.stringify({ compose: f.compose, samples: f.samples }),
      });
      expect(bad.status).toBe(1);
      expect(bad.stderr.trim()).toBe('runtime_host_invalid');
    }
  });

  test('operations_inspect_host bootstrap renders compose in private-disabled even when OPS_RUNTIME_MODE is private-enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-bootstrap-enabled-'));
    tempRoots.push(root);
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_COMMON"
source "$TASK_RUNTIME_HOST"
OPS_ROOT="$TASK_ROOT"
OPS_RUNTIME_MODE=private-enabled
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-host-test-synth [FCD_SUPPORT_REVISION]=${revision} [FCD_SUPPORT_IMAGE]=sha256:${'d'.repeat(64)} [FCD_OPERATIONS_IMAGE]=sha256:${'e'.repeat(64)} [FCD_POSTGRES_IMAGE]=sha256:${'f'.repeat(64)} [FCD_POSTGRES_VOLUME]=fcd-support-vol [FCD_ADMIN_SOCKET_ROOT]=/synthetic/sock [FCD_CONFIG_ROOT]=/synthetic/cfg [FCD_SECRET_ROOT]=/synthetic/sec [FCD_HEALTH_TIMEOUT_MS]=6000 [FCD_ADMIN_CPUS]=0.5 [FCD_ADMIN_MEMORY_MIB]=256 [FCD_ADMIN_PIDS]=64 [FCD_STOP_GRACE_MS]=1000)
operations_runtime_selection_context() { OPS_RUNTIME_VOLUME_IDENTITY=''; OPS_RUNTIME_SELECTED_IDENTIFIER=''; OPS_RUNTIME_SELECTION_STAMP=''; }
operations_compose() { printf '%s\\n' "\${OPS_RUNTIME_MODE:-unset}" > "$TASK_ROOT/compose-mode"; printf '{}'; }
operations_runtime_snapshot() { printf '{}'; }
operations_read_database_identity() { printf '1111111111111111111\\n'; }
operations_docker() {
  if [[ "$1 $2" == 'image inspect' ]]; then
    printf 'sha256:${'e'.repeat(64)}/${revision}/linux/amd64/node\\n'
  elif [[ "$1" == run ]]; then
    cat >/dev/null
    printf '{"status":"verified"}\\n'
  else
    return 1
  fi
}
operations_inspect_host bootstrap
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_ROOT: root.replaceAll('\\', '/'),
          TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
          TASK_RUNTIME_HOST: resolve('scripts/operations-runtime-host.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('bootstrap_database_verified');
    expect((await readFile(join(root, 'compose-mode'), 'utf8')).trim()).toBe('private-disabled');
  });

  test('writeRuntimeHostFixture v1-enabled satisfies loadModelConfig, loadReplySettings(true), and loadOutboundConfig', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fcd-fixture-valid-'));
    tempRoots.push(parent);
    const root = join(parent, 'fcd-support-host-test-v1val');
    await writeRuntimeHostFixture(root, 'fcd-support-host-test-v1val', revision, 'v1-enabled');
    const parse = async (name: string) =>
      Object.fromEntries(
        (await readFile(join(root, 'config', name), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => {
            const idx = line.indexOf('=');
            return [line.slice(0, idx), line.slice(idx + 1)];
          }),
      );
    const common = await parse('common.env');
    const model = await parse('model.env');
    const reply = await parse('reply.env');
    const outbound = await parse('outbound.env');
    const base = {
      ...common,
      ...model,
      ...reply,
      ...outbound,
      OPS_GIT_REVISION: revision,
      MANIFEST_API_KEY: 'synthetic_manifest_key_value_0001',
      META_PAGE_ACCESS_TOKEN: 'synthetic_page_token_value_0001',
      META_WHATSAPP_ACCESS_TOKEN: 'synthetic_wa_token_value_0001',
      META_MESSENGER_PAGE_ID: '123456789012345',
      META_WHATSAPP_PHONE_NUMBER_ID: '123456789012346',
    };
    expect(loadModelConfig(base).model).toBe('auto');
    expect(loadReplySettings(base, true).attestation?.verified).toBe(true);
    expect(loadOutboundConfig(base).allowLoopbackFake).toBe(false);
  });
});
