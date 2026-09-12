import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import { PostgresReplyDraftStore } from '../../src/persistence/postgres-reply-draft-store.js';
import { PostgresRetentionPolicy } from '../../src/persistence/postgres-retention-policy.js';
import type { PersistReplyDecisionInput } from '../../src/replies/reply-types.js';
import { safeResponse } from '../../src/safety/safe-responses.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let store: PostgresReplyDraftStore;

const evaluatedAt = new Date('2026-09-11T10:05:00.000Z');
const occurredAt = new Date('2026-09-11T10:00:00.000Z');
const editor = {
  reviewerRef: 'ADMIN_TEST_reply_editor',
  roles: ['knowledge_editor'],
} as const;
const reviewer = {
  reviewerRef: 'ADMIN_TEST_reply_reviewer',
  roles: ['knowledge_reviewer'],
} as const;
const policyOwner = {
  reviewerRef: 'OWNER_TEST_reply_retention',
  roles: ['policy_owner'],
} as const;

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_reply_draft_store');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(
    'truncate table contacts, webhook_receipts, knowledge_sources, knowledge_items restart identity cascade',
  );
  store = new PostgresReplyDraftStore(pool, syntheticPrivacyKeyring);
});

afterAll(async () => {
  await dispose?.();
});

function identity(key: string) {
  return {
    channel: 'messenger' as const,
    channelAccountId: 'PAGE_TEST_reply',
    externalContactId: `PSID_TEST_reply_${key}`,
  };
}

async function applied(key: string, messageText = 'How do I open a synthetic support request?') {
  const customerIdentity = identity(key);
  const result = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `reply_${key}`,
    identity: customerIdentity,
    messageText,
    occurredAt,
  });
  return { ...result, identity: customerIdentity };
}

async function publishFaq() {
  const repository = new PostgresKnowledgeRepository(pool);
  const publication = new PostgresKnowledgePublication(pool);
  await repository.createSource(
    {
      createdAt: new Date('2026-09-10T09:00:00.000Z'),
      createdByReference: editor.reviewerRef,
      label: 'Synthetic reply decision FAQ source',
      sourceRef: 'SOURCE_TEST_reply_faq',
      sourceType: 'manual_business',
    },
    editor,
  );
  await repository.createProposal(
    {
      aliases: [],
      answers: {
        bn: 'সিনথেটিক পর্যালোচিত সহায়তা উত্তর।',
        en: 'Synthetic reviewed support answer.',
      },
      authorReference: editor.reviewerRef,
      contentSha256: '1'.repeat(64),
      createdAt: new Date('2026-09-10T09:01:00.000Z'),
      itemKey: 'faq.synthetic.reply',
      kind: 'faq',
      questions: {
        bn: 'আমি কীভাবে সিনথেটিক সহায়তা অনুরোধ খুলব?',
        en: 'How do I open a synthetic support request?',
      },
      requestKey: 'REQUEST_TEST_reply_faq_proposal',
      sourceRef: 'SOURCE_TEST_reply_faq',
      sourceSha256: '2'.repeat(64),
      tags: ['synthetic'],
      versionRef: 'VERSION_TEST_reply_faq',
    },
    editor,
  );
  await publication.submitVersion(
    {
      action: 'submit',
      effectiveAt: new Date('2026-09-10T09:02:00.000Z'),
      reasonCode: 'ready_for_review',
      requestKey: 'REQUEST_TEST_reply_faq_submit',
      reviewerReference: editor.reviewerRef,
      versionRef: 'VERSION_TEST_reply_faq',
    },
    editor,
  );
  await publication.reviewVersion(
    {
      action: 'approve',
      effectiveAt: new Date('2026-09-10T09:03:00.000Z'),
      reasonCode: 'business_fact_verified',
      requestKey: 'REQUEST_TEST_reply_faq_approve',
      reviewerReference: reviewer.reviewerRef,
      versionRef: 'VERSION_TEST_reply_faq',
    },
    reviewer,
  );
  await publication.publishVersion(
    {
      action: 'publish',
      effectiveAt: new Date('2026-09-10T09:04:00.000Z'),
      itemKey: 'faq.synthetic.reply',
      reasonCode: 'initial_publication',
      requestKey: 'REQUEST_TEST_reply_faq_publish',
      reviewerReference: reviewer.reviewerRef,
      versionRef: 'VERSION_TEST_reply_faq',
    },
    reviewer,
  );
}

function faqDecision(webhookEventId: string, requestKey: string): PersistReplyDecisionInput {
  return {
    answerText: 'Synthetic reviewed support answer.',
    evaluatedAt,
    itemReference: 'faq.synthetic.reply',
    kind: 'faq',
    language: 'en',
    requestKey,
    versionReference: 'VERSION_TEST_reply_faq',
    webhookEventId,
  };
}

describe('Postgres reply draft store', () => {
  test('claims only applied customer events and returns content without persisting a claim', async () => {
    const source = await applied('claim');
    await expect(
      store.claimDecision({
        evaluatedAt,
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_claim',
        webhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({
      status: 'claimed',
      source: {
        conversationId: source.conversationId,
        messageText: 'How do I open a synthetic support request?',
        occurredAt,
        webhookEventId: source.eventId,
      },
    });

    const pendingId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_reply',
      contactId: 'PSID_TEST_reply_pending',
      eventKind: 'customer_message',
      fixtureKey: 'reply_pending',
      messageText: 'Synthetic unapplied request',
      occurredAt,
    });
    await expect(
      store.claimDecision({
        evaluatedAt,
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_pending',
        webhookEventId: pendingId,
      }),
    ).resolves.toEqual({ status: 'not_processable' });
  });

  test('stores an effective FAQ answer/reference exactly once and rejects conflicting replay', async () => {
    await publishFaq();
    const source = await applied('faq');
    const decision = faqDecision(source.eventId, 'REQUEST_TEST_reply_faq_decision');

    await expect(store.persistDecision(decision)).resolves.toMatchObject({
      status: 'created',
      decisionType: 'faq',
      nextAction: 'none',
    });
    await expect(store.persistDecision(decision)).resolves.toMatchObject({
      status: 'duplicate',
      decisionType: 'faq',
      nextAction: 'none',
    });
    await expect(
      store.persistDecision({ ...decision, requestKey: 'REQUEST_TEST_reply_faq_conflict' }),
    ).rejects.toMatchObject({ name: 'ReplyDecisionConflictError' });

    const rows = await pool.query(
      `select draft.decision_type, draft.answer_text, draft.state,
              version.version_ref, link.reference_kind
       from support_reply_drafts as draft
       join knowledge_versions as version on version.id = draft.knowledge_version_id
       join support_reply_draft_knowledge as link on link.draft_id = draft.id
       where draft.source_webhook_event_id = $1`,
      [source.eventId],
    );
    expect(rows.rows).toEqual([
      {
        answer_text: 'Synthetic reviewed support answer.',
        decision_type: 'faq',
        reference_kind: 'faq_answer',
        state: 'ready',
        version_ref: 'VERSION_TEST_reply_faq',
      },
    ]);
  });

  test('serializes concurrent FAQ persistence into created plus duplicate', async () => {
    await publishFaq();
    const source = await applied('concurrent');
    const decision = faqDecision(source.eventId, 'REQUEST_TEST_reply_concurrent');

    const results = await Promise.all([
      store.persistDecision(decision),
      store.persistDecision(decision),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(['created', 'duplicate']);
    const count = await pool.query<{ count: number }>(
      'select count(*)::int as count from support_reply_drafts where source_webhook_event_id = $1',
      [source.eventId],
    );
    expect(count.rows).toEqual([{ count: 1 }]);
  });

  test('stores a sensitive-data safe draft and one linked escalation atomically', async () => {
    const source = await applied('sensitive', 'Card number is 4111 1111 1111 1111');
    const decision: PersistReplyDecisionInput = {
      answerText: safeResponse('en', 'sensitive_data_blocked'),
      escalationReasonCode: 'sensitive_data_blocked',
      evaluatedAt,
      kind: 'safe_failure',
      language: 'en',
      requestKey: 'REQUEST_TEST_reply_sensitive',
      webhookEventId: source.eventId,
    };

    await expect(store.persistDecision(decision)).resolves.toMatchObject({
      status: 'created',
      decisionType: 'safe_failure',
      nextAction: 'none',
    });
    await expect(store.persistDecision(decision)).resolves.toMatchObject({ status: 'duplicate' });
    const rows = await pool.query(
      `select draft.decision_type, draft.answer_text,
              escalation.reason_code, escalation.state
       from support_reply_drafts as draft
       join support_escalation_outcomes as escalation on escalation.reply_draft_id = draft.id
       where draft.source_webhook_event_id = $1`,
      [source.eventId],
    );
    expect(rows.rows).toEqual([
      {
        answer_text: safeResponse('en', 'sensitive_data_blocked'),
        decision_type: 'safe_failure',
        reason_code: 'sensitive_data_blocked',
        state: 'open',
      },
    ]);
  });

  test.each([
    ['faq_miss', 'No reviewed FAQ matched.'],
    ['faq_ambiguous', 'Reviewed FAQ candidates need disambiguation.'],
  ] as const)(
    'records one content-minimized %s gap for the later model boundary',
    async (gapKind, summary) => {
      const source = await applied(`gap_${gapKind}`);
      const decision: PersistReplyDecisionInput = {
        evaluatedAt,
        gapKind,
        kind: 'model_required',
        language: 'en',
        requestKey: `REQUEST_TEST_reply_${gapKind}`,
        webhookEventId: source.eventId,
      };

      await expect(store.persistDecision(decision)).resolves.toMatchObject({
        status: 'created',
        decisionType: 'model_required',
        nextAction: 'model_required',
      });
      const rows = await pool.query(
        `select gap_kind, sanitized_summary, erased_at
       from knowledge_gap_observations where source_webhook_event_id = $1`,
        [source.eventId],
      );
      expect(rows.rows).toEqual([
        { erased_at: null, gap_kind: gapKind, sanitized_summary: summary },
      ]);
      const drafts = await pool.query<{ count: number }>(
        'select count(*)::int as count from support_reply_drafts',
      );
      expect(drafts.rows).toEqual([{ count: 0 }]);
    },
  );

  test('lets an active human pause created after claim block final persistence', async () => {
    const source = await applied('pause_race');
    await expect(
      store.claimDecision({
        evaluatedAt,
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_pause',
        webhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
    const echoEventId = await insertSyntheticPendingEvent(pool, {
      channel: source.identity.channel,
      channelAccountId: source.identity.channelAccountId,
      contactId: source.identity.externalContactId,
      eventKind: 'business_message_echo',
      fixtureKey: 'reply_pause_race_echo',
      messageText: 'Synthetic human reply excluded from model input',
      occurredAt: new Date('2026-09-11T10:01:00.000Z'),
    });
    await expect(
      new PostgresConversationEventProcessor(pool).processEvent(echoEventId),
    ).resolves.toMatchObject({
      conversationId: source.conversationId,
      outcome: 'business_echo_paused',
      status: 'applied',
    });

    await expect(
      store.persistDecision(faqDecision(source.eventId, 'REQUEST_TEST_reply_pause')),
    ).resolves.toEqual({ status: 'policy_blocked', reasonCode: 'pause_active' });
    await expect(pool.query('select id from support_reply_drafts')).resolves.toMatchObject({
      rows: [],
    });
  });

  test('lets an open privacy request created after claim block final persistence', async () => {
    const source = await applied('privacy_race', 'REQUEST MY DATA');
    await store.claimDecision({
      evaluatedAt,
      language: 'en',
      requestKey: 'REQUEST_TEST_reply_privacy',
      webhookEventId: source.eventId,
    });
    await expect(
      new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring).processAppliedEvent({
        requestKey: 'REQUEST_TEST_reply_privacy_hold',
        sourceWebhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ intent: 'access', status: 'opened' });

    await expect(
      store.persistDecision({
        answerText: safeResponse('en', 'sensitive_data_blocked'),
        escalationReasonCode: 'sensitive_data_blocked',
        evaluatedAt,
        kind: 'safe_failure',
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_privacy',
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ status: 'policy_blocked', reasonCode: 'privacy_request_open' });
    const counts = await pool.query(
      `select (select count(*)::int from support_reply_drafts) as drafts,
              (select count(*)::int from support_escalation_outcomes) as escalations`,
    );
    expect(counts.rows).toEqual([{ drafts: 0, escalations: 0 }]);
  });

  test('lets a retained deletion tombstone created after claim block final persistence', async () => {
    const source = await applied('deletion_race');
    await store.claimDecision({
      evaluatedAt,
      language: 'en',
      requestKey: 'REQUEST_TEST_reply_deletion',
      webhookEventId: source.eventId,
    });
    const key = syntheticPrivacyKeyring.keys.get(syntheticPrivacyKeyring.activeVersion);
    if (key === undefined) throw new Error('Synthetic privacy key missing');
    await pool.query(
      `insert into privacy_suppressions
        (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1, 'messenger', 'deletion_tombstone', 'customer_deletion', $2, $3)`,
      [
        createIdentityHmac(source.identity, {
          key,
          version: syntheticPrivacyKeyring.activeVersion,
        }),
        evaluatedAt,
        syntheticPrivacyKeyring.activeVersion,
      ],
    );

    await expect(
      store.persistDecision({
        evaluatedAt,
        gapKind: 'faq_miss',
        kind: 'model_required',
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_deletion',
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ status: 'policy_blocked', reasonCode: 'identity_deleted' });
    await expect(pool.query('select id from knowledge_gap_observations')).resolves.toMatchObject({
      rows: [],
    });
  });

  test.each([
    ['retention_expired', 'expires_at = $2'],
    ['content_purged', 'content_purged_through_at = $2'],
  ] as const)(
    'lets a %s retention race block final persistence',
    async (reasonCode, assignment) => {
      const source = await applied(`retention_${reasonCode}`);
      await store.claimDecision({
        evaluatedAt,
        language: 'en',
        requestKey: `REQUEST_TEST_reply_${reasonCode}`,
        webhookEventId: source.eventId,
      });
      await pool.query(
        `update conversation_retention_states set ${assignment} where conversation_id = $1`,
        [source.conversationId, reasonCode === 'retention_expired' ? evaluatedAt : occurredAt],
      );

      await expect(
        store.persistDecision({
          evaluatedAt,
          gapKind: 'faq_miss',
          kind: 'model_required',
          language: 'en',
          requestKey: `REQUEST_TEST_reply_${reasonCode}`,
          webhookEventId: source.eventId,
        }),
      ).resolves.toEqual({ status: 'policy_blocked', reasonCode });
    },
  );

  test('returns a policy block when retention erases the source after claim', async () => {
    const source = await applied('purged_source_race');
    await expect(
      store.claimDecision({
        evaluatedAt,
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_purged_source',
        webhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
    await pool.query('update webhook_events set message_text = null where id = $1', [
      source.eventId,
    ]);
    await pool.query(
      `update conversation_retention_states
       set content_purged_through_at = $2 where conversation_id = $1`,
      [source.conversationId, occurredAt],
    );

    await expect(
      store.persistDecision({
        evaluatedAt,
        gapKind: 'faq_miss',
        kind: 'model_required',
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_purged_source',
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ status: 'policy_blocked', reasonCode: 'content_purged' });
  });

  test('supports open active clients using their required review boundary', async () => {
    const source = await applied('active_client');
    await new PostgresRetentionPolicy(pool).startActiveRelationship(
      {
        conversationId: source.conversationId,
        effectiveAt: evaluatedAt,
        relationshipStartedAt: occurredAt,
        requestKey: 'REQUEST_TEST_reply_active_start',
      },
      policyOwner,
    );

    await expect(
      store.persistDecision({
        evaluatedAt,
        gapKind: 'faq_miss',
        kind: 'model_required',
        language: 'en',
        requestKey: 'REQUEST_TEST_reply_active_gap',
        webhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ status: 'created' });
    const stored = await pool.query(
      `select retention_deadline from knowledge_gap_observations
       where source_webhook_event_id = $1`,
      [source.eventId],
    );
    expect(stored.rows).toEqual([{ retention_deadline: new Date('2027-09-11T10:05:00.000Z') }]);
  });
});
