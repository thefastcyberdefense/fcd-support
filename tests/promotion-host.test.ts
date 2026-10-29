import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { inspectPromotionHostSamples } from '../src/operations/promotion-host.js';

function fixture(createdAt = '2030-01-01T00:00:00Z') {
  const revision = 'a'.repeat(40);
  const sourceRevision = 'b'.repeat(40);
  const runtime = 'fcd-support-synthetic';
  const project = 'fcd-support-restore-synthetic';
  const sourceId = '1'.repeat(64);
  const targetId = '2'.repeat(64);
  const jobId = '3'.repeat(64);
  const operation = `operation_${'c'.repeat(32)}`;
  const jobProject = `fcd-support-operation-${'c'.repeat(32)}`;
  const pgImage = `sha256:${'d'.repeat(64)}`;
  const sourceImage = `sha256:${'e'.repeat(64)}`;
  const jobImage = `sha256:${'f'.repeat(64)}`;
  const sourceVolume = 'fcd-support-synthetic-source';
  const targetVolume = 'fcd-support-synthetic-target';
  const backupVolume = 'fcd-support-synthetic-backups';
  const secretRoot = '/synthetic/secrets';
  const sourceSystem = '7300000000000000001';
  const targetSystem = '7300000000000000002';
  const bind = (name: string, directory: string) => ({
    type: 'bind',
    name: '',
    source: `${secretRoot}/${directory}/${name}`,
    destination: `/run/secrets/${name}`,
    readWrite: false,
    propagation: 'rprivate',
  });
  const volume = (name: string, destination: string, readWrite: boolean) => ({
    type: 'volume',
    name,
    source: `/var/lib/docker/volumes/${name}/_data`,
    destination,
    readWrite,
    propagation: '',
  });
  const image = (id: string, rev: string, user: string) => ({
    id,
    revision: rev,
    os: 'linux',
    architecture: 'amd64',
    user,
  });
  const base = {
    project: runtime,
    service: 'postgres',
    revision: sourceRevision,
    imageId: sourceImage,
    running: true,
    paused: false,
    restarting: false,
    dead: false,
    healthy: true,
    startedAt: '2030-01-01T00:00:00Z',
    restartCount: 0,
    readOnlyRootfs: true,
    privileged: false,
    init: true,
    user: 'postgres',
    networkMode: `${runtime}-webhook-data`,
    networks: [] as { name: string; id: string }[],
    hostPortBindings: 0,
    publishedPortBindings: 0,
    publishAllPorts: false,
    pidMode: '',
    ipcMode: 'private',
    utsMode: '',
    capAdd: [] as string[],
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    devices: 0,
    deviceRequests: 0,
    groupAdd: [] as string[],
    volumesFrom: [] as string[],
    extraHosts: [] as string[],
    sysctls: {},
    nanoCpus: 1e9,
    memory: 268435456,
    pidsLimit: 64,
    stopTimeout: 2,
    restartPolicy: 'unless-stopped',
    tmpfs: {
      '/tmp': 'rw,noexec,nosuid,nodev,mode=1777,size=16m',
      '/var/run/postgresql': 'rw,noexec,nosuid,nodev,uid=999,gid=999,mode=0770,size=16m',
    } as Record<string, string>,
    command: ['postgres'],
    entrypoint: ['/usr/local/bin/fcd-postgres-entrypoint.sh'],
    environmentNames: ['POSTGRES_PASSWORD_FILE'],
    executionFlags: [] as string[],
    mounts: [
      volume(sourceVolume, '/var/lib/postgresql', true),
      bind('postgres-password', 'postgres'),
    ],
  };
  const networks = ['webhook', 'admin', 'reply', 'outbound', 'notification', 'operations'].map(
    (role, index) => ({
      id: String(index + 4).repeat(64),
      name: `${runtime}-${role}-data`,
      driver: 'bridge',
      scope: 'local',
      internal: true,
      project: runtime,
      logicalName: `${role}_data`,
      members: role === 'operations' ? [sourceId, jobId] : [sourceId],
    }),
  );
  const source = {
    ...base,
    id: sourceId,
    networks: networks.map(({ id, name }) => ({ id, name })),
  };
  const targetNetwork = {
    id: 'a'.repeat(64),
    name: `${project}-data`,
    driver: 'bridge',
    scope: 'local',
    internal: true,
    project,
    logicalName: 'restore_data',
    members: [targetId, jobId],
  };
  const target = {
    ...base,
    id: targetId,
    project,
    revision,
    imageId: pgImage,
    networkMode: targetNetwork.name,
    networks: [{ name: targetNetwork.name, id: targetNetwork.id }],
    restartPolicy: 'no',
    mounts: [
      volume(targetVolume, '/var/lib/postgresql', true),
      bind('restore-postgres-password', 'restore'),
    ],
  };
  const command = [
    'node',
    'dist/operations/promotion-main.js',
    'promote',
    `restore_${'1'.repeat(32)}`,
    `restore_${'2'.repeat(32)}`,
    `backup_${'3'.repeat(32)}`,
    `checkpoint_${'4'.repeat(32)}`,
    'e30=',
  ];
  const environment = {
    NODE_ENV: 'production',
    OPS_GIT_REVISION: revision,
    OPS_OPERATION_REFERENCE: operation,
    OPS_DATABASE_SYSTEM_IDENTIFIER: targetSystem,
    OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: sourceSystem,
    OPS_DATABASE_NAME: 'fcd_support_test',
    OPS_SOURCE_DATABASE_NAME: 'fcd_support_test',
    OPS_DATABASE_SCHEMA: 'public',
    OPS_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
    OPS_SCHEMA_REVISION: '000016',
    RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
    RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
    RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE: '/run/secrets/restore-checkpoint-database',
    RESTORE_TARGET_OWNER_DATABASE_URL_FILE: '/run/secrets/restore-database',
    PRIVACY_HMAC_KEYRING_FILE: '/run/secrets/restore-keyring',
    BACKUP_AGE_IDENTITY_FILE: '/run/secrets/restore-identity',
    RECOVERY_MANIFEST_HMAC_FILE: '/run/secrets/recovery-hmac',
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
    CHECKPOINT_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/backups',
  };
  const job = {
    ...base,
    id: jobId,
    project: jobProject,
    service: 'promote',
    revision,
    imageId: jobImage,
    user: 'node',
    healthy: false,
    networkMode: targetNetwork.name,
    networks: [
      { name: targetNetwork.name, id: targetNetwork.id },
      { name: networks.at(5)?.name ?? '', id: networks.at(5)?.id ?? '' },
    ],
    restartPolicy: 'no',
    tmpfs: { '/run/fcd-support': 'rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=32m' },
    command,
    entrypoint: ['/usr/local/bin/container-entrypoint.sh', 'operations-readonly'],
    environmentNames: Object.keys(environment),
    executionFlags: [
      'MODEL_EXECUTION_ENABLED=false',
      'OUTBOUND_EXECUTION_ENABLED=false',
      'N8N_EXECUTION_ENABLED=false',
    ],
    mounts: [
      volume(backupVolume, '/var/lib/fcd-support/backups', false),
      bind('restore-checkpoint-database', 'restore'),
      bind('restore-database', 'restore'),
      bind('restore-keyring', 'restore'),
      bind('restore-identity', 'verify-backup'),
      bind('recovery-hmac', 'backup'),
    ],
  };
  const localVolume = (name: string, projectName: string, logicalName: string) => ({
    name,
    driver: 'local',
    scope: 'local',
    options: null,
    project: projectName,
    logicalName,
    createdAt,
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  });
  const expectedHost = {
    projectName: project,
    volumeName: targetVolume,
    volumeCreatedAt: createdAt,
    networkId: targetNetwork.id,
    postgresImageId: pgImage,
    runtimeImageId: jobImage,
  };
  const snapshot = {
    source: {
      postgres: source,
      terminal: structuredClone(source),
      image: image(sourceImage, sourceRevision, 'postgres'),
      networks,
      volume: { ...localVolume(sourceVolume, runtime, 'postgres-data'), users: [sourceId] },
      projectActors: [sourceId],
      systemIdentifier: sourceSystem,
      selectionReference: `selection_${'d'.repeat(32)}`,
    },
    target: {
      postgres: target,
      terminal: structuredClone(target),
      image: image(pgImage, revision, 'postgres'),
      network: targetNetwork,
      volume: { ...localVolume(targetVolume, project, 'restore-data'), users: [targetId] },
      projectActors: [targetId],
      systemIdentifier: targetSystem,
    },
    job,
    jobEnvironment: environment,
    jobLabels: {
      reference: operation,
      parent: runtime,
      service: 'promote',
      commandHash: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    },
    jobProjectActors: [jobId],
    runtimeImage: image(jobImage, revision, 'node'),
    archiveVolume: {
      name: backupVolume,
      driver: 'local',
      scope: 'local',
      options: null,
      mountpoint: `/var/lib/docker/volumes/${backupVolume}/_data`,
    },
    hostBinds: [] as { containerId: string; source: string; canonicalSource: string }[],
  };
  const options = {
    expectedHost,
    runtimeProject: runtime,
    sourceContainerId: sourceId,
    sourceVolumeName: sourceVolume,
    sourceSystemIdentifier: sourceSystem,
    sourceSelectionReference: `selection_${'d'.repeat(32)}`,
    sourceRevision,
    sourcePostgresImageId: sourceImage,
    targetSystemIdentifier: targetSystem,
    gitRevision: revision,
    secretRoot,
    backupVolumeName: backupVolume,
    databaseName: 'fcd_support_test',
    databaseSchema: 'public',
    rolePrefix: 'fcd_synthetic',
    schemaRevision: '000016',
    job: {
      id: jobId,
      reference: operation,
      project: jobProject,
      imageId: jobImage,
      command: [...command],
      commandHash: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    },
    sourceVolumeIdentity: { project: runtime, logicalName: 'postgres-data', createdAt },
    limits: {
      postgres: { cpus: 1, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
      job: { cpus: 1, memoryMiB: 256, pids: 64, tmpfsMiB: 32 },
      stopTimeoutSeconds: 2,
    },
  };
  return { snapshot, options };
}

function inspect(f: ReturnType<typeof fixture>) {
  return inspectPromotionHostSamples(
    { before: f.snapshot, after: structuredClone(f.snapshot) },
    f.options,
  );
}
test('accepts the checkpoint path supplied by restore Compose and rejects a substituted path', () => {
  const source = readFileSync('infra/compose.restore.yml', 'utf8');
  const paths = [
    ...source.matchAll(/^ {6}CHECKPOINT_ARCHIVE_DIRECTORY: (\/[A-Za-z0-9._/-]+)[ \t]*\r?$/gmu),
  ];
  expect(paths).toHaveLength(1);
  const checkpointPath = paths[0]?.[1];
  if (checkpointPath === undefined) throw new Error('compose_checkpoint_path_missing');
  const actual = fixture();
  actual.snapshot.jobEnvironment.CHECKPOINT_ARCHIVE_DIRECTORY = checkpointPath;
  expect(inspect(actual)).toEqual(actual.options.expectedHost);
  const substituted = fixture();
  substituted.snapshot.jobEnvironment.CHECKPOINT_ARCHIVE_DIRECTORY = `${checkpointPath}/checkpoints`;
  expect(() => inspect(substituted)).toThrow(/^promotion_host_invalid$/u);
});

test('accepts only the exact live narrow promotion job on both private bridges and retains canonical target identity', () => {
  const f = fixture();
  expect(inspect(f)).toEqual(f.options.expectedHost);
});

test('promotion binds explicit volume timezone offsets without normalizing their identity', () => {
  const f = fixture('2030-01-01T06:00:00+06:00');
  expect(inspect(f)).toEqual(f.options.expectedHost);
  f.snapshot.target.volume.createdAt = '2030-01-01T00:00:00Z';
  expect(() => inspect(f)).toThrow('promotion_host_invalid');
});
test.each([
  [
    'foreign source actor',
    (f: ReturnType<typeof fixture>) => f.snapshot.source.projectActors.push('f'.repeat(64)),
  ],
  [
    'foreign target actor',
    (f: ReturnType<typeof fixture>) => f.snapshot.target.projectActors.push('f'.repeat(64)),
  ],
  [
    'foreign source peer',
    (f: ReturnType<typeof fixture>) =>
      f.snapshot.source.networks.at(5)?.members.push('f'.repeat(64)),
  ],
  [
    'foreign target peer',
    (f: ReturnType<typeof fixture>) => f.snapshot.target.network.members.push('f'.repeat(64)),
  ],
  [
    'source image substitution',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.source.postgres.imageId = f.snapshot.target.postgres.imageId;
    },
  ],
  [
    'source revision substitution',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.source.postgres.revision = f.options.gitRevision;
    },
  ],
  [
    'source physical substitution',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.source.systemIdentifier = f.snapshot.target.systemIdentifier;
    },
  ],
  [
    'target physical substitution',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.target.systemIdentifier = f.snapshot.source.systemIdentifier;
    },
  ],
  [
    'source volume shared by stopped actor',
    (f: ReturnType<typeof fixture>) => f.snapshot.source.volume.users.push('f'.repeat(64)),
  ],
  [
    'target volume shared by stopped actor',
    (f: ReturnType<typeof fixture>) => f.snapshot.target.volume.users.push('f'.repeat(64)),
  ],
  [
    'target creation changed',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.target.volume.createdAt = '2030-02-01T00:00:00Z';
    },
  ],
  [
    'source selected creation changed',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.source.volume.createdAt = '2030-02-01T00:00:00Z';
    },
  ],
  [
    'swapped job',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.id = 'f'.repeat(64);
    },
  ],
  [
    'job project substitute',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.project = 'fcd-support-operation-other';
    },
  ],
  [
    'job command substitute',
    (f: ReturnType<typeof fixture>) => f.snapshot.job.command.push('synthetic'),
  ],
  [
    'job label substitute',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.jobLabels.reference = `operation_${'f'.repeat(32)}`;
    },
  ],
  [
    'job privileged',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.privileged = true;
    },
  ],
  [
    'job root UID',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.user = '0';
    },
  ],
  [
    'job added capability',
    (f: ReturnType<typeof fixture>) => f.snapshot.job.capAdd.push('SYS_ADMIN'),
  ],
  [
    'job writable root',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.readOnlyRootfs = false;
    },
  ],
  [
    'job paused',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.paused = true;
    },
  ],
  [
    'job stopped',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.running = false;
    },
  ],
  [
    'job restart',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.restartCount = 1;
    },
  ],
  [
    'job extra network',
    (f: ReturnType<typeof fixture>) =>
      f.snapshot.job.networks.push({ name: 'synthetic-egress', id: 'f'.repeat(64) }),
  ],
  [
    'job swapped network id',
    (f: ReturnType<typeof fixture>) => {
      const network = f.snapshot.job.networks[0];
      if (network === undefined) throw new Error('fixture');
      network.id = 'f'.repeat(64);
    },
  ],
  [
    'job writable backup',
    (f: ReturnType<typeof fixture>) => {
      const mount = f.snapshot.job.mounts[0];
      if (mount === undefined) throw new Error('fixture');
      mount.readWrite = true;
    },
  ],
  [
    'job docker socket',
    (f: ReturnType<typeof fixture>) => {
      const mount = f.snapshot.job.mounts[1];
      if (mount === undefined) throw new Error('fixture');
      mount.source = '/var/run/docker.sock';
    },
  ],
  [
    'job secret host path substitute',
    (f: ReturnType<typeof fixture>) => {
      const mount = f.snapshot.job.mounts[1];
      if (mount === undefined) throw new Error('fixture');
      mount.source = '/synthetic/secrets/bootstrap/bootstrap-database';
    },
  ],
  [
    'job file path substitute',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.jobEnvironment.RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE =
        '/run/secrets/restore-database';
    },
  ],
  [
    'job source identity substitute',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.jobEnvironment.OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER =
        f.options.targetSystemIdentifier;
    },
  ],
  [
    'job raw credential name',
    (f: ReturnType<typeof fixture>) => f.snapshot.job.environmentNames.push('DATABASE_URL'),
  ],
  [
    'job bootstrap credential file',
    (f: ReturnType<typeof fixture>) =>
      f.snapshot.job.environmentNames.push('BOOTSTRAP_DATABASE_URL_FILE'),
  ],
  [
    'job hidden execution flag',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.jobEnvironment.MODEL_EXECUTION_ENABLED = 'true';
    },
  ],
  [
    'job extra false execution flag',
    (f: ReturnType<typeof fixture>) =>
      f.snapshot.job.executionFlags.push('MODEL_EXECUTION_ENABLED=false'),
  ],
  [
    'job no CPU bound',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.nanoCpus = 0;
    },
  ],
  [
    'job executable tmpfs',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.job.tmpfs['/run/fcd-support'] =
        'rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=32m';
    },
  ],
  [
    'source bind alias',
    (f: ReturnType<typeof fixture>) =>
      f.snapshot.hostBinds.push({
        containerId: 'f'.repeat(64),
        source: '/synthetic/alias',
        canonicalSource: f.snapshot.source.volume.mountpoint,
      }),
  ],
  [
    'target base check retained',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.target.network.internal = false;
    },
  ],
] as const)('refuses %s', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => inspect(f)).toThrow(/^promotion_host_invalid$/u);
});
test('rejects a changed raw sample even if the filtered target host identity is unchanged', () => {
  const f = fixture();
  const after = structuredClone(f.snapshot);
  after.job.startedAt = '2030-01-02T00:00:00Z';
  expect(() => inspectPromotionHostSamples({ before: f.snapshot, after }, f.options)).toThrow(
    /^promotion_host_invalid$/u,
  );
});

test('requires the protected source selection reference and exact bridge IDs', () => {
  const f = fixture();
  f.snapshot.source.selectionReference = `selection_${'f'.repeat(32)}`;
  expect(() => inspect(f)).toThrow(/^promotion_host_invalid$/u);
  const other = fixture();
  const network = other.snapshot.source.postgres.networks[0];
  if (network === undefined) throw new Error('fixture');
  network.id = 'f'.repeat(64);
  expect(() => inspect(other)).toThrow(/^promotion_host_invalid$/u);
});

test.each(['PGHOST', 'PGOPTIONS', 'NODE_OPTIONS', 'DATABASE_URL_FILE', 'BOOTSTRAP_PASSWORD_FILE'])(
  'rejects extra connection, code or credential capability %s',
  (key) => {
    const f = fixture();
    f.snapshot.job.environmentNames.push(key);
    expect(() => inspect(f)).toThrow(/^promotion_host_invalid$/u);
  },
);

test('permits constrained inherited PostgreSQL image metadata and rejects a changed value', () => {
  const f = fixture();
  f.snapshot.job.environmentNames.push('PG_MAJOR', 'PG_VERSION', 'PGDATA');
  Object.assign(f.snapshot.jobEnvironment, {
    PG_MAJOR: '18',
    PG_VERSION: '18.4-1.pgdg13+1',
    PGDATA: '/var/lib/postgresql/18/docker',
  });
  expect(inspect(f)).toEqual(f.options.expectedHost);
  Object.assign(f.snapshot.jobEnvironment, { PGDATA: '/synthetic/other' });
  expect(() => inspect(f)).toThrow(/^promotion_host_invalid$/u);
});

test('binds archive mounts to their actual local volume rather than a Docker root convention', () => {
  const f = fixture();
  f.snapshot.archiveVolume.mountpoint = '/synthetic/docker-data/archives';
  const archive = f.snapshot.job.mounts[0];
  if (archive === undefined) throw new Error('fixture');
  archive.source = f.snapshot.archiveVolume.mountpoint;
  expect(inspect(f)).toEqual(f.options.expectedHost);
  f.snapshot.archiveVolume.mountpoint = f.snapshot.source.volume.mountpoint;
  archive.source = f.snapshot.archiveVolume.mountpoint;
  expect(() => inspect(f)).toThrow(/^promotion_host_invalid$/u);
});

test('accepts reordered host bind inventory without losing record multiplicity', () => {
  const f = fixture();
  f.snapshot.hostBinds.push(
    {
      containerId: f.snapshot.job.id,
      source: '/synthetic/secrets/restore/restore-keyring',
      canonicalSource: '/synthetic/secrets/restore/restore-keyring',
    },
    {
      containerId: f.snapshot.job.id,
      source: '/synthetic/secrets/restore/restore-database',
      canonicalSource: '/synthetic/secrets/restore/restore-database',
    },
  );
  // Distinct destinations may yield identical projected bind sources.
  const repeated = f.snapshot.hostBinds[1];
  if (repeated === undefined) throw new Error('fixture_bind_missing');
  f.snapshot.hostBinds.push(structuredClone(repeated));
  const after = structuredClone(f.snapshot);
  after.hostBinds.reverse();
  expect(inspectPromotionHostSamples({ before: f.snapshot, after }, f.options)).toEqual(
    f.options.expectedHost,
  );
  const extra = after.hostBinds[0];
  if (extra === undefined) throw new Error('fixture_bind_missing');
  after.hostBinds.push(structuredClone(extra));
  expect(() => inspectPromotionHostSamples({ before: f.snapshot, after }, f.options)).toThrow(
    /^promotion_host_invalid$/u,
  );
});

test('accepts deterministic mount-order permutations within a snapshot and between snapshots', () => {
  const f = fixture();
  // Permutation within snapshot: initial postgres vs terminal
  f.snapshot.target.terminal.mounts.reverse();
  f.snapshot.source.terminal.mounts.reverse();
  const after = structuredClone(f.snapshot);
  // Permutation between snapshots: before vs after
  after.target.postgres.mounts.reverse();
  after.source.postgres.mounts.reverse();
  after.job.mounts.reverse();
  expect(inspectPromotionHostSamples({ before: f.snapshot, after }, f.options)).toEqual(
    f.options.expectedHost,
  );
});

test.each([
  [
    'changed mount source within sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[0];
      if (m) m.source = '/synthetic/other';
    },
  ],
  [
    'changed mount destination within sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[0];
      if (m) m.destination = '/var/lib/other';
    },
  ],
  [
    'changed mount type within sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[0];
      if (m) m.type = 'bind';
    },
  ],
  [
    'changed mount name within sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[0];
      if (m) m.name = 'other-volume';
    },
  ],
  [
    'changed mount readWrite within sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[0];
      if (m) m.readWrite = !m.readWrite;
    },
  ],
  [
    'changed mount propagation within sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[1];
      if (m) m.propagation = '';
    },
  ],
  [
    'extra mount within sample',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.target.terminal.mounts.push({
        type: 'bind',
        name: '',
        source: '/synthetic/secrets/restore/restore-keyring',
        destination: '/run/secrets/restore-keyring',
        readWrite: false,
        propagation: 'rprivate',
      });
    },
  ],
  [
    'missing mount within sample',
    (f: ReturnType<typeof fixture>) => {
      f.snapshot.target.terminal.mounts.pop();
    },
  ],
  [
    'duplicate mount within initial sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.postgres.mounts[0];
      if (m) f.snapshot.target.postgres.mounts.push(structuredClone(m));
    },
  ],
  [
    'duplicate mount within terminal sample',
    (f: ReturnType<typeof fixture>) => {
      const m = f.snapshot.target.terminal.mounts[0];
      if (m) f.snapshot.target.terminal.mounts.push(structuredClone(m));
    },
  ],
  [
    'reordered job command arguments between samples',
    (_f: ReturnType<typeof fixture>, after: ReturnType<typeof fixture>['snapshot']) => {
      after.job.command.reverse();
    },
  ],
  [
    'reordered job execution flags between samples',
    (_f: ReturnType<typeof fixture>, after: ReturnType<typeof fixture>['snapshot']) => {
      after.job.executionFlags.reverse();
    },
  ],
  [
    'reordered job entrypoint arguments between samples',
    (_f: ReturnType<typeof fixture>, after: ReturnType<typeof fixture>['snapshot']) => {
      after.job.entrypoint.reverse();
    },
  ],
])('refuses %s', (_name, mutate) => {
  const f = fixture();
  const after = structuredClone(f.snapshot);
  mutate(f, after);
  expect(() => inspectPromotionHostSamples({ before: f.snapshot, after }, f.options)).toThrow(
    /^promotion_host_invalid$/u,
  );
});

test.each(['source', 'target'] as const)('requires the %s terminal observation', (side) => {
  const f = fixture();
  Reflect.deleteProperty(f.snapshot[side], 'terminal');
  expect(() => inspect(f)).toThrow(/^promotion_host_invalid$/u);
});
