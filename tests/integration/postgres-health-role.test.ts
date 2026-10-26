import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, test } from 'vitest';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { postgresHealthDatabase } from '../../src/persistence/postgres-admin-operations.js';
import { runHealthCommand } from '../../src/operations/health-main.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

test('health principal reads real queue aggregates while customer columns and admin credentials remain denied', async () => {
  const database = await createIsolatedTestDatabase('health_grants');
  const prefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const root = await mkdtemp(join(tmpdir(), 'fcd-health-grants-'));
  await chmod(root, 0o700);
  const files: Record<string, string> = {};
  const passwords: Record<string, string> = {};
  let health: pg.Pool | undefined;
  try {
    for (const role of [...runtimeDatabaseRoles, 'migrator']) {
      const file = join(root, role);
      const password = `synthetic_${prefix}_${role}`;
      files[role] = file;
      passwords[role] = password;
      await writeFile(file, password, { mode: 0o600 });
    }
    await configureRuntimeGrants(database.pool, {
      schema: database.schema,
      database: 'fcd_support_test',
      rolePrefix: prefix,
      passwordFiles: files,
    });
    const url = new URL(database.connectionString);
    url.username = `${prefix}_health`;
    url.password = passwords.health ?? '';
    health = new pg.Pool({ connectionString: url.toString(), max: 1, statement_timeout: 3000 });
    const snapshot = await postgresHealthDatabase(
      health,
      () => new Date('2030-01-01T00:00:00.000Z'),
    ).read();
    expect(snapshot.queues).toHaveLength(3);
    expect(
      snapshot.queues.every((value) => value.pending === 0 && value.oldestAgeBucket === 'empty'),
    ).toBe(true);
    const target = (
      await database.pool.query<{ id: string }>(
        'select system_identifier::text as id from pg_catalog.pg_control_system()',
      )
    ).rows[0]?.id;
    const acknowledgements: string[] = [];
    expect(
      await runHealthCommand({
        args: ['health'],
        environment: {
          ...operationsEnvironment(),
          DATABASE_URL: url.toString(),
          OPS_GIT_REVISION: 'a'.repeat(40),
          OPS_SCHEMA_REVISION: '000016',
          OPS_DATABASE_SYSTEM_IDENTIFIER: target,
          OPS_DATABASE_NAME: 'fcd_support_test',
          OPS_DATABASE_SCHEMA: database.schema,
          OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
            health: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
          }),
        },
        input: {},
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        write: (line) => {
          acknowledgements.push(line);
        },
      }),
    ).toBe(0);
    expect(acknowledgements.map((line) => JSON.parse(line) as unknown)).toEqual([
      { status: 'completed', processed: 11, reasonCode: 'ok' },
    ]);
    expect(
      (
        await database.pool.query(
          "select state from operations_health_checks where component='postgres'",
        )
      ).rows,
    ).toEqual([{ state: 'healthy' }]);
    await expect(
      health.query('select channel_identity_id from outbound_intents limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      health.query('select session_hash from admin_sessions limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      health.query('select message_text from webhook_events limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await health?.end();
    const cleanup = new pg.Pool({ connectionString: database.connectionString, max: 1 });
    try {
      // Grant setup transfers schema ownership to the migrator. Dispose the
      // schema first so role cleanup cannot mask the assertion that failed.
      await database.dispose();
      for (const role of [...runtimeDatabaseRoles, 'migrator']) {
        const name = `${prefix}_${role}`;
        if (/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name)) {
          await cleanup.query(`drop owned by "${name}"`).catch(() => undefined);
          await cleanup.query(`drop role if exists "${name}"`);
        }
      }
    } finally {
      await cleanup.end();
    }
    if (root.startsWith(join(tmpdir(), 'fcd-health-grants-')))
      await rm(root, { recursive: true, force: true });
  }
});
