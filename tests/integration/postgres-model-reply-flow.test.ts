import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ManifestClient,
  ManifestClientResult,
  ManifestCompleteInput,
} from '../../src/model/manifest-client.js';
import type { ModelPolicyValues } from '../../src/model/model-policy-types.js';
import type {
  ModelDeploymentCeilings,
  ModelOperationalLimits,
} from '../../src/model/model-types.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PostgresModelAllowance } from '../../src/persistence/postgres-model-allowance.js';
import { PostgresModelPolicy } from '../../src/persistence/postgres-model-policy.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import { PostgresReplyDraftStore } from '../../src/persistence/postgres-reply-draft-store.js';
import {
  createModelLogicalCallKey,
  ModelReplyService,
} from '../../src/replies/model-reply-service.js';
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
let policy: PostgresModelPolicy;
let allowance: PostgresModelAllowance;

const baseAt = new Date('2026-09-13T09:00:00.000Z');
const evaluatedAt = new Date('2026-09-13T09:01:00.000Z');
const administrator = {
  reviewerRef: 'ADMIN_TEST_model_flow',
  roles: ['administrator'],
} as const;
const editor = {
  reviewerRef: 'ADMIN_TEST_model_flow_editor',
  roles: ['knowledge_editor'],
} as const;
const reviewer = {
  reviewerRef: 'ADMIN_TEST_model_flow_reviewer',
  roles: ['knowledge_reviewer'],
} as const;
const policyValues: ModelPolicyValues = {
  approvedProviderAttempts: 1,
  architectureProviderCeiling: 1,
  concurrentCalls: 2,
  cooldownMs: 0,
  faqAmbiguityMargin: 0.05,
  faqMinimumSimilarity: 0.7,
  globalUtcDayCalls: 20,
  maximumFaqCandidates: 4,
  outputTokens: 77,
  perContact15MinuteCalls: 3,
  perContact24HourCalls: 10,
  queueCapacity: 2,
  totalTimeoutMs: 1000,
};
const operational: ModelOperationalLimits = {
  concurrentCalls: policyValues.concurrentCalls,
  cooldownMs: policyValues.cooldownMs,
  globalUtcDayCalls: policyValues.globalUtcDayCalls,
  outputTokens: policyValues.outputTokens,
  perContact15MinuteCalls: policyValues.perContact15MinuteCalls,
  perContact24HourCalls: policyValues.perContact24HourCalls,
  providerAttempts: policyValues.approvedProviderAttempts,
  queueCapacity: policyValues.queueCapacity,
  totalTimeoutMs: policyValues.totalTimeoutMs,
};
const deployment: ModelDeploymentCeilings = {
  ...operational,
  architectureProviderConnections: 1,
  contextItems: 4,
  inputCodePoints: 2000,
  responseBytes: 4096,
};
const attestation = { operationalLimits: operational, verified: true as const };

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_model_reply_flow');
  pool = database.pool;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(
    `truncate table contacts, webhook_receipts, knowledge_sources, knowledge_items,
       model_policy_versions, admin_accounts restart identity cascade`,
  );
  store = new PostgresReplyDraftStore(pool, syntheticPrivacyKeyring);
  policy = new PostgresModelPolicy(pool);
  allowance = new PostgresModelAllowance(pool);
  await seedActivePolicy();
  await publishBusinessFact();
});

afterAll(async () => {
  await dispose?.();
});

async function seedActivePolicy(): Promise<void> {
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.model.flow', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x31), Buffer.alloc(32, 0x32), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2, 'REQUEST_TEST_model_flow_role')`,
    [account.rows[0]?.id, baseAt],
  );
  await policy.createPolicy(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_model_flow',
      requestKey: 'REQUEST_TEST_model_flow_policy',
      values: policyValues,
    },
    administrator,
  );
  for (const [index, action] of ['submit', 'approve', 'activate'].entries()) {
    await policy.transitionPolicy(
      {
        action,
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        policyRef: 'POLICY_TEST_model_flow',
        reasonCode: `${action}_reviewed`,
        requestKey: `REQUEST_TEST_model_flow_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
}

async function publishBusinessFact(): Promise<void> {
  const repository = new PostgresKnowledgeRepository(pool);
  const publication = new PostgresKnowledgePublication(pool);
  await repository.createSource(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByReference: editor.reviewerRef,
      label: 'Synthetic model flow facts',
      sourceRef: 'SOURCE_TEST_model_flow',
      sourceType: 'manual_business',
    },
    editor,
  );
  await repository.createProposal(
    {
      aliases: [],
      answers: {
        bn: 'সিনথেটিক পর্যালোচিত সহায়তা অনলাইনে পাওয়া যায়।',
        en: 'Synthetic reviewed support is available online.',
      },
      authorReference: editor.reviewerRef,
      contentSha256: '3'.repeat(64),
      createdAt: new Date(baseAt.getTime() + 2000),
      itemKey: 'business.synthetic.model-flow',
      kind: 'business_fact',
      requestKey: 'REQUEST_TEST_model_flow_fact',
      sourceRef: 'SOURCE_TEST_model_flow',
      sourceSha256: '4'.repeat(64),
      tags: ['synthetic'],
      versionRef: 'VERSION_TEST_model_flow',
    },
    editor,
  );
  await publication.submitVersion(
    {
      action: 'submit',
      effectiveAt: new Date(baseAt.getTime() + 3000),
      reasonCode: 'ready_for_review',
      requestKey: 'REQUEST_TEST_model_flow_fact_submit',
      reviewerReference: editor.reviewerRef,
      versionRef: 'VERSION_TEST_model_flow',
    },
    editor,
  );
  await publication.reviewVersion(
    {
      action: 'approve',
      effectiveAt: new Date(baseAt.getTime() + 4000),
      reasonCode: 'business_fact_verified',
      requestKey: 'REQUEST_TEST_model_flow_fact_approve',
      reviewerReference: reviewer.reviewerRef,
      versionRef: 'VERSION_TEST_model_flow',
    },
    reviewer,
  );
  await publication.publishVersion(
    {
      action: 'publish',
      effectiveAt: new Date(baseAt.getTime() + 5000),
      itemKey: 'business.synthetic.model-flow',
      reasonCode: 'initial_publication',
      requestKey: 'REQUEST_TEST_model_flow_fact_publish',
      reviewerReference: reviewer.reviewerRef,
      versionRef: 'VERSION_TEST_model_flow',
    },
    reviewer,
  );
}

async function gap(key: string, messageText = 'Where is synthetic reviewed support available?') {
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `model_flow_${key}`,
    identity: {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_model_flow',
      externalContactId: `PSID_TEST_model_flow_${key}`,
    },
    messageText,
    occurredAt: new Date(evaluatedAt.getTime() - 1000),
  });
  const requestKey = `REQUEST_TEST_model_flow_${key}`;
  await store.persistDecision({
    evaluatedAt,
    gapKind: 'faq_miss',
    kind: 'model_required',
    language: 'en',
    requestKey,
    webhookEventId: source.eventId,
  });
  return { ...source, requestKey };
}

function client(
  result: ManifestClientResult,
  beforeResult?: () => Promise<void>,
): { readonly complete: ReturnType<typeof vi.fn>; readonly manifest: ManifestClient } {
  const complete = vi.fn(async (): Promise<ManifestClientResult> => {
    await beforeResult?.();
    return result;
  });
  return { complete, manifest: { complete } };
}

function service(manifest: ManifestClient, now = new Date(evaluatedAt.getTime() + 500)) {
  return new ModelReplyService({
    allowance,
    deployment,
    manifest,
    manifestAttestation: attestation,
    now: () => now,
    policy,
    store,
  });
}

describe('PostgreSQL model reply flow', () => {
  test('uses customized limits and stores one grounded draft across exact replay', async () => {
    const source = await gap('grounded');
    const fake = client({
      status: 'completed',
      value: {
        answer: 'Synthetic reviewed support is available online.',
        decision: 'answer',
        knowledgeReferences: ['VERSION_TEST_model_flow'],
        language: 'en',
        needsHumanReview: false,
        reasonCode: 'published_knowledge_answer',
      },
    });
    const model = service(fake.manifest);
    const command = {
      evaluatedAt,
      language: 'en' as const,
      requestKey: source.requestKey,
      webhookEventId: source.eventId,
    };
    await expect(model.decide(command)).resolves.toMatchObject({
      decisionType: 'model',
      status: 'created',
    });
    await expect(model.decide(command)).resolves.toMatchObject({
      decisionType: 'model',
      status: 'duplicate',
    });
    expect(fake.complete).toHaveBeenCalledTimes(1);
    const calls = fake.complete.mock.calls as unknown as readonly [ManifestCompleteInput][];
    expect(calls[0]?.[0].request).toMatchObject({
      max_tokens: 77,
      model: 'auto',
      stream: false,
    });
    const counts = await pool.query(
      `select
         (select count(*)::int from model_call_leases) as calls,
         (select count(*)::int from support_reply_drafts) as drafts,
         (select count(*)::int from support_reply_draft_knowledge) as links,
         (select count(*)::int from knowledge_gap_observations) as gaps,
         (select count(*)::int from support_escalation_outcomes) as escalations`,
    );
    expect(counts.rows).toEqual([{ calls: 1, drafts: 1, escalations: 0, gaps: 1, links: 1 }]);
  });

  test('persists one deterministic safe draft and escalation for timeout', async () => {
    const source = await gap('timeout');
    const fake = client({ status: 'failed', reasonCode: 'timeout' });
    const model = service(fake.manifest);
    const command = {
      evaluatedAt,
      language: 'en' as const,
      requestKey: source.requestKey,
      webhookEventId: source.eventId,
    };
    await model.decide(command);
    await model.decide(command);
    expect(fake.complete).toHaveBeenCalledTimes(1);
    const rows = await pool.query(
      `select draft.answer_text, escalation.reason_code, lease.outcome_code
       from support_reply_drafts as draft
       join support_escalation_outcomes as escalation on escalation.reply_draft_id = draft.id
       join model_call_leases as lease on lease.source_webhook_event_id = draft.source_webhook_event_id`,
    );
    expect(rows.rows).toEqual([
      {
        answer_text: safeResponse('en', 'provider_unavailable'),
        outcome_code: 'timeout',
        reason_code: 'timeout',
      },
    ]);
  });

  test('does not retry a lease lost to crash and recovers with safe failure after expiry', async () => {
    const source = await gap('crash');
    const effective = await policy.resolveEffectivePolicy(evaluatedAt, deployment, attestation);
    if (effective.status !== 'enabled') throw new Error('Synthetic model policy unavailable');
    await allowance.acquireModelAllowance({
      conversationId: source.conversationId,
      effectivePolicy: effective,
      evaluatedAt,
      logicalCallKey: createModelLogicalCallKey(source.eventId),
      webhookEventId: source.eventId,
    });
    const fake = client({
      status: 'failed',
      reasonCode: 'network_failure',
    });
    const model = service(fake.manifest, new Date(evaluatedAt.getTime() + 2000));
    const command = {
      evaluatedAt,
      language: 'en' as const,
      requestKey: source.requestKey,
      webhookEventId: source.eventId,
    };
    await expect(model.decide(command)).resolves.toEqual({ status: 'in_progress' });
    await allowance.expireLeases(new Date(evaluatedAt.getTime() + 1000));
    await expect(model.decide(command)).resolves.toMatchObject({
      decisionType: 'safe_failure',
      status: 'created',
    });
    expect(fake.complete).not.toHaveBeenCalled();
    const counts = await pool.query(
      `select
         (select count(*)::int from model_call_leases) as calls,
         (select count(*)::int from support_reply_drafts) as drafts,
         (select count(*)::int from support_escalation_outcomes) as escalations`,
    );
    expect(counts.rows).toEqual([{ calls: 1, drafts: 1, escalations: 1 }]);
  });

  test('human takeover activated during inference blocks the final draft', async () => {
    const source = await gap('takeover');
    const echoId = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_model_flow',
      contactId: 'PSID_TEST_model_flow_takeover',
      eventKind: 'business_message_echo',
      fixtureKey: 'model_flow_takeover_echo',
      messageText: 'Synthetic human response excluded from model context',
      occurredAt: evaluatedAt,
    });
    const fake = client(
      {
        status: 'completed',
        value: {
          answer: 'Synthetic reviewed support is available online.',
          decision: 'answer',
          knowledgeReferences: ['VERSION_TEST_model_flow'],
          language: 'en',
          needsHumanReview: false,
          reasonCode: 'published_knowledge_answer',
        },
      },
      async () => {
        await new PostgresConversationEventProcessor(pool).processEvent(echoId);
      },
    );
    await expect(
      service(fake.manifest).decide({
        evaluatedAt,
        language: 'en',
        requestKey: source.requestKey,
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ reasonCode: 'pause_active', status: 'policy_blocked' });
    const state = await pool.query(
      `select
         (select count(*)::int from support_reply_drafts) as drafts,
         (select outcome_code from model_call_leases) as outcome`,
    );
    expect(state.rows).toEqual([{ drafts: 0, outcome: 'guard_blocked' }]);
  });

  test('privacy hold and deletion suppression win before allowance acquisition', async () => {
    const privacy = await gap('privacy', 'REQUEST MY DATA');
    await new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring).processAppliedEvent({
      requestKey: 'REQUEST_TEST_model_flow_privacy_hold',
      sourceWebhookEventId: privacy.eventId,
    });
    const privacyFake = client({ status: 'failed', reasonCode: 'network_failure' });
    await expect(
      service(privacyFake.manifest).decide({
        evaluatedAt,
        language: 'en',
        requestKey: privacy.requestKey,
        webhookEventId: privacy.eventId,
      }),
    ).resolves.toEqual({ reasonCode: 'privacy_request_open', status: 'policy_blocked' });

    const deleted = await gap('deleted');
    const key = syntheticPrivacyKeyring.keys.get(syntheticPrivacyKeyring.activeVersion);
    if (key === undefined) throw new Error('Synthetic privacy key missing');
    await pool.query(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1, 'messenger', 'deletion_tombstone', 'customer_deletion', $2, $3)`,
      [
        createIdentityHmac(
          {
            channel: 'messenger',
            channelAccountId: 'PAGE_TEST_model_flow',
            externalContactId: 'PSID_TEST_model_flow_deleted',
          },
          { key, version: syntheticPrivacyKeyring.activeVersion },
        ),
        evaluatedAt,
        syntheticPrivacyKeyring.activeVersion,
      ],
    );
    const deletionFake = client({ status: 'failed', reasonCode: 'network_failure' });
    await expect(
      service(deletionFake.manifest).decide({
        evaluatedAt,
        language: 'en',
        requestKey: deleted.requestKey,
        webhookEventId: deleted.eventId,
      }),
    ).resolves.toEqual({ reasonCode: 'identity_deleted', status: 'policy_blocked' });
    expect(privacyFake.complete).not.toHaveBeenCalled();
    expect(deletionFake.complete).not.toHaveBeenCalled();
    const leases = await pool.query<{ readonly count: number }>(
      'select count(*)::int as count from model_call_leases',
    );
    expect(leases.rows).toEqual([{ count: 0 }]);
  });

  test('sensitive source at model stage bypasses allowance and stores a safety escalation', async () => {
    const source = await gap('sensitive_late');
    await pool.query(
      `update webhook_events
       set message_text = 'Synthetic request with card number 4111 1111 1111 1111'
       where id = $1`,
      [source.eventId],
    );
    const fake = client({ status: 'failed', reasonCode: 'network_failure' });
    await expect(
      service(fake.manifest).decide({
        evaluatedAt,
        language: 'en',
        requestKey: source.requestKey,
        webhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ decisionType: 'safe_failure', status: 'created' });
    expect(fake.complete).not.toHaveBeenCalled();
    const state = await pool.query(
      `select
         (select count(*)::int from model_call_leases) as calls,
         (select reason_code from support_escalation_outcomes) as reason`,
    );
    expect(state.rows).toEqual([{ calls: 0, reason: 'sensitive_data_blocked' }]);
  });

  test('retirement during inference prevents a stale model fact from becoming a draft', async () => {
    const source = await gap('retired_fact');
    const fake = client(
      {
        status: 'completed',
        value: {
          answer: 'Synthetic reviewed support is available online.',
          decision: 'answer',
          knowledgeReferences: ['VERSION_TEST_model_flow'],
          language: 'en',
          needsHumanReview: false,
          reasonCode: 'published_knowledge_answer',
        },
      },
      async () => {
        await new PostgresKnowledgePublication(pool).retireItem(
          {
            action: 'retire',
            effectiveAt: new Date(evaluatedAt.getTime() + 100),
            itemKey: 'business.synthetic.model-flow',
            reasonCode: 'synthetic_retirement',
            requestKey: 'REQUEST_TEST_model_flow_retire_during_call',
            reviewerReference: reviewer.reviewerRef,
            versionRef: 'VERSION_TEST_model_flow',
          },
          reviewer,
        );
      },
    );
    await expect(
      service(fake.manifest).decide({
        evaluatedAt,
        language: 'en',
        requestKey: source.requestKey,
        webhookEventId: source.eventId,
      }),
    ).resolves.toMatchObject({ decisionType: 'safe_failure', status: 'created' });
    const rows = await pool.query(
      `select draft.decision_type, escalation.reason_code,
              (select count(*)::int from support_reply_draft_knowledge) as links
       from support_reply_drafts as draft
       join support_escalation_outcomes as escalation on escalation.reply_draft_id = draft.id`,
    );
    expect(rows.rows).toEqual([
      { decision_type: 'safe_failure', links: 0, reason_code: 'invalid_response' },
    ]);
  });

  test('direct unsupported model draft cannot bypass database grounding check', async () => {
    const source = await gap('direct_unsupported');
    const effective = await policy.resolveEffectivePolicy(evaluatedAt, deployment, attestation);
    if (effective.status !== 'enabled') throw new Error('Synthetic model policy unavailable');
    await allowance.acquireModelAllowance({
      conversationId: source.conversationId,
      effectivePolicy: effective,
      evaluatedAt,
      logicalCallKey: createModelLogicalCallKey(source.eventId),
      webhookEventId: source.eventId,
    });
    await expect(
      store.persistModelDecision({
        answerText: 'Synthetic reviewed support costs 999 BDT.',
        evaluatedAt: new Date(evaluatedAt.getTime() + 500),
        kind: 'model',
        knowledgeReferences: ['VERSION_TEST_model_flow'],
        language: 'en',
        requestKey: source.requestKey,
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ status: 'knowledge_changed' });
    const counts = await pool.query(
      `select
         (select count(*)::int from support_reply_drafts) as drafts,
         (select count(*)::int from support_escalation_outcomes) as escalations`,
    );
    expect(counts.rows).toEqual([{ drafts: 0, escalations: 0 }]);
  });

  test('direct model draft without an active authoritative lease is rejected', async () => {
    const source = await gap('no_lease');
    await expect(
      store.persistModelDecision({
        answerText: 'Synthetic reviewed support is available online.',
        evaluatedAt: new Date(evaluatedAt.getTime() + 500),
        kind: 'model',
        knowledgeReferences: ['VERSION_TEST_model_flow'],
        language: 'en',
        requestKey: source.requestKey,
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ status: 'not_processable' });
    const drafts = await pool.query<{ readonly count: number }>(
      'select count(*)::int as count from support_reply_drafts',
    );
    expect(drafts.rows).toEqual([{ count: 0 }]);
  });

  test('a deletion tombstone created during inference blocks final persistence', async () => {
    const source = await gap('deleted_during_call');
    const fake = client(
      {
        status: 'completed',
        value: {
          answer: 'Synthetic reviewed support is available online.',
          decision: 'answer',
          knowledgeReferences: ['VERSION_TEST_model_flow'],
          language: 'en',
          needsHumanReview: false,
          reasonCode: 'published_knowledge_answer',
        },
      },
      async () => {
        const key = syntheticPrivacyKeyring.keys.get(syntheticPrivacyKeyring.activeVersion);
        if (key === undefined) throw new Error('Synthetic privacy key missing');
        await pool.query(
          `insert into privacy_suppressions
             (identity_hmac, channel, category, reason_code, effective_at, key_version)
           values ($1, 'messenger', 'deletion_tombstone', 'customer_deletion', $2, $3)`,
          [
            createIdentityHmac(
              {
                channel: 'messenger',
                channelAccountId: 'PAGE_TEST_model_flow',
                externalContactId: 'PSID_TEST_model_flow_deleted_during_call',
              },
              { key, version: syntheticPrivacyKeyring.activeVersion },
            ),
            new Date(evaluatedAt.getTime() + 100),
            syntheticPrivacyKeyring.activeVersion,
          ],
        );
      },
    );
    await expect(
      service(fake.manifest).decide({
        evaluatedAt,
        language: 'en',
        requestKey: source.requestKey,
        webhookEventId: source.eventId,
      }),
    ).resolves.toEqual({ reasonCode: 'identity_deleted', status: 'policy_blocked' });
    const counts = await pool.query(
      `select
         (select count(*)::int from support_reply_drafts) as drafts,
         (select outcome_code from model_call_leases) as outcome`,
    );
    expect(counts.rows).toEqual([{ drafts: 0, outcome: 'guard_blocked' }]);
  });
});
