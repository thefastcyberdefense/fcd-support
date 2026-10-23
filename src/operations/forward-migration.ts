import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import type pg from 'pg';
import { z } from 'zod';

export interface ForwardMigrationOptions {
  readonly schema: string;
  readonly expectedSchemaRevision: string;
  readonly timeoutMilliseconds: number;
  readonly expectedDatabaseIdentity?:
    | {
        readonly systemIdentifier: string;
        readonly databaseName: string;
      }
    | undefined;
}

export async function runForwardMigrations(
  pool: pg.Pool,
  input: ForwardMigrationOptions,
): Promise<{ readonly schemaRevision: string }> {
  let options: ForwardMigrationOptions;
  const directory = resolve('migrations');
  try {
    options = z
      .strictObject({
        schema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
        expectedSchemaRevision: z.string().regex(/^[0-9]{6}$/u),
        timeoutMilliseconds: z.number().int().min(1).max(300000),
        expectedDatabaseIdentity: z
          .strictObject({
            systemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/u),
            databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
          })
          .optional(),
      })
      .parse(input);
    const versions = (await readdir(directory))
      .map((name) => /^([0-9]{6})_[a-z0-9_]+\.ts$/u.exec(name)?.[1])
      .filter((version): version is string => version !== undefined)
      .sort();
    if (
      versions.length === 0 ||
      new Set(versions).size !== versions.length ||
      versions.at(-1) !== options.expectedSchemaRevision
    )
      throw new Error('invalid');
  } catch {
    throw new Error('migration_configuration_invalid');
  }
  let client: pg.PoolClient | undefined;
  let reason = 'migration_failed';
  try {
    client = await pool.connect();
    await client.query("select set_config('statement_timeout',$1,false)", [
      `${String(options.timeoutMilliseconds)}ms`,
    ]);
    if (options.expectedDatabaseIdentity !== undefined) {
      reason = 'migration_target_invalid';
      const actual = (
        await client.query<{ id: string; name: string }>(
          'select system_identifier::text as id,current_database() as name from pg_control_system()',
        )
      ).rows[0];
      if (
        actual?.id !== options.expectedDatabaseIdentity.systemIdentifier ||
        actual.name !== options.expectedDatabaseIdentity.databaseName
      )
        throw new Error('invalid');
      reason = 'migration_failed';
    }
    const lock = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1,0)) as acquired',
      [`fcd-support:deployment:${options.schema}`],
    );
    if (lock.rows[0]?.acquired !== true) {
      reason = 'migration_lock_conflict';
      throw new Error('invalid');
    }
    const present = await client.query<{ present: boolean }>(
      'select to_regclass($1) is not null as present',
      [`${options.schema}.pgmigrations`],
    );
    if (present.rows[0]?.present === true) {
      const rows = await client.query<{ name: string }>(
        `select name from "${options.schema}".pgmigrations`,
      );
      if (
        rows.rows.some(
          (row) =>
            !/^\d{6}_[a-z0-9_]+$/u.test(row.name) ||
            row.name.slice(0, 6) > options.expectedSchemaRevision,
        )
      ) {
        reason = 'migration_configuration_invalid';
        throw new Error('invalid');
      }
    }
    await runner({
      dbClient: client,
      dir: directory,
      direction: 'up',
      schema: options.schema,
      migrationsSchema: options.schema,
      migrationsTable: 'pgmigrations',
      createSchema: true,
      createMigrationsSchema: true,
      singleTransaction: true,
      noLock: true,
      log: () => undefined,
      verbose: false,
    });
    const latest = await client.query<{ name: string }>(
      `select name from "${options.schema}".pgmigrations order by name desc limit 1`,
    );
    if (latest.rows[0]?.name.slice(0, 6) !== options.expectedSchemaRevision)
      throw new Error('invalid');
    return { schemaRevision: options.expectedSchemaRevision };
  } catch {
    throw new Error(reason);
  } finally {
    // A one-shot operations connection is never returned with session settings
    // or advisory locks. Closing also releases the lock after a failed rollback.
    client?.release(true);
  }
}
