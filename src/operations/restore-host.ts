import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const project = z.string().regex(/^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$/u);
const volumeName = z.string().regex(/^fcd-support[-a-z0-9_]{1,128}$/u);
const absolutePath = z
  .string()
  .regex(/^\/[A-Za-z0-9._/-]+$/u)
  .refine(
    (value) =>
      value !== '/' &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      !value.split('/').some((part) => part === '.' || part === '..'),
  );
const strings = z.array(z.string().max(256)).max(32);
const localVolume = z.strictObject({
  name: volumeName,
  driver: z.literal('local'),
  scope: z.literal('local'),
  options: z
    .record(z.string(), z.unknown())
    .nullable()
    .refine((value) => value === null || Object.keys(value).length === 0),
  mountpoint: absolutePath,
});
const image = z.strictObject({
  id: imageId,
  revision,
  os: z.literal('linux'),
  architecture: z.literal('amd64'),
  user: z.string().max(64),
});
const snapshotSchema = z.strictObject({
  volume: localVolume.extend({
    project,
    logicalName: z.literal('restore-data'),
    createdAt: z.iso.datetime(),
  }),
  liveVolume: localVolume,
  network: z.strictObject({
    id,
    name: z.string().max(128),
    driver: z.literal('bridge'),
    internal: z.literal(true),
    project,
    logicalName: z.literal('restore_data'),
    members: z.array(id).length(1),
  }),
  postgres: z.strictObject({
    id,
    project,
    service: z.literal('postgres'),
    revision,
    imageId,
    running: z.literal(true),
    paused: z.literal(false),
    restarting: z.literal(false),
    dead: z.literal(false),
    healthy: z.literal(true),
    readOnlyRootfs: z.literal(true),
    privileged: z.literal(false),
    user: z.string().max(64),
    networkMode: z.string().max(128),
    networkIds: z.array(id).length(1),
    hostPortBindings: z.literal(0),
    publishAllPorts: z.literal(false),
    pidMode: z.literal(''),
    ipcMode: z.literal('private'),
    capAdd: strings.nullable(),
    capDrop: strings,
    securityOpt: strings,
    mounts: z
      .array(
        z.strictObject({
          type: z.enum(['volume', 'bind']),
          name: z.string().max(256),
          destination: absolutePath,
          readWrite: z.boolean(),
        }),
      )
      .min(1)
      .max(8),
  }),
  volumeUsers: z.array(id).length(1),
  postgresImage: image,
  runtimeImage: image,
});
export const restoreHostIdentitySchema = z.strictObject({
  projectName: project,
  volumeName,
  volumeCreatedAt: z.iso.datetime(),
  networkId: id,
  postgresImageId: imageId,
  runtimeImageId: imageId,
});
export type RestoreHostIdentity = z.infer<typeof restoreHostIdentitySchema>;
const optionsSchema = z.strictObject({
  projectName: project,
  volumeName,
  liveVolumeName: volumeName,
  gitRevision: revision,
  expectedHost: restoreHostIdentitySchema.optional(),
});
export interface RestoreHostOptions {
  readonly projectName: string;
  readonly volumeName: string;
  readonly liveVolumeName: string;
  readonly gitRevision: string;
  readonly expectedHost?: RestoreHostIdentity;
}

/** Validates narrowed Docker projections, not arbitrary full inspect output.
 * This is a current sample, not a reservation or transferable promotion token.
 * The host collector and deployment lock remain separate trusted capabilities. */
export function inspectRestoreHostSnapshot(
  input: unknown,
  expected: RestoreHostOptions,
): RestoreHostIdentity {
  try {
    const snapshot = snapshotSchema.parse(input);
    const options = optionsSchema.parse(expected);
    const { volume, liveVolume, network, postgres, postgresImage, runtimeImage } = snapshot;
    if (
      volume.name !== options.volumeName ||
      liveVolume.name !== options.liveVolumeName ||
      volume.name === liveVolume.name ||
      volume.project !== options.projectName ||
      network.project !== options.projectName ||
      postgres.project !== options.projectName ||
      network.name !== `${options.projectName}-data` ||
      postgres.networkMode !== network.name ||
      network.members[0] !== postgres.id ||
      snapshot.volumeUsers[0] !== postgres.id ||
      postgres.networkIds[0] !== network.id ||
      [postgres.revision, postgresImage.revision, runtimeImage.revision].some(
        (value) => value !== options.gitRevision,
      ) ||
      postgres.imageId !== postgresImage.id ||
      !['postgres', '999', '999:999'].includes(postgres.user) ||
      !['postgres', '999', '999:999'].includes(postgresImage.user) ||
      !['node', '1000', '1000:1000'].includes(runtimeImage.user) ||
      (postgres.capAdd?.length ?? 0) !== 0 ||
      postgres.capDrop.length !== 1 ||
      postgres.capDrop[0] !== 'ALL' ||
      postgres.securityOpt.length !== 1 ||
      !['no-new-privileges', 'no-new-privileges:true'].includes(postgres.securityOpt[0] ?? '') ||
      volume.mountpoint === liveVolume.mountpoint ||
      volume.mountpoint.startsWith(liveVolume.mountpoint + '/') ||
      liveVolume.mountpoint.startsWith(volume.mountpoint + '/')
    )
      throw new Error('invalid');
    const data = postgres.mounts.filter(
      (mount) =>
        mount.type === 'volume' &&
        mount.name === volume.name &&
        mount.destination === '/var/lib/postgresql' &&
        mount.readWrite,
    );
    if (
      data.length !== 1 ||
      postgres.mounts.some(
        (mount) =>
          mount !== data[0] &&
          !(
            mount.type === 'bind' &&
            mount.destination === '/run/secrets/restore-postgres-password' &&
            !mount.readWrite
          ),
      )
    )
      throw new Error('invalid');
    const identity: RestoreHostIdentity = {
      projectName: options.projectName,
      volumeName: volume.name,
      volumeCreatedAt: volume.createdAt,
      networkId: network.id,
      postgresImageId: postgresImage.id,
      runtimeImageId: runtimeImage.id,
    };
    if (
      options.expectedHost !== undefined &&
      JSON.stringify(identity) !== JSON.stringify(options.expectedHost)
    )
      throw new Error('invalid');
    return identity;
  } catch {
    throw new Error('restore_host_invalid');
  }
}

export function inspectRestoreHostSamples(
  input: unknown,
  expected: RestoreHostOptions,
): RestoreHostIdentity {
  try {
    const samples = z.strictObject({ before: snapshotSchema, after: snapshotSchema }).parse(input);
    const before = inspectRestoreHostSnapshot(samples.before, expected);
    const after = inspectRestoreHostSnapshot(samples.after, { ...expected, expectedHost: before });
    if (samples.before.postgres.id !== samples.after.postgres.id) throw new Error('invalid');
    return after;
  } catch {
    throw new Error('restore_host_invalid');
  }
}
