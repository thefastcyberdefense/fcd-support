import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type pg from 'pg';
import { z } from 'zod';
import { AdminSecretBytes } from '../admin/admin-types.js';
import { PostgresOperationsStore } from '../persistence/postgres-operations-store.js';
import type { TransactionSource } from '../persistence/postgres-transaction.js';
import {
  archiveCipherDigest,
  requireBackupDirectory,
  runArchivePipeline,
  syncArchiveDirectory,
  syncArchiveFile,
  writeArchiveExclusive,
  type BackupProcessPort,
} from './backup.js';
import { readSecretFile } from './secret-files.js';

const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const watermarkSchema = z.strictObject({
  sourceEpoch: z.uuid(),
  sequence: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/u)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
});
const materialSchema = z.strictObject({
  checkpointRef: z.string().regex(/^checkpoint_[a-f0-9]{32}$/u),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  schemaRevision: z.string().regex(/^[0-9]{6}$/u),
  snapshotAt: z.iso.datetime({ precision: 3 }),
  validUntil: z.iso.datetime({ precision: 3 }).nullable(),
  watermark: watermarkSchema,
  rowCount: z.number().int().min(0).max(2147483647),
  requiredKeyVersions: z
    .array(version)
    .max(1000)
    .refine(
      (keys) =>
        new Set(keys).size === keys.length &&
        [...keys].sort().every((key, index) => keys[index] === key),
    ),
  ciphertextBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const manifestSchema = materialSchema.extend({ signature: z.string().regex(/^[a-f0-9]{64}$/u) });
export type CheckpointWatermark = Readonly<z.infer<typeof watermarkSchema>>;
export type CheckpointManifest = Readonly<
  Omit<z.infer<typeof manifestSchema>, 'requiredKeyVersions' | 'watermark'>
> & {
  readonly watermark: CheckpointWatermark;
  readonly requiredKeyVersions: readonly string[];
};
const rowSchema = z.strictObject({
  identityHmac: z.string().regex(/^[a-f0-9]{64}$/u),
  channel: z.enum(['messenger', 'whatsapp']),
  keyVersion: version,
  effectiveAt: z.iso.datetime({ precision: 3 }),
  expiresAt: z.iso.datetime({ precision: 3 }).nullable(),
});
interface CheckpointLimits {
  readonly timeoutMilliseconds: number;
  readonly maximumRows: number;
  readonly maximumPayloadBytes: number;
  readonly processes?: BackupProcessPort;
}
export interface CheckpointExportOptions extends CheckpointLimits {
  readonly sourcePool: TransactionSource;
  readonly recipientFile: string;
  readonly signingKey: AdminSecretBytes;
  readonly archiveDirectory: string;
  readonly sourceRevision: string;
  readonly schemaRevision: string;
  readonly now: Date;
}
interface ValidationOptions {
  readonly signingKey: AdminSecretBytes;
  readonly expectedWatermark: CheckpointWatermark;
  readonly evaluatedAt: Date;
  readonly maximumAgeMilliseconds: number;
}
export interface CheckpointImportOptions extends CheckpointLimits {
  readonly targetPool: TransactionSource;
  readonly currentSourcePool?: TransactionSource;
  readonly archiveFile: string;
  readonly identityFile: string;
  readonly signingKey: AdminSecretBytes;
  readonly expectedManifest: CheckpointManifest;
  readonly expectedCurrentWatermark: CheckpointWatermark;
  readonly evaluatedAt: Date;
  readonly maximumAgeMilliseconds: number;
  readonly restoreRef: string;
}
function requireLimits(options: CheckpointLimits) {
  z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
  z.number().int().min(1).max(2147483647).parse(options.maximumRows);
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(options.maximumPayloadBytes);
}
function checkpointSignature(
  material: z.infer<typeof materialSchema>,
  secret: AdminSecretBytes,
): Buffer {
  if (!(secret instanceof AdminSecretBytes)) throw new Error('invalid');
  const key = secret.copy();
  try {
    if (key.length < 32 || key.length > 4096) throw new Error('invalid');
    return createHmac('sha256', key)
      .update('fcd-support:deletion-checkpoint:v1\n')
      .update(JSON.stringify(materialSchema.parse(material)))
      .digest();
  } finally {
    key.fill(0);
  }
}
async function checkpointTransaction<T>(
  source: TransactionSource,
  milliseconds: number,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if ('transactionClient' in source) {
    const isolation = (
      await source.transactionClient.query<{ transaction_isolation: string }>(
        'show transaction_isolation',
      )
    ).rows[0]?.transaction_isolation;
    if (isolation !== 'read committed') throw new Error('checkpoint_invalid');
    return operation(source.transactionClient);
  }
  const client = await source.connect();
  let destroy = false;
  try {
    // The privacy-table freeze, acquired before reading clock/rows, provides a
    // consistent snapshot without reusing a snapshot established before the lock.
    await client.query('begin');
    await client.query(
      "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true),set_config('transaction_timeout',$1,true)",
      [`${String(milliseconds)}ms`],
    );
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}
export async function readCheckpointWatermark(
  source: TransactionSource,
): Promise<CheckpointWatermark> {
  try {
    const query = 'transactionClient' in source ? source.transactionClient : source;
    const row = (
      await query.query<{ source_epoch: string; revision: string }>(
        'select source_epoch,revision from deletion_checkpoint_clock where singleton',
      )
    ).rows[0];
    if (row === undefined) throw new Error('invalid');
    return watermarkSchema.parse({ sourceEpoch: row.source_epoch, sequence: row.revision });
  } catch {
    throw new Error('checkpoint_invalid');
  }
}

export function validateCheckpointManifest(
  input: unknown,
  options: ValidationOptions,
): CheckpointManifest {
  try {
    const manifest = manifestSchema.parse(input);
    const expected = watermarkSchema.parse(options.expectedWatermark);
    const evaluatedAt = z.date().parse(options.evaluatedAt);
    const maximumAge = z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(options.maximumAgeMilliseconds);
    const elapsed = evaluatedAt.getTime() - new Date(manifest.snapshotAt).getTime();
    if (
      elapsed < 0 ||
      elapsed > maximumAge ||
      (manifest.validUntil !== null &&
        (new Date(manifest.validUntil) <= new Date(manifest.snapshotAt) ||
          evaluatedAt >= new Date(manifest.validUntil))) ||
      manifest.watermark.sourceEpoch !== expected.sourceEpoch ||
      manifest.watermark.sequence !== expected.sequence ||
      (manifest.rowCount === 0) !== (manifest.requiredKeyVersions.length === 0)
    )
      throw new Error('invalid');
    const { signature, ...material } = manifest;
    if (
      !timingSafeEqual(
        checkpointSignature(material, options.signingKey),
        Buffer.from(signature, 'hex'),
      )
    )
      throw new Error('invalid');
    return Object.freeze({
      ...manifest,
      watermark: Object.freeze(manifest.watermark),
      requiredKeyVersions: Object.freeze(manifest.requiredKeyVersions),
    });
  } catch {
    throw new Error('checkpoint_invalid');
  }
}

export async function assertCheckpointCurrent(
  source: TransactionSource,
  manifest: CheckpointManifest,
  options: Omit<ValidationOptions, 'expectedWatermark'>,
): Promise<void> {
  validateCheckpointManifest(manifest, {
    ...options,
    expectedWatermark: await readCheckpointWatermark(source),
  });
}
async function requireAgeFile(path: string, identity: boolean): Promise<void> {
  const bytes = await readSecretFile(path);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (identity) {
      const lines = text.split(/\r?\n/u).filter((line) => line !== '' && !line.startsWith('#'));
      const line = lines[0];
      if (
        lines.length !== 1 ||
        line === undefined ||
        !/^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/u.test(line)
      )
        throw new Error('invalid');
    } else if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u.test(text.replace(/\r?\n$/u, '')))
      throw new Error('invalid');
  } finally {
    bytes.fill(0);
  }
}
export async function exportDeletionCheckpoint(
  options: CheckpointExportOptions,
): Promise<CheckpointManifest> {
  let ownedDirectory: string | undefined;
  let complete = false;
  try {
    requireLimits(options);
    z.date().parse(options.now);
    await requireBackupDirectory(options.archiveDirectory);
    await requireAgeFile(options.recipientFile, false);
    const manifest = await checkpointTransaction(
      options.sourcePool,
      options.timeoutMilliseconds,
      async (client) => {
        await client.query('lock table privacy_suppressions in share mode');
        const watermark = await readCheckpointWatermark({ transactionClient: client });
        const result = await client.query<{
          identity_hmac: string;
          channel: string;
          key_version: string;
          effective_at: Date;
          expires_at: Date | null;
        }>(
          `select identity_hmac,channel,key_version,effective_at,expires_at from privacy_suppressions
        where category='deletion_tombstone' and effective_at <= $1 and (expires_at is null or expires_at > $1)
        order by channel,key_version,identity_hmac limit $2`,
          [options.now, options.maximumRows + 1],
        );
        if (result.rows.length > options.maximumRows) throw new Error('invalid');
        const rows = result.rows.map((row) =>
          rowSchema.parse({
            identityHmac: row.identity_hmac,
            channel: row.channel,
            keyVersion: row.key_version,
            effectiveAt: row.effective_at.toISOString(),
            expiresAt: row.expires_at?.toISOString() ?? null,
          }),
        );
        const boundary =
          (
            await client.query<{ valid_until: Date | null }>(
              `select min(boundary) as valid_until
        from privacy_suppressions cross join lateral (values(effective_at),(expires_at)) times(boundary)
        where category='deletion_tombstone' and boundary > $1`,
              [options.now],
            )
          ).rows[0]?.valid_until ?? null;
        const payload = {
          format: 'fcd-support-deletion-checkpoint-v1',
          snapshotAt: options.now.toISOString(),
          validUntil: boundary?.toISOString() ?? null,
          watermark,
          rows,
        };
        const bytes = Buffer.from(JSON.stringify(payload));
        if (bytes.length > options.maximumPayloadBytes) throw new Error('invalid');
        const checkpointRef = `checkpoint_${randomUUID().replaceAll('-', '')}`;
        const candidate = join(options.archiveDirectory, checkpointRef);
        await mkdir(candidate, { mode: 0o700 });
        ownedDirectory = candidate;
        const stage = join(candidate, 'archive.partial');
        try {
          await runArchivePipeline(
            [{ file: 'age', args: ['--encrypt', '--recipients-file', options.recipientFile] }],
            options,
            Readable.from([bytes]),
            createWriteStream(stage, { flags: 'wx', mode: 0o600 }),
          );
        } finally {
          bytes.fill(0);
        }
        await syncArchiveFile(stage);
        const material = materialSchema.parse({
          checkpointRef,
          sourceRevision: options.sourceRevision,
          schemaRevision: options.schemaRevision,
          snapshotAt: payload.snapshotAt,
          validUntil: payload.validUntil,
          watermark,
          rowCount: rows.length,
          requiredKeyVersions: [...new Set(rows.map((row) => row.keyVersion))].sort(),
          ...(await archiveCipherDigest(stage)),
        });
        const manifest = validateCheckpointManifest(
          {
            ...material,
            signature: checkpointSignature(material, options.signingKey).toString('hex'),
          },
          {
            signingKey: options.signingKey,
            expectedWatermark: watermark,
            evaluatedAt: options.now,
            maximumAgeMilliseconds: 1,
          },
        );
        await writeArchiveExclusive(
          join(candidate, 'manifest.partial'),
          JSON.stringify(manifest) + '\n',
        );
        await rename(stage, join(candidate, 'archive.age'));
        await syncArchiveDirectory(candidate);
        await rename(join(candidate, 'manifest.partial'), join(candidate, 'manifest.json'));
        await syncArchiveDirectory(candidate);
        await syncArchiveDirectory(options.archiveDirectory);
        await client.query(
          `insert into deletion_checkpoints(checkpoint_ref,source_epoch,sequence,source_revision,schema_revision,
        snapshot_at,valid_until,row_count,required_key_versions,ciphertext_bytes,ciphertext_sha256,signature)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            manifest.checkpointRef,
            watermark.sourceEpoch,
            watermark.sequence,
            manifest.sourceRevision,
            manifest.schemaRevision,
            options.now,
            boundary,
            manifest.rowCount,
            [...manifest.requiredKeyVersions],
            manifest.ciphertextBytes,
            manifest.ciphertextSha256,
            manifest.signature,
          ],
        );
        return manifest;
      },
    );
    complete = true;
    return manifest;
  } catch {
    try {
      await new PostgresOperationsStore(options.sourcePool).recordHealth({
        component: 'deletion_checkpoint',
        state: 'unavailable',
        reasonCode: 'collection_failed',
        checkedAt: new Date(),
        durationMilliseconds: 0,
      });
    } catch {
      /* The caller also reports a closed job failure. */
    }
    throw new Error('checkpoint_export_failed');
  } finally {
    if (!complete && ownedDirectory !== undefined)
      await rm(ownedDirectory, { recursive: true, force: true });
  }
}

export async function importDeletionCheckpoint(
  options: CheckpointImportOptions,
): Promise<{ imported: number }> {
  try {
    requireLimits(options);
    z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      .parse(options.restoreRef);
    const validation = {
      signingKey: options.signingKey,
      evaluatedAt: options.evaluatedAt,
      maximumAgeMilliseconds: options.maximumAgeMilliseconds,
      expectedWatermark: options.expectedCurrentWatermark,
    };
    const manifest = validateCheckpointManifest(options.expectedManifest, validation);
    if (manifest.rowCount > options.maximumRows) throw new Error('invalid');
    if (options.currentSourcePool !== undefined)
      await assertCheckpointCurrent(options.currentSourcePool, manifest, validation);
    const directory = dirname(options.archiveFile);
    const archiveDirectory = dirname(directory);
    if (join(archiveDirectory, manifest.checkpointRef, 'archive.age') !== options.archiveFile)
      throw new Error('invalid');
    await requireBackupDirectory(archiveDirectory);
    await requireBackupDirectory(directory);
    const sidecar = await readSecretFile(join(directory, 'manifest.json'));
    const disk = validateCheckpointManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sidecar)),
      validation,
    );
    if (JSON.stringify(disk) !== JSON.stringify(manifest)) throw new Error('invalid');
    const digest = await archiveCipherDigest(options.archiveFile);
    if (
      digest.ciphertextBytes !== manifest.ciphertextBytes ||
      digest.ciphertextSha256 !== manifest.ciphertextSha256
    )
      throw new Error('invalid');
    await requireAgeFile(options.identityFile, true);
    const chunks: Buffer[] = [];
    let length = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        length += chunk.length;
        if (length > options.maximumPayloadBytes) done(new Error('checkpoint_payload_invalid'));
        else {
          chunks.push(Buffer.from(chunk));
          done();
        }
      },
    });
    let payload: unknown;
    try {
      await runArchivePipeline(
        [{ file: 'age', args: ['--decrypt', '--identity', options.identityFile] }],
        options,
        createReadStream(options.archiveFile),
        sink,
      );
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
    const parsed = z
      .strictObject({
        format: z.literal('fcd-support-deletion-checkpoint-v1'),
        snapshotAt: z.iso.datetime({ precision: 3 }),
        validUntil: z.iso.datetime({ precision: 3 }).nullable(),
        watermark: watermarkSchema,
        rows: z.array(rowSchema).max(options.maximumRows),
      })
      .parse(payload);
    const keys = [...new Set(parsed.rows.map((row) => row.keyVersion))].sort();
    if (
      parsed.snapshotAt !== manifest.snapshotAt ||
      parsed.validUntil !== manifest.validUntil ||
      parsed.rows.length !== manifest.rowCount ||
      JSON.stringify(parsed.watermark) !== JSON.stringify(manifest.watermark) ||
      JSON.stringify(keys) !== JSON.stringify(manifest.requiredKeyVersions) ||
      new Set(
        parsed.rows.map((row) => JSON.stringify([row.channel, row.keyVersion, row.identityHmac])),
      ).size !== parsed.rows.length ||
      parsed.rows.some(
        (row) =>
          new Date(row.effectiveAt) > options.evaluatedAt ||
          (row.expiresAt !== null &&
            (new Date(row.expiresAt) <= options.evaluatedAt ||
              new Date(row.expiresAt) <= new Date(row.effectiveAt))),
      )
    )
      throw new Error('invalid');
    return await checkpointTransaction(
      options.targetPool,
      options.timeoutMilliseconds,
      async (client) => {
        await client.query('lock table privacy_suppressions in share row exclusive mode');
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `fcd-support:checkpoint-import:${options.restoreRef}`,
        ]);
        const prior = (
          await client.query<{ checkpoint_ref: string; signature: string; row_count: number }>(
            'select checkpoint_ref,signature,row_count from restore_checkpoint_imports where restore_ref=$1',
            [options.restoreRef],
          )
        ).rows[0];
        if (prior !== undefined) {
          if (
            prior.checkpoint_ref !== manifest.checkpointRef ||
            prior.signature !== manifest.signature ||
            prior.row_count !== manifest.rowCount
          )
            throw new Error('invalid');
          if (options.currentSourcePool !== undefined)
            await assertCheckpointCurrent(options.currentSourcePool, manifest, validation);
          return { imported: prior.row_count };
        }
        for (const row of parsed.rows) {
          await client.query(
            `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version,expires_at)
          values($1,$2,'deletion_tombstone','customer_deletion',$3,$4,$5)
          on conflict(identity_hmac,channel,category,key_version) do update set
          effective_at=least(privacy_suppressions.effective_at,excluded.effective_at),
          expires_at=case when privacy_suppressions.expires_at is null or excluded.expires_at is null then null
            else greatest(privacy_suppressions.expires_at,excluded.expires_at) end`,
            [
              row.identityHmac,
              row.channel,
              new Date(row.effectiveAt),
              row.keyVersion,
              row.expiresAt === null ? null : new Date(row.expiresAt),
            ],
          );
        }
        if (options.currentSourcePool !== undefined)
          await assertCheckpointCurrent(options.currentSourcePool, manifest, validation);
        await client.query(
          `insert into restore_checkpoint_imports(restore_ref,checkpoint_ref,source_epoch,sequence,row_count,
        required_key_versions,ciphertext_sha256,signature,imported_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            options.restoreRef,
            manifest.checkpointRef,
            manifest.watermark.sourceEpoch,
            manifest.watermark.sequence,
            manifest.rowCount,
            [...manifest.requiredKeyVersions],
            manifest.ciphertextSha256,
            manifest.signature,
            options.evaluatedAt,
          ],
        );
        return { imported: parsed.rows.length };
      },
    );
  } catch {
    throw new Error('checkpoint_import_failed');
  }
}
