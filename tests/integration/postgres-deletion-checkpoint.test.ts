import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { AdminSecretBytes } from '../../src/admin/admin-types.js';
import {
  exportDeletionCheckpoint,
  importDeletionCheckpoint,
  readCheckpointWatermark,
  assertCheckpointCurrent,
} from '../../src/operations/deletion-checkpoint.js';
import { PostgresRestoreDeletionGate } from '../../src/persistence/postgres-restore-deletion-gate.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';

const native = process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
async function addTombstone(
  pool: import('pg').default.Pool,
  at: Date,
  keyVersion = 'TEST_v1',
  marker = 'a',
) {
  await pool.query(
    `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
    values($1,'messenger','deletion_tombstone','customer_deletion',$2,$3)`,
    [marker.repeat(64), at, keyVersion],
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fcd-checkpoint-test-'));
  await chmod(root, 0o700);
  const source = await createIsolatedTestDatabase('checkpoint_source');
  const target = await createIsolatedTestDatabase('checkpoint_target');
  const archiveRoot = process.env.BACKUP_TEST_ARCHIVE_ROOT;
  if (archiveRoot !== '/var/lib/fcd-support/backups')
    throw new Error('synthetic_archive_root_invalid');
  const archiveDirectory = join(archiveRoot, basename(root));
  await mkdir(archiveDirectory, { mode: 0o700 });
  const identityFile = join(root, 'identity');
  const recipientFile = join(root, 'recipient');
  const keygen = spawn('age-keygen', ['--output', identityFile], { stdio: 'ignore' });
  await new Promise<void>((done, reject) => {
    keygen.once('error', () => {
      reject(new Error('synthetic_keygen_failed'));
    });
    keygen.once('close', (code) => {
      if (code === 0) done();
      else reject(new Error('synthetic_keygen_failed'));
    });
  });
  const publicKey = spawn('age-keygen', ['-y', identityFile], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let recipient = '';
  publicKey.stdout.setEncoding('utf8');
  publicKey.stdout.on('data', (text: string) => {
    recipient += text;
  });
  await new Promise<void>((done, reject) => {
    publicKey.once('error', () => {
      reject(new Error('synthetic_recipient_failed'));
    });
    publicKey.once('close', (code) => {
      if (code === 0) done();
      else reject(new Error('synthetic_recipient_failed'));
    });
  });
  await writeFile(recipientFile, recipient, { mode: 0o600 });
  await chmod(identityFile, 0o600);
  const now = new Date('2030-02-01T00:00:00.000Z');
  const signingKey = new AdminSecretBytes(
    Buffer.from('synthetic_checkpoint_signing_key_'.repeat(2)),
  );
  const observed = (
    await source.pool.query<{ id: string; name: string }>(
      'select system_identifier::text as id,current_database() as name from pg_catalog.pg_control_system()',
    )
  ).rows[0];
  if (observed === undefined) throw new Error('synthetic_cluster_missing');
  const options = {
    expectedDatabaseIdentity: { systemIdentifier: observed.id, databaseName: observed.name },
    sourcePool: source.pool,
    recipientFile,
    signingKey,
    archiveDirectory,
    sourceRevision: 'a'.repeat(40),
    schemaRevision: '000016',
    now,
    timeoutMilliseconds: 10000,
    maximumRows: 1000,
    maximumPayloadBytes: 1048576,
  };
  return {
    source,
    target,
    root,
    identityFile,
    options,
    close: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(archiveDirectory, { recursive: true, force: true });
      await target.dispose();
      await source.dispose();
    },
  };
}
test.skipIf(!native)(
  'checkpoint source identity is checked on the export-owning connection',
  async () => {
    const f = await fixture();
    try {
      for (const expectedDatabaseIdentity of [
        { systemIdentifier: '1111111111111111111', databaseName: 'fcd_support_test' },
        { systemIdentifier: '0', databaseName: 'fcd_support_test' },
      ]) {
        const options = { ...f.options, expectedDatabaseIdentity };
        await expect(exportDeletionCheckpoint(options)).rejects.toThrow('checkpoint_export_failed');
        expect(await readdir(f.options.archiveDirectory)).toEqual([]);
      }
    } finally {
      await f.close();
    }
  },
);
test.skipIf(!native)(
  'current encrypted checkpoint reapplies a deletion absent from the selected older state',
  async () => {
    const f = await fixture();
    try {
      const identity = {
        channel: 'whatsapp' as const,
        channelAccountId: 'PHONE_TEST_checkpoint',
        externalContactId: 'CONTACT_TEST_checkpoint',
      };
      await insertSyntheticAppliedCustomerEvent(f.target.pool, {
        fixtureKey: 'checkpoint_old_state',
        identity,
        occurredAt: new Date('2030-01-31T23:59:00.000Z'),
        messageText: 'Synthetic old-state content requiring post-archive deletion',
      });
      const key = syntheticPrivacyKeyring.keys.get('TEST_v1');
      if (key === undefined) throw new Error('synthetic_key_missing');
      await f.source.pool.query(
        `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
      values($1,'whatsapp','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
        [createIdentityHmac(identity, { key, version: 'TEST_v1' }), f.options.now],
      );
      await chmod(f.identityFile, 0o000);
      const manifest = await exportDeletionCheckpoint(f.options);
      expect(manifest.rowCount).toBe(1);
      expect(manifest.requiredKeyVersions).toEqual(['TEST_v1']);
      await chmod(f.identityFile, 0o600);
      const command = {
        targetPool: f.target.pool,
        archiveFile: join(f.options.archiveDirectory, manifest.checkpointRef, 'archive.age'),
        identityFile: f.identityFile,
        signingKey: f.options.signingKey,
        expectedManifest: manifest,
        expectedCurrentWatermark: await readCheckpointWatermark(f.source.pool),
        currentSourcePool: f.source.pool,
        evaluatedAt: f.options.now,
        maximumAgeMilliseconds: 60000,
        maximumRows: 1000,
        maximumPayloadBytes: 1048576,
        timeoutMilliseconds: 10000,
        restoreRef: 'RESTORE_TEST_checkpoint',
      };
      expect(await importDeletionCheckpoint(command)).toEqual({ imported: 1 });
      expect(await importDeletionCheckpoint(command)).toEqual({ imported: 1 });
      const gate = new PostgresRestoreDeletionGate(f.target.pool, syntheticPrivacyKeyring);
      const common = {
        gateRef: 'GATE_TEST_checkpoint',
        gitRevision: 'a'.repeat(40),
        evaluatedAt: f.options.now,
        requiredKeyVersions: ['TEST_v1'],
      };
      await gate.reapplyBatch({
        ...common,
        requestKey: 'REQUEST_TEST_checkpoint_batch',
        limit: 100,
      });
      expect(
        await gate.finalizeGate({ ...common, requestKey: 'REQUEST_TEST_checkpoint_finalize' }),
      ).toEqual({ status: 'passed' });
      expect(
        (
          await f.target.pool.query(
            'select count(*)::int as count from channel_identities where external_contact_id=$1 and channel_account_id=$2',
            [identity.externalContactId, identity.channelAccountId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await f.source.pool.query(
        `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
      values($1,'messenger','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
        ['c'.repeat(64), f.options.now],
      );
      await expect(assertCheckpointCurrent(f.source.pool, manifest, command)).rejects.toThrow(
        'checkpoint_invalid',
      );
      await expect(
        importDeletionCheckpoint({
          ...command,
          expectedCurrentWatermark: await readCheckpointWatermark(f.source.pool),
        }),
      ).rejects.toThrow('checkpoint_import_failed');
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!native).each(['count', 'key_versions', 'corruption', 'missing', 'stale'])(
  'encrypted checkpoint rejects %s without partial target imports',
  async (kind) => {
    const f = await fixture();
    try {
      await addTombstone(f.source.pool, f.options.now);
      let manifest = await exportDeletionCheckpoint(f.options);
      const archiveFile = join(f.options.archiveDirectory, manifest.checkpointRef, 'archive.age');
      if (kind === 'count' || kind === 'key_versions') {
        const { signature: _signature, ...original } = manifest;
        void _signature;
        const material = {
          ...original,
          ...(kind === 'count' ? { rowCount: 2 } : { requiredKeyVersions: ['TEST_v2'] }),
        };
        const signature = createHmac('sha256', f.options.signingKey.copy())
          .update('fcd-support:deletion-checkpoint:v1\n')
          .update(JSON.stringify(material))
          .digest('hex');
        manifest = { ...material, signature };
        await writeFile(
          join(f.options.archiveDirectory, manifest.checkpointRef, 'manifest.json'),
          JSON.stringify(manifest),
        );
      }
      if (kind === 'corruption')
        await writeFile(archiveFile, 'Synthetic corrupted ciphertext only');
      if (kind === 'missing') await rm(archiveFile);
      await expect(
        importDeletionCheckpoint({
          targetPool: f.target.pool,
          currentSourcePool: f.source.pool,
          archiveFile,
          identityFile: f.identityFile,
          signingKey: f.options.signingKey,
          expectedManifest: manifest,
          expectedCurrentWatermark: await readCheckpointWatermark(f.source.pool),
          evaluatedAt: kind === 'stale' ? new Date(f.options.now.getTime() + 60001) : f.options.now,
          maximumAgeMilliseconds: 60000,
          maximumRows: 1000,
          maximumPayloadBytes: 1048576,
          timeoutMilliseconds: 10000,
          restoreRef: 'RESTORE_TEST_invalid_checkpoint',
        }),
      ).rejects.toThrow('checkpoint_import_failed');
      expect(
        (await f.target.pool.query('select count(*)::int as count from privacy_suppressions')).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (await f.target.pool.query('select count(*)::int as count from restore_checkpoint_imports'))
          .rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await f.close();
    }
  },
);
test.skipIf(!native)(
  'rotated and older unexpired target key versions are not discarded during import',
  async () => {
    const f = await fixture();
    try {
      await addTombstone(f.source.pool, f.options.now, 'TEST_v1', 'a');
      await addTombstone(f.source.pool, f.options.now, 'TEST_v2', 'b');
      await addTombstone(f.target.pool, f.options.now, 'TEST_old', 'c');
      const manifest = await exportDeletionCheckpoint(f.options);
      expect(manifest.requiredKeyVersions).toEqual(['TEST_v1', 'TEST_v2']);
      await importDeletionCheckpoint({
        targetPool: f.target.pool,
        currentSourcePool: f.source.pool,
        archiveFile: join(f.options.archiveDirectory, manifest.checkpointRef, 'archive.age'),
        identityFile: f.identityFile,
        signingKey: f.options.signingKey,
        expectedManifest: manifest,
        expectedCurrentWatermark: await readCheckpointWatermark(f.source.pool),
        evaluatedAt: f.options.now,
        maximumAgeMilliseconds: 60000,
        maximumRows: 1000,
        maximumPayloadBytes: 1048576,
        timeoutMilliseconds: 10000,
        restoreRef: 'RESTORE_TEST_rotated_checkpoint',
      });
      expect(
        (
          await f.target.pool.query(
            'select key_version from privacy_suppressions order by key_version',
          )
        ).rows,
      ).toEqual([
        { key_version: 'TEST_old' },
        { key_version: 'TEST_v1' },
        { key_version: 'TEST_v2' },
      ]);
    } finally {
      await f.close();
    }
  },
);
test.skipIf(!native)(
  'bounded export failure leaves no archive and creates a sanitized dashboard incident',
  async () => {
    const f = await fixture();
    try {
      await addTombstone(f.source.pool, f.options.now, 'TEST_v1', 'a');
      await addTombstone(f.source.pool, f.options.now, 'TEST_v1', 'b');
      await expect(exportDeletionCheckpoint({ ...f.options, maximumRows: 1 })).rejects.toThrow(
        'checkpoint_export_failed',
      );
      expect(await readdir(f.options.archiveDirectory)).toEqual([]);
      expect(
        (
          await f.source.pool.query(
            "select count(*)::int as count from operations_incidents where component='deletion_checkpoint'",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await f.close();
    }
  },
);
test.skipIf(!native).each(['checkpoint', 'export-checkpoint-reference'])(
  'compiled private %s job exports current authority without an identity',
  async (command) => {
    const f = await fixture();
    try {
      await addTombstone(f.source.pool, f.options.now);
      // A past fixture time is deliberate; the CLI must sample its own current clock.
      await f.source.pool.query(
        "update privacy_suppressions set effective_at='2001-01-01T00:00:00Z'",
      );
      const databaseFile = join(f.root, 'database');
      const signingFile = join(f.root, 'signing');
      await writeFile(databaseFile, f.source.connectionString, { mode: 0o600 });
      await writeFile(signingFile, f.options.signingKey.copy(), { mode: 0o600 });
      await chmod(f.identityFile, 0o000);
      const config = operationsEnvironment();
      const invoke = async (override: Record<string, string> = {}) => {
        const child = spawn(process.execPath, ['/app/dist/operations-main.js', command], {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            PATH: process.env.PATH,
            ...config,
            NODE_ENV: 'production',
            DATABASE_URL_FILE: databaseFile,
            BACKUP_ENCRYPTION_RECIPIENT_FILE: f.options.recipientFile,
            RECOVERY_MANIFEST_HMAC_FILE: signingFile,
            CHECKPOINT_ARCHIVE_DIRECTORY: f.options.archiveDirectory,
            CHECKPOINT_MAX_ROWS: '1000',
            CHECKPOINT_MAX_PAYLOAD_BYTES: '1048576',
            OPS_GIT_REVISION: 'a'.repeat(40),
            OPS_SCHEMA_REVISION: '000016',
            OPS_DATABASE_SYSTEM_IDENTIFIER: f.options.expectedDatabaseIdentity.systemIdentifier,
            OPS_DATABASE_NAME: f.options.expectedDatabaseIdentity.databaseName,
            OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
              checkpoint: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 32 },
            }),
            ...override,
          },
        });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (text: string) => {
          output += text;
          if (output.length > 4096) child.kill('SIGKILL');
        });
        const code = await new Promise<number | null>((done, reject) => {
          child.once('error', () => {
            reject(new Error('synthetic_checkpoint_cli_failed'));
          });
          child.once('close', done);
        });
        return { code, output };
      };
      for (const override of [
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '1111111111111111111' },
        { OPS_DATABASE_NAME: 'fcd_support_foreign' },
        { OPS_DATABASE_SYSTEM_IDENTIFIER: '' },
      ]) {
        const refused = await invoke(override);
        expect(refused.code).toBe(1);
        expect(JSON.parse(refused.output)).toMatchObject({
          event: 'operations_job_failed',
          level: 'error',
        });
        expect(await readdir(f.options.archiveDirectory)).toEqual([]);
      }
      const { code, output } = await invoke();
      expect(code).toBe(0);
      const ref = (await readdir(f.options.archiveDirectory))[0];
      if (ref === undefined) throw new Error('synthetic_checkpoint_archive_missing');
      if (command === 'export-checkpoint-reference') expect(output).toBe(ref + '\n');
      else
        expect(JSON.parse(output)).toMatchObject({
          status: 'completed',
          processed: 1,
          reasonCode: 'ok',
        });
      const text = await readFile(join(f.options.archiveDirectory, ref, 'manifest.json'), 'utf8');
      expect(text.includes('Synthetic')).toBe(false);
    } finally {
      await chmod(f.identityFile, 0o600);
      await f.close();
    }
  },
);
test.skipIf(!native)(
  'caller-held source freeze persists through export and prevents a promotion-time deletion race',
  async () => {
    const f = await fixture();
    const source = await f.source.pool.connect();
    const writer = await f.source.pool.connect();
    try {
      await source.query('begin');
      await source.query('lock table privacy_suppressions in share mode');
      const manifest = await exportDeletionCheckpoint({
        ...f.options,
        sourcePool: { transactionClient: source },
      });
      expect(manifest.rowCount).toBe(0);
      await writer.query('begin');
      await writer.query("set local lock_timeout='50ms'");
      await expect(
        writer.query(
          `insert into privacy_suppressions(identity_hmac,channel,category,reason_code,effective_at,key_version)
      values($1,'messenger','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
          ['d'.repeat(64), f.options.now],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('rollback');
      await source.query('rollback');
    } finally {
      await source.query('rollback');
      await writer.query('rollback');
      source.release();
      writer.release();
      await f.close();
    }
  },
);
