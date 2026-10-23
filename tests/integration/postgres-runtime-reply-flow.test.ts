import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createManifestClient } from '../../src/model/manifest-client.js';
import pg from 'pg';
import { noopSafeLogger } from '../../src/logging.js';
import { createReplyRuntime } from '../../src/operations/reply-runtime.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { runReplyStage, type ReplyPipelinePorts } from '../../src/operations/reply-pipeline.js';
import {
  PostgresReplyRuntimeState,
  PostgresRuntimeFaqResolver,
} from '../../src/operations/reply-state.js';
import { PostgresConversationEventProcessor } from '../../src/persistence/postgres-conversation-event-processor.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import { PostgresModelAllowance } from '../../src/persistence/postgres-model-allowance.js';
import { PostgresModelPolicy } from '../../src/persistence/postgres-model-policy.js';
import { PostgresOutboundIntentStore } from '../../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import {
  PostgresProcessingWork,
  type ProcessingClaim,
} from '../../src/persistence/postgres-processing-work.js';
import { PostgresReplyDraftStore } from '../../src/persistence/postgres-reply-draft-store.js';
import { ModelReplyService } from '../../src/replies/model-reply-service.js';
import { ReplyDecisionService } from '../../src/replies/reply-decision-service.js';
import { inspectSensitiveText } from '../../src/safety/sensitive-data-gate.js';
import { MARKETING_CATEGORIES } from '../../src/policy/policy-types.js';
import {
  startFakeManifestServer,
  type FakeManifestServer,
} from '../helpers/fake-manifest-server.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';
import { seedReviewedRestore } from './restore-fixtures.js';

const base = new Date('2025-02-01T00:00:00.000Z');
const at = new Date('2025-02-01T00:01:00.000Z');
const bounds = {
  global1Minute: 120,
  globalUtcDay: 900,
  leaseMs: 25000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 80,
  perContact15Minute: 3,
  perContact24Hour: 30,
  providerTimeoutMs: 8000,
  retryBaseMs: 5000,
  retryMaximumMs: 30000,
  whatsappAccount1Minute: 90,
  workerBatchSize: 10,
};
const limits = {
  concurrentCalls: 2,
  cooldownMs: 0,
  globalUtcDayCalls: 20,
  outputTokens: 77,
  perContact15MinuteCalls: 3,
  perContact24HourCalls: 10,
  queueCapacity: 2,
  providerAttempts: 1,
  totalTimeoutMs: 1000,
};
const deployment = {
  ...limits,
  architectureProviderConnections: 1,
  contextItems: 4,
  inputCodePoints: 2000,
  responseBytes: 4096,
};
const owner = { reviewerRef: 'ADMIN_TEST_runtime', roles: ['administrator'] } as const;
const editor = { reviewerRef: 'EDITOR_TEST_runtime', roles: ['knowledge_editor'] } as const;
const reviewer = { reviewerRef: 'REVIEWER_TEST_runtime', roles: ['knowledge_reviewer'] } as const;
const identity = {
  channel: 'messenger',
  channelAccountId: 'PAGE_TEST_runtime',
  externalContactId: 'CONTACT_TEST_runtime',
} as const;
let db: IsolatedTestDatabase;
let fake: FakeManifestServer;
let fixture: RuntimeReplyFixture;

class RuntimeReplyFixture {
  public now = new Date(at);
  public readonly work = new PostgresProcessingWork(db.pool);
  public readonly processor = new PostgresConversationEventProcessor(db.pool);
  public readonly drafts = new PostgresReplyDraftStore(db.pool, syntheticPrivacyKeyring);
  public readonly state = new PostgresReplyRuntimeState(db.pool, syntheticPrivacyKeyring);
  private modelEnabled = true;
  public disableModel(): void {
    this.modelEnabled = false;
  }
  public manifestCalls(): number {
    return fake.requests.length;
  }
  public async count(
    table:
      | 'outbound_intents'
      | 'support_reply_drafts'
      | 'support_escalation_outcomes'
      | 'knowledge_gap_observations'
      | 'consent_events',
  ): Promise<number> {
    const result = await db.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return result.rows[0]?.n ?? -1;
  }
  public async readyDraftLanguages(): Promise<readonly string[]> {
    return (
      await db.pool.query<{ language: string }>(
        "select language from support_reply_drafts where state='ready' order by id",
      )
    ).rows.map((row) => row.language);
  }
  public dependencies(): ReplyPipelinePorts {
    return {
      processor: this.processor,
      drafts: this.drafts,
      state: this.state,
      work: this.work,
      now: () => this.now,
      decision: new ReplyDecisionService({
        store: this.drafts,
        inspectSensitiveText,
        faqResolver: new PostgresRuntimeFaqResolver(db.pool, {
          ambiguityMargin: 0.05,
          minimumSimilarity: 0.7,
          maximumCandidates: 4,
        }),
      }),
      model: this.modelEnabled
        ? new ModelReplyService({
            store: this.drafts,
            now: () => this.now,
            allowance: new PostgresModelAllowance(db.pool),
            policy: new PostgresModelPolicy(db.pool),
            deployment,
            manifestAttestation: { verified: true, operationalLimits: limits },
            manifest: createManifestClient({
              apiKey: 'SYNTHETIC_RUNTIME_KEY_NOT_OPERATIONAL',
              baseUrl: fake.baseUrl,
              maximumResponseBytes: 4096,
              totalTimeoutMs: 1000,
            }),
          })
        : undefined,
      intent: new PostgresOutboundIntentStore(db.pool, syntheticPrivacyKeyring, bounds),
    };
  }
  public async event(text = 'How is synthetic support provided?'): Promise<string> {
    return insertSyntheticPendingEvent(db.pool, {
      channel: identity.channel,
      channelAccountId: identity.channelAccountId,
      contactId: identity.externalContactId,
      eventKind: 'customer_message',
      fixtureKey: 'runtime_reply_event',
      messageText: text,
      occurredAt: base,
    });
  }
  public async claim(): Promise<ProcessingClaim> {
    await this.work.reconcile(10, this.now);
    const claimed = (
      await this.work.claim({
        workerRef: 'WORKER_TEST_runtime',
        evaluatedAt: this.now,
        limit: 10,
        leaseMilliseconds: 1000,
      })
    )[0];
    if (claimed === undefined) throw new Error('Synthetic runtime work missing');
    return claimed;
  }
  public async run(claimed: ProcessingClaim, dependencies = this.dependencies()): Promise<void> {
    for (let index = 0; index < 8; index++) {
      const row = (
        await db.pool.query<{ stage: ProcessingClaim['stage'] }>(
          "select stage from runtime_processing_work where work_ref=$1 and state='leased'",
          [claimed.workRef],
        )
      ).rows[0];
      if (row === undefined) return;
      const result = await runReplyStage({ ...claimed, stage: row.stage }, dependencies);
      if (result !== 'advanced') return;
      this.now = new Date(this.now.getTime() + 10);
    }
    throw new Error('Synthetic runtime stage bound exceeded');
  }
  public async restart(): Promise<void> {
    this.now = new Date(this.now.getTime() + 1000);
    await this.run(await this.claim());
  }
  public async applySyntheticFaqQuestion(language: 'en' | 'bn'): Promise<void> {
    await this.event(
      language === 'bn'
        ? 'সিনথেটিক সহায়তা কীভাবে পাওয়া যায়?'
        : 'How is synthetic support provided?',
    );
    await this.run(await this.claim());
  }
  public async runThrough(boundary: 'draft_persisted' | 'intent_inserted'): Promise<void> {
    await this.event(
      boundary === 'draft_persisted' ? 'Where can synthetic online support be found?' : undefined,
    );
    const claimed = await this.claim();
    const ports = this.dependencies();
    const real = this.work;
    const crashPorts = {
      ...ports,
      work: {
        advance: (command: Parameters<typeof real.advance>[0]) => {
          if (boundary === 'draft_persisted' && command.stage === 'enqueue')
            return Promise.reject(new Error('synthetic_crash'));
          return real.advance(command);
        },
        finish: (command: Parameters<typeof real.finish>[0]) =>
          boundary === 'intent_inserted'
            ? Promise.reject(new Error('synthetic_crash'))
            : real.finish(command),
      },
    };
    await expect(this.run(claimed, crashPorts)).rejects.toThrow('synthetic_crash');
  }
}

async function seedAuthority(): Promise<void> {
  const account = await db.pool.query<{ id: string }>(
    `insert into admin_accounts
    (account_ref,login_name,password_algorithm,password_cost,password_block_size,password_parallelization,password_key_length,password_salt,password_hash,state,created_at,updated_at,password_changed_at)
    values ($1,'synthetic.runtime','scrypt_v1',16384,8,1,32,$2,$3,'active',$4,$4,$4) returning id`,
    [owner.reviewerRef, Buffer.alloc(16, 0x31), Buffer.alloc(32, 0x32), base],
  );
  await db.pool.query(
    `insert into admin_role_assignments (account_id,role,action,actor_account_id,effective_at,request_key) values ($1,'administrator','assign',$1,$2,'REQUEST_TEST_runtime_role')`,
    [account.rows[0]?.id, base],
  );
  const outbound = new PostgresOutboundPolicy(db.pool);
  await outbound.createVersion(
    {
      createdAt: base,
      createdByAccountRef: owner.reviewerRef,
      policyRef: 'POLICY_TEST_runtime_outbound',
      requestKey: 'REQUEST_TEST_runtime_outbound',
      values: bounds,
    },
    owner,
  );
  for (const action of ['submitVersion', 'approveVersion', 'activateVersion'] as const) {
    await outbound[action](
      {
        effectiveAt: base,
        policyRef: 'POLICY_TEST_runtime_outbound',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_runtime_${action}`,
        reviewerAccountRef: owner.reviewerRef,
      },
      owner,
    );
  }
  const policy = new PostgresModelPolicy(db.pool);
  const { providerAttempts, ...policyLimits } = limits;
  await policy.createPolicy(
    {
      createdAt: base,
      createdByAccountRef: owner.reviewerRef,
      policyRef: 'POLICY_TEST_runtime_model',
      requestKey: 'REQUEST_TEST_runtime_model',
      values: {
        ...policyLimits,
        approvedProviderAttempts: providerAttempts,
        architectureProviderCeiling: 1,
        faqAmbiguityMargin: 0.05,
        faqMinimumSimilarity: 0.99,
        maximumFaqCandidates: 4,
      },
    },
    owner,
  );
  for (const action of ['submit', 'approve', 'activate'] as const) {
    await policy.transitionPolicy(
      {
        action,
        effectiveAt: base,
        policyRef: 'POLICY_TEST_runtime_model',
        reasonCode: `${action}_reviewed`,
        requestKey: `REQUEST_TEST_runtime_model_${action}`,
        reviewerAccountRef: owner.reviewerRef,
      },
      owner,
    );
  }
  const repository = new PostgresKnowledgeRepository(db.pool);
  const publication = new PostgresKnowledgePublication(db.pool);
  await repository.createSource(
    {
      createdAt: base,
      createdByReference: editor.reviewerRef,
      label: 'Synthetic runtime catalog',
      sourceRef: 'SOURCE_TEST_runtime',
      sourceType: 'manual_business',
    },
    editor,
  );
  for (const kind of ['faq', 'business_fact'] as const) {
    const versionRef = `VERSION_TEST_runtime_${kind}`;
    const itemKey = `synthetic.runtime.${kind}`;
    await repository.createProposal(
      {
        aliases: [],
        answers: {
          en: 'Synthetic reviewed support is available online.',
          bn: 'সিনথেটিক পর্যালোচিত সহায়তা অনলাইনে পাওয়া যায়।',
        },
        authorReference: editor.reviewerRef,
        contentSha256: '1'.repeat(64),
        createdAt: base,
        itemKey,
        kind,
        ...(kind === 'faq'
          ? {
              questions: {
                en: 'How is synthetic support provided?',
                bn: 'সিনথেটিক সহায়তা কীভাবে পাওয়া যায়?',
              },
            }
          : {}),
        requestKey: `REQUEST_TEST_runtime_${kind}`,
        sourceRef: 'SOURCE_TEST_runtime',
        sourceSha256: '2'.repeat(64),
        tags: ['synthetic'],
        versionRef,
      },
      editor,
    );
    await publication.submitVersion(
      {
        action: 'submit',
        effectiveAt: base,
        reasonCode: 'ready_for_review',
        requestKey: `REQUEST_TEST_runtime_${kind}_submit`,
        reviewerReference: editor.reviewerRef,
        versionRef,
      },
      editor,
    );
    await publication.reviewVersion(
      {
        action: 'approve',
        effectiveAt: base,
        reasonCode: kind === 'faq' ? 'faq_verified' : 'business_fact_verified',
        requestKey: `REQUEST_TEST_runtime_${kind}_approve`,
        reviewerReference: reviewer.reviewerRef,
        versionRef,
      },
      reviewer,
    );
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: base,
        itemKey,
        reasonCode: 'initial_publication',
        requestKey: `REQUEST_TEST_runtime_${kind}_publish`,
        reviewerReference: reviewer.reviewerRef,
        versionRef,
      },
      reviewer,
    );
  }
}

beforeAll(async () => {
  db = await createIsolatedTestDatabase('runtime_reply');
  fake = await startFakeManifestServer();
});
afterAll(async () => {
  await fake.close();
  await db.dispose();
});
beforeEach(async () => {
  await db.pool.query(
    'truncate contacts,webhook_receipts,knowledge_sources,knowledge_items,model_policy_versions,outbound_policy_versions,admin_accounts,privacy_suppressions,operations_deployments restart identity cascade',
  );
  fake.reset();
  fixture = new RuntimeReplyFixture();
  await seedAuthority();
  fake.enqueueResponse({
    statusCode: 200,
    body: JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              answer: 'Synthetic reviewed support is available online.',
              decision: 'answer',
              knowledgeReferences: ['VERSION_TEST_runtime_business_fact'],
              language: 'en',
              needsHumanReview: false,
              reasonCode: 'published_knowledge_answer',
            }),
          },
        },
      ],
    }),
  });
});

describe('PostgreSQL recoverable reply runtime', () => {
  test('the composed daemon repairs admitted work with no model or outbound provider transport', async () => {
    await fixture.event();
    await db.pool.query(
      `insert into operations_deployments (git_revision,schema_revision,recorded_at,status)
      values ($1,'000016',$2,'started')`,
      ['c'.repeat(40), at],
    );
    const runtime = await createReplyRuntime({
      role: 'reply',
      logger: noopSafeLogger,
      now: () => fixture.now,
      environment: {
        ...operationsEnvironment(),
        DATABASE_URL: db.connectionString,
        PRIVACY_HMAC_KEYRING: JSON.stringify({
          activeVersion: 'TEST_v1',
          keys: [
            { version: 'TEST_v1', keyBase64url: Buffer.alloc(32, 0x51).toString('base64url') },
          ],
        }),
        OPS_GIT_REVISION: 'c'.repeat(40),
        OPS_SCHEMA_REVISION: '000016',
        REPLY_FAQ_POLICY_JSON: JSON.stringify({
          ambiguityMargin: 0.05,
          minimumSimilarity: 0.7,
          maximumCandidates: 4,
        }),
        REPLY_OUTBOUND_BOUNDS_JSON: JSON.stringify(bounds),
      },
      poolFactory: (configuration) => new pg.Pool(configuration),
    });
    try {
      await runtime.start();
      for (
        let attempt = 0;
        attempt < 100 && (await fixture.count('outbound_intents')) === 0;
        attempt++
      ) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      expect(await fixture.count('outbound_intents')).toBe(1);
      expect(fixture.manifestCalls()).toBe(0);
    } finally {
      await runtime.stop();
    }
  });

  test('a receipt marked by restore quarantine never enters the reply pipeline', async () => {
    const id = await fixture.event();
    await seedReviewedRestore(db.pool, 'RESTORE_TEST_runtime', at);
    try {
      await db.pool.query(
        "insert into runtime_restore_quarantine(source_kind,source_id,restore_ref,reason,recorded_at) values ('webhook_event',$1,'RESTORE_TEST_runtime','restore_quarantined',$2)",
        [id, at],
      );
      expect(await fixture.work.reconcile(10, at)).toEqual({ created: 0 });
      expect(await fixture.count('support_reply_drafts')).toBe(0);
      expect(fixture.manifestCalls()).toBe(0);
    } finally {
      await db.pool.query(
        'truncate operations_restore_bindings,runtime_restore_quarantine,runtime_recovery_reviews,runtime_recovery_holds',
      );
    }
  });

  test('a crash after FAQ persistence resumes with one draft and one intent', async () => {
    fixture.disableModel();
    const source = await fixture.event();
    const claim = await fixture.claim();
    const dependencies = fixture.dependencies();
    await runReplyStage(claim, dependencies);
    // Commit domain outcome while intentionally leaving the durable stage at decide.
    await dependencies.decision.decide({
      evaluatedAt: fixture.now,
      language: 'en',
      requestKey: (await import('../../src/operations/reply-pipeline.js')).replyEventKey(source),
      webhookEventId: source,
    });
    await fixture.restart();
    expect(await fixture.count('support_reply_drafts')).toBe(1);
    expect(await fixture.count('outbound_intents')).toBe(1);
    expect(fixture.manifestCalls()).toBe(0);
  });
  test('absent model policy still permits exact reviewed FAQ, never fuzzy matching', async () => {
    await db.pool.query('truncate model_policy_versions cascade');
    fixture.disableModel();
    await fixture.applySyntheticFaqQuestion('en');
    expect(await fixture.count('knowledge_gap_observations')).toBe(0);
    expect(await fixture.count('outbound_intents')).toBe(1);
  });
  test('runtime FAQ thresholds cannot bypass the active versioned policy', async () => {
    await fixture.event('How is synthetic support provided online?');
    await fixture.run(await fixture.claim());
    expect(fixture.manifestCalls()).toBe(1);
    expect(await fixture.count('knowledge_gap_observations')).toBe(1);
  });
  test('repairs a crash after creating a draft without another model call', async () => {
    await fixture.runThrough('draft_persisted');
    await fixture.restart();
    expect(await fixture.count('outbound_intents')).toBe(1);
    expect(fixture.manifestCalls()).toBe(1);
  });
  test('repairs a crash after intent insertion with a later clock', async () => {
    await fixture.runThrough('intent_inserted');
    await fixture.restart();
    expect(await fixture.count('outbound_intents')).toBe(1);
    expect(await fixture.count('support_reply_drafts')).toBe(1);
    expect(fixture.manifestCalls()).toBe(0);
  });
  test.each(['en', 'bn'] as const)(
    'model disabled keeps approved %s FAQ resolution available',
    async (language) => {
      fixture.disableModel();
      await fixture.applySyntheticFaqQuestion(language);
      expect(fixture.manifestCalls()).toBe(0);
      expect(await fixture.readyDraftLanguages()).toEqual([language]);
      expect(await fixture.count('outbound_intents')).toBe(1);
    },
  );
  test('reconciliation after application still routes exact privacy intake first', async () => {
    const id = await fixture.event('REQUEST MY DATA');
    await fixture.processor.processEvent(id);
    await fixture.run(await fixture.claim());
    expect(await db.pool.query('select state from privacy_requests')).toMatchObject({
      rows: [{ state: 'human_review' }],
    });
    expect(await fixture.count('support_reply_drafts')).toBe(0);
    expect(fixture.manifestCalls()).toBe(0);
  });
  test('exact STOP MARKETING uses existing consent/suppression intake, never ordinary reply', async () => {
    await fixture.event('STOP MARKETING');
    await fixture.run(await fixture.claim());
    expect(
      await db.pool.query('select count(*)::int as n from privacy_suppressions'),
    ).toMatchObject({ rows: [{ n: MARKETING_CATEGORIES.length }] });
    expect(await fixture.count('support_reply_drafts')).toBe(0);
  });
  test('missing model policy produces a safe draft and escalation without a provider request', async () => {
    await db.pool.query('truncate model_policy_versions cascade');
    await fixture.event('Where can synthetic online support be found?');
    await fixture.run(await fixture.claim());
    expect(fixture.manifestCalls()).toBe(0);
    expect(await fixture.count('support_escalation_outcomes')).toBe(1);
    expect(await fixture.count('support_reply_drafts')).toBe(1);
    expect(await fixture.count('knowledge_gap_observations')).toBe(1);
  });
  test('parallel workers cannot duplicate work or a ready draft', async () => {
    await fixture.event();
    await fixture.work.reconcile(10, fixture.now);
    const claims = (
      await Promise.all(
        ['a', 'b'].map((suffix) =>
          fixture.work.claim({
            workerRef: `WORKER_TEST_${suffix}`,
            evaluatedAt: fixture.now,
            limit: 10,
            leaseMilliseconds: 1000,
          }),
        ),
      )
    ).flat();
    expect(claims).toHaveLength(1);
    await Promise.all(claims.map((claimed) => fixture.run(claimed)));
    expect(await fixture.count('outbound_intents')).toBe(1);
  });
  test.each(['business_message_echo', 'message_status'] as const)(
    '%s never produces a draft',
    async (eventKind) => {
      await insertSyntheticPendingEvent(db.pool, {
        fixtureKey: `runtime_${eventKind}`,
        channel: 'messenger',
        channelAccountId: identity.channelAccountId,
        contactId: identity.externalContactId,
        eventKind,
        occurredAt: base,
        externalMessageId: 'MESSAGE_TEST_runtime',
        ...(eventKind === 'message_status' ? { messageStatus: 'delivered' } : {}),
      });
      await fixture.run(await fixture.claim());
      expect(await fixture.count('support_reply_drafts')).toBe(0);
      expect(fixture.manifestCalls()).toBe(0);
    },
  );
  test.each(['pause', 'deletion'] as const)(
    'late %s prevents intent creation after a ready draft',
    async (hold) => {
      await fixture.event();
      const claimed = await fixture.claim();
      const dependencies = fixture.dependencies();
      await runReplyStage(claimed, dependencies);
      await runReplyStage({ ...claimed, stage: 'decide' }, dependencies);
      if (hold === 'pause')
        await db.pool.query('update conversations set ai_paused_until=$1', [
          new Date(at.getTime() + 86400000),
        ]);
      else {
        const source = await insertSyntheticAppliedCustomerEvent(db.pool, {
          fixtureKey: 'runtime_delete',
          identity,
          occurredAt: at,
          messageText: 'DELETE MY DATA',
        });
        await new PostgresPrivacyRightsPolicy(db.pool, syntheticPrivacyKeyring).processAppliedEvent(
          { sourceWebhookEventId: source.eventId, requestKey: 'REQUEST_TEST_runtime_delete' },
        );
      }
      await runReplyStage({ ...claimed, stage: 'enqueue' }, dependencies);
      expect(await fixture.count('outbound_intents')).toBe(0);
    },
  );
});
