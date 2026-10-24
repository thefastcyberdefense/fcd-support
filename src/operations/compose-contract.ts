import { z } from 'zod';
import { posix, win32 } from 'node:path';

import { loadOperationsConfig } from './operations-config.js';
import { runtimeRoles } from './operations-types.js';
import { runtimeDatabaseRoles } from '../persistence/postgres-runtime-grants.js';

const serviceSchema = z.object({
  image: z.string(),
  labels: z.record(z.string(), z.string()),
  user: z.string(),
  read_only: z.literal(true),
  cap_drop: z.array(z.string()),
  security_opt: z.array(z.string()),
  init: z.literal(true),
  pids_limit: z.number().int().positive(),
  cpus: z.number().positive(),
  mem_limit: z.union([z.number().positive(), z.string().regex(/^[1-9][0-9]*(?:[kmgKMG])?$/u)]),
  stop_grace_period: z.string().min(1),
  restart: z.string(),
  command: z.array(z.string()).nullish(),
  entrypoint: z.array(z.string()).nullish(),
  healthcheck: z.object({
    test: z.array(z.string()).min(2),
    interval: z.string().min(1),
    timeout: z.string().min(1),
    retries: z.number().int().positive(),
    disable: z.literal(false).optional(),
  }),
  networks: z.record(z.string(), z.unknown()),
  environment: z.record(z.string(), z.string().nullable()).default({}),
  secrets: z.array(z.object({ source: z.string(), target: z.string().optional() })).default([]),
  profiles: z.array(z.string()).default([]),
  ports: z
    .array(
      z.object({
        target: z.number(),
        published: z.string(),
        host_ip: z.string(),
        protocol: z.literal('tcp'),
      }),
    )
    .default([]),
  volumes: z
    .array(
      z.object({
        type: z.string(),
        source: z.string(),
        target: z.string(),
        read_only: z.boolean().optional(),
        bind: z
          .strictObject({
            create_host_path: z.literal(false),
            propagation: z.literal('rprivate').optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  tmpfs: z.array(z.string()).min(1),
  network_mode: z.never().optional(),
  privileged: z.literal(false).optional(),
  devices: z.never().optional(),
  pid: z.never().optional(),
  ipc: z.never().optional(),
  cap_add: z.never().optional(),
  privileged_mode: z.never().optional(),
  volumes_from: z.never().optional(),
  group_add: z.never().optional(),
  device_cgroup_rules: z.never().optional(),
  sysctls: z.never().optional(),
  userns_mode: z.never().optional(),
  uts: z.never().optional(),
  gpus: z.never().optional(),
  use_api_socket: z.never().optional(),
});
const composeSchema = z.object({
  name: z.string().min(1),
  services: z.record(z.string(), serviceSchema),
  networks: z.record(
    z.string(),
    z.object({
      name: z.string().min(1),
      internal: z.boolean().optional(),
      external: z.boolean().optional(),
    }),
  ),
  secrets: z.record(z.string(), z.object({ file: z.string().min(1) })),
  volumes: z.record(z.string(), z.object({ name: z.string().min(1) })).optional(),
});
type Compose = z.infer<typeof composeSchema>;
type Service = z.infer<typeof serviceSchema>;
interface Contract {
  readonly networks: readonly string[];
  readonly secrets: readonly string[];
  readonly profile?: string;
}
const runtimeContracts: Readonly<Record<string, Contract>> = {
  postgres: {
    networks: [
      'webhook_data',
      'admin_data',
      'reply_data',
      'outbound_data',
      'notification_data',
      'operations_data',
    ],
    secrets: ['postgres-password'],
  },
  'fcd-support-api': {
    networks: ['webhook_data', 'ingress'],
    secrets: ['webhook-database', 'meta-app-secret', 'meta-verify-token', 'webhook-keyring'],
  },
  'fcd-support-admin': {
    networks: ['admin_data'],
    secrets: ['admin-database', 'admin-session', 'admin-mfa'],
  },
  'fcd-support-reply': { networks: ['reply_data'], secrets: ['reply-database', 'reply-keyring'] },
  'fcd-support-outbound': {
    networks: ['outbound_data', 'provider_egress'],
    secrets: [
      'outbound-database',
      'outbound-keyring',
      'meta-page-token',
      'meta-whatsapp-token',
      'meta-page-id',
      'meta-phone-id',
    ],
    profile: 'outbound-execution',
  },
  'fcd-support-notification': {
    networks: ['notification_data', 'notification'],
    secrets: ['notification-database', 'n8n-secret'],
    profile: 'notification-execution',
  },
};
const operationSecrets: Readonly<Record<string, readonly string[]>> = {
  bootstrap: [
    'bootstrap-database',
    ...[...runtimeDatabaseRoles, 'migrator'].map(
      (role) => `bootstrap-${role.replaceAll('_', '-')}-password`,
    ),
  ],
  migrate: ['migrate-database'],
  backup: ['backup-database', 'backup-recipient', 'recovery-hmac'],
  'verify-backup': ['verify-database', 'restore-identity', 'recovery-hmac'],
  checkpoint: ['checkpoint-database', 'backup-recipient', 'recovery-hmac'],
  health: ['health-database'],
  maintenance: ['maintenance-database', 'maintenance-keyring'],
};
function invalid(): never {
  throw new Error('compose_contract_invalid');
}
function same(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((value) => expected.includes(value))
  );
}
const secretEnvironmentName =
  /^(?:DATABASE_URL|META_(?:APP_SECRET|VERIFY_TOKEN|PAGE_ACCESS_TOKEN|WHATSAPP_ACCESS_TOKEN|MESSENGER_PAGE_ID|WHATSAPP_PHONE_NUMBER_ID|WHATSAPP_BUSINESS_ACCOUNT_ID)|MANIFEST_API_KEY|N8N_ESCALATION_WEBHOOK_SECRET|ADMIN_SESSION_HMAC_KEY|ADMIN_MFA_ENCRYPTION_KEY|PRIVACY_HMAC_KEYRING|RECOVERY_MANIFEST_HMAC|BACKUP_(?:AGE_IDENTITY|ENCRYPTION_RECIPIENT|ENCRYPTION_PASSWORD)|POSTGRES_PASSWORD|CLOUDFLARE_TUNNEL_TOKEN)$/u;
function durationMilliseconds(value: string): number {
  const factors: Readonly<Record<string, number>> = {
    h: 3600000,
    m: 60000,
    s: 1000,
    ms: 1,
    us: 0.001,
    ns: 0.000001,
  };
  return [...value.matchAll(/([0-9]+)(ms|us|ns|h|m|s)/gu)].reduce(
    (sum, match) => sum + Number(match[1]) * (factors[match[2] ?? ''] ?? NaN),
    0,
  );
}
function memoryBytes(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^([1-9][0-9]*)([kmg])?$/iu.exec(value);
  const units: Readonly<Record<string, number>> = { k: 1024, m: 1048576, g: 1073741824 };
  return Number(match?.[1]) * (units[match?.[2]?.toLowerCase() ?? ''] ?? 1);
}
function checkResourceSettings(name: string, s: Service): void {
  const roleName =
    name === 'postgres' || name === 'fcd-support-api'
      ? 'webhook'
      : name === 'bootstrap'
        ? 'migrate'
        : name.replace(/^fcd-support-/u, '').replaceAll('-', '_');
  const role = z.enum(runtimeRoles).parse(roleName);
  const environment = Object.fromEntries(
    Object.entries(s.environment).map(([key, value]) => [key, value ?? undefined]),
  );
  for (const flag of [
    'MODEL_EXECUTION_ENABLED',
    'OUTBOUND_EXECUTION_ENABLED',
    'N8N_EXECUTION_ENABLED',
  ])
    if (environment[flag] !== 'true' && environment[flag] !== 'false') invalid();
  // Validate scheduling/resource policy independently of provider credentials;
  // execution flags remain checked separately and never enable a provider here.
  const config = loadOperationsConfig(role, {
    ...environment,
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
  });
  if (durationMilliseconds(s.stop_grace_period) !== config.stopGraceMilliseconds) invalid();
  const limit = config.resourceLimits[role];
  if (limit === undefined) invalid();
  if (
    name !== 'postgres' &&
    (s.cpus !== limit.cpus ||
      memoryBytes(s.mem_limit) !== limit.memoryMiB * 1048576 ||
      s.pids_limit !== limit.pids)
  )
    invalid();
  const bounds = z
    .object({
      minimum: z.record(z.string(), z.number()),
      maximum: z.record(z.string(), z.number()),
    })
    .parse(JSON.parse(environment.OPS_RESOURCE_BOUNDS_JSON ?? ''));
  if (name === 'postgres') {
    for (const [field, value] of Object.entries({
      cpus: s.cpus,
      memoryMiB: memoryBytes(s.mem_limit) / 1048576,
      pids: s.pids_limit,
    })) {
      if (
        value < (bounds.minimum[field] ?? Infinity) ||
        value > (bounds.maximum[field] ?? -Infinity)
      )
        invalid();
    }
    if (
      s.cpus > Number(environment.OPS_HOST_CPUS) ||
      memoryBytes(s.mem_limit) > Number(environment.OPS_HOST_MEMORY_MIB) * 1048576
    )
      invalid();
  }
  const expected = name === 'postgres' ? ['/var/run/postgresql', '/tmp'] : ['/run/fcd-support'];
  if (
    !same(
      s.tmpfs.map((entry) => entry.split(':')[0] ?? ''),
      expected,
    )
  )
    invalid();
  for (const mount of s.tmpfs) {
    const [path, optionsText] = mount.split(':');
    const options = (optionsText ?? '').split(',');
    for (const flag of ['rw', 'noexec', 'nosuid', 'nodev']) if (!options.includes(flag)) invalid();
    if (path !== '/tmp')
      for (const option of name === 'postgres'
        ? ['uid=999', 'gid=999', 'mode=0770']
        : ['uid=1000', 'gid=1000', 'mode=0700'])
        if (!options.includes(option)) invalid();
    const size = options.find((value) => value.startsWith('size='))?.slice(5);
    if (
      size === undefined ||
      !Number.isFinite(memoryBytes(size)) ||
      memoryBytes(size) <= 0 ||
      (name !== 'postgres' && memoryBytes(size) !== limit.tmpfsMiB * 1048576) ||
      memoryBytes(size) >= memoryBytes(s.mem_limit)
    )
      invalid();
  }
}
function checkCommon(config: Compose, revision: string): void {
  if (!/^[a-f0-9]{40}$/u.test(revision)) invalid();
  for (const [name, s] of Object.entries(config.services)) {
    if (
      !s.image.endsWith(`:${revision}`) ||
      s.labels['org.opencontainers.image.revision'] !== revision
    )
      invalid();
    checkResourceSettings(name, s);
    if (s.user !== (name === 'postgres' ? 'postgres' : 'node')) invalid();
    if (!same(s.cap_drop, ['ALL']) || !same(s.security_opt, ['no-new-privileges:true'])) invalid();
    if (
      !/^(?:[0-9]+(?:h|m|s|ms|us|ns))+$/u.test(s.stop_grace_period) ||
      !/[1-9]/u.test(s.stop_grace_period)
    )
      invalid();
    for (const [key, value] of Object.entries(s.environment)) {
      if (secretEnvironmentName.test(key) && value !== null && value !== '') invalid();
      if (
        key.endsWith('_FILE') &&
        (value === null || !s.secrets.some((secret) => value === `/run/secrets/${secret.source}`))
      )
        invalid();
    }
    for (const secret of s.secrets) {
      if (
        config.secrets[secret.source] === undefined ||
        (secret.target !== undefined &&
          secret.target !== secret.source &&
          secret.target !== `/run/secrets/${secret.source}`)
      )
        invalid();
    }
    if (
      s.volumes.some(
        (v) =>
          !(
            name === 'fcd-support-admin' &&
            v.type === 'bind' &&
            v.target === '/run/fcd-support-admin'
          ) &&
          (v.type !== 'volume' ||
            (v.target !== '/var/lib/postgresql' && v.target !== '/var/lib/fcd-support/backups')),
      )
    )
      invalid();
    if (
      name !== 'postgres' &&
      !s.tmpfs.some(
        (v) =>
          v.startsWith('/run/fcd-support:') &&
          v.includes('uid=1000') &&
          v.includes('gid=1000') &&
          /mode=0?700/u.test(v),
      )
    )
      invalid();
  }
}
function checkService(s: Service | undefined, contract: Contract, restart: string): void {
  if (
    s === undefined ||
    !same(Object.keys(s.networks), contract.networks) ||
    !same(
      s.secrets.map((secret) => secret.source),
      contract.secrets,
    ) ||
    s.restart !== restart
  )
    invalid();
  if (!same(s.profiles, contract.profile === undefined ? [] : [contract.profile])) invalid();
}
export interface RuntimeComposePaths {
  readonly adminSocketRoot: string;
  readonly configRoot: string;
  readonly secretRoot: string;
  readonly workspaceRoot: string;
}

function canonicalPath(value: string): string {
  const windows = /^[a-z]:[\\/]/iu.test(value);
  const api = windows ? win32 : posix;
  if (!api.isAbsolute(value) || Buffer.from(value).some((byte) => byte < 32 || byte === 127))
    invalid();
  const normalized = api.normalize(value).replaceAll('\\', '/').replace(/\/$/u, '');
  return windows ? normalized.toLowerCase() : normalized;
}

function validateSocketRoot(paths: RuntimeComposePaths): string {
  const source = canonicalPath(paths.adminSocketRoot);
  if (
    [
      '',
      '/run',
      '/tmp',
      '/var',
      '/var/lib',
      '/etc',
      '/home',
      '/usr',
      '/opt',
      '/dev',
      '/proc',
      '/sys',
    ].includes(source) ||
    /^[a-z]:$/iu.test(source) ||
    source === '/var/lib/docker' ||
    source.startsWith('/var/lib/docker/')
  )
    invalid();
  for (const protectedRoot of [paths.configRoot, paths.secretRoot, paths.workspaceRoot]) {
    const protectedPath = canonicalPath(protectedRoot);
    if (
      source === protectedPath ||
      source.startsWith(`${protectedPath}/`) ||
      protectedPath.startsWith(`${source}/`)
    )
      invalid();
  }
  return source;
}

export function assertRuntimeCompose(
  input: unknown,
  revision: string,
  modelEnabled: boolean,
  paths: RuntimeComposePaths,
): void {
  try {
    const config = composeSchema.parse(input);
    const socketRoot = validateSocketRoot(paths);
    checkCommon(config, revision);
    if (!same(Object.keys(config.services), Object.keys(runtimeContracts))) invalid();
    for (const [name, base] of Object.entries(runtimeContracts)) {
      const contract =
        name === 'fcd-support-reply' && modelEnabled
          ? {
              networks: [...base.networks, 'model'],
              secrets: [...base.secrets, 'manifest-key'],
              profile: 'model-execution',
            }
          : base;
      checkService(config.services[name], contract, 'unless-stopped');
      const volumes = config.services[name]?.volumes;
      if (name === 'postgres') {
        if (
          volumes?.length !== 1 ||
          volumes[0]?.source !== 'postgres-data' ||
          volumes[0].target !== '/var/lib/postgresql'
        )
          invalid();
      } else if (name !== 'fcd-support-admin' && volumes?.length !== 0) invalid();
      if (config.services[name]?.ports.length !== 0) invalid();
    }
    const admin = config.services['fcd-support-admin'];
    if (admin?.volumes.length !== 1) invalid();
    const mount = admin.volumes[0];
    if (
      mount?.type !== 'bind' ||
      canonicalPath(mount.source) !== socketRoot ||
      mount.target !== '/run/fcd-support-admin' ||
      mount.read_only === true ||
      mount.bind?.create_host_path !== false
    )
      invalid();
    const origin = new URL(admin.environment.ADMIN_ORIGIN ?? '');
    if (
      admin.environment.ADMIN_HOST !== undefined ||
      admin.environment.ADMIN_PORT !== undefined ||
      admin.environment.ADMIN_LISTEN_MODE !== 'unix' ||
      admin.environment.ADMIN_SOCKET_PATH !== '/run/fcd-support-admin/admin.sock' ||
      !/^[1-9][0-9]{0,4}$/u.test(admin.environment.ADMIN_BROWSER_PORT ?? '') ||
      Number(admin.environment.ADMIN_BROWSER_PORT) > 65535 ||
      origin.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      Number(origin.port || 80) !== Number(admin.environment.ADMIN_BROWSER_PORT)
    )
      invalid();
    const reply = config.services['fcd-support-reply'];
    if (reply?.environment.MODEL_EXECUTION_ENABLED !== (modelEnabled ? 'true' : 'false')) invalid();
    const expectedNetworks = [
      ...new Set(Object.values(runtimeContracts).flatMap((c) => c.networks)),
      ...(modelEnabled ? ['model'] : []),
    ];
    if (!same(Object.keys(config.networks), expectedNetworks)) invalid();
    for (const [name, network] of Object.entries(config.networks)) {
      if (name.endsWith('_data') && (network.internal !== true || network.external === true))
        invalid();
      if (['ingress', 'notification', 'model'].includes(name) && network.external !== true)
        invalid();
      if (name === 'provider_egress' && (network.internal === true || network.external === true))
        invalid();
    }
  } catch {
    invalid();
  }
}
export function assertOperationsCompose(input: unknown, revision: string): void {
  try {
    const config = composeSchema.parse(input);
    checkCommon(config, revision);
    if (!same(Object.keys(config.services), Object.keys(operationSecrets))) invalid();
    for (const [name, secrets] of Object.entries(operationSecrets)) {
      const s = config.services[name];
      checkService(
        s,
        { networks: ['operations_data'], secrets, profile: `operations-${name}` },
        'no',
      );
      if (s?.ports.length !== 0) invalid();
      if (name === 'bootstrap') {
        if (
          !same(s.command ?? [], ['node', 'dist/operations/bootstrap-main.js']) ||
          s.command?.[0] !== 'node' ||
          !same(s.entrypoint ?? [], ['/usr/local/bin/container-entrypoint.sh', 'application']) ||
          s.entrypoint?.[0] !== '/usr/local/bin/container-entrypoint.sh' ||
          s.environment.NODE_ENV !== 'production' ||
          s.environment.DATABASE_URL_FILE !== '/run/secrets/bootstrap-database' ||
          !/^fcd_support(?:_[a-z0-9_]+)?$/u.test(s.environment.OPS_DATABASE_NAME ?? '') ||
          !/^[a-z][a-z0-9_]{0,62}$/u.test(s.environment.OPS_DATABASE_SCHEMA ?? '') ||
          !/^fcd_[a-z0-9_]{1,28}$/u.test(s.environment.OPS_DATABASE_ROLE_PREFIX ?? '') ||
          ['MODEL_EXECUTION_ENABLED', 'OUTBOUND_EXECUTION_ENABLED', 'N8N_EXECUTION_ENABLED'].some(
            (flag) => s.environment[flag] !== 'false',
          )
        )
          invalid();
      }
      const archive = ['backup', 'verify-backup', 'checkpoint'].includes(name);
      if (s.volumes.length !== (archive ? 1 : 0)) invalid();
      if (
        archive &&
        (s.volumes[0]?.target !== '/var/lib/fcd-support/backups' ||
          s.volumes[0].source !== 'backups')
      )
        invalid();
      if (name === 'verify-backup' && s.volumes[0]?.read_only !== true) invalid();
    }
    if (
      !same(Object.keys(config.networks), ['operations_data']) ||
      config.networks.operations_data?.external !== true
    )
      invalid();
  } catch {
    invalid();
  }
}
export function assertRestoreCompose(
  input: unknown,
  revision: string,
  runtimeVolume: string,
): void {
  try {
    const config = composeSchema.parse(input);
    checkCommon(config, revision);
    if (
      !same(Object.keys(config.services), ['postgres', 'restore']) ||
      !same(Object.keys(config.networks), ['restore_data']) ||
      config.networks.restore_data?.internal !== true ||
      config.networks.restore_data.external === true
    )
      invalid();
    const volume = config.volumes?.['restore-data']?.name;
    if (
      volume === undefined ||
      volume === runtimeVolume ||
      !/^fcd-support-restore-[a-z0-9-]+$/u.test(volume)
    )
      invalid();
    checkService(
      config.services.postgres,
      { networks: ['restore_data'], secrets: ['restore-postgres-password'] },
      'no',
    );
    checkService(
      config.services.restore,
      {
        networks: ['restore_data'],
        secrets: ['restore-database', 'restore-identity', 'recovery-hmac', 'restore-keyring'],
        profile: 'isolated-restore',
      },
      'no',
    );
    for (const s of Object.values(config.services)) if (s.ports.length !== 0) invalid();
    if (
      config.services.restore?.volumes.length !== 1 ||
      config.services.restore.volumes[0]?.read_only !== true ||
      config.services.restore.volumes[0].source !== 'backups' ||
      config.services.restore.volumes[0].target !== '/var/lib/fcd-support/backups'
    )
      invalid();
    if (
      config.services.postgres?.volumes.length !== 1 ||
      config.services.postgres.volumes[0]?.source !== 'restore-data' ||
      config.services.postgres.volumes[0].target !== '/var/lib/postgresql'
    )
      invalid();
  } catch {
    invalid();
  }
}
export function assertExternalNetworkParticipants(
  input: unknown,
  expectedNames: readonly string[],
): void {
  try {
    const network = z
      .object({
        Driver: z.literal('bridge'),
        Scope: z.literal('local'),
        Internal: z.literal(true),
        Containers: z.record(z.string(), z.object({ Name: z.string() })),
      })
      .parse(input);
    if (
      !same(
        Object.values(network.Containers).map((c) => c.Name),
        expectedNames,
      )
    )
      throw new Error('invalid');
  } catch {
    throw new Error('network_contract_invalid');
  }
}
