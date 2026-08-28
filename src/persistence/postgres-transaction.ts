import type pg from 'pg';

export interface BoundedTransactionOptions {
  readonly lockTimeoutMilliseconds?: 750 | 2_000;
}

export async function withBoundedTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
  options: BoundedTransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;
  const lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? 2_000;

  try {
    await client.query('begin');
    await client.query(
      `select set_config('lock_timeout', $1, true),
              set_config('statement_timeout', '3000ms', true),
              set_config('transaction_timeout', '3500ms', true)`,
      [`${String(lockTimeoutMilliseconds)}ms`],
    );
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
