import { expect, test } from 'vitest';
import { assertRestoreCompose } from '../src/operations/compose-contract.js';
import { runtimeDatabaseRoles } from '../src/persistence/postgres-runtime-grants.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

const revision = 'a'.repeat(40);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('synthetic_fixture_missing');
  return value;
}
const passwords = [...runtimeDatabaseRoles, 'migrator'].map(
  (role) => `bootstrap-${role.replaceAll('_', '-')}-password`,
);
const specs = {
  restore: {
    networks: ['restore_data', 'source_data'],
    secrets: ['restore-archive-database', 'restore-database', 'restore-identity', 'recovery-hmac'],
    path: 'restore-stream-main',
    profile: 'isolated-restore',
  },
  'restore-bootstrap': {
    networks: ['restore_data'],
    secrets: ['restore-database', ...passwords],
    path: 'bootstrap-main',
    profile: 'restore-bootstrap',
  },
  'restore-migrate': {
    networks: ['restore_data'],
    secrets: ['restore-migrator-database'],
    path: 'restore-migrate-main',
    profile: 'restore-migrate',
  },
  'restore-reconcile': {
    networks: ['restore_data', 'source_data'],
    secrets: [
      'restore-checkpoint-database',
      'restore-database',
      'restore-keyring',
      'restore-identity',
      'recovery-hmac',
    ],
    path: 'restore-reconcile-main',
    profile: 'restore-reconcile',
  },
  promote: {
    networks: ['restore_data', 'source_data'],
    secrets: [
      'restore-checkpoint-database',
      'restore-database',
      'restore-keyring',
      'restore-identity',
      'recovery-hmac',
    ],
    path: 'promotion-main',
    profile: 'restore-promote',
  },
};
function service(networks: string[], secrets: string[]) {
  return {
    image: `synthetic-operations:${revision}`,
    labels: { 'org.opencontainers.image.revision': revision },
    user: 'node',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    init: true,
    pids_limit: 64,
    cpus: 0.5,
    mem_limit: '268435456',
    stop_grace_period: '30s',
    restart: 'no',
    healthcheck: { test: ['CMD', 'node', '--version'], interval: '10s', timeout: '3s', retries: 3 },
    networks: Object.fromEntries(networks.map((name) => [name, {}])),
    environment: {
      ...operationsEnvironment(),
      OPS_RESOURCE_LIMITS_JSON: JSON.stringify(
        Object.fromEntries(
          ['webhook', 'migrate', 'restore'].map((role) => [
            role,
            { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
          ]),
        ),
      ),
      NODE_ENV: 'production',
      OPS_GIT_REVISION: revision,
      OPS_DATABASE_NAME: 'fcd_support_test',
      OPS_DATABASE_SCHEMA: 'public',
      OPS_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
      RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
      RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
      MODEL_EXECUTION_ENABLED: 'false',
      OUTBOUND_EXECUTION_ENABLED: 'false',
      N8N_EXECUTION_ENABLED: 'false',
    } as Record<string, string>,
    secrets: secrets.map((source) => ({ source })),
    tmpfs: ['/run/fcd-support:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16m'],
    ports: [] as unknown[],
    volumes: [] as { type: string; source: string; target: string; read_only?: boolean }[],
    profiles: [] as string[],
    command: [] as string[],
    entrypoint: ['/usr/local/bin/container-entrypoint.sh', 'application'],
  };
}
function fixture() {
  const services: Record<string, ReturnType<typeof service>> = {};
  const pg = service(['restore_data'], ['restore-postgres-password']);
  pg.user = 'postgres';
  pg.tmpfs = [
    '/var/run/postgresql:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=16m',
    '/tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m',
  ];
  pg.volumes = [{ type: 'volume', source: 'restore-data', target: '/var/lib/postgresql' }];
  services.postgres = pg;
  for (const [name, spec] of Object.entries(specs)) {
    const value = service(spec.networks, spec.secrets);
    value.profiles = [spec.profile];
    value.command = ['node', `dist/operations/${spec.path}.js`];
    if (!['restore-bootstrap', 'restore-migrate'].includes(name)) {
      value.entrypoint[1] = 'operations-readonly';
      value.volumes = [
        {
          type: 'volume',
          source: 'backups',
          target: '/var/lib/fcd-support/backups',
          read_only: true,
        },
      ];
      value.environment.BACKUP_AGE_IDENTITY_FILE = '/run/secrets/restore-identity';
      value.environment.RECOVERY_MANIFEST_HMAC_FILE = '/run/secrets/recovery-hmac';
      value.environment.RESTORE_TARGET_OWNER_DATABASE_URL_FILE = '/run/secrets/restore-database';
    }
    if (name === 'restore') {
      value.environment.BACKUP_ARCHIVE_DIRECTORY = '/var/lib/fcd-support/backups';
      value.environment.BACKUP_TMPFS_DIRECTORY = '/run/fcd-support';
      value.environment.RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE =
        '/run/secrets/restore-archive-database';
    }
    if (name === 'restore-reconcile' || name === 'promote') {
      value.environment.CHECKPOINT_ARCHIVE_DIRECTORY = '/var/lib/fcd-support/backups';
      value.environment.RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE =
        '/run/secrets/restore-checkpoint-database';
      value.environment.PRIVACY_HMAC_KEYRING_FILE = '/run/secrets/restore-keyring';
    }
    if (name === 'restore-bootstrap')
      value.environment.DATABASE_URL_FILE = '/run/secrets/restore-database';
    if (name === 'restore-migrate')
      value.environment.DATABASE_URL_FILE = '/run/secrets/restore-migrator-database';
    services[name] = value;
  }
  return {
    name: 'fcd-support-restore-synthetic',
    services,
    networks: {
      restore_data: { name: 'fcd-support-restore-synthetic-data', external: true },
      source_data: { name: 'fcd-support-operations-data', external: true },
    },
    volumes: {
      'restore-data': { name: 'fcd-support-restore-synthetic-data' },
      backups: { name: 'fcd-support-backups', external: true },
    },
    secrets: Object.fromEntries(
      [
        ...new Set(
          Object.values(services).flatMap((value) => value.secrets.map((secret) => secret.source)),
        ),
      ].map((name) => [name, { file: `/protected/synthetic/${name}` }]),
    ),
  };
}

for (const name of Object.keys(specs)) {
  for (const key of [
    'BACKUP_ARCHIVE_DIRECTORY',
    'BACKUP_TMPFS_DIRECTORY',
    'CHECKPOINT_ARCHIVE_DIRECTORY',
  ]) {
    test(`split restore refuses missing or foreign ${key} on ${name}`, () => {
      const input = fixture();
      const value = required(input.services[name]);
      if (key in value.environment)
        value.environment = Object.fromEntries(
          Object.entries(value.environment).filter(([name]) => name !== key),
        );
      else value.environment[key] = '/var/lib/fcd-support/backups';
      expect(() => {
        assertRestoreCompose(input, revision, 'fcd-support-original');
      }).toThrow();
    });
  }
}

test.each(
  Object.keys(specs).flatMap((name) =>
    ['depends_on', 'links', 'external_links'].map((field) => ({ name, field })),
  ),
)('one-shot $name rejects implicit dependency field $field', ({ name, field }) => {
  const value = fixture();
  Object.assign(required(value.services[name]), {
    [field]: field === 'depends_on' ? { postgres: { condition: 'service_healthy' } } : ['postgres'],
  });
  expect(() => {
    assertRestoreCompose(value, revision, 'fcd-support-live-data');
  }).toThrow('compose_contract_invalid');
});
test('accepts split restore jobs with target-only password bootstrap and narrow source-connected jobs', () => {
  expect(() => {
    assertRestoreCompose(fixture(), revision, 'fcd-support-live-data');
  }).not.toThrow();
});
test.each([
  'bootstrap-source',
  'migration-source',
  'stream-password',
  'reconcile-migrator',
  'promote-password',
  'postgres-source',
  'monolithic-driver',
  'owner-secret-alias',
  'archive-write',
  'unexpected-service',
  'target-runtime-volume',
  'source-not-external',
])('refuses split restore capability violation %s', (fault) => {
  const value = fixture();
  const s = value.services;
  const get = (name: string) => required(s[name]);
  if (fault === 'bootstrap-source') get('restore-bootstrap').networks.source_data = {};
  if (fault === 'migration-source') get('restore-migrate').networks.source_data = {};
  if (fault === 'stream-password') get('restore').secrets.push({ source: required(passwords[0]) });
  if (fault === 'reconcile-migrator')
    get('restore-reconcile').secrets.push({ source: 'restore-migrator-database' });
  if (fault === 'promote-password') get('promote').secrets.push({ source: required(passwords[0]) });
  if (fault === 'postgres-source') get('postgres').networks.source_data = {};
  if (fault === 'monolithic-driver')
    get('restore').command = ['node', 'dist/operations/restore-main.js'];
  if (fault === 'owner-secret-alias')
    required(value.secrets['restore-database']).file = required(
      value.secrets['restore-postgres-password'],
    ).file;
  if (fault === 'archive-write') required(get('restore').volumes[0]).read_only = false;
  if (fault === 'unexpected-service') s.foreign = service(['source_data'], []);
  if (fault === 'target-runtime-volume')
    value.volumes['restore-data'].name = 'fcd-support-live-data';
  if (fault === 'source-not-external') value.networks.source_data.external = false;
  expect(() => {
    assertRestoreCompose(value, revision, 'fcd-support-live-data');
  }).toThrow('compose_contract_invalid');
});
