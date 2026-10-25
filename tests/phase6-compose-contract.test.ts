import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import { describe, expect, test } from 'vitest';

import { operationsEnvironment } from './helpers/operations-fixtures.js';
import {
  inspectRuntimeHostSamples,
  inspectBootstrapDatabaseSamples,
} from '../src/operations/runtime-host.js';

import {
  assertExternalNetworkParticipants,
  assertOperationsCompose,
  assertRestoreCompose,
  assertRuntimeCompose,
} from '../src/operations/compose-contract.js';

const revision = 'a'.repeat(40);
const paths = {
  adminSocketRoot: '/run/synthetic-admin-socket',
  configRoot: '/protected/config',
  secretRoot: '/protected/secrets',
  workspaceRoot: '/workspace/source',
};
const root = resolve(import.meta.dirname, '..');
function read(path: string): string {
  const file = resolve(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('accepts Compose null defaults while retaining explicit application commands', () => {
  const input = fixture();
  const rendered = {
    ...input,
    services: Object.fromEntries(
      Object.entries(input.services).map(([name, value]) => [
        name,
        { ...value, entrypoint: null, ...(name === 'postgres' ? { command: null } : {}) },
      ]),
    ),
  };
  expect(() => {
    assertRuntimeCompose(rendered, revision, false, paths);
  }).not.toThrow();
});

function service(role: string, networks: readonly string[], secrets: readonly string[]) {
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
      MODEL_EXECUTION_ENABLED: 'false',
      OUTBOUND_EXECUTION_ENABLED: 'false',
      N8N_EXECUTION_ENABLED: 'false',
    },
    secrets: secrets.map((source) => ({ source, target: `/run/secrets/${source}` })),
    tmpfs: ['/run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m'],
  };
}

function fixture() {
  const services = {
    postgres: {
      ...service(
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
      ),
      volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }],
      tmpfs: [
        '/var/run/postgresql:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=16m',
        '/tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m',
      ],
    },
    'fcd-support-api': service(
      'webhook',
      ['webhook_data', 'ingress'],
      ['webhook-database', 'meta-app-secret', 'meta-verify-token', 'webhook-keyring'],
    ),
    'fcd-support-admin': {
      ...service('admin', ['admin_data'], ['admin-database', 'admin-session', 'admin-mfa']),
      environment: {
        ...service('admin', [], []).environment,
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
    'fcd-support-reply': service('reply', ['reply_data'], ['reply-database', 'reply-keyring']),
    'fcd-support-outbound': {
      ...service(
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
      ),
      profiles: ['outbound-execution'],
    },
    'fcd-support-notification': {
      ...service(
        'notification',
        ['notification_data', 'notification'],
        ['notification-database', 'n8n-secret'],
      ),
      profiles: ['notification-execution'],
    },
  };
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
  ];
  const secretNames = Object.values(services).flatMap((s) => s.secrets.map((x) => x.source));
  return {
    name: 'fcd-support',
    services,
    networks: Object.fromEntries(
      networkNames.map((name) => [
        name,
        {
          name: `fcd-support-${name}`,
          internal: !['ingress', 'provider_egress', 'notification'].includes(name),
          ...(['ingress', 'notification'].includes(name) ? { external: true } : {}),
        },
      ]),
    ),
    secrets: Object.fromEntries(secretNames.map((name) => [name, { file: `/protected/${name}` }])),
  };
}

describe('Phase 6 Compose contract', () => {
  test('accepts socket-only admin without publishing any Docker host port', () => {
    const compose = read('infra/compose.runtime.yml');
    expect(compose).not.toContain('/var/run/docker.sock');
    expect(compose).not.toContain('network_mode: host');
    expect(compose).not.toMatch(/META_WHATSAPP_ACCESS_TOKEN:\s*\$\{/u);
    expect(() => {
      assertRuntimeCompose(fixture(), revision, false, paths);
    }).not.toThrow();
  });

  test.each([
    'missing-secret',
    'extra-secret',
    'public-admin',
    'extra-port',
    'wrong-label',
    'missing-resource',
    'missing-profile',
    'extra-network',
    'host-mount',
    'host-network',
    'privileged',
    'root',
    'wrong-restart',
    'resource-drift',
    'stop-grace-drift',
    'extra-tmpfs',
    'database-volume-on-api',
  ])('rejects %s without including configuration values in the failure', (change) => {
    const input = structuredClone(fixture());
    const api: Record<string, unknown> = input.services['fcd-support-api'];
    const admin = input.services['fcd-support-admin'];
    switch (change) {
      case 'missing-secret':
        delete input.secrets['meta-app-secret'];
        break;
      case 'extra-secret':
        input.services['fcd-support-api'].secrets.push({
          source: 'meta-page-token',
          target: 'meta-page-token',
        });
        break;
      case 'public-admin':
        admin.ports = [{ target: 3004, published: '3004', host_ip: '0.0.0.0', protocol: 'tcp' }];
        break;
      case 'extra-port':
        api.ports = [{ target: 3003, published: '3003', host_ip: '127.0.0.1' }];
        break;
      case 'wrong-label':
        api.labels = { 'org.opencontainers.image.revision': 'b'.repeat(40) };
        break;
      case 'missing-resource':
        delete api.cpus;
        break;
      case 'missing-profile':
        input.services['fcd-support-outbound'].profiles = [];
        break;
      case 'extra-network':
        input.services['fcd-support-api'].networks.model = {};
        break;
      case 'host-mount':
        api.volumes = [{ type: 'bind', source: '/protected/synthetic-private', target: '/app' }];
        break;
      case 'host-network':
        api.network_mode = 'host';
        break;
      case 'privileged':
        api.privileged = true;
        break;
      case 'root':
        api.user = '0';
        break;
      case 'wrong-restart':
        api.restart = 'always';
        break;
      case 'resource-drift':
        api.cpus = 1;
        break;
      case 'stop-grace-drift':
        api.stop_grace_period = '1s';
        break;
      case 'extra-tmpfs':
        input.services['fcd-support-api'].tmpfs.push('/app:size=16m');
        break;
      case 'database-volume-on-api':
        api.volumes = [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }];
        break;
    }
    expect(() => {
      assertRuntimeCompose(input, revision, false, paths);
    }).toThrow(/^compose_contract_invalid$/u);
  });

  test('rejects direct credentials even if they came from an env_file', () => {
    const input = fixture();
    Object.assign(input.services['fcd-support-api'].environment, {
      META_APP_SECRET: 'synthetic_unapproved_environment_value',
    });
    expect(() => {
      assertRuntimeCompose(input, revision, false, paths);
    }).toThrow(/^compose_contract_invalid$/u);
  });

  test.each([
    'loopback-port',
    'tcp-mode',
    'management',
    'wrong-source',
    'auto-create',
    'readonly',
    'wrong-target',
    'extra-mount',
  ])('refuses admin socket boundary drift: %s', (change) => {
    const input = fixture();
    const admin: Record<string, unknown> = input.services['fcd-support-admin'];
    const mount = input.services['fcd-support-admin'].volumes[0];
    if (mount === undefined) throw new Error('synthetic_mount_missing');
    switch (change) {
      case 'loopback-port':
        admin.ports = [{ target: 3004, published: '3004', host_ip: '127.0.0.1', protocol: 'tcp' }];
        break;
      case 'tcp-mode':
        Object.assign(input.services['fcd-support-admin'].environment, { ADMIN_HOST: '0.0.0.0' });
        break;
      case 'management':
        input.services['fcd-support-admin'].networks.management = {};
        break;
      case 'wrong-source':
        mount.source = '/run/synthetic-substitution';
        break;
      case 'auto-create':
        admin.volumes = [
          {
            type: 'bind',
            source: paths.adminSocketRoot,
            target: '/run/fcd-support-admin',
            bind: { create_host_path: true },
          },
        ];
        break;
      case 'readonly':
        mount.read_only = true;
        break;
      case 'wrong-target':
        mount.target = '/app';
        break;
      case 'extra-mount':
        input.services['fcd-support-admin'].volumes.push({
          type: 'bind',
          source: paths.adminSocketRoot,
          target: '/tmp',
          read_only: false,
          bind: { create_host_path: false },
        });
        break;
    }
    expect(() => {
      assertRuntimeCompose(input, revision, false, paths);
    }).toThrow(/^compose_contract_invalid$/u);
  });

  test.each([
    '/',
    '/run',
    '/var/lib/docker/synthetic',
    paths.configRoot,
    '/protected',
    '/protected/secrets/socket',
    '/workspace/source/socket',
  ])('refuses a broad or overlapping socket source %#', (source) => {
    const input = fixture();
    const mount = input.services['fcd-support-admin'].volumes[0];
    if (mount === undefined) throw new Error('synthetic_mount_missing');
    mount.source = source;
    expect(() => {
      assertRuntimeCompose(input, revision, false, { ...paths, adminSocketRoot: source });
    }).toThrow(/^compose_contract_invalid$/u);
  });

  test('rejects missing, over-broad and unexpected external network members', () => {
    expect(() => {
      assertExternalNetworkParticipants(undefined, ['synthetic-manifest']);
    }).toThrow(/^network_contract_invalid$/u);
    expect(() => {
      assertExternalNetworkParticipants(
        {
          Driver: 'bridge',
          Scope: 'local',
          Internal: true,
          Containers: { a: { Name: 'synthetic-manifest' }, b: { Name: 'synthetic-unrelated' } },
        },
        ['synthetic-manifest'],
      );
    }).toThrow(/^network_contract_invalid$/u);
    expect(() => {
      assertExternalNetworkParticipants(
        {
          Driver: 'bridge',
          Scope: 'local',
          Internal: true,
          Containers: { a: { Name: 'synthetic-manifest' } },
        },
        ['synthetic-manifest'],
      );
    }).not.toThrow();
  });

  test('rejects an Internet-routed external network even with the expected participant', () => {
    expect(() => {
      assertExternalNetworkParticipants(
        {
          Driver: 'bridge',
          Scope: 'local',
          Internal: false,
          Containers: { a: { Name: 'synthetic-manifest' } },
        },
        ['synthetic-manifest'],
      );
    }).toThrow(/^network_contract_invalid$/u);
  });

  test('keeps explicitly invoked jobs and isolated recovery separate', () => {
    expect(read('infra/compose.operations.yml')).toContain('profiles:');
    expect(read('infra/compose.restore.yml')).toContain('FCD_RESTORE_VOLUME');
    expect(() => {
      assertOperationsCompose({ services: {} }, revision);
    }).toThrow(/^compose_contract_invalid$/u);
    expect(() => {
      assertRestoreCompose({ services: {} }, revision, 'fcd-support-postgres-data');
    }).toThrow(/^compose_contract_invalid$/u);
    expect(read('scripts/test-phase6-local.sh')).toContain('fcd-support-phase6-test-');
    expect(read('scripts/verify-network-contract.sh')).toContain('network_contract=true');
    expect(read('infra/compose.phase6-test.yml')).toContain('manifest-fake');
  });
});

function runtimeHostFixture() {
  const compose = {
    ...fixture(),
    name: 'fcd-support-runtime',
    volumes: { 'postgres-data': { name: 'fcd-support-runtime-postgres' } },
  };
  for (const [key, network] of Object.entries(compose.networks))
    network.name = `${compose.name}-${key.replaceAll('_', '-')}`;
  const roles = ['postgres', 'fcd-support-api', 'fcd-support-admin', 'fcd-support-reply'] as const;
  const networkIds = Object.fromEntries(
    Object.keys(compose.networks).map((name, index) => [name, (index + 5).toString(16).repeat(64)]),
  );
  const ids = roles.map((_, index) => (index + 1).toString(16).repeat(64));
  const peerId = 'f'.repeat(64);
  const volume = {
    name: compose.volumes['postgres-data'].name,
    driver: 'local',
    scope: 'local',
    options: null,
    project: compose.name,
    logicalName: 'postgres-data',
    createdAt: '2030-04-01T00:00:00Z',
    mountpoint: '/var/lib/docker/volumes/fcd-support-runtime-postgres/_data',
    users: [ids[0]],
  };
  const images = {
    postgres: {
      id: `sha256:${'d'.repeat(64)}`,
      revision,
      os: 'linux',
      architecture: 'amd64',
      user: 'postgres',
    },
    runtime: {
      id: `sha256:${'e'.repeat(64)}`,
      revision,
      os: 'linux',
      architecture: 'amd64',
      user: 'node',
    },
  };
  const containers = roles.map((role, index) => {
    const service = compose.services[role];
    const mounts = service.secrets.map(({ source }) => {
      const directory =
        role === 'postgres'
          ? 'postgres'
          : role === 'fcd-support-api'
            ? 'webhook'
            : role.slice('fcd-support-'.length);
      const file = `${paths.secretRoot}/${directory}/${source}`;
      compose.secrets[source] = { file };
      return {
        type: 'bind',
        name: '',
        source: file,
        destination: `/run/secrets/${source}`,
        readWrite: false,
        propagation: 'rprivate',
      };
    });
    if (role === 'postgres')
      mounts.push({
        type: 'volume',
        name: volume.name,
        source: volume.mountpoint,
        destination: '/var/lib/postgresql',
        readWrite: true,
        propagation: '',
      });
    if (role === 'fcd-support-admin')
      mounts.push({
        type: 'bind',
        name: '',
        source: paths.adminSocketRoot,
        destination: '/run/fcd-support-admin',
        readWrite: true,
        propagation: 'rprivate',
      });
    return {
      id: ids[index],
      project: compose.name,
      service: role,
      revision,
      imageId: role === 'postgres' ? images.postgres.id : images.runtime.id,
      running: true,
      paused: false,
      restarting: false,
      dead: false,
      healthy: true,
      startedAt: '2030-04-01T00:00:00Z',
      restartCount: 0,
      readOnlyRootfs: true,
      privileged: false,
      init: true,
      user: service.user,
      networkMode: compose.networks[Object.keys(service.networks)[0] ?? '']?.name,
      networks: Object.keys(service.networks).map((key) => ({
        name: compose.networks[key]?.name,
        id: networkIds[key],
      })),
      hostPortBindings: 0,
      publishedPortBindings: 0,
      publishAllPorts: false,
      pidMode: '',
      ipcMode: 'private',
      utsMode: '',
      capAdd: [],
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      devices: 0,
      deviceRequests: 0,
      groupAdd: [],
      volumesFrom: [],
      extraHosts: [],
      sysctls: {},
      nanoCpus: 500000000,
      memory: 268435456,
      pidsLimit: 64,
      stopTimeout: 30,
      restartPolicy: 'unless-stopped',
      tmpfs: Object.fromEntries<string>(
        service.tmpfs.map((entry) => {
          const [path, options] = entry.split(':');
          return [path ?? '', options ?? ''] as const;
        }),
      ),
      command:
        role === 'postgres'
          ? ['postgres']
          : [
              'node',
              role === 'fcd-support-api'
                ? 'dist/main.js'
                : role === 'fcd-support-admin'
                  ? 'dist/admin-main.js'
                  : 'dist/worker-main.js',
              ...(role === 'fcd-support-reply' ? ['reply'] : []),
            ],
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
      executionFlags: [
        'MODEL_EXECUTION_ENABLED=false',
        'OUTBOUND_EXECUTION_ENABLED=false',
        'N8N_EXECUTION_ENABLED=false',
      ],
      mounts,
    };
  });
  const keys = [...new Set(roles.flatMap((role) => Object.keys(compose.services[role].networks)))];
  const networks = keys.map((key) => ({
    id: networkIds[key],
    name: compose.networks[key]?.name,
    driver: 'bridge',
    scope: 'local',
    internal: true,
    project: key === 'ingress' ? '' : compose.name,
    logicalName: key === 'ingress' ? '' : key,
    members: [
      ...containers
        .filter((c) => c.networks.some((n) => n.id === networkIds[key]))
        .map((c) => c.id),
      ...(key === 'ingress' ? [peerId] : []),
    ],
  }));
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
        .filter((m) => m.type === 'bind')
        .map((m) => ({ containerId: c.id, source: m.source, canonicalSource: m.source })),
    ),
  };
  return {
    compose,
    options: { revision, paths, ingressPeerId: peerId },
    samples: {
      before: snapshot,
      after: structuredClone(snapshot),
      probes: {
        postgresSql: true,
        apiHttp: true,
        adminSocket: true,
        adminNoTcp: true,
        replyHeartbeat: true,
      },
    },
  };
}

test('runtime host proof compares actual resources with the separately validated private Compose contract', () => {
  const f = runtimeHostFixture();
  expect(inspectRuntimeHostSamples(f.samples, f.compose, f.options)).toEqual({
    status: 'verified',
  });
});

function bootstrapHostFixture() {
  const f = runtimeHostFixture();
  const postgres = f.samples.before.containers.find((c) => c.service === 'postgres');
  if (postgres?.id === undefined) throw new Error('synthetic_fixture_invalid');
  const sample = {
    ...f.samples.before,
    containers: [postgres],
    networks: f.samples.before.networks
      .filter((n) => n.logicalName !== '')
      .map((n) => ({ ...n, members: [postgres.id] })),
    hostBinds: f.samples.before.hostBinds.filter((b) => b.containerId === postgres.id),
    socket: null as typeof f.samples.before.socket | null,
  };
  return {
    compose: f.compose,
    options: { revision: f.options.revision, paths: f.options.paths },
    samples: { before: sample, after: structuredClone(sample) },
  };
}

test('bootstrap host proof requires only the selected PostgreSQL on all six private data networks', () => {
  const f = bootstrapHostFixture();
  expect(inspectBootstrapDatabaseSamples(f.samples, f.compose, f.options)).toEqual({
    status: 'verified',
  });
});

test.each(['runtime', 'bootstrap'] as const)(
  'protected volume binding permits a selected restored origin in %s mode only with its exact identity',
  (mode) => {
    const f = mode === 'runtime' ? runtimeHostFixture() : bootstrapHostFixture();
    for (const sample of [f.samples.before, f.samples.after]) {
      sample.volume.project = 'fcd-support-restore-synthetic';
      sample.volume.logicalName = 'restore-data';
    }
    const volumeIdentity = {
      name: f.samples.before.volume.name,
      project: 'fcd-support-restore-synthetic',
      logicalName: 'restore-data',
      createdAt: f.samples.before.volume.createdAt,
    };
    const inspect =
      mode === 'runtime' ? inspectRuntimeHostSamples : inspectBootstrapDatabaseSamples;
    const options = { ...f.options, ingressPeerId: runtimeHostFixture().options.ingressPeerId };
    expect(() => inspect(f.samples, f.compose, options)).toThrow('runtime_host_invalid');
    const boundOptions = { ...options, volumeIdentity };
    expect(inspect(f.samples, f.compose, boundOptions)).toEqual({ status: 'verified' });
  },
);
test.each(['runtime', 'bootstrap'] as const)(
  'a selected externally provisioned volume has an explicit absent-label identity in %s mode',
  (mode) => {
    const f = mode === 'runtime' ? runtimeHostFixture() : bootstrapHostFixture();
    const replace = (s: typeof f.samples.before) => ({
      ...s,
      volume: { ...s.volume, project: null, logicalName: null },
    });
    const samples = {
      ...f.samples,
      before: replace(f.samples.before),
      after: replace(f.samples.after),
    };
    const volumeIdentity = {
      name: f.samples.before.volume.name,
      project: null,
      logicalName: null,
      createdAt: f.samples.before.volume.createdAt,
    };
    const inspect =
      mode === 'runtime' ? inspectRuntimeHostSamples : inspectBootstrapDatabaseSamples;
    const options = {
      ...f.options,
      ingressPeerId: runtimeHostFixture().options.ingressPeerId,
      volumeIdentity,
    };
    expect(inspect(samples, f.compose, options)).toEqual({ status: 'verified' });
  },
);
test.each(['runtime', 'bootstrap'] as const)(
  'protected expected volume facts are enforced in %s mode',
  (mode) => {
    const f = mode === 'runtime' ? runtimeHostFixture() : bootstrapHostFixture();
    const actual = f.samples.before.volume;
    const expected = {
      name: actual.name,
      project: actual.project,
      logicalName: actual.logicalName,
      createdAt: actual.createdAt,
    };
    const inspect =
      mode === 'runtime' ? inspectRuntimeHostSamples : inspectBootstrapDatabaseSamples;
    for (const override of [
      { name: 'fcd-support-substituted' },
      { project: 'fcd-support-foreign' },
      { logicalName: 'restore-data' },
      { createdAt: '2030-05-01T00:00:00.000Z' },
      { project: null },
      { approved: true },
    ]) {
      const options = {
        ...f.options,
        ingressPeerId: runtimeHostFixture().options.ingressPeerId,
        volumeIdentity: { ...expected, ...override },
      };
      expect(() => inspect(f.samples, f.compose, options)).toThrow('runtime_host_invalid');
    }
  },
);

test.each([
  'application-present',
  'application-network-member',
  'socket-present',
  'foreign-socket-parent',
  'volume-user',
  'volume-name',
  'image',
  'root-user',
  'host-port',
  'data-source',
  'restart',
  'extra-probes',
] as const)('bootstrap PostgreSQL proof refuses %s before owner preparation', (fault) => {
  const f = bootstrapHostFixture();
  const pg = f.samples.after.containers[0];
  const net = f.samples.after.networks[0];
  if (pg === undefined || net === undefined) throw new Error('synthetic_fixture_invalid');
  switch (fault) {
    case 'application-present': {
      const other = runtimeHostFixture().samples.before.containers[1];
      if (other === undefined) throw new Error('synthetic_fixture_invalid');
      f.samples.after.containers.push(other);
      break;
    }
    case 'application-network-member':
      net.members.push('2'.repeat(64));
      break;
    case 'socket-present':
      f.samples.after.socket = runtimeHostFixture().samples.before.socket;
      break;
    case 'foreign-socket-parent':
      f.samples.after.hostBinds.push({
        containerId: '0'.repeat(64),
        source: '/run',
        canonicalSource: '/run',
      });
      break;
    case 'volume-user':
      f.samples.after.volume.users.push('0'.repeat(64));
      break;
    case 'volume-name':
      f.samples.after.volume.name = 'fcd-support-foreign';
      break;
    case 'image':
      f.samples.after.images.postgres.id = `sha256:${'0'.repeat(64)}`;
      break;
    case 'root-user':
      pg.user = 'root';
      break;
    case 'host-port':
      pg.hostPortBindings = 1;
      break;
    case 'data-source': {
      const data = pg.mounts.find((m) => m.type === 'volume');
      if (data === undefined) throw new Error('synthetic_fixture_invalid');
      data.source = '/foreign';
      break;
    }
    case 'restart':
      pg.startedAt = '2030-04-01T00:01:00Z';
      break;
    case 'extra-probes':
      expect(() =>
        inspectBootstrapDatabaseSamples(
          { ...f.samples, probes: runtimeHostFixture().samples.probes },
          f.compose,
          f.options,
        ),
      ).toThrow(/^runtime_host_invalid$/u);
      return;
  }
  expect(() => inspectBootstrapDatabaseSamples(f.samples, f.compose, f.options)).toThrow(
    /^runtime_host_invalid$/u,
  );
});

test.runIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only')(
  'compiled runtime validator consumes only bounded metadata and emits a closed result',
  () => {
    const f = runtimeHostFixture();
    const entry = existsSync('/app/dist/operations/runtime-host-main.js')
      ? '/app/dist/operations/runtime-host-main.js'
      : resolve('dist/operations/runtime-host-main.js');
    const args = [
      f.options.revision,
      paths.adminSocketRoot,
      paths.configRoot,
      paths.secretRoot,
      paths.workspaceRoot,
      f.options.ingressPeerId,
    ];
    const body = JSON.stringify({ compose: f.compose, samples: f.samples });
    const valid = spawnSync(process.execPath, [entry, ...args], {
      input: body,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 2048,
    });
    expect({ status: valid.status, stdout: valid.stdout, stderr: valid.stderr }).toEqual({
      status: 0,
      stdout: '{"status":"verified"}\n',
      stderr: '',
    });
    for (const [parameters, input] of [
      [args.slice(1), body],
      [args, '{'],
      [args, 'x'.repeat(1048577)],
      [
        args,
        JSON.stringify({
          compose: f.compose,
          samples: { ...f.samples, probes: { ...f.samples.probes, adminNoTcp: false } },
        }),
      ],
    ] as const) {
      const refused = spawnSync(process.execPath, [entry, ...parameters], {
        input,
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 2048,
      });
      expect({ status: refused.status, stdout: refused.stdout, stderr: refused.stderr }).toEqual({
        status: 1,
        stdout: '',
        stderr: 'runtime_host_invalid\n',
      });
    }
    const boot = bootstrapHostFixture();
    const prepared = spawnSync(
      process.execPath,
      [
        entry,
        'bootstrap',
        revision,
        paths.adminSocketRoot,
        paths.configRoot,
        paths.secretRoot,
        paths.workspaceRoot,
      ],
      {
        input: JSON.stringify({ compose: boot.compose, samples: boot.samples }),
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 2048,
      },
    );
    expect({ status: prepared.status, stdout: prepared.stdout, stderr: prepared.stderr }).toEqual({
      status: 0,
      stdout: '{"status":"verified"}\n',
      stderr: '',
    });
  },
  15000,
);

test.each([
  'extra-container',
  'missing-role',
  'wrong-project',
  'wrong-image',
  'wrong-image-platform',
  'wrong-image-user',
  'wrong-revision',
  'running',
  'paused',
  'health',
  'rootfs',
  'privileged',
  'user',
  'init',
  'cpu',
  'memory',
  'pids',
  'tmpfs',
  'command',
  'entrypoint',
  'host-port',
  'published-port',
  'host-network',
  'extra-network',
  'network-member',
  'public-data-network',
  'wrong-network-label',
  'ingress-peer',
  'secret-source',
  'writable-secret',
  'extra-mount',
  'socket-other-role',
  'socket-parent-mount',
  'socket-alias',
  'socket-mode',
  'socket-root-owner',
  'volume-user',
  'volume-name',
  'volume-options',
  'execution-enabled',
  'plaintext-secret',
  'capability',
  'security-option',
  'host-pid',
  'host-ipc',
  'device',
  'group',
  'sysctl',
  'restart-between-samples',
  'socket-replaced',
  'probe',
  'invalid-compose',
] as const)('runtime host refuses %s despite reported Docker health', (fault) => {
  const f = runtimeHostFixture();
  const c = f.samples.after.containers[2];
  const n = f.samples.after.networks[0];
  const m = c?.mounts[0];
  if (c === undefined || n === undefined || m === undefined)
    throw new Error('synthetic_fixture_invalid');
  switch (fault) {
    case 'extra-container':
      f.samples.after.containers.push(structuredClone(c));
      break;
    case 'missing-role':
      f.samples.after.containers.pop();
      break;
    case 'wrong-project':
      c.project = 'fcd-support-foreign';
      break;
    case 'wrong-image':
      c.imageId = `sha256:${'0'.repeat(64)}`;
      break;
    case 'wrong-image-platform':
      f.samples.after.images.runtime.architecture = 'arm64';
      break;
    case 'wrong-image-user':
      f.samples.after.images.runtime.user = 'root';
      break;
    case 'wrong-revision':
      c.revision = '0'.repeat(40);
      break;
    case 'running':
      c.running = false;
      break;
    case 'paused':
      c.paused = true;
      break;
    case 'health':
      c.healthy = false;
      break;
    case 'rootfs':
      c.readOnlyRootfs = false;
      break;
    case 'privileged':
      c.privileged = true;
      break;
    case 'user':
      c.user = 'root';
      break;
    case 'init':
      c.init = false;
      break;
    case 'cpu':
      c.nanoCpus = 0;
      break;
    case 'memory':
      c.memory = 0;
      break;
    case 'pids':
      c.pidsLimit = -1;
      break;
    case 'tmpfs':
      c.tmpfs['/run/fcd-support'] = 'rw,size=16m';
      break;
    case 'command':
      c.command = ['node', 'dist/main.js'];
      break;
    case 'entrypoint':
      c.entrypoint = ['/bin/sh'];
      break;
    case 'host-port':
      c.hostPortBindings = 1;
      break;
    case 'published-port':
      c.publishedPortBindings = 1;
      break;
    case 'host-network':
      c.networkMode = 'host';
      break;
    case 'extra-network':
      c.networks.push({ name: 'foreign', id: '0'.repeat(64) });
      break;
    case 'network-member':
      n.members.push('0'.repeat(64));
      break;
    case 'public-data-network':
      n.internal = false;
      break;
    case 'wrong-network-label':
      n.project = 'fcd-support-foreign';
      break;
    case 'ingress-peer':
      f.options.ingressPeerId = '0'.repeat(64);
      break;
    case 'secret-source':
      m.source = '/protected/foreign';
      break;
    case 'writable-secret':
      m.readWrite = true;
      break;
    case 'extra-mount':
      c.mounts.push({ ...m, source: '/etc', destination: '/host' });
      break;
    case 'socket-other-role':
      f.samples.after.hostBinds.push({
        containerId: '0'.repeat(64),
        source: paths.adminSocketRoot,
        canonicalSource: paths.adminSocketRoot,
      });
      break;
    case 'socket-parent-mount':
      f.samples.after.hostBinds.push({
        containerId: '0'.repeat(64),
        source: '/run',
        canonicalSource: '/run',
      });
      break;
    case 'socket-alias':
      f.samples.after.hostBinds.push({
        containerId: c.id,
        source: '/alias',
        canonicalSource: paths.adminSocketRoot,
      });
      break;
    case 'socket-mode':
      f.samples.after.socket.mode = 438;
      break;
    case 'socket-root-owner':
      f.samples.after.socket.rootUid = 0;
      break;
    case 'volume-user':
      f.samples.after.volume.users.push('0'.repeat(64));
      break;
    case 'volume-name':
      f.samples.after.volume.name = 'fcd-support-foreign';
      break;
    case 'volume-options':
      f.samples.after.volume.options = { type: 'nfs' } as never;
      break;
    case 'execution-enabled':
      c.executionFlags[0] = 'MODEL_EXECUTION_ENABLED=true';
      break;
    case 'plaintext-secret':
      c.environmentNames.push('DATABASE_URL');
      break;
    case 'capability':
      c.capAdd.push('SYS_ADMIN' as never);
      break;
    case 'security-option':
      c.securityOpt = [];
      break;
    case 'host-pid':
      c.pidMode = 'host';
      break;
    case 'host-ipc':
      c.ipcMode = 'host';
      break;
    case 'device':
      c.devices = 1;
      break;
    case 'group':
      c.groupAdd.push('0' as never);
      break;
    case 'sysctl':
      c.sysctls = { 'net.ipv4.ip_forward': '1' };
      break;
    case 'restart-between-samples':
      c.startedAt = '2030-04-01T00:01:00Z';
      break;
    case 'socket-replaced':
      f.samples.after.socket.inode = '35';
      break;
    case 'probe':
      f.samples.probes.adminSocket = false;
      break;
    case 'invalid-compose':
      {
        const adminMount = f.compose.services['fcd-support-admin'].volumes[0];
        if (adminMount === undefined) throw new Error('synthetic_fixture_invalid');
        adminMount.read_only = true;
      }
      break;
  }
  expect(() => inspectRuntimeHostSamples(f.samples, f.compose, f.options)).toThrow(
    /^runtime_host_invalid$/u,
  );
});

test
  .runIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only')
  .each([
    'ok',
    'probe',
    'changed',
    'extra-container',
    'validator-ambiguous',
    'bootstrap',
    'bootstrap-network',
    'bootstrap-socket',
    'bootstrap-application',
    'bootstrap-changed',
    'bootstrap-ambiguous',
    'bootstrap-foreign-bind',
    'selected-restore',
    'selected-external',
    'selected-system',
    'selected-changed',
    'selected-missing',
    'selected-config',
    'selected-missing-empty',
    'selected-state-phase',
    'selected-state-revision',
    'selected-state-schema',
    'bootstrap-selected-restore',
    'bootstrap-selected-external',
    'bootstrap-selected-system',
    'bootstrap-selected-changed',
  ] as const)(
  'runtime host collector handles %s with real shell and compiled validator',
  async (fault) => {
    const root = await mkdtemp('/run/fcd-support/runtime-host-test-');
    const bin = await mkdtemp('/var/lib/fcd-support/backups/runtime-host-bin-');
    await chmod(root, 0o700);
    await chmod(bin, 0o700);
    const bootstrap = fault.startsWith('bootstrap');
    const original = bootstrap ? bootstrapHostFixture() : runtimeHostFixture();
    const f = JSON.parse(
      JSON.stringify(original)
        .replaceAll(paths.adminSocketRoot, `${root}/socket`)
        .replaceAll(paths.secretRoot, `${root}/secrets`)
        .replaceAll(paths.configRoot, `${root}/config`),
    ) as typeof original;
    const selected = fault.includes('selected');
    if (selected) {
      const volumeName = 'fcd-support-selected-data';
      const volume = f.compose.volumes['postgres-data'];
      volume.name = volumeName;
      for (const sample of [f.samples.before, f.samples.after]) {
        sample.volume.name = volumeName;
        sample.volume.project = fault.endsWith('external') ? '' : 'fcd-support-restore-synthetic';
        sample.volume.logicalName = fault.endsWith('external') ? '' : 'restore-data';
        sample.volume.mountpoint = '/var/lib/docker/volumes/' + volumeName + '/_data';
        for (const c of sample.containers)
          for (const m of c.mounts)
            if (m.type === 'volume') {
              m.name = volumeName;
              m.source = sample.volume.mountpoint;
            }
      }
      await mkdir(join(root, 'state'), { mode: 0o700 });
      if (fault !== 'selected-missing-empty')
        await writeFile(
          join(
            root,
            'state',
            fault === 'selected-missing' ? 'volume-synthetic.record' : 'deployment-state',
          ),
          'synthetic_state_reader_adapter_only\n',
          { mode: 0o600 },
        );
    }
    if (fault === 'bootstrap-network') {
      const network = f.samples.before.networks[0];
      if (network === undefined) throw new Error('synthetic_fixture_invalid');
      network.members.push('0'.repeat(64));
    }
    if (fault === 'bootstrap-application') {
      const app = runtimeHostFixture().samples.before.containers[1];
      if (app === undefined) throw new Error('synthetic_fixture_invalid');
      f.samples.before.containers.push(app);
    }
    await mkdir(f.options.paths.adminSocketRoot, { mode: 0o700 });
    for (const bind of f.samples.before.hostBinds.filter(
      (b) => b.source !== f.options.paths.adminSocketRoot,
    )) {
      await mkdir(resolve(bind.source, '..'), { recursive: true, mode: 0o700 });
      await writeFile(bind.source, 'synthetic_runtime_mount_fixture_only', { mode: 0o600 });
    }
    const server = createServer((socket) => {
      socket.destroy();
    });
    let listening = false;
    try {
      if (!bootstrap || fault === 'bootstrap-socket') {
        await new Promise<void>((done, reject) => {
          server.once('error', reject);
          server.listen(join(f.options.paths.adminSocketRoot, 'admin.sock'), done);
        });
        listening = true;
        await chmod(join(f.options.paths.adminSocketRoot, 'admin.sock'), 0o600);
      }
      await writeFile(join(bin, 'fixture.json'), JSON.stringify(f), { mode: 0o600 });
      await writeFile(join(bin, 'failure'), fault, { mode: 0o600 });
      await writeFile(
        join(bin, 'docker'),
        `#!/usr/bin/env bash
set -eu
scope="$(dirname "$0")"
printf '%s\\n' docker >> "$scope/trace"
if [[ " $* " == *" compose "* ]]; then
  if [[ " $* " == *" config "* ]]; then node "$scope/project.cjs" compose
  else
    [[ " $* " == *"OPS_DATABASE_SYSTEM_IDENTIFIER=1111111111111111111"* && " $* " == *"OPS_DATABASE_ROLE_PREFIX=fcd_support"* && " $* " == *"OPS_DATABASE_NAME=fcd_support_test"* ]] || exit 29
    printf '%s\\n' sql >> "$scope/trace"
    printf '{"status":"completed","processed":1,"reasonCode":"ok"}\\n'
  fi
elif [[ " $* " == *" ps "* ]]; then node "$scope/project.cjs" ids "$@"
elif [[ " $* " == *" image inspect "* ]]; then node "$scope/project.cjs" image "$@"
elif [[ " $* " == *" volume inspect "* ]]; then node "$scope/project.cjs" volume "$@"
elif [[ " $* " == *" network inspect "* ]]; then node "$scope/project.cjs" network "$@"
elif [[ " $* " == *" container inspect "* ]]; then node "$scope/project.cjs" container "$@"
elif [[ " $* " == *" exec "* ]]; then
  printf '%s\\n' exec >> "$scope/trace"
  if [[ " $* " == *"pg_controldata "* ]]; then printf '%s\\n' 1111111111111111111; exit 0; fi
  [[ "$(<"$scope/failure")" != probe ]] || exit 17
  touch "$scope/probed"
elif [[ " $* " == *" run "* ]]; then
  printf '%s\\n' run >> "$scope/trace"
  if [[ "$(<"$scope/failure")" == *ambiguous ]]; then printf '{"status":"verified"}\\n'; exit 17; fi
  while [[ "$1" != dist/operations/runtime-host-main.js ]]; do shift; done
  shift
  exec node "$(<"$scope/cli")" "$@"
else exit 19
fi
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(bin, 'project.cjs'),
        `
const fs=require('node:fs'); const path=require('node:path'); const root=__dirname;
const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8')); const s=f.samples.before;
const args=process.argv.slice(3); const mode=process.argv[2]; const last=args.at(-1); const format=args[args.indexOf('--format')+1]||'';
fs.appendFileSync(path.join(root,'trace'),mode+'\\n');
const fault=fs.readFileSync(path.join(root,'failure'),'utf8');
const output=v=>process.stdout.write(typeof v==='string'?v+'\\n':JSON.stringify(v)+'\\n');
if(mode==='compose')output(f.compose);
else if(mode==='ids') {
  const service=args.find(a=>a.startsWith('label=com.docker.compose.service='))?.split('=').at(-1);
  const list=service?s.containers.filter(c=>c.service===service):args.some(a=>a.startsWith('volume='))?[s.containers[0]]:s.containers;
  const foreign=fault==='bootstrap-foreign-bind'&&!args.some(a=>a.startsWith('label=')||a.startsWith('volume='));
  output(list.map(c=>c.id).join('\\n')+((fault==='extra-container'&&!service)||foreign?'\\n'+'0'.repeat(64):''));
} else if(mode==='image') {
  const image=last==='synthetic-pg'?s.images.postgres:s.images.runtime;
  if(format.startsWith('{"'))output(image);else output(image.id+'/'+f.options.revision+'/linux/amd64/'+image.user);
} else if(mode==='volume') {
  const {users,...volume}=s.volume; output(JSON.stringify(volume).slice(0,-1));
} else if(mode==='network') {
  const net=s.networks.find(n=>n.name===last); if(!net)process.exit(19);
  if(format.startsWith('{"')){const {members,...metadata}=net;output(JSON.stringify(metadata).slice(0,-1));}else output(net.members.join('\\n'));
} else if(mode==='container') {
  if(fault==='bootstrap-foreign-bind'&&last==='0'.repeat(64)){output('/run');process.exit(0)}
  const c=s.containers.find(c=>c.id===last);if(!c)process.exit(19);
  if(format.startsWith('{{.Id}}/'))output(c.id+'/'+c.project+'/'+c.service+'/'+c.revision+'/'+c.imageId+'/'+c.running+'/'+c.paused+'/'+c.restarting+'/'+c.dead+'/'+c.startedAt);
  else if(format.startsWith('{"')) {
    const value=structuredClone(c); if((fault==='changed'&&fs.existsSync(path.join(root,'probed')))||(fault==='bootstrap-changed'&&fs.existsSync(path.join(root,'sampled'))))value.startedAt='2030-04-01T00:01:00Z';fs.writeFileSync(path.join(root,'sampled'),'sampled');output(value);
  }else output(c.mounts.filter(m=>m.type==='bind').map(m=>m.source).join('\\n'));
} else process.exit(19);
`,
        { mode: 0o600 },
      );
      const entry = existsSync('/app/dist/operations/runtime-host-main.js')
        ? '/app/dist/operations/runtime-host-main.js'
        : resolve('dist/operations/runtime-host-main.js');
      await writeFile(join(bin, 'cli'), entry, { mode: 0o600 });
      const result = spawnSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `
source "$TASK_COMMON"
source "$TASK_LIBRARY"
OPS_ROOT=/workspace/source
OPS_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
declare -A OPS_CONFIG=([FCD_RUNTIME_PROJECT]=fcd-support-runtime [FCD_SUPPORT_REVISION]="$OPS_REVISION" [FCD_SUPPORT_IMAGE]=synthetic-app [FCD_POSTGRES_IMAGE]=synthetic-pg [FCD_OPERATIONS_IMAGE]=synthetic-operations
[FCD_POSTGRES_VOLUME]=fcd-support-runtime-postgres [FCD_ADMIN_SOCKET_ROOT]="$TASK_ROOT/socket" [FCD_CONFIG_ROOT]="$TASK_ROOT/config" [FCD_SECRET_ROOT]="$TASK_ROOT/secrets"
[FCD_INGRESS_NETWORK]=fcd-support-runtime-ingress
[FCD_POSTGRES_DB]=fcd_support_test [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=fcd_support [FCD_SCHEMA_REVISION]=000016
[FCD_INGRESS_PEER_ID]=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff [FCD_COMMAND_TIMEOUT_SECONDS]=10 [FCD_STOP_GRACE_MS]=30000 [FCD_HEALTH_TIMEOUT_MS]=1000
[FCD_ADMIN_CPUS]=0.5 [FCD_ADMIN_MEMORY_MIB]=256 [FCD_ADMIN_PIDS]=64)
if [[ "$TASK_SELECTED" == yes ]]; then
  OPS_CONFIG[FCD_STATE_ROOT]="$TASK_ROOT/state"
  OPS_CONFIG[FCD_POSTGRES_VOLUME]="$TASK_VOLUME"
  [[ "$TASK_FAULT" != selected-config ]] || OPS_CONFIG[FCD_POSTGRES_VOLUME]=fcd-support-stale
  # The filesystem protocol has separate real native tests. This adapter double
  # supplies protected state facts to the real collector/compiled validator.
  operations_selection_read() {
    declare -gA OPS_SELECTION=([STATE_VOLUME]="$TASK_VOLUME" [STATE_VOLUME_ORIGIN]=fcd-support-restore-synthetic [STATE_VOLUME_LOGICAL]=restore-data [STATE_VOLUME_CREATED_AT]="$TASK_CREATED" [STATE_SYSTEM_IDENTIFIER]=1111111111111111111 [STATE_REF]=selection_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa [STATE_PHASE]=starting [STATE_WRITES_POSSIBLE]=yes [STATE_REVISION]=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa [STATE_SCHEMA_REVISION]=000016)
    if [[ "$TASK_FAULT" == *external ]]; then OPS_SELECTION[STATE_VOLUME_ORIGIN]=none; OPS_SELECTION[STATE_VOLUME_LOGICAL]=none; fi
    if [[ "$TASK_FAULT" == *system || ( "$TASK_FAULT" == selected-changed && -e "$TASK_BIN/probed" ) || ( "$TASK_FAULT" == bootstrap-selected-changed && -e "$TASK_BIN/sampled" ) ]]; then OPS_SELECTION[STATE_SYSTEM_IDENTIFIER]=2222222222222222222; fi
    if [[ "$TASK_FAULT" == selected-state-phase ]]; then OPS_SELECTION[STATE_PHASE]=quiescent; OPS_SELECTION[STATE_WRITES_POSSIBLE]=no; fi
    [[ "$TASK_FAULT" != selected-state-revision ]] || OPS_SELECTION[STATE_REVISION]=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    [[ "$TASK_FAULT" != selected-state-schema ]] || OPS_SELECTION[STATE_SCHEMA_REVISION]=000015
    return 0
  }
fi
if [[ "$TASK_KIND" == bootstrap ]]; then operations_inspect_bootstrap_database; else operations_inspect_runtime_host; fi
`,
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 2048,
          env: {
            PATH: bin + ':' + (process.env.PATH ?? ''),
            TASK_ROOT: root,
            TASK_KIND: bootstrap ? 'bootstrap' : 'runtime',
            TASK_CLI: entry,
            TASK_SELECTED: selected ? 'yes' : 'no',
            TASK_VOLUME: f.samples.before.volume.name,
            TASK_CREATED: f.samples.before.volume.createdAt,
            TASK_FAULT: fault,
            TASK_BIN: bin,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_LIBRARY: resolve('scripts/operations-runtime-host.sh'),
          },
        },
      );
      const success =
        fault === 'ok' ||
        fault === 'bootstrap' ||
        (selected && (fault.endsWith('restore') || fault.endsWith('external')));
      if (success && result.status !== 0)
        throw new Error(
          'synthetic_runtime_collector_phases:' + (await readFile(join(bin, 'trace'), 'utf8')),
        );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
        success
          ? {
              status: 0,
              stdout: bootstrap ? 'bootstrap_database_verified\n' : 'runtime_host_verified\n',
              stderr: '',
            }
          : { status: 1, stdout: '', stderr: 'runtime_host_invalid\n' },
      );
      const phases = (await readFile(join(bin, 'trace'), 'utf8').catch(() => ''))
        .trim()
        .split('\n');
      if (selected) {
        if (
          [
            'selected-missing',
            'selected-config',
            'selected-missing-empty',
            'selected-state-phase',
            'selected-state-revision',
            'selected-state-schema',
          ].includes(fault)
        )
          expect(phases).toEqual(['']);
        else {
          expect(phases).toContain('image');
          expect(phases).toContain('exec');
          if (!bootstrap && !fault.endsWith('system')) expect(phases).toContain('sql');
          else expect(phases).not.toContain('sql');
          if (success) expect(phases).toContain('run');
          else expect(phases).not.toContain('run');
        }
        return;
      }
      expect(phases).toContain('image');
      if (!bootstrap && fault !== 'extra-container') expect(phases).toContain('sql');
      else expect(phases).not.toContain('sql');
      if (fault === 'extra-container' || bootstrap) expect(phases).not.toContain('exec');
      else expect(phases).toContain('exec');
      if (
        fault === 'ok' ||
        fault === 'changed' ||
        fault === 'validator-ambiguous' ||
        [
          'bootstrap',
          'bootstrap-network',
          'bootstrap-changed',
          'bootstrap-ambiguous',
          'bootstrap-foreign-bind',
        ].includes(fault)
      )
        expect(phases).toContain('run');
      else expect(phases).not.toContain('run');
    } finally {
      if (listening)
        await new Promise<void>((done, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else done();
          });
        });
      await rm(root, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  },
  15000,
);
