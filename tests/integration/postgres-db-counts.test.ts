import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { collectDbCounts, dbCountsReportSchema } from '../../src/operations/db-counts.js';
import { createMaintenancePool } from '../../src/operations/maintenance-pool.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import {
  createIsolatedTestDatabase,
  requireIsolatedTestDatabaseUrl,
  type IsolatedTestDatabase,
} from './test-database.js';

let database: IsolatedTestDatabase;
let root: string;
let systemIdentifier: string;
const rolePrefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const passwords: Record<string, string> = {};
const passwordFiles: Record<string, string> = {};
const cleanups: (() => Promise<void>)[] = [];
const at = new Date('2030-03-01T00:00:00.000Z');
const revision = 'a'.repeat(40);

async function dropFixtureRoles(admin: pg.Pool) {
  for (const role of [...runtimeDatabaseRoles, 'migrator']) {
    const name = `${rolePrefix}_${role}`;
    if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name)) {
      throw new Error('synthetic_role_scope_invalid');
    }
    await admin.query(`drop owned by "${name}"`);
    await admin.query(`drop role "${name}"`);
  }
}

beforeAll(async () => {
  database = await createIsolatedTestDatabase('db_counts');
  cleanups.push(async () => {
    await database.dispose();
    const admin = new pg.Pool({ connectionString: requireIsolatedTestDatabaseUrl(process.env) });
    try {
      await dropFixtureRoles(admin);
    } finally {
      await admin.end();
    }
  });
  root = await mkdtemp(join(tmpdir(), 'fcd-db-counts-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  for (const role of [...runtimeDatabaseRoles, 'migrator']) {
    const password = `synthetic_${rolePrefix}_${role}_password_only`;
    passwords[role] = password;
    const path = join(root, role);
    passwordFiles[role] = path;
    await writeFile(path, password, { mode: 0o600 });
  }
  await configureRuntimeGrants(database.pool, {
    schema: database.schema,
    database: 'fcd_support_test',
    rolePrefix,
    passwordFiles,
  });
  const actual = (
    await database.pool.query<{ id: string }>(
      'select system_identifier::text as id from pg_catalog.pg_control_system()',
    )
  ).rows[0]?.id;
  if (actual === undefined) throw new Error('synthetic_cluster_missing');
  systemIdentifier = actual;

  await database.pool.query(
    `insert into operations_deployments(git_revision, schema_revision, status, recorded_at)
     values ($1, '000019', 'succeeded', $2)`,
    [revision, at],
  );
  const receipt = await database.pool.query<{ id: string }>(
    `insert into webhook_receipts(payload_sha256, received_at, event_count)
     values ($1, $2, 1) returning id`,
    ['0'.repeat(64), at],
  );
  const receiptId = receipt.rows[0]?.id;
  const event = await database.pool.query<{ id: string }>(
    `insert into webhook_events (
       receipt_id, idempotency_key, channel, event_kind, channel_account_id,
       contact_id, external_message_id, occurred_at, message_text,
       admission_outcome, created_at
     ) values (
       $1, 'synthetic_idem_1', 'whatsapp', 'customer_message', 'synthetic_phone_id',
       'synthetic_contact_999', 'synthetic_wamid_1', $2, 'SYNTHETIC_SECRET_CUSTOMER_MESSAGE',
       'pending', $2
     ) returning id`,
    [receiptId, at],
  );
  await database.pool.query(
    `insert into webhook_event_attachments (
       webhook_event_id, attachment_index, attachment_kind, raw_type,
       extraction_status, extracted_text, extraction_method, detected_language
     ) values (
       $1, 0, 'document', 'document',
       'extracted', 'SYNTHETIC_EXTRACTED_PDF_BODY', 'pdf_text', 'en'
     )`,
    [event.rows[0]?.id],
  );
});

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test('collectDbCounts runs as least-privilege maintenance role and leaks zero customer text or identifiers', async () => {
  const url = new URL(database.connectionString);
  url.username = `${rolePrefix}_maintenance`;
  url.password = passwords.maintenance ?? '';

  const pool = createMaintenancePool({
    connectionString: url.toString(),
    expectedDatabaseIdentity: { systemIdentifier, databaseName: 'fcd_support_test' },
    schema: database.schema,
    rolePrefix,
    operationReference: `operation_${randomUUID().replaceAll('-', '')}`,
    max: 1,
    timeoutMilliseconds: 5000,
  });

  try {
    const counts = await collectDbCounts(pool, { maximumCallMilliseconds: 5000 });
    expect(dbCountsReportSchema.parse(counts)).toEqual(counts);
    expect(counts.webhookReceipts).toEqual({ total: 1 });
    expect(counts.webhookEvents).toEqual({
      total: 1,
      byAdmissionOutcome: { pending: 1 },
    });
    expect(counts.webhookEventAttachments).toEqual({
      total: 1,
      byStatus: { extracted: 1 },
      byKind: { document: 1 },
    });
    expect(counts.operationsDeployments).toEqual({
      total: 1,
      byStatus: { succeeded: 1 },
    });

    const serialized = JSON.stringify(counts);
    expect(serialized).not.toContain('SYNTHETIC_SECRET_CUSTOMER_MESSAGE');
    expect(serialized).not.toContain('SYNTHETIC_EXTRACTED_PDF_BODY');
    expect(serialized).not.toContain('synthetic_contact_999');
    expect(serialized).not.toContain('synthetic_wamid_1');
  } finally {
    await pool.end();
  }
});
