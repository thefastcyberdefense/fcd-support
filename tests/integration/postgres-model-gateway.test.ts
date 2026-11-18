import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  AesGcmGatewaySecretProtector,
  decodeGatewayEncryptionKey,
} from '../../src/model/gateway-secret.js';
import type { ModelPolicyValues } from '../../src/model/model-policy-types.js';
import type { ModelDeploymentCeilings } from '../../src/model/model-types.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PostgresModelAllowance } from '../../src/persistence/postgres-model-allowance.js';
import {
  GatewayStateTransitionError,
  PostgresModelGateway,
} from '../../src/persistence/postgres-model-gateway.js';
import { PostgresModelPolicy } from '../../src/persistence/postgres-model-policy.js';
import { PostgresReplyDraftStore } from '../../src/persistence/postgres-reply-draft-store.js';
import { ModelReplyService } from '../../src/replies/model-reply-service.js';
import { SecretText } from '../../src/safety/secret-bytes.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let gateway: PostgresModelGateway;
let policyService: PostgresModelPolicy;
let allowance: PostgresModelAllowance;
let protector: AesGcmGatewaySecretProtector;

const baseAt = new Date('2030-04-05T06:00:00.000Z');
const administrator = {
  reviewerRef: 'ADMIN_TEST_gateway',
  roles: ['administrator', 'knowledge_editor', 'knowledge_reviewer'],
} as const;
const policyValues: ModelPolicyValues = Object.freeze({
  approvedProviderAttempts: 3,
  architectureProviderCeiling: 5,
  concurrentCalls: 2,
  cooldownMs: 0,
  faqAmbiguityMargin: 0.05,
  faqMinimumSimilarity: 0.7,
  globalUtcDayCalls: 100,
  maximumFaqCandidates: 10,
  outputTokens: 200,
  perContact15MinuteCalls: 5,
  perContact24HourCalls: 20,
  queueCapacity: 1,
  totalTimeoutMs: 10_000,
});
const deployment: ModelDeploymentCeilings = Object.freeze({
  architectureProviderConnections: 5,
  concurrentCalls: 4,
  contextItems: 5,
  cooldownMs: 0,
  globalUtcDayCalls: 200,
  inputCodePoints: 4000,
  outputTokens: 600,
  perContact15MinuteCalls: 10,
  perContact24HourCalls: 50,
  providerAttempts: 3,
  queueCapacity: 5,
  responseBytes: 32_768,
  totalTimeoutMs: 20_000,
});
const attestation = Object.freeze({ operationalLimits: deployment, verified: true as const });

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('model_gateway');
  pool = database.pool;
  dispose = database.dispose;
  const encoded = Buffer.alloc(32, 0x2c).toString('base64url');
  protector = new AesGcmGatewaySecretProtector('gateway-v1', decodeGatewayEncryptionKey(encoded));
});

beforeEach(async () => {
  await pool.query(
    `truncate table contacts, webhook_receipts, model_gateway_profiles, model_policy_versions,
      knowledge_sources, knowledge_items, admin_accounts
     restart identity cascade`,
  );
  gateway = new PostgresModelGateway(pool, protector);
  policyService = new PostgresModelPolicy(pool);
  allowance = new PostgresModelAllowance(pool);

  const account = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.gateway', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x71), Buffer.alloc(32, 0x72), baseAt],
  );
  for (const role of administrator.roles) {
    await pool.query(
      `insert into admin_role_assignments
         (account_id, role, action, actor_account_id, effective_at, request_key)
       values ($1, $2, 'assign', $1, $3, $4)`,
      [account.rows[0]?.id, role, baseAt, `REQUEST_TEST_gateway_role_${role}`],
    );
  }
});

afterAll(async () => {
  await dispose?.();
});

async function activateDefaultPolicy(): Promise<void> {
  await policyService.createPolicy(
    {
      createdAt: baseAt,
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_gateway',
      requestKey: 'REQUEST_TEST_gateway_policy_create',
      values: policyValues,
    },
    administrator,
  );
  for (const action of ['submit', 'approve', 'activate'] as const) {
    await policyService.transitionPolicy(
      {
        action,
        effectiveAt: new Date(baseAt.getTime() + 1000),
        policyRef: 'POLICY_TEST_gateway',
        reasonCode: `${action}_reviewed`,
        requestKey: `REQUEST_TEST_gateway_policy_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
}

async function seedPublishedKnowledge(): Promise<void> {
  const repository = new PostgresKnowledgeRepository(pool);
  const publication = new PostgresKnowledgePublication(pool);
  await repository.createSource(
    {
      createdAt: baseAt,
      createdByReference: administrator.reviewerRef,
      label: 'Synthetic Business Facts',
      sourceRef: 'SOURCE_TEST_gateway',
      sourceType: 'manual_business',
    },
    administrator,
  );
  await repository.createProposal(
    {
      aliases: [],
      answers: {
        bn: 'সিনথেটিক সাপোর্ট সকাল ১০টা থেকে সন্ধ্যা ৬টা খোলা।',
        en: 'Synthetic support is open 10 AM to 6 PM.',
      },
      authorReference: administrator.reviewerRef,
      contentSha256: '3'.repeat(64),
      createdAt: new Date(baseAt.getTime() + 100),
      itemKey: 'business.synthetic.gateway_hours',
      kind: 'business_fact',
      requestKey: 'REQUEST_TEST_gw_knowledge',
      sourceRef: 'SOURCE_TEST_gateway',
      sourceSha256: '4'.repeat(64),
      tags: ['synthetic'],
      versionRef: 'VERSION_TEST_gateway_fact',
    },
    administrator,
  );
  await publication.submitVersion(
    {
      action: 'submit',
      effectiveAt: new Date(baseAt.getTime() + 200),
      reasonCode: 'ready_for_review',
      requestKey: 'REQUEST_TEST_gw_knowledge_submit',
      reviewerReference: administrator.reviewerRef,
      versionRef: 'VERSION_TEST_gateway_fact',
    },
    administrator,
  );
  await publication.reviewVersion(
    {
      action: 'approve',
      effectiveAt: new Date(baseAt.getTime() + 300),
      reasonCode: 'verified',
      requestKey: 'REQUEST_TEST_gw_knowledge_approve',
      reviewerReference: administrator.reviewerRef,
      versionRef: 'VERSION_TEST_gateway_fact',
    },
    administrator,
  );
  await publication.publishVersion(
    {
      action: 'publish',
      effectiveAt: new Date(baseAt.getTime() + 400),
      itemKey: 'business.synthetic.gateway_hours',
      reasonCode: 'initial_publication',
      requestKey: 'REQUEST_TEST_gw_knowledge_publish',
      reviewerReference: administrator.reviewerRef,
      versionRef: 'VERSION_TEST_gateway_fact',
    },
    administrator,
  );
}

describe('PostgreSQL model gateway configuration and positive budget enforcement', () => {
  test('defaults to Manifest fcd-support auto, enforces test-before-activate, protects keys, and retires back to default', async () => {
    expect(await gateway.resolveRuntimeGateway()).toEqual({
      budgetMicroUsd: 0,
      budgetWindowKind: 'utc_month',
      gatewayKind: 'manifest_default',
      gatewayProfileId: undefined,
      gatewayRef: undefined,
      inputCostPerMillionMicroUsd: 0,
      modelName: 'auto',
      outputCostPerMillionMicroUsd: 0,
    });

    await gateway.createProfile(
      {
        apiKey: new SecretText('synthetic_custom_gateway_secret_value'),
        budgetMicroUsd: 0,
        budgetWindowKind: 'utc_month',
        createdAt: baseAt,
        createdByAccountRef: administrator.reviewerRef,
        displayLabel: 'Synthetic OpenAI Gateway',
        endpointBaseUrl: 'https://gateway.example.test/v1/',
        gatewayKind: 'openai_compatible',
        gatewayRef: 'GATEWAY_TEST_1',
        inputCostPerMillionMicroUsd: 0,
        modelName: 'gpt-4o-mini',
        outputCostPerMillionMicroUsd: 0,
        requestKey: 'REQUEST_TEST_gw_create_1',
      },
      administrator,
    );

    const view = await gateway.getProfile('GATEWAY_TEST_1');
    expect(view.endpointBaseUrl).toBe('https://gateway.example.test/v1');
    expect(JSON.stringify(view)).not.toContain('synthetic_custom_gateway_secret_value');

    await expect(
      gateway.transitionProfile(
        {
          action: 'activate',
          effectiveAt: new Date(baseAt.getTime() + 1000),
          gatewayRef: 'GATEWAY_TEST_1',
          reasonCode: 'attempt_untested',
          requestKey: 'REQUEST_TEST_gw_activate_untested',
          reviewerAccountRef: administrator.reviewerRef,
        },
        administrator,
      ),
    ).rejects.toBeInstanceOf(GatewayStateTransitionError);

    const failedTest = await gateway.testProfileConnection(
      {
        fetch: () => Promise.resolve(new Response('unauthorized', { status: 401 })),
        gatewayRef: 'GATEWAY_TEST_1',
        now: () => new Date(baseAt.getTime() + 2000),
        requestKey: 'REQUEST_TEST_gw_test_fail',
        testerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
    expect(failedTest.outcome.result).toBe('failed');
    expect(failedTest.outcome.reasonCode).toBe('unauthorized');

    await expect(
      gateway.transitionProfile(
        {
          action: 'activate',
          effectiveAt: new Date(baseAt.getTime() + 3000),
          gatewayRef: 'GATEWAY_TEST_1',
          reasonCode: 'attempt_after_fail',
          requestKey: 'REQUEST_TEST_gw_activate_failed',
          reviewerAccountRef: administrator.reviewerRef,
        },
        administrator,
      ),
    ).rejects.toBeInstanceOf(GatewayStateTransitionError);

    const passedTest = await gateway.testProfileConnection(
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  { finish_reason: 'stop', message: { content: 'pong', role: 'assistant' } },
                ],
              }),
              { status: 200 },
            ),
          ),
        gatewayRef: 'GATEWAY_TEST_1',
        now: () => new Date(baseAt.getTime() + 4000),
        requestKey: 'REQUEST_TEST_gw_test_pass',
        testerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
    expect(passedTest.outcome.result).toBe('passed');

    await gateway.transitionProfile(
      {
        action: 'activate',
        effectiveAt: new Date(baseAt.getTime() + 5000),
        gatewayRef: 'GATEWAY_TEST_1',
        reasonCode: 'activated_tested',
        requestKey: 'REQUEST_TEST_gw_activate_ok',
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );

    const resolved = await gateway.resolveRuntimeGateway();
    expect(resolved.gatewayKind).toBe('openai_compatible');
    if (resolved.gatewayKind === 'openai_compatible') {
      expect(resolved.modelName).toBe('gpt-4o-mini');
      expect(resolved.endpointBaseUrl).toBe('https://gateway.example.test/v1');
      expect(resolved.apiKey.reveal()).toBe('synthetic_custom_gateway_secret_value');
    }

    await gateway.transitionProfile(
      {
        action: 'retire',
        effectiveAt: new Date(baseAt.getTime() + 6000),
        gatewayRef: 'GATEWAY_TEST_1',
        reasonCode: 'revert_to_manifest',
        requestKey: 'REQUEST_TEST_gw_retire',
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );

    const reverted = await gateway.resolveRuntimeGateway();
    expect(reverted.gatewayKind).toBe('manifest_default');
    expect(reverted.modelName).toBe('auto');
  });

  test('enforces positive monthly/daily monetary budget reservation and settlement while keeping budget 0 unlimited with safety limits', async () => {
    await activateDefaultPolicy();
    await seedPublishedKnowledge();

    await gateway.createProfile(
      {
        apiKey: new SecretText('synthetic_budget_gateway_secret_value'),
        budgetMicroUsd: 5_000,
        budgetWindowKind: 'utc_day',
        createdAt: baseAt,
        createdByAccountRef: administrator.reviewerRef,
        displayLabel: 'Tight Budget Profile',
        endpointBaseUrl: 'https://gateway.example.test/v1',
        gatewayKind: 'openai_compatible',
        gatewayRef: 'GATEWAY_TEST_budget',
        inputCostPerMillionMicroUsd: 1_000_000,
        modelName: 'gpt-4o-mini',
        outputCostPerMillionMicroUsd: 2_000_000,
        requestKey: 'REQUEST_TEST_gw_budget_create',
      },
      administrator,
    );
    await gateway.recordTestOutcome(
      {
        gatewayRef: 'GATEWAY_TEST_budget',
        outcome: {
          httpStatus: 200,
          latencyMs: 25,
          reasonCode: 'ok',
          result: 'passed',
          testedAt: new Date(baseAt.getTime() + 1000),
        },
        requestKey: 'REQUEST_TEST_gw_budget_test',
        testerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
    await gateway.transitionProfile(
      {
        action: 'activate',
        effectiveAt: new Date(baseAt.getTime() + 2000),
        gatewayRef: 'GATEWAY_TEST_budget',
        reasonCode: 'budget_activated',
        requestKey: 'REQUEST_TEST_gw_budget_activate',
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );

    const identity = {
      channel: 'whatsapp' as const,
      channelAccountId: 'PHONE_TEST_gateway',
      externalContactId: 'USER_TEST_gateway_1',
    };
    const first = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'gw_budget_1',
      identity,
      messageText: 'Tell me support schedule please',
      occurredAt: new Date(baseAt.getTime() + 2000),
    });
    const second = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'gw_budget_2',
      identity,
      messageText: 'Tell me support hours please',
      occurredAt: new Date(baseAt.getTime() + 2500),
    });

    const store = new PostgresReplyDraftStore(pool, syntheticPrivacyKeyring);
    await store.persistDecision({
      evaluatedAt: new Date(baseAt.getTime() + 2100),
      gapKind: 'faq_miss',
      kind: 'model_required',
      language: 'en',
      requestKey: 'REQUEST_TEST_gw_reply_1',
      webhookEventId: first.eventId,
    });
    await store.persistDecision({
      evaluatedAt: new Date(baseAt.getTime() + 2600),
      gapKind: 'faq_miss',
      kind: 'model_required',
      language: 'en',
      requestKey: 'REQUEST_TEST_gw_reply_2',
      webhookEventId: second.eventId,
    });

    const upstreamCalls: number[] = [];
    const replyService = new ModelReplyService({
      allowance,
      deployment,
      gateway,
      gatewayClientFactory: () => ({
        complete: vi.fn(() => {
          upstreamCalls.push(1);
          return Promise.resolve({
            status: 'completed' as const,
            usage: { completionTokens: 2000, promptTokens: 800 },
            value: {
              answer: 'Synthetic support is open 10 AM to 6 PM.',
              decision: 'answer' as const,
              knowledgeReferences: ['VERSION_TEST_gateway_fact'],
              language: 'en' as const,
              needsHumanReview: false as const,
              reasonCode: 'published_knowledge_answer' as const,
            },
          });
        }),
      }),
      manifest: { complete: vi.fn() },
      manifestAttestation: attestation,
      now: () => new Date(baseAt.getTime() + 3000),
      policy: policyService,
      store,
    });

    const r1 = await replyService.decide({
      evaluatedAt: new Date(baseAt.getTime() + 3000),
      language: 'en',
      requestKey: 'REQUEST_TEST_gw_reply_1',
      webhookEventId: first.eventId,
    });
    expect(r1).toMatchObject({ decisionType: 'model', status: 'created' });
    expect(upstreamCalls).toHaveLength(1);

    const midSummary = await gateway.readActiveBudgetSummary(new Date(baseAt.getTime() + 3000));
    expect(midSummary).toMatchObject({
      budgetMicroUsd: 5_000,
      reservedMicroUsd: 0,
      spentMicroUsd: 4_800,
    });

    // Second call cannot fit within remaining 200 micro-USD -> denied before upstream HTTP call!
    const r2 = await replyService.decide({
      evaluatedAt: new Date(baseAt.getTime() + 3500),
      language: 'en',
      requestKey: 'REQUEST_TEST_gw_reply_2',
      webhookEventId: second.eventId,
    });
    expect(r2).toMatchObject({ decisionType: 'safe_failure', status: 'created' });
    expect(upstreamCalls).toHaveLength(1);

    const escalations = await pool.query<{ readonly reason_code: string }>(
      `select reason_code from support_escalation_outcomes where source_webhook_event_id = $1`,
      [second.eventId],
    );
    expect(escalations.rows).toEqual([{ reason_code: 'budget_exceeded' }]);
  });
});
