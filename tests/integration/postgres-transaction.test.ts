import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { withBoundedTransaction } from '../../src/persistence/postgres-transaction.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('postgres_transaction');
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query('truncate table webhook_receipts cascade');
});

afterAll(async () => {
  await disposeDatabase?.();
});

describe('withBoundedTransaction', () => {
  test('commits a synthetic receipt after the operation resolves', async () => {
    await withBoundedTransaction(pool, async (client) => {
      await client.query(
        `insert into webhook_receipts (payload_sha256, event_count)
         values ($1, $2)`,
        ['a'.repeat(64), 1],
      );
    });

    const result = await pool.query('select count(*)::int as receipts from webhook_receipts');

    expect(result.rows).toEqual([{ receipts: 1 }]);
  });

  test('rolls back a synthetic receipt when the operation throws', async () => {
    await expect(
      withBoundedTransaction(pool, async (client) => {
        await client.query(
          `insert into webhook_receipts (payload_sha256, event_count)
           values ($1, $2)`,
          ['b'.repeat(64), 1],
        );
        throw new Error('synthetic transaction failure');
      }),
    ).rejects.toThrow('synthetic transaction failure');

    const result = await pool.query('select count(*)::int as receipts from webhook_receipts');

    expect(result.rows).toEqual([{ receipts: 0 }]);
  });
});
