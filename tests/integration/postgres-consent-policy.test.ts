import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConsentPolicy } from '../../src/persistence/postgres-consent-policy.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import type {
  ChannelIdentitySelector,
  CustomerMessageConsentCommand,
} from '../../src/policy/policy-types.js';
import { insertSyntheticPendingEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let databaseConnectionString: string;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase =
    await createIsolatedTestDatabase('postgres_consent_policy');
  databaseConnectionString = database.connectionString;
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       policy_audit_outcomes, consent_events, human_pause_events,
       webhook_event_applications, conversations, channel_identities,
       contacts, webhook_events, webhook_receipts
     restart identity`,
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

const supportReviewer = {
  reviewerRef: 'reviewer-opaque-consent',
  roles: ['incident_reader', 'support_reviewer'],
} as const;

async function createCustomerIdentity(input: {
  readonly fixtureKey: string;
  readonly identity?: ChannelIdentitySelector;
  readonly occurredAt?: Date;
}): Promise<{ readonly eventId: string; readonly identity: ChannelIdentitySelector }> {
  const identity = input.identity ?? {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${input.fixtureKey}`,
    externalContactId: `PSID_TEST_${input.fixtureKey}`,
  };
  const occurredAt = input.occurredAt ?? new Date('2026-08-11T12:00:00.000Z');
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: identity.channel,
    channelAccountId: identity.channelAccountId,
    contactId: identity.externalContactId,
    eventKind: 'customer_message',
    fixtureKey: input.fixtureKey,
    messageText: 'Synthetic consent source text that policy must not compare or audit',
    occurredAt,
  });
  const result = await new PostgresConversationEventProcessor(pool).processEvent(eventId);
  if (result.status !== 'applied' || result.outcome !== 'customer_message_applied') {
    throw new Error('Synthetic customer consent source was not applied');
  }
  return { eventId, identity };
}

function customerCommand(input: {
  readonly action?: 'grant' | 'revoke';
  readonly eventId: string;
  readonly fixtureKey: string;
  readonly identity: ChannelIdentitySelector;
  readonly sourceAt?: Date;
}): CustomerMessageConsentCommand {
  return {
    identity: input.identity,
    action: input.action ?? 'grant',
    category: 'security_updates',
    wording: 'Synthetic approved consent wording',
    wordingVersion: '2026-08',
    source: 'customer_message' as const,
    sourceAt: input.sourceAt ?? new Date('2026-08-11T12:00:00.000Z'),
    idempotencyKey: `synthetic-consent-${input.fixtureKey}`,
    sourceWebhookEventId: input.eventId,
  };
}

function reviewerCommand(input: {
  readonly action?: 'grant' | 'revoke';
  readonly category?: string;
  readonly fixtureKey: string;
  readonly identity: ChannelIdentitySelector;
  readonly sourceAt: Date;
}) {
  return {
    identity: input.identity,
    action: input.action ?? ('grant' as const),
    category: input.category ?? 'security_updates',
    wording: 'Synthetic approved reviewer consent wording',
    wordingVersion: '2026-08',
    source: 'reviewer_recorded' as const,
    sourceAt: input.sourceAt,
    idempotencyKey: `synthetic-reviewer-consent-${input.fixtureKey}`,
  };
}

async function identityDatabaseId(identity: ChannelIdentitySelector): Promise<string> {
  const selected = await pool.query<{ readonly id: string }>(
    `select id from channel_identities
     where channel = $1 and channel_account_id = $2 and external_contact_id = $3`,
    [identity.channel, identity.channelAccountId, identity.externalContactId],
  );
  const identityId = selected.rows[0]?.id;
  if (identityId === undefined) throw new Error('Synthetic identity was not persisted');
  return identityId;
}

interface ConsentMutationState {
  readonly audits: readonly unknown[] | null;
  readonly consent: readonly unknown[] | null;
}

async function readConsentMutationState() {
  return pool.query<ConsentMutationState>(
    `select
       (select jsonb_agg(to_jsonb(consent_events) order by id) from consent_events) as consent,
       (select jsonb_agg(to_jsonb(policy_audit_outcomes) order by id)
        from policy_audit_outcomes
        where decision_type = 'consent_record') as audits`,
  );
}

async function waitForConsentLockWaiters(
  applicationNames: readonly string[],
  expectedCount: number,
): Promise<void> {
  const deadline = performance.now() + 200;
  let observed = 0;
  while (performance.now() < deadline) {
    const activity = await pool.query<{ readonly waiting: number }>(
      `select count(*) filter (
         where state = 'active' and wait_event_type = 'Lock'
       )::int as waiting
       from pg_stat_activity
       where application_name = any($1::text[])`,
      [applicationNames],
    );
    observed = activity.rows[0]?.waiting ?? 0;
    if (observed === expectedCount) return;
  }
  throw new Error(`Synthetic consent lock barrier observed ${String(observed)} waiter(s)`);
}

async function runConcurrentConsentKeyReuse(input: {
  readonly firstCommand: ReturnType<typeof customerCommand>;
  readonly fixtureKey: string;
  readonly secondCommand: ReturnType<typeof customerCommand>;
}) {
  const applicationNames = [
    `consent_${input.fixtureKey}_first`,
    `consent_${input.fixtureKey}_second`,
  ] as const;
  const firstPool = new pg.Pool({
    application_name: applicationNames[0],
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const secondPool = new pg.Pool({
    application_name: applicationNames[1],
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const holder = await pool.connect();
  let holderOpen = false;
  let firstPromise: Promise<PromiseSettledResult<unknown>> | undefined;
  let secondPromise: Promise<PromiseSettledResult<unknown>> | undefined;

  try {
    await holder.query('begin');
    holderOpen = true;
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
      input.firstCommand.idempotencyKey,
    ]);
    firstPromise = new PostgresConsentPolicy(firstPool)
      .recordCustomerCommand(input.firstCommand)
      .then(
        (value): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value }),
        (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason }),
      );
    secondPromise = new PostgresConsentPolicy(secondPool)
      .recordCustomerCommand(input.secondCommand)
      .then(
        (value): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value }),
        (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason }),
      );
    await waitForConsentLockWaiters(applicationNames, 2);
    await holder.query('commit');
    holderOpen = false;
    return await Promise.all([firstPromise, secondPromise]);
  } finally {
    if (holderOpen) await holder.query('rollback');
    holder.release();
    await Promise.allSettled([firstPromise, secondPromise].filter((value) => value !== undefined));
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
}

interface SourceInvalidationCase {
  readonly label: string;
  readonly expectedCode: '23503' | '23514';
  readonly sql: string;
  readonly values: (input: {
    readonly conversationId: string;
    readonly eventId: string;
    readonly replacementIdentityId: string;
  }) => readonly string[];
}

const sourceInvalidationCases: readonly SourceInvalidationCase[] = [
  {
    label: 'application outcome update',
    expectedCode: '23514',
    sql: `update webhook_event_applications
          set outcome = 'business_echo_paused'
          where webhook_event_id = $1`,
    values: ({ eventId }) => [eventId],
  },
  {
    label: 'application deletion',
    expectedCode: '23514',
    sql: `delete from webhook_event_applications where webhook_event_id = $1`,
    values: ({ eventId }) => [eventId],
  },
  {
    label: 'event kind update',
    expectedCode: '23514',
    sql: `update webhook_events set event_kind = 'business_message_echo' where id = $1`,
    values: ({ eventId }) => [eventId],
  },
  {
    label: 'event deletion',
    expectedCode: '23503',
    sql: `delete from webhook_events where id = $1`,
    values: ({ eventId }) => [eventId],
  },
  {
    label: 'mapped conversation identity update',
    expectedCode: '23514',
    sql: `update conversations set channel_identity_id = $2 where id = $1`,
    values: ({ conversationId, replacementIdentityId }) => [conversationId, replacementIdentityId],
  },
  {
    label: 'mapped conversation deletion',
    expectedCode: '23514',
    sql: `delete from conversations where id = $1`,
    values: ({ conversationId }) => [conversationId],
  },
];

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
  );
}

async function runConcurrentSourceInvalidation(sourceInvalidation: SourceInvalidationCase) {
  const fixtureKey = `source-lock-${sourceInvalidation.label.replaceAll(' ', '-')}`;
  const sourceAt = new Date('2026-08-11T14:20:00.123Z');
  const { eventId, identity } = await createCustomerIdentity({ fixtureKey, occurredAt: sourceAt });
  const identityId = await identityDatabaseId(identity);
  const sourceMapping = await pool.query<{ readonly conversation_id: string }>(
    `select conversation_id from webhook_event_applications where webhook_event_id = $1`,
    [eventId],
  );
  const conversationId = sourceMapping.rows[0]?.conversation_id;
  if (conversationId === undefined) throw new Error('Synthetic source conversation was not mapped');
  const replacement = await pool.query<{ readonly id: string }>(
    `with replacement_contact as (
       insert into contacts (created_at, updated_at) values ($1, $1) returning id
     )
     insert into channel_identities
       (contact_id, channel, channel_account_id, external_contact_id, first_seen_at, last_seen_at)
     select id, 'messenger', $2, $3, $1, $1 from replacement_contact
     returning id`,
    [sourceAt, `PAGE_TEST_${fixtureKey}_replacement`, `PSID_TEST_${fixtureKey}_replacement`],
  );
  const replacementIdentityId = replacement.rows[0]?.id;
  if (replacementIdentityId === undefined)
    throw new Error('Synthetic replacement identity missing');

  const applicationKey = sourceInvalidation.label.replaceAll(' ', '_');
  const recorderName = `consent_source_${applicationKey}_record`;
  const invalidatorName = `consent_source_${applicationKey}_invalidate`;
  const recorderPool = new pg.Pool({
    application_name: recorderName,
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const invalidatorPool = new pg.Pool({
    application_name: invalidatorName,
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const holder = await pool.connect();
  const advisoryKey = 6_200_061;
  let holderOpen = false;
  let recordPromise: Promise<PromiseSettledResult<unknown>> | undefined;
  let invalidationPromise: Promise<PromiseSettledResult<unknown>> | undefined;

  try {
    await pool.query(`
      create function synthetic_block_consent_source_insert()
      returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(${String(advisoryKey)}::bigint);
        return new;
      end;
      $$;
      create trigger synthetic_block_consent_source_insert
        before insert on consent_events
        for each row execute function synthetic_block_consent_source_insert();
    `);
    await holder.query('begin');
    holderOpen = true;
    await holder.query(`select pg_advisory_xact_lock($1::bigint)`, [advisoryKey]);

    recordPromise = settled(
      new PostgresConsentPolicy(recorderPool).recordCustomerCommand(
        customerCommand({ eventId, fixtureKey, identity, sourceAt }),
      ),
    );
    await waitForConsentLockWaiters([recorderName], 1);

    invalidationPromise = settled(
      invalidatorPool.query(sourceInvalidation.sql, [
        ...sourceInvalidation.values({ conversationId, eventId, replacementIdentityId }),
      ]),
    );
    await waitForConsentLockWaiters([invalidatorName], 1);

    await holder.query('commit');
    holderOpen = false;
    const [recordResult, invalidationResult] = await Promise.all([
      recordPromise,
      invalidationPromise,
    ]);
    return { conversationId, eventId, identityId, invalidationResult, recordResult, sourceAt };
  } finally {
    if (holderOpen) await holder.query('rollback');
    holder.release();
    await Promise.allSettled(
      [recordPromise, invalidationPromise].filter((value) => value !== undefined),
    );
    await pool.query(`
      drop trigger if exists synthetic_block_consent_source_insert on consent_events;
      drop function if exists synthetic_block_consent_source_insert();
    `);
    await Promise.all([recorderPool.end(), invalidatorPool.end()]);
  }
}

describe('PostgresConsentPolicy missing and blank consent', () => {
  test('denies an existing identity with no consent', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'missing-consent' });

    const result = await new PostgresConsentPolicy(pool).evaluateMarketingEligibility(
      identity,
      'security_updates',
      new Date('2026-08-11T12:05:00.000Z'),
    );

    expect(result).toEqual({ eligible: false, reason: 'consent_missing' });
  });

  test('does not broaden an identity lookup across channels', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'channel-scope' });

    const result = await new PostgresConsentPolicy(pool).evaluateMarketingEligibility(
      { ...identity, channel: 'whatsapp' },
      'security_updates',
      new Date('2026-08-11T12:05:00.000Z'),
    );

    expect(result).toEqual({ eligible: false, reason: 'identity_not_found' });
  });

  test('denies an invalid category as missing consent even when the identity does not exist', async () => {
    const evaluatedAt = new Date('2026-08-11T12:05:00.000Z');

    const result = await new PostgresConsentPolicy(pool).evaluateMarketingEligibility(
      {
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST_invalid_category_missing_identity',
        externalContactId: 'PSID_TEST_invalid_category_missing_identity',
      },
      'Security Updates',
      evaluatedAt,
    );

    expect(result).toEqual({ eligible: false, reason: 'consent_missing' });
    const audit = await pool.query(
      `select outcome, reason_code, channel_identity_id, evaluated_at
       from policy_audit_outcomes
       where decision_type = 'marketing_eligibility'`,
    );
    expect(audit.rows).toEqual([
      {
        outcome: 'denied',
        reason_code: 'consent_missing',
        channel_identity_id: null,
        evaluated_at: evaluatedAt,
      },
    ]);
  });

  test('denies a blank category without querying consent rows', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'blank-category' });
    const lockHolder = await pool.connect();
    let transactionOpen = false;

    try {
      await lockHolder.query('begin');
      transactionOpen = true;
      await lockHolder.query('lock table consent_events in access exclusive mode');

      await expect(
        new PostgresConsentPolicy(pool).evaluateMarketingEligibility(
          identity,
          '   ',
          new Date('2026-08-11T12:05:00.000Z'),
        ),
      ).resolves.toEqual({ eligible: false, reason: 'consent_missing' });
    } finally {
      if (transactionOpen) {
        await lockHolder.query('rollback');
      }
      lockHolder.release();
    }
  });

  test.each([
    ['grant', 'category', { category: '   ' }],
    ['grant', 'wording', { wording: '   ' }],
    ['grant', 'wording version', { wordingVersion: '   ' }],
    ['revoke', 'category', { category: '   ' }],
    ['revoke', 'wording', { wording: '   ' }],
    ['revoke', 'wording version', { wordingVersion: '   ' }],
  ] as const)('rejects a %s with blank %s', async (action, _field, override) => {
    const sourceAt = new Date('2026-08-11T12:00:00.000Z');
    const { eventId, identity } = await createCustomerIdentity({
      fixtureKey: `blank-record-${action}-${Object.keys(override)[0] ?? 'field'}`,
      occurredAt: sourceAt,
    });
    const command = {
      identity,
      action,
      category: 'security_updates',
      wording: 'Synthetic approved consent wording',
      wordingVersion: '2026-08',
      source: 'customer_message',
      sourceAt,
      idempotencyKey: `synthetic-blank-${action}-${Object.keys(override)[0] ?? 'field'}`,
      sourceWebhookEventId: eventId,
      ...override,
    };

    await expect(new PostgresConsentPolicy(pool).recordCustomerCommand(command)).rejects.toThrow();
    const records = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from consent_events`,
    );
    expect(records.rows).toEqual([{ count: 0 }]);
  });
});

describe('PostgresConsentPolicy consent recording', () => {
  test('records a customer grant only from its exact applied customer event', async () => {
    const sourceAt = new Date('2026-08-11T13:00:00.000Z');
    const { eventId, identity } = await createCustomerIdentity({
      fixtureKey: 'record-customer',
      occurredAt: sourceAt,
    });

    const result = await new PostgresConsentPolicy(pool).recordCustomerCommand(
      customerCommand({ eventId, fixtureKey: 'record-customer', identity, sourceAt }),
    );

    expect(result).toMatchObject({ status: 'applied' });
    expect(result.consentEventId).toMatch(/^\d+$/);
    const stored = await pool.query<{ readonly channel_identity_id: string }>(
      `select consent.id, identity.channel, identity.channel_account_id,
              consent.category, consent.action, consent.wording,
              consent.wording_version, consent.source, consent.source_at,
              consent.idempotency_key, consent.source_webhook_event_id,
              audit.decision_type, audit.outcome, audit.reason_code,
              audit.channel_identity_id, audit.related_webhook_event_id,
              audit.evaluated_at
       from consent_events as consent
       join channel_identities as identity on identity.id = consent.channel_identity_id
       join policy_audit_outcomes as audit
         on audit.channel_identity_id = consent.channel_identity_id
        and audit.decision_type = 'consent_record'`,
    );
    expect(stored.rows).toMatchObject([
      {
        id: result.consentEventId,
        channel: 'messenger',
        channel_account_id: identity.channelAccountId,
        category: 'security_updates',
        action: 'grant',
        wording: 'Synthetic approved consent wording',
        wording_version: '2026-08',
        source: 'customer_message',
        source_at: sourceAt,
        idempotency_key: 'synthetic-consent-record-customer',
        source_webhook_event_id: eventId,
        decision_type: 'consent_record',
        outcome: 'applied',
        reason_code: 'consent_grant',
        related_webhook_event_id: eventId,
        evaluated_at: sourceAt,
      },
    ]);
    expect(stored.rows[0]?.channel_identity_id).toMatch(/^\d+$/);
  });

  test('records authorized reviewer consent for an existing exact identity', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'record-reviewer' });
    const command = {
      identity,
      action: 'revoke' as const,
      category: 'security_updates',
      wording: 'Synthetic approved revocation wording',
      wordingVersion: '2026-08',
      source: 'reviewer_recorded' as const,
      sourceAt: new Date('2026-08-11T13:30:00.000Z'),
      idempotencyKey: 'synthetic-consent-record-reviewer',
    };

    const result = await new PostgresConsentPolicy(pool).recordReviewerCommand(
      command,
      supportReviewer,
    );

    expect(result).toMatchObject({ status: 'applied' });
    const stored = await pool.query(
      `select action, source, source_webhook_event_id
       from consent_events
       where id = $1`,
      [result.consentEventId],
    );
    expect(stored.rows).toEqual([
      { action: 'revoke', source: 'reviewer_recorded', source_webhook_event_id: null },
    ]);
  });

  test('rejects the wrong source at each recording boundary without mutation', async () => {
    const { eventId, identity } = await createCustomerIdentity({ fixtureKey: 'wrong-boundary' });
    const customer = customerCommand({ eventId, fixtureKey: 'wrong-boundary', identity });
    const { sourceWebhookEventId: removed, ...reviewer } = {
      ...customer,
      source: 'reviewer_recorded' as const,
    };
    void removed;
    const before = await readConsentMutationState();
    const policy = new PostgresConsentPolicy(pool);

    await expect(policy.recordCustomerCommand(reviewer)).rejects.toThrow();
    await expect(policy.recordReviewerCommand(customer, supportReviewer)).rejects.toThrow();

    const after = await readConsentMutationState();
    expect(after.rows).toEqual(before.rows);
  });

  test('rejects an unauthorized reviewer before database access and without mutation', async () => {
    const unavailablePool = new pg.Pool({
      connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
      connectionTimeoutMillis: 100,
      max: 1,
    });
    const command = {
      identity: {
        channel: 'messenger' as const,
        channelAccountId: 'PAGE_TEST_unauthorized',
        externalContactId: 'PSID_TEST_unauthorized',
      },
      action: 'grant' as const,
      category: 'security_updates',
      wording: 'Synthetic approved consent wording',
      wordingVersion: '2026-08',
      source: 'reviewer_recorded' as const,
      sourceAt: new Date('2026-08-11T14:00:00.000Z'),
      idempotencyKey: 'synthetic-consent-unauthorized',
    };

    try {
      await expect(
        new PostgresConsentPolicy(unavailablePool).recordReviewerCommand(command, {
          reviewerRef: 'reviewer-opaque-denied',
          roles: ['incident_reader'],
        }),
      ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    } finally {
      await unavailablePool.end();
    }

    const state = await readConsentMutationState();
    expect(state.rows).toEqual([{ audits: null, consent: null }]);
  });

  test('exact replay is a no-op and material key reuse is a policy conflict', async () => {
    const { eventId, identity } = await createCustomerIdentity({ fixtureKey: 'record-replay' });
    const command = customerCommand({ eventId, fixtureKey: 'record-replay', identity });
    const policy = new PostgresConsentPolicy(pool);
    const applied = await policy.recordCustomerCommand(command);
    const beforeConflict = await readConsentMutationState();

    await expect(policy.recordCustomerCommand(command)).resolves.toEqual({
      status: 'duplicate',
      consentEventId: applied.consentEventId,
    });
    await expect(
      policy.recordCustomerCommand({ ...command, action: 'revoke' }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });

    const afterConflict = await readConsentMutationState();
    expect(afterConflict.rows).toEqual(beforeConflict.rows);
  });

  test('normalized exact replay appends no second consent or audit row', async () => {
    const { eventId, identity } = await createCustomerIdentity({ fixtureKey: 'normalized-replay' });
    const command = customerCommand({ eventId, fixtureKey: 'normalized-replay', identity });
    const policy = new PostgresConsentPolicy(pool);
    const applied = await policy.recordCustomerCommand(command);

    await expect(
      policy.recordCustomerCommand({
        ...command,
        identity: {
          ...identity,
          channelAccountId: `  ${identity.channelAccountId}  `,
          externalContactId: `  ${identity.externalContactId}  `,
        },
        category: `  ${command.category}  `,
        wording: `  ${command.wording}  `,
        wordingVersion: `  ${command.wordingVersion}  `,
        idempotencyKey: `  ${command.idempotencyKey}  `,
      }),
    ).resolves.toEqual({ status: 'duplicate', consentEventId: applied.consentEventId });
    const state = await readConsentMutationState();
    expect(state.rows[0]?.consent).toHaveLength(1);
    expect(state.rows[0]?.audits).toHaveLength(1);
  });

  test('revalidates the applied customer source before accepting an exact replay', async () => {
    const { eventId, identity } = await createCustomerIdentity({
      fixtureKey: 'replay-source-binding',
    });
    const command = customerCommand({ eventId, fixtureKey: 'replay-source-binding', identity });
    const policy = new PostgresConsentPolicy(pool);
    await policy.recordCustomerCommand(command);

    await pool.query(
      `alter table webhook_event_applications
       disable trigger webhook_event_applications_authoritative_stability`,
    );
    try {
      const invalidated = await pool.query(
        `update webhook_event_applications
         set outcome = 'business_echo_paused'
         where webhook_event_id = $1`,
        [eventId],
      );
      expect(invalidated.rowCount).toBe(1);
      const beforeReplay = await readConsentMutationState();

      await expect(policy.recordCustomerCommand(command)).rejects.toMatchObject({
        name: 'PolicyRecordNotFoundError',
      });

      expect((await readConsentMutationState()).rows).toEqual(beforeReplay.rows);
    } finally {
      await pool.query(
        `alter table webhook_event_applications
         enable trigger webhook_event_applications_authoritative_stability`,
      );
    }
  });

  test.each(sourceInvalidationCases)(
    'locks the source during concurrent $label and preserves its authority',
    async (sourceInvalidation) => {
      const result = await runConcurrentSourceInvalidation(sourceInvalidation);

      expect(result.recordResult).toMatchObject({
        status: 'fulfilled',
        value: { status: 'applied' },
      });
      expect(result.invalidationResult).toMatchObject({
        status: 'rejected',
        reason: { code: sourceInvalidation.expectedCode },
      });
      const source = await pool.query(
        `select source_event.event_kind, source_event.occurred_at,
                application.outcome, application.conversation_id,
                conversations.channel_identity_id
         from webhook_events as source_event
         join webhook_event_applications as application
           on application.webhook_event_id = source_event.id
         join conversations on conversations.id = application.conversation_id
         where source_event.id = $1`,
        [result.eventId],
      );
      expect(source.rows).toEqual([
        {
          event_kind: 'customer_message',
          occurred_at: result.sourceAt,
          outcome: 'customer_message_applied',
          conversation_id: result.conversationId,
          channel_identity_id: result.identityId,
        },
      ]);
      const state = await readConsentMutationState();
      expect(state.rows[0]?.consent).toHaveLength(1);
      expect(state.rows[0]?.audits).toHaveLength(1);
    },
  );

  test('every material idempotency-key mismatch is a conflict without mutation', async () => {
    const sourceAt = new Date('2026-08-11T14:30:00.000Z');
    const { eventId, identity } = await createCustomerIdentity({
      fixtureKey: 'material-base',
      occurredAt: sourceAt,
    });
    const secondSource = await createCustomerIdentity({
      fixtureKey: 'material-other-source',
      identity,
      occurredAt: sourceAt,
    });
    const command = customerCommand({ eventId, fixtureKey: 'material-key', identity, sourceAt });
    const policy = new PostgresConsentPolicy(pool);
    await policy.recordCustomerCommand(command);
    const before = await readConsentMutationState();
    const customerMismatches = [
      { ...command, action: 'revoke' as const },
      { ...command, identity: { ...identity, externalContactId: 'PSID_TEST_other_identity' } },
      { ...command, category: 'product_offers' },
      { ...command, wording: 'Synthetic changed approved wording' },
      { ...command, wordingVersion: '2026-09' },
      { ...command, sourceWebhookEventId: secondSource.eventId },
      { ...command, sourceAt: new Date('2026-08-11T14:30:00.001Z') },
    ];

    for (const mismatch of customerMismatches) {
      await expect(policy.recordCustomerCommand(mismatch)).rejects.toMatchObject({
        name: 'PolicyIdempotencyConflictError',
      });
      expect((await readConsentMutationState()).rows).toEqual(before.rows);
    }

    const { sourceWebhookEventId: removed, ...reviewerMismatch } = {
      ...command,
      source: 'reviewer_recorded' as const,
    };
    void removed;
    await expect(
      policy.recordReviewerCommand(reviewerMismatch, supportReviewer),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    expect((await readConsentMutationState()).rows).toEqual(before.rows);
  });

  test('concurrent exact reuse produces one applied record and one duplicate', async () => {
    const { eventId, identity } = await createCustomerIdentity({ fixtureKey: 'concurrent-exact' });
    const command = customerCommand({ eventId, fixtureKey: 'concurrent-exact', identity });

    const outcomes = await runConcurrentConsentKeyReuse({
      firstCommand: command,
      fixtureKey: 'exact',
      secondCommand: command,
    });

    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([]);
    const values = outcomes
      .filter((outcome) => outcome.status === 'fulfilled')
      .map((outcome) => outcome.value);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'applied' }),
        expect.objectContaining({ status: 'duplicate' }),
      ]),
    );
    const state = await readConsentMutationState();
    expect(state.rows[0]?.consent).toHaveLength(1);
    expect(state.rows[0]?.audits).toHaveLength(1);
  });

  test('concurrent material reuse becomes a policy conflict and never raw 23505', async () => {
    const { eventId, identity } = await createCustomerIdentity({
      fixtureKey: 'concurrent-conflict',
    });
    const command = customerCommand({ eventId, fixtureKey: 'concurrent-conflict', identity });

    const outcomes = await runConcurrentConsentKeyReuse({
      firstCommand: command,
      fixtureKey: 'conflict',
      secondCommand: customerCommand({
        ...command,
        action: 'revoke',
        eventId,
        fixtureKey: 'concurrent-conflict',
      }),
    });

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ value: { status: 'applied' } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { name: 'PolicyIdempotencyConflictError' } });
    expect(rejected[0]).not.toMatchObject({ reason: { code: '23505' } });
    const state = await readConsentMutationState();
    expect(state.rows[0]?.consent).toHaveLength(1);
    expect(state.rows[0]?.audits).toHaveLength(1);
  });

  test.each([
    ['business echo', 'business_message_echo', true, false],
    ['status event', 'message_status', true, false],
    ['unapplied customer event', 'customer_message', false, false],
    ['another identity customer event', 'customer_message', true, true],
  ] as const)(
    'rejects %s as a customer consent source',
    async (_reason, eventKind, applyEvent, useOtherIdentity) => {
      const sourceAt = new Date('2026-08-11T14:45:00.000Z');
      const { identity } = await createCustomerIdentity({
        fixtureKey: `invalid-source-seed-${eventKind}`,
      });
      const sourceIdentity = useOtherIdentity
        ? {
            ...identity,
            externalContactId: `${identity.externalContactId}_other`,
          }
        : identity;
      const sourceEventId = await insertSyntheticPendingEvent(pool, {
        channel: sourceIdentity.channel,
        channelAccountId: sourceIdentity.channelAccountId,
        contactId: sourceIdentity.externalContactId,
        eventKind,
        fixtureKey: `invalid-source-${eventKind}-${String(useOtherIdentity)}`,
        ...(eventKind === 'message_status' ? { messageStatus: 'delivered' as const } : {}),
        ...(eventKind !== 'message_status'
          ? { messageText: 'Synthetic invalid consent source text' }
          : {}),
        occurredAt: sourceAt,
      });
      if (applyEvent) {
        await new PostgresConversationEventProcessor(pool).processEvent(sourceEventId);
      }
      const command = customerCommand({
        eventId: sourceEventId,
        fixtureKey: `invalid-source-${eventKind}-${String(useOtherIdentity)}`,
        identity,
        sourceAt,
      });

      await expect(
        new PostgresConsentPolicy(pool).recordCustomerCommand(command),
      ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });
      const state = await readConsentMutationState();
      expect(state.rows).toEqual([{ audits: null, consent: null }]);
    },
  );

  test('rejects customer source-time mismatch without mutation', async () => {
    const { eventId, identity } = await createCustomerIdentity({
      fixtureKey: 'source-time-mismatch',
    });
    const command = customerCommand({
      eventId,
      fixtureKey: 'source-time-mismatch',
      identity,
      sourceAt: new Date('2026-08-11T12:00:00.001Z'),
    });

    await expect(
      new PostgresConsentPolicy(pool).recordCustomerCommand(command),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });
    expect((await readConsentMutationState()).rows).toEqual([{ audits: null, consent: null }]);
  });

  test('consent audits exclude wording, message text, raw identity, and reviewer authorization', async () => {
    const identity: ChannelIdentitySelector = {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_audit_privacy',
      externalContactId: 'PSID_TEST_audit_privacy',
    };
    await createCustomerIdentity({ fixtureKey: 'audit-privacy', identity });
    const privatePrincipal = {
      reviewerRef: 'reviewer-opaque-audit-privacy',
      roles: ['support_reviewer', 'synthetic_private_role'],
    } as const;
    const policy = new PostgresConsentPolicy(pool);
    await policy.recordReviewerCommand(
      {
        ...reviewerCommand({
          fixtureKey: 'audit-privacy',
          identity,
          sourceAt: new Date('2026-08-11T19:10:00.000Z'),
        }),
        wording: 'Synthetic approved wording excluded from audit',
      },
      privatePrincipal,
    );
    await policy.evaluateMarketingEligibility(
      identity,
      'security_updates',
      new Date('2026-08-11T19:11:00.000Z'),
    );

    const audits = await pool.query<{ readonly audit: unknown }>(
      `select to_jsonb(audit) as audit
       from policy_audit_outcomes as audit
       where decision_type in ('consent_record', 'marketing_eligibility')
       order by id`,
    );
    expect(audits.rows).toHaveLength(2);
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain('Synthetic approved wording excluded from audit');
    expect(serialized).not.toContain('Synthetic consent source text');
    expect(serialized).not.toContain(identity.channelAccountId);
    expect(serialized).not.toContain(identity.externalContactId);
    expect(serialized).not.toContain(privatePrincipal.reviewerRef);
    expect(serialized).not.toContain('synthetic_private_role');
    expect(serialized).not.toContain('authorization');
  });

  test('audit insertion failure rolls back the consent row', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'audit-rollback' });
    await pool.query(
      `create function synthetic_reject_consent_audit()
       returns trigger language plpgsql as $$
       begin
         if new.decision_type = 'consent_record' then
           raise exception using errcode = 'P0001', message = 'synthetic consent audit rejection';
         end if;
         return new;
       end;
       $$;
       create trigger synthetic_reject_consent_audit
         before insert on policy_audit_outcomes
         for each row execute function synthetic_reject_consent_audit()`,
    );
    try {
      await expect(
        new PostgresConsentPolicy(pool).recordReviewerCommand(
          reviewerCommand({
            fixtureKey: 'audit-rollback',
            identity,
            sourceAt: new Date('2026-08-11T19:00:00.000Z'),
          }),
          supportReviewer,
        ),
      ).rejects.toThrow('synthetic consent audit rejection');
    } finally {
      await pool.query(
        `drop trigger if exists synthetic_reject_consent_audit on policy_audit_outcomes;
         drop function if exists synthetic_reject_consent_audit()`,
      );
    }
    expect((await readConsentMutationState()).rows).toEqual([{ audits: null, consent: null }]);
  });
});

describe('PostgresConsentPolicy marketing eligibility', () => {
  test('grants only the exact identity, channel, account, and category with bounded audits', async () => {
    const sourceAt = new Date('2026-08-11T15:00:00.000Z');
    const identity: ChannelIdentitySelector = {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_exact_scope',
      externalContactId: 'CONTACT_TEST_exact_scope',
    };
    const { eventId } = await createCustomerIdentity({
      fixtureKey: 'exact-scope-source',
      identity,
      occurredAt: sourceAt,
    });
    const otherAccountIdentity: ChannelIdentitySelector = {
      ...identity,
      channelAccountId: 'PHONE_TEST_other_account',
    };
    await createCustomerIdentity({ fixtureKey: 'other-account', identity: otherAccountIdentity });
    const policy = new PostgresConsentPolicy(pool);
    await policy.recordCustomerCommand(
      customerCommand({ eventId, fixtureKey: 'exact-scope', identity, sourceAt }),
    );

    await expect(
      policy.evaluateMarketingEligibility(
        identity,
        'security_updates',
        new Date('2026-08-11T15:05:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
    await expect(
      policy.evaluateMarketingEligibility(
        identity,
        'product_offers',
        new Date('2026-08-11T15:06:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'consent_missing' });
    await expect(
      policy.evaluateMarketingEligibility(
        otherAccountIdentity,
        'security_updates',
        new Date('2026-08-11T15:07:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'consent_missing' });
    await expect(
      policy.evaluateMarketingEligibility(
        { ...identity, channel: 'messenger' },
        'security_updates',
        new Date('2026-08-11T15:08:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'identity_not_found' });

    const audits = await pool.query(
      `select outcome, reason_code, evaluated_at,
              channel_identity_id is not null as has_internal_identity,
              conversation_id, related_webhook_event_id
       from policy_audit_outcomes
       where decision_type = 'marketing_eligibility'
       order by evaluated_at`,
    );
    expect(audits.rows).toEqual([
      {
        outcome: 'allowed',
        reason_code: 'consent_latest_grant',
        evaluated_at: new Date('2026-08-11T15:05:00.000Z'),
        has_internal_identity: true,
        conversation_id: null,
        related_webhook_event_id: null,
      },
      {
        outcome: 'denied',
        reason_code: 'consent_missing',
        evaluated_at: new Date('2026-08-11T15:06:00.000Z'),
        has_internal_identity: true,
        conversation_id: null,
        related_webhook_event_id: null,
      },
      {
        outcome: 'denied',
        reason_code: 'consent_missing',
        evaluated_at: new Date('2026-08-11T15:07:00.000Z'),
        has_internal_identity: true,
        conversation_id: null,
        related_webhook_event_id: null,
      },
      {
        outcome: 'denied',
        reason_code: 'identity_not_found',
        evaluated_at: new Date('2026-08-11T15:08:00.000Z'),
        has_internal_identity: false,
        conversation_id: null,
        related_webhook_event_id: null,
      },
    ]);
  });

  test('does not share consent with another contact under the same channel account', async () => {
    const channelAccountId = 'PAGE_TEST_external_contact_scope';
    const grantedIdentity: ChannelIdentitySelector = {
      channel: 'messenger',
      channelAccountId,
      externalContactId: 'PSID_TEST_external_contact_granted',
    };
    const otherIdentity: ChannelIdentitySelector = {
      ...grantedIdentity,
      externalContactId: 'PSID_TEST_external_contact_other',
    };
    const sourceAt = new Date('2026-08-11T15:20:00.000Z');
    const { eventId } = await createCustomerIdentity({
      fixtureKey: 'external-contact-granted',
      identity: grantedIdentity,
      occurredAt: sourceAt,
    });
    await createCustomerIdentity({
      fixtureKey: 'external-contact-other',
      identity: otherIdentity,
      occurredAt: sourceAt,
    });
    const policy = new PostgresConsentPolicy(pool);
    await policy.recordCustomerCommand(
      customerCommand({
        eventId,
        fixtureKey: 'external-contact-granted',
        identity: grantedIdentity,
        sourceAt,
      }),
    );

    await expect(
      policy.evaluateMarketingEligibility(
        grantedIdentity,
        'security_updates',
        new Date('2026-08-11T15:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
    await expect(
      policy.evaluateMarketingEligibility(
        otherIdentity,
        'security_updates',
        new Date('2026-08-11T15:22:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'consent_missing' });
  });

  test.each([
    [
      'an invalid selector channel',
      { channel: 'email', channelAccountId: 'ACCOUNT_TEST', externalContactId: 'CONTACT_TEST' },
      'security_updates',
      new Date('2026-08-11T15:00:00.000Z'),
      TypeError,
    ],
    [
      'a blank channel account',
      { channel: 'messenger', channelAccountId: '   ', externalContactId: 'CONTACT_TEST' },
      'security_updates',
      new Date('2026-08-11T15:00:00.000Z'),
      TypeError,
    ],
    [
      'an invalid evaluation time',
      { channel: 'messenger', channelAccountId: 'ACCOUNT_TEST', externalContactId: 'CONTACT_TEST' },
      'security_updates',
      new Date(Number.NaN),
      TypeError,
    ],
  ] as const)(
    'rejects %s before database access',
    async (_reason, identity, category, evaluatedAt, errorType) => {
      const unavailablePool = new pg.Pool({
        connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
        connectionTimeoutMillis: 100,
        max: 1,
      });
      try {
        await expect(
          new PostgresConsentPolicy(unavailablePool).evaluateMarketingEligibility(
            identity as ChannelIdentitySelector,
            category,
            evaluatedAt,
          ),
        ).rejects.toBeInstanceOf(errorType);
      } finally {
        await unavailablePool.end();
      }
    },
  );

  test('denies an invalid category without broadening to valid consent', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'invalid-category' });
    await new PostgresConsentPolicy(pool).recordReviewerCommand(
      reviewerCommand({
        fixtureKey: 'invalid-category',
        identity,
        sourceAt: new Date('2026-08-11T15:00:00.000Z'),
      }),
      supportReviewer,
    );

    await expect(
      new PostgresConsentPolicy(pool).evaluateMarketingEligibility(
        identity,
        'Security Updates',
        new Date('2026-08-11T15:05:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'consent_missing' });
  });

  test('applies revoke and later re-grant immediately', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'revoke-regrant' });
    const policy = new PostgresConsentPolicy(pool);
    const grant = reviewerCommand({
      fixtureKey: 'grant-first',
      identity,
      sourceAt: new Date('2026-08-11T16:00:00.000Z'),
    });
    await policy.recordReviewerCommand(grant, supportReviewer);
    await policy.recordReviewerCommand(
      {
        ...grant,
        action: 'revoke',
        sourceAt: new Date('2026-08-11T16:01:00.000Z'),
        idempotencyKey: 'synthetic-reviewer-consent-revoke',
      },
      supportReviewer,
    );
    await expect(
      policy.evaluateMarketingEligibility(
        identity,
        'security_updates',
        new Date('2026-08-11T16:01:01.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'consent_latest_revoke' });

    await policy.recordReviewerCommand(
      {
        ...grant,
        sourceAt: new Date('2026-08-11T16:02:00.000Z'),
        idempotencyKey: 'synthetic-reviewer-consent-regrant',
      },
      supportReviewer,
    );
    await expect(
      policy.evaluateMarketingEligibility(
        identity,
        'security_updates',
        new Date('2026-08-11T16:02:01.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
  });

  test('uses higher database ID for equal source times and ignores older late inserts', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'ordering' });
    const policy = new PostgresConsentPolicy(pool);
    const tiedAt = new Date('2026-08-11T17:00:00.000Z');
    await policy.recordReviewerCommand(
      reviewerCommand({ fixtureKey: 'tie-grant', identity, sourceAt: tiedAt }),
      supportReviewer,
    );
    await policy.recordReviewerCommand(
      reviewerCommand({ action: 'revoke', fixtureKey: 'tie-revoke', identity, sourceAt: tiedAt }),
      supportReviewer,
    );
    await expect(
      policy.evaluateMarketingEligibility(
        identity,
        'security_updates',
        new Date('2026-08-11T17:01:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'consent_latest_revoke' });

    await policy.recordReviewerCommand(
      reviewerCommand({
        fixtureKey: 'newer-grant',
        identity,
        sourceAt: new Date('2026-08-11T17:02:00.000Z'),
      }),
      supportReviewer,
    );
    await policy.recordReviewerCommand(
      reviewerCommand({
        action: 'revoke',
        fixtureKey: 'older-late-revoke',
        identity,
        sourceAt: new Date('2026-08-11T17:01:30.000Z'),
      }),
      supportReviewer,
    );
    await expect(
      policy.evaluateMarketingEligibility(
        identity,
        'security_updates',
        new Date('2026-08-11T17:03:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
  });

  test('preserves PostgreSQL microsecond source-time ordering', async () => {
    const { identity } = await createCustomerIdentity({ fixtureKey: 'microsecond-ordering' });
    const identityId = await identityDatabaseId(identity);
    await pool.query(
      `insert into consent_events
         (channel_identity_id, category, action, wording, wording_version,
          source, source_at, idempotency_key)
       values
         ($1, 'security_updates', 'revoke', 'Synthetic microsecond revoke', 'v1',
          'reviewer_recorded', '2026-08-11T18:00:00.000001Z', 'synthetic-microsecond-revoke'),
         ($1, 'security_updates', 'grant', 'Synthetic microsecond grant', 'v1',
          'reviewer_recorded', '2026-08-11T18:00:00.000002Z', 'synthetic-microsecond-grant')`,
      [identityId],
    );

    await expect(
      new PostgresConsentPolicy(pool).evaluateMarketingEligibility(
        identity,
        'security_updates',
        new Date('2026-08-11T18:01:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
  });
});
