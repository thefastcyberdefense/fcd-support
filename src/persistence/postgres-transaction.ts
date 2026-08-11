import type pg from 'pg';

export async function withBoundedTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query('begin');
    await client.query(
      `set local lock_timeout = '750ms';
       set local statement_timeout = '3000ms';
       set local transaction_timeout = '3500ms'`,
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
