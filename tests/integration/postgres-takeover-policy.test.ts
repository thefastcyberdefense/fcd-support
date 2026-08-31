import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresTakeoverPolicy } from '../../src/persistence/postgres-takeover-policy.js';
import { insertSyntheticPendingEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let databaseConnectionString: string;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_takeover_policy',
  );
  databaseConnectionString = database.connectionString;
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
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

const supportReviewer = {
  reviewerRef: 'reviewer-opaque-42',
  roles: ['incident_reader', 'support_reviewer'],
} as const;

async function createPausedConversation(fixtureKey: string, echoOccurredAt: Date) {
  const echoEventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${fixtureKey}`,
    contactId: `PSID_TEST_${fixtureKey}`,
    eventKind: 'business_message_echo',
    fixtureKey: `${fixtureKey}-echo`,
    messageText: 'Synthetic reviewer echo excluded from takeover history',
    occurredAt: echoOccurredAt,
  });
  const processed = await new PostgresConversationEventProcessor(pool).processEvent(echoEventId);
  if (processed.status !== 'applied' || processed.conversationId === undefined) {
    throw new Error('Synthetic echo did not create a paused conversation');
  }

  return { conversationId: processed.conversationId, echoEventId };
}

async function readTakeoverMutationState() {
  return pool.query(
    `select
       (select jsonb_agg(to_jsonb(conversations) order by id) from conversations) as conversations,
       (select jsonb_agg(to_jsonb(human_pause_events) order by id) from human_pause_events) as history,
       (select jsonb_agg(to_jsonb(policy_audit_outcomes) order by id) from policy_audit_outcomes) as audits`,
  );
}

async function createConversationSeed(fixtureKey: string): Promise<string> {
  const customerEventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${fixtureKey}`,
    contactId: `PSID_TEST_${fixtureKey}`,
    eventKind: 'customer_message',
    fixtureKey: `${fixtureKey}-customer`,
    messageText: 'Synthetic conversation seed excluded from takeover state',
    occurredAt: new Date('2026-08-11T10:00:00.000Z'),
  });
  const processed = await new PostgresConversationEventProcessor(pool).processEvent(
    customerEventId,
  );
  if (processed.status !== 'applied' || processed.conversationId === undefined) {
    throw new Error('Synthetic customer event did not create a conversation');
  }
  return processed.conversationId;
}

async function insertProviderPrecisionEcho(
  fixtureKey: string,
  occurredAt: string,
): Promise<string> {
  const eventId = await insertSyntheticPendingEvent(pool, {
    channel: 'messenger',
    channelAccountId: `PAGE_TEST_${fixtureKey}`,
    contactId: `PSID_TEST_${fixtureKey}`,
    eventKind: 'business_message_echo',
    fixtureKey: `${fixtureKey}-echo`,
    messageText: 'Synthetic precision echo excluded from takeover state',
    occurredAt: new Date(occurredAt),
  });
  await pool.query(`update webhook_events set occurred_at = $2::timestamptz where id = $1`, [
    eventId,
    occurredAt,
  ]);
  return eventId;
}

async function waitForDatabaseLockWaiter(applicationName: string): Promise<void> {
  const deadline = performance.now() + 250;
  let observedWaiting = 0;

  while (performance.now() < deadline) {
    const activity = await pool.query<{ readonly waiting: number }>(
      `select count(*) filter (
         where state = 'active' and wait_event_type = 'Lock'
       )::int as waiting
       from pg_stat_activity
       where application_name = $1`,
      [applicationName],
    );
    observedWaiting = activity.rows[0]?.waiting ?? 0;
    if (observedWaiting === 1) {
      return;
    }
  }

  throw new Error(
    `Synthetic lock barrier observed ${String(observedWaiting)} waiting transaction(s)`,
  );
}

type RaceOperation = 'echo' | 'resume';

async function runTimestampOrderedRace(input: {
  readonly echoOccurredAt: string;
  readonly firstCommit: RaceOperation;
  readonly fixtureKey: string;
  readonly resumeAt: Date;
}) {
  const conversationId = await createConversationSeed(input.fixtureKey);
  const echoEventId = await insertProviderPrecisionEcho(input.fixtureKey, input.echoOccurredAt);
  const firstApplicationName = `takeover_${input.fixtureKey}_first`;
  const secondApplicationName = `takeover_${input.fixtureKey}_second`;
  const firstPool = new pg.Pool({
    application_name: firstApplicationName,
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const secondPool = new pg.Pool({
    application_name: secondApplicationName,
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const holder = await pool.connect();
  let holderTransactionOpen = false;
  let firstPromise: Promise<unknown> | undefined;
  let secondPromise: Promise<unknown> | undefined;
  const startOperation = (operation: RaceOperation, operationPool: pg.Pool) =>
    operation === 'resume'
      ? new PostgresTakeoverPolicy(operationPool).resume(
          {
            conversationId,
            effectiveAt: input.resumeAt,
            requestKey: `resume-${input.fixtureKey}`,
          },
          supportReviewer,
        )
      : new PostgresConversationEventProcessor(operationPool).processEvent(echoEventId);

  try {
    await holder.query('begin');
    holderTransactionOpen = true;
    await holder.query(`select id from conversations where id = $1 for update`, [conversationId]);
    const heldAt = performance.now();

    firstPromise = startOperation(input.firstCommit, firstPool);
    await waitForDatabaseLockWaiter(firstApplicationName);
    const secondOperation = input.firstCommit === 'resume' ? 'echo' : 'resume';
    secondPromise = startOperation(secondOperation, secondPool);
    await waitForDatabaseLockWaiter(secondApplicationName);

    await holder.query('commit');
    holderTransactionOpen = false;
    const heldForMilliseconds = performance.now() - heldAt;
    expect(heldForMilliseconds).toBeLessThan(650);
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    return {
      conversationId,
      echoResult: input.firstCommit === 'echo' ? firstResult : secondResult,
      resumeResult: input.firstCommit === 'resume' ? firstResult : secondResult,
    };
  } finally {
    if (holderTransactionOpen) {
      await holder.query('rollback');
    }
    holder.release();
    await Promise.allSettled(
      [firstPromise, secondPromise].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ),
    );
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
}

interface ConcurrentResumeAttempt {
  readonly conversationId: string;
  readonly effectiveAt: Date;
  readonly principal: unknown;
  readonly requestKey: string;
}

function captureSettlement<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
  return operation.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ reason, status: 'rejected' }),
  );
}

async function runConcurrentResumeKeyRace(input: {
  readonly first: ConcurrentResumeAttempt;
  readonly fixtureKey: string;
  readonly second: ConcurrentResumeAttempt;
}) {
  const firstApplicationName = `takeover_${input.fixtureKey}_first`;
  const secondApplicationName = `takeover_${input.fixtureKey}_second`;
  const firstPool = new pg.Pool({
    application_name: firstApplicationName,
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const secondPool = new pg.Pool({
    application_name: secondApplicationName,
    connectionString: databaseConnectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  const holder = await pool.connect();
  let holderTransactionOpen = false;
  let firstPromise: Promise<PromiseSettledResult<unknown>> | undefined;
  let secondPromise: Promise<PromiseSettledResult<unknown>> | undefined;
  const startResume = (attempt: ConcurrentResumeAttempt, operationPool: pg.Pool) =>
    captureSettlement(
      new PostgresTakeoverPolicy(operationPool).resume(
        {
          conversationId: attempt.conversationId,
          effectiveAt: attempt.effectiveAt,
          requestKey: attempt.requestKey,
        },
        attempt.principal,
      ),
    );

  try {
    await holder.query('begin');
    holderTransactionOpen = true;
    await holder.query(`select id from conversations where id = $1 for update`, [
      input.first.conversationId,
    ]);
    const heldAt = performance.now();

    firstPromise = startResume(input.first, firstPool);
    await waitForDatabaseLockWaiter(firstApplicationName);
    secondPromise = startResume(input.second, secondPool);
    await waitForDatabaseLockWaiter(secondApplicationName);

    await holder.query('commit');
    holderTransactionOpen = false;
    expect(performance.now() - heldAt).toBeLessThan(650);

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    return { firstResult, secondResult };
  } finally {
    if (holderTransactionOpen) {
      await holder.query('rollback');
    }
    holder.release();
    await Promise.all(
      [firstPromise, secondPromise].filter(
        (operation): operation is Promise<PromiseSettledResult<unknown>> => operation !== undefined,
      ),
    );
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
}

describe('PostgresTakeoverPolicy', () => {
  test('denies replies strictly before the 24-hour pause deadline and allows them at equality', async () => {
    const echoOccurredAt = new Date('2026-08-11T03:00:00.000Z');
    const echoEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_takeover_boundary',
      contactId: 'PSID_TEST_takeover_boundary',
      eventKind: 'business_message_echo',
      fixtureKey: 'takeover-boundary',
      messageText: 'Synthetic reviewer echo',
      occurredAt: echoOccurredAt,
    });
    const processed = await new PostgresConversationEventProcessor(pool).processEvent(echoEventId);
    if (processed.status !== 'applied' || processed.conversationId === undefined) {
      throw new Error('Synthetic echo did not create a paused conversation');
    }
    const deadline = new Date('2026-08-12T03:00:00.000Z');

    const stored = await pool.query<{ readonly ai_paused_until: Date }>(
      `select ai_paused_until from conversations where id = $1`,
      [processed.conversationId],
    );
    expect(stored.rows).toEqual([{ ai_paused_until: deadline }]);

    const policy = new PostgresTakeoverPolicy(pool);
    await expect(
      policy.evaluateReplyEligibility(
        processed.conversationId,
        new Date('2026-08-12T02:59:59.999Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'pause_active' });
    await expect(
      policy.evaluateReplyEligibility(processed.conversationId, deadline),
    ).resolves.toEqual({ eligible: true, reason: 'pause_inactive' });
    await expect(
      policy.evaluateReplyEligibility(
        processed.conversationId,
        new Date('2026-08-12T03:00:00.001Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'pause_inactive' });

    const audit = await pool.query(
      `select outcome, reason_code, evaluated_at
       from policy_audit_outcomes
       where conversation_id = $1
         and decision_type = 'reply_eligibility'
       order by evaluated_at`,
      [processed.conversationId],
    );
    expect(audit.rows).toEqual([
      {
        evaluated_at: new Date('2026-08-12T02:59:59.999Z'),
        outcome: 'denied',
        reason_code: 'pause_active',
      },
      { evaluated_at: deadline, outcome: 'allowed', reason_code: 'pause_inactive' },
      {
        evaluated_at: new Date('2026-08-12T03:00:00.001Z'),
        outcome: 'allowed',
        reason_code: 'pause_inactive',
      },
    ]);
  });

  test.each([
    ['a non-decimal conversation identifier', 'not-decimal', new Date('2026-08-11T03:00:00Z')],
    ['an invalid evaluation date', '1', new Date(Number.NaN)],
  ])('rejects %s before evaluating eligibility', async (_reason, conversationId, evaluatedAt) => {
    const unavailablePool = new pg.Pool({
      connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
      connectionTimeoutMillis: 100,
      max: 1,
    });
    try {
      await expect(
        new PostgresTakeoverPolicy(unavailablePool).evaluateReplyEligibility(
          conversationId,
          evaluatedAt,
        ),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      await unavailablePool.end();
    }
  });

  test('allows a conversation with no pause and records only bounded audit outcomes', async () => {
    const customerEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_takeover_unpaused',
      contactId: 'CONTACT_TEST_takeover_unpaused',
      eventKind: 'customer_message',
      fixtureKey: 'takeover-unpaused',
      messageText: 'Synthetic customer message excluded from policy audit',
      occurredAt: new Date('2026-08-11T04:00:00.000Z'),
    });
    const processed = await new PostgresConversationEventProcessor(pool).processEvent(
      customerEventId,
    );
    if (processed.status !== 'applied' || processed.conversationId === undefined) {
      throw new Error('Synthetic customer message did not create a conversation');
    }
    const evaluatedAt = new Date('2026-08-11T04:30:00.000Z');

    await expect(
      new PostgresTakeoverPolicy(pool).evaluateReplyEligibility(
        processed.conversationId,
        evaluatedAt,
      ),
    ).resolves.toEqual({ eligible: true, reason: 'pause_inactive' });

    const audit = await pool.query(
      `select decision_type, outcome, reason_code, conversation_id,
              channel_identity_id, related_webhook_event_id, evaluated_at
       from policy_audit_outcomes
       where decision_type = 'reply_eligibility'`,
    );
    expect(audit.rows).toEqual([
      {
        channel_identity_id: null,
        conversation_id: processed.conversationId,
        decision_type: 'reply_eligibility',
        evaluated_at: evaluatedAt,
        outcome: 'allowed',
        reason_code: 'pause_inactive',
        related_webhook_event_id: null,
      },
    ]);
  });

  test('rejects an unknown conversation without appending an eligibility audit', async () => {
    await expect(
      new PostgresTakeoverPolicy(pool).evaluateReplyEligibility(
        '999999999',
        new Date('2026-08-11T05:00:00.000Z'),
      ),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });

    const audits = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from policy_audit_outcomes`,
    );
    expect(audits.rows).toEqual([{ count: 0 }]);
  });

  test('rejects a missing support reviewer role before database access and without mutation', async () => {
    const { conversationId } = await createPausedConversation(
      'resume-unauthorized',
      new Date('2026-08-11T06:00:00.000Z'),
    );
    const before = await readTakeoverMutationState();
    const unavailablePool = new pg.Pool({
      connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
      connectionTimeoutMillis: 100,
      max: 1,
    });

    try {
      await expect(
        new PostgresTakeoverPolicy(unavailablePool).resume(
          {
            conversationId,
            effectiveAt: new Date('2026-08-11T06:30:00.000Z'),
            requestKey: 'resume-unauthorized',
          },
          { reviewerRef: 'reviewer-opaque-denied', roles: ['incident_reader'] },
        ),
      ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    } finally {
      await unavailablePool.end();
    }

    await expect(
      new PostgresTakeoverPolicy(pool).resume(
        {
          conversationId,
          effectiveAt: new Date('2026-08-11T06:30:00.000Z'),
          requestKey: 'resume-unauthorized',
        },
        { reviewerRef: 'reviewer-opaque-denied', roles: ['incident_reader'] },
      ),
    ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    const after = await readTakeoverMutationState();
    expect(after.rows).toEqual(before.rows);
  });

  test('authorized resume clears the pause and stores only the opaque reviewer reference', async () => {
    const { conversationId } = await createPausedConversation(
      'resume-applied',
      new Date('2026-08-11T07:00:00.000Z'),
    );
    const effectiveAt = new Date('2026-08-11T07:30:00.000Z');

    await expect(
      new PostgresTakeoverPolicy(pool).resume(
        { conversationId, effectiveAt, requestKey: '  resume-applied  ' },
        { reviewerRef: '  reviewer-opaque-42  ', roles: supportReviewer.roles },
      ),
    ).resolves.toEqual({ aiPausedUntil: null, conversationId, status: 'applied' });

    const state = await pool.query(
      `select conversations.ai_paused_until, conversations.last_authorized_resume_at,
              conversations.row_version, history.action, history.effective_at,
              history.resulting_pause_until, history.actor_kind,
              history.reviewer_reference, history.reviewer_request_key,
              audit.decision_type, audit.outcome, audit.reason_code,
              audit.channel_identity_id, audit.related_webhook_event_id
       from conversations
       join human_pause_events as history
         on history.conversation_id = conversations.id and history.action = 'resume'
       join policy_audit_outcomes as audit
         on audit.conversation_id = conversations.id
        and audit.decision_type = 'authorized_resume'
       where conversations.id = $1`,
      [conversationId],
    );
    expect(state.rows).toEqual([
      {
        action: 'resume',
        actor_kind: 'reviewer',
        ai_paused_until: null,
        channel_identity_id: null,
        decision_type: 'authorized_resume',
        effective_at: effectiveAt,
        last_authorized_resume_at: effectiveAt,
        outcome: 'applied',
        reason_code: 'resume_applied',
        related_webhook_event_id: null,
        resulting_pause_until: null,
        reviewer_reference: 'reviewer-opaque-42',
        reviewer_request_key: 'resume-applied',
        row_version: '3',
      },
    ]);
    expect(JSON.stringify(state.rows)).not.toContain('incident_reader');
    expect(JSON.stringify(state.rows)).not.toContain('support_reviewer');
    expect(JSON.stringify(state.rows)).not.toContain('credential');

    const boundedAudit = await pool.query(
      `select to_jsonb(audit) as audit
       from policy_audit_outcomes as audit
       where audit.conversation_id = $1
         and audit.decision_type = 'authorized_resume'`,
      [conversationId],
    );
    const auditJson = JSON.stringify(boundedAudit.rows);
    expect(auditJson).not.toContain('reviewer-opaque-42');
    expect(auditJson).not.toContain('Synthetic reviewer echo');
    expect(auditJson).not.toContain('PSID_TEST_resume-applied');
  });

  test('exact resume replay returns duplicate without a second history or audit mutation', async () => {
    const { conversationId } = await createPausedConversation(
      'resume-duplicate',
      new Date('2026-08-11T08:00:00.000Z'),
    );
    const policy = new PostgresTakeoverPolicy(pool);
    const input = {
      conversationId,
      effectiveAt: new Date('2026-08-11T08:30:00.000Z'),
      requestKey: 'resume-duplicate',
    };

    await expect(policy.resume(input, supportReviewer)).resolves.toEqual({
      aiPausedUntil: null,
      conversationId,
      status: 'applied',
    });
    const afterApplied = await readTakeoverMutationState();

    await expect(policy.resume(input, supportReviewer)).resolves.toEqual({
      aiPausedUntil: null,
      conversationId,
      status: 'duplicate',
    });
    const afterDuplicate = await readTakeoverMutationState();
    expect(afterDuplicate.rows).toEqual(afterApplied.rows);
  });

  test('classifies concurrent exact normalized request-key material as applied then duplicate', async () => {
    const { conversationId } = await createPausedConversation(
      'resume-concurrent-exact',
      new Date('2026-08-11T08:40:00.000Z'),
    );
    const effectiveAt = new Date('2026-08-11T09:00:00.000Z');
    const raced = await runConcurrentResumeKeyRace({
      first: {
        conversationId,
        effectiveAt,
        principal: {
          reviewerRef: '  reviewer-opaque-42  ',
          roles: supportReviewer.roles,
        },
        requestKey: '  resume-concurrent-exact  ',
      },
      fixtureKey: 'resume_key_exact',
      second: {
        conversationId,
        effectiveAt,
        principal: supportReviewer,
        requestKey: 'resume-concurrent-exact',
      },
    });

    expect(raced.firstResult).toEqual({
      status: 'fulfilled',
      value: { aiPausedUntil: null, conversationId, status: 'applied' },
    });
    expect(raced.secondResult).toEqual({
      status: 'fulfilled',
      value: { aiPausedUntil: null, conversationId, status: 'duplicate' },
    });

    const state = await pool.query(
      `select conversations.ai_paused_until, conversations.last_authorized_resume_at,
              conversations.row_version,
              (select count(*)::int from human_pause_events as history
               where history.conversation_id = conversations.id
                 and history.action = 'resume') as resumes,
              (select min(reviewer_reference) from human_pause_events as history
               where history.conversation_id = conversations.id
                 and history.action = 'resume') as reviewer_reference,
              (select min(reviewer_request_key) from human_pause_events as history
               where history.conversation_id = conversations.id
                 and history.action = 'resume') as reviewer_request_key,
              (select count(*)::int from policy_audit_outcomes as audit
               where audit.conversation_id = conversations.id
                 and audit.decision_type = 'authorized_resume') as audits
       from conversations
       where conversations.id = $1`,
      [conversationId],
    );
    expect(state.rows).toEqual([
      {
        ai_paused_until: null,
        audits: 1,
        last_authorized_resume_at: effectiveAt,
        resumes: 1,
        reviewer_reference: 'reviewer-opaque-42',
        reviewer_request_key: 'resume-concurrent-exact',
        row_version: '3',
      },
    ]);
  });

  test.each(['conversation', 'reviewer', 'effective timestamp'] as const)(
    'classifies concurrent normalized request-key reuse with a different %s as a policy conflict',
    async (changedMaterial) => {
      const fixtureKey = changedMaterial.replace(' ', '-');
      const first = await createPausedConversation(
        `resume-concurrent-conflict-${fixtureKey}-first`,
        new Date('2026-08-11T09:10:00.000Z'),
      );
      const second = await createPausedConversation(
        `resume-concurrent-conflict-${fixtureKey}-second`,
        new Date('2026-08-11T09:15:00.000Z'),
      );
      const firstEffectiveAt = new Date('2026-08-11T09:30:00.000Z');
      const normalizedRequestKey = `resume-concurrent-conflict-${fixtureKey}`;
      const raced = await runConcurrentResumeKeyRace({
        first: {
          conversationId: first.conversationId,
          effectiveAt: firstEffectiveAt,
          principal: supportReviewer,
          requestKey: `  ${normalizedRequestKey}  `,
        },
        fixtureKey: `resume_key_conflict_${fixtureKey}`,
        second: {
          conversationId:
            changedMaterial === 'conversation' ? second.conversationId : first.conversationId,
          effectiveAt:
            changedMaterial === 'effective timestamp'
              ? new Date('2026-08-11T09:30:00.001Z')
              : firstEffectiveAt,
          principal:
            changedMaterial === 'reviewer'
              ? { reviewerRef: 'reviewer-opaque-other', roles: ['support_reviewer'] }
              : { reviewerRef: '  reviewer-opaque-42  ', roles: supportReviewer.roles },
          requestKey: normalizedRequestKey,
        },
      });

      expect(raced.firstResult).toEqual({
        status: 'fulfilled',
        value: {
          aiPausedUntil: null,
          conversationId: first.conversationId,
          status: 'applied',
        },
      });
      expect(raced.secondResult.status).toBe('rejected');
      if (raced.secondResult.status !== 'rejected') {
        throw new Error('Synthetic conflicting resume unexpectedly fulfilled');
      }
      expect(raced.secondResult.reason).toMatchObject({
        name: 'PolicyIdempotencyConflictError',
      });
      expect(raced.secondResult.reason).not.toMatchObject({ code: '23505' });

      const mutations = await pool.query(
        `select
           (select count(*)::int from human_pause_events
            where action = 'resume' and reviewer_request_key = $1) as resumes,
           (select min(conversation_id)::text from human_pause_events
            where action = 'resume' and reviewer_request_key = $1) as resumed_conversation_id,
           (select count(*)::int from policy_audit_outcomes
            where decision_type = 'authorized_resume') as audits`,
        [normalizedRequestKey],
      );
      expect(mutations.rows).toEqual([
        { audits: 1, resumed_conversation_id: first.conversationId, resumes: 1 },
      ]);

      const conversations = await pool.query(
        `select id, ai_paused_until, last_authorized_resume_at, row_version
         from conversations
         where id = any($1::bigint[])
         order by id`,
        [[first.conversationId, second.conversationId]],
      );
      expect(conversations.rows).toEqual([
        {
          ai_paused_until: null,
          id: first.conversationId,
          last_authorized_resume_at: firstEffectiveAt,
          row_version: '3',
        },
        {
          ai_paused_until: new Date('2026-08-12T09:15:00.000Z'),
          id: second.conversationId,
          last_authorized_resume_at: null,
          row_version: '2',
        },
      ]);
    },
  );

  test.each(['conversation', 'reviewer', 'effective timestamp'] as const)(
    'rejects request-key reuse with a different %s without mutation',
    async (changedMaterial) => {
      const first = await createPausedConversation(
        `resume-conflict-${changedMaterial}-first`,
        new Date('2026-08-11T09:00:00.000Z'),
      );
      const second = await createPausedConversation(
        `resume-conflict-${changedMaterial}-second`,
        new Date('2026-08-11T09:05:00.000Z'),
      );
      const policy = new PostgresTakeoverPolicy(pool);
      const input = {
        conversationId: first.conversationId,
        effectiveAt: new Date('2026-08-11T09:30:00.000Z'),
        requestKey: `resume-conflict-${changedMaterial}`,
      };
      await policy.resume(input, supportReviewer);
      const beforeConflict = await readTakeoverMutationState();

      const conflictingInput = {
        ...input,
        conversationId:
          changedMaterial === 'conversation' ? second.conversationId : input.conversationId,
        effectiveAt:
          changedMaterial === 'effective timestamp'
            ? new Date('2026-08-11T09:30:00.001Z')
            : input.effectiveAt,
      };
      const conflictingPrincipal =
        changedMaterial === 'reviewer'
          ? { reviewerRef: 'reviewer-opaque-other', roles: ['support_reviewer'] }
          : supportReviewer;

      await expect(policy.resume(conflictingInput, conflictingPrincipal)).rejects.toMatchObject({
        name: 'PolicyIdempotencyConflictError',
      });
      const afterConflict = await readTakeoverMutationState();
      expect(afterConflict.rows).toEqual(beforeConflict.rows);
    },
  );

  test.each([
    ['a blank request key', '   '],
    ['a request key over 128 characters', 'r'.repeat(129)],
  ])('rejects %s before database access', async (_reason, requestKey) => {
    const unavailablePool = new pg.Pool({
      connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
      connectionTimeoutMillis: 100,
      max: 1,
    });
    try {
      await expect(
        new PostgresTakeoverPolicy(unavailablePool).resume(
          {
            conversationId: '1',
            effectiveAt: new Date('2026-08-11T10:00:00.000Z'),
            requestKey,
          },
          supportReviewer,
        ),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      await unavailablePool.end();
    }
  });

  test.each([
    ['a non-decimal conversation identifier', 'not-decimal', new Date('2026-08-11T10:00:00Z')],
    ['an invalid effective date', '1', new Date(Number.NaN)],
  ])(
    'rejects resume with %s before database access',
    async (_reason, conversationId, effectiveAt) => {
      const unavailablePool = new pg.Pool({
        connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
        connectionTimeoutMillis: 100,
        max: 1,
      });
      try {
        await expect(
          new PostgresTakeoverPolicy(unavailablePool).resume(
            { conversationId, effectiveAt, requestKey: 'resume-invalid-material' },
            supportReviewer,
          ),
        ).rejects.toBeInstanceOf(TypeError);
      } finally {
        await unavailablePool.end();
      }
    },
  );

  test('rejects resume for an unknown conversation without mutation', async () => {
    const before = await readTakeoverMutationState();

    await expect(
      new PostgresTakeoverPolicy(pool).resume(
        {
          conversationId: '999999999',
          effectiveAt: new Date('2026-08-11T10:00:00.000Z'),
          requestKey: 'resume-unknown-conversation',
        },
        supportReviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyRecordNotFoundError' });

    const after = await readTakeoverMutationState();
    expect(after.rows).toEqual(before.rows);
  });

  test('keeps the greatest authorized resume cutoff when a distinct older request arrives later', async () => {
    const { conversationId } = await createPausedConversation(
      'resume-greatest-cutoff',
      new Date('2026-08-11T11:00:00.000Z'),
    );
    const policy = new PostgresTakeoverPolicy(pool);
    const laterCutoff = new Date('2026-08-11T11:45:00.000Z');
    await policy.resume(
      { conversationId, effectiveAt: laterCutoff, requestKey: 'resume-greatest-later' },
      supportReviewer,
    );

    await expect(
      policy.resume(
        {
          conversationId,
          effectiveAt: new Date('2026-08-11T11:30:00.000Z'),
          requestKey: 'resume-greatest-older',
        },
        supportReviewer,
      ),
    ).resolves.toEqual({ aiPausedUntil: null, conversationId, status: 'applied' });

    const state = await pool.query(
      `select ai_paused_until, last_authorized_resume_at, row_version,
              count(*) filter (where history.action = 'resume')::int as resumes
       from conversations
       join human_pause_events as history on history.conversation_id = conversations.id
       where conversations.id = $1
       group by conversations.id`,
      [conversationId],
    );
    expect(state.rows).toEqual([
      {
        ai_paused_until: null,
        last_authorized_resume_at: laterCutoff,
        resumes: 2,
        row_version: '4',
      },
    ]);
  });

  test('reprocessing the same echo cannot extend its deadline or append another pause row', async () => {
    const { conversationId, echoEventId } = await createPausedConversation(
      'echo-duplicate-takeover',
      new Date('2026-08-11T12:00:00.000Z'),
    );
    const before = await readTakeoverMutationState();

    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(echoEventId),
    ).resolves.toMatchObject({
      conversationId,
      outcome: 'business_echo_paused',
      status: 'already_applied',
    });

    const after = await readTakeoverMutationState();
    expect(after.rows).toEqual(before.rows);
  });

  test('a distinct later echo extends an active pause only to its provider deadline', async () => {
    const fixtureKey = 'echo-distinct-extension';
    const first = await createPausedConversation(fixtureKey, new Date('2026-08-11T13:00:00.000Z'));
    const secondEventId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: `PAGE_TEST_${fixtureKey}`,
      contactId: `PSID_TEST_${fixtureKey}`,
      eventKind: 'business_message_echo',
      fixtureKey: `${fixtureKey}-second`,
      messageText: 'Synthetic distinct echo excluded from pause history',
      occurredAt: new Date('2026-08-11T13:15:00.000Z'),
    });

    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(secondEventId),
    ).resolves.toMatchObject({
      conversationId: first.conversationId,
      outcome: 'business_echo_paused',
      status: 'applied',
    });

    const state = await pool.query(
      `select conversations.ai_paused_until, conversations.row_version,
              array_agg(history.resulting_pause_until order by history.effective_at) as deadlines
       from conversations
       join human_pause_events as history on history.conversation_id = conversations.id
       where conversations.id = $1
       group by conversations.id`,
      [first.conversationId],
    );
    expect(state.rows).toEqual([
      {
        ai_paused_until: new Date('2026-08-12T13:15:00.000Z'),
        deadlines: [new Date('2026-08-12T13:00:00.000Z'), new Date('2026-08-12T13:15:00.000Z')],
        row_version: '3',
      },
    ]);
  });

  test.each(['echo', 'resume'] as const)(
    'resume and an older echo finish resumed when %s is first in the row-lock queue',
    async (firstCommit) => {
      const fixtureKey = `race-older-${firstCommit}`;
      const resumeAt = new Date('2026-08-11T14:30:00.000Z');
      const raced = await runTimestampOrderedRace({
        echoOccurredAt: '2026-08-11T14:29:59.999999+00:00',
        firstCommit,
        fixtureKey,
        resumeAt,
      });

      expect(raced.resumeResult).toMatchObject({ status: 'applied' });
      expect(raced.echoResult).toMatchObject({
        outcome:
          firstCommit === 'echo' ? 'business_echo_paused' : 'business_echo_ignored_before_resume',
      });
      const finalState = await pool.query(
        `select ai_paused_until is null as resumed,
                last_authorized_resume_at = $2::timestamptz as exact_cutoff
         from conversations where id = $1`,
        [raced.conversationId, resumeAt],
      );
      expect(finalState.rows).toEqual([{ exact_cutoff: true, resumed: true }]);
    },
  );

  test.each(['echo', 'resume'] as const)(
    'resume and a later echo preserve the exact provider deadline when %s is first in the row-lock queue',
    async (firstCommit) => {
      const fixtureKey = `race-later-${firstCommit}`;
      const resumeAt = new Date('2026-08-11T15:30:00.000Z');
      const echoOccurredAt = '2026-08-11T15:30:00.000001+00:00';
      const raced = await runTimestampOrderedRace({
        echoOccurredAt,
        firstCommit,
        fixtureKey,
        resumeAt,
      });

      expect(raced.resumeResult).toMatchObject({ status: 'applied' });
      expect(raced.echoResult).toMatchObject({ outcome: 'business_echo_paused' });
      const finalState = await pool.query(
        `select ai_paused_until = $2::timestamptz + interval '24 hours' as exact_deadline,
                last_authorized_resume_at = $3::timestamptz as exact_cutoff,
                resume.resulting_pause_until is not distinct from conversations.ai_paused_until
                  as exact_resume_history_deadline
         from conversations
         join human_pause_events as resume
           on resume.conversation_id = conversations.id and resume.action = 'resume'
         where conversations.id = $1`,
        [raced.conversationId, echoOccurredAt, resumeAt],
      );
      expect(finalState.rows).toEqual([
        {
          exact_cutoff: true,
          exact_deadline: true,
          exact_resume_history_deadline: firstCommit === 'echo',
        },
      ]);
    },
  );

  test.each(['echo', 'resume'] as const)(
    'an echo equal to the resume cutoff does not re-pause when %s is first in the row-lock queue',
    async (firstCommit) => {
      const fixtureKey = `race-equal-${firstCommit}`;
      const resumeAt = new Date('2026-08-11T16:30:00.000Z');
      const raced = await runTimestampOrderedRace({
        echoOccurredAt: '2026-08-11T16:30:00.000000+00:00',
        firstCommit,
        fixtureKey,
        resumeAt,
      });

      expect(raced.resumeResult).toMatchObject({ status: 'applied' });
      expect(raced.echoResult).toMatchObject({
        outcome:
          firstCommit === 'echo' ? 'business_echo_paused' : 'business_echo_ignored_before_resume',
      });
      const finalState = await pool.query(
        `select ai_paused_until is null as resumed,
                last_authorized_resume_at = $2::timestamptz as exact_cutoff
         from conversations where id = $1`,
        [raced.conversationId, resumeAt],
      );
      expect(finalState.rows).toEqual([{ exact_cutoff: true, resumed: true }]);
    },
  );

  test('accepts and stores a trimmed request key at the 128-character maximum', async () => {
    const { conversationId } = await createPausedConversation(
      'resume-request-key-maximum',
      new Date('2026-08-11T16:45:00.000Z'),
    );
    const normalizedRequestKey = 'r'.repeat(128);

    await expect(
      new PostgresTakeoverPolicy(pool).resume(
        {
          conversationId,
          effectiveAt: new Date('2026-08-11T17:00:00.000Z'),
          requestKey: `  ${normalizedRequestKey}  `,
        },
        supportReviewer,
      ),
    ).resolves.toMatchObject({ conversationId, status: 'applied' });

    const history = await pool.query(
      `select reviewer_request_key, length(reviewer_request_key)::int as request_key_length
       from human_pause_events
       where conversation_id = $1 and action = 'resume'`,
      [conversationId],
    );
    expect(history.rows).toEqual([
      { request_key_length: 128, reviewer_request_key: normalizedRequestKey },
    ]);
  });

  test('database unavailability returns no successful eligibility or resume result', async () => {
    const unavailablePool = new pg.Pool({
      connectionString: 'postgresql://fcd_support_test@127.0.0.1:1/fcd_support_test',
      connectionTimeoutMillis: 100,
      max: 1,
    });
    const policy = new PostgresTakeoverPolicy(unavailablePool);

    try {
      await expect(
        policy.evaluateReplyEligibility('1', new Date('2026-08-11T17:00:00.000Z')),
      ).rejects.toBeDefined();
      await expect(
        policy.resume(
          {
            conversationId: '1',
            effectiveAt: new Date('2026-08-11T17:00:00.000Z'),
            requestKey: 'resume-database-unavailable',
          },
          supportReviewer,
        ),
      ).rejects.toBeDefined();
    } finally {
      await unavailablePool.end();
    }
  });
});
