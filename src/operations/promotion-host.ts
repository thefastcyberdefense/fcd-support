import { createHash } from 'node:crypto';
import { z } from 'zod';
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
    image,
    networks: z.array(network).length(6),
    volume,
    projectActors: z.array(id).length(1),
    systemIdentifier,
    selectionReference,
  }),
  target: z.strictObject({
    postgres: container,
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
function invalid(): never {
  throw new Error('promotion_host_invalid');
}
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
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
  if (
    (c.capAdd?.length ?? 0) !== 0 ||
    !same(c.capDrop, ['ALL']) ||
    c.securityOpt.length !== 1 ||
    !['no-new-privileges', 'no-new-privileges:true'].includes(c.securityOpt[0] ?? '') ||
    (c.groupAdd?.length ?? 0) !== 0 ||
    (c.volumesFrom?.length ?? 0) !== 0 ||
    (c.extraHosts?.length ?? 0) !== 0 ||
    Object.keys(c.sysctls ?? {}).length !== 0 ||
    c.nanoCpus !== Math.round(l.cpus * 1e9) ||
    c.memory !== l.memoryMiB * 1048576 ||
    c.pidsLimit !== l.pids ||
    c.stopTimeout !== o.limits.stopTimeoutSeconds ||
    new Set(c.environmentNames).size !== c.environmentNames.length
  )
    invalid();
}
function mounts(
  c: Container,
  expected: z.infer<typeof mount>[],
  expectedTmpfs: Record<string, string>,
) {
  if (
    stable(c.mounts.filter((m) => m.type !== 'tmpfs')) !== stable(expected) ||
    !same(Object.keys(c.tmpfs), Object.keys(expectedTmpfs)) ||
    Object.entries(c.tmpfs).some(([p, v]) => tmpfs(v) !== tmpfs(expectedTmpfs[p] ?? '')) ||
    c.mounts.some(
      (m) =>
        m.type === 'tmpfs' &&
        (!(m.destination in c.tmpfs) || !m.readWrite || m.source !== '' || m.name !== ''),
    )
  )
    invalid();
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
  if (
    c.service !== 'postgres' ||
    !c.healthy ||
    !['postgres', '999', '999:999'].includes(c.user) ||
    c.restartPolicy !== (target ? 'no' : 'unless-stopped') ||
    JSON.stringify(c.command) !== '["postgres"]' ||
    JSON.stringify(c.entrypoint) !== '["/usr/local/bin/fcd-postgres-entrypoint.sh"]' ||
    c.environmentNames.some(
      (k) =>
        /(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|DATABASE_URL|HMAC|KEYRING)/u.test(k) &&
        k !== 'POSTGRES_PASSWORD_FILE',
    )
  )
    invalid();
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
  if (
    s.archiveVolume.name !== o.backupVolumeName ||
    new Set([source.postgres.id, target.postgres.id, job.id]).size !== 3 ||
    o.sourceSystemIdentifier === o.targetSystemIdentifier ||
    o.sourceVolumeName === o.expectedHost.volumeName ||
    o.backupVolumeName === o.sourceVolumeName ||
    o.backupVolumeName === o.expectedHost.volumeName ||
    source.postgres.id !== o.sourceContainerId ||
    source.postgres.project !== o.runtimeProject ||
    source.postgres.revision !== o.sourceRevision ||
    source.postgres.imageId !== o.sourcePostgresImageId ||
    source.image.id !== o.sourcePostgresImageId ||
    source.image.revision !== o.sourceRevision ||
    !['postgres', '999', '999:999'].includes(source.image.user) ||
    source.systemIdentifier !== o.sourceSystemIdentifier ||
    source.selectionReference !== o.sourceSelectionReference ||
    !same(source.projectActors, [source.postgres.id]) ||
    !same(source.volume.users, [source.postgres.id]) ||
    source.volume.name !== o.sourceVolumeName ||
    source.volume.createdAt !== o.sourceVolumeIdentity.createdAt ||
    source.volume.project !== o.sourceVolumeIdentity.project ||
    source.volume.logicalName !== o.sourceVolumeIdentity.logicalName ||
    target.postgres.project !== o.expectedHost.projectName ||
    target.postgres.revision !== o.gitRevision ||
    target.postgres.imageId !== o.expectedHost.postgresImageId ||
    target.image.id !== o.expectedHost.postgresImageId ||
    target.image.revision !== o.gitRevision ||
    target.systemIdentifier !== o.targetSystemIdentifier ||
    !same(target.projectActors, [target.postgres.id]) ||
    !same(target.volume.users, [target.postgres.id]) ||
    s.runtimeImage.id !== o.expectedHost.runtimeImageId ||
    s.runtimeImage.revision !== o.gitRevision ||
    !['node', '1000', '1000:1000'].includes(s.runtimeImage.user)
  )
    invalid();
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
    invalid();
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
      invalid();
  }
  const sourceNetwork = source.networks.find((n) => n.name === sourceOps);
  if (sourceNetwork === undefined) invalid();
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
    invalid();
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
    invalid();
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
    CHECKPOINT_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/backups/checkpoints',
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
    invalid();
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
  postgres(target.postgres, target.volume, o, true);
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
    invalid();
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
  try {
    const o = promotionHostOptionsSchema.parse(expected);
    const samples = z.strictObject({ before: snapshot, after: snapshot }).parse(input);
    const before = check(samples.before, o);
    const after = check(samples.after, o);
    if (stable(samples.before) !== stable(samples.after)) invalid();
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
    invalid();
  }
}
