import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { configureRuntimeGrants } from '../src/persistence/postgres-runtime-grants.js';

const roles = [
  'webhook',
  'admin',
  'reply',
  'outbound',
  'notification',
  'maintenance',
  'health',
  'backup',
  'verify_backup',
  'checkpoint',
  'archive_reader',
  'migrator',
];

async function passwords(run: (files: Record<string, string>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'fcd-synthetic-archive-grants-'));
  await chmod(root, 0o700);
  try {
    const files: Record<string, string> = {};
    for (const role of roles) {
      files[role] = join(root, role);
      await writeFile(files[role], `synthetic_archive_grants_${role}_password_only`, {
        mode: 0o600,
      });
    }
    await run(files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.each(['prepare', 'converge'] as const)(
  '%s provisions the distinct archive login with metadata and physical identity access only',
  async (phase) => {
    await passwords(async (passwordFiles) => {
      const statements: string[] = [];
      // The external PostgreSQL boundary records only non-secret statements.
      // Actual privilege enforcement is covered by the nonsuperuser SQL suite.
      const client = Object.assign(new EventEmitter(), {
        release: vi.fn(),
        query: (sql: string) => {
          if (!sql.includes(" password '")) statements.push(sql);
          if (sql.includes('current_database() as name'))
            return Promise.resolve({ rows: [{ name: 'fcd_support_test', privileged: true }] });
          if (sql.includes('pg_try_advisory_xact_lock'))
            return Promise.resolve({ rows: [{ acquired: true }] });
          if (sql.includes('select relname,relkind'))
            return Promise.resolve({
              rows: [
                { relname: 'pgmigrations', relkind: 'r' },
                { relname: 'webhook_receipts', relkind: 'r' },
                { relname: 'operations_backups', relkind: 'r' },
                { relname: 'operations_backup_events', relkind: 'r' },
                { relname: 'operations_deployments', relkind: 'r' },
              ],
            });
          return Promise.resolve({ rows: [] });
        },
      });
      const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
      await configureRuntimeGrants(pool, {
        schema: 'test_archive_reader',
        database: 'fcd_support_test',
        rolePrefix: 'fcd_test_archive',
        phase,
        passwordFiles,
      });
      const role = '"fcd_test_archive_archive_reader"';
      expect(
        statements.filter((sql) => sql.startsWith('grant ') && sql.endsWith(` to ${role}`)),
      ).toEqual([
        `grant usage on schema "test_archive_reader" to ${role}; grant connect on database "fcd_support_test" to ${role}`,
        `grant select on "test_archive_reader"."operations_backups","test_archive_reader"."operations_backup_events" to ${role}`,
        `grant execute on function pg_catalog.pg_control_system() to ${role}`,
      ]);
      expect(statements).toContain('commit');
      expect(client.release).toHaveBeenCalledWith(true);
    });
  },
);

test('old bootstrap password sets cannot provision roles without an independent archive credential', async () => {
  await passwords(async (passwordFiles) => {
    delete passwordFiles.archive_reader;
    const connect = vi.fn(() => Promise.reject(new Error('synthetic_connection_must_not_open')));
    await expect(
      configureRuntimeGrants({ connect } as unknown as pg.Pool, {
        schema: 'test_archive_reader',
        database: 'fcd_support_test',
        rolePrefix: 'fcd_test_archive',
        passwordFiles,
      }),
    ).rejects.toThrow(/^runtime_grants_invalid$/u);
    expect(connect).not.toHaveBeenCalled();
  });
});
