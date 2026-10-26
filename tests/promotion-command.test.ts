import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { parsePromotionCommand } from '../src/operations/promotion-command.js';
import { runPromotionCommand } from '../src/operations/promotion-main.js';
import type { PromotionOptions } from '../src/operations/restore.js';

const sourceId = '7300000000000000000';
const operationRef = `operation_${'e'.repeat(32)}`;
const at = new Date('2030-01-01T00:00:01.000Z');
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
const metadata = { ...target, gitRevision: 'd'.repeat(40), schemaRevision: '000016' };
function args() {
  return [
    'promote',
    `restore_${'a'.repeat(32)}`,
    `restore_${'f'.repeat(32)}`,
    `backup_${'b'.repeat(32)}`,
    `checkpoint_${'c'.repeat(32)}`,
    Buffer.from(JSON.stringify(metadata)).toString('base64'),
  ];
}

test('promotion parser requires distinct restore and verification refs with canonical restore metadata', () => {
  expect(parsePromotionCommand(args())).toEqual({
    job: 'promote',
    restoreRef: args()[1],
    verificationRef: args()[2],
    backupRef: args()[3],
    checkpointRef: args()[4],
    target,
    gitRevision: metadata.gitRevision,
    schemaRevision: metadata.schemaRevision,
  });
  for (const invalid of [
    [],
    args().slice(0, -1),
    [...args(), 'synthetic_extra'],
    ['restore', ...args().slice(1)],
    [args()[0], args()[1], args()[1], ...args().slice(3)],
    [...args().slice(0, 5), 'synthetic_not_base64'],
  ])
    expect(() => parsePromotionCommand(invalid as string[])).toThrow('promotion_command_invalid');
});

function fixture() {
  const input = new PassThrough();
  const lines: string[] = [];
  const errors: string[] = [];
  const configurations: pg.PoolConfig[] = [];
  const pools: SyntheticPromotionPool[] = [];
  const hmac = Buffer.from('synthetic_promotion_manifest_key_material_0001');
  const material = {
    checkpointRef: args()[4],
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
    '/run/secrets/synthetic-target-owner':
      'postgresql://postgres:synthetic_owner@127.0.0.1/fcd_support_test',
    '/run/secrets/synthetic-keyring': JSON.stringify({
      activeVersion: 'synthetic-v1',
      keys: [{ version: 'synthetic-v1', keyBase64url: Buffer.alloc(32, 3).toString('base64url') }],
    }),
    '/run/secrets/synthetic-hmac': hmac.toString(),
    [`/var/lib/fcd-support/checkpoints/${args()[4] ?? ''}/manifest.json`]:
      JSON.stringify(checkpoint),
  };
  const environment: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
    OPS_OPERATION_REFERENCE: operationRef,
    OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: sourceId,
    OPS_SOURCE_DATABASE_NAME: 'fcd_support_test',
    OPS_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
    OPS_DATABASE_SCHEMA: 'public',
    OPS_GIT_REVISION: metadata.gitRevision,
    OPS_SCHEMA_REVISION: metadata.schemaRevision,
    RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
    RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
    RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE: '/run/secrets/synthetic-source-checkpoint',
    RESTORE_TARGET_OWNER_DATABASE_URL_FILE: '/run/secrets/synthetic-target-owner',
    PRIVACY_HMAC_KEYRING_FILE: '/run/secrets/synthetic-keyring',
    RECOVERY_MANIFEST_HMAC_FILE: '/run/secrets/synthetic-hmac',
    BACKUP_AGE_IDENTITY_FILE: '/run/secrets/synthetic-age',
    CHECKPOINT_ARCHIVE_DIRECTORY: '/var/lib/fcd-support/checkpoints',
    OPS_MAX_CALL_MS: '20000',
    PROMOTION_HOST_CHECK_TIMEOUT_MS: '100',
    CHECKPOINT_MAX_AGE_MS: '60000',
    CHECKPOINT_MAX_ROWS: '1000',
    CHECKPOINT_MAX_PAYLOAD_BYTES: '1048576',
    RESTORE_BATCH_LIMIT: '50',
    RESTORE_MAX_BATCHES: '20',
  };
  const verify = vi.fn(async (options: PromotionOptions) => {
    for (const pool of [options.sourcePool, options.targetPool]) {
      const client = await pool.connect();
      client.release(true);
    }
    await options.assertQuiesced(new AbortController().signal);
    await options.assertQuiesced(new AbortController().signal);
    return { status: 'ready' as const };
  });
  const options = {
    args: args(),
    environment,
    input,
    now: () => at,
    readSecret: (file: string) => {
      const text = files[file];
      if (text === undefined) throw new Error('synthetic_unexpected_file');
      return Promise.resolve(Buffer.from(text));
    },
    createPool: (configuration: pg.PoolConfig) => {
      configurations.push(configuration);
      const pool = new SyntheticPromotionPool(configuration);
      pools.push(pool);
      return pool as unknown as pg.Pool;
    },
    verify,
    write: (line: string) => {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (data.event === 'promotion_host_check')
        input.write(
          Buffer.from(JSON.stringify({ ...data, event: 'promotion_host_verified' }) + '\n'),
        );
      else expect(pools.every((pool) => pool.closed)).toBe(true);
      lines.push(line);
    },
    error: (line: string) => {
      errors.push(line);
    },
  };
  return { options, pools, configurations, files, lines, errors, verify };
}

class SyntheticPromotionPool extends EventEmitter {
  public closed = false;
  public closeFailure = false;
  public substitutedAt = 0;
  public connects = 0;
  public backupRef = args()[3];
  public constructor(public readonly config: pg.PoolConfig) {
    super();
  }
  public async connect() {
    this.connects++;
    const client = Object.assign(new EventEmitter(), {
      query: (sql: string) => this.query(sql),
      release: () => undefined,
    });
    this.emit('connect', client);
    return Promise.resolve(client);
  }
  public query(sql: string) {
    const source =
      new URL(this.config.connectionString ?? '').username === 'fcd_synthetic_checkpoint';
    if (sql.includes('pg_control_system'))
      return Promise.resolve({
        rows: [
          {
            id:
              this.substitutedAt !== 0 && this.connects >= this.substitutedAt
                ? '7300000000000000099'
                : source
                  ? sourceId
                  : target.systemIdentifier,
            name: target.databaseName,
          },
        ],
      });
    if (sql.includes('pg_roles'))
      return Promise.resolve({
        rows: [
          {
            name: source ? 'fcd_synthetic_checkpoint' : 'postgres',
            session: source ? 'fcd_synthetic_checkpoint' : 'postgres',
            privileged: !source,
            memberships: false,
            read_only: source,
          },
        ],
      });
    if (sql.includes('deletion_checkpoint_clock'))
      return Promise.resolve({
        rows: [{ source_epoch: '00000000-0000-4000-8000-000000000001', revision: '0' }],
      });
    if (sql.includes('operations_restore_bindings'))
      return Promise.resolve({
        rows: [
          {
            restore_ref: args()[1],
            backup_ref: this.backupRef,
            checkpoint_ref: args()[4],
            git_revision: metadata.gitRevision,
            schema_revision: metadata.schemaRevision,
            target_identity: target,
            target_identity_sha256: createHash('sha256')
              .update(JSON.stringify(target))
              .digest('hex'),
            source_system_identifier: sourceId,
            source_epoch: '00000000-0000-4000-8000-000000000001',
            source_sequence: '0',
            required_key_versions: ['synthetic-v1'],
            gate_ref: `gate_${'a'.repeat(32)}`,
            recorded_at: at,
          },
        ],
      });
    throw new Error('synthetic_unexpected_query');
  }
  public end() {
    this.closed = true;
    return this.closeFailure
      ? Promise.reject(new Error('synthetic_close_secret'))
      : Promise.resolve();
  }
}

test('promotion driver holds only two capabilities and makes two fresh host exchanges before closed completion', async () => {
  const f = fixture();
  Object.assign(f.options.environment, {
    PG_MAJOR: '18',
    PG_VERSION: '18.4-1.pgdg13+1',
    PGDATA: '/var/lib/postgresql/18/docker',
  });
  expect(await runPromotionCommand(f.options)).toBe(0);
  expect(f.configurations).toHaveLength(2);
  expect(f.configurations[0]?.options).toContain('default_transaction_read_only=on');
  expect(
    f.configurations.map((configuration) => new URL(configuration.connectionString ?? '').hostname),
  ).toEqual(['fcd-support-source-postgres', 'fcd-support-restore-postgres']);
  const requests = f.lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(requests.map((request) => request.sequence)).toEqual([1, 2]);
  expect(new Set(requests.map((request) => request.challenge)).size).toBe(2);
  expect(f.lines.at(-1)).toBe('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
  expect(f.errors).toEqual([]);
  expect(f.options.input.listenerCount('data')).toBe(0);
});

test('promotion rejects surplus secret capabilities and invalid bounds before database access', async () => {
  for (const [name, value] of [
    ['RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE', '/run/secrets/synthetic_archive'],
    ['RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE', '/run/secrets/synthetic_migrator'],
    ['RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY', '/run/secrets'],
    ['PROMOTION_HOST_CHECK_TIMEOUT_MS', '0'],
    ['PROMOTION_HOST_CHECK_TIMEOUT_MS', '20001'],
    ['OPS_OPERATION_REFERENCE', 'synthetic_invalid'],
    ['MODEL_EXECUTION_ENABLED', 'true'],
  ] as const) {
    const f = fixture();
    f.options.environment[name] = value;
    expect(await runPromotionCommand(f.options)).toBe(1);
    expect(f.pools).toEqual([]);
    expect(f.lines).toEqual([]);
    expect(f.errors).toEqual(['promotion_command_failed\n']);
  }
});

test('promotion binds owning sessions to physical identities and refuses backup substitution', async () => {
  for (const mode of ['source', 'target', 'backup'] as const) {
    const f = fixture();
    const create = f.options.createPool;
    f.options.createPool = (configuration) => {
      const result = create(configuration);
      const source = f.pools[0];
      const targetPool = f.pools[1];
      if (mode === 'source' && source) source.substitutedAt = 3;
      if (mode === 'target' && targetPool) targetPool.substitutedAt = 3;
      if (mode === 'backup' && targetPool) targetPool.backupRef = `backup_${'f'.repeat(32)}`;
      return result;
    };
    expect(await runPromotionCommand(f.options)).toBe(1);
    expect(f.lines).toEqual([]);
    expect(f.errors).toEqual(['promotion_command_failed\n']);
    expect(f.pools.every((pool) => pool.closed)).toBe(true);
  }
});

test('a one-check verifier and failed pool shutdown cannot yield promotion success', async () => {
  for (const mode of ['one-check', 'close'] as const) {
    const f = fixture();
    const original = f.options.verify;
    f.options.verify = vi.fn(async (options: PromotionOptions) => {
      if (mode === 'one-check') {
        await options.assertQuiesced(new AbortController().signal);
        return { status: 'ready' as const };
      }
      const outcome = await original(options);
      const source = f.pools[0];
      if (source) source.closeFailure = true;
      return outcome;
    });
    expect(await runPromotionCommand(f.options)).toBe(1);
    expect(f.lines.some((line) => line.includes('"status":"completed"'))).toBe(false);
    expect(f.errors).toEqual(['promotion_command_failed\n']);
  }
});
