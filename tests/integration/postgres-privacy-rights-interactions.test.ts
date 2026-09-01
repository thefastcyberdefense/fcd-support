import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresAccessExport } from '../../src/persistence/postgres-access-export.js';
import { PostgresConsentPolicy } from '../../src/persistence/postgres-consent-policy.js';
import { PostgresDeletionPolicy } from '../../src/persistence/postgres-deletion-policy.js';
import { PostgresMarketingOptOutPolicy } from '../../src/persistence/postgres-marketing-opt-out-policy.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import { PostgresTakeoverPolicy } from '../../src/persistence/postgres-takeover-policy.js';
import type { ChannelIdentitySelector } from '../../src/policy/policy-types.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticLinkedCustomerIdentities,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_privacy_rights_interactions',
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
  reviewerRef: 'REVIEWER_TEST_privacy_interactions',
  roles: ['support_reviewer'],
} as const;

function identity(fixtureKey: string, channel: 'messenger' | 'whatsapp' = 'whatsapp') {
  return {
    channel,
    channelAccountId: `ACCOUNT_TEST_interaction_${fixtureKey}`,
    externalContactId: `CONTACT_TEST_interaction_${fixtureKey}`,
  } as const;
}

async function openReviewedPrivacyRequest(input: {
  readonly fixtureKey: string;
  readonly identity: ChannelIdentitySelector;
  readonly occurredAt: Date;
  readonly requestType: 'access' | 'correction';
}): Promise<{ readonly conversationId: string; readonly requestRef: string }> {
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `${input.fixtureKey}-source`,
    identity: input.identity,
    messageText: input.requestType === 'access' ? 'REQUEST MY DATA' : 'CORRECT MY DATA',
    occurredAt: input.occurredAt,
  });
  const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
  const opened = await policy.processAppliedEvent({
    requestKey: `${input.fixtureKey}-open`,
    sourceWebhookEventId: source.eventId,
  });
  if (opened.status !== 'opened' || opened.intent !== input.requestType) {
    throw new Error('Synthetic reviewed privacy request was not opened');
  }
  await policy.reviewRequest(
    {
      decidedAt: new Date(input.occurredAt.getTime() + 1_000),
      decision: 'approve',
      reasonCode: 'identity_verified',
      requestKey: `${input.fixtureKey}-approve`,
      requestRef: opened.requestRef,
      verificationMethod: 'same_channel_context',
    },
    reviewer,
  );
  return { conversationId: source.conversationId, requestRef: opened.requestRef };
}

async function executeDeletion(input: {
  readonly fixtureKey: string;
  readonly identity: ChannelIdentitySelector;
  readonly requestedAt: Date;
}): Promise<{ readonly policy: PostgresDeletionPolicy; readonly requestRef: string }> {
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `${input.fixtureKey}-deletion-source`,
    identity: input.identity,
    messageText: 'DELETE MY DATA',
    occurredAt: input.requestedAt,
  });
  const policy = new PostgresDeletionPolicy(pool, syntheticPrivacyKeyring);
  const opened = await policy.openRequest({
    identity: input.identity,
    requestedAt: input.requestedAt,
    requestKey: `${input.fixtureKey}-deletion-open`,
    sourceWebhookEventId: source.eventId,
  });
  const confirmation = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `${input.fixtureKey}-deletion-confirmation`,
    identity: input.identity,
    messageText: 'Synthetic explicit privacy deletion confirmation',
    occurredAt: new Date(input.requestedAt.getTime() + 1_000),
  });
  await policy.reviewRequest(
    {
      confirmationWebhookEventId: confirmation.eventId,
      decidedAt: new Date(input.requestedAt.getTime() + 2_000),
      decision: 'approve',
      reasonCode: 'customer_confirmed',
      requestKey: `${input.fixtureKey}-deletion-review`,
      requestRef: opened.requestRef,
      verificationMethod: 'explicit_confirmation',
    },
    reviewer,
  );
  await policy.executeApprovedRequest({
    executedAt: new Date(input.requestedAt.getTime() + 3_000),
    requestKey: `${input.fixtureKey}-deletion-execute`,
    requestRef: opened.requestRef,
  });
  return { policy, requestRef: opened.requestRef };
}

async function privacyEvidenceCounts(): Promise<Record<string, number>> {
  const selected = await pool.query<{ readonly counts: Record<string, number> }>(
    `select jsonb_build_object(
       'requests', (select count(*)::int from privacy_requests),
       'notifications', (select count(*)::int from privacy_notification_intents),
       'suppressions', (select count(*)::int from privacy_suppressions),
       'consents', (select count(*)::int from consent_events),
       'corrections', (select count(*)::int from privacy_correction_runs),
       'access_runs', (select count(*)::int from privacy_access_runs),
       'marketing_runs', (select count(*)::int from privacy_marketing_opt_out_runs)
     ) as counts`,
  );
  const counts = selected.rows[0]?.counts;
  if (counts === undefined) throw new Error('Synthetic privacy evidence counts were not returned');
  return counts;
}

describe('privacy-rights cross-feature safety', () => {
  test('keeps a deletion tombstone terminal after its request row closes', async () => {
    const subject = identity('terminal-tombstone');
    const deleted = await executeDeletion({
      fixtureKey: 'terminal-tombstone',
      identity: subject,
      requestedAt: new Date('2026-08-31T10:00:00.000Z'),
    });
    await pool.query(
      `update privacy_request_locations
       set state = 'completed',
           outcome_code = 'location_complete',
           checked_at = $2
       where request_id = (
         select id from privacy_requests where request_ref = $1
       )
         and state = 'pending'`,
      [deleted.requestRef, new Date('2026-08-31T10:09:00.000Z')],
    );
    await pool.query(
      `update privacy_requests
       set state = 'completed', completed_at = $2
       where request_ref = $1`,
      [deleted.requestRef, new Date('2026-08-31T10:10:00.000Z')],
    );

    await expect(
      deleted.policy.isIdentityDeleted(subject, new Date('2026-08-31T10:11:00.000Z')),
    ).resolves.toBe(true);
  });

  test('does not change retention deadlines or consent history when access and correction holds open', async () => {
    const subject = identity('hold-invariants');
    const accessSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'hold-invariants-access',
      identity: subject,
      messageText: 'REQUEST MY DATA',
      occurredAt: new Date('2026-08-31T10:20:00.000Z'),
    });
    const correctionSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'hold-invariants-correction',
      identity: subject,
      messageText: 'CORRECT MY DATA',
      occurredAt: new Date('2026-08-31T10:21:00.000Z'),
    });
    await new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).recordReviewerCommand(
      {
        action: 'grant',
        category: 'security_updates',
        idempotencyKey: 'hold-invariants-consent',
        identity: subject,
        source: 'reviewer_recorded',
        sourceAt: new Date('2026-08-31T10:22:00.000Z'),
        wording: 'Synthetic approved privacy interaction consent',
        wordingVersion: 'TEST_v1',
      },
      reviewer,
    );
    const retentionBefore = await pool.query(
      `select lifecycle_class, anchor_at, expires_at, relationship_status,
              relationship_started_at, relationship_ended_at
       from conversation_retention_states
       where conversation_id = $1`,
      [accessSource.conversationId],
    );
    const consentBefore = await pool.query(
      `select channel_identity_id, category, action, wording, wording_version,
              source, source_at, idempotency_key
       from consent_events
       order by id`,
    );

    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    for (const [requestType, source] of [
      ['access', accessSource],
      ['correction', correctionSource],
    ] as const) {
      const opened = await policy.processAppliedEvent({
        requestKey: `hold-invariants-${requestType}-open`,
        sourceWebhookEventId: source.eventId,
      });
      if (opened.status !== 'opened' || opened.intent !== requestType) {
        throw new Error('Synthetic hold request was not opened');
      }
      await policy.reviewRequest(
        {
          decidedAt: new Date('2026-08-31T10:23:00.000Z'),
          decision: 'approve',
          reasonCode: 'identity_verified',
          requestKey: `hold-invariants-${requestType}-review`,
          requestRef: opened.requestRef,
          verificationMethod: 'same_channel_context',
        },
        reviewer,
      );
    }

    await expect(
      pool.query(
        `select lifecycle_class, anchor_at, expires_at, relationship_status,
                relationship_started_at, relationship_ended_at
         from conversation_retention_states
         where conversation_id = $1`,
        [accessSource.conversationId],
      ),
    ).resolves.toEqual(retentionBefore);
    await expect(
      pool.query(
        `select channel_identity_id, category, action, wording, wording_version,
                source, source_at, idempotency_key
         from consent_events
         order by id`,
      ),
    ).resolves.toEqual(consentBefore);
  });

  test('does not alter an active human takeover pause during global opt-out', async () => {
    const primary = identity('opt-out-pause-whatsapp');
    const linked = identity('opt-out-pause-messenger', 'messenger');
    const fixture = await insertSyntheticLinkedCustomerIdentities(pool, {
      fixtureKey: 'opt-out-pause',
      seeds: [
        {
          identity: primary,
          messageText: 'STOP MARKETING',
          occurredAt: new Date('2026-08-31T10:30:00.000Z'),
        },
        {
          identity: linked,
          occurredAt: new Date('2026-08-31T10:30:01.000Z'),
        },
      ],
    });
    const conversationId = fixture.conversationIds[0];
    const sourceEventId = fixture.eventIds[0];
    if (conversationId === undefined || sourceEventId === undefined) {
      throw new Error('Synthetic linked opt-out fixture is incomplete');
    }
    const pauseUntil = new Date('2026-08-31T11:30:00.000Z');
    await pool.query(`update conversations set ai_paused_until = $2 where id = $1`, [
      conversationId,
      pauseUntil,
    ]);

    await new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply({
      effectiveAt: new Date('2026-08-31T10:30:00.000Z'),
      requestKey: 'opt-out-pause-apply',
      sourceWebhookEventId: sourceEventId,
    });

    await expect(
      pool.query(`select ai_paused_until from conversations where id = $1`, [conversationId]),
    ).resolves.toMatchObject({ rows: [{ ai_paused_until: pauseUntil }] });
    await expect(
      new PostgresTakeoverPolicy(pool).evaluateReplyEligibility(
        conversationId,
        new Date('2026-08-31T10:31:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'pause_active' });
  });

  test('refuses access collection after the approved subject is deleted and pseudonymized', async () => {
    const subject = identity('deleted-access');
    const access = await openReviewedPrivacyRequest({
      fixtureKey: 'deleted-access',
      identity: subject,
      occurredAt: new Date('2026-08-31T10:40:00.000Z'),
      requestType: 'access',
    });
    await executeDeletion({
      fixtureKey: 'deleted-access',
      identity: subject,
      requestedAt: new Date('2026-08-31T10:41:00.000Z'),
    });

    await expect(
      new PostgresAccessExport(pool, () => new Date('2026-08-31T10:45:00.000Z')).collect(
        {
          collectedAt: new Date('2026-08-31T10:45:00.000Z'),
          requestKey: 'deleted-access-collect',
          requestRef: access.requestRef,
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    await expect(
      pool.query(`select count(*)::int as count from privacy_access_runs`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  test('releases overlapping access and correction holds independently', async () => {
    const subject = identity('overlapping-holds');
    const sources = await Promise.all([
      insertSyntheticAppliedCustomerEvent(pool, {
        fixtureKey: 'overlapping-holds-access',
        identity: subject,
        messageText: 'REQUEST MY DATA',
        occurredAt: new Date('2026-08-31T10:50:00.000Z'),
      }),
      insertSyntheticAppliedCustomerEvent(pool, {
        fixtureKey: 'overlapping-holds-correction',
        identity: subject,
        messageText: 'CORRECT MY DATA',
        occurredAt: new Date('2026-08-31T10:50:01.000Z'),
      }),
    ]);
    const conversationId = sources[0].conversationId;
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const requests = [];
    for (const [requestType, source] of [
      ['access', sources[0]],
      ['correction', sources[1]],
    ] as const) {
      const opened = await policy.processAppliedEvent({
        requestKey: `overlapping-holds-${requestType}-open`,
        sourceWebhookEventId: source.eventId,
      });
      if (opened.status !== 'opened' || opened.intent !== requestType) {
        throw new Error('Synthetic overlapping request was not opened');
      }
      requests.push({ requestRef: opened.requestRef, requestType });
    }

    await expect(
      new PostgresTakeoverPolicy(pool).evaluateReplyEligibility(
        conversationId,
        new Date('2026-08-31T10:51:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'privacy_request_open' });

    for (const [index, request] of requests.entries()) {
      await policy.reviewRequest(
        {
          decidedAt: new Date(`2026-08-31T10:5${String(index + 2)}:00.000Z`),
          decision: 'reject',
          reasonCode: 'identity_ambiguous',
          requestKey: `overlapping-holds-${request.requestType}-reject`,
          requestRef: request.requestRef,
          verificationMethod: 'same_channel_context',
        },
        reviewer,
      );
      await expect(
        new PostgresTakeoverPolicy(pool).evaluateReplyEligibility(
          conversationId,
          new Date(`2026-08-31T10:5${String(index + 2)}:30.000Z`),
        ),
      ).resolves.toEqual(
        index === 0
          ? { eligible: false, reason: 'privacy_request_open' }
          : { eligible: true, reason: 'pause_inactive' },
      );
    }
  });

  test('rolls a timed-out intake back fully and permits a clean retry', async () => {
    const source = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'timeout-retry-access',
      identity: identity('timeout-retry-access'),
      messageText: 'REQUEST MY DATA',
      occurredAt: new Date('2026-08-31T11:00:00.000Z'),
    });
    const policy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
    const command = {
      requestKey: 'timeout-retry-access-open',
      sourceWebhookEventId: source.eventId,
    } as const;
    await pool.query(`
      create function delay_synthetic_privacy_notification()
      returns trigger language plpgsql as $$
      begin
        perform pg_sleep(4);
        return new;
      end;
      $$;
      create trigger delay_synthetic_privacy_notification
        before insert on privacy_notification_intents
        for each row execute function delay_synthetic_privacy_notification();
    `);
    try {
      await expect(policy.processAppliedEvent(command)).rejects.toMatchObject({ code: '57014' });
      await expect(privacyEvidenceCounts()).resolves.toEqual({
        access_runs: 0,
        consents: 0,
        corrections: 0,
        marketing_runs: 0,
        notifications: 0,
        requests: 0,
        suppressions: 0,
      });
    } finally {
      await pool.query(`
        drop trigger if exists delay_synthetic_privacy_notification
          on privacy_notification_intents;
        drop function if exists delay_synthetic_privacy_notification();
      `);
    }

    await expect(policy.processAppliedEvent(command)).resolves.toMatchObject({
      intent: 'access',
      status: 'opened',
    });
    await expect(privacyEvidenceCounts()).resolves.toEqual({
      access_runs: 0,
      consents: 0,
      corrections: 0,
      marketing_runs: 0,
      notifications: 1,
      requests: 1,
      suppressions: 0,
    });
  }, 10_000);
});
