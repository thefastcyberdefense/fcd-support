import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  MODEL_ESCALATION_REASON_CODES,
  PostgresSupportEscalation,
} from '../../src/persistence/postgres-support-escalation.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import { insertSyntheticAppliedCustomerEvent } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let escalations: PostgresSupportEscalation;

const at = new Date('2026-09-13T08:00:00.000Z');

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('support_escalation');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(`truncate table contacts, webhook_receipts restart identity cascade`);
  escalations = new PostgresSupportEscalation(pool);
});

afterAll(async () => {
  await dispose?.();
});

async function source(key: string) {
  return insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `support_escalation_${key}`,
    identity: {
      channel: 'whatsapp',
      channelAccountId: 'WABA_TEST_escalation',
      externalContactId: `WA_TEST_escalation_${key}`,
    },
    occurredAt: at,
  });
}

describe('PostgreSQL support escalation evidence', () => {
  test('records every closed P4-005 escalation category without message or provider content', async () => {
    const fixture = await source('reasons');
    for (const [index, reasonCode] of MODEL_ESCALATION_REASON_CODES.entries()) {
      await expect(
        escalations.recordEscalation({
          conversationId: fixture.conversationId,
          createdAt: new Date(at.getTime() + index),
          reasonCode,
          requestKey: `REQUEST_TEST_escalation_${reasonCode}`,
          webhookEventId: fixture.eventId,
        }),
      ).resolves.toMatchObject({ reasonCode, status: 'applied' });
    }

    const rows = await pool.query<{
      readonly reason_code: string;
      readonly state: string;
    }>(`select reason_code, state from support_escalation_outcomes order by reason_code`);
    expect(rows.rows).toHaveLength(MODEL_ESCALATION_REASON_CODES.length);
    expect(rows.rows.every((row) => row.state === 'open')).toBe(true);
    expect(rows.rows.map((row) => row.reason_code).sort()).toEqual(
      [...MODEL_ESCALATION_REASON_CODES].sort(),
    );

    const columns = await pool.query<{ readonly column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'support_escalation_outcomes'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        'message_text',
        'prompt',
        'response_body',
        'provider_name',
        'provider_payload',
      ]),
    );
  });

  test('replays the exact request and rejects changed material under the same key', async () => {
    const fixture = await source('replay');
    const command = {
      conversationId: fixture.conversationId,
      createdAt: at,
      reasonCode: 'timeout' as const,
      requestKey: 'REQUEST_TEST_escalation_replay',
      webhookEventId: fixture.eventId,
    };
    const first = await escalations.recordEscalation(command);
    await expect(escalations.recordEscalation(command)).resolves.toEqual({
      escalationRef: first.escalationRef,
      reasonCode: 'timeout',
      status: 'duplicate',
    });
    await expect(
      escalations.recordEscalation({ ...command, reasonCode: 'network_failure' }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
    await expect(
      escalations.recordEscalation({ ...command, unexpected: 'forbidden' }),
    ).rejects.toThrow('invalid');
  });

  test('requires the source event to belong to the supplied conversation', async () => {
    const first = await source('source_first');
    const second = await source('source_second');
    await expect(
      escalations.recordEscalation({
        conversationId: first.conversationId,
        createdAt: at,
        reasonCode: 'provider_failure',
        requestKey: 'REQUEST_TEST_escalation_wrong_source',
        webhookEventId: second.eventId,
      }),
    ).rejects.toThrow('not found');
    await expect(
      pool.query(`select count(*)::int as count from support_escalation_outcomes`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
