import pg from 'pg';
import { z } from 'zod';

const identitySchema = z.strictObject({
  systemIdentifier: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .refine((value) => BigInt(value) <= 18446744073709551615n),
  databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
});
export type DatabaseIdentity = Readonly<z.infer<typeof identitySchema>>;

export function parseDatabaseIdentity(input: unknown): DatabaseIdentity {
  try {
    return identitySchema.parse(input);
  } catch {
    throw new Error('operations_database_target_invalid');
  }
}

export async function assertDatabaseIdentity(
  client: pg.PoolClient,
  input: DatabaseIdentity,
): Promise<void> {
  try {
    const expected = parseDatabaseIdentity(input);
    const actual = (
      await client.query<{ id: string; name: string }>(
        'select system_identifier::text as id,pg_catalog.current_database() as name from pg_catalog.pg_control_system()',
      )
    ).rows[0];
    if (actual?.id !== expected.systemIdentifier || actual.name !== expected.databaseName)
      throw new Error('invalid');
  } catch {
    throw new Error('operations_database_target_invalid');
  }
}

/** The callback may write a partial ciphertext, never a published manifest.
 * pg_dump imports this verified connection's snapshot on the same target. */
export async function withVerifiedDatabaseSnapshot(
  options: {
    readonly connectionString: string;
    readonly expectedDatabaseIdentity: DatabaseIdentity;
    readonly timeoutMilliseconds: number;
  },
  operation: (snapshot: string) => Promise<void>,
): Promise<void> {
  const expected = parseDatabaseIdentity(options.expectedDatabaseIdentity);
  const milliseconds = z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: milliseconds,
    query_timeout: milliseconds,
    statement_timeout: milliseconds,
  });
  let failed = false;
  let client: pg.PoolClient | undefined;
  const onError = () => {
    failed = true;
  };
  pool.on('error', onError);
  try {
    client = await pool.connect();
    client.on('error', onError);
    await client.query('begin isolation level repeatable read read only');
    await client.query(
      "select pg_catalog.set_config('transaction_timeout',$1,true),pg_catalog.set_config('idle_in_transaction_session_timeout',$1,true)",
      [`${String(milliseconds)}ms`],
    );
    await assertDatabaseIdentity(client, expected);
    const snapshot = (
      await client.query<{ snapshot: string }>('select pg_catalog.pg_export_snapshot() as snapshot')
    ).rows[0]?.snapshot;
    if (
      snapshot === undefined ||
      !/^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{8}-[1-9][0-9]{0,9}$/u.test(snapshot)
    )
      throw new Error('invalid');
    await operation(snapshot);
  } catch {
    failed = true;
  } finally {
    if (client !== undefined) {
      try {
        await client.query('rollback');
      } catch {
        failed = true;
      }
      client.release(true);
    }
    try {
      await pool.end();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('operations_database_target_invalid');
}
