import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { PostgresOperationsStore } from '../persistence/postgres-operations-store.js';
import { postgresHealthDatabase } from '../persistence/postgres-admin-operations.js';
import {
  collectHealth,
  parseHostHealthSnapshot,
  type HealthCollectorOptions,
  type HealthOutageGap,
} from './health-collector.js';
import { loadOperationsConfig } from './operations-config.js';
import { loadRoleEnvironment } from './secret-files.js';
import { assertDatabaseIdentity, parseDatabaseIdentity } from './database-identity.js';

const inputSchema = z.strictObject({
  hostSnapshot: z.custom((value) => parseHostHealthSnapshot(value) !== undefined).optional(),
  availability: z
    .strictObject({
      manifest: z.enum(['healthy', 'unavailable']).optional(),
      n8n: z.enum(['healthy', 'unavailable']).optional(),
    })
    .optional(),
  outageGap: z
    .strictObject({ startedAt: z.iso.datetime(), lastObservedAt: z.iso.datetime() })
    .refine((gap) => gap.startedAt <= gap.lastObservedAt)
    .optional(),
});
export interface HealthCommandPorts {
  readonly database: HealthCollectorOptions['database'];
  readonly store: HealthCollectorOptions['store'];
  readonly close: () => Promise<void>;
}
export interface HealthCommandLimits {
  readonly maximumCallMilliseconds: number;
  readonly backupStaleMilliseconds: number;
  readonly maximumOutageGapMilliseconds: number;
}
export interface HealthCommandOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly args: readonly string[];
  readonly input?: unknown;
  readonly readInput?: (timeoutMilliseconds: number) => Promise<unknown>;
  readonly now?: () => Date;
  readonly write: (line: string) => void;
  readonly journal?: (line: string) => void;
  readonly readSecret?: (path: string) => Promise<Uint8Array>;
  readonly ports?: (
    environment: Readonly<Record<string, string | undefined>>,
    now: () => Date,
    limits: HealthCommandLimits,
  ) => HealthCommandPorts;
}
function healthCommandLimits(
  environment: Readonly<Record<string, string | undefined>>,
  maximumCallMilliseconds: number,
): HealthCommandLimits {
  const milliseconds = (maximum: number) =>
    z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(maximum));
  return Object.freeze({
    maximumCallMilliseconds,
    backupStaleMilliseconds: milliseconds(604_800_000).parse(
      environment.OPS_HEALTH_BACKUP_STALE_MS ?? '129600000',
    ),
    maximumOutageGapMilliseconds: milliseconds(86_400_000).parse(
      environment.OPS_HEALTH_MAX_OUTAGE_GAP_MS ?? '86400000',
    ),
  });
}
function postgresPorts(
  environment: Readonly<Record<string, string | undefined>>,
  now: () => Date,
  limits: HealthCommandLimits,
): HealthCommandPorts {
  const expected = parseDatabaseIdentity({
    systemIdentifier: environment.OPS_DATABASE_SYSTEM_IDENTIFIER,
    databaseName: environment.OPS_DATABASE_NAME,
  });
  const schema = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/u)
    .parse(environment.OPS_DATABASE_SCHEMA);
  const pool = new pg.Pool({
    connectionString: environment.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: limits.maximumCallMilliseconds,
    idleTimeoutMillis: limits.maximumCallMilliseconds,
    query_timeout: limits.maximumCallMilliseconds,
    statement_timeout: limits.maximumCallMilliseconds,
    idle_in_transaction_session_timeout: limits.maximumCallMilliseconds,
  });
  const connectionState = { failed: false };
  const connectionFailed = () => connectionState.failed;
  pool.on('error', () => {
    connectionState.failed = true;
  });
  const watched = new WeakSet<pg.PoolClient>();
  const watchConnection = (client: pg.PoolClient) => {
    if (watched.has(client)) return;
    watched.add(client);
    const onError = () => {
      connectionState.failed = true;
    };
    client.on('error', onError);
    client.once('end', () => client.off('error', onError));
  };
  pool.on('connect', watchConnection);
  const verified = async <T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    if (connectionFailed()) throw new Error('operations_database_target_invalid');
    // A refusal before acquiring a client is a handled availability failure.
    // Any error after acquisition makes transaction completion uncertain.
    const client = await pool.connect();
    watchConnection(client);
    try {
      await client.query('begin');
      await client.query(
        "select pg_catalog.set_config('lock_timeout',$1,true),pg_catalog.set_config('statement_timeout',$1,true),pg_catalog.set_config('transaction_timeout',$1,true),pg_catalog.set_config('idle_in_transaction_session_timeout',$1,true)",
        [`${String(limits.maximumCallMilliseconds)}ms`],
      );
      await assertDatabaseIdentity(client, expected);
      await client.query("select pg_catalog.set_config('search_path',$1,true)", [
        `pg_catalog,"${schema}",pg_temp`,
      ]);
      const result = await operation(client);
      if (connectionFailed()) throw new Error('invalid');
      await client.query('commit');
      if (connectionFailed()) throw new Error('invalid');
      return result;
    } catch {
      connectionState.failed = true;
      try {
        await client.query('rollback');
      } catch {
        /* Destroy the ambiguous physical connection below. */
      }
      throw new Error('operations_database_target_invalid');
    } finally {
      client.release(connectionState.failed);
    }
  };
  return {
    database: {
      read: () =>
        verified((client) => postgresHealthDatabase({ transactionClient: client }, now).read()),
    },
    store: {
      recordHealth: (value) =>
        verified((client) =>
          new PostgresOperationsStore({ transactionClient: client }).recordHealth(value),
        ),
    },
    close: async () => {
      await pool.end();
      if (connectionState.failed) throw new Error('operations_database_target_invalid');
    },
  };
}
/** No HTTP listener, socket mount, admin credential or provider client is acquired. */
export async function runHealthCommand(options: HealthCommandOptions): Promise<0 | 1> {
  let ports: HealthCommandPorts | undefined;
  let status: 0 | 1 = 1;
  let acknowledgement:
    | {
        readonly status: 'completed';
        readonly processed: number;
        readonly reasonCode: 'ok' | 'dependency_unavailable';
      }
    | undefined;
  const now = options.now ?? (() => new Date());
  try {
    z.tuple([z.literal('health')]).parse(options.args);
    const environment = await loadRoleEnvironment(
      'health',
      options.environment,
      options.readSecret,
    );
    const config = loadOperationsConfig('health', environment);
    const limits = healthCommandLimits(environment, config.maximumCallMilliseconds);
    const gitRevision = z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .parse(environment.OPS_GIT_REVISION);
    const schemaRevision = z
      .string()
      .regex(/^\d{6}$/u)
      .parse(environment.OPS_SCHEMA_REVISION);
    parseDatabaseIdentity({
      systemIdentifier: environment.OPS_DATABASE_SYSTEM_IDENTIFIER,
      databaseName: environment.OPS_DATABASE_NAME,
    });
    z.string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(environment.OPS_DATABASE_SCHEMA);
    const input = inputSchema.parse(
      options.readInput === undefined
        ? options.input
        : await options.readInput(limits.maximumCallMilliseconds),
    );
    ports = (options.ports ?? postgresPorts)(environment, now, limits);
    let gap: HealthOutageGap | undefined = input.outageGap;
    const host = parseHostHealthSnapshot(input.hostSnapshot);
    const hostAge = host === undefined ? -1 : now().getTime() - Date.parse(host.checkedAt);
    const verifiedHost = hostAge >= 0 && hostAge <= config.healthStaleMilliseconds;
    const manifest = verifiedHost ? input.availability?.manifest : undefined;
    const n8n = verifiedHost ? input.availability?.n8n : undefined;
    const observations = await collectHealth({
      database: ports.database,
      store: ports.store,
      now,
      timeoutMilliseconds: limits.maximumCallMilliseconds,
      staleMilliseconds: config.healthStaleMilliseconds,
      maximumOutageGapMilliseconds: limits.maximumOutageGapMilliseconds,
      backupStaleMilliseconds: limits.backupStaleMilliseconds,
      expectedSchemaRevision: schemaRevision,
      expectedGitRevision: gitRevision,
      modelEnabled: config.modelExecutionEnabled,
      notificationsEnabled: config.n8nExecutionEnabled,
      outboundEnabled: config.outboundExecutionEnabled,
      ...(input.hostSnapshot === undefined ? {} : { hostSnapshot: input.hostSnapshot }),
      ...(manifest === undefined ? {} : { manifestProbe: () => Promise.resolve(manifest) }),
      ...(n8n === undefined ? {} : { n8nProbe: () => Promise.resolve(n8n) }),
      journal: (event) => {
        options.journal?.(JSON.stringify(event));
      },
      outage: {
        read: () => Promise.resolve(gap),
        write: (value) => {
          gap = value;
          return Promise.resolve();
        },
        clear: () => {
          gap = undefined;
          return Promise.resolve();
        },
      },
    });
    const available =
      observations.find((value) => value.component === 'postgres')?.state === 'healthy';
    acknowledgement = {
      status: 'completed',
      processed: available ? observations.length : 0,
      reasonCode: available ? 'ok' : 'dependency_unavailable',
    };
    status = 0;
  } catch {
    options.journal?.(
      JSON.stringify({
        event: 'operations_health',
        component: 'postgres',
        state: 'unknown',
        checkedAt: now().toISOString(),
      }),
    );
  } finally {
    try {
      await ports?.close();
    } catch {
      status = 1;
    }
  }
  if (status === 0 && acknowledgement !== undefined) options.write(JSON.stringify(acknowledgement));
  return status;
}
async function readInput(timeoutMilliseconds: number): Promise<unknown> {
  if (process.stdin.isTTY) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = await Promise.race([
      (async () => {
        let text = '';
        for await (const chunk of process.stdin) {
          text += String(chunk);
          if (Buffer.byteLength(text) > 16_384) throw new Error('health_input_invalid');
        }
        return text;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          process.stdin.destroy();
          reject(new Error('health_input_invalid'));
        }, timeoutMilliseconds);
      }),
    ]);
    return input.trim() === '' ? {} : (JSON.parse(input) as unknown);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runHealthCommand({
      environment: process.env,
      args: process.argv.slice(2),
      readInput,
      journal: (line) => {
        process.stderr.write(`${line}\n`);
      },
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: 'operations_health', component: 'postgres', state: 'unknown', checkedAt: new Date().toISOString() })}\n`,
    );
    process.exitCode = 1;
  }
}
