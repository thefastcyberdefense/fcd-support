import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  PostgresRestoreEvidence,
  type SealRestoreEvidence,
} from '../../src/persistence/postgres-restore-evidence.js';
import { PostgresRestoreDeletionGate } from '../../src/persistence/postgres-restore-deletion-gate.js';
import { PostgresRestoreFence } from '../../src/persistence/postgres-restore-fence.js';
import { syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let database: IsolatedTestDatabase;
beforeAll(async () => {
  database = await createIsolatedTestDatabase('restore_binding');
});
afterAll(async () => {
  await database.dispose();
});

async function fixture(missing?: 'import' | 'hold' | 'gate', scope = database) {
  const restoreRef = `restore_${randomUUID().replaceAll('-', '')}`;
  const gateRef = `gate_${randomUUID().replaceAll('-', '')}`;
  const backupRef = `backup_${randomUUID().replaceAll('-', '')}`;
  const checkpointRef = `checkpoint_${randomUUID().replaceAll('-', '')}`;
  const at = new Date('2030-03-01T00:00:00.000Z');
  const system = (
    await scope.pool.query<{ id: string; name: string }>(
      'select system_identifier::text as id,current_database() as name from pg_control_system()',
    )
  ).rows[0];
  if (system === undefined) throw new Error('synthetic_cluster_missing');
  const target = {
    projectName: 'fcd-support-restore-synthetic',
    volumeName: 'fcd-support-restore-synthetic-data',
    volumeCreatedAt: '2030-02-28T00:00:00.000Z',
    networkId: 'a'.repeat(64),
    postgresImageId: `sha256:${'b'.repeat(64)}`,
    runtimeImageId: `sha256:${'c'.repeat(64)}`,
    systemIdentifier: system.id,
    databaseName: system.name,
    schema: scope.schema,
  };
  await scope.pool.query(
    "insert into operations_restore_runs(restore_ref,backup_ref,checkpoint_ref,git_revision,schema_revision,state,recorded_at) values($1,$2,$3,$4,'000016','isolated',$5)",
    [restoreRef, backupRef, checkpointRef, 'd'.repeat(40), at],
  );
  if (missing !== 'import')
    await scope.pool.query(
      "insert into restore_checkpoint_imports(restore_ref,checkpoint_ref,source_epoch,sequence,row_count,required_key_versions,ciphertext_sha256,signature,imported_at) values($1,$2,$3,0,0,'{}',$4,$5,$6)",
      [restoreRef, checkpointRef, randomUUID(), 'e'.repeat(64), 'f'.repeat(64), at],
    );
  if (missing !== 'hold')
    await new PostgresRestoreFence(scope.pool).quarantine({ restoreRef, evaluatedAt: at });
  const command = {
    gateRef,
    gitRevision: 'd'.repeat(40),
    requiredKeyVersions: ['TEST_v1'],
    evaluatedAt: at,
  };
  const gate = new PostgresRestoreDeletionGate(scope.pool, syntheticPrivacyKeyring);
  await gate.reapplyBatch({ ...command, requestKey: `${gateRef}:batch`, limit: 1 });
  if (missing !== 'gate') await gate.finalizeGate({ ...command, requestKey: `${gateRef}:final` });
  return {
    restoreRef,
    backupRef,
    checkpointRef,
    gitRevision: 'd'.repeat(40),
    schemaRevision: '000016',
    target,
    sourceSystemIdentifier: '1234567890123456789',
    gateRef,
    requiredKeyVersions: ['TEST_v1'],
    evaluatedAt: at,
  };
}

test('persists immutable target and checkpoint binding joined to real gate, import and recovery evidence', async () => {
  const input = await fixture();
  const store = new PostgresRestoreEvidence(database.pool);
  const binding = await store.seal(input);
  expect(binding).toMatchObject({
    restoreRef: input.restoreRef,
    target: input.target,
    checkpointRef: input.checkpointRef,
    requiredKeyVersions: ['TEST_v1'],
    recoveryHeldAtSeal: true,
  });
  expect(await store.load(input.restoreRef)).toEqual(binding);
  await expect(
    database.pool.query(
      'update operations_restore_bindings set git_revision=$2 where restore_ref=$1',
      [input.restoreRef, 'a'.repeat(40)],
    ),
  ).rejects.toMatchObject({ code: '55000' });
  await expect(
    database.pool.query('delete from operations_restore_bindings where restore_ref=$1', [
      input.restoreRef,
    ]),
  ).rejects.toMatchObject({ code: '55000' });
});

test('binding retains exact offset timestamp text and refuses an equivalent-time replacement', async () => {
  const input = await fixture();
  input.target.volumeCreatedAt = '2030-02-28T06:00:00+06:00';
  const store = new PostgresRestoreEvidence(database.pool);
  await store.seal(input);
  expect((await store.load(input.restoreRef)).target.volumeCreatedAt).toBe(
    input.target.volumeCreatedAt,
  );
  await expect(
    store.seal({ ...input, target: { ...input.target, volumeCreatedAt: '2030-02-28T00:00:00Z' } }),
  ).rejects.toThrow('restore_binding_invalid');
});

test('refuses a substituted actual PostgreSQL target even when the old gate passed', async () => {
  const input = await fixture();
  await expect(
    new PostgresRestoreEvidence(database.pool).seal({
      ...input,
      target: { ...input.target, systemIdentifier: '1111111111111111111' },
    }),
  ).rejects.toThrow(/^restore_binding_invalid$/u);
  expect(
    (
      await database.pool.query(
        'select count(*)::int as count from operations_restore_bindings where restore_ref=$1',
        [input.restoreRef],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
});

test('refuses an unlinked import or old gate revision without persisting a pass', async () => {
  const input = await fixture();
  const store = new PostgresRestoreEvidence(database.pool);
  await expect(
    store.seal({ ...input, checkpointRef: `checkpoint_${'0'.repeat(32)}` }),
  ).rejects.toThrow(/^restore_binding_invalid$/u);
  await expect(store.seal({ ...input, gitRevision: 'a'.repeat(40) })).rejects.toThrow(
    /^restore_binding_invalid$/u,
  );
  expect(
    (
      await database.pool.query(
        "select count(*)::int as count from operations_restore_runs where restore_ref=$1 and state='passed'",
        [input.restoreRef],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
});

test('refuses sealing replay instead of treating a copied old pass as current authority', async () => {
  const input = await fixture();
  const store = new PostgresRestoreEvidence(database.pool);
  await store.seal(input);
  await expect(store.seal(input)).rejects.toThrow(/^restore_binding_invalid$/u);
});

test('refuses a failed run without inserting partial pass evidence', async () => {
  const input = await fixture();
  await database.pool.query(
    "insert into operations_restore_runs(restore_ref,backup_ref,checkpoint_ref,git_revision,schema_revision,state,recorded_at) values($1,$2,$3,$4,'000016','failed',$5)",
    [input.restoreRef, input.backupRef, input.checkpointRef, input.gitRevision, input.evaluatedAt],
  );
  await expect(new PostgresRestoreEvidence(database.pool).seal(input)).rejects.toThrow(
    /^restore_binding_invalid$/u,
  );
  expect(
    (
      await database.pool.query(
        'select state from operations_restore_runs where restore_ref=$1 order by id',
        [input.restoreRef],
      )
    ).rows,
  ).toEqual([{ state: 'isolated' }, { state: 'failed' }]);
});

test('protects its own evidence from truncate and unsafe downgrade atomically', async () => {
  const input = await fixture();
  await new PostgresRestoreEvidence(database.pool).seal(input);
  await expect(database.pool.query('truncate operations_restore_bindings')).rejects.toMatchObject({
    code: '55000',
  });
  await expect(database.runMigrations('down', 1)).rejects.toThrow();
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local search_path=public');
    await expect(
      client.query(`truncate "${database.schema}".operations_restore_bindings`),
    ).rejects.toMatchObject({ code: '55000' });
    await client.query('rollback');
  } finally {
    client.release(true);
  }
  expect(
    (await database.pool.query('select count(*)::int as count from pgmigrations')).rows,
  ).toEqual([{ count: 16 }]);
  expect(await new PostgresRestoreEvidence(database.pool).load(input.restoreRef)).toMatchObject({
    restoreRef: input.restoreRef,
  });
});

test.each(['databaseName', 'schema', 'systemIdentifier'] as const)(
  'refuses substituted target SQL %s',
  async (field) => {
    const input = await fixture();
    const substitute =
      field === 'systemIdentifier' ? '1111111111111111111' : 'synthetic_wrong_target';
    await expect(
      new PostgresRestoreEvidence(database.pool).seal({
        ...input,
        target: { ...input.target, [field]: substitute },
      }),
    ).rejects.toThrow(/^restore_binding_invalid$/u);
  },
);

test.each<Partial<SealRestoreEvidence>>([
  { schemaRevision: '000015' },
  { sourceSystemIdentifier: '0' },
  { sourceSystemIdentifier: '18446744073709551616' },
  { requiredKeyVersions: ['TEST_v1', 'TEST_v1'] },
  { requiredKeyVersions: ['TEST_v2', 'TEST_v1'] },
  { evaluatedAt: new Date('2030-03-01T00:00:01.000Z') },
])('refuses malformed or unbound seal input %#', async (override) => {
  const input = await fixture();
  await expect(
    new PostgresRestoreEvidence(database.pool).seal({
      ...input,
      ...override,
      requiredKeyVersions: [...(override.requiredKeyVersions ?? input.requiredKeyVersions)],
    }),
  ).rejects.toThrow(/^restore_binding_invalid$/u);
});

test.each(['import', 'hold', 'gate'] as const)('refuses missing %s evidence', async (missing) => {
  const input = await fixture(missing);
  await expect(new PostgresRestoreEvidence(database.pool).seal(input)).rejects.toThrow(
    /^restore_binding_invalid$/u,
  );
  expect(
    (
      await database.pool.query('select state from operations_restore_runs where restore_ref=$1', [
        input.restoreRef,
      ])
    ).rows,
  ).toEqual([{ state: 'isolated' }]);
});

test('refuses the source cluster itself as the target', async () => {
  const input = await fixture();
  await expect(
    new PostgresRestoreEvidence(database.pool).seal({
      ...input,
      sourceSystemIdentifier: input.target.systemIdentifier,
    }),
  ).rejects.toThrow(/^restore_binding_invalid$/u);
});

test('one final deletion gate cannot seal two restores and a conflict rolls back the second pass', async () => {
  const first = await fixture();
  const second = await fixture();
  const store = new PostgresRestoreEvidence(database.pool);
  await store.seal(first);
  await expect(store.seal({ ...second, gateRef: first.gateRef })).rejects.toThrow(
    /^restore_binding_invalid$/u,
  );
  expect(
    (
      await database.pool.query('select state from operations_restore_runs where restore_ref=$1', [
        second.restoreRef,
      ])
    ).rows,
  ).toEqual([{ state: 'isolated' }]);
});

test('concurrent sealing produces exactly one binding and one pass', async () => {
  const input = await fixture();
  const store = new PostgresRestoreEvidence(database.pool);
  const results = await Promise.allSettled([store.seal(input), store.seal(input)]);
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(
    (
      await database.pool.query(
        'select state from operations_restore_runs where restore_ref=$1 order by id',
        [input.restoreRef],
      )
    ).rows,
  ).toEqual([{ state: 'isolated' }, { state: 'reconciled' }, { state: 'passed' }]);
});

test('unknown and invalid references do not load evidence', async () => {
  const store = new PostgresRestoreEvidence(database.pool);
  for (const ref of ['restore_' + '0'.repeat(32), 'invalid']) {
    await expect(store.load(ref)).rejects.toThrow(/^restore_binding_invalid$/u);
  }
});

test('joins an enclosing restore transaction and does not commit its partial result', async () => {
  const input = await fixture();
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await new PostgresRestoreEvidence({ transactionClient: client }).seal(input);
    await client.query('rollback');
  } finally {
    client.release(true);
  }
  expect(
    (
      await database.pool.query(
        'select count(*)::int as count from operations_restore_bindings where restore_ref=$1',
        [input.restoreRef],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(
    (
      await database.pool.query('select state from operations_restore_runs where restore_ref=$1', [
        input.restoreRef,
      ])
    ).rows,
  ).toEqual([{ state: 'isolated' }]);
});

test('empty migration 16 rolls back and upgrades without rewriting earlier migrations', async () => {
  const empty = await createIsolatedTestDatabase('restore_binding_upgrade');
  try {
    await empty.runMigrations('down', 1);
    expect(
      (
        await empty.pool.query(
          "select to_regclass('operations_restore_bindings') is null as absent",
        )
      ).rows,
    ).toEqual([{ absent: true }]);
    expect(
      (await empty.pool.query('select count(*)::int as count from pgmigrations')).rows,
    ).toEqual([{ count: 15 }]);
    await empty.runMigrations('up');
    expect(
      (
        await empty.pool.query(
          "select to_regclass('operations_restore_bindings') is not null as present",
        )
      ).rows,
    ).toEqual([{ present: true }]);
    expect(
      (await empty.pool.query('select count(*)::int as count from pgmigrations')).rows,
    ).toEqual([{ count: 16 }]);
  } finally {
    await empty.dispose();
  }
});

test('empty binding reset is harmless only under read committed; a stale snapshot cannot authorize truncation', async () => {
  const empty = await createIsolatedTestDatabase('binding_empty_reset');
  try {
    await expect(empty.pool.query('truncate operations_restore_bindings')).resolves.toMatchObject({
      command: 'TRUNCATE',
    });
    const client = await empty.pool.connect();
    try {
      await client.query('begin isolation level repeatable read');
      await expect(client.query('truncate operations_restore_bindings')).rejects.toMatchObject({
        code: '55000',
      });
      await client.query('rollback');
    } finally {
      client.release(true);
    }
  } finally {
    await empty.dispose();
  }
});

test('a truncate queued behind a new binding sees the committed row and cannot erase it', async () => {
  const empty = await createIsolatedTestDatabase('restore_truncate_race');
  const writer = await empty.pool.connect();
  const truncater = await empty.pool.connect();
  try {
    const input = await fixture(undefined, empty);
    await writer.query('begin');
    await new PostgresRestoreEvidence({ transactionClient: writer }).seal(input);
    const pid = (await truncater.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
      ?.pid;
    if (pid === undefined) throw new Error('synthetic_backend_missing');
    await truncater.query('begin isolation level read committed');
    await truncater.query("set local statement_timeout='3000ms'");
    const outcome = truncater.query('truncate operations_restore_bindings').then(
      () => 'unexpected_success',
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : 'unexpected_failure',
    );
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (!blocked && Date.now() < deadline) {
      blocked =
        (
          await empty.pool.query<{ blocked: boolean }>(
            `select exists(select 1 from pg_locks where pid=$1
        and relation=$2::regclass and mode='AccessExclusiveLock' and not granted) as blocked`,
            [pid, `${empty.schema}.operations_restore_bindings`],
          )
        ).rows[0]?.blocked === true;
      if (!blocked) await new Promise((done) => setTimeout(done, 10));
    }
    expect(blocked).toBe(true);
    await writer.query('commit');
    expect(await outcome).toBe('55000');
    await truncater.query('rollback');
    expect(await new PostgresRestoreEvidence(empty.pool).load(input.restoreRef)).toMatchObject({
      restoreRef: input.restoreRef,
    });
  } finally {
    writer.release(true);
    truncater.release(true);
    await empty.dispose();
  }
});

test('a queued downgrade cannot drop a binding committed while it waits for DDL access', async () => {
  const empty = await createIsolatedTestDatabase('binding_down_race');
  const writer = await empty.pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    const input = await fixture(undefined, empty);
    await writer.query('begin');
    await new PostgresRestoreEvidence({ transactionClient: writer }).seal(input);
    pending = empty.runMigrations('down', 1).then(
      () => 'unexpected_success',
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : 'unexpected_failure',
    );
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (!blocked && Date.now() < deadline) {
      blocked =
        (
          await empty.pool.query<{ blocked: boolean }>(
            `select exists(select 1 from pg_locks
        where relation=$1::regclass and mode='AccessExclusiveLock' and not granted) as blocked`,
            [`${empty.schema}.operations_restore_bindings`],
          )
        ).rows[0]?.blocked === true;
      if (!blocked) await new Promise((done) => setTimeout(done, 10));
    }
    expect(blocked).toBe(true);
    await writer.query('commit');
    expect(await pending).toBe('55000');
    expect(
      (await empty.pool.query('select count(*)::int as count from pgmigrations')).rows,
    ).toEqual([{ count: 16 }]);
    expect(await new PostgresRestoreEvidence(empty.pool).load(input.restoreRef)).toMatchObject({
      restoreRef: input.restoreRef,
    });
  } finally {
    writer.release(true);
    await pending;
    await empty.dispose();
  }
});
