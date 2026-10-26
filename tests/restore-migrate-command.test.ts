import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { runRestoreMigrateCommand } from '../src/operations/restore-migrate-main.js';
import type { ForwardMigrationOptions } from '../src/operations/forward-migration.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

// All values are authored synthetic fixtures; no connection is opened.
const identifier = '7300000000000000001';
function fixture() {
  const lines: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const reads: Uint8Array[] = [];
  const configurations: pg.PoolConfig[] = [];
  const pool = Object.assign(new EventEmitter(), {
    identifier,
    role: 'fcd_synthetic_migrator',
    privileged: false,
    memberships: false,
    closed: false,
    closeFailure: false,
    connect: () => {
      const client = Object.assign(new EventEmitter(), {
        query: (sql: string) => {
          if (sql.includes('pg_control_system'))
            return Promise.resolve({ rows: [{ id: pool.identifier, name: 'fcd_support_test' }] });
          if (sql.includes('pg_roles'))
            return Promise.resolve({
              rows: [
                {
                  name: pool.role,
                  session: pool.role,
                  privileged: pool.privileged,
                  memberships: pool.memberships,
                  read_only: false,
                },
              ],
            });
          throw new Error('synthetic_unexpected_query');
        },
        release: () => {
          events.push('release');
        },
      });
      pool.emit('connect', client);
      return Promise.resolve(client);
    },
    end: () => {
      events.push('close');
      pool.closed = true;
      return pool.closeFailure
        ? Promise.reject(new Error('synthetic_close_secret'))
        : Promise.resolve();
    },
  });
  const environment: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
    OPS_DATABASE_NAME: 'fcd_support_test',
    OPS_DATABASE_SCHEMA: 'public',
    OPS_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
    OPS_SCHEMA_REVISION: '000016',
    OPS_GIT_REVISION: 'd'.repeat(40),
    OPS_OPERATION_REFERENCE: `operation_${'e'.repeat(32)}`,
    OPS_MAX_CALL_MS: '20000',
    DATABASE_URL_FILE: '/run/secrets/synthetic-migrator',
  };
  let uri = 'postgresql://fcd_synthetic_migrator:synthetic_migrator@127.0.0.1/fcd_support_test';
  const migrate = vi.fn((_pool: pg.Pool, options: ForwardMigrationOptions) => {
    events.push('migrate');
    return Promise.resolve({ schemaRevision: options.expectedSchemaRevision });
  });
  const options = {
    args: ['migrate', identifier],
    environment,
    readSecret: () => {
      const bytes = Buffer.from(uri);
      reads.push(bytes);
      return Promise.resolve(bytes);
    },
    createPool: (configuration: pg.PoolConfig) => {
      configurations.push(configuration);
      return pool as unknown as pg.Pool;
    },
    migrate,
    write: (line: string) => {
      events.push('stdout');
      lines.push(line);
    },
    error: (line: string) => {
      errors.push(line);
    },
  };
  return {
    options,
    pool,
    lines,
    errors,
    reads,
    configurations,
    migrate,
    events,
    setUri: (value: string) => {
      uri = value;
    },
  };
}

const completed = '{"status":"completed","processed":1,"reasonCode":"ok"}\n';
test('target migration accepts shared nonsecret scheduling policy without gaining source capabilities', async () => {
  const f = fixture();
  f.options.environment = { ...operationsEnvironment(), ...f.options.environment };
  Object.assign(f.options.environment, {
    PG_MAJOR: '18',
    PG_VERSION: '18.4-1.pgdg13+1',
    PGDATA: '/var/lib/postgresql/18/docker',
  });
  expect(await runRestoreMigrateCommand(f.options)).toBe(0);
  expect(f.lines).toEqual([completed]);
});
test('target migration uses only the restricted role on a fixed isolated alias and binds real migration identity', async () => {
  const f = fixture();
  expect(await runRestoreMigrateCommand(f.options)).toBe(0);
  const config = f.configurations[0];
  expect(f.configurations).toHaveLength(1);
  expect(new URL(config?.connectionString ?? '').hostname).toBe('fcd-support-restore-postgres');
  expect(new URL(config?.connectionString ?? '').username).toBe('fcd_synthetic_migrator');
  expect(config).toMatchObject({
    max: 1,
    ssl: false,
    connectionTimeoutMillis: 20000,
    query_timeout: 20000,
    statement_timeout: 20000,
    idle_in_transaction_session_timeout: 20000,
    application_name: `fcd-support:operation_${'e'.repeat(32)}`,
  });
  expect(config?.options).toBe(
    `-c application_name=fcd-support:operation_${'e'.repeat(32)} -c search_path=public,public`,
  );
  expect(f.migrate.mock.calls[0]?.[1]).toEqual({
    schema: 'public',
    expectedSchemaRevision: '000016',
    timeoutMilliseconds: 20000,
    expectedDatabaseIdentity: { systemIdentifier: identifier, databaseName: 'fcd_support_test' },
    expectedMigratorRole: 'fcd_synthetic_migrator',
  });
  expect(f.events.slice(-2)).toEqual(['close', 'stdout']);
  expect(f.reads.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  expect(f.lines).toEqual([completed]);
  expect(f.errors).toEqual([]);
});

test('migration rejects source, owner, bootstrap, archive and ambient PG capabilities before reading credentials', async () => {
  for (const [name, value] of [
    ['RESTORE_SOURCE_CHECKPOINT_DATABASE_URL_FILE', '/run/secrets/synthetic-checkpoint'],
    ['RESTORE_TARGET_OWNER_DATABASE_URL_FILE', '/run/secrets/synthetic-owner'],
    ['RESTORE_BOOTSTRAP_PASSWORD_DIRECTORY', '/run/secrets'],
    ['BACKUP_ARCHIVE_DIRECTORY', '/var/lib/fcd-support/backups'],
    ['CHECKPOINT_ARCHIVE_DIRECTORY', '/var/lib/fcd-support/checkpoints'],
    ['PRIVACY_HMAC_KEYRING_FILE', '/run/secrets/synthetic-keyring'],
    ['META_APP_SECRET_FILE', '/run/secrets/synthetic-meta'],
    ['PGPASSWORD', 'synthetic_password'],
    ['DATABASE_URL', 'synthetic_uri'],
    ['OPS_SOURCE_DATABASE_SYSTEM_IDENTIFIER', '7300000000000000000'],
    ['MODEL_EXECUTION_ENABLED', 'true'],
    ['OPS_MAX_CALL_MS', '0'],
    ['OPS_MAX_CALL_MS', '300001'],
    ['OPS_DATABASE_NAME', 'postgres'],
    ['OPS_DATABASE_SCHEMA', 'public;select'],
    ['OPS_DATABASE_ROLE_PREFIX', 'postgres'],
    ['OPS_SCHEMA_REVISION', '16'],
    ['OPS_GIT_REVISION', 'synthetic_invalid'],
    ['OPS_OPERATION_REFERENCE', 'synthetic_invalid'],
  ]) {
    const f = fixture();
    f.options.environment[name ?? ''] = value;
    expect(await runRestoreMigrateCommand(f.options)).toBe(1);
    expect(f.reads).toEqual([]);
    expect(f.configurations).toEqual([]);
    expect(f.migrate).not.toHaveBeenCalled();
    expect(f.lines).toEqual([]);
    expect(f.errors).toEqual(['restore_migrate_command_failed\n']);
  }
});

test('migration rejects missing bounds, wrong commands and nonphysical targets before opening a pool', async () => {
  for (const args of [
    [],
    ['migrate'],
    ['restore', identifier],
    ['migrate', '0'],
    ['migrate', '18446744073709551616'],
    ['migrate', identifier, 'extra'],
  ]) {
    const f = fixture();
    f.options.args = args;
    expect(await runRestoreMigrateCommand(f.options)).toBe(1);
    expect(f.configurations).toEqual([]);
    expect(f.lines).toEqual([]);
  }
  const f = fixture();
  delete f.options.environment.OPS_MAX_CALL_MS;
  expect(await runRestoreMigrateCommand(f.options)).toBe(1);
  expect(f.reads).toEqual([]);
});

test('migration rejects owner URI and connection-option injection without allocating a pool', async () => {
  for (const uri of [
    'postgresql://postgres:synthetic_owner@127.0.0.1/fcd_support_test',
    'postgresql://fcd_synthetic_migrator:synthetic_migrator@127.0.0.1/fcd_support_test?options=-c%20role=postgres',
  ]) {
    const f = fixture();
    f.setUri(uri);
    expect(await runRestoreMigrateCommand(f.options)).toBe(1);
    expect(f.configurations).toEqual([]);
    expect(f.lines).toEqual([]);
    expect(f.reads.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  }
});

test('wrong physical instance, privileged role or membership refuses before migration and closes', async () => {
  for (const mode of ['physical', 'privileged', 'memberships'] as const) {
    const f = fixture();
    if (mode === 'physical') f.pool.identifier = '7300000000000000099';
    else f.pool[mode] = true;
    expect(await runRestoreMigrateCommand(f.options)).toBe(1);
    expect(f.migrate).not.toHaveBeenCalled();
    expect(f.pool.closed).toBe(true);
    expect(f.lines).toEqual([]);
  }
});

test('migration failure, async pool error, bad schema result and failed close never acknowledge', async () => {
  for (const mode of ['migration', 'pool', 'result', 'close'] as const) {
    const f = fixture();
    f.options.migrate = vi.fn(() => {
      if (mode === 'migration') return Promise.reject(new Error('synthetic_external_secret'));
      if (mode === 'pool') f.pool.emit('error', new Error('synthetic_pool_secret'));
      if (mode === 'close') f.pool.closeFailure = true;
      return Promise.resolve({ schemaRevision: mode === 'result' ? '000001' : '000016' });
    });
    expect(await runRestoreMigrateCommand(f.options)).toBe(1);
    expect(f.pool.closed).toBe(true);
    expect(f.lines).toEqual([]);
    expect(f.errors).toEqual(['restore_migrate_command_failed\n']);
  }
});
