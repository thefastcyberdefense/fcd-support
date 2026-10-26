import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { parseRestoreCommand } from '../src/operations/restore-command.js';
import { runRestoreCommand } from '../src/operations/restore-main.js';
import type { RestoreEvidence, RestoreOptions } from '../src/operations/restore.js';
import { operationApplicationName } from '../src/operations/operation-reference.js';

// All metadata is intentionally authored for this isolated synthetic fixture.
function syntheticRestoreTarget() {
  return {
    projectName: 'fcd-support-restore-synthetic',
    volumeName: 'fcd-support-restore-synthetic-data',
    volumeCreatedAt: '2030-01-01T00:00:00.000Z',
    networkId: 'a'.repeat(64),
    postgresImageId: `sha256:${'b'.repeat(64)}`,
    runtimeImageId: `sha256:${'c'.repeat(64)}`,
    systemIdentifier: '7300000000000000001',
    databaseName: 'fcd_support_test',
    schema: 'public',
    gitRevision: 'd'.repeat(40),
    schemaRevision: '000016',
  };
}

function syntheticRestoreArgs() {
  return [
    'restore',
    `restore_${'a'.repeat(32)}`,
    `backup_${'b'.repeat(32)}`,
    `checkpoint_${'c'.repeat(32)}`,
    Buffer.from(JSON.stringify(syntheticRestoreTarget())).toString('base64'),
  ];
}

test('restore parser binds known refs to canonical bounded host and SQL target metadata', () => {
  const { gitRevision, schemaRevision, ...target } = syntheticRestoreTarget();
  expect(parseRestoreCommand(syntheticRestoreArgs())).toEqual({
    job: 'restore',
    restoreRef: `restore_${'a'.repeat(32)}`,
    backupRef: `backup_${'b'.repeat(32)}`,
    checkpointRef: `checkpoint_${'c'.repeat(32)}`,
    target,
    gitRevision,
    schemaRevision,
  });
});

const sourceIdentifier = '7300000000000000000';
const at = new Date('2030-01-01T00:00:01.000Z');
function commandFixture() {
  const events: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const configurations: pg.PoolConfig[] = [];
  const environment: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
    OPS_OPERATION_REFERENCE: `operation_${'e'.repeat(32)}`,
    OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: sourceIdentifier,
    OPS_SOURCE_DATABASE_NAME: 'fcd_support_test',
    OPS_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
    OPS_GIT_REVISION: 'd'.repeat(40),
    OPS_SCHEMA_REVISION: '000016',
    OPS_DATABASE_SCHEMA: 'public',
    RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
    RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
    RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE: '/run/secrets/synthetic-source-checkpoint',
    RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE: '/run/secrets/synthetic-source-archive',
    RESTORE_TARGET_OWNER_DATABASE_URL_FILE: '/run/secrets/synthetic-target-owner',
    RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE: '/run/secrets/synthetic-target-migrator',
    PRIVACY_HMAC_KEYRING_FILE: '/run/secrets/synthetic-keyring',
    RECOVERY_MANIFEST_HMAC_FILE: '/run/secrets/synthetic-hmac',
    BACKUP_AGE_IDENTITY_FILE: '/run/secrets/synthetic-age',
    RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY: '/run/secrets',
    BACKUP_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/backups',
    CHECKPOINT_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/checkpoints',
    BACKUP_TMPFS_DIRECTORY: '/run/fcd-support',
    OPS_MAX_CALL_MS: '20000',
    CHECKPOINT_MAX_AGE_MS: '60000',
    CHECKPOINT_MAX_ROWS: '1000',
    CHECKPOINT_MAX_PAYLOAD_BYTES: '1048576',
    RESTORE_BATCH_LIMIT: '50',
    RESTORE_MAX_BATCHES: '20',
  };
  const hmac = Buffer.from('synthetic_restore_manifest_key_material_0001');
  const material = {
    checkpointRef: `checkpoint_${'c'.repeat(32)}`,
    sourceRevision: 'd'.repeat(40),
    schemaRevision: '000016',
    snapshotAt: '2030-01-01T00:00:00.000Z',
    validUntil: null,
    watermark: { sourceEpoch: '00000000-0000-4000-8000-000000000001', sequence: '0' },
    rowCount: 0,
    requiredKeyVersions: [],
    ciphertextBytes: 1,
    ciphertextSha256: 'f'.repeat(64),
  };
  const checkpoint = {
    ...material,
    signature: createHmac('sha256', hmac)
      .update('fcd-support:deletion-checkpoint:v1\n')
      .update(JSON.stringify(material))
      .digest('hex'),
  };
  const files: Record<string, string> = {
    '/run/secrets/synthetic-source-checkpoint':
      'postgresql://fcd_synthetic_checkpoint:synthetic_checkpoint@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-source-archive':
      'postgresql://fcd_synthetic_backup:synthetic_archive@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-target-owner':
      'postgresql://postgres:synthetic_owner@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-target-migrator':
      'postgresql://fcd_synthetic_migrator:synthetic_migrator@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-keyring': JSON.stringify({
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: Buffer.alloc(32, 3).toString('base64url') }],
    }),
    '/run/secrets/synthetic-hmac': hmac.toString(),
    [`/var/lib/fcd-support/checkpoints/${material.checkpointRef}/manifest.json`]:
      JSON.stringify(checkpoint),
  };
  const pools: SyntheticRestorePool[] = [];
  const restored = vi.fn(async (options: RestoreOptions): Promise<RestoreEvidence> => {
    events.push('restore');
    await options.migration?.prepare();
    events.push('migrate');
    await options.migration?.converge();
    return {
      restoreRef: options.restoreRef,
      backupRef: options.backupRef,
      checkpointRef: options.checkpoint.checkpointRef,
      gitRevision: options.gitRevision,
      schemaRevision: options.expectedSchemaRevision,
      target: options.target,
      sourceSystemIdentifier: sourceIdentifier,
      sourceWatermark: material.watermark,
      requiredKeyVersions: ['synthetic-v1'],
      gateRef: `gate_${'f'.repeat(32)}`,
      recordedAt: at,
      recoveryHeldAtSeal: true,
      status: 'deletion_verified',
      quarantined: 0,
      erasedIdentities: 0,
      batches: 1,
    };
  });
  const grants = vi.fn(async (pool: pg.Pool, options: { phase?: string }) => {
    const owner = await pool.connect();
    try {
      events.push(`grants:${options.phase ?? 'missing'}`);
    } finally {
      owner.release(true);
    }
  });
  const allocated: Uint8Array[] = [];
  const options = {
    args: syntheticRestoreArgs(),
    environment,
    now: () => at,
    verifyPasswordDirectory: () => Promise.resolve(),
    readSecret: (path: string) => {
      const value = files[path];
      if (value === undefined) throw new Error('synthetic_unexpected_file');
      const bytes = Buffer.from(value);
      allocated.push(bytes);
      return Promise.resolve(bytes);
    },
    createPool: (config: pg.PoolConfig) => {
      configurations.push(config);
      const pool = new SyntheticRestorePool(config, events);
      pools.push(pool);
      return pool as unknown as pg.Pool;
    },
    restore: restored,
    configureGrants: grants,
    write: (line: string) => {
      events.push('stdout');
      output.push(line);
    },
    error: (line: string) => errors.push(line),
  };
  return {
    options,
    events,
    output,
    errors,
    configurations,
    pools,
    restored,
    grants,
    allocated,
    files,
  };
}

class SyntheticRestorePool extends EventEmitter {
  public closed = false;
  public actualIdentifier: string;
  public principal: string;
  public closeFailure = false;
  public privileged = false;
  public memberships = false;
  public readOnly = true;
  public connects = 0;
  public substituteOnConnect: number | undefined;
  public constructor(
    public readonly config: pg.PoolConfig,
    private readonly events: string[],
  ) {
    super();
    this.principal = decodeURIComponent(new URL(config.connectionString ?? '').username);
    this.actualIdentifier =
      this.principal.endsWith('_checkpoint') || this.principal.endsWith('_backup')
        ? sourceIdentifier
        : syntheticRestoreTarget().systemIdentifier;
  }
  public async connect() {
    this.connects++;
    if (this.connects === this.substituteOnConnect) this.actualIdentifier = sourceIdentifier;
    const client = new EventEmitter();
    const connection = Object.assign(client, {
      query: (sql: string) => this.query(sql),
      release: () => this.events.push(`release:${this.principal}`),
    });
    this.emit('connect', connection);
    return Promise.resolve(connection);
  }
  public query(sql: string) {
    if (sql.includes('pg_control_system'))
      return Promise.resolve({ rows: [{ id: this.actualIdentifier, name: 'fcd_support_test' }] });
    if (sql.includes('pg_roles'))
      return Promise.resolve({
        rows: [
          {
            name: this.principal,
            session: this.principal,
            privileged: this.principal === 'postgres' || this.privileged,
            memberships: this.memberships,
            read_only:
              this.config.options?.includes('default_transaction_read_only=on') === true &&
              this.readOnly,
          },
        ],
      });
    if (sql.includes('deletion_checkpoint_clock'))
      return Promise.resolve({
        rows: [{ source_epoch: '00000000-0000-4000-8000-000000000001', revision: '0' }],
      });
    throw new Error('synthetic_unexpected_sql');
  }
  public end() {
    this.events.push(`close:${this.principal}`);
    this.closed = true;
    return this.closeFailure
      ? Promise.reject(new Error('synthetic_close_secret'))
      : Promise.resolve();
  }
}

test('restore driver isolates capabilities, binds every pool and stream URI, then acknowledges after close', async () => {
  const fixture = commandFixture();
  expect(await runRestoreCommand(fixture.options)).toBe(0);
  expect(fixture.configurations).toHaveLength(4);
  const expectedUsers = [
    'fcd_synthetic_checkpoint',
    'fcd_synthetic_backup',
    'postgres',
    'fcd_synthetic_migrator',
  ];
  for (const [index, config] of fixture.configurations.entries()) {
    const uri = new URL(config.connectionString ?? '');
    expect(decodeURIComponent(uri.username)).toBe(expectedUsers[index]);
    expect(uri.hostname).toBe(
      index < 2 ? 'fcd-support-source-postgres' : 'fcd-support-restore-postgres',
    );
    expect(config.application_name).toBe(
      operationApplicationName(fixture.options.environment.OPS_OPERATION_REFERENCE ?? ''),
    );
    expect(config.options).toContain(`application_name=${config.application_name ?? ''}`);
    expect(config.options?.includes('default_transaction_read_only=on')).toBe(index < 2);
    expect(config.max).toBe(1);
    expect(config.connectionTimeoutMillis).toBe(20000);
  }
  const call = fixture.restored.mock.calls[0]?.[0];
  expect(call?.sourcePool).toBe(fixture.pools[0]);
  expect(call?.archiveSourcePool).toBe(fixture.pools[1]);
  expect(call?.targetPool).toBe(fixture.pools[2]);
  expect(call?.migration?.pool).toBe(fixture.pools[3]);
  expect(call?.migration?.roleName).toBe('fcd_synthetic_migrator');
  expect(call?.expectedSourceDatabaseIdentity).toEqual({
    systemIdentifier: sourceIdentifier,
    databaseName: 'fcd_support_test',
  });
  expect(new URL(call?.targetConnectionString ?? '').searchParams.get('application_name')).toBe(
    fixture.configurations[0]?.application_name,
  );
  expect(call?.batchLimit).toBe(50);
  expect(call?.maximumBatches).toBe(20);
  expect(call?.maximumCheckpointAgeMilliseconds).toBe(60000);
  expect(call?.maximumCheckpointRows).toBe(1000);
  expect(call?.maximumCheckpointPayloadBytes).toBe(1048576);
  expect(fixture.grants.mock.calls.map((args) => args[1].phase)).toEqual(['prepare', 'converge']);
  expect(fixture.events.indexOf('grants:prepare')).toBeLessThan(fixture.events.indexOf('migrate'));
  expect(fixture.events.indexOf('grants:converge')).toBeGreaterThan(
    fixture.events.indexOf('migrate'),
  );
  expect(fixture.events.at(-1)).toBe('stdout');
  expect(fixture.pools.every((pool) => pool.closed)).toBe(true);
  expect(fixture.allocated.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  expect(fixture.output).toEqual(['{"status":"completed","processed":1,"reasonCode":"ok"}\n']);
  expect(fixture.errors).toEqual([]);
});

test('restore rejects untrusted settings and credentials before any pool exists', async () => {
  const mutations: ((f: ReturnType<typeof commandFixture>) => void)[] = [
    (f) => {
      delete f.options.environment.OPS_OPERATION_REFERENCE;
    },
    (f) => {
      delete f.options.environment.OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER;
    },
    (f) => {
      f.options.environment.OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER =
        syntheticRestoreTarget().systemIdentifier;
    },
    (f) => {
      f.options.environment.OPS_SOURCE_DATABASE_NAME = 'fcd_support_wrong';
    },
    (f) => {
      f.options.environment.RESTORE_SOURCE_SERVICE_ALIAS = 'example.invalid';
    },
    (f) => {
      f.options.environment.RESTORE_TARGET_SERVICE_ALIAS = 'postgres';
    },
    (f) => {
      f.options.environment.OPS_GIT_REVISION = 'e'.repeat(40);
    },
    (f) => {
      f.options.environment.MODEL_EXECUTION_ENABLED = 'true';
    },
    (f) => {
      f.options.environment.DATABASE_URL = 'synthetic_disallowed_secret';
    },
    (f) => {
      f.options.environment.META_APP_SECRET_FILE = '/run/secrets/synthetic_unrelated';
    },
    (f) => {
      f.options.environment.RESTORE_BATCH_LIMIT = '1001';
    },
    (f) => {
      f.options.environment.RESTORE_MAX_BATCHES = '0';
    },
    (f) => {
      f.options.environment.OPS_MAX_CALL_MS = '300001';
    },
    (f) => {
      f.options.environment.CHECKPOINT_MAX_AGE_MS = '0';
    },
    (f) => {
      f.options.environment.CHECKPOINT_MAX_ROWS = '2147483648';
    },
    (f) => {
      f.options.environment.CHECKPOINT_MAX_PAYLOAD_BYTES = '9007199254740992';
    },
    (f) => {
      f.options.environment.BACKUP_TMPFS_DIRECTORY = '/run/../tmp';
    },
    (f) => {
      f.files['/run/secrets/synthetic-source-checkpoint'] =
        'postgresql://postgres:synthetic_wrong@127.0.0.1/fcd_support_test';
    },
    (f) => {
      f.files['/run/secrets/synthetic-source-archive'] =
        `${f.files['/run/secrets/synthetic-source-archive'] ?? ''}?options=-c%20role%3Dpostgres`;
    },
    (f) => {
      f.files['/run/secrets/synthetic-target-owner'] =
        `${f.files['/run/secrets/synthetic-target-owner'] ?? ''}?host=example.invalid`;
    },
    (f) => {
      f.files['/run/secrets/synthetic-target-migrator'] =
        'postgresql://fcd_synthetic_migrator:synthetic_wrong@127.0.0.1/fcd_support_other';
    },
    (f) => {
      f.files['/run/secrets/synthetic-target-owner'] =
        'postgresql://postgres:synthetic_wrong@127.0.0.1:6000/fcd_support_test';
    },
    (f) => {
      f.files['/run/secrets/synthetic-hmac'] = 'synthetic_short';
    },
    (f) => {
      f.files['/run/secrets/synthetic-target-owner'] =
        `\uFEFF${f.files['/run/secrets/synthetic-target-owner'] ?? ''}`;
    },
  ];
  for (const mutate of mutations) {
    const fixture = commandFixture();
    mutate(fixture);
    expect(await runRestoreCommand(fixture.options)).toBe(1);
    expect(fixture.configurations).toEqual([]);
    expect(fixture.restored).not.toHaveBeenCalled();
    expect(fixture.output).toEqual([]);
    expect(fixture.errors).toEqual(['restore_command_failed\n']);
  }
});

test('restore physical source, archive, owner and migrator substitutions refuse and close all pools', async () => {
  for (const altered of [0, 1, 2, 3]) {
    const fixture = commandFixture();
    const original = fixture.options.createPool;
    fixture.options.createPool = (config) => {
      const pool = original(config);
      const changed = fixture.pools[altered];
      if (fixture.pools.length === altered + 1 && changed)
        changed.actualIdentifier = '7300000000000000099';
      return pool;
    };
    expect(await runRestoreCommand(fixture.options)).toBe(1);
    expect(fixture.pools.every((pool) => pool.closed)).toBe(true);
    if (altered < 3) expect(fixture.restored).not.toHaveBeenCalled();
    expect(fixture.output).toEqual([]);
    expect(fixture.errors).toEqual(['restore_command_failed\n']);
  }
});

test('restore failure, asynchronous database errors and ambiguous pool shutdown never acknowledge', async () => {
  for (const mode of ['restore', 'pool', 'client', 'close'] as const) {
    const fixture = commandFixture();
    const originalRestore = fixture.options.restore;
    fixture.options.restore = vi.fn(async (options: RestoreOptions) => {
      if (mode === 'restore') throw new Error('synthetic_external_secret_error');
      const evidence = await originalRestore(options);
      if (mode === 'pool') fixture.pools[0]?.emit('error', new Error('synthetic_pool_secret'));
      if (mode === 'client') {
        const client = await options.targetPool.connect();
        client.emit('error', new Error('synthetic_client_secret'));
        client.release(true);
      }
      const closing = fixture.pools[1];
      if (mode === 'close' && closing) closing.closeFailure = true;
      return evidence;
    });
    expect(await runRestoreCommand(fixture.options)).toBe(1);
    expect(fixture.output).toEqual([]);
    expect(fixture.errors).toEqual(['restore_command_failed\n']);
    expect(fixture.pools.every((pool) => pool.closed)).toBe(true);
  }
});

test('restore refuses a wrong checkpoint reference or stale signed checkpoint without streaming', async () => {
  for (const mode of ['wrong-reference', 'stale'] as const) {
    const fixture = commandFixture();
    if (mode === 'wrong-reference') fixture.options.args[3] = `checkpoint_${'d'.repeat(32)}`;
    else fixture.options.environment.CHECKPOINT_MAX_AGE_MS = '1';
    expect(await runRestoreCommand(fixture.options)).toBe(1);
    expect(fixture.restored).not.toHaveBeenCalled();
    expect(fixture.output).toEqual([]);
    expect(fixture.errors).toEqual(['restore_command_failed\n']);
  }
});

test('source login, privilege, membership and read-only mismatches refuse before streaming', async () => {
  for (const mode of ['login', 'privileged', 'membership', 'read-only'] as const) {
    const fixture = commandFixture();
    const create = fixture.options.createPool;
    fixture.options.createPool = (configuration) => {
      const pool = create(configuration);
      const source = fixture.pools[0];
      if (fixture.pools.length === 1 && source) {
        if (mode === 'login') source.principal = 'synthetic_unexpected_login';
        if (mode === 'privileged') source.privileged = true;
        if (mode === 'membership') source.memberships = true;
        if (mode === 'read-only') source.readOnly = false;
      }
      return pool;
    };
    expect(await runRestoreCommand(fixture.options)).toBe(1);
    expect(fixture.restored).not.toHaveBeenCalled();
    expect(fixture.pools.every((pool) => pool.closed)).toBe(true);
    expect(fixture.output).toEqual([]);
    expect(fixture.errors).toEqual(['restore_command_failed\n']);
  }
});

test('grants failure prevents restricted migration and final convergence', async () => {
  const fixture = commandFixture();
  fixture.options.configureGrants = vi.fn(() =>
    Promise.reject(new Error('synthetic_grant_secret')),
  );
  expect(await runRestoreCommand(fixture.options)).toBe(1);
  expect(fixture.events).not.toContain('migrate');
  expect(fixture.events).not.toContain('grants:converge');
  expect(fixture.pools.every((pool) => pool.closed)).toBe(true);
  expect(fixture.output).toEqual([]);
  expect(fixture.errors).toEqual(['restore_command_failed\n']);
});

test('grant-owning connections verify physical identity before any owner grant runs', async () => {
  const fixture = commandFixture();
  const create = fixture.options.createPool;
  fixture.options.createPool = (configuration) => {
    const pool = create(configuration);
    const owner = fixture.pools[2];
    if (fixture.pools.length === 3 && owner) owner.substituteOnConnect = 3;
    return pool;
  };
  expect(await runRestoreCommand(fixture.options)).toBe(1);
  expect(fixture.events).not.toContain('grants:prepare');
  expect(fixture.events).not.toContain('migrate');
  expect(fixture.pools.every((pool) => pool.closed)).toBe(true);
  expect(fixture.output).toEqual([]);
  expect(fixture.errors).toEqual(['restore_command_failed\n']);
});

test('a stalled pool shutdown is bounded and cannot produce a successful acknowledgement', async () => {
  vi.useFakeTimers();
  try {
    const fixture = commandFixture();
    fixture.options.environment.OPS_MAX_CALL_MS = '10';
    const restore = fixture.options.restore;
    fixture.options.restore = vi.fn(async (options: RestoreOptions) => {
      const evidence = await restore(options);
      const closing = fixture.pools[0];
      if (!closing) throw new Error('synthetic_missing_pool');
      closing.end = () =>
        new Promise<void>(() => {
          /* Synthetic stalled close. */
        });
      return evidence;
    });
    const running = runRestoreCommand(fixture.options);
    await vi.runAllTimersAsync();
    expect(await running).toBe(1);
    expect(fixture.output).toEqual([]);
    expect(fixture.errors).toEqual(['restore_command_failed\n']);
  } finally {
    vi.useRealTimers();
  }
});

test('restore parser refuses missing refs, promotion, trailing arguments and noncanonical metadata', () => {
  const args = syntheticRestoreArgs();
  const target = syntheticRestoreTarget();
  const invalid = [
    [],
    args.slice(0, -1),
    [...args, 'synthetic_extra'],
    ['promote', ...args.slice(1)],
    [args[0], 'restore_invalid', ...args.slice(2)],
    [args[0], args[1], 'backup_invalid', ...args.slice(3)],
    [args[0], args[1], args[2], 'checkpoint_invalid', args[4]],
    [...args.slice(0, 4), '%%%'],
    [...args.slice(0, 4), `${args[4] ?? ''}\n`],
    [...args.slice(0, 4), Buffer.from(JSON.stringify(target, null, 2)).toString('base64')],
    [...args.slice(0, 4), Buffer.from(`\uFEFF${JSON.stringify(target)}`).toString('base64')],
    [
      ...args.slice(0, 4),
      Buffer.from(JSON.stringify({ ...target, ready: true })).toString('base64'),
    ],
    [...args.slice(0, 4), Buffer.from(' '.repeat(4097)).toString('base64')],
    [
      ...args.slice(0, 4),
      Buffer.from(JSON.stringify({ ...target, systemIdentifier: '0' })).toString('base64'),
    ],
    [
      ...args.slice(0, 4),
      Buffer.from(JSON.stringify({ ...target, gitRevision: 'synthetic_invalid' })).toString(
        'base64',
      ),
    ],
  ];
  for (const input of invalid)
    expect(() => parseRestoreCommand(input as string[])).toThrow('restore_command_invalid');
});
