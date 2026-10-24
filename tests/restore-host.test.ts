import { expect, test } from 'vitest';
import {
  inspectRestoreHostSnapshot,
  inspectRestoreHostSamples,
} from '../src/operations/restore-host.js';

function fixture() {
  const revision = 'a'.repeat(40);
  const project = 'fcd-support-restore-synthetic';
  const volume = 'fcd-support-restore-synthetic-postgres';
  const id = 'b'.repeat(64);
  const networkId = 'c'.repeat(64);
  const postgresImageId = `sha256:${'d'.repeat(64)}`;
  const runtimeImageId = `sha256:${'e'.repeat(64)}`;
  const container = {
    id,
    project,
    service: 'postgres',
    revision,
    imageId: postgresImageId,
    running: true,
    paused: false,
    restarting: false,
    dead: false,
    healthy: true,
    readOnlyRootfs: true,
    privileged: false,
    user: 'postgres',
    networkMode: `${project}-data`,
    networkIds: [networkId],
    hostPortBindings: 0,
    publishAllPorts: false,
    pidMode: '',
    ipcMode: 'private',
    capAdd: [],
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    mounts: [{ type: 'volume', name: volume, destination: '/var/lib/postgresql', readWrite: true }],
  };
  const snapshot = {
    volume: {
      name: volume,
      driver: 'local',
      scope: 'local',
      options: null,
      project,
      logicalName: 'restore-data',
      createdAt: '2030-03-01T00:00:00Z',
      mountpoint: `/var/lib/docker/volumes/${volume}/_data`,
    },
    liveVolume: {
      name: 'fcd-support-runtime-postgres',
      driver: 'local',
      scope: 'local',
      options: null,
      mountpoint: '/var/lib/docker/volumes/fcd-support-runtime-postgres/_data',
    },
    network: {
      id: networkId,
      name: `${project}-data`,
      driver: 'bridge',
      internal: true,
      project,
      logicalName: 'restore_data',
      members: [id],
    },
    postgres: container,
    volumeUsers: [id],
    postgresImage: {
      id: postgresImageId,
      revision,
      os: 'linux',
      architecture: 'amd64',
      user: 'postgres',
    },
    runtimeImage: {
      id: runtimeImageId,
      revision,
      os: 'linux',
      architecture: 'amd64',
      user: 'node',
    },
  };
  return {
    snapshot,
    options: {
      projectName: project,
      volumeName: volume,
      liveVolumeName: 'fcd-support-runtime-postgres',
      gitRevision: revision,
    },
    target: {
      projectName: project,
      volumeName: volume,
      volumeCreatedAt: '2030-03-01T00:00:00Z',
      networkId,
      postgresImageId,
      runtimeImageId,
    },
  };
}

test('derives a content-free host identity from isolated actual Docker projections', () => {
  const f = fixture();
  expect(inspectRestoreHostSnapshot(f.snapshot, f.options)).toEqual(f.target);
});

test('requires two matching independently collected samples before returning host identity', () => {
  const f = fixture();
  expect(
    inspectRestoreHostSamples(
      { before: f.snapshot, after: structuredClone(f.snapshot) },
      f.options,
    ),
  ).toEqual(f.target);
  const after = structuredClone(f.snapshot);
  after.volume.createdAt = '2030-03-02T00:00:00Z';
  expect(() => inspectRestoreHostSamples({ before: f.snapshot, after }, f.options)).toThrow(
    /^restore_host_invalid$/u,
  );
});

test('refuses a database container replaced between samples even on the same volume/image/network', () => {
  const f = fixture();
  const after = structuredClone(f.snapshot);
  after.postgres.id = 'f'.repeat(64);
  after.network.members = [after.postgres.id];
  after.volumeUsers = [after.postgres.id];
  expect(() => inspectRestoreHostSamples({ before: f.snapshot, after }, f.options)).toThrow(
    /^restore_host_invalid$/u,
  );
});

test('binds a later sample to every previously recorded host identity field', () => {
  const f = fixture();
  expect(inspectRestoreHostSnapshot(f.snapshot, { ...f.options, expectedHost: f.target })).toEqual(
    f.target,
  );
  for (const field of [
    'networkId',
    'postgresImageId',
    'runtimeImageId',
    'volumeCreatedAt',
  ] as const) {
    const substitute =
      field === 'volumeCreatedAt'
        ? '2030-03-02T00:00:00Z'
        : field === 'networkId'
          ? 'f'.repeat(64)
          : `sha256:${'f'.repeat(64)}`;
    expect(() =>
      inspectRestoreHostSnapshot(f.snapshot, {
        ...f.options,
        expectedHost: { ...f.target, [field]: substitute },
      }),
    ).toThrow(/^restore_host_invalid$/u);
  }
});

test.each([
  [
    'extra network endpoint',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.network.members.push('f'.repeat(64));
    },
  ],
  [
    'stopped application volume mount',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.volumeUsers.push('f'.repeat(64));
    },
  ],
  [
    'live volume selected',
    (f: ReturnType<typeof fixture>) => {
      f.options.liveVolumeName = f.options.volumeName;
    },
  ],
  [
    'volume path alias',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.liveVolume.mountpoint = f.snapshot.volume.mountpoint;
    },
  ],
  [
    'wrong volume project',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.volume.project = 'fcd-support-restore-other';
    },
  ],
  [
    'wrong logical volume',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.volume.logicalName = 'backups';
    },
  ],
  [
    'wrong network project',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.network.project = 'fcd-support-restore-other';
    },
  ],
  [
    'public network',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.network.internal = false;
    },
  ],
  [
    'overlay network',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.network.driver = 'overlay';
    },
  ],
  [
    'substituted postgres image',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.imageId = `sha256:${'f'.repeat(64)}`;
    },
  ],
  [
    'wrong runtime revision',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.runtimeImage.revision = 'f'.repeat(40);
    },
  ],
  [
    'wrong database image revision',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgresImage.revision = 'f'.repeat(40);
    },
  ],
  [
    'wrong container revision',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.revision = 'f'.repeat(40);
    },
  ],
  [
    'wrong container role',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.service = 'fcd-support-api';
    },
  ],
  [
    'wrong container project',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.project = 'fcd-support-runtime';
    },
  ],
  [
    'stopped database',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.running = false;
    },
  ],
  [
    'unhealthy database',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.healthy = false;
    },
  ],
  [
    'restarting database',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.restarting = true;
    },
  ],
  [
    'paused database',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.paused = true;
    },
  ],
  [
    'writable root',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.readOnlyRootfs = false;
    },
  ],
  [
    'privileged container',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.privileged = true;
    },
  ],
  [
    'root database user',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.user = '0';
    },
  ],
  [
    'extra network',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.networkIds.push('f'.repeat(64));
    },
  ],
  [
    'published port',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.hostPortBindings = 1;
    },
  ],
  [
    'automatic publication',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.publishAllPorts = true;
    },
  ],
  [
    'host networking',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.networkMode = 'host';
    },
  ],
  [
    'host process namespace',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.pidMode = 'host';
    },
  ],
  [
    'host IPC',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.ipcMode = 'host';
    },
  ],
  [
    'capabilities not dropped',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.capDrop = [];
    },
  ],
  [
    'privilege escalation allowed',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.securityOpt = [];
    },
  ],
  [
    'read-only database storage',
    (f: ReturnType<typeof fixture>) => {
      const mount = f.snapshot.postgres.mounts[0];
      if (mount) mount.readWrite = false;
    },
  ],
  [
    'different storage target',
    (f: ReturnType<typeof fixture>) => {
      const mount = f.snapshot.postgres.mounts[0];
      if (mount) mount.destination = '/other';
    },
  ],
  [
    'foreign writable mount',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.mounts.push({
        type: 'bind',
        name: '',
        destination: '/workspace',
        readWrite: true,
      });
    },
  ],
  [
    'docker socket mount',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.postgres.mounts.push({
        type: 'bind',
        name: '',
        destination: '/var/run/docker.sock',
        readWrite: false,
      });
    },
  ],
] as const)('refuses %s', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => inspectRestoreHostSnapshot(f.snapshot, f.options)).toThrow(
    /^restore_host_invalid$/u,
  );
});

test('rejects custom volume drivers/options, foreign fields and malformed metadata without diagnostics', () => {
  const f = fixture();
  for (const snapshot of [
    { ...f.snapshot, volume: { ...f.snapshot.volume, options: { device: '/synthetic' } } },
    { ...f.snapshot, volume: { ...f.snapshot.volume, driver: 'nfs' } },
    {
      ...f.snapshot,
      postgres: { ...f.snapshot.postgres, environment: ['synthetic_secret_not_for_output'] },
    },
    { ...f.snapshot, volume: { ...f.snapshot.volume, createdAt: 'invalid' } },
    { ...f.snapshot, runtimeImage: { ...f.snapshot.runtimeImage, architecture: 'arm64' } },
  ])
    expect(() => inspectRestoreHostSnapshot(snapshot, f.options)).toThrow(
      /^restore_host_invalid$/u,
    );
});
