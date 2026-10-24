import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { z } from 'zod';
import type { AdminSecretBytes } from '../admin/admin-types.js';
import { PostgresRestoreDeletionGate } from '../persistence/postgres-restore-deletion-gate.js';
import { PostgresRestoreFence } from '../persistence/postgres-restore-fence.js';
import {
  PostgresRestoreEvidence,
  restoreTargetIdentitySchema,
  type RestoreBinding,
  type RestoreTargetIdentity,
} from '../persistence/postgres-restore-evidence.js';
import { requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import {
  assertCheckpointCurrent,
  importDeletionCheckpoint,
  readCheckpointWatermark,
  type CheckpointManifest,
} from './deletion-checkpoint.js';
import { runForwardMigrations } from './forward-migration.js';
import {
  archiveDatabaseConnection,
  readBackupManifest,
  requireBackupDirectory,
  runArchivePipeline,
  verifyEncryptedBackup,
  writeArchiveExclusive,
  type BackupManifest,
  type BackupProcessPort,
} from './backup.js';

/** Internal SQL/stream leg only. The host controller must independently prove
 * fresh volume/network isolation before invoking this primitive. It neither
 * attaches applications nor produces deletion/promotion readiness evidence. */
export interface EncryptedRestoreOptions {
  readonly sourcePool: pg.Pool;
  readonly targetConnectionString: string;
  readonly expectedTargetSystemIdentifier: string;
  readonly schema: string;
  readonly backupRef: string;
  readonly archiveDirectory: string;
  readonly temporaryDirectory: string;
  readonly manifestHmacFile: string;
  readonly identityFile: string;
  readonly timeoutMilliseconds: number;
  readonly processes?: BackupProcessPort;
}
export interface EncryptedRestoreEvidence {
  readonly status: 'restored';
  readonly backupRef: string;
  readonly schemaRevision: string;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
}

/** Internal database orchestration. The caller is the trusted operations plane,
 * not an HTTP/model input. Host isolation and Docker identities must be proven
 * independently; these functions do not inspect Docker or attach applications. */
export interface RestoreOptions extends EncryptedRestoreOptions {
  readonly targetPool: pg.Pool;
  readonly target: RestoreTargetIdentity;
  readonly restoreRef: string;
  readonly gitRevision: string;
  readonly expectedSchemaRevision: string;
  readonly keyring: PrivacyHmacKeyring;
  readonly checkpoint: CheckpointManifest;
  readonly checkpointArchiveFile: string;
  readonly checkpointSigningKey: AdminSecretBytes;
  readonly maximumCheckpointAgeMilliseconds: number;
  readonly maximumCheckpointRows: number;
  readonly maximumCheckpointPayloadBytes: number;
  readonly batchLimit: number;
  readonly maximumBatches: number;
  readonly clock: () => Date;
}
export interface RestoreEvidence extends RestoreBinding {
  readonly status: 'deletion_verified';
  readonly quarantined: number;
  readonly erasedIdentities: number;
  readonly batches: number;
}

type ReconciliationOptions = Omit<
  RestoreOptions,
  | 'targetConnectionString'
  | 'expectedTargetSystemIdentifier'
  | 'schema'
  | 'archiveDirectory'
  | 'temporaryDirectory'
  | 'manifestHmacFile'
  | 'backupRef'
> & { readonly backupRef?: string };

/** Trusted host-control capability only. The caller retains its deployment lock,
 * verified isolation and ALL application shutdown from before this call through
 * the switch. Neither this return value nor historical evidence is a token.
 * A new verificationRef preserves the original immutable restore/import. */
export interface PromotionOptions extends Omit<ReconciliationOptions, 'backupRef'> {
  readonly verificationRef: string;
  readonly assertQuiesced: (signal: AbortSignal) => Promise<unknown>;
}

async function beginRestoreTransaction(client: pg.PoolClient, milliseconds: number) {
  await client.query('begin isolation level read committed');
  await client.query(
    "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true),set_config('transaction_timeout',$1,true)",
    [`${String(milliseconds)}ms`],
  );
}

async function requireRestoreTargetDatabase(
  client: pg.PoolClient,
  identity: RestoreTargetIdentity,
) {
  const actual = (
    await client.query<{ id: string; name: string }>(
      'select system_identifier::text as id,current_database() as name from pg_control_system()',
    )
  ).rows[0];
  if (actual?.id !== identity.systemIdentifier || actual.name !== identity.databaseName)
    throw new Error('invalid');
}

function validateReconciliation(options: ReconciliationOptions, beganAt?: Date) {
  z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
  z.string()
    .regex(/^restore_[a-f0-9]{32}$/u)
    .parse(options.restoreRef);
  z.string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(options.gitRevision);
  z.string()
    .regex(/^[0-9]{6}$/u)
    .parse(options.expectedSchemaRevision);
  z.number().int().min(1).max(1000).parse(options.batchLimit);
  z.number().int().min(1).max(1000000).parse(options.maximumBatches);
  z.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(options.maximumCheckpointAgeMilliseconds);
  z.number().int().positive().max(2147483647).parse(options.maximumCheckpointRows);
  z.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(options.maximumCheckpointPayloadBytes);
  const identity = restoreTargetIdentitySchema.parse(options.target);
  if (options.sourcePool === options.targetPool) throw new Error('invalid');
  const keyring = requirePrivacyHmacKeyring(options.keyring);
  const startedAt = z.date().parse(beganAt ?? options.clock());
  return { identity, keyring, startedAt };
}

export async function restoreAndReconcile(options: RestoreOptions): Promise<RestoreEvidence> {
  try {
    const { identity, startedAt } = validateReconciliation(options);
    const connection = archiveDatabaseConnection(options.targetConnectionString);
    if (
      identity.systemIdentifier !== options.expectedTargetSystemIdentifier ||
      identity.databaseName !== connection.env.PGDATABASE ||
      identity.schema !== options.schema
    )
      throw new Error('invalid');
    // Cheap current-source validation before the SQL stream; repeat under the
    // retained freeze after migration. A precheck alone is never authority.
    await assertCheckpointCurrent(options.sourcePool, options.checkpoint, {
      signingKey: options.checkpointSigningKey,
      evaluatedAt: startedAt,
      maximumAgeMilliseconds: options.maximumCheckpointAgeMilliseconds,
    });
    const restored = await restoreEncryptedBackup(options);
    // A caller-supplied pool is a distinct capability from the stream URI.
    // Bind the actual migration-owning connection BEFORE it can execute DDL.
    await runForwardMigrations(options.targetPool, {
      schema: options.schema,
      expectedSchemaRevision: options.expectedSchemaRevision,
      timeoutMilliseconds: options.timeoutMilliseconds,
      expectedDatabaseIdentity: {
        systemIdentifier: identity.systemIdentifier,
        databaseName: identity.databaseName,
      },
    });
    return await reconcileRestoredTarget(options, startedAt, restored.sourceSystemIdentifier);
  } catch {
    throw new Error('restore_reconciliation_failed');
  }
}

export async function verifyPromotion(options: PromotionOptions): Promise<{ status: 'ready' }> {
  try {
    const { startedAt } = validateReconciliation(options);
    z.string()
      .regex(/^restore_[a-f0-9]{32}$/u)
      .parse(options.verificationRef);
    if (
      options.verificationRef === options.restoreRef ||
      typeof options.assertQuiesced !== 'function'
    )
      throw new Error('invalid');
    const assertQuiesced = async () => {
      const finished = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => options.assertQuiesced(finished.signal))
            .then((outcome) => {
              if (finished.signal.aborted || outcome !== undefined) throw new Error('invalid');
            }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('invalid'));
              finished.abort();
            }, options.timeoutMilliseconds);
          }),
        ]);
      } finally {
        finished.abort();
        clearTimeout(timer);
      }
    };
    await assertQuiesced();
    await reconcileRestoredTarget(
      { ...options, restoreRef: options.verificationRef },
      startedAt,
      undefined,
      { restoreRef: options.restoreRef, assertQuiesced },
    );
    return { status: 'ready' };
  } catch {
    throw new Error('promotion_verification_failed');
  }
}

async function reconcileRestoredTarget(
  options: ReconciliationOptions,
  startedAt: Date,
  expectedSourceIdentifier?: string,
  promotion?: { readonly restoreRef: string; readonly assertQuiesced: () => Promise<void> },
): Promise<RestoreEvidence> {
  let source: pg.PoolClient | undefined;
  let target: pg.PoolClient | undefined;
  try {
    const { identity, keyring } = validateReconciliation(options, startedAt);
    source = await options.sourcePool.connect();
    await beginRestoreTransaction(source, options.timeoutMilliseconds);
    const helper = (
      await source.query<{ present: boolean }>(
        "select to_regprocedure('lock_deletion_checkpoint_source()') is not null as present",
      )
    ).rows[0];
    if (helper?.present === true) await source.query('select lock_deletion_checkpoint_source()');
    else await source.query('lock table privacy_suppressions in share mode');
    const frozenSource = { transactionClient: source };
    const sourceSystemIdentifier = await systemIdentifier(source);
    if (
      sourceSystemIdentifier === identity.systemIdentifier ||
      (expectedSourceIdentifier !== undefined &&
        sourceSystemIdentifier !== expectedSourceIdentifier)
    )
      throw new Error('invalid');
    const evaluatedAt = z.date().parse(options.clock());
    if (evaluatedAt < startedAt) throw new Error('invalid');
    const validateCurrent = async (at: Date) => {
      if (at < evaluatedAt) throw new Error('invalid');
      await assertCheckpointCurrent(frozenSource, options.checkpoint, {
        signingKey: options.checkpointSigningKey,
        evaluatedAt: at,
        maximumAgeMilliseconds: options.maximumCheckpointAgeMilliseconds,
      });
      if ((await systemIdentifier(frozenSource.transactionClient)) !== sourceSystemIdentifier)
        throw new Error('invalid');
    };
    await validateCurrent(evaluatedAt);
    target = await options.targetPool.connect();
    await beginRestoreTransaction(target, options.timeoutMilliseconds);
    await target.query(`set local search_path="${identity.schema}",public`);
    await requireRestoreTargetDatabase(target, identity);
    const locked = await target.query<{ acquired: boolean }>(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired',
      [`fcd-support:deployment:${identity.schema}`],
    );
    if (locked.rows[0]?.acquired !== true) throw new Error('invalid');
    let backupRef = options.backupRef;
    if (promotion !== undefined) {
      // Keep recovery review and parent evidence stable through the fresh pass.
      await target.query(
        'lock table operations_restore_runs,operations_restore_bindings,runtime_recovery_holds,runtime_recovery_reviews in share row exclusive mode',
      );
      const parent = await new PostgresRestoreEvidence({ transactionClient: target }).load(
        promotion.restoreRef,
      );
      const held = (
        await target.query<{ held: boolean }>(
          `select exists(
        select 1 from runtime_recovery_holds hold where hold.restore_ref=$1 and hold.created_at <= $2
        and not exists(select 1 from runtime_recovery_reviews review where review.restore_ref=hold.restore_ref)
        and not exists(select 1 from operations_restore_runs run where run.restore_ref=hold.restore_ref and run.state='failed')
      ) as held`,
          [promotion.restoreRef, evaluatedAt],
        )
      ).rows[0]?.held;
      if (
        held !== true ||
        parent.gitRevision !== options.gitRevision ||
        parent.schemaRevision !== options.expectedSchemaRevision ||
        parent.sourceSystemIdentifier !== sourceSystemIdentifier ||
        parent.sourceWatermark.sourceEpoch !== options.checkpoint.watermark.sourceEpoch ||
        BigInt(options.checkpoint.watermark.sequence) < BigInt(parent.sourceWatermark.sequence) ||
        parent.recordedAt > evaluatedAt ||
        JSON.stringify(parent.target) !== JSON.stringify(identity)
      )
        throw new Error('invalid');
      backupRef = parent.backupRef;
    }
    backupRef = z
      .string()
      .regex(/^backup_[a-f0-9]{32}$/u)
      .parse(backupRef);
    await target.query(
      "insert into operations_restore_runs(restore_ref,backup_ref,checkpoint_ref,git_revision,schema_revision,state,recorded_at) values($1,$2,$3,$4,$5,'isolated',$6)",
      [
        options.restoreRef,
        backupRef,
        options.checkpoint.checkpointRef,
        options.gitRevision,
        options.expectedSchemaRevision,
        evaluatedAt,
      ],
    );
    const targetTransaction = { transactionClient: target };
    await importDeletionCheckpoint({
      targetPool: targetTransaction,
      currentSourcePool: frozenSource,
      archiveFile: options.checkpointArchiveFile,
      identityFile: options.identityFile,
      signingKey: options.checkpointSigningKey,
      expectedManifest: options.checkpoint,
      expectedCurrentWatermark: await readCheckpointWatermark(frozenSource),
      evaluatedAt,
      maximumAgeMilliseconds: options.maximumCheckpointAgeMilliseconds,
      restoreRef: options.restoreRef,
      timeoutMilliseconds: options.timeoutMilliseconds,
      maximumRows: options.maximumCheckpointRows,
      maximumPayloadBytes: options.maximumCheckpointPayloadBytes,
      ...(options.processes === undefined ? {} : { processes: options.processes }),
    });
    const fence = await new PostgresRestoreFence(targetTransaction).quarantine({
      restoreRef: options.restoreRef,
      evaluatedAt,
    });
    const activeVersions = await target.query<{ key_version: string }>(
      `select distinct key_version from privacy_suppressions where category='deletion_tombstone'
      and effective_at <= $1 and (expires_at is null or expires_at > $1) order by key_version`,
      [evaluatedAt],
    );
    const requiredKeyVersions = [
      ...new Set([...activeVersions.rows.map((row) => row.key_version), keyring.activeVersion]),
    ].sort();
    // Crossing a target-only activation/expiry boundary also invalidates the
    // fixed-time gate, even when no source write advanced its durable clock.
    const boundary = (
      await target.query<{ at: Date | null }>(
        `select min(at) as at from (
      select effective_at as at from privacy_suppressions where category='deletion_tombstone' and effective_at>$1
      union all select expires_at from privacy_suppressions where category='deletion_tombstone' and expires_at>$1) boundaries`,
        [evaluatedAt],
      )
    ).rows[0]?.at;
    const gate = new PostgresRestoreDeletionGate(targetTransaction, keyring);
    const gateRef = `gate_${randomUUID().replaceAll('-', '')}`;
    const common = { gateRef, gitRevision: options.gitRevision, evaluatedAt, requiredKeyVersions };
    let batches = 0;
    let erasedIdentities = 0;
    let remaining = 1;
    while (remaining !== 0 && batches < options.maximumBatches) {
      const result = await gate.reapplyBatch({
        ...common,
        requestKey: `${gateRef}:batch:${String(batches)}`,
        limit: options.batchLimit,
      });
      if (result.status !== 'applied') throw new Error('invalid');
      erasedIdentities += result.identitiesProcessed;
      remaining = result.remainingMatches;
      batches++;
    }
    if (remaining !== 0) throw new Error('invalid');
    await gate.finalizeGate({ ...common, requestKey: `${gateRef}:final` });
    const finishedAt = z.date().parse(options.clock());
    if (boundary !== undefined && boundary !== null && finishedAt >= boundary)
      throw new Error('invalid');
    await validateCurrent(finishedAt);
    const binding = await new PostgresRestoreEvidence(targetTransaction).seal({
      restoreRef: options.restoreRef,
      backupRef,
      checkpointRef: options.checkpoint.checkpointRef,
      gitRevision: options.gitRevision,
      schemaRevision: options.expectedSchemaRevision,
      target: identity,
      sourceSystemIdentifier,
      gateRef,
      requiredKeyVersions,
      evaluatedAt,
    });
    await promotion?.assertQuiesced();
    const sealedAt = z.date().parse(options.clock());
    if (
      sealedAt < finishedAt ||
      (boundary !== undefined && boundary !== null && sealedAt >= boundary)
    )
      throw new Error('invalid');
    await validateCurrent(sealedAt);
    await target.query('commit');
    // This remains historical database evidence, not a transferable ready token.
    // Promotion must separately freeze/revalidate the real source and host target.
    return {
      ...binding,
      status: 'deletion_verified',
      quarantined: fence.quarantined,
      erasedIdentities,
      batches,
    };
  } catch {
    throw new Error('restore_reconciliation_failed');
  } finally {
    // Destroy one-shot sessions even on success: borrowed services must not leak
    // a transaction, search_path, freeze, or operation timeout into runtime work.
    for (const client of [target, source]) {
      if (client === undefined) continue;
      try {
        await client.query('rollback');
      } catch {
        /* The one-shot session is always destroyed. */
      } finally {
        client.release(true);
      }
    }
  }
}

async function systemIdentifier(client: pg.PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select system_identifier::text as id from pg_catalog.pg_control_system()',
  );
  return z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .parse(result.rows[0]?.id);
}
async function cataloguedManifest(
  client: pg.PoolClient,
  options: EncryptedRestoreOptions,
): Promise<BackupManifest> {
  const manifest = await readBackupManifest(
    options.archiveDirectory,
    options.backupRef,
    options.manifestHmacFile,
  );
  const result = await client.query<{
    state: string;
    class: string;
    created_at: Date;
    git_revision: string;
    schema_revision: string;
    ciphertext_bytes: string;
    ciphertext_sha256: string;
  }>(
    'select state,class,created_at,git_revision,schema_revision,ciphertext_bytes,ciphertext_sha256 from operations_backups where backup_ref=$1',
    [options.backupRef],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    result.rows.length !== 1 ||
    !['verified', 'restore_verified'].includes(row.state) ||
    manifest.state !== 'created' ||
    manifest.class !== row.class ||
    manifest.createdAt !== row.created_at.toISOString() ||
    manifest.gitRevision !== row.git_revision ||
    manifest.schemaRevision !== row.schema_revision ||
    manifest.ciphertextBytes !== Number(row.ciphertext_bytes) ||
    manifest.ciphertextSha256 !== row.ciphertext_sha256
  )
    throw new Error('invalid');
  return manifest;
}

async function requireEmptyDatabase(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ empty: boolean }>(`
    select
      not exists(select 1 from pg_catalog.pg_namespace
        where nspname !~ '^pg_' and nspname not in ('public','information_schema'))
      and not exists(select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
      and not exists(select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
      and not exists(select 1 from pg_catalog.pg_type t
        join pg_catalog.pg_namespace n on n.oid=t.typnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
      and not exists(select 1 from pg_catalog.pg_extension where extname <> 'plpgsql')
      and not exists(select 1 from pg_catalog.pg_largeobject_metadata)
      and not exists(select 1 from pg_catalog.pg_stat_activity
        where datname=current_database() and pid <> pg_backend_pid()) as empty`);
  if (result.rows[0]?.empty !== true) throw new Error('invalid');
}

async function closeRestoreAttempt(
  source: pg.PoolClient | undefined,
  target: pg.PoolClient | undefined,
  pool: pg.Pool | undefined,
  workDirectory: string | undefined,
) {
  let failed = false;
  for (const client of [source, target]) {
    try {
      client?.release(true);
    } catch {
      failed = true;
    }
  }
  try {
    await pool?.end();
  } catch {
    failed = true;
  }
  if (workDirectory !== undefined) {
    try {
      await rm(workDirectory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('restore_failed');
}

export async function restoreEncryptedBackup(
  options: EncryptedRestoreOptions,
): Promise<EncryptedRestoreEvidence> {
  let source: pg.PoolClient | undefined;
  let target: pg.PoolClient | undefined;
  let targetPool: pg.Pool | undefined;
  let workDirectory: string | undefined;
  let failure = 'restore_failed';
  try {
    z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
    z.string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(options.schema);
    z.string()
      .regex(/^[1-9][0-9]{0,19}$/u)
      .parse(options.expectedTargetSystemIdentifier);
    const connection = archiveDatabaseConnection(options.targetConnectionString);
    const database = z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(connection.env.PGDATABASE);
    source = await options.sourcePool.connect();
    await source.query("select set_config('statement_timeout',$1,false)", [
      `${String(options.timeoutMilliseconds)}ms`,
    ]);
    failure = 'restore_archive_invalid';
    const manifest = await cataloguedManifest(source, options);
    failure = 'restore_target_invalid';
    const sourceSystemIdentifier = await systemIdentifier(source);
    targetPool = new pg.Pool({
      connectionString: options.targetConnectionString,
      ssl: false,
      max: 1,
      connectionTimeoutMillis: options.timeoutMilliseconds,
      statement_timeout: options.timeoutMilliseconds,
      application_name: 'fcd-support-restore-control',
    });
    target = await targetPool.connect();
    const targetSystemIdentifier = await systemIdentifier(target);
    if (
      targetSystemIdentifier === sourceSystemIdentifier ||
      targetSystemIdentifier !== options.expectedTargetSystemIdentifier
    )
      throw new Error('invalid');
    const locked = await target.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended('fcd-support:isolated-restore',0)) as acquired",
    );
    if (locked.rows[0]?.acquired !== true) throw new Error('invalid');
    await requireEmptyDatabase(target);
    failure = 'restore_failed';
    await verifyEncryptedBackup({ ...options, expectedManifest: manifest });
    await requireBackupDirectory(options.temporaryDirectory);
    if (
      options.temporaryDirectory === options.archiveDirectory ||
      options.temporaryDirectory.startsWith(options.archiveDirectory + '/') ||
      options.archiveDirectory.startsWith(options.temporaryDirectory + '/') ||
      (process.platform === 'linux' &&
        (await statfs(options.temporaryDirectory)).type !== 0x01021994)
    )
      throw new Error('invalid');
    const candidate = join(options.temporaryDirectory, `restore_pgpass_${randomUUID()}`);
    await mkdir(candidate, { mode: 0o700 });
    workDirectory = candidate;
    const passFile = join(workDirectory, 'pgpass');
    await writeArchiveExclusive(passFile, connection.pass);
    // Recheck after the independent decrypt/list pass and before any SQL restore.
    await requireEmptyDatabase(target);
    const flags: Partial<typeof constants> = constants;
    const handle = await open(
      join(options.archiveDirectory, options.backupRef, 'archive.age'),
      constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== manifest.ciphertextBytes) throw new Error('invalid');
      const hash = createHash('sha256');
      let bytes = 0;
      const ciphertext = Readable.from(
        (async function* () {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            const buffer = chunk as Buffer;
            bytes += buffer.length;
            hash.update(buffer);
            yield buffer;
          }
        })(),
      );
      await runArchivePipeline(
        [
          { file: 'age', args: ['--decrypt', '--identity', options.identityFile] },
          {
            file: 'pg_restore',
            args: [
              '--exit-on-error',
              '--single-transaction',
              '--no-owner',
              '--no-acl',
              '--dbname',
              database,
            ],
            env: {
              ...connection.env,
              PGPASSFILE: passFile,
              PGAPPNAME: 'fcd-support-isolated-restore',
              PGOPTIONS: `-c statement_timeout=${String(options.timeoutMilliseconds)} -c lock_timeout=${String(options.timeoutMilliseconds)}`,
            },
          },
        ],
        options,
        ciphertext,
      );
      const after = await handle.stat();
      if (
        bytes !== manifest.ciphertextBytes ||
        hash.digest('hex') !== manifest.ciphertextSha256 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new Error('invalid');
    } finally {
      await handle.close();
    }
    if (
      (await systemIdentifier(target)) !== targetSystemIdentifier ||
      (await systemIdentifier(source)) !== sourceSystemIdentifier
    )
      throw new Error('invalid');
    const installed = await target.query<{ present: boolean }>(
      'select to_regclass($1) is not null as present',
      [`${options.schema}.pgmigrations`],
    );
    let schemaRevision = '000000';
    if (installed.rows[0]?.present === true) {
      const latest = await target.query<{ name: string }>(
        `select name from "${options.schema}".pgmigrations order by name desc limit 1`,
      );
      if (latest.rows.length !== 0)
        schemaRevision = z
          .string()
          .regex(/^[0-9]{6}_[a-z0-9_]+$/u)
          .parse(latest.rows[0]?.name)
          .slice(0, 6);
    }
    if (schemaRevision !== manifest.schemaRevision) throw new Error('invalid');
    return {
      status: 'restored',
      backupRef: manifest.backupRef,
      schemaRevision,
      sourceSystemIdentifier,
      targetSystemIdentifier,
    };
  } catch {
    throw new Error(failure);
  } finally {
    // Never drop target objects/volumes on error: an ambiguous stream must stay isolated.
    await closeRestoreAttempt(source, target, targetPool, workDirectory);
  }
}
