import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresRestoreDeletionGate } from '../../src/persistence/postgres-restore-deletion-gate.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import type {
  ChannelIdentitySelector,
  PrivacyHmacKeyring,
  RestoreDeletionBatchInput,
  RestoreDeletionFinalizeInput,
} from '../../src/policy/policy-types.js';
import { insertSyntheticAppliedCustomerEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

const gitRevision = 'a'.repeat(40);
const keyring: PrivacyHmacKeyring = {
  activeVersion: 'test-v2',
  keys: new Map([
    ['test-v1', Buffer.alloc(32, 0x71)],
    ['test-v2', Buffer.alloc(32, 0x72)],
  ]),
};

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_restore_deletion_gate',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       restore_deletion_gates, privacy_deletion_runs,
       privacy_notification_intents, privacy_request_events,
       privacy_request_locations, privacy_requests, privacy_suppressions,
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

function identity(fixtureKey: string): ChannelIdentitySelector {
  return {
    channel: 'whatsapp',
    channelAccountId: `PHONE_TEST_restore_${fixtureKey}`,
    externalContactId: `WA_TEST_restore_${fixtureKey}`,
  };
}

async function insertRestoredIdentity(
  fixtureKey: string,
  occurredAt: Date,
): Promise<ChannelIdentitySelector> {
  const restoredIdentity = identity(fixtureKey);
  await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `restore-${fixtureKey}`,
    identity: restoredIdentity,
    messageText: `Synthetic restored content ${fixtureKey}`,
    occurredAt,
  });
  return restoredIdentity;
}

async function insertTombstone(
  customerIdentity: ChannelIdentitySelector,
  version: 'test-v1' | 'test-v2',
  effectiveAt: Date,
): Promise<void> {
  const key = keyring.keys.get(version);
  if (key === undefined) throw new Error('Synthetic restore key missing');
  await pool.query(
    `insert into privacy_suppressions
       (identity_hmac, channel, category, reason_code, effective_at, key_version)
     values ($1, $2, 'deletion_tombstone', 'customer_deletion', $3, $4)`,
    [
      createIdentityHmac(customerIdentity, { key, version }),
      customerIdentity.channel,
      effectiveAt,
      version,
    ],
  );
}

function batchCommand(input: {
  readonly evaluatedAt: Date;
  readonly gateRef?: string;
  readonly limit?: number;
  readonly requestKey: string;
  readonly requiredKeyVersions?: readonly string[];
}): RestoreDeletionBatchInput {
  return {
    evaluatedAt: input.evaluatedAt,
    gateRef: input.gateRef ?? 'synthetic-restore-gate',
    gitRevision,
    limit: input.limit ?? 100,
    requestKey: input.requestKey,
    requiredKeyVersions: input.requiredKeyVersions ?? ['test-v1', 'test-v2'],
  };
}

function finalizeCommand(input: {
  readonly evaluatedAt: Date;
  readonly gateRef?: string;
  readonly gitRevisionOverride?: string;
  readonly requestKey: string;
  readonly requiredKeyVersions?: readonly string[];
}): RestoreDeletionFinalizeInput {
  return {
    evaluatedAt: input.evaluatedAt,
    gateRef: input.gateRef ?? 'synthetic-restore-gate',
    gitRevision: input.gitRevisionOverride ?? gitRevision,
    requestKey: input.requestKey,
    requiredKeyVersions: input.requiredKeyVersions ?? ['test-v1', 'test-v2'],
  };
}

describe('PostgresRestoreDeletionGate reconciliation', () => {
  test('reapplies rotated tombstones in stable bounded batches without touching nonmatches', async () => {
    const effectiveAt = new Date('2026-08-31T07:00:00.000Z');
    const first = await insertRestoredIdentity('first', effectiveAt);
    const second = await insertRestoredIdentity('second', new Date(effectiveAt.getTime() + 1_000));
    const survivor = await insertRestoredIdentity(
      'survivor',
      new Date(effectiveAt.getTime() + 2_000),
    );
    const restoredDraftSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'restore-first-draft',
      identity: first,
      messageText: 'Synthetic restored draft source content',
      occurredAt: new Date(effectiveAt.getTime() + 3_000),
    });
    const restoredGapSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'restore-first-gap',
      identity: first,
      messageText: 'Synthetic restored gap source content',
      occurredAt: new Date(effectiveAt.getTime() + 4_000),
    });
    await pool.query(
      `insert into support_reply_drafts
        (draft_ref, source_webhook_event_id, conversation_id, decision_type,
         language, answer_text, state, retention_deadline, request_key, created_at)
       select 'DRAFT_TEST_restore_erasure', $1, $2, 'safe_failure', 'en',
              'Synthetic restored pending reply.', 'ready', expires_at,
              'REQUEST_TEST_restore_draft', $3
       from conversation_retention_states where conversation_id = $2`,
      [
        restoredDraftSource.eventId,
        restoredDraftSource.conversationId,
        new Date(effectiveAt.getTime() + 5_000),
      ],
    );
    await pool.query(
      `insert into knowledge_gap_observations
        (observation_ref, source_webhook_event_id, conversation_id, language,
         gap_kind, sanitized_summary, retention_deadline, request_key, created_at)
       select 'GAP_TEST_restore_erasure', $1, $2, 'en', 'faq_miss',
              'No reviewed FAQ matched.', expires_at,
              'REQUEST_TEST_restore_gap', $3
       from conversation_retention_states where conversation_id = $2`,
      [
        restoredGapSource.eventId,
        restoredGapSource.conversationId,
        new Date(effectiveAt.getTime() + 5_000),
      ],
    );
    await insertTombstone(first, 'test-v1', effectiveAt);
    await insertTombstone(second, 'test-v2', effectiveAt);
    const gate = new PostgresRestoreDeletionGate(pool, keyring);

    await expect(
      gate.reapplyBatch(
        batchCommand({
          evaluatedAt: new Date('2026-08-31T07:01:00.000Z'),
          limit: 1,
          requestKey: 'synthetic-restore-batch-1',
        }),
      ),
    ).resolves.toEqual({ identitiesProcessed: 1, remainingMatches: 1, status: 'applied' });
    const afterFirst = await pool.query<{
      readonly channel_account_id: string;
      readonly external_contact_id: string;
    }>(`select channel_account_id, external_contact_id from channel_identities order by id`);
    expect(afterFirst.rows[0]?.channel_account_id).toMatch(/^deleted:[0-9a-f-]{36}$/);
    expect(afterFirst.rows[1]).toMatchObject({
      channel_account_id: second.channelAccountId,
      external_contact_id: second.externalContactId,
    });
    const erasedPhase4 = await pool.query(
      `select
         (select state from support_reply_drafts
          where draft_ref = 'DRAFT_TEST_restore_erasure') as draft_state,
         (select answer_text from support_reply_drafts
          where draft_ref = 'DRAFT_TEST_restore_erasure') as draft_text,
         (select sanitized_summary from knowledge_gap_observations
          where observation_ref = 'GAP_TEST_restore_erasure') as gap_summary,
         (select count(*)::int from support_reply_drafts
          where draft_ref = 'DRAFT_TEST_restore_erasure' and erased_at = $1) as exact_draft_erasure,
         (select count(*)::int from knowledge_gap_observations
          where observation_ref = 'GAP_TEST_restore_erasure' and erased_at = $1) as exact_gap_erasure`,
      [new Date('2026-08-31T07:01:00.000Z')],
    );
    expect(erasedPhase4.rows).toEqual([
      {
        draft_state: 'erased',
        draft_text: null,
        exact_draft_erasure: 1,
        exact_gap_erasure: 1,
        gap_summary: null,
      },
    ]);

    await expect(
      gate.reapplyBatch(
        batchCommand({
          evaluatedAt: new Date('2026-08-31T07:02:00.000Z'),
          limit: 1,
          requestKey: 'synthetic-restore-batch-2',
        }),
      ),
    ).resolves.toEqual({ identitiesProcessed: 1, remainingMatches: 0, status: 'applied' });
    await expect(
      gate.reapplyBatch(
        batchCommand({
          evaluatedAt: new Date('2026-08-31T07:03:00.000Z'),
          limit: 1,
          requestKey: 'synthetic-restore-batch-3',
        }),
      ),
    ).resolves.toEqual({ identitiesProcessed: 0, remainingMatches: 0, status: 'applied' });
    const finalRows = await pool.query<{
      readonly channel_account_id: string;
      readonly external_contact_id: string;
    }>(`select channel_account_id, external_contact_id from channel_identities order by id`);
    expect(finalRows.rows[0]?.channel_account_id).toMatch(/^deleted:[0-9a-f-]{36}$/);
    expect(finalRows.rows[1]?.channel_account_id).toMatch(/^deleted:[0-9a-f-]{36}$/);
    expect(finalRows.rows[2]).toEqual({
      channel_account_id: survivor.channelAccountId,
      external_contact_id: survivor.externalContactId,
    });
    const evidence = await pool.query(
      `select action, status, identities_processed, remaining_matches
       from restore_deletion_gates order by id`,
    );
    expect(evidence.rows).toEqual([
      { action: 'reapply_batch', identities_processed: 1, remaining_matches: 1, status: 'applied' },
      { action: 'reapply_batch', identities_processed: 1, remaining_matches: 0, status: 'applied' },
      { action: 'reapply_batch', identities_processed: 0, remaining_matches: 0, status: 'applied' },
    ]);
  });

  test('returns aggregate evidence for exact replay and conflicts on changed material', async () => {
    const evaluatedAt = new Date('2026-08-31T07:10:00.000Z');
    const erased = await insertRestoredIdentity('replay', evaluatedAt);
    await insertTombstone(erased, 'test-v1', evaluatedAt);
    const gate = new PostgresRestoreDeletionGate(pool, keyring);
    const command = batchCommand({
      evaluatedAt: new Date('2026-08-31T07:11:00.000Z'),
      requestKey: 'synthetic-restore-replay',
    });

    await expect(gate.reapplyBatch(command)).resolves.toEqual({
      identitiesProcessed: 1,
      remainingMatches: 0,
      status: 'applied',
    });
    await expect(gate.reapplyBatch(command)).resolves.toEqual({
      identitiesProcessed: 1,
      remainingMatches: 0,
      status: 'duplicate',
    });
    await expect(
      gate.reapplyBatch({ ...command, gitRevision: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    const evidence = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from restore_deletion_gates`,
    );
    expect(evidence.rows).toEqual([{ count: 1 }]);
  });

  test('rejects missing required and tombstone key versions without mutation', async () => {
    const evaluatedAt = new Date('2026-08-31T07:20:00.000Z');
    const erased = await insertRestoredIdentity('missing-key', evaluatedAt);
    await insertTombstone(erased, 'test-v1', evaluatedAt);
    const incompleteKeyring: PrivacyHmacKeyring = {
      activeVersion: 'test-v2',
      keys: new Map([['test-v2', Buffer.alloc(32, 0x72)]]),
    };
    await expect(
      new PostgresRestoreDeletionGate(pool, incompleteKeyring).reapplyBatch(
        batchCommand({
          evaluatedAt: new Date('2026-08-31T07:21:00.000Z'),
          requestKey: 'synthetic-restore-missing-key',
        }),
      ),
    ).rejects.toMatchObject({ name: 'RestoreDeletionKeyVersionError' });
    await expect(
      new PostgresRestoreDeletionGate(pool, keyring).reapplyBatch(
        batchCommand({
          evaluatedAt: new Date('2026-08-31T07:21:00.000Z'),
          requestKey: 'synthetic-restore-omitted-version',
          requiredKeyVersions: ['test-v2'],
        }),
      ),
    ).rejects.toMatchObject({ name: 'RestoreDeletionKeyVersionError' });
    const unchanged = await pool.query(
      `select
         (select count(*)::int from channel_identities
          where channel_account_id = $1 and external_contact_id = $2) as raw_identities,
         (select count(*)::int from restore_deletion_gates) as evidence`,
      [erased.channelAccountId, erased.externalContactId],
    );
    expect(unchanged.rows).toEqual([{ evidence: 0, raw_identities: 1 }]);
  });

  test('rolls back erasure when batch evidence cannot be written', async () => {
    const evaluatedAt = new Date('2026-08-31T07:30:00.000Z');
    const erased = await insertRestoredIdentity('rollback', evaluatedAt);
    await insertTombstone(erased, 'test-v2', evaluatedAt);
    await pool.query(
      `create function synthetic_reject_restore_batch()
       returns trigger language plpgsql as $$
       begin
         if new.action = 'reapply_batch' then
           raise exception using errcode = 'P0001', message = 'synthetic restore evidence rejection';
         end if;
         return new;
       end;
       $$;
       create trigger synthetic_reject_restore_batch
         before insert on restore_deletion_gates
         for each row execute function synthetic_reject_restore_batch()`,
    );
    try {
      await expect(
        new PostgresRestoreDeletionGate(pool, keyring).reapplyBatch(
          batchCommand({
            evaluatedAt: new Date('2026-08-31T07:31:00.000Z'),
            requestKey: 'synthetic-restore-rollback',
          }),
        ),
      ).rejects.toThrow('synthetic restore evidence rejection');
    } finally {
      await pool.query(
        `drop trigger if exists synthetic_reject_restore_batch on restore_deletion_gates;
         drop function if exists synthetic_reject_restore_batch()`,
      );
    }
    const afterRollback = await pool.query(
      `select
         (select count(*)::int from channel_identities
          where channel_account_id = $1 and external_contact_id = $2) as raw_identities,
         (select count(*)::int from webhook_events
          where channel_account_id = $1 and contact_id = $2 and message_text is not null) as raw_events,
         (select count(*)::int from restore_deletion_gates) as evidence`,
      [erased.channelAccountId, erased.externalContactId],
    );
    expect(afterRollback.rows).toEqual([{ evidence: 0, raw_events: 1, raw_identities: 1 }]);
  });
});

describe('PostgresRestoreDeletionGate promotion gate', () => {
  test('refuses finalization while a matching raw identity or nonzero latest batch remains', async () => {
    const evaluatedAt = new Date('2026-08-31T08:00:00.000Z');
    const first = await insertRestoredIdentity('finalize-first', evaluatedAt);
    const second = await insertRestoredIdentity(
      'finalize-second',
      new Date(evaluatedAt.getTime() + 1_000),
    );
    await insertTombstone(first, 'test-v1', evaluatedAt);
    await insertTombstone(second, 'test-v2', evaluatedAt);
    const gate = new PostgresRestoreDeletionGate(pool, keyring);
    await gate.reapplyBatch(
      batchCommand({
        evaluatedAt: new Date('2026-08-31T08:01:00.000Z'),
        limit: 1,
        requestKey: 'synthetic-restore-finalize-partial',
      }),
    );

    await expect(
      gate.finalizeGate(
        finalizeCommand({
          evaluatedAt: new Date('2026-08-31T08:02:00.000Z'),
          requestKey: 'synthetic-restore-finalize-refused',
        }),
      ),
    ).rejects.toMatchObject({ name: 'RestoreDeletionGateNotReadyError' });
    const passes = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from restore_deletion_gates
       where action = 'finalize' and status = 'passed'`,
    );
    expect(passes.rows).toEqual([{ count: 0 }]);
  });

  test('refuses finalization after failed evidence or with a missing required key', async () => {
    const evaluatedAt = new Date('2026-08-31T08:10:00.000Z');
    await pool.query(
      `insert into restore_deletion_gates
         (gate_ref, request_key, action, status, evaluated_at, git_revision,
          required_key_versions, identities_processed, remaining_matches, completed_at)
       values ('synthetic-restore-gate', 'synthetic-restore-failed-evidence',
               'reapply_batch', 'failed', $1, $2, $3, 0, 0, $1)`,
      [evaluatedAt, gitRevision, ['test-v1', 'test-v2']],
    );
    const command = finalizeCommand({
      evaluatedAt: new Date('2026-08-31T08:11:00.000Z'),
      requestKey: 'synthetic-restore-finalize-after-failure',
    });
    await expect(
      new PostgresRestoreDeletionGate(pool, keyring).finalizeGate(command),
    ).rejects.toMatchObject({ name: 'RestoreDeletionGateNotReadyError' });
    const incompleteKeyring: PrivacyHmacKeyring = {
      activeVersion: 'test-v2',
      keys: new Map([['test-v2', Buffer.alloc(32, 0x72)]]),
    };
    await expect(
      new PostgresRestoreDeletionGate(pool, incompleteKeyring).finalizeGate({
        ...command,
        requestKey: 'synthetic-restore-finalize-missing-key',
      }),
    ).rejects.toMatchObject({ name: 'RestoreDeletionKeyVersionError' });
  });

  test('cannot pass while a matching raw identity is locked outside the gate scan', async () => {
    const evaluatedAt = new Date('2026-08-31T08:15:00.000Z');
    const erased = await insertRestoredIdentity('finalize-locked', evaluatedAt);
    await insertTombstone(erased, 'test-v1', evaluatedAt);
    await pool.query(
      `insert into restore_deletion_gates
         (gate_ref, request_key, action, status, evaluated_at, git_revision,
          required_key_versions, identities_processed, remaining_matches, completed_at)
       values ('synthetic-restore-gate', 'synthetic-restore-locked-batch',
               'reapply_batch', 'applied', $1, $2, $3, 0, 0, $1)`,
      [evaluatedAt, gitRevision, ['test-v1', 'test-v2']],
    );
    const locker = await pool.connect();
    try {
      await locker.query('begin');
      await locker.query(
        `select id from channel_identities
         where channel_account_id = $1 and external_contact_id = $2
         for update`,
        [erased.channelAccountId, erased.externalContactId],
      );
      await expect(
        new PostgresRestoreDeletionGate(pool, keyring).finalizeGate(
          finalizeCommand({
            evaluatedAt: new Date('2026-08-31T08:16:00.000Z'),
            requestKey: 'synthetic-restore-finalize-while-locked',
          }),
        ),
      ).rejects.toBeDefined();
    } finally {
      await locker.query('rollback');
      locker.release();
    }
    const passes = await pool.query<{ readonly count: number }>(
      `select count(*)::int as count from restore_deletion_gates
       where action = 'finalize' and status = 'passed'`,
    );
    expect(passes.rows).toEqual([{ count: 0 }]);
  });

  test('records one append-only pass with safe replay and changed-material conflict', async () => {
    const gate = new PostgresRestoreDeletionGate(pool, keyring);
    await gate.reapplyBatch(
      batchCommand({
        evaluatedAt: new Date('2026-08-31T08:20:00.000Z'),
        requestKey: 'synthetic-restore-empty-batch',
      }),
    );
    const command = finalizeCommand({
      evaluatedAt: new Date('2026-08-31T08:21:00.000Z'),
      requestKey: 'synthetic-restore-finalize-pass',
    });

    await expect(gate.finalizeGate(command)).resolves.toEqual({ status: 'passed' });
    await expect(gate.finalizeGate(command)).resolves.toEqual({ status: 'passed' });
    await expect(
      gate.finalizeGate({ ...command, gitRevision: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    const evidence = await pool.query(
      `select gate_ref, action, status, identities_processed, remaining_matches,
              git_revision, required_key_versions
       from restore_deletion_gates order by id`,
    );
    expect(evidence.rows).toEqual([
      {
        action: 'reapply_batch',
        gate_ref: 'synthetic-restore-gate',
        git_revision: gitRevision,
        identities_processed: 0,
        remaining_matches: 0,
        required_key_versions: ['test-v1', 'test-v2'],
        status: 'applied',
      },
      {
        action: 'finalize',
        gate_ref: 'synthetic-restore-gate',
        git_revision: gitRevision,
        identities_processed: 0,
        remaining_matches: 0,
        required_key_versions: ['test-v1', 'test-v2'],
        status: 'passed',
      },
    ]);
    await expect(
      pool.query(
        `update restore_deletion_gates set remaining_matches = 1
         where request_key = 'synthetic-restore-finalize-pass'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
