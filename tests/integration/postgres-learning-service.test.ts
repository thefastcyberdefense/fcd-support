import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { PostgresLearningService } from '../../src/persistence/postgres-learning-service.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticLinkedCustomerIdentities,
  insertSyntheticPendingEvent,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase } from './test-database.js';
import type { GapKind, LearningPolicy } from '../../src/learning/learning-types.js';

let pool: pg.Pool;
let dispose: (() => Promise<void>) | undefined;
const base = new Date('2026-09-06T06:00:00.000Z');
let at = new Date(base);
const policy: LearningPolicy = {
  minimumGroupCount: 3,
  digestIntervalMilliseconds: 259200000,
  maximumQuestionsPerDigest: 5,
  questionCooldownMilliseconds: 604800000,
  maximumDigestAppearances: 2,
  maximumObservationsPerRun: 1000,
};
let service: PostgresLearningService;
const reviewer = { reviewerRef: 'ADMIN_TEST_learning', roles: ['administrator'] } as const;
beforeAll(async () => {
  const database = await createIsolatedTestDatabase('postgres_learning_service');
  pool = database.pool;
  dispose = database.dispose;
});
beforeEach(async () => {
  await pool.query(
    'truncate table contacts, webhook_receipts, webhook_events, knowledge_sources, knowledge_items, admin_accounts, customer_insight_runs, owner_questions, owner_question_digests restart identity cascade',
  );
  at = new Date(base);
  service = new PostgresLearningService(pool, { policy, now: () => new Date(at) });
});
afterAll(async () => {
  await dispose?.();
});

async function gap(
  key: string,
  options: { kind?: GapKind; language?: 'en' | 'bn'; contactKey?: string; deadline?: Date } = {},
) {
  const occurredAt = new Date(base.getTime() - 60000);
  const applied = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'learning_' + key,
    identity: {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_learning',
      externalContactId: 'PSID_TEST_' + (options.contactKey ?? key),
    },
    occurredAt,
    messageText: 'SYNTHETIC_RAW_MESSAGE_MUST_NOT_ENTER_LEARNING',
  });
  return {
    observationRef: 'OBSERVATION_TEST_' + key,
    requestKey: 'REQUEST_TEST_gap_' + key,
    webhookEventId: applied.eventId,
    observedAt: occurredAt,
    retentionDeadline: options.deadline ?? new Date('2026-10-01T06:00:00.000Z'),
    language: options.language ?? 'en',
    gapKind: options.kind ?? 'faq_miss',
  };
}
function run(key: string) {
  return {
    runRef: 'RUN_TEST_' + key,
    requestKey: 'REQUEST_TEST_run_' + key,
    windowStartedAt: new Date(base.getTime() - 120000),
    windowEndedAt: new Date(base),
  };
}
async function seedOwnerQuestion(key: string, priority: 'high' | 'low' | 'normal' = 'normal') {
  for (let index = 0; index < policy.minimumGroupCount; index += 1)
    await service.recordGapObservation(await gap(`seed_${key}_${String(index)}`));
  const runRow = await pool.query<{ id: string }>(
    `insert into customer_insight_runs
      (run_ref, window_started_at, window_ended_at, minimum_group_count, state,
       source_observation_count, request_key, created_at)
     values ($1,$2,$3,3,'completed',3,$4,$5) returning id`,
    [
      'RUN_TEST_seed_' + key,
      new Date(base.getTime() - 120000),
      base,
      'REQUEST_TEST_seed_run_' + key,
      new Date(base.getTime() - 240000),
    ],
  );
  const insightRow = await pool.query<{ id: string }>(
    `insert into customer_insight_entries
      (insight_ref, run_id, topic_code, category_code, language, occurrence_count,
       sanitized_summary, retention_deadline, created_at)
     values ($1,$2,'knowledge_coverage','faq_miss','en',3,null,$3,$4) returning id`,
    [
      'INSIGHT_TEST_seed_' + key,
      runRow.rows[0]?.id,
      new Date('2026-10-01T06:00:00.000Z'),
      new Date(base.getTime() - 240000),
    ],
  );
  const questionRef = 'QUESTION_TEST_seed_' + key;
  const questionRow = await pool.query<{ id: string }>(
    `insert into owner_questions
      (question_ref, question_en, question_bn, priority, state,
       next_eligible_digest_at, request_key, created_at, updated_at)
     values ($1,$2,$3,$4,'open',$5,$6,$7,$7) returning id`,
    [
      questionRef,
      'Which reviewed answer should cover this synthetic support category?',
      'এই সিনথেটিক সহায়তা বিভাগের জন্য কোন পর্যালোচিত উত্তর প্রযোজ্য?',
      priority,
      base,
      'REQUEST_TEST_seed_question_' + key,
      new Date(base.getTime() - 180000),
    ],
  );
  await pool.query(`insert into owner_question_insights (question_id, insight_id) values ($1,$2)`, [
    questionRow.rows[0]?.id,
    insightRow.rows[0]?.id,
  ]);
  return questionRef;
}
async function seedReviewer(assignRole = true) {
  await pool.query(
    `insert into admin_accounts
      (account_ref, login_name, password_algorithm, password_cost, password_block_size,
       password_parallelization, password_key_length, password_salt, password_hash,
       state, created_at, updated_at, password_changed_at)
     values ($1,'synthetic.learning','scrypt_v1',16384,8,1,32,$2,$3,'active',$4,$4,$4)`,
    [reviewer.reviewerRef, Buffer.alloc(16, 0x31), Buffer.alloc(32, 0x32), base],
  );
  if (assignRole)
    await pool.query(
      `insert into admin_role_assignments
        (account_id, role, action, actor_account_id, effective_at, request_key)
       select id, 'administrator', 'assign', id, $2, 'REQUEST_TEST_learning_admin_role'
       from admin_accounts where account_ref = $1`,
      [reviewer.reviewerRef, base],
    );
}
async function candidate() {
  const repository = new PostgresKnowledgeRepository(pool);
  await repository.createSource(
    {
      sourceRef: 'SOURCE_TEST_learning',
      sourceType: 'manual_business',
      label: 'Synthetic learning candidate source',
      createdByReference: reviewer.reviewerRef,
      createdAt: new Date(base.getTime() - 120000),
    },
    reviewer,
  );
  await repository.createProposal(
    {
      versionRef: 'VERSION_TEST_learning',
      itemKey: 'faq.synthetic.learning',
      kind: 'faq',
      questions: { en: 'Synthetic support question?', bn: 'সিনথেটিক সহায়তা প্রশ্ন?' },
      answers: { en: 'Synthetic reviewed answer.', bn: 'সিনথেটিক পর্যালোচিত উত্তর।' },
      aliases: [],
      tags: [],
      authorReference: reviewer.reviewerRef,
      sourceRef: 'SOURCE_TEST_learning',
      contentSha256: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64),
      createdAt: new Date(base.getTime() - 120000),
      requestKey: 'REQUEST_TEST_candidate',
    },
    reviewer,
  );
  return new PostgresKnowledgePublication(pool);
}

describe('Postgres proposal-only learning', () => {
  test('records only applied internal-event metadata exactly once across concurrent replay', async () => {
    const input = await gap('replay');
    const results = await Promise.all([
      service.recordGapObservation(input),
      service.recordGapObservation(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['created', 'duplicate']);
    expect(results.map((result) => result.observationRef)).toEqual([
      input.observationRef,
      input.observationRef,
    ]);
    const rows = await pool.query<{ count: number; summary_count: number }>(
      'select count(*)::int as count, count(sanitized_summary)::int as summary_count from knowledge_gap_observations',
    );
    expect(rows.rows).toEqual([{ count: 1, summary_count: 0 }]);
    expect(JSON.stringify(results)).not.toContain('SYNTHETIC_RAW_MESSAGE');
  });
  test('rejects unapplied, missing, and non-customer events without learning rows', async () => {
    const input = await gap('authority');
    const pending = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_learning',
      contactId: 'PSID_TEST_unapplied',
      eventKind: 'customer_message',
      fixtureKey: 'learning_pending',
      occurredAt: input.observedAt,
    });
    await expect(
      service.recordGapObservation({ ...input, webhookEventId: pending }),
    ).rejects.toThrow();
    await expect(
      service.recordGapObservation({ ...input, webhookEventId: '999999' }),
    ).rejects.toThrow();
    const echo = await insertSyntheticPendingEvent(pool, {
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_learning',
      contactId: 'PSID_TEST_echo',
      eventKind: 'business_message_echo',
      fixtureKey: 'learning_echo',
      occurredAt: input.observedAt,
    });
    await expect(
      service.recordGapObservation({ ...input, webhookEventId: echo }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from knowledge_gap_observations',
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  test('rejects changed replay material, alternate event keys, and reused observation references', async () => {
    const input = await gap('conflict');
    await service.recordGapObservation(input);
    await expect(
      service.recordGapObservation({ ...input, gapKind: 'faq_ambiguous' }),
    ).rejects.toThrow();
    await expect(
      service.recordGapObservation({ ...input, requestKey: 'REQUEST_TEST_alternate' }),
    ).rejects.toThrow();
    const another = await gap('another');
    await expect(
      service.recordGapObservation({ ...another, observationRef: input.observationRef }),
    ).rejects.toThrow();
  });
  test('accepts only candidates that were published at observation time', async () => {
    const input = await gap('candidate');
    const publication = await candidate();
    await expect(
      service.recordGapObservation({ ...input, candidateVersionRefs: ['VERSION_TEST_learning'] }),
    ).rejects.toThrow();
    const command = {
      versionRef: 'VERSION_TEST_learning',
      reviewerReference: reviewer.reviewerRef,
      effectiveAt: new Date(base.getTime() - 120000),
    };
    await publication.submitVersion(
      {
        ...command,
        action: 'submit',
        reasonCode: 'ready_for_review',
        requestKey: 'REQUEST_TEST_candidate_submit',
      },
      reviewer,
    );
    await publication.reviewVersion(
      {
        ...command,
        action: 'approve',
        reasonCode: 'business_fact_verified',
        requestKey: 'REQUEST_TEST_candidate_approve',
      },
      reviewer,
    );
    await publication.publishVersion(
      {
        ...command,
        action: 'publish',
        itemKey: 'faq.synthetic.learning',
        reasonCode: 'manual_publication',
        requestKey: 'REQUEST_TEST_candidate_publish',
      },
      reviewer,
    );
    await expect(
      service.recordGapObservation({ ...input, candidateVersionRefs: ['VERSION_TEST_learning'] }),
    ).resolves.toMatchObject({ status: 'created' });
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from knowledge_gap_candidates',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  test('enforces authoritative retention and rejects future, purged, and erased sources', async () => {
    const input = await gap('retention');
    await expect(
      service.recordGapObservation({
        ...input,
        retentionDeadline: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow();
    await expect(
      service.recordGapObservation({ ...input, observedAt: new Date(base.getTime() + 1) }),
    ).rejects.toThrow();
    await pool.query(
      'update conversation_retention_states set content_purged_through_at = anchor_at',
    );
    await expect(service.recordGapObservation(input)).rejects.toThrow();
    const erased = await gap('erased');
    await pool.query(
      'update webhook_events set contact_id=null, channel_account_id=null, message_text=null where id=$1',
      [erased.webhookEventId],
    );
    await expect(service.recordGapObservation(erased)).rejects.toThrow();
  });
  test('aggregates closed categories only, suppresses low counts, and inherits the shortest deadline', async () => {
    for (const key of ['a', 'b', 'c'])
      await service.recordGapObservation(
        await gap(key, {
          deadline: new Date(key === 'b' ? '2026-09-15T06:00:00.000Z' : '2026-10-01T06:00:00.000Z'),
        }),
      );
    await service.recordGapObservation(await gap('low', { language: 'bn', kind: 'escalation' }));
    const input = run('aggregate');
    const results = await Promise.all([
      service.aggregateInsights(input),
      service.aggregateInsights(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['created', 'duplicate']);
    const rows = await pool.query<{
      topic_code: string;
      category_code: string;
      language: string;
      occurrence_count: number;
      sanitized_summary: null;
      retention_deadline: Date;
    }>(
      'select topic_code,category_code,language,occurrence_count,sanitized_summary,retention_deadline from customer_insight_entries',
    );
    expect(rows.rows).toEqual([
      {
        topic_code: 'knowledge_coverage',
        category_code: 'faq_miss',
        language: 'en',
        occurrence_count: 3,
        sanitized_summary: null,
        retention_deadline: new Date('2026-09-15T06:00:00.000Z'),
      },
    ]);
    const questions = await pool.query<{
      question_en: string;
      question_bn: string;
      state: string;
    }>('select question_en, question_bn, state from owner_questions');
    expect(questions.rows).toEqual([
      {
        question_en: 'Which reviewed answer should cover this recurring FAQ gap?',
        question_bn: 'এই পুনরাবৃত্ত FAQ ঘাটতির জন্য কোন পর্যালোচিত উত্তর প্রযোজ্য?',
        state: 'open',
      },
    ]);
    expect(JSON.stringify(questions.rows)).not.toContain('SYNTHETIC_RAW_MESSAGE');
    await service.aggregateInsights(run('aggregate_repeat'));
    expect(
      (await pool.query<{ count: number }>('select count(*)::int as count from owner_questions'))
        .rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from owner_question_insights',
        )
      ).rows[0]?.count,
    ).toBe(2);
    await expect(
      service.aggregateInsights({ ...input, windowStartedAt: new Date(base.getTime() - 180000) }),
    ).rejects.toThrow();
  });
  test('does not unlock an insight group through repeated events from one conversation', async () => {
    for (const key of ['a', 'b', 'c'])
      await service.recordGapObservation(await gap(key, { contactKey: 'same' }));
    await expect(service.aggregateInsights(run('one_subject'))).resolves.toMatchObject({
      entryCount: 0,
    });
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from customer_insight_entries',
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  test('counts distinct people rather than linked channel conversations for suppression', async () => {
    const occurredAt = new Date(base.getTime() - 60_000);
    const linked = await insertSyntheticLinkedCustomerIdentities(pool, {
      fixtureKey: 'learning_linked_person',
      seeds: [
        {
          identity: {
            channel: 'messenger',
            channelAccountId: 'PAGE_TEST_learning_linked_a',
            externalContactId: 'PSID_TEST_learning_linked_a',
          },
          occurredAt,
        },
        {
          identity: {
            channel: 'messenger',
            channelAccountId: 'PAGE_TEST_learning_linked_b',
            externalContactId: 'PSID_TEST_learning_linked_b',
          },
          occurredAt,
        },
        {
          identity: {
            channel: 'whatsapp',
            channelAccountId: 'PHONE_TEST_learning_linked',
            externalContactId: 'WAID_TEST_learning_linked',
          },
          occurredAt,
        },
      ],
    });
    for (const [index, eventId] of linked.eventIds.entries())
      await service.recordGapObservation({
        observationRef: 'OBSERVATION_TEST_linked_' + String(index),
        requestKey: 'REQUEST_TEST_gap_linked_' + String(index),
        webhookEventId: eventId,
        observedAt: occurredAt,
        retentionDeadline: new Date('2026-10-01T06:00:00.000Z'),
        language: 'en',
        gapKind: 'faq_miss',
      });
    await expect(service.aggregateInsights(run('linked_person'))).resolves.toMatchObject({
      entryCount: 0,
    });
  });
  test('excludes observations placed under a later privacy hold', async () => {
    const inputs = await Promise.all(['hold_a', 'hold_b', 'hold_c'].map((key) => gap(key)));
    for (const input of inputs) await service.recordGapObservation(input);
    await expect(service.aggregateInsights(run('privacy_hold_before'))).resolves.toMatchObject({
      entryCount: 1,
    });
    await pool.query(
      `insert into privacy_requests
        (request_ref, request_type, state, contact_id, source_webhook_event_id,
         received_at, open_request_key, updated_at)
       select 'PRIVACY_TEST_learning_hold','access','received',identity.contact_id,
              observation.source_webhook_event_id,$2,'OPEN_TEST_learning_hold',$2
       from knowledge_gap_observations as observation
       join conversations as conversation on conversation.id = observation.conversation_id
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where observation.observation_ref = $1`,
      [inputs[0]?.observationRef, base],
    );
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_privacy_hold',
        requestKey: 'REQUEST_TEST_digest_privacy_hold',
      }),
    ).resolves.toEqual({ status: 'empty', questionRefs: [] });
    await expect(service.aggregateInsights(run('privacy_hold_after'))).resolves.toMatchObject({
      entryCount: 0,
    });
  });
  test('excludes observations whose source content was purged later', async () => {
    const inputs = await Promise.all(['purge_a', 'purge_b', 'purge_c'].map((key) => gap(key)));
    for (const input of inputs) await service.recordGapObservation(input);
    await expect(service.aggregateInsights(run('purged_source_before'))).resolves.toMatchObject({
      entryCount: 1,
    });
    await pool.query(
      `update conversation_retention_states as retention
       set content_purged_through_at = retention.anchor_at
       from knowledge_gap_observations as observation
       where observation.conversation_id = retention.conversation_id
         and observation.observation_ref = $1`,
      [inputs[0]?.observationRef],
    );
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_purged_source',
        requestKey: 'REQUEST_TEST_digest_purged_source',
      }),
    ).resolves.toEqual({ status: 'empty', questionRefs: [] });
    await expect(service.aggregateInsights(run('purged_source_after'))).resolves.toMatchObject({
      entryCount: 0,
    });
  });
  test('fails atomically when reporting exceeds the configured observation bound', async () => {
    for (const key of ['a', 'b', 'c']) await service.recordGapObservation(await gap(key));
    const bounded = new PostgresLearningService(pool, {
      policy: { ...policy, minimumGroupCount: 2, maximumObservationsPerRun: 2 },
      now: () => new Date(at),
    });
    await expect(bounded.aggregateInsights(run('bounded'))).rejects.toThrow();
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from customer_insight_runs',
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  test('creates no digest row when no eligible owner question exists', async () => {
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_empty',
        requestKey: 'REQUEST_TEST_digest_empty',
      }),
    ).resolves.toEqual({ status: 'empty', questionRefs: [] });
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from owner_question_digests',
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  test('selects at most five questions and enforces the configurable three-day cadence', async () => {
    for (let index = 1; index <= 6; index += 1)
      await seedOwnerQuestion(String(index), index === 6 ? 'high' : 'normal');
    const first = {
      digestRef: 'DIGEST_TEST_first',
      requestKey: 'REQUEST_TEST_digest_first',
    };
    await expect(service.openQuestionDigest(first)).resolves.toMatchObject({
      status: 'created',
      questionRefs: [
        'QUESTION_TEST_seed_6',
        'QUESTION_TEST_seed_1',
        'QUESTION_TEST_seed_2',
        'QUESTION_TEST_seed_3',
        'QUESTION_TEST_seed_4',
      ],
    });
    await expect(service.openQuestionDigest(first)).resolves.toMatchObject({
      status: 'duplicate',
    });
    at = new Date(base.getTime() + policy.digestIntervalMilliseconds - 1);
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_early',
        requestKey: 'REQUEST_TEST_digest_early',
      }),
    ).resolves.toEqual({ status: 'not_due', questionRefs: [] });
    at = new Date(base.getTime() + policy.digestIntervalMilliseconds);
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_second',
        requestKey: 'REQUEST_TEST_digest_second',
      }),
    ).resolves.toEqual({
      status: 'created',
      digestRef: 'DIGEST_TEST_second',
      questionRefs: ['QUESTION_TEST_seed_5'],
    });
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from owner_question_digests',
        )
      ).rows[0]?.count,
    ).toBe(2);
  });
  test('serializes concurrent digests and does not repeat unchanged questions indefinitely', async () => {
    await seedOwnerQuestion('repeat');
    const concurrent = await Promise.all([
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_concurrent_a',
        requestKey: 'REQUEST_TEST_digest_concurrent_a',
      }),
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_concurrent_b',
        requestKey: 'REQUEST_TEST_digest_concurrent_b',
      }),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['created', 'not_due']);
    at = new Date(base.getTime() + policy.questionCooldownMilliseconds);
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_repeat',
        requestKey: 'REQUEST_TEST_digest_repeat',
      }),
    ).resolves.toMatchObject({ status: 'created', questionRefs: ['QUESTION_TEST_seed_repeat'] });
    at = new Date(base.getTime() + policy.questionCooldownMilliseconds * 2);
    await expect(
      service.openQuestionDigest({
        digestRef: 'DIGEST_TEST_exhausted',
        requestKey: 'REQUEST_TEST_digest_exhausted',
      }),
    ).resolves.toEqual({ status: 'empty', questionRefs: [] });
  });
  test('records an authenticated answer as an append-only draft proposal only', async () => {
    const questionRef = await seedOwnerQuestion('answer');
    await seedReviewer();
    const input = {
      questionRef,
      requestKey: 'REQUEST_TEST_owner_answer',
      answeredAt: base,
      answerText: 'Synthetic reviewed owner answer.',
      answerBn: 'সিনথেটিক পর্যালোচিত মালিকের উত্তর।',
    };
    const created = await service.answerOwnerQuestion(input, reviewer);
    expect(created.status).toBe('created');
    await expect(service.answerOwnerQuestion(input, reviewer)).resolves.toEqual({
      ...created,
      status: 'duplicate',
    });
    await expect(
      service.answerOwnerQuestion({ ...input, answerText: 'Changed synthetic answer.' }, reviewer),
    ).rejects.toThrow();
    const stored = await pool.query<{
      answer_bn: string;
      answer_en: string;
      source_type: string;
      state: string;
    }>(
      `select version.answer_en, version.answer_bn, version.state, source.source_type
       from owner_question_answers as answer
       join knowledge_versions as version on version.id = answer.proposal_version_id
       join knowledge_sources as source on source.id = version.source_id`,
    );
    expect(stored.rows).toEqual([
      {
        answer_en: input.answerText,
        answer_bn: input.answerBn,
        state: 'draft',
        source_type: 'support_gap',
      },
    ]);
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from knowledge_review_events',
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from knowledge_publication_events',
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect((await pool.query<{ state: string }>('select state from owner_questions')).rows).toEqual(
      [{ state: 'answered' }],
    );
  });
  test('opens a new generation when fresh insight follows a terminal owner question', async () => {
    for (const key of ['generation_a', 'generation_b', 'generation_c'])
      await service.recordGapObservation(await gap(key));
    await service.aggregateInsights(run('generation_first'));
    const questionRef = (
      await pool.query<{ question_ref: string }>('select question_ref from owner_questions')
    ).rows[0]?.question_ref;
    if (questionRef === undefined) throw new Error('Synthetic owner question was not created');
    await seedReviewer();
    await service.answerOwnerQuestion(
      {
        questionRef,
        requestKey: 'REQUEST_TEST_generation_answer',
        answeredAt: base,
        answerText: 'Synthetic reviewed generation answer.',
        answerBn: 'সিনথেটিক পর্যালোচিত প্রজন্মের উত্তর।',
      },
      reviewer,
    );
    await service.aggregateInsights(run('generation_second'));
    expect(
      (
        await pool.query<{ state: string }>(
          `select state from owner_questions order by created_at, id`,
        )
      ).rows,
    ).toEqual([{ state: 'answered' }, { state: 'open' }]);
  });
  test('rejects unauthorized, future, and publication-shaped owner answers atomically', async () => {
    const questionRef = await seedOwnerQuestion('answer_reject');
    await seedReviewer(false);
    const input = {
      questionRef,
      requestKey: 'REQUEST_TEST_owner_answer_reject',
      answeredAt: base,
      answerText: 'Synthetic reviewed answer.',
      answerBn: 'সিনথেটিক পর্যালোচিত উত্তর।',
    };
    await expect(service.answerOwnerQuestion(input, reviewer)).rejects.toThrow();
    await expect(
      service.answerOwnerQuestion(input, {
        reviewerRef: reviewer.reviewerRef,
        roles: ['support_reviewer'],
      }),
    ).rejects.toThrow();
    await expect(
      service.answerOwnerQuestion({ ...input, answeredAt: new Date(base.getTime() + 1) }, reviewer),
    ).rejects.toThrow();
    await expect(
      service.answerOwnerQuestion({ ...input, action: 'publish' }, reviewer),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<{ count: number }>(
          'select count(*)::int as count from owner_question_answers',
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
});
