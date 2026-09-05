import type pg from 'pg';
import { z } from 'zod';

import { normalizeFaqText } from '../knowledge/faq-normalization.js';
import { parseKnowledgeProposal, parseKnowledgeSourceInput } from '../knowledge/knowledge-input.js';
import type {
  KnowledgeAliasView,
  KnowledgeProposalInput,
  KnowledgeSnapshotWriteResult,
  KnowledgeSourceWriteResult,
  KnowledgeVersionView,
  KnowledgeWriteResult,
} from '../knowledge/knowledge-types.js';
import { PolicyAuthorizationError, requireKnowledgeEditor } from '../policy/reviewer-principal.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const opaqueReference = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));

const sourceSnapshotSchema = z
  .strictObject({
    contentSha256: digest.optional(),
    createdByReference: opaqueReference,
    fetchOutcome: z.enum(['retrieved', 'not_modified', 'failed']),
    fetchedAt: validDate,
    proposedPublicContent: z.string().trim().min(1).max(12000).optional(),
    requestKey: opaqueReference,
    snapshotRef: opaqueReference,
    sourceRef: opaqueReference,
    sourceSha256: digest.optional(),
  })
  .superRefine((value, context) => {
    const retrievedIsComplete =
      value.fetchOutcome === 'retrieved' &&
      value.contentSha256 !== undefined &&
      value.sourceSha256 !== undefined &&
      value.proposedPublicContent !== undefined;
    const notModifiedIsComplete =
      value.fetchOutcome === 'not_modified' &&
      value.contentSha256 === undefined &&
      value.sourceSha256 !== undefined &&
      value.proposedPublicContent === undefined;
    const failedIsComplete =
      value.fetchOutcome === 'failed' &&
      value.contentSha256 === undefined &&
      value.sourceSha256 === undefined &&
      value.proposedPublicContent === undefined;
    if (!retrievedIsComplete && !notModifiedIsComplete && !failedIsComplete) {
      context.addIssue({ code: 'custom', message: 'Snapshot outcome fields are invalid' });
    }
  });

interface SourceRow {
  readonly active: boolean;
  readonly approved_url: string | null;
  readonly created_at: Date;
  readonly created_by_reference: string;
  readonly id: string;
  readonly label: string;
  readonly source_ref: string;
  readonly source_type: 'manual_business' | 'policy' | 'support_gap' | 'website';
}

interface SnapshotRow {
  readonly content_sha256: string | null;
  readonly created_by_reference: string;
  readonly fetch_outcome: 'failed' | 'not_modified' | 'retrieved';
  readonly fetched_at: Date;
  readonly id: string;
  readonly proposed_public_content: string | null;
  readonly request_key: string;
  readonly snapshot_ref: string;
  readonly source_id: string;
  readonly source_ref: string;
  readonly source_sha256: string | null;
}

interface ItemRow {
  readonly id: string;
  readonly item_key: string;
  readonly kind: KnowledgeProposalInput['kind'];
}

interface VersionRow {
  readonly answer_bn: string;
  readonly answer_en: string;
  readonly applicability: string | null;
  readonly author_reference: string;
  readonly content_sha256: string;
  readonly created_at: Date;
  readonly item_key: string;
  readonly kind: KnowledgeProposalInput['kind'];
  readonly question_bn: string | null;
  readonly question_en: string | null;
  readonly replaces_version_ref: string | null;
  readonly request_key: string;
  readonly rollback_from_version_ref: string | null;
  readonly source_ref: string;
  readonly source_sha256: string;
  readonly source_snapshot_ref: string | null;
  readonly state: KnowledgeVersionView['state'];
  readonly version_number: number;
  readonly version_ref: string;
}

interface AliasRow {
  readonly alias_kind: KnowledgeAliasView['kind'];
  readonly language: KnowledgeAliasView['language'];
  readonly normalized_phrase: string;
  readonly phrase: string;
}

interface TagRow {
  readonly tag: string;
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function requireMatchingActor(principalReference: string, actorReference: string): void {
  if (principalReference !== actorReference) {
    throw new PolicyAuthorizationError('Knowledge actor identity mismatch');
  }
}

function parseSnapshot(input: unknown): z.infer<typeof sourceSnapshotSchema> {
  const result = sourceSnapshotSchema.safeParse(input);
  if (!result.success) throw new TypeError('Knowledge source snapshot is invalid');
  return result.data;
}

function buildAliases(proposal: KnowledgeProposalInput): KnowledgeAliasView[] {
  const aliases: KnowledgeAliasView[] = [];
  if (proposal.questions !== undefined) {
    aliases.push(
      {
        kind: 'question',
        language: 'en',
        normalizedPhrase: normalizeFaqText(proposal.questions.en),
        phrase: proposal.questions.en,
      },
      {
        kind: 'question',
        language: 'bn',
        normalizedPhrase: normalizeFaqText(proposal.questions.bn),
        phrase: proposal.questions.bn,
      },
    );
  }
  aliases.push(
    ...proposal.aliases.map((alias) => ({
      ...alias,
      normalizedPhrase: normalizeFaqText(alias.phrase),
    })),
  );

  const keys = aliases.map(
    ({ kind, language, normalizedPhrase }) => `${language}\u0000${kind}\u0000${normalizedPhrase}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('Knowledge proposal contains duplicate normalized aliases');
  }
  return aliases;
}

function proposalMatchesView(
  proposal: KnowledgeProposalInput,
  aliases: readonly KnowledgeAliasView[],
  view: KnowledgeVersionView,
): boolean {
  const questionsMatch =
    view.questions?.en === proposal.questions?.en && view.questions?.bn === proposal.questions?.bn;
  const aliasesMatch =
    view.aliases.length === aliases.length &&
    view.aliases.every((alias, index) => {
      const expected = aliases[index];
      return (
        alias.kind === expected?.kind &&
        alias.language === expected.language &&
        alias.phrase === expected.phrase &&
        alias.normalizedPhrase === expected.normalizedPhrase
      );
    });
  return (
    view.versionRef === proposal.versionRef &&
    view.itemKey === proposal.itemKey &&
    view.kind === proposal.kind &&
    view.sourceRef === proposal.sourceRef &&
    view.sourceSnapshotRef === proposal.sourceSnapshotRef &&
    view.sourceSha256 === proposal.sourceSha256 &&
    view.contentSha256 === proposal.contentSha256 &&
    view.authorReference === proposal.authorReference &&
    sameDate(view.createdAt, proposal.createdAt) &&
    questionsMatch &&
    view.answers.en === proposal.answers.en &&
    view.answers.bn === proposal.answers.bn &&
    view.applicability === proposal.applicability &&
    view.replacesVersionRef === proposal.replacesVersionRef &&
    view.rollbackFromVersionRef === proposal.rollbackFromVersionRef &&
    aliasesMatch &&
    JSON.stringify(view.tags) === JSON.stringify([...proposal.tags].sort())
  );
}

export class PostgresKnowledgeRepository {
  public constructor(private readonly pool: TransactionSource) {}

  public async createSource(
    input: unknown,
    principalInput: unknown,
  ): Promise<KnowledgeSourceWriteResult> {
    const source = parseKnowledgeSourceInput(input);
    const principal = requireKnowledgeEditor(principalInput);
    requireMatchingActor(principal.reviewerRef, source.createdByReference);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        source.sourceRef,
      ]);
      const existing = await client.query<SourceRow>(
        `select id, source_ref, source_type, label, approved_url, active,
                created_by_reference, created_at
         from knowledge_sources
         where source_ref = $1`,
        [source.sourceRef],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        const matches =
          row.source_type === source.sourceType &&
          row.label === source.label &&
          row.approved_url === (source.approvedUrl ?? null) &&
          row.active &&
          row.created_by_reference === source.createdByReference &&
          sameDate(row.created_at, source.createdAt);
        if (!matches) throw new PolicyIdempotencyConflictError();
        return { sourceRef: row.source_ref, status: 'duplicate' };
      }

      await client.query(
        `insert into knowledge_sources
           (source_ref, source_type, label, approved_url, active,
            created_by_reference, created_at, updated_at)
         values ($1, $2, $3, $4, true, $5, $6, $6)`,
        [
          source.sourceRef,
          source.sourceType,
          source.label,
          source.approvedUrl ?? null,
          source.createdByReference,
          source.createdAt,
        ],
      );
      return { sourceRef: source.sourceRef, status: 'created' };
    });
  }

  public async recordSourceSnapshot(
    input: unknown,
    principalInput: unknown,
  ): Promise<KnowledgeSnapshotWriteResult> {
    const snapshot = parseSnapshot(input);
    const principal = requireKnowledgeEditor(principalInput);
    requireMatchingActor(principal.reviewerRef, snapshot.createdByReference);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        snapshot.requestKey,
      ]);
      const existing = await client.query<SnapshotRow>(
        `select snapshot.id, snapshot.snapshot_ref, snapshot.source_id,
                source.source_ref, snapshot.fetch_outcome, snapshot.fetched_at,
                snapshot.source_sha256, snapshot.content_sha256,
                snapshot.proposed_public_content, snapshot.created_by_reference,
                snapshot.request_key
         from knowledge_source_snapshots as snapshot
         join knowledge_sources as source on source.id = snapshot.source_id
         where snapshot.request_key = $1`,
        [snapshot.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        const matches =
          row.snapshot_ref === snapshot.snapshotRef &&
          row.source_ref === snapshot.sourceRef &&
          row.fetch_outcome === snapshot.fetchOutcome &&
          sameDate(row.fetched_at, snapshot.fetchedAt) &&
          row.source_sha256 === (snapshot.sourceSha256 ?? null) &&
          row.content_sha256 === (snapshot.contentSha256 ?? null) &&
          row.proposed_public_content === (snapshot.proposedPublicContent ?? null) &&
          row.created_by_reference === snapshot.createdByReference;
        if (!matches) throw new PolicyIdempotencyConflictError();
        return { snapshotRef: row.snapshot_ref, status: 'duplicate' };
      }

      const selectedSource = await client.query<SourceRow>(
        `select id, source_ref, source_type, label, approved_url, active,
                created_by_reference, created_at
         from knowledge_sources
         where source_ref = $1 and active`,
        [snapshot.sourceRef],
      );
      const sourceId = selectedSource.rows[0]?.id;
      if (sourceId === undefined) throw new PolicyRecordNotFoundError();

      await client.query(
        `insert into knowledge_source_snapshots
           (snapshot_ref, source_id, fetch_outcome, fetched_at, source_sha256,
            content_sha256, proposed_public_content, created_by_reference, request_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          snapshot.snapshotRef,
          sourceId,
          snapshot.fetchOutcome,
          snapshot.fetchedAt,
          snapshot.sourceSha256 ?? null,
          snapshot.contentSha256 ?? null,
          snapshot.proposedPublicContent ?? null,
          snapshot.createdByReference,
          snapshot.requestKey,
        ],
      );
      return { snapshotRef: snapshot.snapshotRef, status: 'created' };
    });
  }

  public createProposal(input: unknown, principalInput: unknown): Promise<KnowledgeWriteResult> {
    return this.writeProposal(input, principalInput, false);
  }

  public createReplacementProposal(
    input: unknown,
    principalInput: unknown,
  ): Promise<KnowledgeWriteResult> {
    return this.writeProposal(input, principalInput, true);
  }

  public async getVersion(versionRef: string): Promise<KnowledgeVersionView> {
    const parsedRef = opaqueReference.safeParse(versionRef);
    if (!parsedRef.success) throw new TypeError('Knowledge version reference is invalid');
    return withBoundedTransaction(this.pool, async (client) => {
      const view = await this.readVersion(client, parsedRef.data);
      if (view === undefined) throw new PolicyRecordNotFoundError();
      return view;
    });
  }

  private async writeProposal(
    input: unknown,
    principalInput: unknown,
    replacementRequired: boolean,
  ): Promise<KnowledgeWriteResult> {
    const proposal = parseKnowledgeProposal(input);
    const principal = requireKnowledgeEditor(principalInput);
    requireMatchingActor(principal.reviewerRef, proposal.authorReference);
    if (replacementRequired !== (proposal.replacesVersionRef !== undefined)) {
      throw new TypeError(
        replacementRequired
          ? 'Replacement knowledge proposal requires a prior version'
          : 'Initial knowledge proposal cannot replace a prior version',
      );
    }

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        proposal.requestKey,
      ]);
      const existingRequest = await client.query<{ readonly version_ref: string }>(
        `select version_ref from knowledge_versions where request_key = $1`,
        [proposal.requestKey],
      );
      const existingRef = existingRequest.rows[0]?.version_ref;
      if (existingRef !== undefined) {
        const aliases = buildAliases(proposal);
        const view = await this.readVersion(client, existingRef);
        if (view === undefined || !proposalMatchesView(proposal, aliases, view)) {
          throw new PolicyIdempotencyConflictError();
        }
        return { status: 'duplicate', versionRef: view.versionRef };
      }

      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        proposal.itemKey,
      ]);
      const selectedSource = await client.query<SourceRow>(
        `select id, source_ref, source_type, label, approved_url, active,
                created_by_reference, created_at
         from knowledge_sources
         where source_ref = $1 and active`,
        [proposal.sourceRef],
      );
      const sourceId = selectedSource.rows[0]?.id;
      if (sourceId === undefined) throw new PolicyRecordNotFoundError();

      const selectedItem = await client.query<ItemRow>(
        `select id, item_key, kind from knowledge_items where item_key = $1`,
        [proposal.itemKey],
      );
      let item = selectedItem.rows[0];
      if (item === undefined) {
        if (replacementRequired) throw new PolicyRecordNotFoundError();
        const inserted = await client.query<ItemRow>(
          `insert into knowledge_items (item_key, kind, created_at, updated_at)
           values ($1, $2, $3, $3)
           returning id, item_key, kind`,
          [proposal.itemKey, proposal.kind, proposal.createdAt],
        );
        item = inserted.rows[0];
      } else if (item.kind !== proposal.kind || !replacementRequired) {
        throw new PolicyIdempotencyConflictError();
      }
      if (item === undefined) throw new Error('Knowledge item insert returned no identifier');

      const snapshotId = await this.resolveSnapshotId(client, proposal.sourceSnapshotRef, sourceId);
      const replacesVersionId = await this.resolveRelatedVersionId(
        client,
        proposal.replacesVersionRef,
        item.id,
      );
      const rollbackFromVersionId = await this.resolveRelatedVersionId(
        client,
        proposal.rollbackFromVersionRef,
        item.id,
      );
      const nextVersion = await client.query<{ readonly version_number: number }>(
        `select coalesce(max(version_number), 0)::int + 1 as version_number
         from knowledge_versions where item_id = $1`,
        [item.id],
      );
      const versionNumber = nextVersion.rows[0]?.version_number;
      if (versionNumber === undefined) throw new Error('Knowledge version number was not resolved');

      const inserted = await client.query<{ readonly id: string }>(
        `insert into knowledge_versions
           (version_ref, item_id, version_number, request_key, state,
            question_en, answer_en, question_bn, answer_bn, applicability,
            source_id, source_snapshot_id, source_sha256, content_sha256,
            author_reference, replaces_version_id, rollback_from_version_id, created_at)
         values ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9,
                 $10, $11, $12, $13, $14, $15, $16, $17)
         returning id`,
        [
          proposal.versionRef,
          item.id,
          versionNumber,
          proposal.requestKey,
          proposal.questions?.en ?? null,
          proposal.answers.en,
          proposal.questions?.bn ?? null,
          proposal.answers.bn,
          proposal.applicability ?? null,
          sourceId,
          snapshotId,
          proposal.sourceSha256,
          proposal.contentSha256,
          proposal.authorReference,
          replacesVersionId,
          rollbackFromVersionId,
          proposal.createdAt,
        ],
      );
      const versionId = inserted.rows[0]?.id;
      if (versionId === undefined)
        throw new Error('Knowledge version insert returned no identifier');

      for (const alias of buildAliases(proposal)) {
        await client.query(
          `insert into knowledge_aliases
             (version_id, language, alias_kind, phrase, normalized_phrase)
           values ($1, $2, $3, $4, $5)`,
          [versionId, alias.language, alias.kind, alias.phrase, alias.normalizedPhrase],
        );
      }
      for (const tag of [...proposal.tags].sort()) {
        await client.query(`insert into knowledge_tags (version_id, tag) values ($1, $2)`, [
          versionId,
          tag,
        ]);
      }

      return { status: 'created', versionRef: proposal.versionRef };
    });
  }

  private async resolveSnapshotId(
    client: pg.PoolClient,
    snapshotRef: string | undefined,
    sourceId: string,
  ): Promise<string | null> {
    if (snapshotRef === undefined) return null;
    const selected = await client.query<{ readonly id: string }>(
      `select id from knowledge_source_snapshots where snapshot_ref = $1 and source_id = $2`,
      [snapshotRef, sourceId],
    );
    const id = selected.rows[0]?.id;
    if (id === undefined) throw new PolicyRecordNotFoundError();
    return id;
  }

  private async resolveRelatedVersionId(
    client: pg.PoolClient,
    versionRef: string | undefined,
    itemId: string,
  ): Promise<string | null> {
    if (versionRef === undefined) return null;
    const selected = await client.query<{ readonly id: string }>(
      `select id from knowledge_versions where version_ref = $1 and item_id = $2`,
      [versionRef, itemId],
    );
    const id = selected.rows[0]?.id;
    if (id === undefined) throw new PolicyRecordNotFoundError();
    return id;
  }

  private async readVersion(
    client: pg.PoolClient,
    versionRef: string,
  ): Promise<KnowledgeVersionView | undefined> {
    const selected = await client.query<VersionRow>(
      `select version.version_ref, version.version_number, version.request_key,
              version.state, version.question_en, version.answer_en,
              version.question_bn, version.answer_bn, version.applicability,
              version.source_sha256, version.content_sha256,
              version.author_reference, version.created_at,
              item.item_key, item.kind, source.source_ref,
              snapshot.snapshot_ref as source_snapshot_ref,
              replaced.version_ref as replaces_version_ref,
              rolled_back.version_ref as rollback_from_version_ref
       from knowledge_versions as version
       join knowledge_items as item on item.id = version.item_id
       join knowledge_sources as source on source.id = version.source_id
       left join knowledge_source_snapshots as snapshot on snapshot.id = version.source_snapshot_id
       left join knowledge_versions as replaced on replaced.id = version.replaces_version_id
       left join knowledge_versions as rolled_back on rolled_back.id = version.rollback_from_version_id
       where version.version_ref = $1`,
      [versionRef],
    );
    const row = selected.rows[0];
    if (row === undefined) return undefined;

    const aliases = await client.query<AliasRow>(
      `select language, alias_kind, phrase, normalized_phrase
       from knowledge_aliases
       where version_id = (select id from knowledge_versions where version_ref = $1)
       order by id`,
      [row.version_ref],
    );
    const tags = await client.query<TagRow>(
      `select tag
       from knowledge_tags
       where version_id = (select id from knowledge_versions where version_ref = $1)
       order by tag`,
      [row.version_ref],
    );
    return {
      aliases: aliases.rows.map((alias) => ({
        kind: alias.alias_kind,
        language: alias.language,
        normalizedPhrase: alias.normalized_phrase,
        phrase: alias.phrase,
      })),
      answers: { bn: row.answer_bn, en: row.answer_en },
      ...(row.applicability === null ? {} : { applicability: row.applicability }),
      authorReference: row.author_reference,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
      itemKey: row.item_key,
      kind: row.kind,
      ...(row.question_en === null || row.question_bn === null
        ? {}
        : { questions: { bn: row.question_bn, en: row.question_en } }),
      ...(row.replaces_version_ref === null
        ? {}
        : { replacesVersionRef: row.replaces_version_ref }),
      requestKey: row.request_key,
      ...(row.rollback_from_version_ref === null
        ? {}
        : { rollbackFromVersionRef: row.rollback_from_version_ref }),
      sourceRef: row.source_ref,
      sourceSha256: row.source_sha256,
      ...(row.source_snapshot_ref === null ? {} : { sourceSnapshotRef: row.source_snapshot_ref }),
      state: row.state,
      tags: tags.rows.map(({ tag: valueTag }) => valueTag),
      versionNumber: row.version_number,
      versionRef: row.version_ref,
    };
  }
}
