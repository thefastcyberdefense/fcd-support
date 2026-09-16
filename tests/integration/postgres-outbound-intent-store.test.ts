import { Buffer } from 'node:buffer';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { OutboundDeploymentBounds } from '../../src/outbound/outbound-types.js';
import { createIdentityHmac } from '../../src/policy/privacy-identity.js';
import type { ReviewerPrincipal } from '../../src/policy/policy-types.js';
import { PostgresOutboundIntentStore } from '../../src/persistence/postgres-outbound-intent-store.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundTemplate } from '../../src/persistence/postgres-outbound-template.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import { insertSyntheticAppliedCustomerEvent, syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';

let dispose: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let store: PostgresOutboundIntentStore;

const baseAt = new Date('2026-09-15T08:00:00.000Z');
const customerAt = new Date('2026-09-15T10:00:00.000Z');
const evaluatedAt = new Date('2026-09-15T11:00:00.000Z');
const administrator: ReviewerPrincipal = {
  reviewerRef: 'ADMIN_TEST_outbound_intent',
  roles: ['administrator'],
};
const syntheticPrivacyKey = syntheticPrivacyKeyring.keys.get('TEST_v1');
if (syntheticPrivacyKey === undefined) throw new Error('Synthetic privacy key is missing');
const bounds = Object.freeze({
  global1Minute: 120,
  globalUtcDay: 900,
  leaseMs: 25_000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 80,
  perContact15Minute: 3,
  perContact24Hour: 30,
  providerTimeoutMs: 8000,
  retryBaseMs: 5000,
  retryMaximumMs: 30_000,
  whatsappAccount1Minute: 90,
  workerBatchSize: 10,
}) satisfies OutboundDeploymentBounds;

beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_outbound_intent_store');
  pool = database.pool;
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
      outbound_policy_versions, admin_accounts
    restart identity cascade
  `);
  store = new PostgresOutboundIntentStore(pool, syntheticPrivacyKeyring, bounds);
  await seedAdministrator();
  await seedActivePolicy();
});

afterAll(async () => {
  await dispose?.();
});

async function seedAdministrator(): Promise<void> {
  const inserted = await pool.query<{ readonly id: string }>(
    `insert into admin_accounts
       (account_ref, login_name, password_algorithm, password_cost,
        password_block_size, password_parallelization, password_key_length,
        password_salt, password_hash, state, created_at, updated_at,
        password_changed_at)
     values ($1, 'synthetic.outbound.intent', 'scrypt_v1', 16384,
             8, 1, 32, $2, $3, 'active', $4, $4, $4)
     returning id`,
    [administrator.reviewerRef, Buffer.alloc(16, 0x75), Buffer.alloc(32, 0x76), baseAt],
  );
  await pool.query(
    `insert into admin_role_assignments
       (account_id, role, action, actor_account_id, effective_at, request_key)
     values ($1, 'administrator', 'assign', $1, $2,
             'REQUEST_TEST_outbound_intent_admin_role')`,
    [inserted.rows[0]?.id, baseAt],
  );
}

async function seedActivePolicy(): Promise<void> {
  const policies = new PostgresOutboundPolicy(pool);
  await policies.createVersion(
    {
      createdAt: new Date(baseAt.getTime() + 1000),
      createdByAccountRef: administrator.reviewerRef,
      policyRef: 'POLICY_TEST_outbound_intent',
      requestKey: 'REQUEST_TEST_outbound_intent_policy_create',
      values: bounds,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await policies[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        policyRef: 'POLICY_TEST_outbound_intent',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_outbound_intent_policy_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
      },
      administrator,
    );
  }
}

function identity(key: string, channel: 'messenger' | 'whatsapp' = 'whatsapp') {
  return {
    channel,
    channelAccountId: channel === 'whatsapp' ? 'PHONE_TEST_outbound' : 'PAGE_TEST_outbound',
    externalContactId: `CONTACT_TEST_outbound_${key}`,
  };
}

async function seedReadyDraft(key: string, occurredAt = customerAt) {
  const customerIdentity = identity(key);
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: `outbound_intent_${key}`,
    identity: customerIdentity,
    messageText: 'Synthetic customer question excluded from outbound intent state.',
    occurredAt,
  });
  const inserted = await pool.query<{ readonly id: string }>(
    `insert into support_reply_drafts
       (draft_ref, source_webhook_event_id, conversation_id, decision_type,
        language, answer_text, state, retention_deadline, request_key, created_at)
     values ($1,$2,$3,'safe_failure','en',$4,'ready',$5,$6,$7)
     returning id`,
    [
      `DRAFT_TEST_outbound_${key}`,
      source.eventId,
      source.conversationId,
      'Synthetic reviewed reply that must not be copied to the intent.',
      new Date(occurredAt.getTime() + 7 * 86_400_000),
      `REQUEST_TEST_outbound_draft_${key}`,
      new Date(occurredAt.getTime() + 1000),
    ],
  );
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
  return {
    ...source,
    contactId: authority.rows[0]?.contact_id ?? '',
    draftId: inserted.rows[0]?.id ?? '',
    draftRef: `DRAFT_TEST_outbound_${key}`,
    identity: customerIdentity,
    identityId: authority.rows[0]?.identity_id ?? '',
  };
}

async function seedActiveTemplate(
  channelAccountId: string,
  purpose: 'marketing_news' | 'marketing_offers' = 'marketing_news',
): Promise<string> {
  const templates = new PostgresOutboundTemplate(pool);
  const templateRef = `TEMPLATE_TEST_outbound_${purpose}`;
  await templates.createVersion(
    {
      category: purpose,
      channel: 'whatsapp',
      channelAccountId,
      contentSha256: 'd'.repeat(64),
      createdAt: new Date(baseAt.getTime() + 1000),
      locale: 'en_US',
      providerTemplateId: `META_TEMPLATE_TEST_${purpose}`,
      requestKey: `REQUEST_TEST_outbound_${purpose}_create`,
      templateName: `synthetic_${purpose}`,
      templateRef,
    },
    administrator,
  );
  for (const [index, action] of ['submitVersion', 'approveVersion', 'activateVersion'].entries()) {
    await templates[action as 'submitVersion' | 'approveVersion' | 'activateVersion'](
      {
        effectiveAt: new Date(baseAt.getTime() + (index + 2) * 1000),
        reasonCode: 'reviewed_outbound_template',
        requestKey: `REQUEST_TEST_outbound_${purpose}_${action}`,
        reviewerAccountRef: administrator.reviewerRef,
        templateRef,
        versionNumber: 1,
      },
      administrator,
    );
  }
  return templateRef;
}

async function grantConsent(identityId: string, category: string): Promise<void> {
  await pool.query(
    `insert into consent_events
       (channel_identity_id, category, action, wording, wording_version,
        source, source_at, idempotency_key)
     values ($1,$2,'grant','Synthetic explicit consent wording','v1',
             'reviewer_recorded',$3,$4)`,
    [
      identityId,
      category,
      new Date(evaluatedAt.getTime() - 1000),
      `CONSENT_TEST_${category}_${identityId}`,
    ],
  );
}

describe('PostgreSQL outbound intent store', () => {
  test('creates one content-free support intent under replay and concurrent workers', async () => {
    const fixture = await seedReadyDraft('support_replay');
    const command = {
      draftRef: fixture.draftRef,
      evaluatedAt,
      requestKey: 'REQUEST_TEST_outbound_support_replay',
    };

    const outcomes = await Promise.all([
      store.createSupportIntent(command),
      store.createSupportIntent(command),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(['created', 'duplicate']);

    const stored = await pool.query<{
      readonly channel: string;
      readonly message_kind: string;
      readonly purpose: string;
      readonly reply_draft_id: string | null;
      readonly serialized: string;
      readonly state: string;
      readonly template_version_id: string | null;
    }>(
      `select intent.intent_ref, intent.request_key, intent.reply_draft_id,
              intent.template_version_id, intent.channel, intent.channel_account_id,
              intent.purpose, intent.message_kind, intent.state,
              to_jsonb(intent)::text as serialized
       from outbound_intents as intent`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      channel: 'whatsapp',
      message_kind: 'support_text',
      purpose: 'customer_support',
      reply_draft_id: fixture.draftId,
      state: 'pending',
      template_version_id: null,
    });
    expect(stored.rows[0]?.serialized).not.toContain('Synthetic reviewed reply');
    expect(stored.rows[0]?.serialized).not.toContain(fixture.identity.externalContactId);
  });

  test('rejects request/source conflicts and rechecks the locked source', async () => {
    const first = await seedReadyDraft('support_conflict_one');
    const second = await seedReadyDraft('support_conflict_two');
    const requestKey = 'REQUEST_TEST_outbound_support_conflict';
    await store.createSupportIntent({ draftRef: first.draftRef, evaluatedAt, requestKey });

    await expect(
      store.createSupportIntent({ draftRef: second.draftRef, evaluatedAt, requestKey }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
    await expect(
      store.createSupportIntent({
        draftRef: first.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_support_other_key',
      }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);

    await pool.query(
      `update support_reply_drafts
       set state = 'erased', answer_text = null, erased_at = $2
       where id = $1`,
      [second.draftId, evaluatedAt],
    );
    await expect(
      store.createSupportIntent({
        draftRef: second.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_support_erased',
      }),
    ).resolves.toEqual({ reason: 'content_erased', status: 'denied' });
    await expect(
      pool.query('select count(*)::int as count from outbound_intents'),
    ).resolves.toMatchObject({
      rows: [{ count: 1 }],
    });
  });

  test('does not convert an outside-window support draft into a template', async () => {
    const oldCustomerAt = new Date(evaluatedAt.getTime() - 86_400_000 - 1);
    const fixture = await seedReadyDraft('support_expired_window', oldCustomerAt);
    await expect(
      store.createSupportIntent({
        draftRef: fixture.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_support_expired_window',
      }),
    ).resolves.toEqual({ reason: 'template_required', status: 'denied' });
    await expect(
      pool.query(
        `select (select count(*)::int from outbound_intents) as intents,
                (select count(*)::int from outbound_escalation_outcomes
                 where reason_code = 'template_required') as escalations`,
      ),
    ).resolves.toMatchObject({ rows: [{ escalations: 1, intents: 0 }] });
  });

  test('enforces exact template consent and global or scoped suppression', async () => {
    const fixture = await seedReadyDraft('template_news');
    const templateRef = await seedActiveTemplate(fixture.identity.channelAccountId);
    const command = {
      conversationId: fixture.conversationId,
      evaluatedAt,
      purpose: 'marketing_news' as const,
      requestKey: 'REQUEST_TEST_outbound_template_news',
      templateRef,
    };

    await expect(store.createFixedTemplateIntent(command)).resolves.toEqual({
      reason: 'consent_missing',
      status: 'denied',
    });
    await grantConsent(fixture.identityId, 'newsletter');
    await expect(
      store.createFixedTemplateIntent({ ...command, requestKey: `${command.requestKey}_allowed` }),
    ).resolves.toMatchObject({ status: 'created' });
    const replayConflict = await seedReadyDraft('template_news_replay_conflict');
    await expect(
      store.createFixedTemplateIntent({
        ...command,
        conversationId: replayConflict.conversationId,
        requestKey: `${command.requestKey}_allowed`,
      }),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);

    const hmac = createIdentityHmac(fixture.identity, {
      key: syntheticPrivacyKey,
      version: 'TEST_v1',
    });
    await pool.query(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1,'whatsapp','marketing_opt_out:newsletter','customer_opt_out',$2,'TEST_v1')`,
      [hmac, new Date(evaluatedAt.getTime() - 500)],
    );
    await expect(
      store.createFixedTemplateIntent({
        ...command,
        requestKey: 'REQUEST_TEST_outbound_template_scoped_suppressed',
      }),
    ).resolves.toEqual({ reason: 'suppressed', status: 'denied' });
    const second = await seedReadyDraft('template_news_suppressed');
    await grantConsent(second.identityId, 'newsletter');
    const secondHmac = createIdentityHmac(second.identity, {
      key: syntheticPrivacyKey,
      version: 'TEST_v1',
    });
    await pool.query(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1,'whatsapp','marketing_opt_out','customer_opt_out',$2,'TEST_v1')`,
      [secondHmac, new Date(evaluatedAt.getTime() - 500)],
    );
    await expect(
      store.createFixedTemplateIntent({
        ...command,
        conversationId: second.conversationId,
        requestKey: 'REQUEST_TEST_outbound_template_global_suppressed',
      }),
    ).resolves.toEqual({ reason: 'suppressed', status: 'denied' });
  });

  test('keeps support available after opt-out but denies privacy holds and deletion tombstones', async () => {
    const support = await seedReadyDraft('support_opt_out');
    const supportHmac = createIdentityHmac(support.identity, {
      key: syntheticPrivacyKey,
      version: 'TEST_v1',
    });
    await pool.query(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1,'whatsapp','marketing_opt_out','customer_opt_out',$2,'TEST_v1')`,
      [supportHmac, new Date(evaluatedAt.getTime() - 500)],
    );
    await expect(
      store.createSupportIntent({
        draftRef: support.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_support_after_opt_out',
      }),
    ).resolves.toMatchObject({ status: 'created' });

    const held = await seedReadyDraft('support_privacy_hold');
    await pool.query(
      `insert into privacy_requests
         (request_ref, request_type, state, contact_id, received_at, open_request_key)
       values ('PRIVACY_TEST_outbound_hold','access','received',$1,$2,
               'REQUEST_TEST_outbound_privacy_hold')`,
      [held.contactId, new Date(evaluatedAt.getTime() - 500)],
    );
    await expect(
      store.createSupportIntent({
        draftRef: held.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_support_privacy_hold',
      }),
    ).resolves.toEqual({ reason: 'privacy_hold', status: 'denied' });

    const deleted = await seedReadyDraft('support_deleted');
    const deletionHmac = createIdentityHmac(deleted.identity, {
      key: syntheticPrivacyKey,
      version: 'TEST_v1',
    });
    await pool.query(
      `insert into privacy_suppressions
         (identity_hmac, channel, category, reason_code, effective_at, key_version)
       values ($1,'whatsapp','deletion_tombstone','customer_deletion',$2,'TEST_v1')`,
      [deletionHmac, new Date(evaluatedAt.getTime() - 500)],
    );
    await expect(
      store.createSupportIntent({
        draftRef: deleted.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_support_deleted',
      }),
    ).resolves.toEqual({ reason: 'identity_deleted', status: 'denied' });
  });

  test('denies an overdue active-client review with the specific closed reason', async () => {
    const fixture = await seedReadyDraft('active_review_overdue');
    await pool.query(
      `update conversation_retention_states
       set lifecycle_class = 'active_client', anchor_at = null, expires_at = null,
           relationship_status = 'open', relationship_started_at = $2,
           relationship_ended_at = null, final_paid_service_completed_at = null,
           last_active_review_at = $2, next_active_review_at = $3
       where conversation_id = $1`,
      [fixture.conversationId, baseAt, evaluatedAt],
    );
    await expect(
      store.createSupportIntent({
        draftRef: fixture.draftRef,
        evaluatedAt,
        requestKey: 'REQUEST_TEST_outbound_active_review_overdue',
      }),
    ).resolves.toEqual({ reason: 'active_review_overdue', status: 'denied' });
  });

  test.each([
    [
      'policy_unavailable',
      'truncate table outbound_policy_review_events, outbound_policy_versions cascade',
    ],
    ['pause_active', `update conversations set ai_paused_until = '2026-09-15T12:00:00.000Z'`],
    [
      'retention_expired',
      `update conversation_retention_states
       set expires_at = '2026-09-15T10:59:59.999Z',
           anchor_at = '2026-09-08T10:59:59.999Z'`,
    ],
  ] as const)('denies %s without creating an intent', async (reason, mutation) => {
    const fixture = await seedReadyDraft(`denied_${reason}`);
    await pool.query(mutation);
    await expect(
      store.createSupportIntent({
        draftRef: fixture.draftRef,
        evaluatedAt,
        requestKey: `REQUEST_TEST_outbound_denied_${reason}`,
      }),
    ).resolves.toEqual({ reason, status: 'denied' });
    await expect(
      pool.query('select count(*)::int as count from outbound_intents'),
    ).resolves.toMatchObject({
      rows: [{ count: 0 }],
    });
  });
});
