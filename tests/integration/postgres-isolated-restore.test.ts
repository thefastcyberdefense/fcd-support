import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AdminSecretBytes } from '../../src/admin/admin-types.js';
import {
  createEncryptedBackup,
  verifyEncryptedBackup,
  type BackupManifest,
} from '../../src/operations/backup.js';
import { registerBackup } from '../../src/operations/backup-command.js';
import { runForwardMigrations } from '../../src/operations/forward-migration.js';
import { restoreAndReconcile, restoreEncryptedBackup } from '../../src/operations/restore.js';
import { exportDeletionCheckpoint } from '../../src/operations/deletion-checkpoint.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import {
  requireIsolatedTestDatabaseUrl,
  rollbackThroughMigration,
  type IsolatedTestDatabase,
} from './test-database.js';

const enabled = process.env.RUN_ISOLATED_RESTORE_TESTS === 'synthetic-isolated-cluster-only';
let source: IsolatedTestDatabase;
let targetOwner: pg.Pool;
let root: string;
let archiveDirectory: string;
let temporaryDirectory: string;
let identityFile: string;
let wrongIdentityFile: string;
let manifestHmacFile: string;
let manifest: BackupManifest;
let targetSystemIdentifier: string;
const targetOwnerUrl = 'postgresql://fcd_support_test@restore-postgres:5432/postgres';
const cleanup: {
  targetOwner?: pg.Pool;
  source?: IsolatedTestDatabase;
  root?: string;
  archiveDirectory?: string;
  snapshots: Set<IsolatedTestDatabase>;
} = { snapshots: new Set() };

async function createRestoreSource(): Promise<IsolatedTestDatabase> {
  const base = requireIsolatedTestDatabaseUrl(process.env);
  const owner = new pg.Pool({
    connectionString: base,
    max: 1,
    application_name: 'synthetic-restore-source-owner',
  });
  const name = `fcd_support_restore_source_${randomUUID().replaceAll('-', '')}`;
  const schema = `test_isolated_restore_${randomUUID().replaceAll('-', '')}`;
  await owner.query(`create database "${name}" template template0`);
  const url = new URL(base);
  url.pathname = name;
  const runMigrations = async (direction: 'up' | 'down', count?: number) => {
    await runner({
      databaseUrl: url.toString(),
      dir: resolve('migrations'),
      direction,
      ...(count === undefined ? {} : { count }),
      schema,
      migrationsSchema: schema,
      migrationsTable: 'pgmigrations',
      createSchema: true,
      createMigrationsSchema: true,
      singleTransaction: true,
      log: () => undefined,
      verbose: false,
    });
  };
  await runMigrations('up');
  const schemaUrl = new URL(url);
  schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: schemaUrl.toString(), max: 4 });
  return {
    pool,
    schema,
    connectionString: schemaUrl.toString(),
    runMigrations,
    dispose: async () => {
      await pool.end();
      try {
        await owner.query(`drop database "${name}"`);
      } finally {
        await owner.end();
      }
    },
  };
}

async function command(file: string, args: string[]): Promise<string> {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    if (output.length > 4096) child.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('synthetic_tool_failed'));
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('synthetic_tool_failed'));
    });
  });
  return output;
}

beforeAll(async () => {
  if (!enabled) return;
  requireIsolatedTestDatabaseUrl(process.env);
  if (
    process.env.RESTORE_TEST_DATABASE_URL !== targetOwnerUrl ||
    process.env.BACKUP_TEST_ARCHIVE_ROOT !== '/var/lib/fcd-support/backups'
  )
    throw new Error('synthetic_restore_target_invalid');
  targetOwner = new pg.Pool({ connectionString: targetOwnerUrl, max: 1 });
  cleanup.targetOwner = targetOwner;
  const targetId = (
    await targetOwner.query<{ id: string }>(
      'select system_identifier::text as id from pg_control_system()',
    )
  ).rows[0]?.id;
  if (targetId === undefined) throw new Error('synthetic_restore_target_invalid');
  targetSystemIdentifier = targetId;
  source = await createRestoreSource();
  cleanup.source = source;
  root = await mkdtemp(join(tmpdir(), 'fcd-isolated-restore-test-'));
  cleanup.root = root;
  await chmod(root, 0o700);
  archiveDirectory = join('/var/lib/fcd-support/backups', basename(root));
  cleanup.archiveDirectory = archiveDirectory;
  temporaryDirectory = join(root, 'work');
  await mkdir(archiveDirectory, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  identityFile = join(root, 'identity');
  wrongIdentityFile = join(root, 'wrong-identity');
  manifestHmacFile = join(root, 'hmac');
  for (const file of [identityFile, wrongIdentityFile]) {
    await command('age-keygen', ['--output', file]);
    await chmod(file, 0o600);
  }
  const recipientFile = join(root, 'recipient');
  await writeFile(recipientFile, await command('age-keygen', ['-y', identityFile]), {
    mode: 0o600,
  });
  await writeFile(manifestHmacFile, 'synthetic_restore_manifest_hmac_'.repeat(3), { mode: 0o600 });
  await source.pool.query(
    'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
    ['a'.repeat(64), new Date('2030-03-01T00:00:00.000Z')],
  );
  const backupUrl = new URL(source.connectionString);
  backupUrl.search = '';
  manifest = await createEncryptedBackup({
    connectionString: backupUrl.toString(),
    archiveDirectory,
    temporaryDirectory,
    recipientFile,
    manifestHmacFile,
    gitRevision: 'a'.repeat(40),
    schemaRevision: '000016',
    backupClass: 'pre_migration',
    now: new Date('2030-03-01T00:00:00.000Z'),
    timeoutMilliseconds: 10000,
  });
  await registerBackup(source.pool, manifest, 'verified');
});

afterAll(async () => {
  if (!enabled) return;
  await cleanup.targetOwner?.end();
  for (const snapshot of cleanup.snapshots) await snapshot.dispose();
  await cleanup.source?.dispose();
  if (cleanup.archiveDirectory !== undefined)
    await rm(cleanup.archiveDirectory, { recursive: true, force: true });
  if (cleanup.root !== undefined) await rm(cleanup.root, { recursive: true, force: true });
  // DROP DATABASE forces a checkpoint. Keep loaded shared-cluster teardown
  // outside the unchanged 20-second assertion and 10-second restore deadlines.
}, 60000);

async function withTarget(
  work: (input: ReturnType<typeof options>, pool: pg.Pool) => Promise<void>,
) {
  const name = `fcd_support_restore_${randomUUID().replaceAll('-', '')}`;
  await targetOwner.query(`create database "${name}" template template0`);
  const url = new URL(targetOwnerUrl);
  url.pathname = name;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await work(options(url.toString()), pool);
  } finally {
    await pool.end();
    await targetOwner.query(`drop database "${name}"`);
  }
}
function options(targetConnectionString: string) {
  return {
    sourcePool: source.pool,
    targetConnectionString,
    expectedTargetSystemIdentifier: targetSystemIdentifier,
    schema: source.schema,
    backupRef: manifest.backupRef,
    archiveDirectory,
    temporaryDirectory,
    manifestHmacFile,
    identityFile,
    timeoutMilliseconds: 10000,
  };
}

async function additionalArchive(
  schemaRevision: string,
  schemas?: readonly string[],
  snapshot = source,
) {
  const url = new URL(snapshot.connectionString);
  url.search = '';
  const archive = await createEncryptedBackup({
    connectionString: url.toString(),
    ...(schemas === undefined ? {} : { schemas }),
    archiveDirectory,
    temporaryDirectory,
    recipientFile: join(root, 'recipient'),
    manifestHmacFile,
    gitRevision: 'a'.repeat(40),
    schemaRevision,
    backupClass: 'pre_migration',
    now: new Date('2030-03-01T00:00:00.000Z'),
    timeoutMilliseconds: 10000,
  });
  await registerBackup(source.pool, archive, 'verified');
  return archive;
}

async function reconciliationFixture(
  mode: 'normal' | 'batch_exhausted' | 'missing_rotated_key' | 'target_time_boundary' = 'normal',
) {
  const snapshot = await createRestoreSource();
  cleanup.snapshots.add(snapshot);
  const marker = randomUUID().replaceAll('-', '');
  const at = new Date('2030-03-01T00:00:01.000Z');
  const identities = Array.from({ length: mode === 'batch_exhausted' ? 2 : 1 }, (_, index) => ({
    channel: 'whatsapp' as const,
    channelAccountId: `PHONE_TEST_restore_${marker}`,
    externalContactId: `CONTACT_TEST_restore_${marker}_${String(index)}`,
  }));
  for (const [index, identity] of identities.entries())
    await insertSyntheticAppliedCustomerEvent(snapshot.pool, {
      fixtureKey: `restore_reconcile_${marker}_${String(index)}`,
      identity,
      occurredAt: new Date('2030-02-28T23:59:00.000Z'),
      messageText: 'Synthetic old archive content requiring post-backup erasure',
    });
  if (mode === 'missing_rotated_key' || mode === 'target_time_boundary') {
    await snapshot.pool.query(
      `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
      values($1,'whatsapp','deletion_tombstone','customer_deletion',$2,$3)`,
      [
        'e'.repeat(64),
        mode === 'target_time_boundary' ? new Date(at.getTime() + 1000) : at,
        mode === 'missing_rotated_key' ? 'TEST_old_v0' : 'TEST_v1',
      ],
    );
  }
  const archive = await additionalArchive('000016', undefined, snapshot);
  const key = syntheticPrivacyKeyring.keys.get('TEST_v1');
  if (key === undefined) throw new Error('synthetic_key_missing');
  for (const identity of identities)
    await source.pool.query(
      `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
    values($1,'whatsapp','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
      [createIdentityHmac(identity, { key, version: 'TEST_v1' }), at],
    );
  const signingKey = new AdminSecretBytes(
    Buffer.from('synthetic_restore_checkpoint_signing_'.repeat(2)),
  );
  const checkpoint = await exportDeletionCheckpoint({
    sourcePool: source.pool,
    recipientFile: join(root, 'recipient'),
    signingKey,
    archiveDirectory,
    sourceRevision: 'a'.repeat(40),
    schemaRevision: '000016',
    now: at,
    timeoutMilliseconds: 10000,
    maximumRows: 1000,
    maximumPayloadBytes: 1048576,
  });
  return { snapshot, archive, at, signingKey, checkpoint };
}

function reconciliationOptions(
  fixture: Awaited<ReturnType<typeof reconciliationFixture>>,
  input: ReturnType<typeof options>,
  pool: pg.Pool,
) {
  const target = {
    projectName: 'fcd-support-restore-synthetic',
    volumeName: 'fcd-support-restore-synthetic-data',
    volumeCreatedAt: '2030-02-28T00:00:00.000Z',
    networkId: 'a'.repeat(64),
    postgresImageId: `sha256:${'b'.repeat(64)}`,
    runtimeImageId: `sha256:${'c'.repeat(64)}`,
    systemIdentifier: targetSystemIdentifier,
    databaseName: new URL(input.targetConnectionString).pathname.slice(1),
    schema: fixture.snapshot.schema,
  };
  return {
    ...input,
    schema: fixture.snapshot.schema,
    backupRef: fixture.archive.backupRef,
    targetPool: pool,
    target,
    restoreRef: `restore_${randomUUID().replaceAll('-', '')}`,
    gitRevision: 'd'.repeat(40),
    expectedSchemaRevision: '000016',
    keyring: syntheticPrivacyKeyring,
    checkpoint: fixture.checkpoint,
    checkpointArchiveFile: join(archiveDirectory, fixture.checkpoint.checkpointRef, 'archive.age'),
    checkpointSigningKey: fixture.signingKey,
    maximumCheckpointAgeMilliseconds: 60000,
    maximumCheckpointRows: 1000,
    maximumCheckpointPayloadBytes: 1048576,
    batchLimit: 1,
    maximumBatches: 10,
    clock: () => fixture.at,
  };
}

test.skipIf(!enabled)(
  'full restore composes current checkpoint, quarantine, bounded erasure and immutable target binding',
  async () => {
    const fixture = await reconciliationFixture();
    await withTarget(async (input, pool) => {
      const command = reconciliationOptions(fixture, input, pool);
      const { restoreRef, target } = command;
      let freezeObserved = false;
      const checkedPool = new Proxy(pool, {
        get(original, property, receiver) {
          if (property !== 'connect') return Reflect.get(original, property, receiver) as unknown;
          return async () => {
            const client = await original.connect();
            const query = client.query.bind(client);
            return new Proxy(client, {
              get(connection, field, view) {
                if (field !== 'query') return Reflect.get(connection, field, view) as unknown;
                return async (sql: unknown, ...parameters: unknown[]) => {
                  if (
                    typeof sql === 'string' &&
                    sql.startsWith('insert into operations_restore_bindings')
                  ) {
                    const contender = await source.pool.connect();
                    try {
                      await contender.query(
                        "set lock_timeout='200ms'; set statement_timeout='1000ms'",
                      );
                      await expect(
                        contender.query(
                          `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
                        values($1,'messenger','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
                          [randomBytes(32).toString('hex'), fixture.at],
                        ),
                      ).rejects.toMatchObject({ code: '55P03' });
                      freezeObserved = true;
                    } finally {
                      contender.release(true);
                    }
                  }
                  return Reflect.apply(query, client, [sql, ...parameters]) as unknown;
                };
              },
            });
          };
        },
      });
      const evidence = await restoreAndReconcile({ ...command, targetPool: checkedPool });
      expect(freezeObserved).toBe(true);
      expect(evidence).toMatchObject({
        status: 'deletion_verified',
        erasedIdentities: 1,
        batches: 1,
        restoreRef,
        target,
        checkpointRef: fixture.checkpoint.checkpointRef,
        recoveryHeldAtSeal: true,
        requiredKeyVersions: ['TEST_v1'],
      });
      expect(
        (
          await pool.query(
            `select external_contact_id ~ '^deleted:' as erased from "${fixture.snapshot.schema}".channel_identities`,
          )
        ).rows,
      ).toEqual([{ erased: true }]);
      expect(
        (
          await pool.query(
            `select message_text is null as erased from "${fixture.snapshot.schema}".webhook_events`,
          )
        ).rows,
      ).toEqual([{ erased: true }]);
      expect(
        (
          await pool.query(
            `select count(*)::int as count from "${fixture.snapshot.schema}".operations_restore_bindings where restore_ref=$1`,
            [restoreRef],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await pool.query(`select exists(select 1 from "${fixture.snapshot.schema}".runtime_recovery_holds hold
          where not exists(select 1 from "${fixture.snapshot.schema}".runtime_recovery_reviews review where review.restore_ref=hold.restore_ref)) as held`)
        ).rows,
      ).toEqual([{ held: true }]);
      expect(
        (
          await source.pool.query('select state from operations_backups where backup_ref=$1', [
            fixture.archive.backupRef,
          ])
        ).rows,
      ).toEqual([{ state: 'verified' }]);
    });
  },
  20000,
);

test
  .skipIf(!enabled)
  .each(['missing_rotated_key', 'batch_exhausted', 'target_time_boundary'] as const)(
  'reconciliation refuses %s and atomically preserves the unapproved isolated restore',
  async (mode) => {
    const fixture = await reconciliationFixture(mode);
    await withTarget(async (input, pool) => {
      let clockReads = 0;
      const command = reconciliationOptions(fixture, input, pool);
      await expect(
        restoreAndReconcile({
          ...command,
          maximumBatches: 1,
          clock: () =>
            mode === 'target_time_boundary' && ++clockReads >= 3
              ? new Date(fixture.at.getTime() + 2000)
              : fixture.at,
        }),
      ).rejects.toThrow(/^restore_reconciliation_failed$/u);
      const schema = fixture.snapshot.schema;
      expect(
        (
          await pool.query(
            `select count(*)::int as count from "${schema}".channel_identities where external_contact_id !~ '^deleted:'`,
          )
        ).rows,
      ).toEqual([{ count: mode === 'batch_exhausted' ? 2 : 1 }]);
      for (const table of [
        'operations_restore_bindings',
        'operations_restore_runs',
        'restore_deletion_gates',
        'restore_checkpoint_imports',
        'runtime_recovery_holds',
      ]) {
        expect(
          (await pool.query(`select count(*)::int as count from "${schema}".${table}`)).rows,
        ).toEqual([{ count: 0 }]);
      }
    });
  },
  20000,
);

test.skipIf(!enabled)(
  'a checkpoint made stale by a post-export deletion refuses before the full restore',
  async () => {
    const fixture = await reconciliationFixture();
    await source.pool.query(
      `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
    values($1,'messenger','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
      ['f'.repeat(64), fixture.at],
    );
    await withTarget(async (input, pool) => {
      await expect(
        restoreAndReconcile(reconciliationOptions(fixture, input, pool)),
      ).rejects.toThrow(/^restore_reconciliation_failed$/u);
      expect(
        (
          await pool.query('select to_regnamespace($1) is null as absent', [
            fixture.snapshot.schema,
          ])
        ).rows,
      ).toEqual([{ absent: true }]);
    });
  },
  20000,
);

test.skipIf(!enabled)(
  'a substituted migration pool cannot create restored-schema objects on the source',
  async () => {
    const fixture = await reconciliationFixture();
    const substitutedPool = new pg.Pool({ connectionString: source.connectionString, max: 1 });
    const schema = fixture.snapshot.schema;
    if (!/^test_isolated_restore_[a-f0-9]{32}$/u.test(schema))
      throw new Error('synthetic_schema_invalid');
    const absent = async () =>
      (
        await source.pool.query<{ absent: boolean }>(
          'select to_regnamespace($1) is null as absent',
          [schema],
        )
      ).rows;
    expect(await absent()).toEqual([{ absent: true }]);
    try {
      await withTarget(async (input, pool) => {
        await expect(
          restoreAndReconcile({
            ...reconciliationOptions(fixture, input, pool),
            targetPool: substitutedPool,
          }),
        ).rejects.toThrow(/^restore_reconciliation_failed$/u);
        expect(await absent()).toEqual([{ absent: true }]);
      });
    } finally {
      await substitutedPool.end();
      // Only the newly generated fixture namespace, on this synthetic source DB.
      await source.pool.query(`drop schema if exists "${schema}" cascade`);
    }
  },
  20000,
);

test.skipIf(!enabled)(
  'decrypts directly into a distinct empty cluster and preserves real rows and schema',
  async () => {
    await withTarget(async (input, pool) => {
      const evidence = await restoreEncryptedBackup(input);
      expect(evidence).toMatchObject({
        status: 'restored',
        backupRef: manifest.backupRef,
        schemaRevision: '000016',
        targetSystemIdentifier,
      });
      expect(evidence.sourceSystemIdentifier).not.toBe(evidence.targetSystemIdentifier);
      expect(
        (
          await pool.query(
            "select count(*)::int as count from pg_extension where extname='pg_trgm'",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await pool.query(
            `select payload_sha256,event_count from "${source.schema}".webhook_receipts`,
          )
        ).rows,
      ).toEqual([{ payload_sha256: 'a'.repeat(64), event_count: 1 }]);
      expect(
        (await pool.query(`select count(*)::int as count from "${source.schema}".pgmigrations`))
          .rows,
      ).toEqual([{ count: 16 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
      expect(await readdir(join(archiveDirectory, manifest.backupRef))).toEqual([
        'archive.age',
        'manifest.json',
      ]);
      // The restored catalog intentionally predates the selected archive's registration.
      expect(
        (
          await pool.query(
            `select count(*)::int as count from "${source.schema}".operations_backups`,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const url = new URL(input.targetConnectionString);
      url.searchParams.set('options', `-c search_path=${source.schema}`);
      const migrationPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        expect(
          await runForwardMigrations(migrationPool, {
            schema: source.schema,
            expectedSchemaRevision: '000016',
            timeoutMilliseconds: 10000,
          }),
        ).toEqual({ schemaRevision: '000016' });
      } finally {
        await migrationPool.end();
      }
    });
  },
);

test.skipIf(!enabled)(
  'refuses the authoritative source cluster even with an empty different database',
  async () => {
    const url = new URL(requireIsolatedTestDatabaseUrl(process.env));
    url.pathname = 'postgres';
    const sourceId = (
      await source.pool.query<{ id: string }>(
        'select system_identifier::text as id from pg_control_system()',
      )
    ).rows[0]?.id;
    if (sourceId === undefined) throw new Error('synthetic_restore_source_invalid');
    await expect(
      restoreEncryptedBackup({
        ...options(url.toString()),
        expectedTargetSystemIdentifier: sourceId,
      }),
    ).rejects.toThrow(/^restore_target_invalid$/u);
    expect(
      (await source.pool.query('select count(*)::int as count from webhook_receipts')).rows,
    ).toEqual([{ count: 1 }]);
  },
);

test.skipIf(!enabled)(
  'refuses a substituted target cluster identity before importing any objects',
  async () => {
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({ ...input, expectedTargetSystemIdentifier: '1234567890123456789' }),
      ).rejects.toThrow(/^restore_target_invalid$/u);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
    });
  },
);

test.skipIf(!enabled)(
  'refuses a populated target without cleaning or replacing its existing data',
  async () => {
    await withTarget(async (input, pool) => {
      const setup = await pool.connect();
      try {
        await setup.query('create table synthetic_preserved(value int)');
        await setup.query('insert into synthetic_preserved values(42)');
      } finally {
        const ended = new Promise<void>((resolve) => {
          setup.once('end', resolve);
        });
        setup.release(true);
        await ended;
      }
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_target_invalid$/u);
      expect((await pool.query('select value from synthetic_preserved')).rows).toEqual([
        { value: 42 },
      ]);
    });
  },
);

test.skipIf(!enabled)(
  'refuses another connected application session even on an empty target',
  async () => {
    await withTarget(async (input, pool) => {
      await pool.query('select 1');
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_target_invalid$/u);
    });
  },
);

test.skipIf(!enabled).each(['wrong', 'missing'] as const)(
  '%s identity cannot restore and leaves no plaintext or credential file',
  async (kind) => {
    await withTarget(async (input, pool) => {
      const file = kind === 'wrong' ? wrongIdentityFile : join(root, 'missing-identity');
      await expect(restoreEncryptedBackup({ ...input, identityFile: file })).rejects.toThrow(
        /^restore_failed$/u,
      );
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)('refuses unverified source catalog state and a missing archive', async () => {
  await withTarget(async (input) => {
    await source.pool.query("update operations_backups set state='failed' where backup_ref=$1", [
      manifest.backupRef,
    ]);
    try {
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_archive_invalid$/u);
    } finally {
      await source.pool.query(
        "update operations_backups set state='verified' where backup_ref=$1",
        [manifest.backupRef],
      );
    }
    await expect(
      restoreEncryptedBackup({ ...input, backupRef: `backup_${'0'.repeat(32)}` }),
    ).rejects.toThrow(/^restore_archive_invalid$/u);
    expect(
      (
        await readFile(join(archiveDirectory, manifest.backupRef, 'manifest.json'), 'utf8')
      ).includes('synthetic_restore_manifest_hmac'),
    ).toBe(false);
  });
});

test.skipIf(!enabled)(
  'an incomplete schema-only archive fails atomically without installing its partial tables',
  async () => {
    const archive = await additionalArchive('000016', [source.schema]);
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({ ...input, backupRef: archive.backupRef }),
      ).rejects.toThrow(/^restore_failed$/u);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
      expect(
        (await source.pool.query('select count(*)::int as count from webhook_receipts')).rows,
      ).toEqual([{ count: 1 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)(
  'a signed but incorrect source schema is refused and its isolated target data is retained',
  async () => {
    const archive = await additionalArchive('000014');
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({ ...input, backupRef: archive.backupRef }),
      ).rejects.toThrow(/^restore_failed$/u);
      expect(
        (await pool.query(`select count(*)::int as count from "${source.schema}".webhook_receipts`))
          .rows,
      ).toEqual([{ count: 1 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)(
  'a stalled decrypt is killed at the configured timeout with no partial SQL or leftover password file',
  async () => {
    await withTarget(async (input, pool) => {
      let decrypts = 0;
      const started = Date.now();
      await expect(
        restoreEncryptedBackup({
          ...input,
          timeoutMilliseconds: 1000,
          processes: (file, args, settings) => {
            if (file === 'age' && ++decrypts === 2)
              return spawn(
                process.execPath,
                ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
                settings,
              );
            return spawn(file, args, settings);
          },
        }),
      ).rejects.toThrow(/^restore_failed$/u);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)(
  'an actual old admission archive restores then forward-migrates without losing its receipt',
  async () => {
    const older = await createRestoreSource();
    try {
      await rollbackThroughMigration(older, 2);
      await older.pool.query(
        'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
        ['b'.repeat(64), new Date('2030-02-01T00:00:00.000Z')],
      );
      const archive = await additionalArchive('000001', undefined, older);
      await withTarget(async (input, pool) => {
        expect(
          await restoreEncryptedBackup({
            ...input,
            schema: older.schema,
            backupRef: archive.backupRef,
          }),
        ).toMatchObject({ status: 'restored', schemaRevision: '000001' });
        const url = new URL(input.targetConnectionString);
        url.searchParams.set('options', `-c search_path=${older.schema},public`);
        const migrations = new pg.Pool({ connectionString: url.toString(), max: 1 });
        try {
          expect(
            await runForwardMigrations(migrations, {
              schema: older.schema,
              expectedSchemaRevision: '000016',
              timeoutMilliseconds: 10000,
            }),
          ).toEqual({ schemaRevision: '000016' });
          expect(
            (
              await pool.query(
                `select payload_sha256,event_count from "${older.schema}".webhook_receipts`,
              )
            ).rows,
          ).toEqual([{ payload_sha256: 'b'.repeat(64), event_count: 1 }]);
          expect(
            (await pool.query(`select count(*)::int as count from "${older.schema}".pgmigrations`))
              .rows,
          ).toEqual([{ count: 16 }]);
        } finally {
          await migrations.end();
        }
      });
    } finally {
      cleanup.snapshots.add(older);
    }
  },
);

test.skipIf(!enabled)('a corrupted ciphertext is rejected before any SQL restore', async () => {
  const path = join(archiveDirectory, manifest.backupRef, 'archive.age');
  const original = await readFile(path);
  const corrupted = Buffer.from(original);
  corrupted[0] = 0;
  await writeFile(path, corrupted);
  try {
    await withTarget(async (input, pool) => {
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_archive_invalid$/u);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
    });
  } finally {
    await writeFile(path, original);
  }
});

test.skipIf(!enabled)(
  'a full archive larger than pipe buffers restores all synthetic binary data without plaintext files',
  async () => {
    await source.pool.query('create table synthetic_restore_blob(payload bytea not null)');
    try {
      await source.pool.query('insert into synthetic_restore_blob values($1)', [
        randomBytes(1024 * 1024),
      ]);
      const archive = await additionalArchive('000016');
      expect(archive.ciphertextBytes).toBeGreaterThan(1024 * 1024);
      expect(
        await verifyEncryptedBackup({
          archiveDirectory,
          manifestHmacFile,
          identityFile,
          expectedManifest: archive,
          timeoutMilliseconds: 10000,
        }),
      ).toEqual({ status: 'verified' });
      await withTarget(async (input, pool) => {
        expect(
          await restoreEncryptedBackup({ ...input, backupRef: archive.backupRef }),
        ).toMatchObject({ status: 'restored', schemaRevision: '000016' });
        expect(
          (
            await pool.query(
              `select octet_length(payload) as bytes from "${source.schema}".synthetic_restore_blob`,
            )
          ).rows,
        ).toEqual([{ bytes: 1024 * 1024 }]);
        expect(await readdir(temporaryDirectory)).toEqual([]);
      });
    } finally {
      await source.pool.query('drop table synthetic_restore_blob');
    }
  },
);
