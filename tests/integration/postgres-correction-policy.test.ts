import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  PostgresCorrectionPolicy,
  PRODUCTION_CORRECTION_HANDLERS,
  type CorrectionHandler,
} from '../../src/persistence/postgres-correction-policy.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_correction_policy',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       privacy_marketing_reopt_in_runs, privacy_access_runs,
       privacy_correction_runs, privacy_marketing_opt_out_runs,
       privacy_notification_intents, privacy_request_events,
       privacy_request_locations, privacy_deletion_runs,
       restore_deletion_gates, privacy_requests, privacy_suppressions,
       retention_job_runs, retention_events, conversation_retention_states,
       policy_audit_outcomes, consent_events, human_pause_events,
       webhook_event_applications, conversations, channel_identities,
       contacts, webhook_events, webhook_receipts
     restart identity cascade`,
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

const reviewer = {
  reviewerRef: 'REVIEWER_TEST_correction',
  roles: ['support_reviewer'],
} as const;

const subjectIdentity = {
  channel: 'whatsapp',
  channelAccountId: 'ACCOUNT_TEST_correction_subject',
  externalContactId: 'CONTACT_TEST_correction_subject',
} as const;

interface ApprovedCorrectionFixture {
  readonly contactId: string;
  readonly requestRef: string;
}

async function prepareApprovedRequest(
  requestType: 'access' | 'correction' = 'correction',
): Promise<ApprovedCorrectionFixture> {
  const phrase = requestType === 'correction' ? 'CORRECT MY DATA' : 'REQUEST MY DATA';
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `correction-${requestType}-request`,
    identity: {
      ...subjectIdentity,
      externalContactId: `${subjectIdentity.externalContactId}_${requestType}`,
    },
    messageText: phrase,
    occurredAt: new Date('2026-08-31T09:00:00.000Z'),
  });
  const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
  const opened = await policy.processAppliedEvent({
    requestKey: `correction-${requestType}-open`,
    sourceWebhookEventId: source.eventId,
  });
  if (opened.status !== 'opened') throw new Error('Synthetic correction request was not opened');
  await policy.reviewRequest(
    {
      decidedAt: new Date('2026-08-31T09:01:00.000Z'),
      decision: 'approve',
      reasonCode: 'identity_verified',
      requestKey: `correction-${requestType}-review`,
      requestRef: opened.requestRef,
      verificationMethod: 'same_channel_context',
    },
    reviewer,
  );
  const contact = await pool.query<{ readonly contact_id: string }>(
    `select contact_id
     from privacy_requests
     where request_ref = $1`,
    [opened.requestRef],
  );
  const contactId = contact.rows[0]?.contact_id;
  if (contactId === undefined) throw new Error('Synthetic correction contact was not found');
  return { contactId, requestRef: opened.requestRef };
}

const timestampCommand = z.strictObject({
  updatedAt: z.date(),
});

function timestampHandler(
  applySpy = vi.fn(),
): CorrectionHandler<'synthetic_profile_timestamp', { readonly updatedAt: Date }> {
  return {
    fieldKey: 'synthetic_profile_timestamp',
    parse(input) {
      return timestampCommand.parse(input);
    },
    async apply(context, command) {
      applySpy(context.contactId);
      await context.client.query(`update contacts set updated_at = $2 where id = $1`, [
        context.contactId,
        command.updatedAt,
      ]);
      return { resultCode: 'applied' };
    },
  };
}

describe('PostgresCorrectionPolicy', () => {
  test('keeps production registry empty and records closed manual/rejected outcomes', async () => {
    const prepared = await prepareApprovedRequest();
    expect(PRODUCTION_CORRECTION_HANDLERS).toEqual([]);
    const service = new PostgresCorrectionPolicy(pool);

    await expect(
      service.execute(
        {
          executedAt: new Date('2026-08-31T09:10:00.000Z'),
          fieldKey: 'unknown_profile_field',
          requestKey: 'correction-unknown',
          requestRef: prepared.requestRef,
        },
        { arbitraryValue: 'Synthetic value that must never persist' },
        reviewer,
      ),
    ).resolves.toEqual({
      fieldKey: 'unknown_profile_field',
      requestRef: prepared.requestRef,
      resultCode: 'manual_required',
      status: 'applied',
    });
    await expect(
      service.execute(
        {
          executedAt: new Date('2026-08-31T09:11:00.000Z'),
          fieldKey: 'password',
          requestKey: 'correction-password',
          requestRef: prepared.requestRef,
        },
        { arbitraryValue: 'Synthetic prohibited value' },
        reviewer,
      ),
    ).resolves.toMatchObject({ resultCode: 'rejected' });
    await expect(
      service.execute(
        {
          executedAt: new Date('2026-08-31T09:12:00.000Z'),
          fieldKey: 'meta_profile_name',
          requestKey: 'correction-provider-owned',
          requestRef: prepared.requestRef,
        },
        { arbitraryValue: 'Synthetic provider value' },
        reviewer,
      ),
    ).resolves.toMatchObject({ resultCode: 'manual_required' });

    const evidence = await pool.query<{
      readonly field_key: string;
      readonly result_code: string;
      readonly run: unknown;
    }>(
      `select field_key, result_code, to_jsonb(run) as run
       from privacy_correction_runs as run
       order by id`,
    );
    expect(evidence.rows.map(({ field_key, result_code }) => ({ field_key, result_code }))).toEqual(
      [
        { field_key: 'unknown_profile_field', result_code: 'manual_required' },
        { field_key: 'password', result_code: 'rejected' },
        { field_key: 'meta_profile_name', result_code: 'manual_required' },
      ],
    );
    const serialized = JSON.stringify(evidence.rows);
    expect(serialized).not.toContain('Synthetic value that must never persist');
    expect(serialized).not.toContain('Synthetic prohibited value');
    expect(serialized).not.toContain('Synthetic provider value');
  });

  test('executes only the registered typed handler for the approved request contact', async () => {
    const prepared = await prepareApprovedRequest();
    const other = await pool.query<{ readonly id: string }>(
      `insert into contacts (created_at, updated_at)
       values ('2026-08-31T09:00:00Z', '2026-08-31T09:00:00Z')
       returning id`,
    );
    const applySpy = vi.fn();
    const requestedTimestamp = new Date('2026-08-31T09:20:00.000Z');
    const service = new PostgresCorrectionPolicy(pool, [timestampHandler(applySpy)]);

    await expect(
      service.execute(
        {
          executedAt: new Date('2026-08-31T09:10:00.000Z'),
          fieldKey: 'synthetic_profile_timestamp',
          requestKey: 'correction-typed-handler',
          requestRef: prepared.requestRef,
        },
        { updatedAt: requestedTimestamp },
        reviewer,
      ),
    ).resolves.toEqual({
      fieldKey: 'synthetic_profile_timestamp',
      requestRef: prepared.requestRef,
      resultCode: 'applied',
      status: 'applied',
    });
    expect(applySpy).toHaveBeenCalledOnce();
    expect(applySpy).toHaveBeenCalledWith(prepared.contactId);
    const contacts = await pool.query(
      `select id, updated_at
       from contacts
       where id in ($1, $2)
       order by id`,
      [prepared.contactId, other.rows[0]?.id],
    );
    expect(contacts.rows).toEqual([
      { id: prepared.contactId, updated_at: requestedTimestamp },
      { id: other.rows[0]?.id, updated_at: new Date('2026-08-31T09:00:00.000Z') },
    ]);
    const checklist = await pool.query(
      `select state, outcome_code, checked_at, reviewer_reference
       from privacy_request_locations
       where request_id = (
         select id from privacy_requests where request_ref = $1
       )
         and location_code = 'primary_postgres'`,
      [prepared.requestRef],
    );
    expect(checklist.rows).toEqual([
      {
        checked_at: new Date('2026-08-31T09:10:00.000Z'),
        outcome_code: 'location_complete',
        reviewer_reference: null,
        state: 'completed',
      },
    ]);
    const evidence = await pool.query<{ readonly run: unknown }>(
      `select to_jsonb(run) as run
       from privacy_correction_runs as run`,
    );
    expect(JSON.stringify(evidence.rows)).not.toContain(requestedTimestamp.toISOString());
  });

  test('requires reviewer authorization and an approved correction request', async () => {
    const prepared = await prepareApprovedRequest();
    const service = new PostgresCorrectionPolicy(pool, [timestampHandler()]);
    const command = {
      executedAt: new Date('2026-08-31T09:10:00.000Z'),
      fieldKey: 'synthetic_profile_timestamp',
      requestKey: 'correction-authorization',
      requestRef: prepared.requestRef,
    } as const;

    await expect(
      service.execute(
        command,
        { updatedAt: new Date() },
        {
          reviewerRef: 'REVIEWER_TEST_correction_unauthorized',
          roles: ['incident_reader'],
        },
      ),
    ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    const access = await prepareApprovedRequest('access');
    await expect(
      service.execute(
        { ...command, requestKey: 'correction-wrong-type', requestRef: access.requestRef },
        { updatedAt: new Date('2026-08-31T09:20:00.000Z') },
        reviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });

  test('returns duplicate without reapplying and rejects conflicting request-key material', async () => {
    const prepared = await prepareApprovedRequest();
    const applySpy = vi.fn();
    const service = new PostgresCorrectionPolicy(pool, [timestampHandler(applySpy)]);
    const command = {
      executedAt: new Date('2026-08-31T09:10:00.000Z'),
      fieldKey: 'synthetic_profile_timestamp',
      requestKey: 'correction-replay',
      requestRef: prepared.requestRef,
    } as const;
    const handlerCommand = { updatedAt: new Date('2026-08-31T09:20:00.000Z') };

    await expect(service.execute(command, handlerCommand, reviewer)).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(service.execute(command, handlerCommand, reviewer)).resolves.toMatchObject({
      status: 'duplicate',
    });
    expect(applySpy).toHaveBeenCalledOnce();
    await expect(
      service.execute(
        { ...command, fieldKey: 'unknown_profile_field' },
        { arbitraryValue: 'Synthetic conflicting value' },
        reviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });

  test('rejects duplicate registry keys and rolls handler failure back completely', async () => {
    const handler = timestampHandler();
    expect(() => new PostgresCorrectionPolicy(pool, [handler, handler])).toThrow(
      'Duplicate correction handler field key',
    );
    const prepared = await prepareApprovedRequest();
    const baseline = await pool.query<{ readonly updated_at: Date }>(
      `select updated_at from contacts where id = $1`,
      [prepared.contactId],
    );
    const failingHandler: CorrectionHandler<
      'synthetic_failing_timestamp',
      { readonly updatedAt: Date }
    > = {
      fieldKey: 'synthetic_failing_timestamp',
      parse(input) {
        return timestampCommand.parse(input);
      },
      async apply(context, command) {
        await context.client.query(`update contacts set updated_at = $2 where id = $1`, [
          context.contactId,
          command.updatedAt,
        ]);
        throw new Error('Synthetic private handler failure detail');
      },
    };

    await expect(
      new PostgresCorrectionPolicy(pool, [failingHandler]).execute(
        {
          executedAt: new Date('2026-08-31T09:10:00.000Z'),
          fieldKey: 'synthetic_failing_timestamp',
          requestKey: 'correction-handler-failure',
          requestRef: prepared.requestRef,
        },
        { updatedAt: new Date('2026-08-31T09:20:00.000Z') },
        reviewer,
      ),
    ).rejects.toMatchObject({
      message: 'Correction handler failed',
      name: 'CorrectionHandlerExecutionError',
    });
    await expect(
      pool.query(`select updated_at from contacts where id = $1`, [prepared.contactId]),
    ).resolves.toEqual(baseline);
    await expect(
      pool.query(`select count(*)::int as count from privacy_correction_runs`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  test('contains no generic patch, dynamic field SQL, filesystem, network, or logging path', async () => {
    const source = await readFile(
      new URL('../../src/persistence/postgres-correction-policy.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/node:fs|node:http|node:https|fetch\s*\(|console\.|SafeLogger/);
    expect(source).not.toMatch(/json.?patch|requested_value|handler_error|\$\{[^}]*field/i);
  });
});
