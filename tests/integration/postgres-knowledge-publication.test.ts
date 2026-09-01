import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import {
  KnowledgePublicationConflictError,
  PostgresKnowledgePublication,
} from '../../src/persistence/postgres-knowledge-publication.js';
import { PolicyAuthorizationError } from '../../src/policy/reviewer-principal.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let repository: PostgresKnowledgeRepository;
let publication: PostgresKnowledgePublication;

const editor = {
  reviewerRef: 'ADMIN_TEST_editor_publication',
  roles: ['knowledge_editor'],
} as const;
const reviewer = {
  reviewerRef: 'ADMIN_TEST_reviewer_publication',
  roles: ['knowledge_reviewer'],
} as const;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_knowledge_publication',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
  repository = new PostgresKnowledgeRepository(pool);
  publication = new PostgresKnowledgePublication(pool);
});

afterAll(async () => {
  await disposeDatabase?.();
});

function proposalInput(
  itemSuffix: string,
  sourceRef: string,
  versionNumber: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    aliases: [],
    answers: {
      en: `Synthetic answer ${itemSuffix} version ${String(versionNumber)}.`,
      bn: `সিনথেটিক উত্তর ${itemSuffix} সংস্করণ ${String(versionNumber)}।`,
    },
    authorReference: editor.reviewerRef,
    contentSha256: versionNumber.toString(16).padStart(64, '0'),
    createdAt: new Date(`2026-09-01T14:${String(versionNumber).padStart(2, '0')}:00.000Z`),
    itemKey: `faq.synthetic.${itemSuffix}`,
    kind: 'faq',
    questions: {
      en: `Synthetic question ${itemSuffix} version ${String(versionNumber)}?`,
      bn: `সিনথেটিক প্রশ্ন ${itemSuffix} সংস্করণ ${String(versionNumber)}?`,
    },
    requestKey: `REQUEST_TEST_${itemSuffix}_proposal_${String(versionNumber)}`,
    sourceRef,
    sourceSha256: 'a'.repeat(64),
    tags: ['synthetic'],
    versionRef: `VERSION_TEST_${itemSuffix}_${String(versionNumber)}`,
    ...overrides,
  };
}

async function createApprovedVersion(
  itemSuffix: string,
  versionNumber = 1,
): Promise<{ readonly itemKey: string; readonly sourceRef: string; readonly versionRef: string }> {
  const sourceRef = `SOURCE_TEST_publication_${itemSuffix}`;
  if (versionNumber === 1) {
    await repository.createSource(
      {
        createdAt: new Date('2026-09-01T14:00:00.000Z'),
        createdByReference: editor.reviewerRef,
        label: `Synthetic publication source ${itemSuffix}`,
        sourceRef,
        sourceType: 'manual_business',
      },
      editor,
    );
    await repository.createProposal(proposalInput(itemSuffix, sourceRef, versionNumber), editor);
  } else {
    await repository.createReplacementProposal(
      proposalInput(itemSuffix, sourceRef, versionNumber, {
        replacesVersionRef: `VERSION_TEST_${itemSuffix}_${String(versionNumber - 1)}`,
      }),
      editor,
    );
  }

  const versionRef = `VERSION_TEST_${itemSuffix}_${String(versionNumber)}`;
  await publication.submitVersion(
    {
      action: 'submit',
      effectiveAt: new Date(`2026-09-01T15:${String(versionNumber).padStart(2, '0')}:00.000Z`),
      reasonCode: 'ready_for_review',
      requestKey: `REQUEST_TEST_${itemSuffix}_submit_${String(versionNumber)}`,
      reviewerReference: editor.reviewerRef,
      versionRef,
    },
    editor,
  );
  await publication.reviewVersion(
    {
      action: 'approve',
      effectiveAt: new Date(`2026-09-01T16:${String(versionNumber).padStart(2, '0')}:00.000Z`),
      reasonCode: 'business_fact_verified',
      requestKey: `REQUEST_TEST_${itemSuffix}_approve_${String(versionNumber)}`,
      reviewerReference: reviewer.reviewerRef,
      versionRef,
    },
    reviewer,
  );
  return { itemKey: `faq.synthetic.${itemSuffix}`, sourceRef, versionRef };
}

describe('Postgres knowledge review and publication', () => {
  test('submit and approve an exact version with idempotent review evidence', async () => {
    const sourceRef = `SOURCE_TEST_publication_review`;
    await repository.createSource(
      {
        createdAt: new Date('2026-09-01T14:00:00.000Z'),
        createdByReference: editor.reviewerRef,
        label: 'Synthetic review source',
        sourceRef,
        sourceType: 'manual_business',
      },
      editor,
    );
    await repository.createProposal(proposalInput('review', sourceRef, 1), editor);
    const submit = {
      action: 'submit',
      effectiveAt: new Date('2026-09-01T15:01:00.000Z'),
      reasonCode: 'ready_for_review',
      requestKey: 'REQUEST_TEST_review_submit_1',
      reviewerReference: editor.reviewerRef,
      versionRef: 'VERSION_TEST_review_1',
    } as const;

    await expect(publication.submitVersion(submit, editor)).resolves.toEqual({
      state: 'submitted',
      status: 'applied',
      versionRef: 'VERSION_TEST_review_1',
    });
    await expect(publication.submitVersion(submit, editor)).resolves.toEqual({
      state: 'submitted',
      status: 'duplicate',
      versionRef: 'VERSION_TEST_review_1',
    });
    await expect(
      publication.submitVersion({ ...submit, reasonCode: 'changed_reason' }, editor),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);

    await expect(
      publication.reviewVersion(
        {
          action: 'approve',
          effectiveAt: new Date('2026-09-01T16:01:00.000Z'),
          reasonCode: 'business_fact_verified',
          requestKey: 'REQUEST_TEST_review_approve_1',
          reviewerReference: reviewer.reviewerRef,
          versionRef: 'VERSION_TEST_review_1',
        },
        reviewer,
      ),
    ).resolves.toEqual({
      state: 'approved',
      status: 'applied',
      versionRef: 'VERSION_TEST_review_1',
    });
    await expect(repository.getVersion('VERSION_TEST_review_1')).resolves.toMatchObject({
      state: 'approved',
    });
  });

  test('require editor authority for submit and reviewer authority for decisions', async () => {
    const sourceRef = `SOURCE_TEST_publication_authority`;
    await repository.createSource(
      {
        createdAt: new Date('2026-09-01T14:00:00.000Z'),
        createdByReference: editor.reviewerRef,
        label: 'Synthetic authority source',
        sourceRef,
        sourceType: 'manual_business',
      },
      editor,
    );
    await repository.createProposal(proposalInput('authority', sourceRef, 1), editor);
    const submit = {
      action: 'submit',
      effectiveAt: new Date('2026-09-01T15:02:00.000Z'),
      reasonCode: 'ready_for_review',
      requestKey: 'REQUEST_TEST_authority_submit_1',
      reviewerReference: editor.reviewerRef,
      versionRef: 'VERSION_TEST_authority_1',
    } as const;

    await expect(publication.submitVersion(submit, reviewer)).rejects.toBeInstanceOf(
      PolicyAuthorizationError,
    );
    await publication.submitVersion(submit, editor);
    await expect(
      publication.reviewVersion(
        {
          action: 'approve',
          effectiveAt: new Date('2026-09-01T16:02:00.000Z'),
          reasonCode: 'business_fact_verified',
          requestKey: 'REQUEST_TEST_authority_approve_1',
          reviewerReference: editor.reviewerRef,
          versionRef: 'VERSION_TEST_authority_1',
        },
        editor,
      ),
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
  });

  test('exclude rejected versions from effective knowledge', async () => {
    const sourceRef = `SOURCE_TEST_publication_rejected`;
    await repository.createSource(
      {
        createdAt: new Date('2026-09-01T14:00:00.000Z'),
        createdByReference: editor.reviewerRef,
        label: 'Synthetic rejected source',
        sourceRef,
        sourceType: 'manual_business',
      },
      editor,
    );
    await repository.createProposal(proposalInput('rejected', sourceRef, 1), editor);
    await publication.submitVersion(
      {
        action: 'submit',
        effectiveAt: new Date('2026-09-01T15:03:00.000Z'),
        reasonCode: 'ready_for_review',
        requestKey: 'REQUEST_TEST_rejected_submit_1',
        reviewerReference: editor.reviewerRef,
        versionRef: 'VERSION_TEST_rejected_1',
      },
      editor,
    );
    await publication.reviewVersion(
      {
        action: 'reject',
        effectiveAt: new Date('2026-09-01T16:03:00.000Z'),
        reasonCode: 'bilingual_review_failed',
        requestKey: 'REQUEST_TEST_rejected_review_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: 'VERSION_TEST_rejected_1',
      },
      reviewer,
    );

    await expect(
      publication.resolveEffectiveVersion(
        'faq.synthetic.rejected',
        new Date('2026-09-01T17:00:00.000Z'),
      ),
    ).resolves.toBeUndefined();
  });

  test('activate an approved version only at its scheduled publication time', async () => {
    const { itemKey, versionRef } = await createApprovedVersion('scheduled');
    const effectiveAt = new Date('2026-09-02T10:00:00.000Z');

    await expect(
      publication.publishVersion(
        {
          action: 'publish',
          effectiveAt,
          itemKey,
          reasonCode: 'initial_publication',
          requestKey: 'REQUEST_TEST_scheduled_publish_1',
          reviewerReference: reviewer.reviewerRef,
          versionRef,
        },
        reviewer,
      ),
    ).resolves.toEqual({ itemKey, status: 'applied', versionRef });

    await expect(
      publication.resolveEffectiveVersion(itemKey, new Date('2026-09-02T09:59:59.999Z')),
    ).resolves.toBeUndefined();
    await expect(publication.resolveEffectiveVersion(itemKey, effectiveAt)).resolves.toMatchObject({
      itemKey,
      versionNumber: 1,
      versionRef,
    });
    await expect(publication.listEffectiveVersions('faq', effectiveAt)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemKey, versionRef })]),
    );
  });

  test('supersede and retire one effective version with exact confirmation', async () => {
    const first = await createApprovedVersion('lifecycle');
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: new Date('2026-09-02T11:00:00.000Z'),
        itemKey: first.itemKey,
        reasonCode: 'initial_publication',
        requestKey: 'REQUEST_TEST_lifecycle_publish_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: first.versionRef,
      },
      reviewer,
    );
    const second = await createApprovedVersion('lifecycle', 2);
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: new Date('2026-09-02T12:00:00.000Z'),
        itemKey: second.itemKey,
        priorVersionRef: first.versionRef,
        reasonCode: 'reviewed_replacement',
        requestKey: 'REQUEST_TEST_lifecycle_publish_2',
        reviewerReference: reviewer.reviewerRef,
        versionRef: second.versionRef,
      },
      reviewer,
    );

    await expect(
      publication.resolveEffectiveVersion(first.itemKey, new Date('2026-09-02T11:30:00.000Z')),
    ).resolves.toMatchObject({ versionRef: first.versionRef });
    await expect(
      publication.resolveEffectiveVersion(first.itemKey, new Date('2026-09-02T12:00:00.000Z')),
    ).resolves.toMatchObject({ versionRef: second.versionRef });

    await publication.retireItem(
      {
        action: 'retire',
        effectiveAt: new Date('2026-09-02T13:00:00.000Z'),
        itemKey: second.itemKey,
        reasonCode: 'reviewed_retirement',
        requestKey: 'REQUEST_TEST_lifecycle_retire_2',
        reviewerReference: reviewer.reviewerRef,
        versionRef: second.versionRef,
      },
      reviewer,
    );
    await expect(
      publication.resolveEffectiveVersion(first.itemKey, new Date('2026-09-02T13:00:00.000Z')),
    ).resolves.toBeUndefined();
  });

  test('roll back only to a previously published approved version', async () => {
    const first = await createApprovedVersion('rollback');
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: new Date('2026-09-02T14:00:00.000Z'),
        itemKey: first.itemKey,
        reasonCode: 'initial_publication',
        requestKey: 'REQUEST_TEST_rollback_publish_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: first.versionRef,
      },
      reviewer,
    );
    const second = await createApprovedVersion('rollback', 2);
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: new Date('2026-09-02T15:00:00.000Z'),
        itemKey: second.itemKey,
        priorVersionRef: first.versionRef,
        reasonCode: 'reviewed_replacement',
        requestKey: 'REQUEST_TEST_rollback_publish_2',
        reviewerReference: reviewer.reviewerRef,
        versionRef: second.versionRef,
      },
      reviewer,
    );

    await publication.rollbackItem(
      {
        action: 'rollback',
        effectiveAt: new Date('2026-09-02T16:00:00.000Z'),
        itemKey: first.itemKey,
        priorVersionRef: second.versionRef,
        reasonCode: 'reviewed_rollback',
        requestKey: 'REQUEST_TEST_rollback_to_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: first.versionRef,
      },
      reviewer,
    );
    await expect(
      publication.resolveEffectiveVersion(first.itemKey, new Date('2026-09-02T16:00:00.000Z')),
    ).resolves.toMatchObject({ versionRef: first.versionRef });
  });

  test('serialize competing publications and preserve exact idempotency', async () => {
    const first = await createApprovedVersion('concurrent-publication');
    await publication.publishVersion(
      {
        action: 'publish',
        effectiveAt: new Date('2026-09-02T17:00:00.000Z'),
        itemKey: first.itemKey,
        reasonCode: 'initial_publication',
        requestKey: 'REQUEST_TEST_concurrent_publication_1',
        reviewerReference: reviewer.reviewerRef,
        versionRef: first.versionRef,
      },
      reviewer,
    );
    const second = await createApprovedVersion('concurrent-publication', 2);
    const command = {
      action: 'publish',
      effectiveAt: new Date('2026-09-02T18:00:00.000Z'),
      itemKey: second.itemKey,
      priorVersionRef: first.versionRef,
      reasonCode: 'reviewed_replacement',
      requestKey: 'REQUEST_TEST_concurrent_publication_2',
      reviewerReference: reviewer.reviewerRef,
      versionRef: second.versionRef,
    } as const;

    const [firstAttempt, replay] = await Promise.all([
      publication.publishVersion(command, reviewer),
      publication.publishVersion(command, reviewer),
    ]);
    expect([firstAttempt.status, replay.status].sort()).toEqual(['applied', 'duplicate']);

    const third = await createApprovedVersion('concurrent-publication', 3);
    const outcomes = await Promise.allSettled([
      publication.publishVersion(
        {
          ...command,
          effectiveAt: new Date('2026-09-02T19:00:00.000Z'),
          priorVersionRef: second.versionRef,
          requestKey: 'REQUEST_TEST_concurrent_publication_3a',
          versionRef: third.versionRef,
        },
        reviewer,
      ),
      publication.publishVersion(
        {
          ...command,
          effectiveAt: new Date('2026-09-02T19:00:00.000Z'),
          priorVersionRef: second.versionRef,
          requestKey: 'REQUEST_TEST_concurrent_publication_3b',
          versionRef: first.versionRef,
        },
        reviewer,
      ),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    if (rejected?.status !== 'rejected') {
      throw new Error('Expected one competing publication to be rejected');
    }
    expect(rejected.reason).toBeInstanceOf(KnowledgePublicationConflictError);
  });
});
