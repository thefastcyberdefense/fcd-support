import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

const destructiveTestOptIn = 'fcd-support-test-only';
const isolatedTestDatabaseName = 'fcd_support_test';

export interface IsolatedTestDatabase {
  readonly connectionString: string;
  readonly dispose: () => Promise<void>;
  readonly pool: pg.Pool;
  readonly runMigrations: (direction: 'down' | 'up', count?: number) => Promise<void>;
  readonly schema: string;
}

export async function rollbackThroughMigration(
  database: Pick<IsolatedTestDatabase, 'pool' | 'runMigrations'>,
  targetVersion: number,
): Promise<void> {
  const installed = await database.pool.query<{ readonly name: string }>(
    'select name from pgmigrations',
  );
  const versions = installed.rows.map((row) => Number.parseInt(row.name.split('_')[0] ?? '', 10));
  if (!versions.includes(targetVersion)) throw new Error('Target test migration is not installed');
  await database.runMigrations(
    'down',
    versions.filter((version) => version >= targetVersion).length,
  );
}

export function requireIsolatedTestDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const databaseUrl = environment.TEST_DATABASE_URL;

  try {
    if (
      environment.ALLOW_DESTRUCTIVE_DATABASE_TESTS !== destructiveTestOptIn ||
      databaseUrl === undefined
    ) {
      throw new Error('guard');
    }

    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
      databaseName !== isolatedTestDatabaseName
    ) {
      throw new Error('guard');
    }
  } catch {
    throw new Error('Integration database safety guard rejected the environment');
  }

  return databaseUrl;
}

export async function createIsolatedTestDatabase(suiteName: string): Promise<IsolatedTestDatabase> {
  const baseDatabaseUrl = requireIsolatedTestDatabaseUrl(process.env);
  const safeSuiteName = suiteName.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
  const schema = `test_${safeSuiteName}_${randomUUID().replaceAll('-', '')}`;

  const runMigrations = async (direction: 'down' | 'up', count?: number): Promise<void> => {
    await runner({
      ...(count === undefined ? {} : { count }),
      createMigrationsSchema: true,
      createSchema: true,
      databaseUrl: baseDatabaseUrl,
      dir: path.resolve('migrations'),
      direction,
      migrationsSchema: schema,
      migrationsTable: 'pgmigrations',
      schema,
      singleTransaction: true,
      log: () => undefined,
      verbose: false,
    });
  };

  await runMigrations('up');

  const schemaUrl = new URL(baseDatabaseUrl);
  schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
  const connectionString = schemaUrl.toString();
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 8,
  });

  return {
    connectionString,
    dispose: async () => {
      await pool.end();
      const cleanupPool = new pg.Pool({
        connectionString: baseDatabaseUrl,
        connectionTimeoutMillis: 5_000,
        max: 1,
      });
      try {
        await cleanupPool.query(`drop schema "${schema}" cascade`);
      } finally {
        await cleanupPool.end();
      }
    },
    pool,
    runMigrations,
    schema,
  };
}
