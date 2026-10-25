import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, test } from 'vitest';
import { inspectOperationSettlement } from '../src/operations/operation-settlement.js';
import { operationApplicationName } from '../src/operations/operation-reference.js';

const reference = `operation_${'a'.repeat(32)}`;
const probeReference = `operation_${'b'.repeat(32)}`;
const options = {
  reference,
  probeReference,
  systemIdentifier: '1111111111111111111',
  databaseName: 'fcd_support_test',
  schema: 'public',
  timeoutMilliseconds: 1000,
};

function fixture(fault = 'none') {
  const statements: string[] = [];
  let released: boolean | undefined;
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      await Promise.resolve();
      statements.push(sql);
      if (sql === 'rollback' && fault === 'close') throw new Error('synthetic_close_error');
      if (sql.includes('pg_control_system'))
        return {
          rows: [
            {
              id: fault === 'identity' ? '2222222222222222222' : options.systemIdentifier,
              name: options.databaseName,
            },
          ],
        };
      if (sql.includes('rolsuper'))
        return {
          rows: [
            {
              privileged: fault !== 'principal',
              application_name:
                fault === 'probe-name'
                  ? operationApplicationName(reference)
                  : operationApplicationName(probeReference),
            },
          ],
        };
      if (sql.includes('pg_try_advisory_xact_lock'))
        return { rows: [{ acquired: fault !== 'lock' }] };
      if (sql.includes('pg_stat_activity')) {
        if (fault === 'connection-error')
          client.emit('error', new Error('synthetic_connection_error'));
        return {
          rows: [
            {
              backends: fault === 'backend' ? '1' : '0',
              prepared: fault === 'prepared' ? '1' : '0',
            },
          ],
        };
      }
      return { rows: [] };
    },
    release(destroy?: boolean) {
      released = destroy;
    },
  });
  const pool = { connect: () => Promise.resolve(client as unknown as pg.PoolClient) };
  return { pool, statements, released: () => released };
}

test('settlement inspects under a read-only transaction and both mutation barriers, then destroys its connection', async () => {
  const f = fixture();
  await expect(inspectOperationSettlement(f.pool, options)).resolves.toEqual({ status: 'settled' });
  expect(f.statements[0]).toBe('begin read only');
  expect(f.statements.filter((s) => s.includes('pg_try_advisory_xact_lock'))).toHaveLength(2);
  expect(f.statements.at(-1)).toBe('rollback');
  expect(f.released()).toBe(true);
});

test.each([
  'identity',
  'principal',
  'probe-name',
  'lock',
  'backend',
  'prepared',
  'connection-error',
  'close',
])('settlement fails closed for %s without acknowledging an operation result', async (fault) => {
  const f = fixture(fault);
  await expect(inspectOperationSettlement(f.pool, options)).rejects.toThrow(
    /^operations_job_unsettled$/u,
  );
  expect(f.statements.at(-1)).toBe('rollback');
  expect(f.released()).toBe(true);
  if (['identity', 'principal', 'probe-name', 'lock'].includes(fault))
    expect(f.statements.some((s) => s.includes('pg_stat_activity'))).toBe(false);
});

test('settlement refuses its own reference before opening a connection', async () => {
  const f = fixture();
  await expect(
    inspectOperationSettlement(f.pool, { ...options, probeReference: reference }),
  ).rejects.toThrow(/^operations_job_unsettled$/u);
  expect(f.statements).toEqual([]);
  expect(f.released()).toBeUndefined();
});
