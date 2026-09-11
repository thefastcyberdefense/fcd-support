import { createHash } from 'node:crypto';
import {
  parseGapObservation,
  parseInsightRun,
  parseLearningPolicy,
  parseOwnerAnswer,
  parseQuestionDigest,
} from '../learning/learning-input.js';
import type { GapKind, LearningPolicy } from '../learning/learning-types.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import { requireKnowledgeEditor } from '../policy/reviewer-principal.js';
import { PostgresKnowledgeRepository } from './postgres-knowledge-repository.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

export class LearningConflictError extends Error {
  public override readonly name = 'LearningConflictError';
}
export interface LearningServiceOptions {
  readonly policy: LearningPolicy;
  readonly now?: () => Date;
}
export interface GapObservationResult {
  readonly observationRef: string;
  readonly status: 'created' | 'duplicate';
}
export interface InsightRunResult {
  readonly entryCount: number;
  readonly runRef: string;
  readonly status: 'created' | 'duplicate';
}
export type QuestionDigestResult =
  | {
      readonly digestRef: string;
      readonly questionRefs: readonly string[];
      readonly status: 'created' | 'duplicate';
    }
  | { readonly questionRefs: readonly []; readonly status: 'empty' | 'not_due' };
export interface OwnerAnswerResult {
  readonly proposalVersionRef: string;
  readonly status: 'created' | 'duplicate';
}

interface ExistingObservationRow {
  readonly candidate_refs: readonly string[];
  readonly created_at: Date;
  readonly gap_kind: GapKind;
  readonly language: 'bn' | 'en';
  readonly observation_ref: string;
  readonly request_key: string;
  readonly retention_deadline: Date;
  readonly sanitized_summary: string | null;
  readonly source_webhook_event_id: string;
}
interface AuthorityRow {
  readonly channel_account_id: string | null;
  readonly contact_id: string | null;
  readonly content_purged_through_at: Date | null;
  readonly conversation_id: string;
  readonly external_contact_id: string;
  readonly occurred_at: Date | null;
  readonly retention_expires_at: Date | null;
}
interface ExistingRunRow {
  readonly entry_count: number;
  readonly minimum_group_count: number;
  readonly request_key: string;
  readonly run_ref: string;
  readonly window_ended_at: Date;
  readonly window_started_at: Date;
}
interface ExistingDigestRow {
  readonly digest_ref: string;
  readonly question_refs: readonly string[];
  readonly request_key: string;
}
interface ExistingAnswerRow {
  readonly account_ref: string;
  readonly answer_bn: string;
  readonly answer_text: string;
  readonly answered_at: Date;
  readonly question_ref: string;
  readonly request_key: string;
  readonly version_ref: string;
}
const topicByGapKind: Readonly<Record<GapKind, string>> = {
  bilingual_coverage_gap: 'knowledge_coverage',
  escalation: 'escalation',
  faq_ambiguous: 'knowledge_coverage',
  faq_miss: 'knowledge_coverage',
  human_correction: 'correction',
  repeated_topic: 'recurring_topic',
  unsupported_model_claim: 'answer_quality',
};
const questionByGapKind: Readonly<
  Record<
    GapKind,
    { readonly bn: string; readonly en: string; readonly priority: 'high' | 'low' | 'normal' }
  >
> = {
  faq_miss: {
    en: 'Which reviewed answer should cover this recurring FAQ gap?',
    bn: 'এই পুনরাবৃত্ত FAQ ঘাটতির জন্য কোন পর্যালোচিত উত্তর প্রযোজ্য?',
    priority: 'normal',
  },
  faq_ambiguous: {
    en: 'How should reviewed FAQ answers distinguish this ambiguous category?',
    bn: 'এই অস্পষ্ট বিভাগকে পর্যালোচিত FAQ উত্তরগুলো কীভাবে আলাদা করবে?',
    priority: 'normal',
  },
  unsupported_model_claim: {
    en: 'Which reviewed fact should replace this unsupported answer category?',
    bn: 'এই অসমর্থিত উত্তর বিভাগের পরিবর্তে কোন পর্যালোচিত তথ্য ব্যবহার হবে?',
    priority: 'high',
  },
  human_correction: {
    en: 'Which reviewed answer should capture this recurring human correction?',
    bn: 'এই পুনরাবৃত্ত মানব সংশোধনটি কোন পর্যালোচিত উত্তরে অন্তর্ভুক্ত হবে?',
    priority: 'high',
  },
  escalation: {
    en: 'Which reviewed guidance could safely resolve this escalation category?',
    bn: 'এই এসকেলেশন বিভাগ নিরাপদে সমাধানে কোন পর্যালোচিত নির্দেশনা প্রযোজ্য?',
    priority: 'high',
  },
  repeated_topic: {
    en: 'Which reviewed answer should cover this recurring support topic?',
    bn: 'এই পুনরাবৃত্ত সহায়তা বিষয়ের জন্য কোন পর্যালোচিত উত্তর প্রযোজ্য?',
    priority: 'low',
  },
  bilingual_coverage_gap: {
    en: 'What reviewed bilingual answer should fill this coverage gap?',
    bn: 'এই ঘাটতি পূরণে কোন পর্যালোচিত দ্বিভাষিক উত্তর প্রযোজ্য?',
    priority: 'normal',
  },
};
// Requires outer aliases `insight` and `run`, with evaluation time in parameter $1.
// It returns counts only; external identities and customer content never leave SQL.
export const currentInsightEligibilityLateralSql = `lateral (
  select count(*)::int as occurrence_count,
         count(distinct current_identity.contact_id)::int as person_count
  from knowledge_gap_observations as current_observation
  join conversations as current_conversation
    on current_conversation.id = current_observation.conversation_id
  join channel_identities as current_identity
    on current_identity.id = current_conversation.channel_identity_id
  join conversation_retention_states as current_retention
    on current_retention.conversation_id = current_observation.conversation_id
  join webhook_events as current_source_event
    on current_source_event.id = current_observation.source_webhook_event_id
  where current_observation.created_at >= run.window_started_at
    and current_observation.created_at < run.window_ended_at
    and current_observation.gap_kind = insight.category_code
    and current_observation.language is not distinct from insight.language
    and current_observation.erased_at is null
    and current_observation.retention_deadline > $1
    and current_source_event.contact_id is not null
    and current_identity.external_contact_id not like 'deleted:%'
    and (current_retention.content_purged_through_at is null
         or current_retention.content_purged_through_at < current_observation.created_at)
    and not exists (
      select 1 from privacy_requests as current_privacy
      where current_privacy.contact_id = current_identity.contact_id
        and current_privacy.state in ('received','awaiting_confirmation','human_review','in_progress')
    )
) as current_insight`;
const sameDate = (left: Date, right: Date): boolean => left.getTime() === right.getTime();
const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
function insightReference(runRef: string, gapKind: GapKind, language: 'bn' | 'en'): string {
  return (
    'INSIGHT_' +
    createHash('sha256')
      .update(JSON.stringify([runRef, gapKind, language]))
      .digest('hex')
      .slice(0, 48)
  );
}
function derivedReference(prefix: string, ...material: readonly string[]): string {
  return prefix + sha256(JSON.stringify(material)).slice(0, 48);
}

export class PostgresLearningService {
  readonly #now: () => Date;
  readonly #policy: LearningPolicy;
  public constructor(
    private readonly pool: TransactionSource,
    options: LearningServiceOptions,
  ) {
    this.#policy = parseLearningPolicy(options.policy);
    this.#now = options.now ?? (() => new Date());
  }

  public async recordGapObservation(input: unknown): Promise<GapObservationResult> {
    const command = parseGapObservation(input);
    const now = this.#now();
    if (command.observedAt > now || command.retentionDeadline <= now)
      throw new LearningConflictError('Learning observation time is not eligible');
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        command.requestKey,
      ]);
      const existing = await client.query<ExistingObservationRow>(
        `select observation.observation_ref, observation.request_key,
                observation.source_webhook_event_id::text, observation.language,
                observation.gap_kind, observation.sanitized_summary,
                observation.retention_deadline, observation.created_at,
                coalesce(array_agg(version.version_ref order by candidate.candidate_rank)
                  filter (where version.version_ref is not null), '{}') as candidate_refs
         from knowledge_gap_observations as observation
         left join knowledge_gap_candidates as candidate on candidate.observation_id = observation.id
         left join knowledge_versions as version on version.id = candidate.knowledge_version_id
         where observation.request_key = $1 or observation.observation_ref = $2
            or observation.source_webhook_event_id = $3
         group by observation.id`,
        [command.requestKey, command.observationRef, command.webhookEventId],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        const matches =
          existing.rows.length === 1 &&
          prior.request_key === command.requestKey &&
          prior.observation_ref === command.observationRef &&
          prior.source_webhook_event_id === command.webhookEventId &&
          prior.language === command.language &&
          prior.gap_kind === command.gapKind &&
          prior.sanitized_summary === (command.sanitizedSummary ?? null) &&
          sameDate(prior.retention_deadline, command.retentionDeadline) &&
          sameDate(prior.created_at, command.observedAt) &&
          prior.candidate_refs.length === command.candidateVersionRefs.length &&
          prior.candidate_refs.every(
            (candidate, index) => candidate === command.candidateVersionRefs[index],
          );
        if (!matches) throw new LearningConflictError('Learning observation replay conflicts');
        return { observationRef: prior.observation_ref, status: 'duplicate' };
      }
      const authority = await client.query<AuthorityRow>(
        `select event.occurred_at, event.channel_account_id, identity.contact_id::text as contact_id,
                application.conversation_id::text, identity.external_contact_id,
                retention.expires_at as retention_expires_at, retention.content_purged_through_at
         from webhook_events as event
         join webhook_event_applications as application
           on application.webhook_event_id = event.id and application.outcome = 'customer_message_applied'
         join conversations as conversation on conversation.id = application.conversation_id
         join channel_identities as identity on identity.id = conversation.channel_identity_id
         join conversation_retention_states as retention on retention.conversation_id = conversation.id
         where event.id = $1 and event.event_kind = 'customer_message'
           and event.admission_outcome = 'pending'
         for share of event, application, conversation, identity, retention`,
        [command.webhookEventId],
      );
      const source = authority.rows[0];
      if (
        source?.occurred_at === undefined ||
        source.occurred_at === null ||
        source.channel_account_id === null ||
        source.contact_id === null ||
        source.external_contact_id.startsWith('deleted:') ||
        !sameDate(source.occurred_at, command.observedAt) ||
        (source.content_purged_through_at !== null &&
          source.content_purged_through_at >= command.observedAt) ||
        (source.retention_expires_at !== null &&
          command.retentionDeadline > source.retention_expires_at)
      )
        throw new LearningConflictError('Learning source event is not eligible');
      const privacyHold = await client.query<{ readonly held: boolean }>(
        `select exists (select 1 from privacy_requests where contact_id = $1
          and state in ('received', 'awaiting_confirmation', 'human_review', 'in_progress')) as held`,
        [source.contact_id],
      );
      if (privacyHold.rows[0]?.held === true)
        throw new LearningConflictError('Learning source is under privacy hold');

      let candidateIds: readonly { readonly id: string; readonly version_ref: string }[] = [];
      if (command.candidateVersionRefs.length > 0) {
        const candidates = await client.query<{
          readonly id: string;
          readonly version_ref: string;
        }>(
          `select version.id, version.version_ref from knowledge_versions as version
           join knowledge_items as item on item.id = version.item_id
           join lateral (
             select event.action, event.version_id from knowledge_publication_events as event
             where event.item_id = item.id and event.effective_at <= $2
             order by event.effective_at desc, event.id desc limit 1
           ) as effective on effective.version_id = version.id
             and effective.action in ('publish', 'rollback')
           where version.version_ref = any($1::text[])`,
          [command.candidateVersionRefs, command.observedAt],
        );
        const byReference = new Map(candidates.rows.map((row) => [row.version_ref, row]));
        candidateIds = command.candidateVersionRefs.map((reference) => {
          const candidate = byReference.get(reference);
          if (candidate === undefined)
            throw new LearningConflictError('Learning candidate was not published');
          return candidate;
        });
      }
      const inserted = await client.query<{ readonly id: string }>(
        `insert into knowledge_gap_observations
          (observation_ref, source_webhook_event_id, conversation_id, language,
           gap_kind, sanitized_summary, retention_deadline, request_key, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          command.observationRef,
          command.webhookEventId,
          source.conversation_id,
          command.language,
          command.gapKind,
          command.sanitizedSummary ?? null,
          command.retentionDeadline,
          command.requestKey,
          command.observedAt,
        ],
      );
      const observationId = inserted.rows[0]?.id;
      if (observationId === undefined) throw new Error('Learning observation insert failed');
      for (const [index, candidate] of candidateIds.entries())
        await client.query(
          `insert into knowledge_gap_candidates
            (observation_id, knowledge_version_id, candidate_rank, similarity_score)
           values ($1,$2,$3,null)`,
          [observationId, candidate.id, index + 1],
        );
      return { observationRef: command.observationRef, status: 'created' };
    });
  }

  public async aggregateInsights(input: unknown): Promise<InsightRunResult> {
    const command = parseInsightRun(input);
    const now = this.#now();
    if (command.windowEndedAt > now)
      throw new LearningConflictError('Insight window is not complete');
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        command.requestKey,
      ]);
      const existing = await client.query<ExistingRunRow>(
        `select run.run_ref, run.request_key, run.window_started_at,
                run.window_ended_at, run.minimum_group_count, count(entry.id)::int as entry_count
         from customer_insight_runs as run
         left join customer_insight_entries as entry on entry.run_id = run.id
         where run.request_key = $1 or run.run_ref = $2 group by run.id`,
        [command.requestKey, command.runRef],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (
          existing.rows.length !== 1 ||
          prior.run_ref !== command.runRef ||
          prior.request_key !== command.requestKey ||
          !sameDate(prior.window_started_at, command.windowStartedAt) ||
          !sameDate(prior.window_ended_at, command.windowEndedAt) ||
          prior.minimum_group_count !== this.#policy.minimumGroupCount
        )
          throw new LearningConflictError('Insight run replay conflicts');
        return { entryCount: prior.entry_count, runRef: prior.run_ref, status: 'duplicate' };
      }
      const observations = await client.query<{
        readonly contact_id: string;
        readonly gap_kind: GapKind;
        readonly language: 'bn' | 'en';
        readonly retention_deadline: Date;
      }>(
        `select identity.contact_id::text, observation.gap_kind, observation.language,
                observation.retention_deadline
         from knowledge_gap_observations as observation
         join conversations as conversation on conversation.id = observation.conversation_id
         join channel_identities as identity on identity.id = conversation.channel_identity_id
         join conversation_retention_states as retention
           on retention.conversation_id = observation.conversation_id
         join webhook_events as source_event
           on source_event.id = observation.source_webhook_event_id
         where observation.created_at >= $1 and observation.created_at < $2
           and observation.erased_at is null and observation.retention_deadline > $3
           and source_event.contact_id is not null
           and identity.external_contact_id not like 'deleted:%'
           and (retention.content_purged_through_at is null
                or retention.content_purged_through_at < observation.created_at)
           and not exists (
             select 1 from privacy_requests as privacy
             where privacy.contact_id = identity.contact_id
               and privacy.state in ('received','awaiting_confirmation','human_review','in_progress')
           )
         order by observation.id limit $4`,
        [
          command.windowStartedAt,
          command.windowEndedAt,
          now,
          this.#policy.maximumObservationsPerRun + 1,
        ],
      );
      if (observations.rows.length > this.#policy.maximumObservationsPerRun)
        throw new LearningConflictError('Insight observation bound was exceeded');
      const groups = new Map<
        string,
        {
          contactIds: Set<string>;
          count: number;
          gapKind: GapKind;
          language: 'bn' | 'en';
          retentionDeadline: Date;
        }
      >();
      for (const observation of observations.rows) {
        const key = observation.gap_kind + ':' + observation.language;
        const group = groups.get(key) ?? {
          contactIds: new Set<string>(),
          count: 0,
          gapKind: observation.gap_kind,
          language: observation.language,
          retentionDeadline: observation.retention_deadline,
        };
        group.count += 1;
        group.contactIds.add(observation.contact_id);
        if (observation.retention_deadline < group.retentionDeadline)
          group.retentionDeadline = observation.retention_deadline;
        groups.set(key, group);
      }
      const eligible = [...groups.values()]
        .filter((group) => group.contactIds.size >= this.#policy.minimumGroupCount)
        .sort((left, right) =>
          (left.gapKind + ':' + left.language).localeCompare(right.gapKind + ':' + right.language),
        );
      const inserted = await client.query<{ readonly id: string }>(
        `insert into customer_insight_runs
          (run_ref, window_started_at, window_ended_at, minimum_group_count,
           state, source_observation_count, request_key, created_at)
         values ($1,$2,$3,$4,'completed',$5,$6,$7) returning id`,
        [
          command.runRef,
          command.windowStartedAt,
          command.windowEndedAt,
          this.#policy.minimumGroupCount,
          observations.rows.length,
          command.requestKey,
          now,
        ],
      );
      const runId = inserted.rows[0]?.id;
      if (runId === undefined) throw new Error('Insight run insert failed');
      for (const group of eligible) {
        const insightRef = insightReference(command.runRef, group.gapKind, group.language);
        const entry = await client.query<{ readonly id: string }>(
          `insert into customer_insight_entries
            (insight_ref, run_id, topic_code, category_code, language,
             occurrence_count, sanitized_summary, retention_deadline, created_at)
           values ($1,$2,$3,$4,$5,$6,null,$7,$8) returning id`,
          [
            insightRef,
            runId,
            topicByGapKind[group.gapKind],
            group.gapKind,
            group.language,
            group.count,
            group.retentionDeadline,
            now,
          ],
        );
        const insightId = entry.rows[0]?.id;
        if (insightId === undefined) throw new Error('Insight entry insert failed');
        const question = questionByGapKind[group.gapKind];
        const questionLockKey = derivedReference('LOCK_question_', group.gapKind, group.language);
        await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          questionLockKey,
        ]);
        const latestQuestion = (
          await client.query<{ readonly id: string; readonly state: string }>(
            `select question.id::text, question.state
             from owner_questions as question
             join owner_question_insights as link on link.question_id = question.id
             join customer_insight_entries as prior_insight on prior_insight.id = link.insight_id
             where prior_insight.category_code = $1 and prior_insight.language = $2
             order by question.created_at desc, question.id desc limit 1
             for update of question`,
            [group.gapKind, group.language],
          )
        ).rows[0];
        let questionId = latestQuestion?.state === 'open' ? latestQuestion.id : undefined;
        const questionRequestKey = derivedReference('REQUEST_question_', insightRef);
        questionId ??= (
          await client.query<{ readonly id: string }>(
            `insert into owner_questions
              (question_ref, question_en, question_bn, priority, state,
               next_eligible_digest_at, request_key, created_at, updated_at)
             values ($1,$2,$3,$4,'open',$5,$6,$5,$5) returning id`,
            [
              derivedReference('QUESTION_', insightRef),
              question.en,
              question.bn,
              question.priority,
              now,
              questionRequestKey,
            ],
          )
        ).rows[0]?.id;
        if (questionId === undefined) throw new Error('Owner question insert failed');
        await client.query(
          `insert into owner_question_insights (question_id, insight_id) values ($1,$2)`,
          [questionId, insightId],
        );
      }
      return { entryCount: eligible.length, runRef: command.runRef, status: 'created' };
    });
  }

  public async openQuestionDigest(input: unknown): Promise<QuestionDigestResult> {
    const command = parseQuestionDigest(input);
    const now = this.#now();
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended('fcd-support:owner-question-digest', 0))`,
      );
      const existing = await client.query<ExistingDigestRow>(
        `select digest.digest_ref, digest.request_key,
                array_agg(question.question_ref order by entry.position) as question_refs
         from owner_question_digests as digest
         join owner_question_digest_entries as entry on entry.digest_id = digest.id
         join owner_questions as question on question.id = entry.question_id
         where digest.request_key = $1 or digest.digest_ref = $2
         group by digest.id`,
        [command.requestKey, command.digestRef],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (
          existing.rows.length !== 1 ||
          prior.request_key !== command.requestKey ||
          prior.digest_ref !== command.digestRef
        )
          throw new LearningConflictError('Question digest replay conflicts');
        return {
          digestRef: prior.digest_ref,
          questionRefs: prior.question_refs,
          status: 'duplicate',
        };
      }
      const latest = await client.query<{ readonly created_at: Date }>(
        `select created_at from owner_question_digests order by created_at desc, id desc limit 1`,
      );
      const latestAt = latest.rows[0]?.created_at;
      if (
        latestAt !== undefined &&
        now.getTime() < latestAt.getTime() + this.#policy.digestIntervalMilliseconds
      )
        return { questionRefs: [], status: 'not_due' };

      const selected = await client.query<{ readonly id: string; readonly question_ref: string }>(
        `select question.id::text, question.question_ref
         from owner_questions as question
         join owner_question_insights as link on link.question_id = question.id
         join customer_insight_entries as insight on insight.id = link.insight_id
         join customer_insight_runs as run on run.id = insight.run_id
         join ${currentInsightEligibilityLateralSql}
           on current_insight.person_count >= run.minimum_group_count
         left join owner_question_digest_entries as prior_entry
           on prior_entry.question_id = question.id
         where question.state = 'open' and question.next_eligible_digest_at <= $1
           and run.state = 'completed' and insight.erased_at is null
           and insight.retention_deadline > $1
         group by question.id
         having count(distinct prior_entry.digest_id) < $2
         order by case question.priority when 'high' then 1 when 'normal' then 2 else 3 end,
                  question.created_at, question.id
         limit $3`,
        [now, this.#policy.maximumDigestAppearances, this.#policy.maximumQuestionsPerDigest],
      );
      if (selected.rows.length === 0) return { questionRefs: [], status: 'empty' };

      const periodStartedAt = new Date(now.getTime() - this.#policy.digestIntervalMilliseconds);
      const digest = await client.query<{ readonly id: string }>(
        `insert into owner_question_digests
          (digest_ref, state, period_started_at, period_ended_at, question_count,
           request_key, created_at)
         values ($1,'ready',$2,$3,$4,$5,$3) returning id`,
        [command.digestRef, periodStartedAt, now, selected.rows.length, command.requestKey],
      );
      const digestId = digest.rows[0]?.id;
      if (digestId === undefined) throw new Error('Question digest insert failed');
      for (const [index, question] of selected.rows.entries()) {
        await client.query(
          `insert into owner_question_digest_entries (digest_id, question_id, position)
           values ($1,$2,$3)`,
          [digestId, question.id, index + 1],
        );
        await client.query(
          `update owner_questions
           set next_eligible_digest_at = $2, updated_at = $1, row_version = row_version + 1
           where id = $3`,
          [now, new Date(now.getTime() + this.#policy.questionCooldownMilliseconds), question.id],
        );
      }
      return {
        digestRef: command.digestRef,
        questionRefs: selected.rows.map((question) => question.question_ref),
        status: 'created',
      };
    });
  }

  public async answerOwnerQuestion(
    input: unknown,
    principalInput: unknown,
  ): Promise<OwnerAnswerResult> {
    const command = parseOwnerAnswer(input);
    const principal: ReviewerPrincipal = requireKnowledgeEditor(principalInput);
    const now = this.#now();
    if (command.answeredAt > now)
      throw new LearningConflictError('Owner answer time is not eligible');
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        command.requestKey,
      ]);
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        command.questionRef,
      ]);
      const existing = await client.query<ExistingAnswerRow>(
        `select answer.request_key, answer.answer_text, answer.answered_at,
                account.account_ref, question.question_ref,
                version.version_ref, version.answer_bn
         from owner_question_answers as answer
         join owner_questions as question on question.id = answer.question_id
         join admin_accounts as account on account.id = answer.reviewer_account_id
         join knowledge_versions as version on version.id = answer.proposal_version_id
         where answer.request_key = $1 or question.question_ref = $2`,
        [command.requestKey, command.questionRef],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        const matches =
          existing.rows.length === 1 &&
          prior.request_key === command.requestKey &&
          prior.question_ref === command.questionRef &&
          prior.answer_text === command.answerText &&
          prior.answer_bn === command.answerBn &&
          prior.account_ref === principal.reviewerRef &&
          sameDate(prior.answered_at, command.answeredAt);
        if (!matches) throw new LearningConflictError('Owner answer replay conflicts');
        return { proposalVersionRef: prior.version_ref, status: 'duplicate' };
      }
      const question = await client.query<{
        readonly created_at: Date;
        readonly id: string;
        readonly question_bn: string | null;
        readonly question_en: string;
        readonly state: 'answered' | 'dismissed' | 'open';
      }>(
        `select question.id::text, question.question_en, question.question_bn,
                question.state, question.created_at
         from owner_questions as question
         where question.question_ref = $2
           and exists (
             select 1
             from owner_question_insights as link
             join customer_insight_entries as insight on insight.id = link.insight_id
             join customer_insight_runs as run on run.id = insight.run_id
             join ${currentInsightEligibilityLateralSql}
               on current_insight.person_count >= run.minimum_group_count
             where link.question_id = question.id and run.state = 'completed'
               and insight.erased_at is null and insight.retention_deadline > $1
           )
         for update of question`,
        [now, command.questionRef],
      );
      const selected = question.rows[0];
      if (
        selected?.state !== 'open' ||
        selected.question_bn === null ||
        command.answeredAt < selected.created_at
      )
        throw new LearningConflictError('Owner question is not answerable');
      const account = await client.query<{ readonly id: string }>(
        `select account.id::text
         from admin_accounts as account
         where account.account_ref = $1 and account.state = 'active'
           and exists (
             select 1 from (
               select distinct on (assignment.role) assignment.role, assignment.action
               from admin_role_assignments as assignment
               where assignment.account_id = account.id and assignment.effective_at <= $2
               order by assignment.role, assignment.effective_at desc, assignment.id desc
             ) as role_state
             where role_state.action = 'assign'
               and role_state.role in ('administrator','knowledge_editor')
           )`,
        [principal.reviewerRef, now],
      );
      const accountId = account.rows[0]?.id;
      if (accountId === undefined) throw new LearningConflictError('Owner reviewer is not active');

      const sourceRef = derivedReference('SOURCE_owner_', command.questionRef);
      const versionRef = derivedReference('VERSION_owner_', command.requestKey);
      const itemKey = 'faq.owner.' + sha256(command.questionRef).slice(0, 32);
      const repository = new PostgresKnowledgeRepository({ transactionClient: client });
      await repository.createSource(
        {
          sourceRef,
          sourceType: 'support_gap',
          label: 'Reviewed owner answer to an aggregate support gap',
          createdByReference: principal.reviewerRef,
          createdAt: command.answeredAt,
        },
        principal,
      );
      const canonicalContent = JSON.stringify({
        answers: { bn: command.answerBn, en: command.answerText },
        questions: { bn: selected.question_bn, en: selected.question_en },
      });
      await repository.createProposal(
        {
          aliases: [],
          answers: { bn: command.answerBn, en: command.answerText },
          authorReference: principal.reviewerRef,
          contentSha256: sha256(canonicalContent),
          createdAt: command.answeredAt,
          itemKey,
          kind: 'faq',
          questions: { bn: selected.question_bn, en: selected.question_en },
          requestKey: derivedReference('REQUEST_proposal_', command.requestKey),
          sourceRef,
          sourceSha256: sha256(JSON.stringify({ questionRef: command.questionRef })),
          tags: ['owner_answer', 'support_gap'],
          versionRef,
        },
        principal,
      );
      const version = await client.query<{ readonly id: string }>(
        `select id::text from knowledge_versions where version_ref = $1 and state = 'draft'`,
        [versionRef],
      );
      const versionId = version.rows[0]?.id;
      if (versionId === undefined) throw new Error('Owner answer proposal insert failed');
      await client.query(
        `insert into owner_question_answers
          (question_id, answer_text, reviewer_account_id, proposal_version_id,
           answered_at, request_key, created_at)
         values ($1,$2,$3,$4,$5,$6,$5)`,
        [
          selected.id,
          command.answerText,
          accountId,
          versionId,
          command.answeredAt,
          command.requestKey,
        ],
      );
      await client.query(
        `update owner_questions
         set state = 'answered', answered_at = $2, updated_at = $2, row_version = row_version + 1
         where id = $1`,
        [selected.id, command.answeredAt],
      );
      await client.query(
        `insert into admin_audit_events
          (actor_account_id, action, result, object_type, object_ref,
           reason_code, request_key, effective_at)
         values ($1,'owner_question_answered','applied','owner_question',$2,
                 'reviewed_owner_answer',$3,$4)`,
        [accountId, command.questionRef, command.requestKey, command.answeredAt],
      );
      return { proposalVersionRef: versionRef, status: 'created' };
    });
  }
}
