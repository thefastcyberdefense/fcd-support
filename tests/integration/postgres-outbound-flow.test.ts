import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { readPreparedOutboundRequest } from '../../src/outbound/outbound-request.js';
import {
  OutboundWorker,
  type OutboundWorkerProvider,
  type OutboundWorkerStore,
} from '../../src/outbound/outbound-worker.js';
import type {
  OutboundDeploymentBounds,
  OutboundPolicyValues,
  OutboundProviderResult,
} from '../../src/outbound/outbound-types.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { PostgresOutboundIntentStore } from '../../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundTemplate } from '../../src/persistence/postgres-outbound-template.js';
import { PostgresOutboundWorkStore } from '../../src/persistence/postgres-outbound-work-store.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';
import { createOutboundRuntime } from '../../src/operations/outbound-runtime.js';
import { noopSafeLogger } from '../../src/logging.js';
import { syntheticOutboundRuntimeEnvironment } from '../helpers/outbound-runtime-fixtures.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let connectionString: string;

const baseAt = new Date('2026-09-17T00:00:00.000Z');
const workAt = new Date('2026-09-17T03:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_flow',
  roles: ['administrator'],
};
const generous = Object.freeze({
  global1Minute: 100,
  globalUtcDay: 10_000,
  leaseMs: 30_000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 100,
  perContact15Minute: 100,
  perContact24Hour: 1000,
  providerTimeoutMs: 8000,
  retryBaseMs: 1000,
  retryMaximumMs: 8000,
  whatsappAccount1Minute: 100,
  workerBatchSize: 20,
}) satisfies OutboundDeploymentBounds;

interface FlowFixture {
  readonly contactId: string;
  readonly conversationId: string;
  readonly draftRef: string;
  readonly eventId: string;
  readonly identity: {
    readonly channel: 'messenger' | 'whatsapp';
    readonly channelAccountId: string;
    readonly externalContactId: string;
  };
  readonly intentRef: string;
}

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_outbound_flow');
  pool = database.pool;
  connectionString = database.connectionString;
  dispose = database.dispose;
});

beforeEach(async () => {
  await pool.query(`
    truncate table
      contacts, webhook_receipts, privacy_suppressions, privacy_requests,
      outbound_echo_correlation_holds, outbound_status_events,
      outbound_escalation_outcomes, outbound_attempts, outbound_intents,
      outbound_rate_windows, outbound_template_review_events,
      outbound_template_versions, outbound_policy_review_events,
      outbound_policy_versions, knowledge_sources, knowledge_items, admin_accounts
    restart identity cascade
  `);
  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.outbound.flow', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x79), Buffer.alloc(32, 0x7a), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_flow_admin_role')`,
    [account.rows[0]?.id, baseAt],
  );
});

afterAll(async () => {
  await dispose?.();
});

async function seedPolicy(values: OutboundPolicyValues = generous): Promise<void> {
  const policies = new PostgresOutboundPolicy(pool);
  await policies.createVersion(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_outbound_flow',
      requestKey: 'REQUEST_TEST_outbound_flow_policy_create',
      values,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await policies[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        policyRef: 'POLICY_TEST_outbound_flow',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_outbound_flow_policy_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
}

async function seedIntent(
  key: string,
  options: {
    readonly answerText?: string;
    readonly channel?: 'messenger' | 'whatsapp';
    readonly decisionType?: 'faq' | 'model' | 'safe_failure';
    readonly evaluatedAt?: Date;
  } = {},
): Promise<FlowFixture> {
  const evaluatedAt = options.evaluatedAt ?? workAt;
  const channel = options.channel ?? 'whatsapp';
  const identity = {
    channel,
    channelAccountId:
      channel === 'whatsapp' ? 'PHONE_TEST_outbound_flow' : 'PAGE_TEST_outbound_flow',
    externalContactId: `CONTACT_TEST_outbound_flow_${key}`,
  } as const;
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `outbound_flow_${key}`,
    identity,
    messageText: 'Synthetic customer source excluded from outbound flow evidence.',
    occurredAt: new Date(evaluatedAt.getTime() - 60 * 60 * 1000),
  });
  const knowledgeVersionId =
    options.decisionType === 'faq' ? await seedPublishedFaqVersion(key) : null;
  const draftRef = `DRAFT_TEST_outbound_flow_${key}`;
  await pool.query(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, knowledge_version_id, state, retention_deadline,
        request_key, created_at)
     values ($1,$2,$3,$4,'en',$5,$6,'ready',$7,$8,$9)`,
    [
      draftRef,
      source.eventId,
      source.conversationId,
      options.decisionType ?? 'safe_failure',
      options.answerText ?? 'Synthetic reviewed flow reply.',
      knowledgeVersionId,
      new Date(evaluatedAt.getTime() + 7 * 86_400_000),
      `REQUEST_TEST_outbound_flow_draft_${key}`,
      new Date(evaluatedAt.getTime() - 30 * 60 * 1000),
    ],
  );
  const created = await new PostgresOutboundIntentStore(
    pool,
    syntheticPrivacyKeyring,
    generous,
  ).createSupportIntent({
    draftRef,
    evaluatedAt,
    requestKey: `REQUEST_TEST_outbound_flow_intent_${key}`,
  });
  if (created.status !== 'created')
    throw new Error('Synthetic outbound flow intent was not created');
  const authority = await pool.query<{ readonly contact_id: string }>(
    `select identity.contact_id
     from outbound_intents as intent
     join channel_identities as identity on identity.id = intent.channel_identity_id
     where intent.intent_ref = $1`,
    [created.intentRef],
  );
  return {
    contactId: authority.rows[0]?.contact_id ?? '',
    conversationId: source.conversationId,
    draftRef,
    eventId: source.eventId,
    identity,
    intentRef: created.intentRef,
  };
}

async function seedPublishedFaqVersion(key: string): Promise<string> {
  const source = await pool.query<{ readonly id: string }>(
    `insert into knowledge_sources
       (source_ref, source_type, label, approved_url, active,
        created_by_reference, created_at, updated_at)
     values ($1,'manual_business',$2,null,true,$3,$4,$4)
     returning id`,
    [
      `SOURCE_TEST_outbound_flow_${key}`,
      'Synthetic outbound flow FAQ source',
      administrator.reviewerRef,
      baseAt,
    ],
  );
  const item = await pool.query<{ readonly id: string }>(
    `insert into knowledge_items (item_key, kind, created_at, updated_at)
     values ($1,'faq',$2,$2) returning id`,
    [`faq.synthetic.outbound_flow.${key}`, baseAt],
  );
  const sourceId = source.rows[0]?.id;
  const itemId = item.rows[0]?.id;
  if (sourceId === undefined || itemId === undefined) {
    throw new Error('Synthetic FAQ authority was not created');
  }
  const version = await pool.query<{ readonly id: string }>(
    `insert into knowledge_versions
       (version_ref, item_id, version_number, request_key, state,
        question_en, answer_en, question_bn, answer_bn, source_id,
        source_sha256, content_sha256, author_reference, created_at,
        submitted_at, decided_at)
     values ($1,$2,1,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,null,null)
     returning id`,
    [
      `VERSION_TEST_outbound_flow_${key}`,
      itemId,
      `REQUEST_TEST_outbound_flow_faq_${key}`,
      'What is the synthetic outbound flow?',
      'Synthetic reviewed flow reply.',
      'সিনথেটিক আউটবাউন্ড ফ্লো কী?',
      'সিনথেটিক পর্যালোচিত উত্তর।',
      sourceId,
      '1'.repeat(64),
      '2'.repeat(64),
      administrator.reviewerRef,
      baseAt,
    ],
  );
  const versionId = version.rows[0]?.id;
  if (versionId === undefined) throw new Error('Synthetic FAQ version was not created');
  await pool.query(
    `insert into knowledge_review_events
       (version_id, action, reviewer_reference, reason_code, request_key, effective_at)
     values
       ($1,'submit',$2,'ready_for_review',$3,$4),
       ($1,'approve',$2,'business_fact_verified',$5,$6)`,
    [
      versionId,
      administrator.reviewerRef,
      `REQUEST_TEST_outbound_flow_faq_submit_${key}`,
      new Date(baseAt.getTime() + 1000),
      `REQUEST_TEST_outbound_flow_faq_approve_${key}`,
      new Date(baseAt.getTime() + 2000),
    ],
  );
  await pool.query(
    `insert into knowledge_publication_events
       (item_id, version_id, action, reviewer_reference, reason_code,
        effective_at, request_key)
     values ($1,$2,'publish',$3,'initial_publication',$4,$5)`,
    [
      itemId,
      versionId,
      administrator.reviewerRef,
      new Date(baseAt.getTime() + 3000),
      `REQUEST_TEST_outbound_flow_faq_publish_${key}`,
    ],
  );
  return versionId;
}

async function seedMarketingIntent(key: string): Promise<FlowFixture> {
  const identity = {
    channel: 'whatsapp' as const,
    channelAccountId: 'PHONE_TEST_outbound_flow',
    externalContactId: `CONTACT_TEST_outbound_flow_${key}`,
  };
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `outbound_flow_${key}`,
    identity,
    messageText: 'Synthetic marketing preference source.',
    occurredAt: new Date(workAt.getTime() - 60 * 60 * 1000),
  });
  const authority = await pool.query<{
    readonly contact_id: string;
    readonly identity_id: string;
  }>(
    `select identity.contact_id, identity.id as identity_id
     from conversations as conversation
     join channel_identities as identity on identity.id = conversation.channel_identity_id
     where conversation.id = $1`,
    [source.conversationId],
  );
  const identityId = authority.rows[0]?.identity_id;
  if (identityId === undefined) throw new Error('Synthetic marketing identity is missing');
  await pool.query(
    `insert into consent_events
       (channel_identity_id, category, action, wording, wording_version,
        source, source_at, idempotency_key)
     values ($1,'newsletter','grant','Synthetic explicit consent wording','v1',
             'reviewer_recorded',$2,$3)`,
    [identityId, new Date(workAt.getTime() - 1000), `CONSENT_TEST_outbound_flow_${key}`],
  );
  const templateRef = `TEMPLATE_TEST_outbound_flow_${key}`;
  const templates = new PostgresOutboundTemplate(pool);
  await templates.createVersion(
    {
      category: 'marketing_news',
      channel: 'whatsapp',
      channelAccountId: identity.channelAccountId,
      contentSha256: 'e'.repeat(64),
      createdAt: new Date(baseAt.getTime() + 1000),
      locale: 'en_US',
      providerTemplateId: `META_TEMPLATE_TEST_${key}`,
      requestKey: `REQUEST_TEST_outbound_flow_template_${key}`,
      templateName: `synthetic_${key}`,
      templateRef,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await templates[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        reasonCode: 'reviewed_outbound_template',
        requestKey: `REQUEST_TEST_outbound_flow_template_${key}_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
        templateRef,
        versionNumber: 1,
      },
      administrator,
    );
  }
  const created = await new PostgresOutboundIntentStore(
    pool,
    syntheticPrivacyKeyring,
    generous,
  ).createFixedTemplateIntent({
    conversationId: source.conversationId,
    evaluatedAt: workAt,
    purpose: 'marketing_news',
    requestKey: `REQUEST_TEST_outbound_flow_intent_${key}`,
    templateRef,
  });
  if (created.status !== 'created') {
    throw new Error('Synthetic marketing outbound flow intent was not created');
  }
  return {
    contactId: authority.rows[0]?.contact_id ?? '',
    conversationId: source.conversationId,
    draftRef: '',
    eventId: source.eventId,
    identity,
    intentRef: created.intentRef,
  };
}

function workStore(bounds: OutboundDeploymentBounds = generous): PostgresOutboundWorkStore {
  return new PostgresOutboundWorkStore(pool, syntheticPrivacyKeyring, bounds);
}

function providerFrom(results: readonly (Error | OutboundProviderResult)[]) {
  const queue = [...results];
  const contexts: unknown[] = [];
  const provider: OutboundWorkerProvider = {
    send: vi.fn(({ request }) => {
      contexts.push(readPreparedOutboundRequest(request));
      const result = queue.shift();
      if (result instanceof Error) return Promise.reject(result);
      if (result === undefined) throw new Error('Synthetic provider result queue exhausted');
      return Promise.resolve(result);
    }),
  };
  return { contexts, provider };
}

function accepted(key: string): OutboundProviderResult {
  return { providerMessageId: `META_MESSAGE_TEST_flow_${key}`, status: 'accepted' };
}

function worker(
  provider: OutboundWorkerProvider,
  store: OutboundWorkerStore = workStore(),
): Pick<OutboundWorker, 'runBatch'> {
  let fixtureNow = workAt;
  const instance = new OutboundWorker({
    maximumResponseBytes: 8192,
    provider,
    store,
    now: () => fixtureNow,
  });
  return {
    runBatch: (input) => {
      fixtureNow = input.evaluatedAt;
      return instance.runBatch(input);
    },
  };
}

describe('PostgreSQL outbound worker flow', () => {
  test('enabled composed daemon uses the existing client and leased outbox with injected synthetic transport', async () => {
    await seedPolicy();
    const source = await seedIntent('daemon');
    await pool.query(
      "insert into operations_deployments (git_revision,schema_revision,recorded_at,status) values ($1,'000014',$2,'started')",
      ['c'.repeat(40), workAt],
    );
    const send = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            messaging_product: 'whatsapp',
            contacts: [
              {
                input: source.identity.externalContactId,
                wa_id: source.identity.externalContactId,
              },
            ],
            messages: [{ id: 'META_MESSAGE_TEST_daemon' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const runtime = await createOutboundRuntime({
      role: 'outbound',
      environment: syntheticOutboundRuntimeEnvironment(connectionString, generous),
      logger: noopSafeLogger,
      now: () => workAt,
      testTransports: { meta: send },
    });
    try {
      await runtime.start();
      for (let attempt = 0; attempt < 250; attempt++) {
        if (
          (
            await pool.query<{ state: string }>(
              'select state from outbound_intents where intent_ref=$1',
              [source.intentRef],
            )
          ).rows[0]?.state === 'provider_accepted'
        )
          break;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await pool.query('select state from outbound_intents where intent_ref=$1', [
          source.intentRef,
        ]),
      ).toMatchObject({ rows: [{ state: 'provider_accepted' }] });
    } finally {
      await runtime.stop();
    }
  });
  test('moves ready FAQ and model drafts through identical provider behavior', async () => {
    await seedPolicy();
    await seedIntent('model', { decisionType: 'model' });
    await seedIntent('faq', { decisionType: 'faq' });
    const fake = providerFrom([accepted('model'), accepted('faq')]);

    await expect(
      worker(fake.provider).runBatch({ evaluatedAt: workAt, workerRef: 'WORKER_TEST_flow' }),
    ).resolves.toMatchObject({
      accepted: 2,
      claimed: 2,
    });
    expect(fake.contexts).toHaveLength(2);
    expect(fake.contexts).toEqual([
      expect.objectContaining({ channel: 'whatsapp', messageKind: 'support_text' }),
      expect.objectContaining({ channel: 'whatsapp', messageKind: 'support_text' }),
    ]);
    await expect(
      pool.query(
        `select intent.state, attempt.state as attempt_state
         from outbound_intents as intent
         join outbound_attempts as attempt on attempt.intent_id = intent.id
         order by intent.id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { attempt_state: 'provider_accepted', state: 'provider_accepted' },
        { attempt_state: 'provider_accepted', state: 'provider_accepted' },
      ],
    });
  });

  test('concurrent workers never duplicate a provider call', async () => {
    await seedPolicy();
    for (const key of ['one', 'two', 'three', 'four']) await seedIntent(`concurrent_${key}`);
    const fake = providerFrom([
      accepted('one'),
      accepted('two'),
      accepted('three'),
      accepted('four'),
    ]);
    const first = worker(fake.provider);
    const second = worker(fake.provider);

    const results = await Promise.all([
      first.runBatch({ evaluatedAt: workAt, workerRef: 'WORKER_TEST_flow_one' }),
      second.runBatch({ evaluatedAt: workAt, workerRef: 'WORKER_TEST_flow_two' }),
    ]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(4);
    expect(fake.contexts).toHaveLength(4);
    await expect(
      pool.query(`select count(*)::int as count from outbound_attempts`),
    ).resolves.toMatchObject({
      rows: [{ count: 4 }],
    });
  });

  test('recovers before dispatch but never retries a crash after dispatch started', async () => {
    await seedPolicy();
    await seedIntent('crash_before');
    const real = workStore();
    const beforeStore: OutboundWorkerStore = {
      authorizeAttempt: (input) => real.authorizeAttempt(input),
      claimBatch: (input) => real.claimBatch(input),
      markDispatchStarted: () => Promise.reject(new Error('synthetic crash before dispatch')),
      recordProviderResult: (input) => real.recordProviderResult(input),
    };
    const beforeProvider = providerFrom([accepted('before')]);
    await expect(
      worker(beforeProvider.provider, beforeStore).runBatch({
        evaluatedAt: workAt,
        workerRef: 'WORKER_TEST_crash_before',
      }),
    ).resolves.toMatchObject({ failed: 1 });
    expect(beforeProvider.contexts).toHaveLength(0);
    await real.expireLeases({
      expiredAt: new Date(workAt.getTime() + generous.leaseMs),
      limit: 10,
    });
    const recoveredProvider = providerFrom([accepted('recovered')]);
    await expect(
      worker(recoveredProvider.provider, real).runBatch({
        evaluatedAt: new Date(workAt.getTime() + generous.leaseMs),
        workerRef: 'WORKER_TEST_recovered',
      }),
    ).resolves.toMatchObject({ accepted: 1 });

    await seedIntent('crash_after', {
      evaluatedAt: new Date(workAt.getTime() + generous.leaseMs),
    });
    const afterAt = new Date(workAt.getTime() + generous.leaseMs + 1);
    const afterProvider = providerFrom([new Error('synthetic crash after dispatch')]);
    await expect(
      worker(afterProvider.provider, real).runBatch({
        evaluatedAt: afterAt,
        workerRef: 'WORKER_TEST_crash_after',
      }),
    ).resolves.toMatchObject({ unknown: 1 });
    await expect(
      real.expireLeases({
        expiredAt: new Date(afterAt.getTime() + generous.leaseMs),
        limit: 10,
      }),
    ).resolves.toMatchObject({ deliveryUnknown: 1 });
    await expect(
      worker(afterProvider.provider, real).runBatch({
        evaluatedAt: new Date(afterAt.getTime() + generous.leaseMs),
        workerRef: 'WORKER_TEST_no_repeat',
      }),
    ).resolves.toMatchObject({ claimed: 0 });
    expect(afterProvider.contexts).toHaveLength(1);
  });

  test('persists timeout as delivery unknown with no retry', async () => {
    await seedPolicy();
    await seedIntent('timeout');
    const fake = providerFrom([{ reasonCode: 'timeout', status: 'delivery_unknown' }]);

    await expect(
      worker(fake.provider).runBatch({ evaluatedAt: workAt, workerRef: 'WORKER_TEST_timeout' }),
    ).resolves.toMatchObject({
      unknown: 1,
    });
    await expect(
      pool.query(`select state, next_attempt_at from outbound_intents`),
    ).resolves.toMatchObject({ rows: [{ next_attempt_at: null, state: 'delivery_unknown' }] });
    expect(fake.contexts).toHaveLength(1);
  });

  test('applies customized global limits before provider I/O', async () => {
    const limits = { ...generous, global1Minute: 1 };
    await seedPolicy(limits);
    await seedIntent('limited_one');
    await seedIntent('limited_two');
    const firstFake = providerFrom([accepted('limited')]);
    const firstStore = workStore(limits);

    await expect(
      worker(firstFake.provider, firstStore).runBatch({
        evaluatedAt: workAt,
        workerRef: 'WORKER_TEST_limited',
      }),
    ).resolves.toEqual({
      accepted: 1,
      canceled: 1,
      claimed: 2,
      deferred: 0,
      failed: 0,
      unknown: 0,
    });
    expect(firstFake.contexts).toHaveLength(1);
  });

  test('retries only definite rejection and stops at the customized retry maximum', async () => {
    const limits = { ...generous, maximumDefiniteRetries: 1 };
    await seedPolicy(limits);
    await seedIntent('retry_exhaustion');
    const firstStore = workStore(limits);
    const firstFake = providerFrom([
      { reasonCode: 'provider_rejected', retryAfter: undefined, status: 'definitely_rejected' },
    ]);
    await expect(
      worker(firstFake.provider, firstStore).runBatch({
        evaluatedAt: workAt,
        workerRef: 'WORKER_TEST_retry_one',
      }),
    ).resolves.toMatchObject({ deferred: 1 });
    const retryAt = new Date(workAt.getTime() + limits.retryBaseMs);
    const secondFake = providerFrom([
      { reasonCode: 'provider_rejected', retryAfter: undefined, status: 'definitely_rejected' },
    ]);
    await expect(
      worker(secondFake.provider, firstStore).runBatch({
        evaluatedAt: retryAt,
        workerRef: 'WORKER_TEST_retry_exhausted',
      }),
    ).resolves.toMatchObject({ failed: 1 });
    expect(secondFake.contexts).toHaveLength(1);
  });

  test.each([
    {
      expectedReason: 'pause_active',
      key: 'pause',
      mutate: async (fixture: FlowFixture) => {
        await pool.query(`update conversations set ai_paused_until = $2 where id = $1`, [
          fixture.conversationId,
          new Date(workAt.getTime() + 60_000),
        ]);
      },
    },
    {
      expectedReason: 'privacy_hold',
      key: 'privacy',
      mutate: async (fixture: FlowFixture) => {
        await pool.query(
          `insert into privacy_requests
             (request_ref, request_type, state, contact_id, received_at, open_request_key)
           values ('PRIVACY_TEST_outbound_flow','access','received',$1,$2,
                   'REQUEST_TEST_outbound_flow_privacy')`,
          [fixture.contactId, workAt],
        );
      },
    },
    {
      expectedReason: 'identity_deleted',
      key: 'deletion',
      mutate: async (fixture: FlowFixture) => {
        const key = syntheticPrivacyKeyring.keys.get(syntheticPrivacyKeyring.activeVersion);
        if (key === undefined) throw new Error('Synthetic privacy key is missing');
        const hmac = createIdentityHmac(fixture.identity, {
          key,
          version: syntheticPrivacyKeyring.activeVersion,
        });
        await pool.query(
          `insert into privacy_suppressions
             (identity_hmac, channel, category, reason_code, effective_at, key_version)
           values ($1,$2,'deletion_tombstone','customer_deletion',$3,$4)`,
          [hmac, fixture.identity.channel, workAt, syntheticPrivacyKeyring.activeVersion],
        );
      },
    },
    {
      expectedReason: 'retention_expired',
      key: 'retention',
      mutate: async (fixture: FlowFixture) => {
        await pool.query(
          `update conversation_retention_states
           set anchor_at = $2, expires_at = $3 where conversation_id = $1`,
          [
            fixture.conversationId,
            new Date(workAt.getTime() - 8 * 86_400_000),
            new Date(workAt.getTime() - 1),
          ],
        );
      },
    },
    {
      expectedReason: 'content_erased',
      key: 'erased',
      mutate: async (fixture: FlowFixture) => {
        await pool.query(
          `update support_reply_drafts
           set answer_text = null, state = 'erased', erased_at = $2
           where draft_ref = $1`,
          [fixture.draftRef, workAt],
        );
      },
    },
  ])('blocks a late $key race before provider I/O', async ({ expectedReason, key, mutate }) => {
    await seedPolicy();
    const fixture = await seedIntent(`late_${key}`);
    const real = workStore();
    const mutatingStore: OutboundWorkerStore = {
      authorizeAttempt: (input) => real.authorizeAttempt(input),
      claimBatch: async (input) => {
        const claims = await real.claimBatch(input);
        await mutate(fixture);
        return claims;
      },
      markDispatchStarted: (input) => real.markDispatchStarted(input),
      recordProviderResult: (input) => real.recordProviderResult(input),
    };
    const fake = providerFrom([accepted('unexpected')]);

    await expect(
      worker(fake.provider, mutatingStore).runBatch({
        evaluatedAt: workAt,
        workerRef: `WORKER_TEST_late_${key}`,
      }),
    ).resolves.toMatchObject({ canceled: 1 });
    expect(fake.contexts).toHaveLength(0);
    await expect(
      pool.query(`select terminal_reason from outbound_intents where intent_ref = $1`, [
        fixture.intentRef,
      ]),
    ).resolves.toMatchObject({ rows: [{ terminal_reason: expectedReason }] });
  });

  test('blocks a late marketing suppression before fixed-template provider I/O', async () => {
    await seedPolicy();
    const fixture = await seedMarketingIntent('late_suppression');
    const real = workStore();
    const mutatingStore: OutboundWorkerStore = {
      authorizeAttempt: (input) => real.authorizeAttempt(input),
      claimBatch: async (input) => {
        const claims = await real.claimBatch(input);
        const key = syntheticPrivacyKeyring.keys.get(syntheticPrivacyKeyring.activeVersion);
        if (key === undefined) throw new Error('Synthetic privacy key is missing');
        const hmac = createIdentityHmac(fixture.identity, {
          key,
          version: syntheticPrivacyKeyring.activeVersion,
        });
        await pool.query(
          `insert into privacy_suppressions
             (identity_hmac, channel, category, reason_code, effective_at, key_version)
           values ($1,$2,'marketing_opt_out','customer_opt_out',$3,$4)`,
          [hmac, fixture.identity.channel, workAt, syntheticPrivacyKeyring.activeVersion],
        );
        return claims;
      },
      markDispatchStarted: (input) => real.markDispatchStarted(input),
      recordProviderResult: (input) => real.recordProviderResult(input),
    };
    const fake = providerFrom([accepted('unexpected')]);

    await expect(
      worker(fake.provider, mutatingStore).runBatch({
        evaluatedAt: workAt,
        workerRef: 'WORKER_TEST_late_suppression',
      }),
    ).resolves.toMatchObject({ canceled: 1 });
    expect(fake.contexts).toHaveLength(0);
    await expect(
      pool.query(`select terminal_reason from outbound_intents where intent_ref = $1`, [
        fixture.intentRef,
      ]),
    ).resolves.toMatchObject({ rows: [{ terminal_reason: 'suppressed' }] });
  });

  test('blocks support text after the exact service window closes', async () => {
    await seedPolicy();
    const fixture = await seedIntent('late_window');
    const outsideWindow = new Date(workAt.getTime() + 23 * 60 * 60 * 1000 + 1);
    const fake = providerFrom([accepted('unexpected')]);

    await expect(
      worker(fake.provider).runBatch({
        evaluatedAt: outsideWindow,
        workerRef: 'WORKER_TEST_late_window',
      }),
    ).resolves.toMatchObject({ canceled: 1 });
    expect(fake.contexts).toHaveLength(0);
    await expect(
      pool.query(`select terminal_reason from outbound_intents where intent_ref = $1`, [
        fixture.intentRef,
      ]),
    ).resolves.toMatchObject({ rows: [{ terminal_reason: 'template_required' }] });
  });

  test('cancels channel-incompatible support text before attempt or provider I/O', async () => {
    await seedPolicy();
    const fixture = await seedIntent('messenger_oversized', {
      answerText: 'X'.repeat(2001),
      channel: 'messenger',
    });
    const fake = providerFrom([accepted('unexpected')]);

    await expect(
      worker(fake.provider).runBatch({
        evaluatedAt: workAt,
        workerRef: 'WORKER_TEST_messenger_oversized',
      }),
    ).resolves.toMatchObject({ canceled: 1 });
    expect(fake.contexts).toHaveLength(0);
    await expect(
      pool.query(
        `select intent.terminal_reason,
                (select count(*)::int from outbound_attempts) as attempts
         from outbound_intents as intent where intent.intent_ref = $1`,
        [fixture.intentRef],
      ),
    ).resolves.toMatchObject({ rows: [{ attempts: 0, terminal_reason: 'template_required' }] });
  });
});
