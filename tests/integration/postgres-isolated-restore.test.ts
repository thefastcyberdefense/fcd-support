import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
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
import { runRestoreCommand } from '../../src/operations/restore-main.js';
import { runPromotionCommand } from '../../src/operations/promotion-main.js';
import {
  bindOperationConnectionString,
  operationApplicationName,
} from '../../src/operations/operation-reference.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import {
  restoreAndReconcile,
  restoreEncryptedBackup,
  verifyPromotion,
} from '../../src/operations/restore.js';
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
  mode:
    | 'normal'
    | 'promotion'
    | 'batch_exhausted'
    | 'missing_rotated_key'
    | 'target_time_boundary' = 'normal',
) {
  const snapshot = await createRestoreSource();
  cleanup.snapshots.add(snapshot);
  const marker = randomUUID().replaceAll('-', '');
  const at = new Date('2030-03-01T00:00:01.000Z');
  const identities = Array.from(
    { length: ['batch_exhausted', 'promotion'].includes(mode) ? 2 : 1 },
    (_, index) => ({
      channel: 'whatsapp' as const,
      channelAccountId: `PHONE_TEST_restore_${marker}`,
      externalContactId: `CONTACT_TEST_restore_${marker}_${String(index)}`,
    }),
  );
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
  for (const identity of mode === 'promotion' ? identities.slice(0, 1) : identities)
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
  return { snapshot, archive, at, signingKey, checkpoint, identities };
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

async function promotionFixture() {
  const fixture = await reconciliationFixture('promotion');
  const at = new Date(fixture.at.getTime() + 2000);
  const key = syntheticPrivacyKeyring.keys.get('TEST_v1');
  const identity = fixture.identities[1];
  if (key === undefined || identity === undefined) throw new Error('synthetic_key_missing');
  const refresh = async () => {
    await source.pool.query(
      `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
      values($1,'whatsapp','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
      [createIdentityHmac(identity, { key, version: 'TEST_v1' }), at],
    );
    return exportDeletionCheckpoint({
      sourcePool: source.pool,
      recipientFile: join(root, 'recipient'),
      signingKey: fixture.signingKey,
      archiveDirectory,
      sourceRevision: 'a'.repeat(40),
      schemaRevision: '000016',
      now: at,
      timeoutMilliseconds: 10000,
      maximumRows: 1000,
      maximumPayloadBytes: 1048576,
    });
  };
  return { fixture, at, refresh };
}

test.skipIf(!enabled)(
  'promotion refreshes post-restore deletions under retained source freeze instead of trusting the old pass',
  async () => {
    const { fixture, at, refresh } = await promotionFixture();
    await withTarget(async (input, pool) => {
      const command = reconciliationOptions(fixture, input, pool);
      await restoreAndReconcile(command);
      const countLive = async () =>
        (
          await pool.query<{ count: number }>(
            `select count(*)::int as count from "${fixture.snapshot.schema}".channel_identities where external_contact_id !~ '^deleted:'`,
          )
        ).rows;
      expect(await countLive()).toEqual([{ count: 1 }]);
      const checkpoint = await refresh();
      const verificationRef = `restore_${randomUUID().replaceAll('-', '')}`;
      let quiescenceChecks = 0;
      const promotion = {
        ...command,
        verificationRef,
        checkpoint,
        checkpointArchiveFile: join(archiveDirectory, checkpoint.checkpointRef, 'archive.age'),
        clock: () => at,
        assertQuiesced: async () => {
          if (++quiescenceChecks !== 2) return;
          const contender = await source.pool.connect();
          try {
            await contender.query("set lock_timeout='200ms'; set statement_timeout='1000ms'");
            await expect(
              contender.query(
                `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
              values($1,'messenger','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
                [randomBytes(32).toString('hex'), at],
              ),
            ).rejects.toMatchObject({ code: '55P03' });
          } finally {
            contender.release(true);
          }
        },
      };
      await expect(
        verifyPromotion({
          ...promotion,
          checkpoint: fixture.checkpoint,
          checkpointArchiveFile: command.checkpointArchiveFile,
        }),
      ).rejects.toThrow(/^promotion_verification_failed$/u);
      quiescenceChecks = 0;
      await expect(verifyPromotion(promotion)).resolves.toEqual({ status: 'ready' });
      expect(quiescenceChecks).toBe(2);
      expect(await countLive()).toEqual([{ count: 0 }]);
      expect(
        (
          await pool.query(
            `select restore_ref,checkpoint_ref from "${fixture.snapshot.schema}".operations_restore_bindings order by recorded_at`,
          )
        ).rows,
      ).toEqual([
        { restore_ref: command.restoreRef, checkpoint_ref: fixture.checkpoint.checkpointRef },
        { restore_ref: verificationRef, checkpoint_ref: checkpoint.checkpointRef },
      ]);
      await expect(verifyPromotion(promotion)).rejects.toThrow(/^promotion_verification_failed$/u);
      expect(
        (
          await pool.query(
            `select count(*)::int as count from "${fixture.snapshot.schema}".operations_restore_bindings`,
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
    });
  },
  20000,
);

test.skipIf(!enabled)(
  'promotion refuses substituted targets and interrupted quiescence without partial fresh evidence or erasure',
  async () => {
    const { fixture, at, refresh } = await promotionFixture();
    await withTarget(async (input, pool) => {
      const command = reconciliationOptions(fixture, input, pool);
      await restoreAndReconcile(command);
      const checkpoint = await refresh();
      const verificationRef = `restore_${randomUUID().replaceAll('-', '')}`;
      const promotion = {
        ...command,
        verificationRef,
        checkpoint,
        checkpointArchiveFile: join(archiveDirectory, checkpoint.checkpointRef, 'archive.age'),
        clock: () => at,
        assertQuiesced: () => Promise.resolve(undefined),
      };
      for (const changed of [
        { ...promotion, target: { ...promotion.target, networkId: 'f'.repeat(64) } },
        { ...promotion, gitRevision: 'f'.repeat(40) },
        { ...promotion, verificationRef: command.restoreRef },
      ])
        await expect(verifyPromotion(changed)).rejects.toThrow(/^promotion_verification_failed$/u);
      // Same PostgreSQL cluster, different authoritative catalogue/clock. A
      // correctly signed but unrelated checkpoint must not replace the source.
      const substitutedCheckpoint = await exportDeletionCheckpoint({
        sourcePool: fixture.snapshot.pool,
        recipientFile: join(root, 'recipient'),
        signingKey: fixture.signingKey,
        archiveDirectory,
        sourceRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        now: at,
        timeoutMilliseconds: 10000,
        maximumRows: 1000,
        maximumPayloadBytes: 1048576,
      });
      await expect(
        verifyPromotion({
          ...promotion,
          sourcePool: fixture.snapshot.pool,
          checkpoint: substitutedCheckpoint,
          checkpointArchiveFile: join(
            archiveDirectory,
            substitutedCheckpoint.checkpointRef,
            'archive.age',
          ),
        }),
      ).rejects.toThrow(/^promotion_verification_failed$/u);
      await fixture.snapshot.pool.query(
        'update deletion_checkpoint_clock set source_epoch=$1,revision=$2 where singleton',
        [
          fixture.checkpoint.watermark.sourceEpoch,
          (BigInt(fixture.checkpoint.watermark.sequence) - 1n).toString(),
        ],
      );
      const regressed = await exportDeletionCheckpoint({
        sourcePool: fixture.snapshot.pool,
        recipientFile: join(root, 'recipient'),
        signingKey: fixture.signingKey,
        archiveDirectory,
        sourceRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        now: at,
        timeoutMilliseconds: 10000,
        maximumRows: 1000,
        maximumPayloadBytes: 1048576,
      });
      await expect(
        verifyPromotion({
          ...promotion,
          sourcePool: fixture.snapshot.pool,
          checkpoint: regressed,
          checkpointArchiveFile: join(archiveDirectory, regressed.checkpointRef, 'archive.age'),
        }),
      ).rejects.toThrow(/^promotion_verification_failed$/u);
      let checks = 0;
      await expect(
        verifyPromotion({
          ...promotion,
          assertQuiesced: () => {
            if (++checks === 2) throw new Error('synthetic_quiescence_lost');
            return Promise.resolve(undefined);
          },
        }),
      ).rejects.toThrow(/^promotion_verification_failed$/u);
      expect(checks).toBe(2);
      const stalled = verifyPromotion({
        ...promotion,
        timeoutMilliseconds: 50,
        assertQuiesced: () => new Promise<void>(() => undefined),
      }).then(
        () => 'ready',
        (error: unknown) => (error instanceof Error ? error.message : 'synthetic_unexpected_error'),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exhausted = new Promise<string>((resolve) => {
          timer = setTimeout(() => {
            resolve('synthetic_wait_exhausted');
          }, 500);
        });
        expect(await Promise.race([stalled, exhausted])).toBe('promotion_verification_failed');
      } finally {
        clearTimeout(timer);
      }
      for (const table of [
        'operations_restore_bindings',
        'operations_restore_runs',
        'restore_checkpoint_imports',
        'runtime_recovery_holds',
      ])
        expect(
          (
            await pool.query(
              `select count(*)::int as count from "${fixture.snapshot.schema}".${table} where restore_ref=$1`,
              [verificationRef],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      expect(
        (
          await pool.query(
            `select count(*)::int as count from "${fixture.snapshot.schema}".channel_identities where external_contact_id !~ '^deleted:'`,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    });
  },
  20000,
);

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
test.skipIf(!enabled)(
  'restored objects pass through owner preparation and a restricted migrator before grant convergence',
  async () => {
    const fixture = await reconciliationFixture();
    const prefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const directory = await mkdtemp(join(root, 'role-'));
    const files: Record<string, string> = {};
    const phases: string[] = [];
    for (const role of [...runtimeDatabaseRoles, 'migrator']) {
      const file = join(directory, `${role}-password`);
      await writeFile(file, `synthetic_${prefix}_${role}_password_only`, { mode: 0o600 });
      files[role] = file;
    }
    await withTarget(async (input, owner) => {
      const url = new URL(input.targetConnectionString);
      url.username = `${prefix}_migrator`;
      url.password = `synthetic_${prefix}_migrator_password_only`;
      const migrator = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        await expect(
          restoreAndReconcile({
            ...reconciliationOptions(fixture, input, owner),
            migration: {
              pool: migrator,
              roleName: `${prefix}_migrator`,
              prepare: async () => {
                phases.push('prepare');
                await configureRuntimeGrants(owner, {
                  database: url.pathname.slice(1),
                  schema: fixture.snapshot.schema,
                  rolePrefix: prefix,
                  passwordFiles: files,
                  phase: 'prepare',
                  timeoutMilliseconds: 10000,
                });
              },
              converge: async () => {
                expect(
                  (
                    await migrator.query(
                      'select not rolsuper as restricted from pg_roles where rolname=current_user',
                    )
                  ).rows,
                ).toEqual([{ restricted: true }]);
                phases.push('converge');
                await configureRuntimeGrants(owner, {
                  database: url.pathname.slice(1),
                  schema: fixture.snapshot.schema,
                  rolePrefix: prefix,
                  passwordFiles: files,
                  phase: 'converge',
                  timeoutMilliseconds: 10000,
                });
              },
            },
          }),
        ).resolves.toMatchObject({ status: 'deletion_verified' });
        expect(phases).toEqual(['prepare', 'converge']);
      } finally {
        await migrator.end();
      }
    });
    await rm(directory, { recursive: true, force: true });
  },
  20000,
);
test.skipIf(!enabled)(
  'restore rejects a different physical source before target schema creation',
  async () => {
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({
          ...input,
          expectedSourceDatabaseIdentity: {
            systemIdentifier: '1',
            databaseName: new URL(source.connectionString).pathname.slice(1),
          },
        }),
      ).rejects.toThrow(/^restore_source_invalid$/u);
      expect(
        (await pool.query('select to_regnamespace($1) is null as absent', [source.schema])).rows,
      ).toEqual([{ absent: true }]);
    });
  },
);

test.skipIf(!enabled)(
  'external restore preserves the managed operation name and bounded server timeouts',
  async () => {
    const reference = `operation_${randomUUID().replaceAll('-', '')}`;
    let observed = 0;
    await withTarget(async (input) => {
      await expect(
        restoreEncryptedBackup({
          ...input,
          targetConnectionString: bindOperationConnectionString(
            input.targetConnectionString,
            reference,
          ),
          processes: (file, args, options) => {
            if (file === 'pg_restore' && args.includes('--dbname')) {
              observed += 1;
              expect(options.env.PGAPPNAME).toBe(operationApplicationName(reference));
              expect(options.env.PGOPTIONS).toContain('-c statement_timeout=10000');
              expect(options.env.PGOPTIONS).toMatch(
                new RegExp(`application_name=${operationApplicationName(reference)}$`, 'u'),
              );
            }
            return spawn(file, args, options);
          },
        }),
      ).resolves.toMatchObject({ status: 'restored' });
    });
    expect(observed).toBe(1);
  },
);

test.skipIf(!enabled)(
  'native restore command uses separate restricted capabilities and acknowledges only after deletion reconciliation and pool shutdown',
  async () => {
    const snapshot = await createRestoreSource();
    cleanup.snapshots.add(snapshot);
    const prefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const roles = [...runtimeDatabaseRoles, 'migrator'];
    const directory = await mkdtemp(join(root, 'command-'));
    await chmod(directory, 0o700);
    const passwordFiles: Record<string, string> = {};
    const sourceName = new URL(snapshot.connectionString).pathname.slice(1);
    if (!/^fcd_support_restore_source_[a-f0-9]{32}$/u.test(sourceName))
      throw new Error('synthetic_restore_command_scope_invalid');
    const pools: pg.Pool[] = [];
    const configurations: pg.PoolConfig[] = [];
    const targetUrl = new URL(targetOwnerUrl);
    targetUrl.pathname = sourceName;
    let targetCreated = false;
    let targetPostgresCreated = false;
    let target: pg.Pool | undefined;
    const password = (role: string) => `synthetic_${prefix}_${role}_password_only`;
    const sourceUrl = (role: string) => {
      const url = new URL(snapshot.connectionString);
      url.search = '';
      url.username = `${prefix}_${role}`;
      url.password = password(role);
      return url.toString();
    };
    try {
      for (const role of roles) {
        const file = join(directory, `bootstrap-${role.replaceAll('_', '-')}-password`);
        await writeFile(file, password(role), { mode: 0o600 });
        passwordFiles[role] = file;
      }
      // Both physical clusters use the same logical database/schema, just as a
      // restored production database will. Every identifier is fixture-owned.
      await configureRuntimeGrants(snapshot.pool, {
        database: sourceName,
        schema: snapshot.schema,
        rolePrefix: prefix,
        passwordFiles,
        phase: 'converge',
        timeoutMilliseconds: 10000,
      });
      const actualSource = (
        await snapshot.pool.query<{ id: string; name: string }>(
          'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
        )
      ).rows[0];
      if (actualSource?.name !== sourceName)
        throw new Error('synthetic_restore_command_source_invalid');
      expect(actualSource.id === targetSystemIdentifier).toBe(false);
      const at = new Date('2030-03-01T00:00:01.000Z');
      const marker = randomUUID().replaceAll('-', '');
      const deletedIdentity = {
        channel: 'whatsapp' as const,
        channelAccountId: `PHONE_TEST_command_${marker}`,
        externalContactId: `CONTACT_TEST_command_deleted_${marker}`,
      };
      const deleted = await insertSyntheticAppliedCustomerEvent(snapshot.pool, {
        fixtureKey: `restore_command_deleted_${marker}`,
        identity: deletedIdentity,
        occurredAt: new Date(at.getTime() - 1000),
        messageText: 'Synthetic archived content erased by a newer checkpoint',
      });
      const preserved = await insertSyntheticAppliedCustomerEvent(snapshot.pool, {
        fixtureKey: `restore_command_preserved_${marker}`,
        identity: {
          ...deletedIdentity,
          externalContactId: `CONTACT_TEST_command_preserved_${marker}`,
        },
        occurredAt: new Date(at.getTime() - 1000),
        messageText: 'Synthetic unrelated archived content retained after restore',
      });
      await snapshot.pool.query(
        `insert into runtime_processing_work(work_ref,webhook_event_id,stage,state,created_at,updated_at)
        values($1,$2,'decide','pending',$3,$3)`,
        [`WORK_TEST_command_${marker}`, preserved.eventId, at],
      );
      const archive = await createEncryptedBackup({
        connectionString: sourceUrl('backup'),
        expectedDatabaseIdentity: { systemIdentifier: actualSource.id, databaseName: sourceName },
        archiveDirectory,
        temporaryDirectory,
        recipientFile: join(root, 'recipient'),
        manifestHmacFile,
        gitRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        backupClass: 'pre_migration',
        now: new Date(at.getTime() - 1000),
        timeoutMilliseconds: 10000,
      });
      await verifyEncryptedBackup({
        archiveDirectory,
        manifestHmacFile,
        identityFile,
        expectedManifest: archive,
        timeoutMilliseconds: 10000,
      });
      await registerBackup(snapshot.pool, archive, 'verified');
      const privacyKey = syntheticPrivacyKeyring.keys.get('TEST_v1');
      if (privacyKey === undefined) throw new Error('synthetic_restore_key_missing');
      await snapshot.pool.query(
        `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
        values($1,'whatsapp','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
        [createIdentityHmac(deletedIdentity, { key: privacyKey, version: 'TEST_v1' }), at],
      );
      const signingBytes = await readFile(manifestHmacFile);
      let signingKey: AdminSecretBytes;
      try {
        signingKey = new AdminSecretBytes(signingBytes);
      } finally {
        signingBytes.fill(0);
      }
      const exporter = new pg.Pool({ connectionString: sourceUrl('checkpoint'), max: 1 });
      const checkpoint = await (async () => {
        try {
          return await exportDeletionCheckpoint({
            sourcePool: exporter,
            expectedDatabaseIdentity: {
              systemIdentifier: actualSource.id,
              databaseName: sourceName,
            },
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
        } finally {
          await exporter.end();
        }
      })();
      // The native cluster's initial owner is fcd_support_test. Provision the
      // production CLI's fixed postgres owner only in this guarded test cluster.
      const hasPostgres = (
        await targetOwner.query<{ present: boolean }>(
          "select exists(select 1 from pg_catalog.pg_roles where rolname='postgres') as present",
        )
      ).rows[0]?.present;
      if (hasPostgres !== true) {
        await targetOwner.query('create role postgres login superuser');
        targetPostgresCreated = true;
      }
      await targetOwner.query(`create database "${sourceName}" template template0`);
      targetCreated = true;
      target = new pg.Pool({ connectionString: targetUrl.toString(), max: 1 });
      const restoreRef = `restore_${randomUUID().replaceAll('-', '')}`;
      const operationRef = `operation_${randomUUID().replaceAll('-', '')}`;
      const metadata = {
        projectName: 'fcd-support-restore-synthetic',
        volumeName: 'fcd-support-restore-synthetic-data',
        volumeCreatedAt: '2030-02-28T00:00:00.000Z',
        networkId: 'a'.repeat(64),
        postgresImageId: `sha256:${'b'.repeat(64)}`,
        runtimeImageId: `sha256:${'c'.repeat(64)}`,
        systemIdentifier: targetSystemIdentifier,
        databaseName: sourceName,
        schema: snapshot.schema,
        gitRevision: 'd'.repeat(40),
        schemaRevision: '000016',
      };
      const ownerUri = new URL(targetUrl);
      ownerUri.username = 'postgres';
      ownerUri.password = 'synthetic_restore_owner_password_only';
      const migratorUri = new URL(targetUrl);
      migratorUri.username = `${prefix}_migrator`;
      migratorUri.password = password('migrator');
      const secretFiles = {
        RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE: join(directory, 'source-checkpoint'),
        RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE: join(directory, 'source-archive'),
        RESTORE_TARGET_OWNER_DATABASE_URL_FILE: join(directory, 'target-owner'),
        RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE: join(directory, 'target-migrator'),
        PRIVACY_HMAC_KEYRING_FILE: join(directory, 'keyring'),
      };
      for (const [file, value] of [
        [secretFiles.RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE, sourceUrl('checkpoint')],
        [secretFiles.RESTORE_SOURCE_ARCHIVE_DATABASE_URL_FILE, sourceUrl('backup')],
        [secretFiles.RESTORE_TARGET_OWNER_DATABASE_URL_FILE, ownerUri.toString()],
        [secretFiles.RESTORE_TARGET_MIGRATOR_DATABASE_URL_FILE, migratorUri.toString()],
        [
          secretFiles.PRIVACY_HMAC_KEYRING_FILE,
          JSON.stringify({
            activeVersion: syntheticPrivacyKeyring.activeVersion,
            keys: [...syntheticPrivacyKeyring.keys].map(([version, key]) => ({
              version,
              keyBase64url: key.toString('base64url'),
            })),
          }),
        ],
      ] as const)
        await writeFile(file, value, { mode: 0o600 });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const status = await runRestoreCommand({
        args: [
          'restore',
          restoreRef,
          archive.backupRef,
          checkpoint.checkpointRef,
          Buffer.from(JSON.stringify(metadata)).toString('base64'),
        ],
        environment: {
          NODE_ENV: 'production',
          MODEL_EXECUTION_ENABLED: 'false',
          OUTBOUND_EXECUTION_ENABLED: 'false',
          N8N_EXECUTION_ENABLED: 'false',
          OPS_OPERATION_REFERENCE: operationRef,
          OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: actualSource.id,
          OPS_SOURCE_DATABASE_NAME: sourceName,
          OPS_DATABASE_ROLE_PREFIX: prefix,
          OPS_DATABASE_SCHEMA: snapshot.schema,
          OPS_GIT_REVISION: metadata.gitRevision,
          OPS_SCHEMA_REVISION: metadata.schemaRevision,
          RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
          RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
          ...secretFiles,
          RECOVERY_MANIFEST_HMAC_FILE: manifestHmacFile,
          BACKUP_AGE_IDENTITY_FILE: identityFile,
          RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY: directory,
          BACKUP_ARCHIVE_DIRECTORY: archiveDirectory,
          CHECKPOINT_ARCHIVE_DIRECTORY: archiveDirectory,
          BACKUP_TMPFS_DIRECTORY: temporaryDirectory,
          OPS_MAX_CALL_MS: '10000',
          CHECKPOINT_MAX_AGE_MS: '60000',
          CHECKPOINT_MAX_ROWS: '1000',
          CHECKPOINT_MAX_PAYLOAD_BYTES: '1048576',
          RESTORE_BATCH_LIMIT: '1',
          RESTORE_MAX_BATCHES: '10',
        },
        now: () => at,
        createPool: (configuration) => {
          configurations.push(configuration);
          const pool = new pg.Pool(configuration);
          pools.push(pool);
          return pool;
        },
        write: (line) => {
          expect(pools).toHaveLength(4);
          expect(pools.every((pool) => pool.ended && pool.totalCount === 0)).toBe(true);
          stdout.push(line);
        },
        error: (line) => {
          stderr.push(line);
        },
      });
      expect({ status, stdout, stderr }).toEqual({
        status: 0,
        stdout: ['{"status":"completed","processed":1,"reasonCode":"ok"}\n'],
        stderr: [],
      });
      expect(
        configurations.map(
          (configuration) => new URL(configuration.connectionString ?? '').username,
        ),
      ).toEqual([`${prefix}_checkpoint`, `${prefix}_backup`, 'postgres', `${prefix}_migrator`]);
      expect(
        configurations.every(
          (configuration) =>
            configuration.application_name === operationApplicationName(operationRef),
        ),
      ).toBe(true);
      expect(
        configurations
          .slice(0, 2)
          .every((configuration) =>
            configuration.options?.includes('default_transaction_read_only=on'),
          ),
      ).toBe(true);
      expect(
        (
          await target.query(
            `select count(*)::int as count from "${snapshot.schema}".webhook_receipts`,
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      expect(
        (
          await target.query(
            `select message_text is null as erased from "${snapshot.schema}".webhook_events where id=$1`,
            [deleted.eventId],
          )
        ).rows,
      ).toEqual([{ erased: true }]);
      expect(
        (
          await target.query(
            `select message_text is not null as preserved from "${snapshot.schema}".webhook_events where id=$1`,
            [preserved.eventId],
          )
        ).rows,
      ).toEqual([{ preserved: true }]);
      expect(
        (
          await snapshot.pool.query(
            'select message_text is not null as preserved from webhook_events where id=$1',
            [deleted.eventId],
          )
        ).rows,
      ).toEqual([{ preserved: true }]);
      expect(
        (await target.query(`select state from "${snapshot.schema}".runtime_processing_work`)).rows,
      ).toEqual([{ state: 'quarantined' }]);
      expect(
        (
          await target.query(
            `select count(*)::int as count from "${snapshot.schema}".runtime_restore_quarantine where restore_ref=$1 and source_kind='processing_work'`,
            [restoreRef],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await target.query(
            `select exists(select 1 from "${snapshot.schema}".runtime_recovery_holds hold where hold.restore_ref=$1 and not exists(select 1 from "${snapshot.schema}".runtime_recovery_reviews review where review.restore_ref=hold.restore_ref)) as held`,
            [restoreRef],
          )
        ).rows,
      ).toEqual([{ held: true }]);
      expect(
        (
          await target.query(
            `select source_system_identifier=$2 as source_matches,checkpoint_ref=$3 as checkpoint_matches from "${snapshot.schema}".operations_restore_bindings where restore_ref=$1`,
            [restoreRef, actualSource.id, checkpoint.checkpointRef],
          )
        ).rows,
      ).toEqual([{ source_matches: true, checkpoint_matches: true }]);
      expect(
        (
          await target.query(
            `select not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls as restricted from pg_catalog.pg_roles where rolname=$1`,
            [`${prefix}_migrator`],
          )
        ).rows,
      ).toEqual([{ restricted: true }]);
      for (const authority of [snapshot.pool, target])
        expect(
          (
            await authority.query(
              'select count(*)::int as count from pg_catalog.pg_stat_activity where application_name=$1',
              [operationApplicationName(operationRef)],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
      const promotionAt = new Date(at.getTime() + 2000);
      await snapshot.pool.query(
        `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
        values($1,'whatsapp','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
        [
          createIdentityHmac(
            { ...deletedIdentity, externalContactId: `CONTACT_TEST_command_preserved_${marker}` },
            { key: privacyKey, version: 'TEST_v1' },
          ),
          promotionAt,
        ],
      );
      const freshExporter = new pg.Pool({ connectionString: sourceUrl('checkpoint'), max: 1 });
      const freshCheckpoint = await (async () => {
        try {
          return await exportDeletionCheckpoint({
            sourcePool: freshExporter,
            expectedDatabaseIdentity: {
              systemIdentifier: actualSource.id,
              databaseName: sourceName,
            },
            recipientFile: join(root, 'recipient'),
            signingKey,
            archiveDirectory,
            sourceRevision: 'a'.repeat(40),
            schemaRevision: '000016',
            now: promotionAt,
            timeoutMilliseconds: 10000,
            maximumRows: 1000,
            maximumPayloadBytes: 1048576,
          });
        } finally {
          await freshExporter.end();
        }
      })();
      const verificationRef = `restore_${randomUUID().replaceAll('-', '')}`;
      const promotionOperationRef = `operation_${randomUUID().replaceAll('-', '')}`;
      const promotionInput = new PassThrough();
      const promotionPools: pg.Pool[] = [];
      const requests: Record<string, unknown>[] = [];
      const completion: string[] = [];
      const promotionErrors: string[] = [];
      const targetProbe = target;
      const promotionStatus = await runPromotionCommand({
        args: [
          'promote',
          restoreRef,
          verificationRef,
          archive.backupRef,
          freshCheckpoint.checkpointRef,
          Buffer.from(JSON.stringify(metadata)).toString('base64'),
        ],
        environment: {
          NODE_ENV: 'production',
          MODEL_EXECUTION_ENABLED: 'false',
          OUTBOUND_EXECUTION_ENABLED: 'false',
          N8N_EXECUTION_ENABLED: 'false',
          OPS_OPERATION_REFERENCE: promotionOperationRef,
          OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER: actualSource.id,
          OPS_SOURCE_DATABASE_NAME: sourceName,
          OPS_DATABASE_ROLE_PREFIX: prefix,
          OPS_DATABASE_SCHEMA: snapshot.schema,
          OPS_GIT_REVISION: metadata.gitRevision,
          OPS_SCHEMA_REVISION: metadata.schemaRevision,
          RESTORE_SOURCE_SERVICE_ALIAS: 'fcd-support-source-postgres',
          RESTORE_TARGET_SERVICE_ALIAS: 'fcd-support-restore-postgres',
          RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE:
            secretFiles.RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE,
          RESTORE_TARGET_OWNER_DATABASE_URL_FILE:
            secretFiles.RESTORE_TARGET_OWNER_DATABASE_URL_FILE,
          PRIVACY_HMAC_KEYRING_FILE: secretFiles.PRIVACY_HMAC_KEYRING_FILE,
          RECOVERY_MANIFEST_HMAC_FILE: manifestHmacFile,
          BACKUP_AGE_IDENTITY_FILE: identityFile,
          CHECKPOINT_ARCHIVE_DIRECTORY: archiveDirectory,
          OPS_MAX_CALL_MS: '10000',
          PROMOTION_HOST_CHECK_TIMEOUT_MS: '5000',
          CHECKPOINT_MAX_AGE_MS: '60000',
          CHECKPOINT_MAX_ROWS: '1000',
          CHECKPOINT_MAX_PAYLOAD_BYTES: '1048576',
          RESTORE_BATCH_LIMIT: '1',
          RESTORE_MAX_BATCHES: '10',
        },
        input: promotionInput,
        now: () => promotionAt,
        createPool: (configuration) => {
          const native = new pg.Pool(configuration);
          promotionPools.push(native);
          pools.push(native);
          return native;
        },
        write: async (line) => {
          const request = JSON.parse(line) as Record<string, unknown>;
          if (request.event !== 'promotion_host_check') {
            expect(promotionPools).toHaveLength(2);
            expect(promotionPools.every((native) => native.ended && native.totalCount === 0)).toBe(
              true,
            );
            completion.push(line);
            return;
          }
          expect(request.operationRef === promotionOperationRef).toBe(true);
          expect(request.sequence).toBe(requests.length + 1);
          expect(request.challenge).toMatch(/^[a-f0-9]{32}$/u);
          requests.push(request);
          // The synthetic controller independently samples both actual clusters
          // after each request, then returns the exact challenge over queued stdio.
          await new Promise<void>((done, reject) => {
            queueMicrotask(() => {
              void Promise.all([
                snapshot.pool.query<{ id: string }>(
                  'select system_identifier::text as id from pg_catalog.pg_control_system()',
                ),
                targetProbe.query<{ id: string }>(
                  'select system_identifier::text as id from pg_catalog.pg_control_system()',
                ),
              ])
                .then(([sourceSample, targetSample]) => {
                  expect(sourceSample.rows[0]?.id === actualSource.id).toBe(true);
                  expect(targetSample.rows[0]?.id === targetSystemIdentifier).toBe(true);
                  promotionInput.write(
                    Buffer.from(
                      JSON.stringify({ ...request, event: 'promotion_host_verified' }) + '\n',
                    ),
                  );
                  done();
                })
                .catch(() => {
                  reject(new Error('synthetic_promotion_host_sample_failed'));
                });
            });
          });
        },
        error: (line) => {
          promotionErrors.push(line);
        },
      });
      promotionInput.destroy();
      expect({ status: promotionStatus, stdout: completion, stderr: promotionErrors }).toEqual({
        status: 0,
        stdout: ['{"status":"completed","processed":1,"reasonCode":"ok"}\n'],
        stderr: [],
      });
      expect(requests).toHaveLength(2);
      expect(new Set(requests.map((request) => request.challenge)).size).toBe(2);
      expect(
        (
          await target.query(
            `select count(*)::int as count from "${snapshot.schema}".webhook_events where message_text is null`,
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      expect(
        (
          await target.query(
            `select count(*) filter(where restore_ref=$1 and checkpoint_ref=$3)::int as original,count(*) filter(where restore_ref=$2 and checkpoint_ref=$4)::int as fresh from "${snapshot.schema}".operations_restore_bindings`,
            [restoreRef, verificationRef, checkpoint.checkpointRef, freshCheckpoint.checkpointRef],
          )
        ).rows,
      ).toEqual([{ original: 1, fresh: 1 }]);
      expect(
        (
          await target.query(
            `select count(*)::int as count from "${snapshot.schema}".runtime_recovery_holds hold where hold.restore_ref in ($1,$2) and not exists(select 1 from "${snapshot.schema}".runtime_recovery_reviews review where review.restore_ref=hold.restore_ref)`,
            [restoreRef, verificationRef],
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      for (const authority of [snapshot.pool, target])
        expect(
          (
            await authority.query(
              'select count(*)::int as count from pg_catalog.pg_stat_activity where application_name=$1',
              [operationApplicationName(promotionOperationRef)],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
    } finally {
      for (const pool of pools) if (!pool.ended) await pool.end();
      await target?.end();
      if (targetCreated) await targetOwner.query(`drop database "${sourceName}"`);
      await snapshot.dispose();
      cleanup.snapshots.delete(snapshot);
      for (const role of roles) {
        await source.pool.query(`drop role if exists "${prefix}_${role}"`);
        await targetOwner.query(`drop role if exists "${prefix}_${role}"`);
      }
      if (targetPostgresCreated) await targetOwner.query('drop role postgres');
      await rm(directory, { recursive: true, force: true });
    }
  },
  40000,
);
