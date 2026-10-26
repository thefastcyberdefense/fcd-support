import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { runRestoreStreamCommand } from '../src/operations/restore-stream-main.js';
import { runRestoreReconcileCommand } from '../src/operations/restore-reconcile-main.js';
import type { EncryptedRestoreOptions, ReconciliationOptions } from '../src/operations/restore.js';

// Intentionally authored metadata and nonfunctional credentials for isolated tests.
const sourceIdentifier = '7300000000000000000';
const target = {
  projectName: 'fcd-support-restore-synthetic',
  volumeName: 'fcd-support-restore-synthetic-data',
  volumeCreatedAt: '2030-01-01T00:00:00.000Z',
  networkId: 'a'.repeat(64),
  postgresImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageId: `sha256:${'c'.repeat(64)}`,
  systemIdentifier: '7300000000000000001',
  databaseName: 'fcd_support_test',
  schema: 'public',
};
const gitRevision = 'd'.repeat(40);
const restoreRef = `restore_${'a'.repeat(32)}`;
const backupRef = `backup_${'b'.repeat(32)}`;
const checkpointRef = `checkpoint_${'c'.repeat(32)}`;
const at = new Date('2030-01-01T00:00:01.000Z');

class SyntheticPool extends EventEmitter {
  public identifier: string;
  public closed = false;
  public closeFailure = false;
  public connects = 0;
  public substituteAt: number | undefined;
  public revision = '000016';
  public principal: string;
  public privileged = false;
  public readOnly = true;
  public constructor(
    public readonly config: pg.PoolConfig,
    private readonly events: string[],
  ) {
    super();
    this.principal = new URL(config.connectionString ?? '').username;
    this.identifier = this.principal === 'postgres' ? target.systemIdentifier : sourceIdentifier;
  }
  public connect() {
    this.connects++;
    const client = Object.assign(new EventEmitter(), {
      query: (sql: string) => {
        if (sql.includes('pg_control_system'))
          return Promise.resolve({
            rows: [
              {
                id: this.connects === this.substituteAt ? '7300000000000000099' : this.identifier,
                name: target.databaseName,
              },
            ],
          });
        if (sql.includes('pg_roles'))
          return Promise.resolve({
            rows: [
              {
                name: this.principal,
                session: this.principal,
                privileged: this.privileged,
                memberships: false,
                read_only:
                  this.readOnly &&
                  this.config.options?.includes('default_transaction_read_only=on'),
              },
            ],
          });
        if (sql.includes('deletion_checkpoint_clock'))
          return Promise.resolve({
            rows: [{ source_epoch: '00000000-0000-4000-8000-000000000001', revision: '0' }],
          });
        if (sql.includes('pgmigrations'))
          return Promise.resolve({ rows: [{ name: `${this.revision}_synthetic` }] });
        throw new Error('synthetic_unexpected_query');
      },
      release: () => this.events.push('release'),
    });
    this.emit('connect', client);
    return Promise.resolve(client);
  }
  public end() {
    this.closed = true;
    this.events.push('close');
    return this.closeFailure
      ? Promise.reject(new Error('synthetic_close_secret'))
      : Promise.resolve();
  }
}

function fixture(job: 'stream' | 'reconcile') {
  const output: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const pools: SyntheticPool[] = [];
  const allocated: Uint8Array[] = [];
  const reads: string[] = [];
  const environment: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
    OPS_OPERATION_REFERENCE: `operation_${'e'.repeat(32)}`,
    OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: sourceIdentifier,
    OPS_SOURCE_DATABASE_NAME: target.databaseName,
    OPS_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
    OPS_GIT_REVISION: gitRevision,
    OPS_SCHEMA_REVISION: '000016',
    OPS_DATABASE_SCHEMA: 'public',
    RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
    RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
    RESTORE_TARGET_OWNER_DATABASE_URL_FILE: '/run/secrets/synthetic-owner',
    RECOVERY_MANIFEST_HMAC_FILE: '/run/secrets/synthetic-hmac',
    BACKUP_AGE_IDENTITY_FILE: '/run/secrets/synthetic-age',
    OPS_MAX_CALL_MS: '20000',
  };
  if (job === 'stream')
    Object.assign(environment, {
      RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE: '/run/secrets/synthetic-archive-reader',
      BACKUP_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/backups',
      BACKUP_TMPFS_DIRECTORY: '/run/fcd-support',
    });
  else
    Object.assign(environment, {
      RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE: '/run/secrets/synthetic-checkpoint',
      PRIVACY_HMAC_KEYRING_FILE: '/run/secrets/synthetic-keyring',
      CHECKPOINT_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/checkpoints',
      CHECKPOINT_MAX_AGE_MS: '60000',
      CHECKPOINT_MAX_ROWS: '1000',
      CHECKPOINT_MAX_PAYLOAD_BYTES: '1048576',
      RESTORE_BATCH_LIMIT: '50',
      RESTORE_MAX_BATCHES: '20',
    });
  const hmac = Buffer.from('synthetic_restore_manifest_key_material_0001');
  const material = {
    checkpointRef,
    sourceRevision: gitRevision,
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
    '/run/secrets/synthetic-archive-reader':
      'postgresql://fcd_synthetic_archive_reader:synthetic_archive@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-checkpoint':
      'postgresql://fcd_synthetic_checkpoint:synthetic_checkpoint@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-owner':
      'postgresql://postgres:synthetic_owner@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-hmac': hmac.toString(),
    '/run/secrets/synthetic-keyring': JSON.stringify({
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: Buffer.alloc(32, 3).toString('base64url') }],
    }),
    [`/var/lib/fcd-support/checkpoints/${checkpointRef}/manifest.json`]: JSON.stringify(checkpoint),
  };
  const common = {
    args: [
      'restore',
      restoreRef,
      backupRef,
      checkpointRef,
      Buffer.from(JSON.stringify({ ...target, gitRevision, schemaRevision: '000016' })).toString(
        'base64',
      ),
    ],
    environment,
    now: () => at,
    readSecret: (path: string) => {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw new Error('synthetic_unexpected_read');
      const bytes = Buffer.from(text);
      allocated.push(bytes);
      return Promise.resolve(bytes);
    },
    createPool: (config: pg.PoolConfig) => {
      const pool = new SyntheticPool(config, events);
      pools.push(pool);
      return pool as unknown as pg.Pool;
    },
    write: (line: string) => {
      events.push('stdout');
      output.push(line);
    },
    error: (line: string) => {
      errors.push(line);
    },
  };
  const restore = vi.fn(async (options: EncryptedRestoreOptions) => {
    events.push('stream');
    const client = await options.sourcePool.connect();
    client.release(true);
    return {
      status: 'restored' as const,
      backupRef: options.backupRef,
      schemaRevision: '000001',
      sourceSystemIdentifier: sourceIdentifier,
      targetSystemIdentifier: target.systemIdentifier,
    };
  });
  const reconcile = vi.fn(async (options: ReconciliationOptions) => {
    events.push('reconcile');
    for (const pool of [options.sourcePool, options.targetPool]) {
      const client = await pool.connect();
      client.release(true);
    }
    return {
      status: 'deletion_verified' as const,
      restoreRef: options.restoreRef,
      backupRef: options.backupRef ?? '',
      checkpointRef: options.checkpoint.checkpointRef,
      gitRevision: options.gitRevision,
      schemaRevision: options.expectedSchemaRevision,
      target: options.target,
      sourceSystemIdentifier: sourceIdentifier,
      sourceWatermark: material.watermark,
      requiredKeyVersions: ['synthetic-v1'],
      gateRef: `gate_${'f'.repeat(32)}`,
      recordedAt: at,
      recoveryHeldAtSeal: true as const,
      quarantined: 0,
      erasedIdentities: 0,
      batches: 1,
    };
  });
  return { common, restore, reconcile, files, output, errors, events, pools, reads, allocated };
}

const completed = '{"status":"completed","processed":1,"reasonCode":"ok"}\n';

test('stream leg accepts metadata-only archive reader and target owner without checkpoint or bootstrap authority', async () => {
  const f = fixture('stream');
  Object.assign(f.common.environment, {
    PG_MAJOR: '18',
    PG_VERSION: '18.4-1.pgdg13+1',
    PGDATA: '/var/lib/postgresql/18/docker',
  });
  expect(await runRestoreStreamCommand({ ...f.common, restore: f.restore })).toBe(0);
  expect(f.pools.map((pool) => pool.principal)).toEqual([
    'fcd_synthetic_archive_reader',
    'postgres',
  ]);
  expect(f.pools.map((pool) => new URL(pool.config.connectionString ?? '').hostname)).toEqual([
    'fcd-support-source-postgres',
    'fcd-support-restore-postgres',
  ]);
  expect(f.pools[0]?.config.options).toContain('default_transaction_read_only=on');
  const call = f.restore.mock.calls[0]?.[0];
  expect(call?.expectedSourceDatabaseIdentity).toEqual({
    systemIdentifier: sourceIdentifier,
    databaseName: target.databaseName,
  });
  expect(call?.expectedTargetSystemIdentifier).toBe(target.systemIdentifier);
  expect(call?.timeoutMilliseconds).toBe(20000);
  expect(call?.archiveDirectory).toBe('/var/lib/fcd-support/backups');
  expect(new URL(call?.targetConnectionString ?? '').searchParams.get('application_name')).toBe(
    `fcd-support:operation_${'e'.repeat(32)}`,
  );
  expect(f.events.at(-1)).toBe('stdout');
  expect(f.pools.every((pool) => pool.closed)).toBe(true);
  expect(f.allocated.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  expect(f.output).toEqual([completed]);
  expect(f.errors).toEqual([]);
});

test('reconciliation leg validates current checkpoint and revision then binds only checkpoint and owner sessions', async () => {
  const f = fixture('reconcile');
  Object.assign(f.common.environment, {
    PG_MAJOR: '18',
    PG_VERSION: '18.4-1.pgdg13+1',
    PGDATA: '/var/lib/postgresql/18/docker',
  });
  expect(await runRestoreReconcileCommand({ ...f.common, reconcile: f.reconcile })).toBe(0);
  expect(f.pools.map((pool) => pool.principal)).toEqual(['fcd_synthetic_checkpoint', 'postgres']);
  const call = f.reconcile.mock.calls[0]?.[0];
  expect(call?.backupRef).toBe(backupRef);
  expect(call?.checkpoint.checkpointRef).toBe(checkpointRef);
  expect(call?.expectedSourceDatabaseIdentity).toEqual({
    systemIdentifier: sourceIdentifier,
    databaseName: target.databaseName,
  });
  expect(call?.checkpointArchiveFile).toBe(
    `/var/lib/fcd-support/checkpoints/${checkpointRef}/archive.age`,
  );
  expect(call?.batchLimit).toBe(50);
  expect(call?.maximumBatches).toBe(20);
  expect(call?.maximumCheckpointRows).toBe(1000);
  expect(call?.maximumCheckpointPayloadBytes).toBe(1048576);
  expect(f.events.at(-1)).toBe('stdout');
  expect(f.pools.every((pool) => pool.closed)).toBe(true);
  expect(f.allocated.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  expect(f.output).toEqual([completed]);
  expect(f.errors).toEqual([]);
});

for (const job of ['stream', 'reconcile'] as const) {
  const run = (f: ReturnType<typeof fixture>) =>
    job === 'stream'
      ? runRestoreStreamCommand({ ...f.common, restore: f.restore })
      : runRestoreReconcileCommand({ ...f.common, reconcile: f.reconcile });
  test(`${job} refuses surplus secret capabilities, enabled execution and unbounded settings before reads`, async () => {
    for (const [name, value] of [
      ['RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY', '/run/secrets'],
      ['RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE', '/run/secrets/synthetic-migrator'],
      ['META_APP_SECRET_FILE', '/run/secrets/synthetic-meta'],
      ['PGPASSWORD', 'synthetic_wrong'],
      ['MODEL_EXECUTION_ENABLED', 'true'],
      ['OPS_MAX_CALL_MS', '300001'],
      ['OPS_OPERATION_REFERENCE', 'synthetic_invalid'],
      ['RESTORE_SOURCE_SERVICE_ALIAS', 'postgres'],
      ['OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER', target.systemIdentifier],
      ['OPS_SCHEMA_REVISION', '000001'],
      [
        job === 'stream'
          ? 'RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE'
          : 'RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE',
        '/run/secrets/synthetic-other',
      ],
      [
        job === 'stream' ? 'PRIVACY_HMAC_KEYRING_FILE' : 'CHECKPOINT_MAX_ROWS',
        job === 'stream' ? '/run/secrets/synthetic-keyring' : '0',
      ],
    ]) {
      const f = fixture(job);
      f.common.environment[name ?? ''] = value;
      expect(await run(f)).toBe(1);
      expect(f.pools).toEqual([]);
      expect(f.reads).toEqual([]);
      expect(f.output).toEqual([]);
      expect(f.errors).toEqual([`restore_${job}_command_failed\n`]);
    }
  });
  test(`${job} refuses wrong source roles and physical substitutions without completion`, async () => {
    for (const mode of ['role', 'source', 'target', 'owning-source', 'owning-target'] as const) {
      if (job === 'stream' && mode === 'owning-target') continue;
      const f = fixture(job);
      if (mode === 'role')
        f.files[
          job === 'stream'
            ? '/run/secrets/synthetic-archive-reader'
            : '/run/secrets/synthetic-checkpoint'
        ] = 'postgresql://postgres:synthetic_wrong@127.0.0.1/fcd_support_test';
      const create = f.common.createPool;
      f.common.createPool = (config) => {
        const pool = create(config);
        const index = f.pools.length - 1;
        const changed = f.pools[index];
        if (changed && ((mode === 'source' && index === 0) || (mode === 'target' && index === 1)))
          changed.identifier = '7300000000000000099';
        if (changed && mode === 'owning-source' && index === 0)
          changed.substituteAt = job === 'stream' ? 2 : 3;
        if (changed && mode === 'owning-target' && index === 1) changed.substituteAt = 3;
        return pool;
      };
      expect(await run(f)).toBe(1);
      expect(f.output).toEqual([]);
      expect(f.pools.every((pool) => pool.closed)).toBe(true);
      expect(f.errors).toEqual([`restore_${job}_command_failed\n`]);
    }
  });
  test(`${job} reports generic failure on pool errors, failed shutdown and substituted result`, async () => {
    for (const mode of ['pool', 'close', 'result'] as const) {
      const f = fixture(job);
      const restore = f.restore;
      const reconcile = f.reconcile;
      f.restore = vi.fn(async (options) => {
        const result = await restore(options);
        if (mode === 'pool') f.pools[0]?.emit('error', new Error('synthetic_secret'));
        if (mode === 'close' && f.pools[0]) f.pools[0].closeFailure = true;
        return mode === 'result' ? { ...result, backupRef: `backup_${'f'.repeat(32)}` } : result;
      });
      f.reconcile = vi.fn(async (options) => {
        const result = await reconcile(options);
        if (mode === 'pool') f.pools[0]?.emit('error', new Error('synthetic_secret'));
        if (mode === 'close' && f.pools[0]) f.pools[0].closeFailure = true;
        return mode === 'result'
          ? { ...result, sourceSystemIdentifier: target.systemIdentifier }
          : result;
      });
      expect(await run(f)).toBe(1);
      expect(f.output).toEqual([]);
      expect(f.errors).toEqual([`restore_${job}_command_failed\n`]);
      expect(f.pools.every((pool) => pool.closed)).toBe(true);
    }
  });
}

test('reconcile refuses stale, substituted checkpoint and unmigrated targets before reconciliation', async () => {
  for (const mode of ['stale', 'checkpoint', 'target-revision'] as const) {
    const f = fixture('reconcile');
    if (mode === 'stale') f.common.environment.CHECKPOINT_MAX_AGE_MS = '1';
    if (mode === 'checkpoint') f.common.args[3] = `checkpoint_${'d'.repeat(32)}`;
    const create = f.common.createPool;
    f.common.createPool = (config) => {
      const pool = create(config);
      if (mode === 'target-revision' && f.pools[1]) f.pools[1].revision = '000001';
      return pool;
    };
    expect(await runRestoreReconcileCommand({ ...f.common, reconcile: f.reconcile })).toBe(1);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.output).toEqual([]);
    expect(f.pools.every((pool) => pool.closed)).toBe(true);
  }
});
