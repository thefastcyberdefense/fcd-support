import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PolicyAuthorizationError } from '../../src/policy/reviewer-principal.js';
import { PolicyIdempotencyConflictError } from '../../src/persistence/postgres-takeover-policy.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
let repository: PostgresKnowledgeRepository;

const editor = {
  reviewerRef: 'ADMIN_TEST_knowledge_editor',
  roles: ['knowledge_editor'],
} as const;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase(
    'postgres_knowledge_repository',
  );
  disposeDatabase = database.dispose;
  pool = database.pool;
  repository = new PostgresKnowledgeRepository(pool);
});

afterAll(async () => {
  await disposeDatabase?.();
});

async function createManualSource(suffix: string): Promise<string> {
  const sourceRef = `SOURCE_TEST_${suffix}`;
  const result = await repository.createSource(
    {
      createdAt: new Date('2026-09-01T13:00:00.000Z'),
      createdByReference: editor.reviewerRef,
      label: `Synthetic source ${suffix}`,
      sourceRef,
      sourceType: 'manual_business',
    },
    editor,
  );
  expect(result).toEqual({ sourceRef, status: 'created' });
  return sourceRef;
}

function proposal(
  suffix: string,
  sourceRef: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    aliases: [
      { language: 'en', kind: 'alias', phrase: `Synthetic HELP—${suffix}` },
      { language: 'bn', kind: 'example', phrase: `সিনথেটিক সহায়তা—${suffix}` },
    ],
    answers: {
      en: `Synthetic reviewed answer ${suffix}.`,
      bn: `সিনথেটিক পর্যালোচিত উত্তর ${suffix}।`,
    },
    authorReference: editor.reviewerRef,
    contentSha256: 'b'.repeat(64),
    createdAt: new Date('2026-09-01T13:01:00.000Z'),
    itemKey: `faq.synthetic.${suffix}`,
    kind: 'faq',
    questions: {
      en: `Synthetic question ${suffix}?`,
      bn: `সিনথেটিক প্রশ্ন ${suffix}?`,
    },
    requestKey: `REQUEST_TEST_${suffix}`,
    sourceRef,
    sourceSha256: 'a'.repeat(64),
    tags: ['synthetic', suffix.toLowerCase()],
    versionRef: `VERSION_TEST_${suffix}_1`,
    ...overrides,
  };
}

describe('Postgres knowledge repository', () => {
  test('create a draft proposal with normalized bilingual aliases and provenance', async () => {
    const sourceRef = await createManualSource('create');

    await expect(repository.createProposal(proposal('create', sourceRef), editor)).resolves.toEqual(
      {
        status: 'created',
        versionRef: 'VERSION_TEST_create_1',
      },
    );

    await expect(repository.getVersion('VERSION_TEST_create_1')).resolves.toMatchObject({
      aliases: [
        {
          kind: 'question',
          language: 'en',
          normalizedPhrase: 'synthetic question create',
        },
        {
          kind: 'question',
          language: 'bn',
          normalizedPhrase: 'সিনথেটিক প্রশ্ন create',
        },
        {
          kind: 'alias',
          language: 'en',
          normalizedPhrase: 'synthetic help create',
        },
        {
          kind: 'example',
          language: 'bn',
          normalizedPhrase: 'সিনথেটিক সহায়তা create',
        },
      ],
      authorReference: editor.reviewerRef,
      itemKey: 'faq.synthetic.create',
      kind: 'faq',
      sourceRef,
      state: 'draft',
      tags: ['create', 'synthetic'],
      versionNumber: 1,
      versionRef: 'VERSION_TEST_create_1',
    });
  });

  test('return duplicate for exact proposal replay and reject changed material', async () => {
    const sourceRef = await createManualSource('replay');
    const input = proposal('replay', sourceRef);

    await expect(repository.createProposal(input, editor)).resolves.toMatchObject({
      status: 'created',
    });
    await expect(repository.createProposal(input, editor)).resolves.toEqual({
      status: 'duplicate',
      versionRef: 'VERSION_TEST_replay_1',
    });
    await expect(
      repository.createProposal(
        proposal('replay', sourceRef, { contentSha256: 'c'.repeat(64) }),
        editor,
      ),
    ).rejects.toBeInstanceOf(PolicyIdempotencyConflictError);
  });

  test('require a knowledge editor and matching author identity', async () => {
    const sourceRef = await createManualSource('authority');
    const unauthorized = {
      reviewerRef: 'ADMIN_TEST_support_only',
      roles: ['support_reviewer'],
    };

    await expect(
      repository.createProposal(proposal('authority', sourceRef), unauthorized),
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
    await expect(
      repository.createProposal(
        proposal('authority', sourceRef, { authorReference: 'ADMIN_TEST_someone_else' }),
        editor,
      ),
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
  });

  test('keep a website snapshot and its proposal in non-published state', async () => {
    const sourceRef = 'SOURCE_TEST_website_proposal';
    await repository.createSource(
      {
        approvedUrl: 'https://example.invalid/support',
        createdAt: new Date('2026-09-01T13:10:00.000Z'),
        createdByReference: editor.reviewerRef,
        label: 'Synthetic website proposal',
        sourceRef,
        sourceType: 'website',
      },
      editor,
    );
    await expect(
      repository.recordSourceSnapshot(
        {
          contentSha256: 'd'.repeat(64),
          createdByReference: editor.reviewerRef,
          fetchOutcome: 'retrieved',
          fetchedAt: new Date('2026-09-01T13:11:00.000Z'),
          proposedPublicContent: 'Synthetic public website support content.',
          requestKey: 'REQUEST_TEST_website_snapshot',
          snapshotRef: 'SNAPSHOT_TEST_website',
          sourceRef,
          sourceSha256: 'e'.repeat(64),
        },
        editor,
      ),
    ).resolves.toEqual({ snapshotRef: 'SNAPSHOT_TEST_website', status: 'created' });

    await repository.createProposal(
      proposal('website', sourceRef, {
        sourceSnapshotRef: 'SNAPSHOT_TEST_website',
        versionRef: 'VERSION_TEST_website_1',
      }),
      editor,
    );
    const evidence = await pool.query<{
      readonly publications: number;
      readonly reviews: number;
      readonly state: string;
    }>(
      `select version.state,
              (select count(*)::int from knowledge_review_events) as reviews,
              (select count(*)::int from knowledge_publication_events) as publications
       from knowledge_versions as version
       where version.version_ref = 'VERSION_TEST_website_1'`,
    );
    expect(evidence.rows).toEqual([{ publications: 0, reviews: 0, state: 'draft' }]);
  });

  test('create immutable replacement versions without changing the submitted original', async () => {
    const sourceRef = await createManualSource('replacement');
    await repository.createProposal(proposal('replacement', sourceRef), editor);
    await pool.query(
      `insert into knowledge_review_events
         (version_id, action, reviewer_reference, reason_code, request_key, effective_at)
       select id, 'submit', $1, 'ready_for_review', 'REQUEST_TEST_replacement_submit',
              '2026-09-01T13:20:00Z'
       from knowledge_versions where version_ref = 'VERSION_TEST_replacement_1'`,
      [editor.reviewerRef],
    );

    await expect(
      repository.createReplacementProposal(
        proposal('replacement', sourceRef, {
          contentSha256: 'f'.repeat(64),
          createdAt: new Date('2026-09-01T13:21:00.000Z'),
          replacesVersionRef: 'VERSION_TEST_replacement_1',
          requestKey: 'REQUEST_TEST_replacement_2',
          versionRef: 'VERSION_TEST_replacement_2',
        }),
        editor,
      ),
    ).resolves.toEqual({ status: 'created', versionRef: 'VERSION_TEST_replacement_2' });

    const versions = await pool.query<{
      readonly state: string;
      readonly version_number: number;
      readonly version_ref: string;
    }>(
      `select version_ref, version_number, state
       from knowledge_versions
       where item_id = (select item_id from knowledge_versions where version_ref = $1)
       order by version_number`,
      ['VERSION_TEST_replacement_1'],
    );
    expect(versions.rows).toEqual([
      { state: 'submitted', version_number: 1, version_ref: 'VERSION_TEST_replacement_1' },
      { state: 'draft', version_number: 2, version_ref: 'VERSION_TEST_replacement_2' },
    ]);
  });

  test('serialize concurrent replacement version numbers', async () => {
    const sourceRef = await createManualSource('concurrent');
    await repository.createProposal(proposal('concurrent', sourceRef), editor);

    const results = await Promise.all([
      repository.createReplacementProposal(
        proposal('concurrent', sourceRef, {
          contentSha256: '1'.repeat(64),
          replacesVersionRef: 'VERSION_TEST_concurrent_1',
          requestKey: 'REQUEST_TEST_concurrent_2',
          versionRef: 'VERSION_TEST_concurrent_2',
        }),
        editor,
      ),
      repository.createReplacementProposal(
        proposal('concurrent', sourceRef, {
          contentSha256: '2'.repeat(64),
          replacesVersionRef: 'VERSION_TEST_concurrent_1',
          requestKey: 'REQUEST_TEST_concurrent_3',
          versionRef: 'VERSION_TEST_concurrent_3',
        }),
        editor,
      ),
    ]);

    expect(results.map(({ status }) => status)).toEqual(['created', 'created']);
    const numbers = await pool.query<{ readonly version_number: number }>(
      `select version_number
       from knowledge_versions
       where item_id = (select item_id from knowledge_versions where version_ref = $1)
       order by version_number`,
      ['VERSION_TEST_concurrent_1'],
    );
    expect(numbers.rows).toEqual([
      { version_number: 1 },
      { version_number: 2 },
      { version_number: 3 },
    ]);
  });

  test('roll back the entire proposal when a normalized child is invalid', async () => {
    const sourceRef = await createManualSource('rollback');

    await expect(
      repository.createProposal(
        proposal('rollback', sourceRef, {
          aliases: [{ language: 'en', kind: 'alias', phrase: '— … !' }],
        }),
        editor,
      ),
    ).rejects.toThrow('FAQ text is invalid');
    await expect(
      pool.query(
        `select exists (
           select 1 from knowledge_versions where request_key = 'REQUEST_TEST_rollback'
         ) as found`,
      ),
    ).resolves.toMatchObject({ rows: [{ found: false }] });
  });
});
