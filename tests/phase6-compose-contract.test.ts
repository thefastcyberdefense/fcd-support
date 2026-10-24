import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { operationsEnvironment } from './helpers/operations-fixtures.js';

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
