import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { AdminSecretBytes } from '../admin/admin-types.js';
import { PostgresRestoreEvidence } from '../persistence/postgres-restore-evidence.js';
import {
  assertDatabaseIdentity,
  parseDatabaseIdentity,
  type DatabaseIdentity,
} from './database-identity.js';
import { readCheckpointWatermark, validateCheckpointManifest } from './deletion-checkpoint.js';
import { operationApplicationName } from './operation-reference.js';
import { loadPrivacyKeyring } from './privacy-keyring.js';
import { parsePromotionCommand, type PromotionCommand } from './promotion-command.js';
import { createPromotionHandshake } from './promotion-handshake.js';
import { connectionString, verifyPool } from './restore-main.js';
import { verifyPromotion } from './restore.js';
import { readSecretFile } from './secret-files.js';

export interface PromotionCommandOptions {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly input: Readable;
  readonly write: (line: string) => void | Promise<void>;
  readonly error: (line: string) => void;
  readonly now?: () => Date;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
  readonly createPool?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly verify?: typeof verifyPromotion;
}

const path = z
  .string()
  .min(2)
  .max(4096)
  .regex(/^\/[A-Za-z0-9._/-]+$/u)
  .refine((value) => !value.endsWith('/') && posix.normalize(value) === value);
const secretFiles = [
  'RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE',
  'RESTORE_TARGET_OWNER_DATABASE_URL_FILE',
  'PRIVACY_HMAC_KEYRING_FILE',
  'RECOVERY_MANIFEST_HMAC_FILE',
  'BACKUP_AGE_IDENTITY_FILE',
] as const;
function settings(environment: PromotionCommandOptions['environment'], command: PromotionCommand) {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === '') continue;
    if (
      (/(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|KEYRING|HMAC|AGE_IDENTITY)(?:_|$)/u.test(
        name,
      ) &&
        !secretFiles.some((allowed) => name === allowed)) ||
      /^PG[A-Z_0-9]+$/u.test(name)
    )
      throw new Error('invalid');
  }
  if (
    environment.NODE_ENV !== 'production' ||
    ['MODEL_EXECUTION_ENABLED', 'OUTBOUND_EXECUTION_ENABLED', 'N8N_EXECUTION_ENABLED'].some(
      (name) => environment[name] !== 'false',
    ) ||
    environment.OPS_GIT_REVISION !== command.gitRevision ||
    environment.OPS_SCHEMA_REVISION !== command.schemaRevision ||
    environment.OPS_DATABASE_SCHEMA !== command.target.schema
  )
    throw new Error('invalid');
  const reference = z.string().parse(environment.OPS_OPERATION_REFERENCE);
  const applicationName = operationApplicationName(reference);
  const source = parseDatabaseIdentity({
    systemIdentifier: environment.OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER,
    databaseName: environment.OPS_SOURCE_DATABASE_NAME,
  });
  if (
    !/^fcd_support(?:_[a-z0-9_]+)?$/u.test(source.databaseName) ||
    source.databaseName !== command.target.databaseName ||
    source.systemIdentifier === command.target.systemIdentifier
  )
    throw new Error('invalid');
  const rolePrefix = z
    .string()
    .regex(/^fcd_[a-z0-9_]{1,28}$/u)
    .parse(environment.OPS_DATABASE_ROLE_PREFIX);
  const sourceAlias = z
    .literal('fcd-support-source-postgres')
    .parse(environment.RESTORE_SOURCE_SERVICE_ALIAS);
  const targetAlias = z
    .literal('fcd-support-restore-postgres')
    .parse(environment.RESTORE_TARGET_SERVICE_ALIAS);
  const number = (name: string, maximum: number) =>
    z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(maximum))
      .parse(environment[name]);
  const timeoutMilliseconds = number('OPS_MAX_CALL_MS', 300000);
  return {
    reference,
    applicationName,
    source,
    rolePrefix,
    sourceAlias,
    targetAlias,
    timeoutMilliseconds,
    hostCheckTimeoutMilliseconds: number('PROMOTION_HOST_CHECK_TIMEOUT_MS', timeoutMilliseconds),
    files: Object.fromEntries(
      secretFiles.map((name) => [name, path.parse(environment[name])]),
    ) as Record<(typeof secretFiles)[number], string>,
    checkpointDirectory: path.parse(environment.CHECKPOINT_ARCHIVE_DIRECTORY),
    maximumCheckpointAgeMilliseconds: number('CHECKPOINT_MAX_AGE_MS', 31536000000),
    maximumCheckpointRows: number('CHECKPOINT_MAX_ROWS', 2147483647),
    maximumCheckpointPayloadBytes: number('CHECKPOINT_MAX_PAYLOAD_BYTES', Number.MAX_SAFE_INTEGER),
    batchLimit: number('RESTORE_BATCH_LIMIT', 1000),
    maximumBatches: number('RESTORE_MAX_BATCHES', 1000000),
  };
}

async function bytes(
  read: NonNullable<PromotionCommandOptions['readSecret']>,
  file: string,
  minimum: number,
  maximum: number,
) {
  const value = await read(file);
  if (value.byteLength < minimum || value.byteLength > maximum) {
    value.fill(0);
    throw new Error('invalid');
  }
  return value;
}
function owningSessions(pool: pg.Pool, expected: DatabaseIdentity): pg.Pool {
  // Only the awaited acquisition interface is consumed by verifyPromotion.
  return new Proxy(pool, {
    get(original, key, receiver): unknown {
      if (key !== 'connect') return Reflect.get(original, key, receiver) as unknown;
      return async () => {
        const client = await original.connect();
        try {
          await assertDatabaseIdentity(client, expected);
          return client;
        } catch {
          client.release(true);
          throw new Error('invalid');
        }
      };
    },
  });
}
async function closePool(pool: pg.Pool, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('invalid'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The parent controller keeps its deployment lock and answers both requests
 * with fresh actual host observations. Historical evidence never supplies an ack. */
export async function runPromotionCommand(options: PromotionCommandOptions): Promise<0 | 1> {
  const pools: pg.Pool[] = [];
  const state = { failed: false };
  let handshake: ReturnType<typeof createPromotionHandshake> | undefined;
  let timeoutMilliseconds = 1000;
  try {
    const command = parsePromotionCommand(options.args);
    const config = settings(options.environment, command);
    timeoutMilliseconds = config.timeoutMilliseconds;
    handshake = createPromotionHandshake({
      operationRef: config.reference,
      input: options.input,
      timeoutMilliseconds: config.hostCheckTimeoutMilliseconds,
      write: options.write,
    });
    const read = options.readSecret ?? readSecretFile;
    const sourceRole = `${config.rolePrefix}_checkpoint`;
    const sourceUri = await connectionString(
      read,
      config.files.RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE,
      {
        databaseName: config.source.databaseName,
        role: sourceRole,
        alias: config.sourceAlias,
        reference: config.reference,
      },
    );
    const targetUri = await connectionString(
      read,
      config.files.RESTORE_TARGET_OWNER_DATABASE_URL_FILE,
      {
        databaseName: command.target.databaseName,
        role: 'postgres',
        alias: config.targetAlias,
        reference: config.reference,
      },
    );
    const keyringBytes = await bytes(read, config.files.PRIVACY_HMAC_KEYRING_FILE, 1, 65536);
    let keyring;
    try {
      keyring = loadPrivacyKeyring(keyringBytes);
    } finally {
      keyringBytes.fill(0);
    }
    const signingBytes = await bytes(read, config.files.RECOVERY_MANIFEST_HMAC_FILE, 32, 4096);
    let checkpointSigningKey: AdminSecretBytes;
    try {
      checkpointSigningKey = new AdminSecretBytes(Buffer.from(signingBytes));
    } finally {
      signingBytes.fill(0);
    }
    for (const [index, uri] of [sourceUri, targetUri].entries()) {
      const poolUri = new URL(uri);
      poolUri.searchParams.delete('options');
      const pool = (
        options.createPool ?? ((configuration: pg.PoolConfig) => new pg.Pool(configuration))
      )({
        connectionString: poolUri.toString(),
        ssl: false,
        max: 1,
        connectionTimeoutMillis: config.timeoutMilliseconds,
        query_timeout: config.timeoutMilliseconds,
        statement_timeout: config.timeoutMilliseconds,
        idle_in_transaction_session_timeout: config.timeoutMilliseconds,
        application_name: config.applicationName,
        options: `-c application_name=${config.applicationName} -c search_path=${command.target.schema},public${index === 0 ? ' -c default_transaction_read_only=on' : ''}`,
      });
      pools.push(pool);
      const onError = () => {
        state.failed = true;
      };
      pool.on('error', onError);
      pool.on('connect', (client) => {
        client.on('error', onError);
        client.once('end', () => {
          client.off('error', onError);
        });
      });
    }
    const source = pools[0];
    const target = pools[1];
    if (!source || !target) throw new Error('invalid');
    const targetIdentity = parseDatabaseIdentity({
      systemIdentifier: command.target.systemIdentifier,
      databaseName: command.target.databaseName,
    });
    await verifyPool(source, config.source, sourceRole, true);
    await verifyPool(target, targetIdentity, 'postgres', false);
    const sourcePool = owningSessions(source, config.source);
    const targetPool = owningSessions(target, targetIdentity);
    const clock = options.now ?? (() => new Date());
    const manifestBytes = await bytes(
      read,
      posix.join(config.checkpointDirectory, command.checkpointRef, 'manifest.json'),
      1,
      65536,
    );
    let checkpoint;
    try {
      const owner = await sourcePool.connect();
      try {
        checkpoint = validateCheckpointManifest(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
          {
            signingKey: checkpointSigningKey,
            expectedWatermark: await readCheckpointWatermark({ transactionClient: owner }),
            evaluatedAt: clock(),
            maximumAgeMilliseconds: config.maximumCheckpointAgeMilliseconds,
          },
        );
      } finally {
        owner.release(true);
      }
    } finally {
      manifestBytes.fill(0);
    }
    if (checkpoint.checkpointRef !== command.checkpointRef) throw new Error('invalid');
    const owner = await targetPool.connect();
    try {
      const binding = await new PostgresRestoreEvidence({ transactionClient: owner }).load(
        command.restoreRef,
      );
      if (
        binding.backupRef !== command.backupRef ||
        binding.sourceSystemIdentifier !== config.source.systemIdentifier ||
        binding.gitRevision !== command.gitRevision ||
        binding.schemaRevision !== command.schemaRevision ||
        JSON.stringify(binding.target) !== JSON.stringify(command.target)
      )
        throw new Error('invalid');
    } finally {
      owner.release(true);
    }
    if (state.failed) throw new Error('invalid');
    const outcome = await (options.verify ?? verifyPromotion)({
      sourcePool,
      targetPool,
      expectedSourceDatabaseIdentity: config.source,
      timeoutMilliseconds: config.timeoutMilliseconds,
      target: command.target,
      restoreRef: command.restoreRef,
      verificationRef: command.verificationRef,
      gitRevision: command.gitRevision,
      expectedSchemaRevision: command.schemaRevision,
      keyring,
      checkpoint,
      checkpointSigningKey,
      checkpointArchiveFile: posix.join(
        config.checkpointDirectory,
        command.checkpointRef,
        'archive.age',
      ),
      identityFile: config.files.BACKUP_AGE_IDENTITY_FILE,
      maximumCheckpointAgeMilliseconds: config.maximumCheckpointAgeMilliseconds,
      maximumCheckpointRows: config.maximumCheckpointRows,
      maximumCheckpointPayloadBytes: config.maximumCheckpointPayloadBytes,
      batchLimit: config.batchLimit,
      maximumBatches: config.maximumBatches,
      clock,
      assertQuiesced: handshake.assertQuiesced,
    });
    z.literal('ready').parse(outcome.status);
  } catch {
    state.failed = true;
  } finally {
    const closed = await Promise.allSettled(
      pools.map((pool) => closePool(pool, timeoutMilliseconds)),
    );
    if (closed.some((result) => result.status === 'rejected')) state.failed = true;
    if (!state.failed) {
      try {
        handshake?.assertComplete();
      } catch {
        state.failed = true;
      }
    }
    handshake?.close();
  }
  if (state.failed) {
    options.error('promotion_command_failed\n');
    return 1;
  }
  try {
    await options.write('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
    return 0;
  } catch {
    options.error('promotion_command_failed\n');
    return 1;
  }
}

export async function runPromotionMain(): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 1000 ||
    process.getegid?.() !== 1000
  ) {
    process.stderr.write('promotion_command_failed\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runPromotionCommand({
    args: process.argv.slice(2),
    environment: process.env,
    input: process.stdin,
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
  await runPromotionMain();
