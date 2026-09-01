import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PostgresConsentPolicy } from '../../src/persistence/postgres-consent-policy.js';
import { PostgresMarketingOptOutPolicy } from '../../src/persistence/postgres-marketing-opt-out-policy.js';
import { PostgresTakeoverPolicy } from '../../src/persistence/postgres-takeover-policy.js';
import type { ChannelIdentitySelector, PrivacyHmacKeyring } from '../../src/policy/policy-types.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_marketing_opt_out_policy',
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
  reviewerRef: 'REVIEWER_TEST_marketing',
  roles: ['support_reviewer'],
} as const;

const whatsappIdentity = {
  channel: 'whatsapp',
  channelAccountId: 'ACCOUNT_TEST_marketing_whatsapp',
  externalContactId: 'CONTACT_TEST_marketing_whatsapp',
} as const;
const messengerIdentity = {
  channel: 'messenger',
  channelAccountId: 'ACCOUNT_TEST_marketing_messenger',
  externalContactId: 'CONTACT_TEST_marketing_messenger',
} as const;

interface LinkedFixture {
  readonly messengerConversationId: string;
  readonly sourceEventId: string;
  readonly sourceOccurredAt: Date;
}

async function createLinkedFixture(
  fixtureKey: string,
  seedDefaultCategories = true,
): Promise<LinkedFixture> {
  const sourceOccurredAt = new Date('2026-08-31T06:00:00.000Z');
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `${fixtureKey}-source`,
    identity: whatsappIdentity,
    messageText: 'STOP MARKETING',
    occurredAt: sourceOccurredAt,
  });
  const contact = await pool.query<{ readonly id: string }>(
    `select identity.contact_id as id
     from conversations
     join channel_identities as identity
       on identity.id = conversations.channel_identity_id
     where conversations.id = $1`,
    [source.conversationId],
  );
  const messenger = await pool.query<{ readonly id: string }>(
    `insert into channel_identities
       (contact_id, channel, channel_account_id, external_contact_id,
        first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $5)
     returning id`,
    [
      contact.rows[0]?.id,
      messengerIdentity.channel,
      messengerIdentity.channelAccountId,
      messengerIdentity.externalContactId,
      sourceOccurredAt,
    ],
  );
  const conversation = await pool.query<{ readonly id: string }>(
    `insert into conversations (channel_identity_id, created_at, last_activity_at)
     values ($1, $2, $2)
     returning id`,
    [messenger.rows[0]?.id, sourceOccurredAt],
  );
  const messengerConversationId = conversation.rows[0]?.id;
  if (messengerConversationId === undefined) {
    throw new Error('Synthetic linked Messenger conversation was not created');
  }

  if (seedDefaultCategories) {
    await seedGrant(whatsappIdentity, 'newsletter', '06:00:00', `${fixtureKey}-whatsapp`);
    await seedGrant(messengerIdentity, 'security_updates', '06:00:01', `${fixtureKey}-messenger`);
  }
  return {
    messengerConversationId,
    sourceEventId: source.eventId,
    sourceOccurredAt,
  };
}

async function identityId(identity: ChannelIdentitySelector): Promise<string> {
  const selected = await pool.query<{ readonly id: string }>(
    `select id from channel_identities
     where channel = $1
       and channel_account_id = $2
       and external_contact_id = $3`,
    [identity.channel, identity.channelAccountId, identity.externalContactId],
  );
  const id = selected.rows[0]?.id;
  if (id === undefined) throw new Error('Synthetic identity was not found');
  return id;
}

async function seedGrant(
  identity: ChannelIdentitySelector,
  category: string,
  time: string,
  fixtureKey: string,
): Promise<void> {
  await pool.query(
    `insert into consent_events
       (channel_identity_id, category, action, wording, wording_version,
        source, source_at, idempotency_key)
     values ($1, $2, 'grant', 'Synthetic approved marketing consent',
             'TEST_v1', 'reviewer_recorded', $3, $4)`,
    [
      await identityId(identity),
      category,
      `2026-08-31T${time}.000Z`,
      `synthetic-grant-${fixtureKey}-${category}`,
    ],
  );
}

function optOutInput(fixture: LinkedFixture, requestKey: string) {
  return {
    effectiveAt: fixture.sourceOccurredAt,
    requestKey,
    sourceWebhookEventId: fixture.sourceEventId,
  };
}

describe('PostgresMarketingOptOutPolicy', () => {
  test('revokes every known category across all linked identities and records bounded evidence', async () => {
    const fixture = await createLinkedFixture('marketing-all-linked');
    const result = await new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply(
      optOutInput(fixture, 'marketing-all-linked'),
    );

    expect(result).toEqual({
      categoryRevocations: 4,
      linkedIdentities: 2,
      pendingIntentsCancelled: 0,
      status: 'applied',
      suppressionsCreated: 8,
    });
    const latest = await pool.query(
      `select identity.channel, consent.category, consent.action
       from consent_events as consent
       join channel_identities as identity
         on identity.id = consent.channel_identity_id
       where consent.source = 'customer_message'
       order by identity.channel, consent.category`,
    );
    expect(latest.rows).toEqual([
      { action: 'revoke', category: 'newsletter', channel: 'messenger' },
      { action: 'revoke', category: 'security_updates', channel: 'messenger' },
      { action: 'revoke', category: 'newsletter', channel: 'whatsapp' },
      { action: 'revoke', category: 'security_updates', channel: 'whatsapp' },
    ]);
    const evidence = await pool.query(
      `select run.linked_identities_count,
              run.category_revocations_count,
              run.suppressions_created_count,
              run.pending_intents_cancelled_count,
              notification.notification_type,
              notification.state as notification_state
       from privacy_marketing_opt_out_runs as run
       join privacy_notification_intents as notification
         on notification.marketing_opt_out_run_id = run.id`,
    );
    expect(evidence.rows).toEqual([
      {
        category_revocations_count: 4,
        linked_identities_count: 2,
        notification_state: 'pending',
        notification_type: 'operator_marketing_opt_out',
        pending_intents_cancelled_count: 0,
        suppressions_created_count: 8,
      },
    ]);
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(whatsappIdentity.channelAccountId);
    expect(serializedResult).not.toContain(whatsappIdentity.externalContactId);
    expect(serializedResult).not.toContain(messengerIdentity.channelAccountId);
    expect(serializedResult).not.toContain(messengerIdentity.externalContactId);
    await expect(
      new PostgresTakeoverPolicy(pool).evaluateReplyEligibility(
        fixture.messengerConversationId,
        new Date('2026-08-31T06:10:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'pause_inactive' });
  });

  test('revokes a category known on only one identity across every linked identity', async () => {
    const fixture = await createLinkedFixture('marketing-single-category', false);
    await seedGrant(
      whatsappIdentity,
      'newsletter',
      '06:00:02',
      'marketing-single-category-whatsapp',
    );

    await expect(
      new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply(
        optOutInput(fixture, 'marketing-single-category'),
      ),
    ).resolves.toMatchObject({
      categoryRevocations: 2,
      linkedIdentities: 2,
      status: 'applied',
    });
    const revokes = await pool.query(
      `select identity.channel, consent.category
       from consent_events as consent
       join channel_identities as identity
         on identity.id = consent.channel_identity_id
       where consent.action = 'revoke'
       order by identity.channel`,
    );
    expect(revokes.rows).toEqual([
      { category: 'newsletter', channel: 'messenger' },
      { category: 'newsletter', channel: 'whatsapp' },
    ]);
  });

  test('serializes exact retry and stores one run, notification, and suppression per identity', async () => {
    const fixture = await createLinkedFixture('marketing-retry');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    const input = optOutInput(fixture, 'marketing-retry');

    const [left, right] = await Promise.all([policy.apply(input), policy.apply(input)]);

    expect([left.status, right.status].sort()).toEqual(['applied', 'duplicate']);
    const counts = await pool.query(
      `select
         (select count(*)::int from privacy_marketing_opt_out_runs) as runs,
         (select count(*)::int from privacy_notification_intents) as notifications,
         (select count(*)::int from privacy_suppressions
          where category like 'marketing_opt_out:%') as suppressions`,
    );
    expect(counts.rows).toEqual([{ notifications: 1, runs: 1, suppressions: 8 }]);
  });

  test('rejects request-key reuse for a different authoritative source', async () => {
    const fixture = await createLinkedFixture('marketing-conflict');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    await policy.apply(optOutInput(fixture, 'marketing-conflict'));
    const otherSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'marketing-conflict-other-source',
      identity: whatsappIdentity,
      messageText: 'STOP MARKETING',
      occurredAt: new Date('2026-08-31T06:02:00.000Z'),
    });

    await expect(
      policy.apply({
        effectiveAt: new Date('2026-08-31T06:02:00.000Z'),
        requestKey: 'marketing-conflict',
        sourceWebhookEventId: otherSource.eventId,
      }),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });

  test('does not merge or suppress a different contact', async () => {
    const fixture = await createLinkedFixture('marketing-contact-isolation');
    const outsiderIdentity = {
      channel: 'messenger',
      channelAccountId: 'ACCOUNT_TEST_marketing_outsider',
      externalContactId: 'CONTACT_TEST_marketing_outsider',
    } as const;
    await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'marketing-contact-isolation-outsider',
      identity: outsiderIdentity,
      messageText: 'Synthetic non-command message',
      occurredAt: new Date('2026-08-31T06:03:00.000Z'),
    });
    await seedGrant(
      outsiderIdentity,
      'security_updates',
      '06:03:01',
      'marketing-contact-isolation-outsider',
    );

    await new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply(
      optOutInput(fixture, 'marketing-contact-isolation'),
    );

    await expect(
      new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).evaluateMarketingEligibility(
        outsiderIdentity,
        'security_updates',
        new Date('2026-08-31T06:04:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
    await expect(pool.query(`select count(*)::int as count from contacts`)).resolves.toMatchObject({
      rows: [{ count: 2 }],
    });
  });

  test('global suppression overrides grants across retained key versions', async () => {
    const fixture = await createLinkedFixture('marketing-precedence');
    await new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply(
      optOutInput(fixture, 'marketing-precedence'),
    );
    const rotatedKeyring = {
      activeVersion: 'TEST_v2',
      keys: new Map([
        ['TEST_v1', syntheticPrivacyKeyring.keys.get('TEST_v1') ?? Buffer.alloc(32)],
        ['TEST_v2', Buffer.alloc(32, 0x62)],
      ]),
    } satisfies PrivacyHmacKeyring;
    await new PostgresConsentPolicy(pool, rotatedKeyring).recordReviewerCommand(
      {
        action: 'grant',
        category: 'security_updates',
        idempotencyKey: 'marketing-precedence-later-grant',
        identity: messengerIdentity,
        source: 'reviewer_recorded',
        sourceAt: new Date('2026-08-31T06:05:00.000Z'),
        wording: 'Synthetic approved marketing consent',
        wordingVersion: 'TEST_v2',
      },
      reviewer,
    );

    await expect(
      new PostgresConsentPolicy(pool, rotatedKeyring).evaluateMarketingEligibility(
        messengerIdentity,
        'security_updates',
        new Date('2026-08-31T06:10:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'global_marketing_opt_out' });
  });

  test('rolls all revokes and suppressions back if notification insertion fails', async () => {
    const fixture = await createLinkedFixture('marketing-notification-rollback');
    await pool.query(`
      create function reject_synthetic_marketing_notification()
      returns trigger language plpgsql as $$
      begin
        raise exception using errcode = '23514', message = 'synthetic notification failure';
      end;
      $$;
      create trigger reject_synthetic_marketing_notification
        before insert on privacy_notification_intents
        for each row execute function reject_synthetic_marketing_notification();
    `);

    try {
      await expect(
        new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply(
          optOutInput(fixture, 'marketing-notification-rollback'),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const counts = await pool.query(
        `select
           (select count(*)::int from privacy_marketing_opt_out_runs) as runs,
           (select count(*)::int from privacy_suppressions) as suppressions,
           (select count(*)::int from consent_events
            where action = 'revoke') as revokes`,
      );
      expect(counts.rows).toEqual([{ revokes: 0, runs: 0, suppressions: 0 }]);
    } finally {
      await pool.query(`
        drop trigger reject_synthetic_marketing_notification
          on privacy_notification_intents;
        drop function reject_synthetic_marketing_notification();
      `);
    }
  });

  test('explicit re-opt-in clears every retained-key suppression only in selected scope', async () => {
    const fixture = await createLinkedFixture('marketing-reopt-in');
    const rotatedKeyring = {
      activeVersion: 'TEST_v2',
      keys: new Map([
        ['TEST_v1', syntheticPrivacyKeyring.keys.get('TEST_v1') ?? Buffer.alloc(32)],
        ['TEST_v2', Buffer.alloc(32, 0x63)],
      ]),
    } satisfies PrivacyHmacKeyring;
    await new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring).apply(
      optOutInput(fixture, 'marketing-reopt-in-opt-out'),
    );
    const secondSource = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'marketing-reopt-in-second-source',
      identity: whatsappIdentity,
      messageText: 'STOP MARKETING',
      occurredAt: new Date('2026-08-31T06:01:00.000Z'),
    });
    await new PostgresMarketingOptOutPolicy(pool, rotatedKeyring).apply({
      effectiveAt: new Date('2026-08-31T06:01:00.000Z'),
      requestKey: 'marketing-reopt-in-rotation-refresh',
      sourceWebhookEventId: secondSource.eventId,
    });
    await expect(
      new PostgresConsentPolicy(pool, rotatedKeyring).evaluateMarketingEligibility(
        messengerIdentity,
        'security_updates',
        new Date('2026-08-31T06:02:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'global_marketing_opt_out' });
    const policy = new PostgresMarketingOptOutPolicy(pool, rotatedKeyring);
    const reOptInCommand = {
      categories: ['security_updates'],
      effectiveAt: new Date('2026-08-31T06:20:00.000Z'),
      identity: messengerIdentity,
      requestKey: 'marketing-reopt-in-selected',
      scope: 'source_identity',
      verificationMethod: 'same_channel_context',
    } as const;

    await expect(policy.recordExplicitReoptIn(reOptInCommand, reviewer)).resolves.toEqual({
      categoryGrants: 1,
      linkedIdentities: 1,
      status: 'applied',
      suppressionsCleared: 2,
    });
    await expect(policy.recordExplicitReoptIn(reOptInCommand, reviewer)).resolves.toMatchObject({
      status: 'duplicate',
      suppressionsCleared: 2,
    });
    await expect(
      policy.recordExplicitReoptIn({ ...reOptInCommand, categories: ['newsletter'] }, reviewer),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
    await expect(
      new PostgresConsentPolicy(pool, rotatedKeyring).evaluateMarketingEligibility(
        messengerIdentity,
        'security_updates',
        new Date('2026-08-31T06:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
    await expect(
      new PostgresConsentPolicy(pool, rotatedKeyring).evaluateMarketingEligibility(
        whatsappIdentity,
        'security_updates',
        new Date('2026-08-31T06:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'global_marketing_opt_out' });
  });

  test('category-scoped re-opt-in keeps every unselected category suppressed', async () => {
    const fixture = await createLinkedFixture('marketing-reopt-in-category-isolation');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    const consent = new PostgresConsentPolicy(pool, syntheticPrivacyKeyring);
    await policy.apply(optOutInput(fixture, 'marketing-reopt-in-category-isolation-opt-out'));
    await seedGrant(
      messengerIdentity,
      'newsletter',
      '06:10:00',
      'marketing-reopt-in-category-isolation-later-grant',
    );

    await expect(
      policy.recordExplicitReoptIn(
        {
          categories: ['security_updates'],
          effectiveAt: new Date('2026-08-31T06:20:00.000Z'),
          identity: messengerIdentity,
          requestKey: 'marketing-reopt-in-category-isolation',
          scope: 'source_identity',
          verificationMethod: 'same_channel_context',
        },
        reviewer,
      ),
    ).resolves.toMatchObject({ status: 'applied' });

    await expect(
      consent.evaluateMarketingEligibility(
        messengerIdentity,
        'security_updates',
        new Date('2026-08-31T06:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
    await expect(
      consent.evaluateMarketingEligibility(
        messengerIdentity,
        'newsletter',
        new Date('2026-08-31T06:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'global_marketing_opt_out' });
  });

  test('future-effective re-opt-in remains suppressed until its effective time', async () => {
    const fixture = await createLinkedFixture('marketing-reopt-in-future');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    const consent = new PostgresConsentPolicy(pool, syntheticPrivacyKeyring);
    await policy.apply(optOutInput(fixture, 'marketing-reopt-in-future-opt-out'));
    await policy.recordExplicitReoptIn(
      {
        categories: ['security_updates'],
        effectiveAt: new Date('2026-08-31T07:00:00.000Z'),
        identity: messengerIdentity,
        requestKey: 'marketing-reopt-in-future',
        scope: 'source_identity',
        verificationMethod: 'same_channel_context',
      },
      reviewer,
    );

    await expect(
      consent.evaluateMarketingEligibility(
        messengerIdentity,
        'security_updates',
        new Date('2026-08-31T06:30:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'global_marketing_opt_out' });
    await expect(
      consent.evaluateMarketingEligibility(
        messengerIdentity,
        'security_updates',
        new Date('2026-08-31T07:00:00.001Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
  });

  test('rejects unauthorized re-opt-in without clearing suppression', async () => {
    const fixture = await createLinkedFixture('marketing-reopt-in-unauthorized');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    await policy.apply(optOutInput(fixture, 'marketing-reopt-in-unauthorized-opt-out'));

    await expect(
      policy.recordExplicitReoptIn(
        {
          categories: ['security_updates'],
          effectiveAt: new Date('2026-08-31T06:20:00.000Z'),
          identity: messengerIdentity,
          requestKey: 'marketing-reopt-in-unauthorized',
          scope: 'all_linked_identities',
          verificationMethod: 'same_channel_context',
        },
        { reviewerRef: 'REVIEWER_TEST_unauthorized', roles: ['incident_reader'] },
      ),
    ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });
    const counts = await pool.query(
      `select
         (select count(*)::int from privacy_suppressions) as suppressions,
         (select count(*)::int from privacy_marketing_reopt_in_runs) as runs`,
    );
    expect(counts.rows).toEqual([{ runs: 0, suppressions: 8 }]);
  });

  test('explicit all-linked re-opt-in clears and grants every selected identity atomically', async () => {
    const fixture = await createLinkedFixture('marketing-reopt-in-all-linked');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    await policy.apply(optOutInput(fixture, 'marketing-reopt-in-all-linked-opt-out'));

    await expect(
      policy.recordExplicitReoptIn(
        {
          categories: ['product_updates'],
          effectiveAt: new Date('2026-08-31T06:20:00.000Z'),
          identity: whatsappIdentity,
          requestKey: 'marketing-reopt-in-all-linked',
          scope: 'all_linked_identities',
          verificationMethod: 'same_channel_context',
        },
        reviewer,
      ),
    ).resolves.toEqual({
      categoryGrants: 2,
      linkedIdentities: 2,
      status: 'applied',
      suppressionsCleared: 2,
    });
    await expect(
      new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).evaluateMarketingEligibility(
        messengerIdentity,
        'product_updates',
        new Date('2026-08-31T06:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
    await expect(
      new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).evaluateMarketingEligibility(
        whatsappIdentity,
        'product_updates',
        new Date('2026-08-31T06:21:00.000Z'),
      ),
    ).resolves.toEqual({ eligible: true, reason: 'consent_latest_grant' });
  });

  test('rolls suppression removal and category grants back if re-opt-in evidence fails', async () => {
    const fixture = await createLinkedFixture('marketing-reopt-in-rollback');
    const policy = new PostgresMarketingOptOutPolicy(pool, syntheticPrivacyKeyring);
    await policy.apply(optOutInput(fixture, 'marketing-reopt-in-rollback-opt-out'));
    await pool.query(`
      create function reject_synthetic_marketing_reopt_in()
      returns trigger language plpgsql as $$
      begin
        raise exception using errcode = '23514', message = 'synthetic re-opt-in failure';
      end;
      $$;
      create trigger reject_synthetic_marketing_reopt_in
        before insert on privacy_marketing_reopt_in_runs
        for each row execute function reject_synthetic_marketing_reopt_in();
    `);

    try {
      await expect(
        policy.recordExplicitReoptIn(
          {
            categories: ['security_updates'],
            effectiveAt: new Date('2026-08-31T06:20:00.000Z'),
            identity: messengerIdentity,
            requestKey: 'marketing-reopt-in-rollback',
            scope: 'all_linked_identities',
            verificationMethod: 'same_channel_context',
          },
          reviewer,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const counts = await pool.query(
        `select
           (select count(*)::int from privacy_suppressions) as suppressions,
           (select count(*)::int from privacy_marketing_reopt_in_runs) as runs,
           (select count(*)::int from consent_events
            where source = 'reviewer_recorded'
              and wording = 'EXPLICIT MARKETING RE-OPT-IN') as reviewer_grants`,
      );
      expect(counts.rows).toEqual([{ reviewer_grants: 0, runs: 0, suppressions: 8 }]);
    } finally {
      await pool.query(`
        drop trigger reject_synthetic_marketing_reopt_in
          on privacy_marketing_reopt_in_runs;
        drop function reject_synthetic_marketing_reopt_in();
      `);
    }
  });
});
