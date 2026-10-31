import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPromotionMounts } from './promotion-mounts.js';
import { dockerVolumeTimestampSchema } from '../docker-volume-timestamp.js';
import {
  inspectRestoreHostSamples,
  restoreHostIdentitySchema,
  type RestoreHostIdentity,
} from './restore-host.js';

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const name = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/u);
const path = z
  .string()
  .max(4096)
  .regex(/^\/[A-Za-z0-9._/-]+$/u)
  .refine(
    (v) =>
      v !== '/' &&
      !v.endsWith('/') &&
      !v.includes('//') &&
      !v.split('/').some((p) => p === '.' || p === '..'),
  );
const strings = z.array(z.string().max(6000)).max(256);
const systemIdentifier = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/u)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const mount = z.strictObject({
  type: z.enum(['volume', 'bind', 'tmpfs']),
  name: z.string().max(256),
  source: z.union([path, z.literal('')]),
  destination: path,
  readWrite: z.boolean(),
  propagation: z.enum(['', 'rprivate']),
});
const image = z.strictObject({
  id: imageId,
  revision,
  os: z.literal('linux'),
  architecture: z.literal('amd64'),
  user: z.string().max(64),
});
const network = z.strictObject({
  id,
  name,
  driver: z.literal('bridge'),
  scope: z.literal('local'),
  internal: z.literal(true),
  project: name,
  logicalName: name,
  members: z.array(id).min(1).max(3),
});
const volume = z.strictObject({
  name,
  driver: z.literal('local'),
  scope: z.literal('local'),
  options: z
    .record(z.string(), z.unknown())
    .nullable()
    .refine((v) => Object.keys(v ?? {}).length === 0),
  project: name.nullable(),
  logicalName: z.enum(['postgres-data', 'restore-data']).nullable(),
  createdAt: dockerVolumeTimestampSchema,
  mountpoint: path,
  users: z.array(id).length(1),
});
const archiveVolume = volume.pick({
  name: true,
  driver: true,
  scope: true,
  options: true,
  mountpoint: true,
});
const container = z.strictObject({
  id,
  project: name,
  service: z.enum(['postgres', 'promote']),
  revision,
  imageId,
  running: z.literal(true),
  paused: z.literal(false),
  restarting: z.literal(false),
  dead: z.literal(false),
  healthy: z.boolean(),
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
  restartPolicy: z.enum(['no', 'unless-stopped']),
  tmpfs: z.record(path, z.string().max(2048)),
  command: strings,
  entrypoint: strings,
  environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(256),
  executionFlags: strings,
  mounts: z.array(mount).min(1).max(16),
});
const reference = z.string().regex(/^operation_[a-f0-9]{32}$/u);
const selectionReference = z.string().regex(/^selection_[a-f0-9]{32}$/u);
const limits = z.strictObject({
  cpus: z.number().positive().max(999.999),
  memoryMiB: z.number().int().positive().max(16777216),
  pids: z.number().int().positive().max(16777216),
  tmpfsMiB: z.number().int().positive().max(16777216),
});
export const promotionHostOptionsSchema = z.strictObject({
  expectedHost: restoreHostIdentitySchema,
  runtimeProject: name,
  sourceContainerId: id,
  sourceVolumeName: name,
  sourceSystemIdentifier: systemIdentifier,
  sourceSelectionReference: selectionReference,
  sourceRevision: revision,
  sourcePostgresImageId: imageId,
  targetSystemIdentifier: systemIdentifier,
  gitRevision: revision,
  secretRoot: path,
  backupVolumeName: name,
  databaseName: z.string().regex(/^fcd_support(?:_[a-z0-9_]+)?$/u),
  databaseSchema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
  rolePrefix: z.string().regex(/^fcd_[a-z0-9_]{1,28}$/u),
  schemaRevision: z.string().regex(/^[0-9]{6}$/u),
  job: z.strictObject({ id, reference, project: name, imageId, command: strings, commandHash: id }),
  sourceVolumeIdentity: z.strictObject({
    project: name.nullable(),
    logicalName: z.enum(['postgres-data', 'restore-data']).nullable(),
    createdAt: dockerVolumeTimestampSchema,
  }),
  limits: z.strictObject({
    postgres: limits,
    job: limits,
    stopTimeoutSeconds: z.number().int().positive().max(900),
  }),
});
const snapshot = z.strictObject({
  source: z.strictObject({
    postgres: container,
    terminal: container,
    image,
    networks: z.array(network).length(6),
    volume,
    projectActors: z.array(id).length(1),
    systemIdentifier,
    selectionReference,
  }),
  target: z.strictObject({
    postgres: container,
    terminal: container,
    image,
    network,
    volume,
    projectActors: z.array(id).length(1),
    systemIdentifier,
  }),
  job: container,
  jobEnvironment: z.record(z.string(), z.string().max(4096)),
  jobLabels: z.strictObject({
    reference,
    parent: name,
    service: z.literal('promote'),
    commandHash: id,
  }),
  jobProjectActors: z.array(id).length(1),
  runtimeImage: image,
  archiveVolume,
  hostBinds: z
    .array(z.strictObject({ containerId: id, source: path, canonicalSource: path }))
    .max(512),
});
type Options = z.infer<typeof promotionHostOptionsSchema>;
type Container = z.infer<typeof container>;
const flags = ['MODEL_EXECUTION_ENABLED', 'OUTBOUND_EXECUTION_ENABLED', 'N8N_EXECUTION_ENABLED'];
const files = {
  RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE: ['restore', 'restore-checkpoint-database'],
  RESTORE_TARGET_OWNER_DATABASE_URL_FILE: ['restore', 'restore-database'],
  PRIVACY_HMAC_KEYRING_FILE: ['restore', 'restore-keyring'],
  BACKUP_AGE_IDENTITY_FILE: ['verify-backup', 'restore-identity'],
  RECOVERY_MANIFEST_HMAC_FILE: ['backup', 'recovery-hmac'],
} as const;
const benignEnvironment = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'NODE_VERSION',
  'YARN_VERSION',
  'NODE_ENV',
  'TMPDIR',
  'LANG',
  'GOSU_VERSION',
  'PG_MAJOR',
  'PG_VERSION',
  'PG_SHA256',
  'DOCKER_PG_LLVM_DEPS',
  'OPS_POLL_MS',
  'OPS_BATCH_SIZE',
  'OPS_LEASE_MS',
  'OPS_MAX_CALL_MS',
  'OPS_SHUTDOWN_GRACE_MS',
  'OPS_STOP_GRACE_MS',
  'OPS_HEALTH_STALE_MS',
  'OPS_HOST_CPUS',
  'OPS_HOST_MEMORY_MIB',
  'OPS_RESOURCE_LIMITS_JSON',
  'OPS_RESOURCE_BOUNDS_JSON',
  'OPS_LEARNING_POLICY_JSON',
  'OPS_LEARNING_WINDOW_MS',
  'BACKUP_ARCHIVE_DIRECTORY',
  'BACKUP_TMPFS_DIRECTORY',
  'BACKUP_DAILY_RETENTION',
  'BACKUP_MONTHLY_RETENTION',
  'BACKUP_CALENDAR',
  'MAINTENANCE_CALENDAR',
  'CHECKPOINT_MAX_ROWS',
  'CHECKPOINT_MAX_PAYLOAD_BYTES',
  'CHECKPOINT_MAX_AGE_MS',
  'RESTORE_BATCH_LIMIT',
  'RESTORE_MAX_BATCHES',
  'PROMOTION_HOST_CHECK_TIMEOUT_MS',
  'RESTORE_STALE_LEASE_MS',
  'RESTORE_MAX_CHECKPOINT_AGE_MS',
]);
// Only schema-owned names may describe a refusal; map keys and values are private.
const diagnosticFields = new Set([
  ...Object.keys(container.shape),
  ...Object.keys(mount.shape),
  ...Object.keys(image.shape),
  ...Object.keys(network.shape),
  ...Object.keys(volume.shape),
  ...Object.keys(snapshot.shape),
  ...Object.keys(snapshot.shape.source.shape),
  ...Object.keys(snapshot.shape.target.shape),
  ...Object.keys(snapshot.shape.jobLabels.shape),
  ...Object.keys(promotionHostOptionsSchema.shape),
  ...Object.keys(promotionHostOptionsSchema.shape.job.shape),
  'stability',
]);
export class PromotionHostValidationError extends Error {
  readonly diagnosticCode: string;
  public constructor(code: string) {
    super('promotion_host_invalid');
    this.name = 'PromotionHostValidationError';
    this.diagnosticCode =
      ['arguments', 'input', 'validation', 'samples'].includes(code) ||
      (code.startsWith('samples.') && diagnosticFields.has(code.slice('samples.'.length)))
        ? code
        : 'validation';
  }
}
function invalid(code = 'validation'): never {
  throw new PromotionHostValidationError(code);
}
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
}
function canonicalContainer(c: Container): Container {
  return {
    ...c,
    mounts: canonicalPromotionMounts(c.mounts),
    networks: [...c.networks].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
  };
}
function canonicalSnapshot(s: z.infer<typeof snapshot>) {
  return {
    ...s,
    source: {
      ...s.source,
      postgres: canonicalContainer(s.source.postgres),
      terminal: canonicalContainer(s.source.terminal),
      networks: [...s.source.networks]
        .map((n) => ({
          ...n,
          members: [...n.members].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    },
    target: {
      ...s.target,
      postgres: canonicalContainer(s.target.postgres),
      terminal: canonicalContainer(s.target.terminal),
      network: {
        ...s.target.network,
        members: [...s.target.network.members].sort(),
      },
    },
    job: canonicalContainer(s.job),
    // Docker returns bind mounts in arbitrary order. Retain every record and
    // duplicate: different destinations may project the same source here.
    hostBinds: [...s.hostBinds].sort((a, b) =>
      deterministicJson(a).localeCompare(deterministicJson(b)),
    ),
  };
}
function deterministicJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(deterministicJson).join(',') + ']';
  }
  return (
    '{' +
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) => JSON.stringify(k) + ':' + deterministicJson((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function tmpfs(value: string): string {
  const parts = value.split(',');
  if (new Set(parts.map((p) => p.split('=')[0])).size !== parts.length) invalid();
  return parts
    .map((p) => {
      if (p.startsWith('mode=')) return `mode=${String(Number.parseInt(p.slice(5), 8))}`;
      if (p.startsWith('size=')) {
        const m = /^size=([1-9][0-9]*)([kmg])?$/iu.exec(p);
        if (m === null) invalid();
        return `size=${String(Number(m[1]) * ({ k: 1024, m: 1048576, g: 1073741824 }[m[2]?.toLowerCase() ?? ''] ?? 1))}`;
      }
      return p;
    })
    .sort()
    .join(',');
}
function security(c: Container, l: Options['limits']['job'], o: Options) {
  if ((c.capAdd?.length ?? 0) !== 0) invalid('samples.capAdd');
  if (!same(c.capDrop, ['ALL'])) invalid('samples.capDrop');
  if (
    c.securityOpt.length !== 1 ||
    !['no-new-privileges', 'no-new-privileges:true'].includes(c.securityOpt[0] ?? '')
  )
    invalid('samples.securityOpt');
  if ((c.groupAdd?.length ?? 0) !== 0) invalid('samples.groupAdd');
  if ((c.volumesFrom?.length ?? 0) !== 0) invalid('samples.volumesFrom');
  if ((c.extraHosts?.length ?? 0) !== 0) invalid('samples.extraHosts');
  if (Object.keys(c.sysctls ?? {}).length !== 0) invalid('samples.sysctls');
  if (c.nanoCpus !== Math.round(l.cpus * 1e9)) invalid('samples.nanoCpus');
  if (c.memory !== l.memoryMiB * 1048576) invalid('samples.memory');
  if (c.pidsLimit !== l.pids) invalid('samples.pidsLimit');
  if (c.stopTimeout !== o.limits.stopTimeoutSeconds) invalid('samples.stopTimeout');
  if (new Set(c.environmentNames).size !== c.environmentNames.length)
    invalid('samples.environmentNames');
}
function mounts(
  c: Container,
  expected: z.infer<typeof mount>[],
  expectedTmpfs: Record<string, string>,
) {
  const cMounts = canonicalPromotionMounts(c.mounts.filter((m) => m.type !== 'tmpfs'));
  const expMounts = canonicalPromotionMounts(expected);
  if (deterministicJson(cMounts) !== deterministicJson(expMounts)) invalid('samples.mounts');
  if (!same(Object.keys(c.tmpfs), Object.keys(expectedTmpfs))) invalid('samples.tmpfs');
  if (Object.entries(c.tmpfs).some(([p, v]) => tmpfs(v) !== tmpfs(expectedTmpfs[p] ?? '')))
    invalid('samples.tmpfs');
  if (
    c.mounts.some(
      (m) =>
        m.type === 'tmpfs' &&
        (!(m.destination in c.tmpfs) || !m.readWrite || m.source !== '' || m.name !== ''),
    )
  )
    invalid('samples.tmpfs');
}
function binding(root: string, directory: string, secret: string): z.infer<typeof mount> {
  return {
    type: 'bind',
    name: '',
    source: `${root}/${directory}/${secret}`,
    destination: `/run/secrets/${secret}`,
    readWrite: false,
    propagation: 'rprivate',
  };
}
function volumeMount(
  v: z.infer<typeof volume>,
  destination: string,
  readWrite: boolean,
): z.infer<typeof mount> {
  return {
    type: 'volume',
    name: v.name,
    source: v.mountpoint,
    destination,
    readWrite,
    propagation: '',
  };
}
function postgres(c: Container, v: z.infer<typeof volume>, o: Options, target: boolean) {
  security(c, o.limits.postgres, o);
  if (c.service !== 'postgres') invalid('samples.service');
  if (!c.healthy) invalid('samples.healthy');
  if (!['postgres', '999', '999:999'].includes(c.user)) invalid('samples.user');
  if (c.restartPolicy !== (target ? 'no' : 'unless-stopped')) invalid('samples.restartPolicy');
  if (JSON.stringify(c.command) !== '["postgres"]') invalid('samples.command');
  if (JSON.stringify(c.entrypoint) !== '["/usr/local/bin/fcd-postgres-entrypoint.sh"]')
    invalid('samples.entrypoint');
  if (
    c.environmentNames.some(
      (k) =>
        /(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|DATABASE_URL|HMAC|KEYRING)/u.test(k) &&
        k !== 'POSTGRES_PASSWORD_FILE',
    )
  )
    invalid('samples.environmentNames');
  const n = o.limits.postgres.tmpfsMiB;
  mounts(
    c,
    [
      volumeMount(v, '/var/lib/postgresql', true),
      binding(
        o.secretRoot,
        target ? 'restore' : 'postgres',
        target ? 'restore-postgres-password' : 'postgres-password',
      ),
    ],
    {
      '/tmp': `rw,noexec,nosuid,nodev,mode=1777,size=${String(n)}m`,
      '/var/run/postgresql': `rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=${String(n)}m`,
    },
  );
}
function check(s: z.infer<typeof snapshot>, o: Options) {
  const { source, target, job } = s;
  const sourceOps = `${o.runtimeProject}-operations-data`;
  if (s.archiveVolume.name !== o.backupVolumeName) invalid('samples.volume');
  if (new Set([source.postgres.id, target.postgres.id, job.id]).size !== 3) invalid('samples.id');
  if (o.sourceSystemIdentifier === o.targetSystemIdentifier) invalid('samples.systemIdentifier');
  if (o.sourceVolumeName === o.expectedHost.volumeName) invalid('samples.volume');
  if (o.backupVolumeName === o.sourceVolumeName) invalid('samples.volume');
  if (o.backupVolumeName === o.expectedHost.volumeName) invalid('samples.volume');
  if (source.postgres.id !== o.sourceContainerId) invalid('samples.id');
  if (source.postgres.project !== o.runtimeProject) invalid('samples.project');
  if (source.postgres.revision !== o.sourceRevision) invalid('samples.revision');
  if (source.postgres.imageId !== o.sourcePostgresImageId) invalid('samples.imageId');
  if (source.image.id !== o.sourcePostgresImageId) invalid('samples.imageId');
  if (source.image.revision !== o.sourceRevision) invalid('samples.revision');
  if (!['postgres', '999', '999:999'].includes(source.image.user)) invalid('samples.user');
  if (source.systemIdentifier !== o.sourceSystemIdentifier) invalid('samples.systemIdentifier');
  if (source.selectionReference !== o.sourceSelectionReference) invalid('samples.reference');
  if (!same(source.projectActors, [source.postgres.id])) invalid('samples.projectActors');
  if (!same(source.volume.users, [source.postgres.id])) invalid('samples.users');
  if (source.volume.name !== o.sourceVolumeName) invalid('samples.name');
  if (source.volume.createdAt !== o.sourceVolumeIdentity.createdAt) invalid('samples.createdAt');
  if (source.volume.project !== o.sourceVolumeIdentity.project) invalid('samples.project');
  if (source.volume.logicalName !== o.sourceVolumeIdentity.logicalName)
    invalid('samples.logicalName');
  if (target.postgres.project !== o.expectedHost.projectName) invalid('samples.project');
  if (target.postgres.revision !== o.gitRevision) invalid('samples.revision');
  if (target.postgres.imageId !== o.expectedHost.postgresImageId) invalid('samples.imageId');
  if (target.image.id !== o.expectedHost.postgresImageId) invalid('samples.imageId');
  if (target.image.revision !== o.gitRevision) invalid('samples.revision');
  if (target.systemIdentifier !== o.targetSystemIdentifier) invalid('samples.systemIdentifier');
  if (!same(target.projectActors, [target.postgres.id])) invalid('samples.projectActors');
  if (!same(target.volume.users, [target.postgres.id])) invalid('samples.users');
  if (s.runtimeImage.id !== o.expectedHost.runtimeImageId) invalid('samples.imageId');
  if (s.runtimeImage.revision !== o.gitRevision) invalid('samples.revision');
  if (!['node', '1000', '1000:1000'].includes(s.runtimeImage.user)) invalid('samples.user');

  const sourceNames = ['webhook', 'admin', 'reply', 'outbound', 'notification', 'operations'].map(
    (role) => `${o.runtimeProject}-${role}-data`,
  );
  if (
    !same(
      source.networks.map((n) => n.name),
      sourceNames,
    ) ||
    new Set([...source.networks.map((n) => n.id), target.network.id]).size !== 7 ||
    !same(
      source.postgres.networks.map((n) => n.name),
      sourceNames,
    ) ||
    !sourceNames.includes(source.postgres.networkMode)
  )
    invalid('samples.networks');
  for (const n of source.networks) {
    if (
      n.project !== o.runtimeProject ||
      n.logicalName !== n.name.slice(o.runtimeProject.length + 1).replaceAll('-', '_') ||
      !same(
        n.members,
        n.name === sourceOps ? [source.postgres.id, job.id] : [source.postgres.id],
      ) ||
      source.postgres.networks.find((p) => p.name === n.name)?.id !== n.id
    )
      invalid('samples.networks');
  }
  const sourceNetwork = source.networks.find((n) => n.name === sourceOps);
  if (sourceNetwork === undefined) invalid('samples.networks');
  if (
    target.network.name !== `${o.expectedHost.projectName}-data` ||
    target.network.project !== o.expectedHost.projectName ||
    target.network.logicalName !== 'restore_data' ||
    target.network.id !== o.expectedHost.networkId ||
    !same(target.network.members, [target.postgres.id, job.id]) ||
    target.postgres.networks.length !== 1 ||
    target.postgres.networks[0]?.name !== target.network.name ||
    target.postgres.networks[0].id !== target.network.id ||
    target.postgres.networkMode !== target.network.name
  )
    invalid('samples.networks');
  if (
    job.id !== o.job.id ||
    job.project !== o.job.project ||
    job.service !== 'promote' ||
    job.revision !== o.gitRevision ||
    job.imageId !== o.job.imageId ||
    !['node', '1000', '1000:1000'].includes(job.user) ||
    job.restartPolicy !== 'no' ||
    job.restartCount !== 0 ||
    JSON.stringify(job.command) !== JSON.stringify(o.job.command) ||
    createHash('sha256').update(JSON.stringify(job.command)).digest('hex') !== o.job.commandHash ||
    JSON.stringify(job.entrypoint) !==
      '["/usr/local/bin/container-entrypoint.sh","operations-readonly"]' ||
    !same(
      job.networks.map((n) => n.name),
      [sourceNetwork.name, target.network.name],
    ) ||
    !job.networks.some((n) => n.id === sourceNetwork.id && n.name === sourceNetwork.name) ||
    !job.networks.some((n) => n.id === target.network.id && n.name === target.network.name) ||
    ![sourceNetwork.name, target.network.name].includes(job.networkMode) ||
    !same(s.jobProjectActors, [job.id]) ||
    s.jobLabels.reference !== o.job.reference ||
    s.jobLabels.parent !== o.runtimeProject ||
    s.jobLabels.commandHash !== o.job.commandHash ||
    o.job.project !== `fcd-support-operation-${o.job.reference.slice('operation_'.length)}`
  )
    invalid('samples.command');
  security(job, o.limits.job, o);
  const env = {
    NODE_ENV: 'production',
    OPS_GIT_REVISION: o.gitRevision,
    OPS_OPERATION_REFERENCE: o.job.reference,
    OPS_DATABASE_SYSTEM_IDENTIFIER: o.targetSystemIdentifier,
    OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: o.sourceSystemIdentifier,
    OPS_DATABASE_NAME: o.databaseName,
    OPS_SOURCE_DATABASE_NAME: o.databaseName,
    OPS_DATABASE_SCHEMA: o.databaseSchema,
    OPS_DATABASE_ROLE_PREFIX: o.rolePrefix,
    OPS_SCHEMA_REVISION: o.schemaRevision,
    RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
    RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
    ...Object.fromEntries(Object.entries(files).map(([k, [, v]]) => [k, `/run/secrets/${v}`])),
    ...Object.fromEntries(flags.map((k) => [k, 'false'])),
    CHECKPOINT_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/backups',
  };
  const imageEnvironment: Readonly<Record<string, RegExp>> = {
    PG_MAJOR: /^18$/u,
    PG_VERSION: /^18\.[0-9]+(?:-[0-9A-Za-z.+~]+)?$/u,
    PGDATA: /^\/var\/lib\/postgresql\/18\/docker$/u,
    PG_SHA256: /^[a-f0-9]{64}$/u,
  };
  const imageKeys = Object.keys(imageEnvironment).filter((key) =>
    job.environmentNames.includes(key),
  );
  if (
    imageKeys.some((key) => !imageEnvironment[key]?.test(s.jobEnvironment[key] ?? '')) ||
    !same(Object.keys(s.jobEnvironment), [...Object.keys(env), ...imageKeys]) ||
    Object.entries(env).some(([k, v]) => s.jobEnvironment[k] !== v) ||
    !same(
      job.executionFlags,
      flags.map((k) => `${k}=false`),
    ) ||
    Object.keys(env).some((k) => !job.environmentNames.includes(k)) ||
    job.environmentNames.some(
      (k) => !(k in env) && !(k in imageEnvironment) && !benignEnvironment.has(k),
    )
  )
    invalid('samples.environmentNames');
  mounts(
    job,
    [
      {
        type: 'volume',
        name: o.backupVolumeName,
        source: s.archiveVolume.mountpoint,
        destination: '/var/lib/fcd-support/backups',
        readWrite: false,
        propagation: '',
      },
      ...Object.values(files).map(([dir, file]) => binding(o.secretRoot, dir, file)),
    ],
    {
      '/run/fcd-support': `rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=${String(o.limits.job.tmpfsMiB)}m`,
    },
  );
  postgres(source.postgres, source.volume, o, false);
  postgres(source.terminal, source.volume, o, false);
  if (
    deterministicJson(canonicalContainer(source.postgres)) !==
    deterministicJson(canonicalContainer(source.terminal))
  )
    invalid('samples.stability');
  postgres(target.postgres, target.volume, o, true);
  postgres(target.terminal, target.volume, o, true);
  if (
    deterministicJson(canonicalContainer(target.postgres)) !==
    deterministicJson(canonicalContainer(target.terminal))
  )
    invalid('samples.stability');
  if (
    overlaps(source.volume.mountpoint, target.volume.mountpoint) ||
    [source.volume.mountpoint, target.volume.mountpoint].some((root) =>
      overlaps(root, s.archiveVolume.mountpoint),
    ) ||
    s.hostBinds.some((b) =>
      [source.volume.mountpoint, target.volume.mountpoint].some(
        (p) => overlaps(p, b.source) || overlaps(p, b.canonicalSource),
      ),
    )
  )
    invalid('samples.hostBinds');
  // The raw source/target membership and complete job capability checks above
  // precede this filtered base view. A foreign peer is never filtered away.
  const { scope: ignoredScope, ...targetNetwork } = target.network;
  void ignoredScope;
  const { users: ignoredUsers, ...targetVolume } = target.volume;
  void ignoredUsers;
  const c = target.postgres;
  const base = {
    volume: targetVolume,
    liveVolume: {
      name: source.volume.name,
      driver: source.volume.driver,
      scope: source.volume.scope,
      options: source.volume.options,
      mountpoint: source.volume.mountpoint,
    },
    network: { ...targetNetwork, members: [c.id] },
    postgres: {
      id: c.id,
      project: c.project,
      service: c.service,
      revision: c.revision,
      imageId: c.imageId,
      running: c.running,
      paused: c.paused,
      restarting: c.restarting,
      dead: c.dead,
      healthy: c.healthy,
      readOnlyRootfs: c.readOnlyRootfs,
      privileged: c.privileged,
      user: c.user,
      networkMode: c.networkMode,
      networkIds: c.networks.map((n) => n.id),
      hostPortBindings: c.hostPortBindings,
      publishAllPorts: c.publishAllPorts,
      pidMode: c.pidMode,
      ipcMode: c.ipcMode,
      capAdd: c.capAdd,
      capDrop: c.capDrop,
      securityOpt: c.securityOpt,
      mounts: c.mounts
        .filter((m) => m.type !== 'tmpfs')
        .map(({ type, name, destination, readWrite }) => ({ type, name, destination, readWrite })),
    },
    volumeUsers: target.volume.users,
    postgresImage: target.image,
    runtimeImage: s.runtimeImage,
  };
  return base;
}
/** Fresh metadata under the controller's deployment lock, never a transferable
 * readiness token. Raw samples retain the actual job on both database bridges. */
export function inspectPromotionHostSamples(
  input: unknown,
  expected: unknown,
): RestoreHostIdentity {
  let o: Options;
  try {
    o = promotionHostOptionsSchema.parse(expected);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const prop = issue?.path.findLast(
        (part): part is string => typeof part === 'string' && diagnosticFields.has(part),
      );
      invalid(prop !== undefined ? `samples.${prop}` : 'input');
    }
    invalid('input');
  }
  let samples: { before: z.infer<typeof snapshot>; after: z.infer<typeof snapshot> };
  try {
    samples = z.strictObject({ before: snapshot, after: snapshot }).parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const prop = issue?.path.findLast(
        (part): part is string => typeof part === 'string' && diagnosticFields.has(part),
      );
      invalid(prop !== undefined ? `samples.${prop}` : 'samples');
    }
    invalid('samples');
  }
  const before = check(samples.before, o);
  const after = check(samples.after, o);
  if (
    deterministicJson(canonicalSnapshot(samples.before)) !==
    deterministicJson(canonicalSnapshot(samples.after))
  )
    invalid('samples.stability');
  try {
    return inspectRestoreHostSamples(
      { before, after },
      {
        projectName: o.expectedHost.projectName,
        volumeName: o.expectedHost.volumeName,
        liveVolumeName: o.sourceVolumeName,
        gitRevision: o.gitRevision,
        expectedHost: o.expectedHost,
      },
    );
  } catch {
    invalid('samples.target');
  }
}
