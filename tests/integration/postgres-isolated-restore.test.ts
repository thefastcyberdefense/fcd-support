import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createEncryptedBackup,
  verifyEncryptedBackup,
  type BackupManifest,
} from '../../src/operations/backup.js';
import { registerBackup } from '../../src/operations/backup-command.js';
import { runForwardMigrations } from '../../src/operations/forward-migration.js';
import { restoreEncryptedBackup } from '../../src/operations/restore.js';
import {
  requireIsolatedTestDatabaseUrl,
  rollbackThroughMigration,
  type IsolatedTestDatabase,
} from './test-database.js';

const enabled = process.env.RUN_ISOLATED_RESTORE_TESTS === 'synthetic-isolated-cluster-only';
let source: IsolatedTestDatabase;
let targetOwner: pg.Pool;
let root: string;
let archiveDirectory: string;
let temporaryDirectory: string;
let identityFile: string;
let wrongIdentityFile: string;
let manifestHmacFile: string;
let manifest: BackupManifest;
let targetSystemIdentifier: string;
const targetOwnerUrl = 'postgresql://fcd_support_test@restore-postgres:5432/postgres';
const cleanup: {
  targetOwner?: pg.Pool;
  source?: IsolatedTestDatabase;
  root?: string;
  archiveDirectory?: string;
  snapshots: Set<IsolatedTestDatabase>;
} = { snapshots: new Set() };

async function createRestoreSource(): Promise<IsolatedTestDatabase> {
  const base = requireIsolatedTestDatabaseUrl(process.env);
  const owner = new pg.Pool({
    connectionString: base,
    max: 1,
    application_name: 'synthetic-restore-source-owner',
  });
  const name = `fcd_support_restore_source_${randomUUID().replaceAll('-', '')}`;
  const schema = `test_isolated_restore_${randomUUID().replaceAll('-', '')}`;
  await owner.query(`create database "${name}" template template0`);
  const url = new URL(base);
  url.pathname = name;
  const runMigrations = async (direction: 'up' | 'down', count?: number) => {
    await runner({
      databaseUrl: url.toString(),
      dir: resolve('migrations'),
      direction,
      ...(count === undefined ? {} : { count }),
      schema,
      migrationsSchema: schema,
      migrationsTable: 'pgmigrations',
      createSchema: true,
      createMigrationsSchema: true,
      singleTransaction: true,
      log: () => undefined,
      verbose: false,
    });
  };
  await runMigrations('up');
  const schemaUrl = new URL(url);
  schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: schemaUrl.toString(), max: 4 });
  return {
    pool,
    schema,
    connectionString: schemaUrl.toString(),
    runMigrations,
    dispose: async () => {
      await pool.end();
      try {
        await owner.query(`drop database "${name}"`);
      } finally {
        await owner.end();
      }
    },
  };
}

async function command(file: string, args: string[]): Promise<string> {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    if (output.length > 4096) child.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('synthetic_tool_failed'));
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('synthetic_tool_failed'));
    });
  });
  return output;
}

beforeAll(async () => {
  if (!enabled) return;
  requireIsolatedTestDatabaseUrl(process.env);
  if (
    process.env.RESTORE_TEST_DATABASE_URL !== targetOwnerUrl ||
    process.env.BACKUP_TEST_ARCHIVE_ROOT !== '/var/lib/fcd-support/backups'
  )
    throw new Error('synthetic_restore_target_invalid');
  targetOwner = new pg.Pool({ connectionString: targetOwnerUrl, max: 1 });
  cleanup.targetOwner = targetOwner;
  const targetId = (
    await targetOwner.query<{ id: string }>(
      'select system_identifier::text as id from pg_control_system()',
    )
  ).rows[0]?.id;
  if (targetId === undefined) throw new Error('synthetic_restore_target_invalid');
  targetSystemIdentifier = targetId;
  source = await createRestoreSource();
  cleanup.source = source;
  root = await mkdtemp(join(tmpdir(), 'fcd-isolated-restore-test-'));
  cleanup.root = root;
  await chmod(root, 0o700);
  archiveDirectory = join('/var/lib/fcd-support/backups', basename(root));
  cleanup.archiveDirectory = archiveDirectory;
  temporaryDirectory = join(root, 'work');
  await mkdir(archiveDirectory, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  identityFile = join(root, 'identity');
  wrongIdentityFile = join(root, 'wrong-identity');
  manifestHmacFile = join(root, 'hmac');
  for (const file of [identityFile, wrongIdentityFile]) {
    await command('age-keygen', ['--output', file]);
    await chmod(file, 0o600);
  }
  const recipientFile = join(root, 'recipient');
  await writeFile(recipientFile, await command('age-keygen', ['-y', identityFile]), {
    mode: 0o600,
  });
  await writeFile(manifestHmacFile, 'synthetic_restore_manifest_hmac_'.repeat(3), { mode: 0o600 });
  await source.pool.query(
    'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
    ['a'.repeat(64), new Date('2030-03-01T00:00:00.000Z')],
  );
  const backupUrl = new URL(source.connectionString);
  backupUrl.search = '';
  manifest = await createEncryptedBackup({
    connectionString: backupUrl.toString(),
    archiveDirectory,
    temporaryDirectory,
    recipientFile,
    manifestHmacFile,
    gitRevision: 'a'.repeat(40),
    schemaRevision: '000015',
    backupClass: 'pre_migration',
    now: new Date('2030-03-01T00:00:00.000Z'),
    timeoutMilliseconds: 10000,
  });
  await registerBackup(source.pool, manifest, 'verified');
});

afterAll(async () => {
  if (!enabled) return;
  await cleanup.targetOwner?.end();
  for (const snapshot of cleanup.snapshots) await snapshot.dispose();
  await cleanup.source?.dispose();
  if (cleanup.archiveDirectory !== undefined)
    await rm(cleanup.archiveDirectory, { recursive: true, force: true });
  if (cleanup.root !== undefined) await rm(cleanup.root, { recursive: true, force: true });
  // DROP DATABASE forces a checkpoint. Keep loaded shared-cluster teardown
  // outside the unchanged 20-second assertion and 10-second restore deadlines.
}, 60000);

async function withTarget(
  work: (input: ReturnType<typeof options>, pool: pg.Pool) => Promise<void>,
) {
  const name = `fcd_support_restore_${randomUUID().replaceAll('-', '')}`;
  await targetOwner.query(`create database "${name}" template template0`);
  const url = new URL(targetOwnerUrl);
  url.pathname = name;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await work(options(url.toString()), pool);
  } finally {
    await pool.end();
    await targetOwner.query(`drop database "${name}"`);
  }
}
function options(targetConnectionString: string) {
  return {
    sourcePool: source.pool,
    targetConnectionString,
    expectedTargetSystemIdentifier: targetSystemIdentifier,
    schema: source.schema,
    backupRef: manifest.backupRef,
    archiveDirectory,
    temporaryDirectory,
    manifestHmacFile,
    identityFile,
    timeoutMilliseconds: 10000,
  };
}

async function additionalArchive(
  schemaRevision: string,
  schemas?: readonly string[],
  snapshot = source,
) {
  const url = new URL(snapshot.connectionString);
  url.search = '';
  const archive = await createEncryptedBackup({
    connectionString: url.toString(),
    ...(schemas === undefined ? {} : { schemas }),
    archiveDirectory,
    temporaryDirectory,
    recipientFile: join(root, 'recipient'),
    manifestHmacFile,
    gitRevision: 'a'.repeat(40),
    schemaRevision,
    backupClass: 'pre_migration',
    now: new Date('2030-03-01T00:00:00.000Z'),
    timeoutMilliseconds: 10000,
  });
  await registerBackup(source.pool, archive, 'verified');
  return archive;
}

test.skipIf(!enabled)(
  'decrypts directly into a distinct empty cluster and preserves real rows and schema',
  async () => {
    await withTarget(async (input, pool) => {
      const evidence = await restoreEncryptedBackup(input);
      expect(evidence).toMatchObject({
        status: 'restored',
        backupRef: manifest.backupRef,
        schemaRevision: '000015',
        targetSystemIdentifier,
      });
      expect(evidence.sourceSystemIdentifier).not.toBe(evidence.targetSystemIdentifier);
      expect(
        (
          await pool.query(
            "select count(*)::int as count from pg_extension where extname='pg_trgm'",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await pool.query(
            `select payload_sha256,event_count from "${source.schema}".webhook_receipts`,
          )
        ).rows,
      ).toEqual([{ payload_sha256: 'a'.repeat(64), event_count: 1 }]);
      expect(
        (await pool.query(`select count(*)::int as count from "${source.schema}".pgmigrations`))
          .rows,
      ).toEqual([{ count: 15 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
      expect(await readdir(join(archiveDirectory, manifest.backupRef))).toEqual([
        'archive.age',
        'manifest.json',
      ]);
      // The restored catalog intentionally predates the selected archive's registration.
      expect(
        (
          await pool.query(
            `select count(*)::int as count from "${source.schema}".operations_backups`,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const url = new URL(input.targetConnectionString);
      url.searchParams.set('options', `-c search_path=${source.schema}`);
      const migrationPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        expect(
          await runForwardMigrations(migrationPool, {
            schema: source.schema,
            expectedSchemaRevision: '000015',
            timeoutMilliseconds: 10000,
          }),
        ).toEqual({ schemaRevision: '000015' });
      } finally {
        await migrationPool.end();
      }
    });
  },
);

test.skipIf(!enabled)(
  'refuses the authoritative source cluster even with an empty different database',
  async () => {
    const url = new URL(requireIsolatedTestDatabaseUrl(process.env));
    url.pathname = 'postgres';
    const sourceId = (
      await source.pool.query<{ id: string }>(
        'select system_identifier::text as id from pg_control_system()',
      )
    ).rows[0]?.id;
    if (sourceId === undefined) throw new Error('synthetic_restore_source_invalid');
    await expect(
      restoreEncryptedBackup({
        ...options(url.toString()),
        expectedTargetSystemIdentifier: sourceId,
      }),
    ).rejects.toThrow(/^restore_target_invalid$/u);
    expect(
      (await source.pool.query('select count(*)::int as count from webhook_receipts')).rows,
    ).toEqual([{ count: 1 }]);
  },
);

test.skipIf(!enabled)(
  'refuses a substituted target cluster identity before importing any objects',
  async () => {
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({ ...input, expectedTargetSystemIdentifier: '1234567890123456789' }),
      ).rejects.toThrow(/^restore_target_invalid$/u);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
    });
  },
);

test.skipIf(!enabled)(
  'refuses a populated target without cleaning or replacing its existing data',
  async () => {
    await withTarget(async (input, pool) => {
      const setup = await pool.connect();
      try {
        await setup.query('create table synthetic_preserved(value int)');
        await setup.query('insert into synthetic_preserved values(42)');
      } finally {
        const ended = new Promise<void>((resolve) => {
          setup.once('end', resolve);
        });
        setup.release(true);
        await ended;
      }
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_target_invalid$/u);
      expect((await pool.query('select value from synthetic_preserved')).rows).toEqual([
        { value: 42 },
      ]);
    });
  },
);

test.skipIf(!enabled)(
  'refuses another connected application session even on an empty target',
  async () => {
    await withTarget(async (input, pool) => {
      await pool.query('select 1');
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_target_invalid$/u);
    });
  },
);

test.skipIf(!enabled).each(['wrong', 'missing'] as const)(
  '%s identity cannot restore and leaves no plaintext or credential file',
  async (kind) => {
    await withTarget(async (input, pool) => {
      const file = kind === 'wrong' ? wrongIdentityFile : join(root, 'missing-identity');
      await expect(restoreEncryptedBackup({ ...input, identityFile: file })).rejects.toThrow(
        /^restore_failed$/u,
      );
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)('refuses unverified source catalog state and a missing archive', async () => {
  await withTarget(async (input) => {
    await source.pool.query("update operations_backups set state='failed' where backup_ref=$1", [
      manifest.backupRef,
    ]);
    try {
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_archive_invalid$/u);
    } finally {
      await source.pool.query(
        "update operations_backups set state='verified' where backup_ref=$1",
        [manifest.backupRef],
      );
    }
    await expect(
      restoreEncryptedBackup({ ...input, backupRef: `backup_${'0'.repeat(32)}` }),
    ).rejects.toThrow(/^restore_archive_invalid$/u);
    expect(
      (
        await readFile(join(archiveDirectory, manifest.backupRef, 'manifest.json'), 'utf8')
      ).includes('synthetic_restore_manifest_hmac'),
    ).toBe(false);
  });
});

test.skipIf(!enabled)(
  'an incomplete schema-only archive fails atomically without installing its partial tables',
  async () => {
    const archive = await additionalArchive('000015', [source.schema]);
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({ ...input, backupRef: archive.backupRef }),
      ).rejects.toThrow(/^restore_failed$/u);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
      expect(
        (await source.pool.query('select count(*)::int as count from webhook_receipts')).rows,
      ).toEqual([{ count: 1 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)(
  'a signed but incorrect source schema is refused and its isolated target data is retained',
  async () => {
    const archive = await additionalArchive('000014');
    await withTarget(async (input, pool) => {
      await expect(
        restoreEncryptedBackup({ ...input, backupRef: archive.backupRef }),
      ).rejects.toThrow(/^restore_failed$/u);
      expect(
        (await pool.query(`select count(*)::int as count from "${source.schema}".webhook_receipts`))
          .rows,
      ).toEqual([{ count: 1 }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)(
  'a stalled decrypt is killed at the configured timeout with no partial SQL or leftover password file',
  async () => {
    await withTarget(async (input, pool) => {
      let decrypts = 0;
      const started = Date.now();
      await expect(
        restoreEncryptedBackup({
          ...input,
          timeoutMilliseconds: 1000,
          processes: (file, args, settings) => {
            if (file === 'age' && ++decrypts === 2)
              return spawn(
                process.execPath,
                ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
                settings,
              );
            return spawn(file, args, settings);
          },
        }),
      ).rejects.toThrow(/^restore_failed$/u);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
      expect(await readdir(temporaryDirectory)).toEqual([]);
    });
  },
);

test.skipIf(!enabled)(
  'an actual old admission archive restores then forward-migrates without losing its receipt',
  async () => {
    const older = await createRestoreSource();
    try {
      await rollbackThroughMigration(older, 2);
      await older.pool.query(
        'insert into webhook_receipts(payload_sha256,received_at,event_count) values($1,$2,1)',
        ['b'.repeat(64), new Date('2030-02-01T00:00:00.000Z')],
      );
      const archive = await additionalArchive('000001', undefined, older);
      await withTarget(async (input, pool) => {
        expect(
          await restoreEncryptedBackup({
            ...input,
            schema: older.schema,
            backupRef: archive.backupRef,
          }),
        ).toMatchObject({ status: 'restored', schemaRevision: '000001' });
        const url = new URL(input.targetConnectionString);
        url.searchParams.set('options', `-c search_path=${older.schema},public`);
        const migrations = new pg.Pool({ connectionString: url.toString(), max: 1 });
        try {
          expect(
            await runForwardMigrations(migrations, {
              schema: older.schema,
              expectedSchemaRevision: '000015',
              timeoutMilliseconds: 10000,
            }),
          ).toEqual({ schemaRevision: '000015' });
          expect(
            (
              await pool.query(
                `select payload_sha256,event_count from "${older.schema}".webhook_receipts`,
              )
            ).rows,
          ).toEqual([{ payload_sha256: 'b'.repeat(64), event_count: 1 }]);
          expect(
            (await pool.query(`select count(*)::int as count from "${older.schema}".pgmigrations`))
              .rows,
          ).toEqual([{ count: 15 }]);
        } finally {
          await migrations.end();
        }
      });
    } finally {
      cleanup.snapshots.add(older);
    }
  },
);

test.skipIf(!enabled)('a corrupted ciphertext is rejected before any SQL restore', async () => {
  const path = join(archiveDirectory, manifest.backupRef, 'archive.age');
  const original = await readFile(path);
  const corrupted = Buffer.from(original);
  corrupted[0] = 0;
  await writeFile(path, corrupted);
  try {
    await withTarget(async (input, pool) => {
      await expect(restoreEncryptedBackup(input)).rejects.toThrow(/^restore_archive_invalid$/u);
      expect(
        (await pool.query('select to_regnamespace($1) as namespace', [source.schema])).rows,
      ).toEqual([{ namespace: null }]);
    });
  } finally {
    await writeFile(path, original);
  }
});

test.skipIf(!enabled)(
  'a full archive larger than pipe buffers restores all synthetic binary data without plaintext files',
  async () => {
    await source.pool.query('create table synthetic_restore_blob(payload bytea not null)');
    try {
      await source.pool.query('insert into synthetic_restore_blob values($1)', [
        randomBytes(1024 * 1024),
      ]);
      const archive = await additionalArchive('000015');
      expect(archive.ciphertextBytes).toBeGreaterThan(1024 * 1024);
      expect(
        await verifyEncryptedBackup({
          archiveDirectory,
          manifestHmacFile,
          identityFile,
          expectedManifest: archive,
          timeoutMilliseconds: 10000,
        }),
      ).toEqual({ status: 'verified' });
      await withTarget(async (input, pool) => {
        expect(
          await restoreEncryptedBackup({ ...input, backupRef: archive.backupRef }),
        ).toMatchObject({ status: 'restored', schemaRevision: '000015' });
        expect(
          (
            await pool.query(
              `select octet_length(payload) as bytes from "${source.schema}".synthetic_restore_blob`,
            )
          ).rows,
        ).toEqual([{ bytes: 1024 * 1024 }]);
        expect(await readdir(temporaryDirectory)).toEqual([]);
      });
    } finally {
      await source.pool.query('drop table synthetic_restore_blob');
    }
  },
);
