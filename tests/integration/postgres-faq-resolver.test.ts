import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { normalizeFaqText } from '../../src/knowledge/faq-normalization.js';
import {
  prepareFaqResolutionText,
  type FaqResolutionPolicy,
  type PreparedFaqResolutionText,
} from '../../src/knowledge/faq-resolver.js';
import { PostgresFaqResolver } from '../../src/persistence/postgres-faq-resolver.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { inspectSensitiveText } from '../../src/safety/sensitive-data-gate.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let publication: PostgresKnowledgePublication;
let repository: PostgresKnowledgeRepository;

const editor = {
  reviewerRef: 'ADMIN_TEST_editor_faq_resolver',
  roles: ['knowledge_editor'],
} as const;
const reviewer = {
  reviewerRef: 'ADMIN_TEST_reviewer_faq_resolver',
  roles: ['knowledge_reviewer'],
} as const;
const policy = {
  ambiguityMargin: 0.08,
  maximumCandidates: 12,
  minimumSimilarity: 0.35,
} satisfies FaqResolutionPolicy;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('postgres_faq_resolver');
  disposeDatabase = database.dispose;
  pool = database.pool;
  publication = new PostgresKnowledgePublication(pool);
  repository = new PostgresKnowledgeRepository(pool);
});

afterAll(async () => {
  await disposeDatabase?.();
});

function proposalInput(
  suffix: string,
  sourceRef: string,
  versionNumber: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    aliases: [
      {
        kind: 'alias',
        language: 'en',
        phrase: `Synthetic help phrase ${suffix} version ${String(versionNumber)}`,
      },
      {
        kind: 'alias',
        language: 'bn',
        phrase: `সিনথেটিক সহায়তা বাক্য ${suffix} সংস্করণ ${String(versionNumber)}`,
      },
    ],
    answers: {
      en: `Synthetic reviewed answer ${suffix} version ${String(versionNumber)}.`,
      bn: `সিনথেটিক পর্যালোচিত উত্তর ${suffix} সংস্করণ ${String(versionNumber)}।`,
    },
    authorReference: editor.reviewerRef,
    contentSha256: versionNumber.toString(16).padStart(64, '0'),
    createdAt: new Date(`2026-09-03T10:${String(versionNumber).padStart(2, '0')}:00.000Z`),
    itemKey: `faq.synthetic.${suffix}`,
    kind: 'faq',
    questions: {
      en: `Synthetic question ${suffix} version ${String(versionNumber)}?`,
      bn: `সিনথেটিক প্রশ্ন ${suffix} সংস্করণ ${String(versionNumber)}?`,
    },
    requestKey: `REQUEST_TEST_faq_${suffix}_proposal_${String(versionNumber)}`,
    sourceRef,
    sourceSha256: 'a'.repeat(64),
    tags: ['synthetic'],
    versionRef: `VERSION_TEST_faq_${suffix}_${String(versionNumber)}`,
    ...overrides,
  };
}

async function createProposal(
  suffix: string,
  versionNumber = 1,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly itemKey: string; readonly sourceRef: string; readonly versionRef: string }> {
  const sourceRef = `SOURCE_TEST_faq_resolver_${suffix}`;
  const versionRef = `VERSION_TEST_faq_${suffix}_${String(versionNumber)}`;
  if (versionNumber === 1) {
    await repository.createSource(
      {
        createdAt: new Date('2026-09-03T10:00:00.000Z'),
        createdByReference: editor.reviewerRef,
        label: `Synthetic FAQ resolver source ${suffix}`,
        sourceRef,
        sourceType: 'manual_business',
      },
      editor,
    );
    await repository.createProposal(
      proposalInput(suffix, sourceRef, versionNumber, overrides),
      editor,
    );
  } else {
    await repository.createReplacementProposal(
      proposalInput(suffix, sourceRef, versionNumber, {
        replacesVersionRef: `VERSION_TEST_faq_${suffix}_${String(versionNumber - 1)}`,
        ...overrides,
      }),
      editor,
    );
  }
  return { itemKey: `faq.synthetic.${suffix}`, sourceRef, versionRef };
}

async function approveVersion(
  suffix: string,
  versionNumber = 1,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly itemKey: string; readonly sourceRef: string; readonly versionRef: string }> {
  const created = await createProposal(suffix, versionNumber, overrides);
  await publication.submitVersion(
    {
      action: 'submit',
      effectiveAt: new Date(`2026-09-03T11:${String(versionNumber).padStart(2, '0')}:00.000Z`),
      reasonCode: 'ready_for_review',
      requestKey: `REQUEST_TEST_faq_${suffix}_submit_${String(versionNumber)}`,
      reviewerReference: editor.reviewerRef,
      versionRef: created.versionRef,
    },
    editor,
  );
  await publication.reviewVersion(
    {
      action: 'approve',
      effectiveAt: new Date(`2026-09-03T12:${String(versionNumber).padStart(2, '0')}:00.000Z`),
      reasonCode: 'business_fact_verified',
      requestKey: `REQUEST_TEST_faq_${suffix}_approve_${String(versionNumber)}`,
      reviewerReference: reviewer.reviewerRef,
      versionRef: created.versionRef,
    },
    reviewer,
  );
  return created;
}

async function publishVersion(
  suffix: string,
  versionNumber: number,
  effectiveAt: Date,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly itemKey: string; readonly sourceRef: string; readonly versionRef: string }> {
  const approved = await approveVersion(suffix, versionNumber, overrides);
  await publication.publishVersion(
    {
      action: 'publish',
      effectiveAt,
      itemKey: approved.itemKey,
      ...(versionNumber === 1
        ? {}
        : { priorVersionRef: `VERSION_TEST_faq_${suffix}_${String(versionNumber - 1)}` }),
      reasonCode: versionNumber === 1 ? 'initial_publication' : 'reviewed_replacement',
      requestKey: `REQUEST_TEST_faq_${suffix}_publish_${String(versionNumber)}`,
      reviewerReference: reviewer.reviewerRef,
      versionRef: approved.versionRef,
    },
    reviewer,
  );
  return approved;
}

function prepareText(input: string, language: 'bn' | 'en'): PreparedFaqResolutionText {
  return prepareFaqResolutionText(
    inspectSensitiveText(input, language, { maximumInputCodePoints: 1000 }),
  );
}

describe('Postgres FAQ resolver', () => {
  test('return exact reviewed English and Bangla answers from one effective version', async () => {
    const published = await publishVersion('exact', 1, new Date('2026-09-04T10:00:00.000Z'), {
      aliases: [
        { kind: 'alias', language: 'en', phrase: 'Open a synthetic support request' },
        { kind: 'alias', language: 'bn', phrase: 'সিনথেটিক সহায়তা অনুরোধ খুলুন' },
      ],
      answers: {
        en: 'Synthetic exact reviewed answer.',
        bn: 'সিনথেটিক নির্ভুল পর্যালোচিত উত্তর।',
      },
      questions: {
        en: 'How do I open a synthetic support request?',
        bn: 'আমি কীভাবে সিনথেটিক সহায়তা অনুরোধ খুলব?',
      },
    });
    const resolver = new PostgresFaqResolver(pool, policy);
    const evaluatedAt = new Date('2026-09-04T10:00:00.000Z');

    await expect(
      resolver.resolve({
        evaluatedAt,
        sanitizedText: prepareText('How do I open a synthetic support request?', 'en'),
      }),
    ).resolves.toEqual({
      status: 'match',
      answer: 'Synthetic exact reviewed answer.',
      itemReference: published.itemKey,
      language: 'en',
      matchKind: 'exact_question',
      versionReference: published.versionRef,
    });
    await expect(
      resolver.resolve({
        evaluatedAt,
        sanitizedText: prepareText('সিনথেটিক সহায়তা অনুরোধ খুলুন', 'bn'),
      }),
    ).resolves.toMatchObject({
      status: 'match',
      answer: 'সিনথেটিক নির্ভুল পর্যালোচিত উত্তর।',
      language: 'bn',
      matchKind: 'exact_alias',
      versionReference: published.versionRef,
    });
  });

  test('use bounded trigram candidates and return closed ambiguity for exact conflicts', async () => {
    const fuzzy = await publishVersion('fuzzy', 1, new Date('2026-09-04T11:00:00.000Z'), {
      aliases: [
        { kind: 'alias', language: 'en', phrase: 'Reset synthetic portal password' },
        { kind: 'alias', language: 'bn', phrase: 'সিনথেটিক পোর্টাল পাসওয়ার্ড রিসেট' },
      ],
    });
    const resolver = new PostgresFaqResolver(pool, policy);
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T11:00:00.000Z'),
        sanitizedText: prepareText('Reset portal password', 'en'),
      }),
    ).resolves.toMatchObject({
      status: 'match',
      itemReference: fuzzy.itemKey,
      matchKind: 'trigram_similarity',
    });

    const conflictText = 'Where is the synthetic conflict status?';
    await publishVersion('conflict-a', 1, new Date('2026-09-04T11:30:00.000Z'), {
      questions: { en: conflictText, bn: 'সিনথেটিক কনফ্লিক্ট অবস্থা কোথায়?' },
    });
    await publishVersion('conflict-b', 1, new Date('2026-09-04T11:30:00.000Z'), {
      questions: { en: conflictText, bn: 'সিনথেটিক কনফ্লিক্ট অবস্থা কী?' },
    });
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T11:30:00.000Z'),
        sanitizedText: prepareText(conflictText, 'en'),
      }),
    ).resolves.toEqual({ status: 'ambiguous', reasonCode: 'multiple_exact_matches' });
  });

  test('select only the current approved complete version across lifecycle states', async () => {
    const sharedQuestion = {
      en: 'What is the synthetic lifecycle answer?',
      bn: 'সিনথেটিক লাইফসাইকেল উত্তর কী?',
    };
    const first = await publishVersion('lifecycle', 1, new Date('2026-09-04T12:00:00.000Z'), {
      answers: { en: 'Synthetic lifecycle answer one.', bn: 'সিনথেটিক লাইফসাইকেল উত্তর এক।' },
      questions: sharedQuestion,
    });
    const second = await publishVersion('lifecycle', 2, new Date('2026-09-04T14:00:00.000Z'), {
      answers: { en: 'Synthetic lifecycle answer two.', bn: 'সিনথেটিক লাইফসাইকেল উত্তর দুই।' },
      questions: sharedQuestion,
    });

    const rejected = await createProposal('rejected-collision', 1, {
      questions: sharedQuestion,
    });
    await publication.submitVersion(
      {
        action: 'submit',
        effectiveAt: new Date('2026-09-04T12:10:00.000Z'),
        reasonCode: 'ready_for_review',
        requestKey: 'REQUEST_TEST_faq_rejected_collision_submit_1',
        reviewerReference: editor.reviewerRef,
        versionRef: rejected.versionRef,
      },
      editor,
    );
    await publication.reviewVersion(
      {
        action: 'reject',
        effectiveAt: new Date('2026-09-04T12:20:00.000Z'),
        reasonCode: 'bilingual_review_failed',
        requestKey: 'REQUEST_TEST_faq_rejected_collision_review_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: rejected.versionRef,
      },
      reviewer,
    );
    await createProposal('draft-collision', 1, { questions: sharedQuestion });
    await expect(
      repository.createProposal(
        proposalInput('incomplete', 'SOURCE_TEST_missing_not_used', 1, {
          answers: { en: 'Synthetic incomplete answer.' },
        }),
        editor,
      ),
    ).rejects.toThrow('Knowledge proposal is invalid');

    const resolver = new PostgresFaqResolver(pool, policy);
    const normalizedText = normalizeFaqText(sharedQuestion.en);
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T13:00:00.000Z'),
        sanitizedText: prepareText(normalizedText, 'en'),
      }),
    ).resolves.toMatchObject({
      status: 'match',
      answer: 'Synthetic lifecycle answer one.',
      versionReference: first.versionRef,
    });
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T14:00:00.000Z'),
        sanitizedText: prepareText(normalizedText, 'en'),
      }),
    ).resolves.toMatchObject({
      status: 'match',
      answer: 'Synthetic lifecycle answer two.',
      versionReference: second.versionRef,
    });

    await publication.retireItem(
      {
        action: 'retire',
        effectiveAt: new Date('2026-09-04T15:00:00.000Z'),
        itemKey: second.itemKey,
        reasonCode: 'reviewed_retirement',
        requestKey: 'REQUEST_TEST_faq_lifecycle_retire_2',
        reviewerReference: reviewer.reviewerRef,
        versionRef: second.versionRef,
      },
      reviewer,
    );
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T15:00:00.000Z'),
        sanitizedText: prepareText(normalizedText, 'en'),
      }),
    ).resolves.toEqual({ status: 'miss', reasonCode: 'no_candidates' });
  });

  test('exclude a published version until its review decision is effective', async () => {
    const created = await createProposal('review-effective', 1, {
      questions: {
        en: 'When is the synthetic reviewed answer effective?',
        bn: 'সিনথেটিক পর্যালোচিত উত্তর কখন কার্যকর?',
      },
    });
    await publication.submitVersion(
      {
        action: 'submit',
        effectiveAt: new Date('2026-09-04T12:00:00.000Z'),
        reasonCode: 'ready_for_review',
        requestKey: 'REQUEST_TEST_faq_review_effective_submit_1',
        reviewerReference: editor.reviewerRef,
        versionRef: created.versionRef,
      },
      editor,
    );
    await publication.reviewVersion(
      {
        action: 'approve',
        effectiveAt: new Date('2026-09-04T14:00:00.000Z'),
        reasonCode: 'business_fact_verified',
        requestKey: 'REQUEST_TEST_faq_review_effective_approve_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: created.versionRef,
      },
      reviewer,
    );
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: new Date('2026-09-04T13:00:00.000Z'),
        itemKey: created.itemKey,
        reasonCode: 'initial_publication',
        requestKey: 'REQUEST_TEST_faq_review_effective_publish_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: created.versionRef,
      },
      reviewer,
    );
    const resolver = new PostgresFaqResolver(pool, {
      ...policy,
      minimumSimilarity: 1,
    });
    const sanitizedText = prepareText('When is the synthetic reviewed answer effective?', 'en');

    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T13:30:00.000Z'),
        sanitizedText,
      }),
    ).resolves.toEqual({ status: 'miss', reasonCode: 'no_candidates' });
    await expect(
      publication.resolveEffectiveVersion(created.itemKey, new Date('2026-09-04T13:30:00.000Z')),
    ).resolves.toBeUndefined();
    await expect(
      publication.listEffectiveVersions('faq', new Date('2026-09-04T13:30:00.000Z')),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ versionRef: created.versionRef })]),
    );
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T14:00:00.000Z'),
        sanitizedText,
      }),
    ).resolves.toMatchObject({ status: 'match', versionReference: created.versionRef });
  });

  test('retain the GIN trigram index used to bound similarity candidates', async () => {
    const index = await pool.query<{ readonly indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = current_schema()
         and indexname = 'knowledge_aliases_normalized_trgm_idx'`,
    );

    expect(index.rows[0]?.indexdef).toContain('USING gin');
    expect(index.rows[0]?.indexdef).toContain('gin_trgm_ops');
  });

  test('reject a forged normalized string before issuing a lookup', async () => {
    const resolver = new PostgresFaqResolver(pool, policy);
    await expect(
      resolver.resolve({
        evaluatedAt: new Date('2026-09-04T16:00:00.000Z'),
        sanitizedText: {
          language: 'en',
          normalizedText: normalizeFaqText('Synthetic Question?'),
        },
      }),
    ).rejects.toThrow('Prepared FAQ text is invalid');
  });
});
