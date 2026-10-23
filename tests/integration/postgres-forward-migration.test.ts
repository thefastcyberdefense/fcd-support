import { afterAll, beforeAll, expect, test } from 'vitest';
import { runForwardMigrations } from '../../src/operations/forward-migration.js';
import {
  createIsolatedTestDatabase,
  rollbackThroughMigration,
  type IsolatedTestDatabase,
} from './test-database.js';

let database: IsolatedTestDatabase;
beforeAll(async () => {
  database = await createIsolatedTestDatabase('forward_migration');
});
afterAll(async () => {
  await database.dispose();
});
const options = () => ({
  schema: database.schema,
  expectedSchemaRevision: '000016',
  timeoutMilliseconds: 10000,
});

test('checks a supplied database identity on the migration-owning connection before any DDL', async () => {
  const bound = await createIsolatedTestDatabase('bound_migration');
  try {
    await rollbackThroughMigration(bound, 1);
    await expect(
      runForwardMigrations(bound.pool, {
        ...options(),
        schema: bound.schema,
        expectedDatabaseIdentity: {
          systemIdentifier: '1111111111111111111',
          databaseName: 'fcd_support_test',
        },
      }),
    ).rejects.toThrow(/^migration_target_invalid$/u);
    expect(
      (await bound.pool.query('select count(*)::int as count from pgmigrations')).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await bound.pool.query("select to_regclass('webhook_receipts') is null as absent")).rows,
    ).toEqual([{ absent: true }]);
  } finally {
    await bound.dispose();
  }
});

test('fresh empty application schema forward-migrates once and replay is safe', async () => {
  await rollbackThroughMigration(database, 1);
  expect(
    (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
  ).toEqual([{ count: 0 }]);
  expect(await runForwardMigrations(database.pool, options())).toEqual({
    schemaRevision: '000016',
  });
  expect(await runForwardMigrations(database.pool, options())).toEqual({
    schemaRevision: '000016',
  });
  expect(
    (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
  ).toEqual([{ count: 16 }]);
});

test('old admission schema upgrades without discarding its receipt evidence', async () => {
  await rollbackThroughMigration(database, 2);
  await database.pool.query(
    'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
    ['a'.repeat(64), new Date('2030-03-01T00:00:00.000Z')],
  );
  expect(await runForwardMigrations(database.pool, options())).toEqual({
    schemaRevision: '000016',
  });
  expect(
    (await database.pool.query('select count(*)::int as count from webhook_receipts')).rows,
  ).toEqual([{ count: 1 }]);
});

test('schema mismatch refuses before migration and never runs a down migration', async () => {
  await expect(
    runForwardMigrations(database.pool, { ...options(), expectedSchemaRevision: '000014' }),
  ).rejects.toThrow(/^migration_configuration_invalid$/u);
  expect(
    (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
  ).toEqual([{ count: 16 }]);
});

test('another deployment advisory lock refuses forward migration without waiting', async () => {
  const client = await database.pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1,0))', [
      `fcd-support:deployment:${database.schema}`,
    ]);
    await expect(runForwardMigrations(database.pool, options())).rejects.toThrow(
      /^migration_lock_conflict$/u,
    );
  } finally {
    client.release(true);
  }
});

test('a later migration failure rolls back earlier DDL and its migration registry entries', async () => {
  await rollbackThroughMigration(database, 1);
  await database.pool.query('create table contacts(synthetic_marker integer)');
  try {
    await expect(runForwardMigrations(database.pool, options())).rejects.toThrow(
      /^migration_failed$/u,
    );
    expect(
      (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await database.pool.query("select to_regclass('webhook_receipts') is null as absent")).rows,
    ).toEqual([{ absent: true }]);
  } finally {
    await database.pool.query('drop table contacts');
    await runForwardMigrations(database.pool, options());
  }
});
