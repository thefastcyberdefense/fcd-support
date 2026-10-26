import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { PostgresReceiptStore } from '../../src/persistence/postgres-receipt-store.js';
import { PostgresOperationsStore } from '../../src/persistence/postgres-operations-store.js';
import { PostgresProcessingWork } from '../../src/persistence/postgres-processing-work.js';
import { PostgresNotificationWork } from '../../src/persistence/postgres-notification-work.js';
import { PostgresOutboundWorkStore } from '../../src/persistence/postgres-outbound-work-store.js';
import { PostgresAdminIdentity } from '../../src/persistence/postgres-admin-identity.js';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import { runMaintenance } from '../../src/operations/maintenance.js';
import { runForwardMigrations } from '../../src/operations/forward-migration.js';
import { exportDeletionCheckpoint } from '../../src/operations/deletion-checkpoint.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { createEncryptedBackup, verifyEncryptedBackup } from '../../src/operations/backup.js';
import { registerBackup } from '../../src/operations/backup-command.js';
import { assertDatabaseIdentity } from '../../src/operations/database-identity.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import {
  createIsolatedTestDatabase,
  requireIsolatedTestDatabaseUrl,
  type IsolatedTestDatabase,
} from './test-database.js';

let database: IsolatedTestDatabase;
let root: string;
const rolePrefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const passwords: Record<string, string> = {};
const passwordFiles: Record<string, string> = {};
const pools = new Map<string, pg.Pool>();
const cleanups: (() => Promise<void>)[] = [];
const at = new Date('2030-03-01T00:00:00.000Z');
beforeAll(async () => {
  database = await createIsolatedTestDatabase('runtime_grants');
  cleanups.push(() => database.dispose());
  root = await mkdtemp(join(tmpdir(), 'fcd-grants-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  for (const role of [...runtimeDatabaseRoles, 'migrator']) {
    const path = join(root, role);
    const password = `synthetic_${rolePrefix}_${role}_password_only`;
    passwords[role] = password;
    passwordFiles[role] = path;
    await writeFile(path, password, { mode: 0o600 });
  }
  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
});
afterAll(async () => {
  for (const pool of pools.values()) await pool.end();
  for (const cleanup of cleanups.reverse()) await cleanup();
  const admin = new pg.Pool({
    connectionString: requireIsolatedTestDatabaseUrl(process.env),
    max: 1,
  });
  try {
    for (const role of [...runtimeDatabaseRoles, 'migrator']) {
      const name = `${rolePrefix}_${role}`;
      if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name))
        throw new Error('synthetic_role_scope_invalid');
      await admin.query(`drop owned by "${name}"`).catch(() => undefined);
      await admin.query(`drop role if exists "${name}"`);
    }
  } finally {
    await admin.end();
  }
});
function poolFor(role: string): pg.Pool {
  const prior = pools.get(role);
  if (prior !== undefined) return prior;
  const pool = new pg.Pool({
    connectionString: connectionFor(role),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 3000,
  });
  pools.set(role, pool);
  return pool;
}
function connectionFor(role: string): string {
  const url = new URL(database.connectionString);
  url.username = `${rolePrefix}_${role}`;
  url.password = passwords[role] ?? '';
  return url.toString();
}

test('the nonsuperuser migrator validates its actual database identity without owner credentials', async () => {
  const id = (
    await database.pool.query<{ id: string }>(
      'select system_identifier::text as id from pg_control_system()',
    )
  ).rows[0]?.id;
  if (id === undefined) throw new Error('synthetic_cluster_missing');
  expect(
    await runForwardMigrations(poolFor('migrator'), {
      schema: database.schema,
      expectedSchemaRevision: '000016',
      timeoutMilliseconds: 10000,
      expectedDatabaseIdentity: { systemIdentifier: id, databaseName: 'fcd_support_test' },
    }),
  ).toEqual({ schemaRevision: '000016' });
});

test.each(runtimeDatabaseRoles)('%s cannot mint or mutate restore bindings', async (role) => {
  const pool = poolFor(role);
  expect(
    (
      await pool.query(`select has_table_privilege(current_user,'operations_restore_bindings','INSERT')
    or has_table_privilege(current_user,'operations_restore_bindings','UPDATE')
    or has_table_privilege(current_user,'operations_restore_bindings','DELETE')
    or has_table_privilege(current_user,'operations_restore_bindings','TRUNCATE') as can_mutate`)
    ).rows,
  ).toEqual([{ can_mutate: false }]);
  await expect(
    pool.query('insert into operations_restore_bindings(restore_ref) values($1)', [
      `restore_${'0'.repeat(32)}`,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
});
test.each(runtimeDatabaseRoles)(
  '%s uses a real nonsuperuser login and cannot create application tables',
  async (role) => {
    const pool = poolFor(role);
    const result = await pool.query<{
      safe: boolean;
    }>(`select not rolsuper and not rolcreaterole and not rolcreatedb
    and not rolreplication and not rolbypassrls and not rolinherit as safe from pg_roles where rolname=current_user`);
    expect(result.rows).toEqual([{ safe: true }]);
    await expect(
      pool.query(`create table "${database.schema}".synthetic_forbidden(id integer)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('create temporary table synthetic_forbidden(id integer)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('create schema synthetic_forbidden')).rejects.toMatchObject({
      code: '42501',
    });
  },
);
test('webhook login performs actual receipt storage but cannot read admin credentials or contacts', async () => {
  const pool = poolFor('webhook');
  const result = await new PostgresReceiptStore(pool, syntheticPrivacyKeyring).store({
    events: [
      {
        kind: 'customer_message',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST_grants',
        contactId: 'CONTACT_TEST_grants',
        externalMessageId: 'MESSAGE_TEST_grants',
        idempotencyKey: 'whatsapp:message:MESSAGE_TEST_grants',
        occurredAt: at,
        text: 'Synthetic least-privilege receipt fixture',
      },
    ],
    payloadSha256: 'a'.repeat(64),
    receivedAt: at,
  });
  expect(result).toMatchObject({ outcome: 'accepted', insertedEventCount: 1 });
  await expect(pool.query('select password_hash from admin_accounts')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(pool.query('select * from contacts')).rejects.toMatchObject({ code: '42501' });
});
test('reply login reconciles real durable work without administration privileges', async () => {
  expect(await new PostgresProcessingWork(poolFor('reply')).reconcile(10, at)).toEqual({
    created: 1,
  });
  await expect(
    poolFor('reply').query('delete from admin_sessions where false'),
  ).rejects.toMatchObject({ code: '42501' });
});
test('health login records real incidents without consent writes or acknowledgement authority', async () => {
  const pool = poolFor('health');
  await new PostgresOperationsStore(pool).recordHealth({
    component: 'postgres',
    state: 'unavailable',
    reasonCode: 'dependency_unavailable',
    checkedAt: at,
    durationMilliseconds: 0,
  });
  expect(
    (
      await database.pool.query(
        "select count(*)::int as count from operations_incidents where component='postgres'",
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
  await expect(pool.query('delete from consent_events where false')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    pool.query('update operations_incidents set acknowledged_at=null where false'),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    pool.query(
      `insert into operations_incidents(incident_ref,component,opened_at,last_observed_at,
    consecutive_failures,acknowledged_at) values('INCIDENT_TEST_forbidden','postgres',$1,$1,1,$1)`,
      [at],
    ),
  ).rejects.toMatchObject({ code: '42501' });
});
test('backup is read-only for business data with only its required content-free catalog exception', async () => {
  const pool = poolFor('backup');
  expect((await pool.query('select count(*)::int as count from webhook_events')).rows).toEqual([
    { count: 1 },
  ]);
  await new PostgresOperationsStore(pool).recordBackup({
    backupRef: `backup_${'a'.repeat(32)}`,
    class: 'daily',
    createdAt: at,
    gitRevision: 'a'.repeat(40),
    schemaRevision: '000016',
    ciphertextBytes: 100,
    ciphertextSha256: 'b'.repeat(64),
    state: 'created',
  });
  await expect(pool.query('delete from webhook_events where false')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    pool.query('update operations_backups set ciphertext_sha256=ciphertext_sha256 where false'),
  ).rejects.toMatchObject({ code: '42501' });
  const sequences = await pool.query<{ denied: number }>(
    `select count(*)::int as denied from pg_class
    where relnamespace=$1::regnamespace and relkind='S' and not has_sequence_privilege(current_user,oid,'SELECT')`,
    [database.schema],
  );
  expect(sequences.rows).toEqual([{ denied: 0 }]);
  await expect(pool.query("select nextval('contacts_id_seq')")).rejects.toMatchObject({
    code: '42501',
  });
});

test('archive reader reads catalog metadata and actual source identity without export or mutation authority', async () => {
  const pool = poolFor('archive_reader');
  const identity = (
    await database.pool.query<{ id: string; name: string }>(
      'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
    )
  ).rows[0];
  if (identity === undefined) throw new Error('synthetic_cluster_missing');
  const client = await pool.connect();
  try {
    await expect(
      assertDatabaseIdentity(client, {
        systemIdentifier: identity.id,
        databaseName: identity.name,
      }),
    ).resolves.toBeUndefined();
  } finally {
    client.release();
  }
  expect((await pool.query('select count(*)::int as count from operations_backups')).rows).toEqual([
    { count: 1 },
  ]);
  expect(
    (await pool.query('select count(*)::int as count from operations_backup_events')).rows,
  ).toEqual([{ count: 1 }]);
  for (const sql of [
    'select * from contacts',
    'select * from webhook_events',
    'select * from admin_accounts',
    'select * from privacy_suppressions',
    'select * from pgmigrations',
    'select * from operations_deployments',
    "insert into operations_backups(backup_ref) values('backup_ffffffffffffffffffffffffffffffff')",
    'update operations_backups set state=state where false',
    'delete from operations_backups where false',
    'truncate operations_backups',
    'insert into operations_backup_events(backup_id) values(-1)',
    'update operations_backup_events set state=state where false',
    'delete from operations_backup_events where false',
    'truncate operations_backup_events',
    'select last_value from contacts_id_seq',
    "select nextval('contacts_id_seq')",
    'select lock_deletion_checkpoint_source()',
    'select runtime_recovery_held()',
    "select pg_read_file('PG_VERSION')",
    `set role "${rolePrefix}_backup"`,
    `set role "${rolePrefix}_migrator"`,
    'create role synthetic_forbidden_archive_role',
  ])
    await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
});

test('archive reader convergence removes stale business, catalog mutation and function grants', async () => {
  const name = `"${rolePrefix}_archive_reader"`;
  await database.pool.query(`grant select on contacts to ${name};
    grant update(state) on operations_backups to ${name};
    grant execute on function lock_deletion_checkpoint_source() to ${name}`);
  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
  const pool = poolFor('archive_reader');
  await expect(pool.query('select * from contacts')).rejects.toMatchObject({ code: '42501' });
  await expect(
    pool.query('update operations_backups set state=state where false'),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(pool.query('select lock_deletion_checkpoint_source()')).rejects.toMatchObject({
    code: '42501',
  });
  expect((await pool.query('select count(*)::int as count from operations_backups')).rows).toEqual([
    { count: 1 },
  ]);
});

test('bootstrap refuses concurrent schema privilege changes without waiting or partial changes', async () => {
  const lock = await database.pool.connect();
  try {
    await lock.query('begin');
    await lock.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `fcd-support:runtime-grants:fcd_support_test:${database.schema}`,
    ]);
    await expect(
      configureRuntimeGrants(database.pool, {
        schema: database.schema,
        database: 'fcd_support_test',
        rolePrefix,
        passwordFiles,
      }),
    ).rejects.toThrow(/^runtime_grants_invalid$/u);
  } finally {
    await lock.query('rollback');
    lock.release();
  }
});

test('runtime login cannot bootstrap and errors never echo credentials or SQL', async () => {
  await expect(
    configureRuntimeGrants(poolFor('webhook'), {
      schema: database.schema,
      database: 'fcd_support_test',
      rolePrefix,
      passwordFiles,
    }),
  ).rejects.toThrow(/^runtime_grants_invalid$/u);
  await expect(
    configureRuntimeGrants(database.pool, {
      schema: database.schema,
      database: 'fcd_support_test',
      rolePrefix: 'untrusted; SQL',
      passwordFiles,
    }),
  ).rejects.toThrow(/^runtime_grants_invalid$/u);
});

test('all PostgreSQL statement sampling is disabled before a password-bearing DDL query', async () => {
  const client = await database.pool.connect();
  const executeQuery = client.query.bind(client);
  let checked = false;
  const guardedClient = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
      return async (sql: unknown, ...parameters: unknown[]) => {
        if (typeof sql === 'string' && /^(create|alter) role .+ password /u.test(sql)) {
          checked = true;
          const control = await client.query<{ safe: boolean }>(`select
          current_setting('log_statement')='none' and current_setting('log_min_error_statement')='panic'
          and current_setting('log_min_duration_statement')='-1' and current_setting('log_min_duration_sample')='-1'
          and current_setting('log_statement_sample_rate')::numeric=0 and current_setting('log_transaction_sample_rate')::numeric=0
          and current_setting('log_parameter_max_length')='0' and current_setting('log_parameter_max_length_on_error')='0'
          and current_setting('password_encryption')='scram-sha-256' as safe`);
          // Assertion occurs BEFORE forwarding the credential-bearing query.
          expect(control.rows).toEqual([{ safe: true }]);
        }
        return Reflect.apply(executeQuery, client, [sql, ...parameters]) as unknown;
      };
    },
  });
  const pool = new Proxy(database.pool, {
    get(target, property, receiver) {
      if (property === 'connect') return () => Promise.resolve(guardedClient);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  await configureRuntimeGrants(pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
  expect(checked).toBe(true);
});

test('bootstrap clears stale role settings and binds new logins to the intended namespace', async () => {
  await database.pool.query(
    `alter role "${rolePrefix}_webhook" in database fcd_support_test set search_path=public`,
  );
  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
  const url = new URL(connectionFor('webhook'));
  url.search = '';
  const fresh = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    expect((await fresh.query('select count(*)::int as count from webhook_events')).rows).toEqual([
      { count: 1 },
    ]);
  } finally {
    await fresh.end();
  }
});

test.each([
  'outsider_membership',
  'runtime_membership',
  'foreign_scope',
  'unknown_table',
  'reused_password',
] as const)(
  'bootstrap refuses %s and leaves its established privilege boundary intact',
  async (kind) => {
    const principal = `"${rolePrefix}_webhook"`;
    const probe = `"${rolePrefix}_probe"`;
    const tag = `fcd-support:database-role:v1:fcd_support_test:${database.schema}:webhook`;
    try {
      if (kind === 'outsider_membership' || kind === 'runtime_membership') {
        await database.pool.query(
          `create role ${probe} nologin nosuperuser nocreaterole nocreatedb noreplication nobypassrls`,
        );
        await database.pool.query(
          kind === 'outsider_membership'
            ? `grant ${principal} to ${probe}`
            : `grant ${probe} to ${principal}`,
        );
      } else if (kind === 'foreign_scope')
        await database.pool.query(`comment on role ${principal} is 'synthetic_unmanaged_scope'`);
      else if (kind === 'unknown_table')
        await database.pool.query('create table synthetic_unmapped_privileges(id integer)');
      else await writeFile(passwordFiles.webhook ?? '', passwords.admin ?? '', { mode: 0o600 });
      await expect(
        configureRuntimeGrants(database.pool, {
          schema: database.schema,
          database: 'fcd_support_test',
          rolePrefix,
          passwordFiles,
        }),
      ).rejects.toThrow(/^runtime_grants_invalid$/u);
    } finally {
      if (kind === 'outsider_membership' || kind === 'runtime_membership')
        await database.pool.query(`drop role ${probe}`);
      else if (kind === 'foreign_scope')
        await database.pool.query(`comment on role ${principal} is '${tag}'`);
      else if (kind === 'unknown_table')
        await database.pool.query('drop table synthetic_unmapped_privileges');
      else await writeFile(passwordFiles.webhook ?? '', passwords.webhook ?? '', { mode: 0o600 });
    }
    await expect(poolFor('webhook').query('select * from admin_accounts')).rejects.toMatchObject({
      code: '42501',
    });
  },
);
test('notification and verification logins cannot change conversation/consent authority', async () => {
  for (const role of ['notification', 'verify_backup']) {
    await expect(
      poolFor(role).query('delete from conversations where false'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      poolFor(role).query('delete from consent_events where false'),
    ).rejects.toMatchObject({ code: '42501' });
  }
});

test('checkpoint login freezes its source without receiving tombstone write privileges', async () => {
  const client = await poolFor('checkpoint').connect();
  try {
    await client.query('begin');
    await client.query('select lock_deletion_checkpoint_source()');
    expect(
      (
        await client.query<{ locked: boolean }>(`select exists(select 1 from pg_locks where
      pid=pg_backend_pid() and relation='privacy_suppressions'::regclass and mode='ShareLock') as locked`)
      ).rows,
    ).toEqual([{ locked: true }]);
    await client.query('rollback');
    await expect(
      client.query('update privacy_suppressions set expires_at=null where false'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query('update deletion_checkpoint_clock set revision=0'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test('bootstrap converges table, column and function grants instead of accumulating privilege', async () => {
  const name = `"${rolePrefix}_webhook"`;
  await database.pool
    .query(`grant select on contacts to ${name}; grant update(expires_at) on privacy_suppressions to ${name};
    grant execute on function runtime_recovery_held() to ${name}`);
  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
  await expect(poolFor('webhook').query('select * from contacts')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    poolFor('webhook').query('update privacy_suppressions set expires_at=null where false'),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(poolFor('webhook').query('select runtime_recovery_held()')).rejects.toMatchObject({
    code: '42501',
  });
});

const outboundBounds = {
  global1Minute: 120,
  globalUtcDay: 900,
  leaseMs: 25000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 80,
  perContact15Minute: 3,
  perContact24Hour: 30,
  providerTimeoutMs: 8000,
  retryBaseMs: 5000,
  retryMaximumMs: 30000,
  whatsappAccount1Minute: 90,
  workerBatchSize: 10,
};
test('outbound login executes bounded lease recovery without admin or tombstone authority', async () => {
  const result = await new PostgresOutboundWorkStore(
    poolFor('outbound'),
    syntheticPrivacyKeyring,
    outboundBounds,
  ).expireLeases({ expiredAt: at, limit: 10 });
  expect(result).toEqual({ deliveryUnknown: 0, returnedToPending: 0 });
  await expect(
    poolFor('outbound').query('update privacy_suppressions set expires_at=null where false'),
  ).rejects.toMatchObject({ code: '42501' });
});

test('notification login reconciles, claims and finishes real content-free escalation delivery', async () => {
  // Root-only fixture construction; all delivery operations use the real runtime login.
  const source = await insertSyntheticAppliedCustomerEvent(database.pool, {
    fixtureKey: 'grants_notification',
    identity: {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_grants',
      externalContactId: 'CONTACT_TEST_grants_notification',
    },
    occurredAt: at,
  });
  await database.pool.query(
    `insert into support_escalation_outcomes(escalation_ref,conversation_id,source_webhook_event_id,reason_code,state,request_key,created_at,updated_at)
    values('ESCALATION_TEST_grants',$1,$2,'provider_failure','open','REQUEST_TEST_grants',$3,$3)`,
    [source.conversationId, source.eventId, at],
  );
  const work = new PostgresNotificationWork(poolFor('notification'), {
    maximumAttempts: 3,
    retryBaseMilliseconds: 1000,
    retryMaximumMilliseconds: 8000,
  });
  expect(await work.reconcile(10, at)).toEqual({ created: 1 });
  const first = (
    await work.claim({
      workerRef: 'WORKER_TEST_grants',
      evaluatedAt: at,
      limit: 10,
      leaseMilliseconds: 1000,
    })
  )[0];
  expect(first).toBeDefined();
  if (first === undefined) throw new Error('synthetic_notification_missing');
  expect(
    await work.authorize({
      workRef: first.workRef,
      leaseRef: first.leaseRef,
      evaluatedAt: at,
      requiredLeaseMilliseconds: 100,
    }),
  ).toBe(true);
  await work.finish({
    workRef: first.workRef,
    leaseRef: first.leaseRef,
    evaluatedAt: at,
    result: { status: 'accepted', reasonCode: 'ok' },
  });
});

test('maintenance login runs all four bounded jobs without knowledge publication authority', async () => {
  const options = {
    pool: poolFor('maintenance'),
    keyring: syntheticPrivacyKeyring,
    outboundBounds,
    now: () => at,
    scheduledAt: at,
    limit: 10,
    runRef: 'RUN_TEST_grants',
    learningWindowMilliseconds: 86400000,
    learningPolicy: {
      minimumGroupCount: 3,
      digestIntervalMilliseconds: 259200000,
      maximumQuestionsPerDigest: 5,
      questionCooldownMilliseconds: 604800000,
      maximumDigestAppearances: 2,
      maximumObservationsPerRun: 1000,
    },
  };
  for (const job of ['retention', 'deletion', 'lease_recovery', 'learning'] as const)
    expect(await runMaintenance(job, options)).toMatchObject({ status: 'completed' });
  await expect(
    poolFor('maintenance').query('update knowledge_versions set state=state where false'),
  ).rejects.toMatchObject({ code: '42501' });
});

test('admin login performs real password/MFA authentication while webhook cannot read its credentials', async () => {
  const seed = new AdminSecretBytes(Buffer.alloc(20, 9));
  const totpPolicy = {
    algorithm: 'sha1',
    digits: 6,
    periodSeconds: 30,
    verificationWindow: 0,
  } as const;
  const identity = new PostgresAdminIdentity(poolFor('admin'), {
    mfaProtector: new AesGcmAdminSecretProtector(
      'synthetic_grants_v1',
      new AdminSecretBytes(Buffer.alloc(32, 11)),
    ),
    sessionHmacKey: new AdminSecretBytes(Buffer.alloc(32, 12)),
    passwordPolicy: {
      algorithm: 'scrypt_v1',
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
      saltLength: 16,
      keyLength: 32,
    },
    totpPolicy,
    preauthenticationTtlMilliseconds: 300000,
    sessionTtlMilliseconds: 3600000,
    now: () => at,
  });
  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_grants',
      loginName: 'synthetic.grants',
      mfaSeed: seed,
      password: new AdminSecretText('synthetic_grants_passphrase'),
      requestKey: 'REQUEST_TEST_grants_admin',
      createdAt: at,
    },
    { kind: 'initial_bootstrap' },
  );
  const first = await identity.beginPasswordAuthentication({
    loginName: 'synthetic.grants',
    password: new AdminSecretText('synthetic_grants_passphrase'),
  });
  expect(first.status).toBe('mfa_required');
  if (first.status !== 'mfa_required') throw new Error('synthetic_authentication_failed');
  const result = await identity.completeMfaAuthentication({
    code: generateTotpCode(seed, at, totpPolicy),
    preauthenticationToken: first.sessionToken,
  });
  expect(result.status).toBe('authenticated');
});

test.skipIf(process.env.RUN_ENCRYPTED_BACKUP_TESTS !== 'synthetic-operations-toolchain-only')(
  'real checkpoint export and encrypted backup work under their distinct nonsuperuser logins',
  async () => {
    const archiveRoot = process.env.BACKUP_TEST_ARCHIVE_ROOT;
    if (archiveRoot !== '/var/lib/fcd-support/backups')
      throw new Error('synthetic_archive_root_invalid');
    const archive = await mkdtemp(join(archiveRoot, `${basename(root)}-`));
    await chmod(archive, 0o700);
    const identity = join(root, 'identity');
    const recipient = join(root, 'recipient');
    const generate = spawn('age-keygen', ['--output', identity], { stdio: 'ignore' });
    await new Promise<void>((done, reject) => {
      generate.once('error', () => {
        reject(new Error('synthetic_keygen_failed'));
      });
      generate.once('close', (code) => {
        if (code === 0) done();
        else reject(new Error('synthetic_keygen_failed'));
      });
    });
    await chmod(identity, 0o600);
    const derive = spawn('age-keygen', ['-y', identity], { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = '';
    derive.stdout.setEncoding('utf8');
    derive.stdout.on('data', (value: string) => {
      bytes += value;
    });
    await new Promise<void>((done, reject) => {
      derive.once('error', () => {
        reject(new Error('synthetic_keygen_failed'));
      });
      derive.once('close', (code) => {
        if (code === 0) done();
        else reject(new Error('synthetic_keygen_failed'));
      });
    });
    await writeFile(recipient, bytes, { mode: 0o600 });
    try {
      await poolFor('maintenance').query(
        `insert into privacy_suppressions
        (identity_hmac,channel,category,reason_code,effective_at,key_version)
        values($1,'messenger','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
        ['b'.repeat(64), at],
      );
      const manifest = await exportDeletionCheckpoint({
        sourcePool: poolFor('checkpoint'),
        recipientFile: recipient,
        signingKey: new AdminSecretBytes(Buffer.from('synthetic_grants_manifest_key_'.repeat(2))),
        archiveDirectory: archive,
        sourceRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        now: at,
        timeoutMilliseconds: 10000,
        maximumRows: 100,
        maximumPayloadBytes: 1048576,
      });
      expect(manifest.rowCount).toBe(1);
      expect(
        (await database.pool.query('select count(*)::int as count from deletion_checkpoints')).rows,
      ).toEqual([{ count: 1 }]);
      const keyFile = join(root, 'manifest-key');
      await writeFile(keyFile, 'synthetic_grants_backup_signing_key_'.repeat(2), { mode: 0o600 });
      const backupUrl = new URL(connectionFor('backup'));
      // pg_dump uses the explicit schema allowlist, not this fixture's pool-only search_path.
      backupUrl.search = '';
      const backup = await createEncryptedBackup({
        connectionString: backupUrl.toString(),
        recipientFile: recipient,
        manifestHmacFile: keyFile,
        archiveDirectory: archive,
        temporaryDirectory: root,
        gitRevision: 'a'.repeat(40),
        schemaRevision: '000016',
        backupClass: 'pre_migration',
        now: at,
        timeoutMilliseconds: 10000,
        schemas: [database.schema],
      });
      await registerBackup(poolFor('backup'), backup, 'created');
      await verifyEncryptedBackup({
        archiveDirectory: archive,
        manifestHmacFile: keyFile,
        identityFile: identity,
        expectedManifest: backup,
        timeoutMilliseconds: 10000,
      });
      await registerBackup(poolFor('verify_backup'), backup, 'verified');
      expect(
        (
          await database.pool.query('select state from operations_backups where backup_ref=$1', [
            backup.backupRef,
          ])
        ).rows,
      ).toEqual([{ state: 'verified' }]);
      const databaseFile = join(root, 'backup-database');
      await writeFile(databaseFile, backupUrl.toString(), { mode: 0o600 });
      const actualSource = (
        await database.pool.query<{ id: string; name: string }>(
          'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
        )
      ).rows[0];
      if (actualSource === undefined) throw new Error('synthetic_cluster_missing');
      const child = spawn(
        process.execPath,
        ['/app/dist/operations-main.js', 'pre-migration-backup', '2001-01-01T00:00:00.000Z'],
        {
          cwd: '/app',
          env: {
            ...operationsEnvironment(),
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            DATABASE_URL_FILE: databaseFile,
            OPS_GIT_REVISION: 'a'.repeat(40),
            OPS_SCHEMA_REVISION: '000017',
            OPS_DATABASE_SYSTEM_IDENTIFIER: actualSource.id,
            OPS_DATABASE_NAME: actualSource.name,
            BACKUP_ENCRYPTION_RECIPIENT_FILE: recipient,
            RECOVERY_MANIFEST_HMAC_FILE: keyFile,
            BACKUP_ARCHIVE_DIRECTORY: archive,
            BACKUP_TMPFS_DIRECTORY: root,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (value: string) => {
        output += value;
        if (output.length > 2048) child.kill('SIGKILL');
      });
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', () => {
          reject(new Error('synthetic_cli_spawn_failed'));
        });
        child.once('close', done);
      });
      expect(code).toBe(0);
      expect(output.trim()).toMatch(/^backup_[a-f0-9]{32}$/u);
      const material = JSON.parse(
        await readFile(join(archive, output.trim(), 'manifest.json'), 'utf8'),
      ) as { schemaRevision: string };
      // The target setting must not rewrite the source archive's actual version.
      expect(material.schemaRevision).toBe('000016');
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  },
);
