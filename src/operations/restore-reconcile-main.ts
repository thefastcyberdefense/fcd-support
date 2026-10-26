import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { AdminSecretBytes } from '../admin/admin-types.js';
import { parseDatabaseIdentity } from './database-identity.js';
import { readCheckpointWatermark, validateCheckpointManifest } from './deletion-checkpoint.js';
import { loadPrivacyKeyring } from './privacy-keyring.js';
import { parseRestoreCommand } from './restore-command.js';
import { connectionString, verifyPool } from './restore-main.js';
import {
  closeRestoreJobPool,
  owningRestoreSessions,
  restoreJobPath,
  restoreJobPool,
  restoreJobSettings,
  type RestoreStreamCommandOptions,
} from './restore-stream-main.js';
import { reconcileRestoredTarget } from './restore.js';
import { readSecretFile } from './secret-files.js';

export interface RestoreReconcileCommandOptions extends Omit<
  RestoreStreamCommandOptions,
  'restore'
> {
  readonly now?: () => Date;
  readonly reconcile?: typeof reconcileRestoredTarget;
}
const files = [
  'RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE',
  'RESTORE_TARGET_OWNER_DATABASE_URL_FILE',
  'PRIVACY_HMAC_KEYRING_FILE',
  'RECOVERY_MANIFEST_HMAC_FILE',
  'BACKUP_AGE_IDENTITY_FILE',
] as const;

async function readBytes(
  read: NonNullable<RestoreReconcileCommandOptions['readSecret']>,
  path: string,
  minimum: number,
  maximum: number,
) {
  const bytes = await read(path);
  if (bytes.byteLength < minimum || bytes.byteLength > maximum) {
    bytes.fill(0);
    throw new Error('invalid');
  }
  return bytes;
}

/** Reconcile an already restored, forward migrated and converged isolated target.
 * The result is historical deletion evidence; promotion requires fresh checks. */
export async function runRestoreReconcileCommand(
  options: RestoreReconcileCommandOptions,
): Promise<0 | 1> {
  const pools: pg.Pool[] = [];
  const state = { failed: false };
  let milliseconds = 1000;
  try {
    const command = parseRestoreCommand(options.args);
    const config = restoreJobSettings(options.environment, command, files, [
      'CHECKPOINT_ARCHIVE_DIRECTORY',
    ]);
    milliseconds = config.timeoutMilliseconds;
    const checkpointDirectory = restoreJobPath.parse(
      options.environment.CHECKPOINT_ARCHIVE_DIRECTORY,
    );
    const maximumCheckpointAgeMilliseconds = config.number('CHECKPOINT_MAX_AGE_MS', 31536000000);
    const maximumCheckpointRows = config.number('CHECKPOINT_MAX_ROWS', 2147483647);
    const maximumCheckpointPayloadBytes = config.number(
      'CHECKPOINT_MAX_PAYLOAD_BYTES',
      Number.MAX_SAFE_INTEGER,
    );
    const batchLimit = config.number('RESTORE_BATCH_LIMIT', 1000);
    const maximumBatches = config.number('RESTORE_MAX_BATCHES', 1000000);
    const read = options.readSecret ?? readSecretFile;
    const sourceRole = `${config.rolePrefix}_checkpoint`;
    const sourceUri = await connectionString(
      read,
      config.files.RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE ?? '',
      {
        databaseName: config.source.databaseName,
        role: sourceRole,
        alias: config.sourceAlias,
        reference: config.reference,
      },
    );
    const targetUri = await connectionString(
      read,
      config.files.RESTORE_TARGET_OWNER_DATABASE_URL_FILE ?? '',
      {
        databaseName: command.target.databaseName,
        role: 'postgres',
        alias: config.targetAlias,
        reference: config.reference,
      },
    );
    if (new URL(sourceUri).password === new URL(targetUri).password) throw new Error('invalid');
    const keyringBytes = await readBytes(
      read,
      config.files.PRIVACY_HMAC_KEYRING_FILE ?? '',
      1,
      65536,
    );
    let keyring;
    try {
      keyring = loadPrivacyKeyring(keyringBytes);
    } finally {
      keyringBytes.fill(0);
    }
    const signingBytes = await readBytes(
      read,
      config.files.RECOVERY_MANIFEST_HMAC_FILE ?? '',
      32,
      4096,
    );
    let checkpointSigningKey: AdminSecretBytes;
    try {
      checkpointSigningKey = new AdminSecretBytes(Buffer.from(signingBytes));
    } finally {
      signingBytes.fill(0);
    }
    const create =
      options.createPool ?? ((configuration: pg.PoolConfig) => new pg.Pool(configuration));
    const onFailure = () => {
      state.failed = true;
    };
    for (const [index, uri] of [sourceUri, targetUri].entries())
      pools.push(restoreJobPool(uri, command, config, index === 0, create, onFailure));
    const source = pools[0];
    const target = pools[1];
    if (!source || !target) throw new Error('invalid');
    const targetIdentity = parseDatabaseIdentity({
      systemIdentifier: command.target.systemIdentifier,
      databaseName: command.target.databaseName,
    });
    await verifyPool(source, config.source, sourceRole, true);
    await verifyPool(target, targetIdentity, 'postgres', false);
    const sourcePool = owningRestoreSessions(source, config.source);
    const targetPool = owningRestoreSessions(target, targetIdentity);
    const clock = options.now ?? (() => new Date());
    const startedAt = clock();
    const checkpointBytes = await readBytes(
      read,
      posix.join(checkpointDirectory, command.checkpointRef, 'manifest.json'),
      1,
      65536,
    );
    let checkpoint;
    try {
      const client = await sourcePool.connect();
      try {
        checkpoint = validateCheckpointManifest(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkpointBytes)),
          {
            signingKey: checkpointSigningKey,
            expectedWatermark: await readCheckpointWatermark({ transactionClient: client }),
            evaluatedAt: startedAt,
            maximumAgeMilliseconds: maximumCheckpointAgeMilliseconds,
          },
        );
      } finally {
        client.release(true);
      }
    } finally {
      checkpointBytes.fill(0);
    }
    if (checkpoint.checkpointRef !== command.checkpointRef) throw new Error('invalid');
    const client = await targetPool.connect();
    try {
      const latest = await client.query<{ name: string }>(
        `select name from "${command.target.schema}".pgmigrations order by name desc limit 1`,
      );
      if (
        !new RegExp(`^${command.schemaRevision}_[a-z0-9_]+$`, 'u').test(latest.rows[0]?.name ?? '')
      )
        throw new Error('invalid');
    } finally {
      client.release(true);
    }
    if (state.failed) throw new Error('invalid');
    const evidence = await (options.reconcile ?? reconcileRestoredTarget)(
      {
        sourcePool,
        targetPool,
        expectedSourceDatabaseIdentity: config.source,
        timeoutMilliseconds: config.timeoutMilliseconds,
        target: command.target,
        restoreRef: command.restoreRef,
        backupRef: command.backupRef,
        gitRevision: command.gitRevision,
        expectedSchemaRevision: command.schemaRevision,
        keyring,
        checkpoint,
        checkpointSigningKey,
        checkpointArchiveFile: posix.join(
          checkpointDirectory,
          command.checkpointRef,
          'archive.age',
        ),
        identityFile: config.files.BACKUP_AGE_IDENTITY_FILE ?? '',
        maximumCheckpointAgeMilliseconds,
        maximumCheckpointRows,
        maximumCheckpointPayloadBytes,
        batchLimit,
        maximumBatches,
        clock,
      },
      startedAt,
      config.source.systemIdentifier,
    );
    z.literal('deletion_verified').parse(evidence.status);
    if (
      evidence.restoreRef !== command.restoreRef ||
      evidence.backupRef !== command.backupRef ||
      evidence.checkpointRef !== command.checkpointRef ||
      evidence.sourceSystemIdentifier !== config.source.systemIdentifier ||
      evidence.gitRevision !== command.gitRevision ||
      evidence.schemaRevision !== command.schemaRevision ||
      JSON.stringify(evidence.target) !== JSON.stringify(command.target)
    )
      throw new Error('invalid');
  } catch {
    state.failed = true;
  } finally {
    const closed = await Promise.allSettled(
      pools.map((pool) => closeRestoreJobPool(pool, milliseconds)),
    );
    if (closed.some((result) => result.status === 'rejected')) state.failed = true;
  }
  if (!state.failed) {
    try {
      await options.write('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
      return 0;
    } catch {
      // A failed stdout write follows the same generic failure path.
    }
  }
  options.error('restore_reconcile_command_failed\n');
  return 1;
}

export async function runRestoreReconcileMain(): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 1000 ||
    process.getegid?.() !== 1000
  ) {
    process.stderr.write('restore_reconcile_command_failed\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runRestoreReconcileCommand({
    args: process.argv.slice(2),
    environment: process.env,
    write: (line) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) => {
          if (error) reject(new Error('invalid'));
          else resolve();
        });
      }),
    error: (line) => {
      process.stderr.write(line);
    },
  });
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRestoreReconcileMain();
