import { z } from 'zod';
import { dockerVolumeTimestampSchema } from '../docker-volume-timestamp.js';
import { readPrivateRuntimeCompose, type RuntimeComposePaths } from './compose-contract.js';

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const name = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/u);
const path = z
  .string()
  .max(4096)
  .regex(/^\/[A-Za-z0-9._/-]+$/u)
  .refine(
    (value) =>
      value !== '/' &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      !value.split('/').some((part) => part === '.' || part === '..'),
  );
const strings = z.array(z.string().max(256)).max(256);
const activeRoles = [
  'postgres',
  'fcd-support-api',
  'fcd-support-admin',
  'fcd-support-reply',
] as const;
const image = z.strictObject({
  id: imageId,
  revision,
  os: z.literal('linux'),
  architecture: z.literal('amd64'),
  user: z.string().max(64),
});
const mount = z.strictObject({
  type: z.enum(['volume', 'bind', 'tmpfs']),
  name: z.string().max(256),
  source: z.union([path, z.literal('')]),
  destination: path,
  readWrite: z.boolean(),
  propagation: z.enum(['', 'rprivate']),
});
const container = z.strictObject({
  id,
  project: name,
  service: z.enum(activeRoles),
  revision,
  imageId,
  running: z.literal(true),
  paused: z.literal(false),
  restarting: z.literal(false),
  dead: z.literal(false),
  healthy: z.literal(true),
  startedAt: z.iso.datetime(),
  restartCount: z.number().int().nonnegative(),
  readOnlyRootfs: z.literal(true),
  privileged: z.literal(false),
  init: z.literal(true),
  user: z.string().max(64),
  networkMode: name,
  networks: z.array(z.strictObject({ name, id })).min(1).max(6),
  hostPortBindings: z.literal(0),
  publishedPortBindings: z.literal(0),
  publishAllPorts: z.literal(false),
  pidMode: z.literal(''),
  ipcMode: z.literal('private'),
  utsMode: z.literal(''),
  capAdd: strings.nullable(),
  capDrop: strings,
  securityOpt: strings,
  devices: z.literal(0),
  deviceRequests: z.literal(0),
  groupAdd: strings.nullable(),
  volumesFrom: strings.nullable(),
  extraHosts: strings.nullable(),
  sysctls: z.record(z.string(), z.string()).nullable(),
  nanoCpus: z.number().int().positive(),
  memory: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  stopTimeout: z.number().int().positive(),
  restartPolicy: z.literal('unless-stopped'),
  tmpfs: z.record(path, z.string().max(2048)),
  command: strings,
  entrypoint: strings,
  environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(256),
  executionFlags: strings,
  mounts: z.array(mount).min(1).max(16),
});
const snapshot = z.strictObject({
  images: z.strictObject({ postgres: image, runtime: image }),
  containers: z.array(container).min(1).max(4),
  networks: z
    .array(
      z.strictObject({
        id,
        name,
        driver: z.literal('bridge'),
        scope: z.literal('local'),
        internal: z.literal(true),
        project: z.union([name, z.literal('')]),
        logicalName: z.union([name, z.literal('')]),
        members: z.array(id).min(1).max(4),
      }),
    )
    .min(6)
    .max(7),
  volume: z.strictObject({
    name,
    driver: z.literal('local'),
    scope: z.literal('local'),
    options: z
      .record(z.string(), z.unknown())
      .nullable()
      .refine((v) => v === null || Object.keys(v).length === 0),
    project: z.union([name, z.literal('')]).nullable(),
    logicalName: z.enum(['postgres-data', 'restore-data', '']).nullable(),
    createdAt: dockerVolumeTimestampSchema,
    mountpoint: path,
    users: z.array(id).length(1),
  }),
  socket: z
    .strictObject({
      device: z.string().regex(/^[0-9]{1,20}$/u),
      inode: z.string().regex(/^[1-9][0-9]{0,19}$/u),
      uid: z.literal(1000),
      gid: z.literal(1000),
      mode: z.literal(0o600),
      rootDevice: z.string().regex(/^[0-9]{1,20}$/u),
      rootInode: z.string().regex(/^[1-9][0-9]{0,19}$/u),
      rootUid: z.literal(1000),
      rootGid: z.literal(1000),
      rootMode: z.literal(0o700),
    })
    .nullable(),
  hostBinds: z
    .array(z.strictObject({ containerId: id, source: path, canonicalSource: path }))
    .max(512),
});
export interface RuntimeHostOptions {
  readonly revision: string;
  readonly paths: RuntimeComposePaths;
  readonly ingressPeerId: string;
  readonly volumeIdentity?: RuntimeVolumeIdentity;
}
export interface RuntimeVolumeIdentity {
  readonly name: string;
  readonly project: string | null;
  readonly logicalName: string | null;
  readonly createdAt: string;
}
export const runtimeVolumeIdentitySchema = z.strictObject({
  name,
  project: name.nullable(),
  logicalName: z.enum(['postgres-data', 'restore-data']).nullable(),
  createdAt: dockerVolumeTimestampSchema,
});
const commands = {
  postgres: ['postgres'],
  'fcd-support-api': ['node', 'dist/main.js'],
  'fcd-support-admin': ['node', 'dist/admin-main.js'],
  'fcd-support-reply': ['node', 'dist/worker-main.js', 'reply'],
} as const;
const flags = ['MODEL_EXECUTION_ENABLED', 'OUTBOUND_EXECUTION_ENABLED', 'N8N_EXECUTION_ENABLED'];
const credentialName =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|SESSION_KEY|HMAC_KEY)(?:_|$)/u;
type DiagnosticStage =
  | 'revision'
  | 'ingress'
  | 'compose'
  | 'paths'
  | 'samples'
  | 'volume_identity'
  | 'topology'
  | 'images'
  | 'volume'
  | 'network_set'
  | 'network_labels'
  | 'network_members'
  | 'container_policy'
  | 'container_networks'
  | 'tmpfs'
  | 'mounts'
  | 'binds'
  | 'protected_binds'
  | 'socket_users'
  | 'stability';
// Never copy an unknown property name, Zod message, issue input or actual value.
const diagnosticFields = new Set([
  ...Object.keys(container.shape),
  ...Object.keys(mount.shape),
  ...Object.keys(snapshot.shape),
  ...Object.keys(snapshot.shape.volume.shape),
  ...Object.keys(image.shape),
  'before',
  'after',
  'probes',
  'postgresSql',
  'apiHttp',
  'adminSocket',
  'adminNoTcp',
  'replyHeartbeat',
  'driver',
  'scope',
  'internal',
  'logicalName',
  'members',
  'containerId',
  'canonicalSource',
  'device',
  'inode',
  'uid',
  'gid',
  'mode',
  'rootDevice',
  'rootInode',
  'rootUid',
  'rootGid',
  'rootMode',
]);
export class RuntimeHostValidationError extends Error {
  readonly diagnosticCode: string;
  constructor(stage: DiagnosticStage, error: unknown) {
    super('runtime_host_invalid');
    const field =
      error instanceof z.ZodError
        ? error.issues[0]?.path.findLast(
            (part): part is string => typeof part === 'string' && diagnosticFields.has(part),
          )
        : undefined;
    this.diagnosticCode = stage + (field === undefined ? '' : `.${field}`);
  }
}
function invalid(): never {
  throw new Error('runtime_host_invalid');
}
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
}
function bytes(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = /^([1-9][0-9]*)([kmg])?$/iu.exec(value);
  if (parsed === null) invalid();
  const unit: Readonly<Record<string, number>> = { k: 1024, m: 1048576, g: 1073741824 };
  return Number(parsed[1]) * (unit[parsed[2]?.toLowerCase() ?? ''] ?? 1);
}
function tmpfsOptions(value: string): string {
  const options = value.split(',');
  if (new Set(options.map((v) => v.split('=')[0])).size !== options.length) invalid();
  return options
    .map((v) =>
      v.startsWith('size=')
        ? `size=${String(bytes(v.slice(5)))}`
        : v.startsWith('mode=')
          ? `mode=${String(Number.parseInt(v.slice(5), 8))}`
          : v,
    )
    .sort()
    .join(',');
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).sort().join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** A current sample, never an attachment token. The trusted collector must
 * retain its deployment lock and obtain real readiness/stat/Docker facts. */
function inspectHostSamples(
  input: unknown,
  renderedCompose: unknown,
  options: Omit<RuntimeHostOptions, 'ingressPeerId'> & { readonly ingressPeerId?: string },
  bootstrap: boolean,
): { readonly status: 'verified' } {
  let stage: DiagnosticStage = 'revision';
  try {
    revision.parse(options.revision);
    stage = 'ingress';
    const ingressPeerId = bootstrap ? undefined : id.parse(options.ingressPeerId);
    const roles: readonly (typeof activeRoles)[number][] = bootstrap ? ['postgres'] : activeRoles;
    stage = 'compose';
    const config = readPrivateRuntimeCompose(renderedCompose, options.revision, options.paths);
    stage = 'paths';
    for (const p of Object.values(options.paths)) path.parse(p);
    const runtimeSamples = z.strictObject({
      before: snapshot,
      after: snapshot,
      probes: z.strictObject({
        postgresSql: z.literal(true),
        apiHttp: z.literal(true),
        adminSocket: z.literal(true),
        adminNoTcp: z.literal(true),
        replyHeartbeat: z.literal(true),
      }),
    });
    stage = 'samples';
    const samples = (
      bootstrap ? z.strictObject({ before: snapshot, after: snapshot }) : runtimeSamples
    ).parse(input);
    stage = 'volume_identity';
    const expectedVolume = config.volumes?.['postgres-data']?.name;
    if (expectedVolume === undefined) invalid();
    const selected =
      options.volumeIdentity === undefined
        ? undefined
        : runtimeVolumeIdentitySchema.parse(options.volumeIdentity);
    const expectedProject = selected === undefined ? config.name : selected.project;
    const expectedLogical = selected === undefined ? 'postgres-data' : selected.logicalName;
    if (selected !== undefined) {
      if (selected.name !== expectedVolume) invalid();
      if (selected.logicalName === 'postgres-data') {
        if (selected.project !== config.name) invalid();
      } else if (selected.logicalName === 'restore-data') {
        if (
          selected.project === null ||
          !/^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$/u.test(selected.project)
        )
          invalid();
      } else if (selected.project !== null) invalid();
    }
    for (const actual of [samples.before, samples.after]) {
      stage = 'topology';
      if (
        (bootstrap ? actual.socket !== null : actual.socket === null) ||
        !same(
          actual.containers.map((c) => c.service),
          roles,
        ) ||
        new Set(actual.containers.map((c) => c.id)).size !== roles.length
      )
        invalid();
      stage = 'images';
      for (const [role, img] of Object.entries(actual.images)) {
        if (
          img.revision !== options.revision ||
          !(
            role === 'postgres' ? ['postgres', '999', '999:999'] : ['node', '1000', '1000:1000']
          ).includes(img.user)
        )
          invalid();
      }
      const postgres = actual.containers.find((c) => c.service === 'postgres');
      const admin = actual.containers.find((c) => c.service === 'fcd-support-admin');
      stage = 'volume';
      if (
        postgres === undefined ||
        (!bootstrap && admin === undefined) ||
        actual.volume.name !== expectedVolume ||
        (actual.volume.project === '' ? null : actual.volume.project) !== expectedProject ||
        (actual.volume.logicalName === '' ? null : actual.volume.logicalName) !== expectedLogical ||
        (selected !== undefined && actual.volume.createdAt !== selected.createdAt) ||
        actual.volume.users[0] !== postgres.id
      )
        invalid();
      const networkKeys = [
        ...new Set(roles.flatMap((role) => Object.keys(config.services[role]?.networks ?? {}))),
      ];
      stage = 'network_set';
      if (
        !same(
          actual.networks.map((n) => n.name),
          networkKeys.map((key) => config.networks[key]?.name ?? ''),
        ) ||
        new Set(actual.networks.map((n) => n.id)).size !== networkKeys.length
      )
        invalid();
      for (const key of networkKeys) {
        stage = 'network_labels';
        const net = actual.networks.find((n) => n.name === config.networks[key]?.name);
        if (
          net === undefined ||
          (key !== 'ingress' && (net.project !== config.name || net.logicalName !== key))
        )
          invalid();
        const members = actual.containers
          .filter((c) => Object.keys(config.services[c.service]?.networks ?? {}).includes(key))
          .map((c) => c.id);
        if (key === 'ingress') {
          if (ingressPeerId === undefined) invalid();
          members.push(ingressPeerId);
        }
        stage = 'network_members';
        if (!same(net.members, members)) invalid();
      }
      for (const c of actual.containers) {
        stage = 'container_policy';
        const expected = config.services[c.service];
        if (
          expected === undefined ||
          c.project !== config.name ||
          c.revision !== options.revision ||
          (expected.image.startsWith('sha256:') && c.imageId !== expected.image) ||
          c.imageId !==
            (c.service === 'postgres' ? actual.images.postgres.id : actual.images.runtime.id) ||
          !(
            c.service === 'postgres'
              ? ['postgres', '999', '999:999']
              : ['node', '1000', '1000:1000']
          ).includes(c.user) ||
          !same(c.capDrop, ['ALL']) ||
          (c.capAdd?.length ?? 0) !== 0 ||
          c.securityOpt.length !== 1 ||
          !['no-new-privileges', 'no-new-privileges:true'].includes(c.securityOpt[0] ?? '') ||
          (c.groupAdd?.length ?? 0) !== 0 ||
          (c.volumesFrom?.length ?? 0) !== 0 ||
          (c.extraHosts?.length ?? 0) !== 0 ||
          Object.keys(c.sysctls ?? {}).length !== 0 ||
          c.nanoCpus !== Math.round(expected.cpus * 1e9) ||
          c.memory !== bytes(expected.mem_limit) ||
          c.pidsLimit !== expected.pids_limit ||
          c.stopTimeout !== Math.ceil(Number(expected.environment.OPS_STOP_GRACE_MS) / 1000) ||
          JSON.stringify(c.command) !== JSON.stringify(commands[c.service]) ||
          JSON.stringify(c.entrypoint) !==
            JSON.stringify(
              c.service === 'postgres'
                ? ['/usr/local/bin/fcd-postgres-entrypoint.sh']
                : ['/usr/local/bin/container-entrypoint.sh', 'application'],
            ) ||
          !same(
            c.executionFlags,
            flags.map((f) => `${f}=false`),
          ) ||
          new Set(c.environmentNames).size !== c.environmentNames.length ||
          c.environmentNames.some((key) => !key.endsWith('_FILE') && credentialName.test(key))
        )
          invalid();
        const expectedNetworks = Object.keys(expected.networks).map(
          (key) => config.networks[key]?.name ?? '',
        );
        stage = 'container_networks';
        if (
          !same(
            c.networks.map((n) => n.name),
            expectedNetworks,
          ) ||
          !expectedNetworks.includes(c.networkMode) ||
          c.networks.some((net) => actual.networks.find((n) => n.name === net.name)?.id !== net.id)
        )
          invalid();
        stage = 'tmpfs';
        const expectedTmpfs = Object.fromEntries(
          expected.tmpfs.map((entry) => {
            const [p, v] = entry.split(':');
            return [p ?? '', tmpfsOptions(v ?? '')];
          }),
        );
        if (
          !same(Object.keys(c.tmpfs), Object.keys(expectedTmpfs)) ||
          Object.entries(c.tmpfs).some(([p, v]) => tmpfsOptions(v) !== expectedTmpfs[p])
        )
          invalid();
        stage = 'mounts';
        const expectedMounts: z.infer<typeof mount>[] = expected.secrets.map((secret) => {
          const source = config.secrets[secret.source]?.file;
          const directory =
            c.service === 'postgres'
              ? 'postgres'
              : c.service === 'fcd-support-api'
                ? 'webhook'
                : c.service.slice('fcd-support-'.length);
          if (source !== `${options.paths.secretRoot}/${directory}/${secret.source}`) invalid();
          return {
            type: 'bind',
            name: '',
            source,
            destination: `/run/secrets/${secret.source}`,
            readWrite: false,
            propagation: 'rprivate',
          };
        });
        if (c.service === 'postgres')
          expectedMounts.push({
            type: 'volume',
            name: expectedVolume,
            source: actual.volume.mountpoint,
            destination: '/var/lib/postgresql',
            readWrite: true,
            propagation: '',
          });
        if (c.service === 'fcd-support-admin')
          expectedMounts.push({
            type: 'bind',
            name: '',
            source: options.paths.adminSocketRoot,
            destination: '/run/fcd-support-admin',
            readWrite: true,
            propagation: 'rprivate',
          });
        const material = c.mounts.filter((m) => m.type !== 'tmpfs');
        if (
          stable(material) !== stable(expectedMounts) ||
          c.mounts.some(
            (m) =>
              m.type === 'tmpfs' &&
              (!(m.destination in c.tmpfs) || !m.readWrite || m.source !== '' || m.name !== ''),
          )
        )
          invalid();
        stage = 'binds';
        for (const m of c.mounts.filter((m) => m.type === 'bind')) {
          const binds = actual.hostBinds.filter(
            (b) => b.containerId === c.id && b.source === m.source,
          );
          if (binds.length !== 1 || binds[0]?.canonicalSource !== m.source) invalid();
        }
      }
      stage = 'protected_binds';
      let socketUsers = 0;
      for (const bind of actual.hostBinds) {
        if (overlaps(bind.canonicalSource, actual.volume.mountpoint)) invalid();
        if (overlaps(bind.canonicalSource, options.paths.adminSocketRoot)) {
          if (
            bootstrap ||
            bind.containerId !== admin?.id ||
            bind.source !== options.paths.adminSocketRoot ||
            bind.canonicalSource !== options.paths.adminSocketRoot
          )
            invalid();
          socketUsers++;
        }
      }
      stage = 'socket_users';
      if (!bootstrap && socketUsers !== 1) invalid();
    }
    stage = 'stability';
    if (stable(samples.before) !== stable(samples.after)) invalid();
    return Object.freeze({ status: 'verified' });
  } catch (error) {
    throw new RuntimeHostValidationError(stage, error);
  }
}

export function inspectRuntimeHostSamples(
  input: unknown,
  renderedCompose: unknown,
  options: RuntimeHostOptions,
): { readonly status: 'verified' } {
  return inspectHostSamples(input, renderedCompose, options, false);
}

/** Before owner preparation, application containers must be stopped/removed,
 * all data networks must contain only PostgreSQL, and no admin socket may exist. */
export function inspectBootstrapDatabaseSamples(
  input: unknown,
  renderedCompose: unknown,
  options: Omit<RuntimeHostOptions, 'ingressPeerId'>,
): { readonly status: 'verified' } {
  return inspectHostSamples(input, renderedCompose, options, true);
}
