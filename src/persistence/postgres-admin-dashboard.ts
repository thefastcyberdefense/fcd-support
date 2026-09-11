import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminActor, AdminDashboardPort, AdminProposalFilter } from '../admin/admin-app.js';
import type {
  AdminAuditSummary,
  AdminEscalationCount,
  AdminInsightSummary,
  AdminPolicySummary,
  AdminProposalDetail,
  AdminProposalSummary,
  AdminQuestionSummary,
} from '../admin/admin-html.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import type { LearningPolicy } from '../learning/learning-types.js';
import { PostgresAdminIdentity, type AdminRole } from './postgres-admin-identity.js';
import { PostgresKnowledgeRepository } from './postgres-knowledge-repository.js';
import { PostgresKnowledgePublication } from './postgres-knowledge-publication.js';
import {
  currentInsightEligibilityLateralSql,
  PostgresLearningService,
} from './postgres-learning-service.js';
import { withBoundedTransaction } from './postgres-transaction.js';

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const date = z.date().refine((value) => Number.isFinite(value.getTime()));
const proposalSchema = z.strictObject({
  answerBn: z.string().trim().min(1).max(4000),
  answerEn: z.string().trim().min(1).max(4000),
  questionBn: z.string().trim().min(1).max(1000),
  questionEn: z.string().trim().min(1).max(1000),
  createdAt: date,
  itemKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
  kind: z.enum(['faq', 'business_fact', 'safety_response', 'escalation_response']),
  requestKey: reference,
  sourceLabel: z.string().trim().min(1).max(200),
  versionRef: reference,
  replacesVersionRef: reference.optional(),
});
const commandSchema = z.strictObject({
  effectiveAt: date,
  requestKey: reference,
  versionRef: reference,
});
const reviewSchema = commandSchema.extend({ action: z.enum(['approve', 'reject']) });
const publicationSchema = commandSchema.extend({ priorVersionRef: reference.optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError('Admin knowledge command is invalid');
  return result.data;
}
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

interface ProposalRow {
  readonly version_ref: string;
  readonly item_key: string;
  readonly title: string;
  readonly source_label: string;
  readonly state: AdminProposalSummary['state'];
  readonly created_at: Date;
  readonly publication_state: NonNullable<AdminProposalSummary['publicationState']>;
  readonly effective_at: Date | null;
  readonly current_version_ref: string | null;
  readonly scheduled_action: 'publish' | 'retire' | 'rollback' | null;
  readonly scheduled_effective_at: Date | null;
}
const proposalSelect = `select version.version_ref, item.item_key, coalesce(version.question_en, item.item_key) as title,
  source.label as source_label, version.state, version.created_at,
  case when current.version_id = version.id and current.action = 'retire' then 'retired'
       when current.version_id = version.id then 'published'
       when upcoming.version_id = version.id then 'scheduled'
       when exists (select 1 from knowledge_publication_events where version_id = version.id and effective_at <= $1) then 'superseded'
       else 'unpublished' end as publication_state,
  case when current.version_id = version.id then current.effective_at else null end as effective_at,
  case when upcoming.version_id = version.id then upcoming.action else null end as scheduled_action,
  case when upcoming.version_id = version.id then upcoming.effective_at else null end as scheduled_effective_at,
  case when current.action <> 'retire' then current_version.version_ref else null end as current_version_ref
  from knowledge_versions as version join knowledge_items as item on item.id = version.item_id
  join knowledge_sources as source on source.id = version.source_id
  left join lateral (select action, version_id, effective_at from knowledge_publication_events
    where item_id = item.id and effective_at <= $1 order by effective_at desc, id desc limit 1) as current on true
  left join knowledge_versions as current_version on current_version.id = current.version_id
  left join lateral (select action, version_id, effective_at from knowledge_publication_events
    where item_id = item.id and version_id = version.id and effective_at > $1 order by effective_at, id limit 1) as upcoming on true`;

export interface AdminDashboardOptions {
  readonly now?: () => Date;
  readonly listLimit?: number;
  readonly learningPolicy?: LearningPolicy;
}

export class PostgresAdminDashboard implements AdminDashboardPort {
  readonly #now: () => Date;
  readonly #listLimit: number;
  public constructor(
    private readonly pool: pg.Pool,
    private readonly identity: PostgresAdminIdentity,
    private readonly options: AdminDashboardOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#listLimit = options.listLimit ?? 100;
    if (!Number.isSafeInteger(this.#listLimit) || this.#listLimit < 1 || this.#listLimit > 500)
      throw new TypeError('Admin list limit is invalid');
  }

  public async listProposals(
    filter: AdminProposalFilter = {},
  ): Promise<readonly AdminProposalSummary[]> {
    const parsed = parse(
      z.strictObject({
        search: z.string().max(200).default(''),
        state: z
          .enum([
            '',
            'draft',
            'submitted',
            'approved',
            'rejected',
            'published',
            'scheduled',
            'retired',
            'superseded',
          ])
          .default(''),
        page: z.number().int().min(1).max(10000).default(1),
      }),
      filter,
    );
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<ProposalRow>(
        `with proposals as (${proposalSelect}) select * from proposals
         where ($2 = '' or strpos(lower(title || ' ' || item_key || ' ' || version_ref), lower($2)) > 0)
           and ($3 = '' or state = $3 or publication_state = $3 or ($3 = 'scheduled' and scheduled_action is not null))
         order by created_at desc, version_ref desc limit $4 offset $5`,
        [
          this.#now(),
          parsed.search,
          parsed.state,
          this.#listLimit,
          (parsed.page - 1) * this.#listLimit,
        ],
      );
      return result.rows.map((row) => ({
        itemKey: row.item_key,
        sourceLabel: row.source_label,
        state: row.state,
        title: row.title,
        updatedAt: row.created_at,
        versionRef: row.version_ref,
        publicationState: row.publication_state,
        ...(row.scheduled_action === null || row.scheduled_effective_at === null
          ? {}
          : {
              scheduledAction: row.scheduled_action,
              scheduledEffectiveAt: row.scheduled_effective_at,
            }),
        ...(row.effective_at === null ? {} : { effectiveAt: row.effective_at }),
      }));
    });
  }

  public async getProposal(
    versionRef: string,
    evaluatedAt = this.#now(),
  ): Promise<AdminProposalDetail> {
    parse(reference, versionRef);
    parse(date, evaluatedAt);
    return withBoundedTransaction(
      this.pool,
      async (client) => {
        const result = await client.query<ProposalRow>(
          `${proposalSelect} where version.version_ref = $2`,
          [evaluatedAt, versionRef],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('Knowledge version was not found');
        const repository = new PostgresKnowledgeRepository({ transactionClient: client });
        const version = await repository.getVersion(versionRef);
        const previous =
          version.replacesVersionRef === undefined
            ? undefined
            : await repository.getVersion(version.replacesVersionRef);
        return {
          answerBn: version.answers.bn,
          answerEn: version.answers.en,
          questionBn: version.questions?.bn ?? '',
          questionEn: version.questions?.en ?? version.itemKey,
          itemKey: version.itemKey,
          kind: version.kind,
          state: version.state,
          sourceLabel: row.source_label,
          versionRef,
          publicationState: row.publication_state,
          ...(row.scheduled_action === null || row.scheduled_effective_at === null
            ? {}
            : {
                scheduledAction: row.scheduled_action,
                scheduledEffectiveAt: row.scheduled_effective_at,
              }),
          sourceRef: version.sourceRef,
          authorReference: version.authorReference,
          ...(row.current_version_ref === null
            ? {}
            : { currentVersionRef: row.current_version_ref }),
          ...(row.effective_at === null ? {} : { effectiveAt: row.effective_at }),
          ...(previous === undefined
            ? {}
            : { previousAnswers: previous.answers, replacesVersionRef: previous.versionRef }),
        };
      },
      { isolationLevel: 'repeatable_read' },
    );
  }

  public async createProposal(input: unknown, actor: AdminActor): Promise<void> {
    const command = parse(proposalSchema, input);
    await this.withActor(actor, ['knowledge_editor'], async (client, principal) => {
      const repository = new PostgresKnowledgeRepository({ transactionClient: client });
      const sourceRef = `SOURCE_admin_${sha256(command.requestKey).slice(0, 32)}`;
      await repository.createSource(
        {
          sourceRef,
          sourceType: 'manual_business',
          label: command.sourceLabel,
          createdByReference: principal.reviewerRef,
          createdAt: command.createdAt,
        },
        principal,
      );
      const proposal = {
        aliases: [],
        tags: [],
        questions: { en: command.questionEn, bn: command.questionBn },
        answers: { en: command.answerEn, bn: command.answerBn },
        authorReference: principal.reviewerRef,
        contentSha256: sha256(
          JSON.stringify([
            command.questionEn,
            command.answerEn,
            command.questionBn,
            command.answerBn,
          ]),
        ),
        sourceSha256: sha256(JSON.stringify(['manual_business', command.sourceLabel])),
        sourceRef,
        createdAt: command.createdAt,
        itemKey: command.itemKey,
        kind: command.kind,
        versionRef: command.versionRef,
        requestKey: command.requestKey,
        ...(command.replacesVersionRef === undefined
          ? {}
          : { replacesVersionRef: command.replacesVersionRef }),
      };
      const result =
        command.replacesVersionRef === undefined
          ? await repository.createProposal(proposal, principal)
          : await repository.createReplacementProposal(proposal, principal);
      if (result.status !== 'duplicate')
        await this.audit(
          client,
          principal,
          'knowledge_proposal_created',
          command.versionRef,
          command.requestKey,
          command.createdAt,
        );
    });
  }

  public async submitVersion(input: unknown, actor: AdminActor): Promise<void> {
    const command = parse(commandSchema, input);
    await this.withActor(actor, ['knowledge_editor'], async (client, principal) => {
      const result = await new PostgresKnowledgePublication({
        transactionClient: client,
      }).submitVersion(
        {
          ...command,
          action: 'submit',
          reasonCode: 'ready_for_review',
          reviewerReference: principal.reviewerRef,
        },
        principal,
      );
      if (result.status !== 'duplicate')
        await this.audit(
          client,
          principal,
          'knowledge_submitted',
          command.versionRef,
          command.requestKey,
          command.effectiveAt,
        );
    });
  }

  public async reviewVersion(input: unknown, actor: AdminActor): Promise<void> {
    const command = parse(reviewSchema, input);
    await this.withActor(actor, ['knowledge_reviewer'], async (client, principal) => {
      const result = await new PostgresKnowledgePublication({
        transactionClient: client,
      }).reviewVersion(
        {
          ...command,
          reasonCode: command.action === 'approve' ? 'business_fact_verified' : 'review_rejected',
          reviewerReference: principal.reviewerRef,
        },
        principal,
      );
      if (result.status !== 'duplicate')
        await this.audit(
          client,
          principal,
          command.action === 'approve' ? 'knowledge_approved' : 'knowledge_rejected',
          command.versionRef,
          command.requestKey,
          command.effectiveAt,
        );
    });
  }

  public publishVersion(input: unknown, actor: AdminActor): Promise<void> {
    return this.publication('publish', input, actor);
  }
  public retireVersion(input: unknown, actor: AdminActor): Promise<void> {
    return this.publication('retire', input, actor);
  }
  public rollbackVersion(input: unknown, actor: AdminActor): Promise<void> {
    return this.publication('rollback', input, actor);
  }

  private async publication(
    action: 'publish' | 'retire' | 'rollback',
    input: unknown,
    actor: AdminActor,
  ): Promise<void> {
    const command = parse(publicationSchema, input);
    await this.withActor(actor, ['knowledge_reviewer'], async (client, principal) => {
      const version = await new PostgresKnowledgeRepository({
        transactionClient: client,
      }).getVersion(command.versionRef);
      const publication = new PostgresKnowledgePublication({ transactionClient: client });
      const base = {
        action,
        itemKey: version.itemKey,
        versionRef: version.versionRef,
        requestKey: command.requestKey,
        effectiveAt: command.effectiveAt,
        reviewerReference: principal.reviewerRef,
        reasonCode: `reviewed_${action}`,
      };
      const result =
        action === 'retire'
          ? await publication.retireItem(base, principal)
          : action === 'publish'
            ? await publication.publishVersion(
                {
                  ...base,
                  ...(command.priorVersionRef === undefined
                    ? {}
                    : { priorVersionRef: command.priorVersionRef }),
                },
                principal,
              )
            : await publication.rollbackItem(
                { ...base, priorVersionRef: command.priorVersionRef },
                principal,
              );
      const auditAction =
        action === 'publish'
          ? 'knowledge_published'
          : action === 'retire'
            ? 'knowledge_retired'
            : 'knowledge_rolled_back';
      if (result.status !== 'duplicate')
        await this.audit(
          client,
          principal,
          auditAction,
          version.versionRef,
          command.requestKey,
          command.effectiveAt,
        );
    });
  }

  public async listQuestions(): Promise<readonly AdminQuestionSummary[]> {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{
        question_ref: string;
        question_en: string;
        priority: AdminQuestionSummary['priority'];
        state: AdminQuestionSummary['state'];
      }>(
        `with eligible_open_questions as (
           select distinct link.question_id
           from owner_question_insights as link
           join customer_insight_entries as insight on insight.id = link.insight_id
           join customer_insight_runs as run on run.id = insight.run_id
           join ${currentInsightEligibilityLateralSql}
             on current_insight.person_count >= run.minimum_group_count
           where run.state = 'completed' and insight.erased_at is null
             and insight.retention_deadline > $1
         )
         select question.question_ref, question.question_en, question.priority, question.state
         from owner_questions as question
         where question.state <> 'open'
            or exists (select 1 from eligible_open_questions where question_id = question.id)
         order by question.created_at desc, question.id desc limit $2`,
        [this.#now(), this.#listLimit],
      );
      return result.rows.map((row) => ({
        questionRef: row.question_ref,
        questionText: row.question_en,
        priority: row.priority,
        state: row.state,
      }));
    });
  }
  public async answerQuestion(input: unknown, actor: AdminActor): Promise<void> {
    const learningPolicy = this.options.learningPolicy;
    if (learningPolicy === undefined) throw new Error('Owner question service is not configured');
    await this.withActor(actor, ['knowledge_editor'], async (client, principal) => {
      await new PostgresLearningService(
        { transactionClient: client },
        { now: this.#now, policy: learningPolicy },
      ).answerOwnerQuestion(input, principal);
    });
  }
  public async listInsights(): Promise<readonly AdminInsightSummary[]> {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{
        topic_code: string;
        category_code: string;
        occurrence_count: number;
      }>(
        `select insight.topic_code, insight.category_code,
                current_insight.occurrence_count
         from customer_insight_entries as insight
         join customer_insight_runs as run on run.id = insight.run_id
         join ${currentInsightEligibilityLateralSql}
           on current_insight.person_count >= run.minimum_group_count
         where run.state = 'completed' and insight.erased_at is null
           and insight.retention_deadline > $1
         order by insight.created_at desc, insight.id desc limit $2`,
        [this.#now(), this.#listLimit],
      );
      return result.rows.map((row) => ({
        topicCode: row.topic_code,
        categoryCode: row.category_code,
        occurrenceCount: row.occurrence_count,
      }));
    });
  }
  public resolveActivePolicy(): Promise<AdminPolicySummary | undefined> {
    return Promise.resolve(undefined);
  }
  public async listEscalationCounts(): Promise<readonly AdminEscalationCount[]> {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{ reason_code: string; state: string; count: number }>(
        `select reason_code, state, count(*)::int as count from support_escalation_outcomes group by reason_code, state order by reason_code, state`,
      );
      return result.rows.map((row) => ({
        reasonCode: row.reason_code,
        state: row.state,
        count: row.count,
      }));
    });
  }
  public async listAudit(): Promise<readonly AdminAuditSummary[]> {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{
        action: string;
        effective_at: Date;
        object_ref: string | null;
        result: string;
      }>(
        `select action, effective_at, object_ref, result from admin_audit_events order by id desc limit $1`,
        [this.#listLimit],
      );
      return result.rows.map((row) => ({
        action: row.action,
        effectiveAt: row.effective_at,
        objectRef: row.object_ref,
        result: row.result,
      }));
    });
  }
  private withActor<T>(
    actor: AdminActor,
    roles: readonly AdminRole[],
    operation: (client: pg.PoolClient, principal: ReviewerPrincipal) => Promise<T>,
  ): Promise<T> {
    return withBoundedTransaction(this.pool, async (client) => {
      const session = await this.identity.authorizeSession(client, actor.sessionToken, roles);
      if (session.accountRef !== actor.accountRef)
        throw new Error('Admin actor does not match session');
      return operation(client, { reviewerRef: session.accountRef, roles: [...session.roles] });
    });
  }
  private async audit(
    client: pg.PoolClient,
    principal: ReviewerPrincipal,
    action: string,
    versionRef: string,
    requestKey: string,
    effectiveAt: Date,
  ): Promise<void> {
    await client.query(
      `insert into admin_audit_events (actor_account_id, action, result, object_type, object_ref, reason_code, request_key, effective_at)
      values ((select id from admin_accounts where account_ref = $1), $2, 'applied', 'knowledge_version', $3, 'reviewed_dashboard_action', $4, $5)`,
      [principal.reviewerRef, action, versionRef, requestKey, effectiveAt],
    );
  }
}
