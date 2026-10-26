import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, test } from 'vitest';
import { createMaintenancePool } from '../src/operations/maintenance-pool.js';

const options = {
  connectionString:
    'postgresql://synthetic_maintenance:synthetic_password@127.0.0.1/fcd_support_test',
  expectedDatabaseIdentity: {
    systemIdentifier: '1111111111111111111',
    databaseName: 'fcd_support_test',
  },
  schema: 'test_maintenance_pool',
  rolePrefix: 'fcd_test_pool',
  operationReference: `operation_${'a'.repeat(32)}`,
  max: 2,
  timeoutMilliseconds: 1000,
};

test.each([
  { schema: 'test_maintenance_pool,public' },
  { schema: 'pg_catalog' },
  { schema: 'pg_temp' },
  { rolePrefix: 'synthetic_foreign' },
  { operationReference: '' },
  { max: 0 },
  { timeoutMilliseconds: 0 },
  { timeoutMilliseconds: 300001 },
  { expectedDatabaseIdentity: { ...options.expectedDatabaseIdentity, systemIdentifier: '0' } },
  { connectionString: 'https://example.invalid/synthetic_password' },
])('rejects invalid maintenance scope before opening a connection: %j', async (change) => {
  let pool: pg.Pool | undefined;
  try {
    expect(() => {
      pool = createMaintenancePool({ ...options, ...change });
    }).toThrow(/^maintenance_pool_invalid$/u);
  } finally {
    await pool?.end();
  }
});

test.each(['identity', 'query-error', 'socket-error'])(
  'sanitizes %s on the physical admission path and never admits the client',
  async (fault) => {
    const pool = createMaintenancePool(options);
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        await Promise.resolve();
        if (fault === 'query-error') throw new Error('synthetic_private_connection_detail');
        if (fault === 'socket-error' && sql.includes('pg_roles'))
          client.emit('error', new Error('synthetic_private_socket_detail'));
        if (sql.includes('pg_control_system'))
          return {
            rows: [
              {
                id: fault === 'identity' ? '2222222222222222222' : '1111111111111111111',
                name: 'fcd_support_test',
              },
            ],
          };
        return {
          rows: [
            {
              name: 'fcd_test_pool_maintenance',
              login: 'fcd_test_pool_maintenance',
              restricted: true,
              scope:
                'fcd-support:database-role:v1:fcd_support_test:test_maintenance_pool:maintenance',
              owner: 'fcd_test_pool_migrator',
              schema_access: true,
              search_path: 'pg_catalog,"test_maintenance_pool",pg_temp',
              application_name: `fcd-support:operation_${'a'.repeat(32)}`,
            },
          ],
        };
      },
    });
    try {
      const admission = pool.options.verify;
      expect(admission).toBeTypeOf('function');
      const result = await new Promise<Error | undefined>((done) => {
        admission?.(client as unknown as pg.PoolClient, done);
      });
      expect(result?.message).toBe('maintenance_pool_invalid');
      // The connection can still emit before its actual socket closes.
      expect(() => client.emit('error', new Error('synthetic_late_socket_detail'))).not.toThrow();
      client.emit('end');
      expect(client.listenerCount('error')).toBe(0);
    } finally {
      await pool.end();
    }
  },
);
