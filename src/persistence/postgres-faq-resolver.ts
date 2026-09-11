import { z } from 'zod';

import {
  decideFaqResolution,
  readPreparedFaqResolutionText,
  type FaqCandidate,
  type PreparedFaqResolutionText,
  type FaqResolution,
  type FaqResolutionPolicy,
} from '../knowledge/faq-resolver.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const resolveInputSchema = z.strictObject({
  evaluatedAt: z.instanceof(Date).refine((value) => Number.isFinite(value.getTime())),
  sanitizedText: z.unknown(),
});

export interface FaqResolveInput {
  readonly evaluatedAt: Date;
  readonly sanitizedText: PreparedFaqResolutionText;
}

// Repository proposals allow 64 authored aliases plus two bilingual question aliases.
const maximumAliasRowsPerVersion = 66;

interface CandidateRow {
  readonly alias_kind: FaqCandidate['aliasKind'];
  readonly answer: string;
  readonly item_reference: string;
  readonly language: FaqCandidate['language'];
  readonly normalized_phrase: string;
  readonly similarity: number;
  readonly version_reference: string;
}

export class PostgresFaqResolver {
  private readonly policy: FaqResolutionPolicy;

  public constructor(
    private readonly pool: TransactionSource,
    policy: FaqResolutionPolicy,
  ) {
    decideFaqResolution('faq policy validation', 'en', [], policy);
    this.policy = Object.freeze({ ...policy });
  }

  public async resolve(input: unknown): Promise<FaqResolution> {
    const parsed = resolveInputSchema.safeParse(input);
    if (!parsed.success) throw new TypeError('FAQ resolution input is invalid');
    const prepared = readPreparedFaqResolutionText(parsed.data.sanitizedText);
    const request = {
      evaluatedAt: parsed.data.evaluatedAt,
      language: prepared.language,
      normalizedText: prepared.normalizedText,
    } as const;
    decideFaqResolution(request.normalizedText, request.language, [], this.policy);
    const maximumAliasCandidates = this.policy.maximumCandidates * maximumAliasRowsPerVersion;

    const candidates = await withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select set_config('pg_trgm.similarity_threshold', $1, true)`, [
        String(this.policy.minimumSimilarity),
      ]);
      const selected = await client.query<CandidateRow>(
        `with effective_versions as (
           select item.item_key as item_reference,
                  version.id as version_id,
                  version.version_ref as version_reference,
                  version.answer_en,
                  version.answer_bn
           from knowledge_items as item
           join lateral (
             select event.action, event.version_id
             from knowledge_publication_events as event
             where event.item_id = item.id
               and event.effective_at <= $3
             order by event.effective_at desc, event.id desc
             limit 1
           ) as current_publication on true
           join knowledge_versions as version
             on version.id = current_publication.version_id
           where item.kind = 'faq'
             and current_publication.action in ('publish', 'rollback')
             and version.state = 'approved'
             and version.decided_at is not null
             and version.decided_at <= $3
             and version.question_en is not null
             and version.answer_en is not null
             and version.question_bn is not null
             and version.answer_bn is not null
         ), matching_aliases as materialized (
           select effective.item_reference,
                  effective.version_id,
                  effective.version_reference,
                  alias.language,
                  alias.alias_kind,
                  alias.normalized_phrase,
                  alias.id as alias_id,
                  case when alias.language = 'en'
                       then effective.answer_en
                       else effective.answer_bn
                  end as answer,
                  alias.normalized_phrase = $1 as exact_match,
                  public.similarity(alias.normalized_phrase, $1)::double precision as similarity
           from effective_versions as effective
           join knowledge_aliases as alias on alias.version_id = effective.version_id
           where alias.language = $2
             and alias.normalized_phrase operator(public.%) $1
           order by exact_match desc, similarity desc,
                    effective.version_id, alias.id
           limit $5
         ), ranked_aliases as (
           select matching.item_reference,
                  matching.version_reference,
                  matching.language,
                  matching.alias_kind,
                  matching.normalized_phrase,
                  matching.answer,
                  matching.similarity,
                  row_number() over (
                    partition by matching.version_id
                    order by matching.exact_match desc,
                             matching.similarity desc,
                             case matching.alias_kind
                               when 'question' then 0
                               when 'alias' then 1
                               when 'example' then 2
                               else 3
                             end,
                             matching.normalized_phrase,
                             matching.alias_id
                  ) as version_rank
           from matching_aliases as matching
         )
         select item_reference, version_reference, language, alias_kind,
                normalized_phrase, answer, similarity
         from ranked_aliases
         where version_rank = 1
         order by (normalized_phrase = $1) desc, similarity desc,
                  item_reference, version_reference
         limit $4`,
        [
          request.normalizedText,
          request.language,
          request.evaluatedAt,
          this.policy.maximumCandidates,
          maximumAliasCandidates,
        ],
      );
      return selected.rows.map((row): FaqCandidate => ({
        aliasKind: row.alias_kind,
        answer: row.answer,
        itemReference: row.item_reference,
        language: row.language,
        normalizedPhrase: row.normalized_phrase,
        similarity: row.similarity,
        versionReference: row.version_reference,
      }));
    });

    return decideFaqResolution(request.normalizedText, request.language, candidates, this.policy);
  }
}
