import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createMaintenancePool } from '../../src/operations/maintenance-pool.js';
import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { PostgresNotificationWork } from '../../src/persistence/postgres-notification-work.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../../src/persistence/postgres-runtime-grants.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import {
  createIsolatedTestDatabase,
  requireIsolatedTestDatabaseUrl,
  type IsolatedTestDatabase,
} from './test-database.js';

let database: IsolatedTestDatabase;
let maintenance: pg.Pool | undefined;
let notification: pg.Pool | undefined;
const rolePrefix = `fcd_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const cleanups: (() => Promise<void>)[] = [];
const at = new Date('2030-04-01T00:00:00.000Z');

beforeAll(async () => {
  database = await createIsolatedTestDatabase('notify_privacy_grants');
  cleanups.push(async () => {
    // The migrator owns this schema after bootstrap. Drop it before DROP OWNED,
    // which would otherwise remove objects underneath schema cleanup.
    await database.dispose();
    const admin = new pg.Pool({
      connectionString: requireIsolatedTestDatabaseUrl(process.env),
      max: 1,
    });
    try {
      for (const role of [...runtimeDatabaseRoles, 'migrator']) {
        const name = `${rolePrefix}_${role}`;
        if (!/^fcd_test_[a-f0-9]{12}_[a-z_]+$/u.test(name))
          throw new Error('synthetic_role_scope_invalid');
        const present = await admin.query<{ present: boolean }>(
          'select exists(select 1 from pg_catalog.pg_roles where rolname=$1) as present',
          [name],
        );
        if (present.rows[0]?.present === true) {
          await admin.query(`drop owned by "${name}"`);
          await admin.query(`drop role "${name}"`);
        }
      }
    } finally {
      await admin.end();
    }
  });
  const root = await mkdtemp(join(tmpdir(), 'fcd-notification-privacy-grants-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const passwords: Record<string, string> = {};
  const passwordFiles: Record<string, string> = {};
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
  const systemIdentifier = (
    await database.pool.query<{ id: string }>(
      'select system_identifier::text as id from pg_catalog.pg_control_system()',
    )
  ).rows[0]?.id;
  if (systemIdentifier === undefined) throw new Error('synthetic_cluster_missing');
  const connectionFor = (role: string) => {
    const url = new URL(database.connectionString);
    url.username = `${rolePrefix}_${role}`;
    url.password = passwords[role] ?? '';
    return url.toString();
  };
  maintenance = createMaintenancePool({
    connectionString: connectionFor('maintenance'),
    expectedDatabaseIdentity: { systemIdentifier, databaseName: 'fcd_support_test' },
    schema: database.schema,
    rolePrefix,
    operationReference: `operation_${randomUUID().replaceAll('-', '')}`,
    max: 2,
    timeoutMilliseconds: 5000,
  });
  notification = new pg.Pool({
    connectionString: connectionFor('notification'),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
});

afterAll(async () => {
  await notification?.end();
  await maintenance?.end();
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test.each(['claimed', 'not_reconciled'] as const)(
  'dedicated maintenance deletion cancels %s support delivery without losing evidence or permitting reconciliation',
  async (stage) => {
    if (maintenance === undefined || notification === undefined)
      throw new Error('synthetic_runtime_pools_missing');
    // All fixture construction and approval use the isolated owner. The erasure
    // transaction below must succeed using the actual restricted maintenance login.
    const identity = {
      channel: 'messenger' as const,
      channelAccountId: `PAGE_TEST_privacy_grants_${stage}`,
      externalContactId: `CONTACT_TEST_privacy_grants_${stage}`,
    };
    const source = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: `notification_privacy_grants_${stage}`,
      identity,
      occurredAt: at,
    });
    const escalationRef = `ESCALATION_TEST_notification_privacy_${stage}`;
    await database.pool.query(
      `insert into support_escalation_outcomes
    (escalation_ref,conversation_id,source_webhook_event_id,reason_code,state,request_key,created_at,updated_at)
    values($1,$2,$3,'provider_failure','open',$4,$5,$5)`,
      [
        escalationRef,
        source.conversationId,
        source.eventId,
        `REQUEST_TEST_notification_privacy_${stage}`,
        at,
      ],
    );
    const work = new PostgresNotificationWork(notification, {
      maximumAttempts: 3,
      retryBaseMilliseconds: 1000,
      retryMaximumMilliseconds: 2000,
    });
    let claim: Awaited<ReturnType<typeof work.claim>>[number] | undefined;
    if (stage === 'claimed') {
      expect(await work.reconcile(10, at)).toEqual({ created: 1 });
      const first = (
        await work.claim({
          workerRef: 'WORKER_TEST_privacy_grants',
          evaluatedAt: at,
          limit: 10,
          leaseMilliseconds: 60000,
        })
      )[0];
      if (first === undefined) throw new Error('synthetic_notification_claim_missing');
      await work.finish({
        workRef: first.workRef,
        leaseRef: first.leaseRef,
        evaluatedAt: new Date(at.getTime() + 1000),
        result: { status: 'retryable', reasonCode: 'transport_failure' },
      });
      claim = (
        await work.claim({
          workerRef: 'WORKER_TEST_privacy_grants',
          evaluatedAt: new Date(at.getTime() + 2000),
          limit: 10,
          leaseMilliseconds: 60000,
        })
      )[0];
      if (claim === undefined) throw new Error('synthetic_notification_retry_missing');
      expect(
        await work.authorize({
          workRef: claim.workRef,
          leaseRef: claim.leaseRef,
          evaluatedAt: new Date(at.getTime() + 2000),
          requiredLeaseMilliseconds: 1000,
        }),
      ).toBe(true);
    }
    const readAttempts = async () =>
      (
        await database.pool.query<{
          attempt_number: number;
          status: string;
          reason_code: string;
          completed_at: Date;
        }>(
          `select attempt.attempt_number,attempt.status,attempt.reason_code,attempt.completed_at
           from notification_delivery_attempts attempt
           join notification_delivery_work work on work.id=attempt.work_id
           join support_escalation_outcomes escalation on escalation.id=work.support_escalation_id
           where escalation.escalation_ref=$1 order by attempt.id`,
          [escalationRef],
        )
      ).rows;
    const attemptsBefore = await readAttempts();
    expect(attemptsBefore).toHaveLength(stage === 'claimed' ? 1 : 0);
    if (stage === 'not_reconciled')
      expect(
        (
          await database.pool.query(
            `select count(*)::int as count from notification_delivery_work work
             join support_escalation_outcomes escalation on escalation.id=work.support_escalation_id
             where escalation.escalation_ref=$1`,
            [escalationRef],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    const ownerDeletion = new PostgresDeletionPolicy(database.pool, syntheticPrivacyKeyring);
    const opened = await ownerDeletion.openRequest({
      identity,
      requestedAt: at,
      sourceWebhookEventId: source.eventId,
      requestKey: `REQUEST_TEST_privacy_grants_open_${stage}`,
    });
    const confirmation = await insertSyntheticAppliedCustomerEvent(database.pool, {
      fixtureKey: `notification_privacy_grants_confirmation_${stage}`,
      identity,
      occurredAt: new Date(at.getTime() + 4000),
      messageText: 'Synthetic explicit deletion confirmation',
    });
    await ownerDeletion.reviewRequest(
      {
        requestRef: opened.requestRef,
        confirmationWebhookEventId: confirmation.eventId,
        decidedAt: new Date(at.getTime() + 5000),
        decision: 'approve',
        verificationMethod: 'explicit_confirmation',
        reasonCode: 'customer_confirmed',
        requestKey: `REQUEST_TEST_privacy_grants_review_${stage}`,
      },
      { reviewerRef: 'REVIEWER_TEST_privacy_grants', roles: ['support_reviewer'] },
    );
    expect(
      (
        await maintenance.query(
          `select current_user=$1 as correct_role,not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls as restricted from pg_catalog.pg_roles where rolname=current_user`,
          [`${rolePrefix}_maintenance`],
        )
      ).rows,
    ).toEqual([{ correct_role: true, restricted: true }]);
    const erasedAt = new Date(at.getTime() + 6000);
    expect(
      await new PostgresDeletionPolicy(maintenance, syntheticPrivacyKeyring).executeApprovedRequest(
        {
          requestRef: opened.requestRef,
          executedAt: erasedAt,
          requestKey: `REQUEST_TEST_privacy_grants_execute_${stage}`,
        },
      ),
    ).toMatchObject({
      status: 'applied',
      conversationsProcessed: 1,
      identitiesPseudonymized: 1,
      messagesCleared: 2,
      tombstonesCreated: 1,
    });
    expect(
      (
        await database.pool.query(
          `select work.state,work.reason_code,work.attempt_count,work.lease_ref,work.worker_ref,work.lease_expires_at,work.next_attempt_at
    from notification_delivery_work work join support_escalation_outcomes escalation on escalation.id=work.support_escalation_id where escalation.escalation_ref=$1`,
          [escalationRef],
        )
      ).rows,
    ).toEqual([
      {
        state: 'failed',
        reason_code: 'source_unavailable',
        attempt_count: stage === 'claimed' ? 2 : 0,
        lease_ref: null,
        worker_ref: null,
        lease_expires_at: null,
        next_attempt_at: null,
      },
    ]);
    expect(
      (
        await database.pool.query(
          'select state,reason_code from support_escalation_outcomes where escalation_ref=$1',
          [escalationRef],
        )
      ).rows,
    ).toEqual([{ state: 'open', reason_code: 'provider_failure' }]);
    expect(await readAttempts()).toEqual(attemptsBefore);
    expect(
      (
        await database.pool.query(
          `select count(*)::int as erased from webhook_events where id=any($1::bigint[]) and message_text is null and channel_account_id is null and contact_id is null`,
          [[source.eventId, confirmation.eventId]],
        )
      ).rows,
    ).toEqual([{ erased: 2 }]);
    expect(await work.reconcile(10, new Date(at.getTime() + 7000))).toEqual({ created: 0 });
    expect(
      await work.claim({
        workerRef: 'WORKER_TEST_privacy_grants_after_deletion',
        evaluatedAt: new Date(at.getTime() + 7000),
        limit: 10,
        leaseMilliseconds: 60000,
      }),
    ).toEqual([]);
    if (claim !== undefined)
      expect(
        await work.authorize({
          workRef: claim.workRef,
          leaseRef: claim.leaseRef,
          evaluatedAt: new Date(at.getTime() + 7000),
          requiredLeaseMilliseconds: 1000,
        }),
      ).toBe(false);
  },
);
