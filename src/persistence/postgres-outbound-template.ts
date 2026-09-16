import type pg from 'pg';
import { z } from 'zod';

import {
  parseFixedTemplateVersionInput,
  type FixedTemplateVersionInput,
} from '../outbound/outbound-template-input.js';
import {
  OUTBOUND_PURPOSES,
  type EffectiveFixedTemplate,
  type OutboundTemplateMutationResult,
} from '../outbound/outbound-types.js';
import { PolicyAuthorizationError } from '../policy/reviewer-principal.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const opaqueReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));
const principalSchema = z.strictObject({
  reviewerRef: opaqueReference,
  roles: z.array(z.string().min(1).max(64)).max(16),
});
const transitionSchema = z.strictObject({
  effectiveAt: validDate,
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  requestKey: opaqueReference,
  reviewerAccountRef: opaqueReference,
  templateRef: opaqueReference,
  versionNumber: z.number().int().min(1),
});
const resolveSchema = z.strictObject({
  category: z.enum(OUTBOUND_PURPOSES),
  channel: z.literal('whatsapp'),
  channelAccountId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u),
  evaluatedAt: validDate,
  locale: z.enum(['bn_BD', 'en_US']),
  templateRef: opaqueReference,
});

interface TransitionInput {
  readonly effectiveAt: Date;
  readonly reasonCode: string;
  readonly requestKey: string;
  readonly reviewerAccountRef: string;
  readonly templateRef: string;
  readonly versionNumber: number;
}

interface TemplateRow {
  readonly category: FixedTemplateVersionInput['category'];
  readonly channel: 'whatsapp';
  readonly channel_account_id: string;
  readonly content_sha256: string;
  readonly created_at: Date;
  readonly created_by_account_ref: string;
  readonly id: string;
  readonly locale: FixedTemplateVersionInput['locale'];
  readonly provider_template_id: string;
  readonly request_key: string;
  readonly template_name: string;
  readonly template_ref: string;
  readonly variable_count: number;
  readonly version_number: number;
}

interface TransitionRow {
  readonly action: 'activate' | 'approve' | 'retire' | 'submit';
  readonly effective_at: Date;
  readonly reason_code: string;
  readonly reviewer_account_ref: string;
  readonly template_ref: string;
  readonly version_number: number;
}

const templateSelect = `
  select template.id, template.template_ref, template.version_number,
         template.request_key, template.channel, template.channel_account_id,
         template.provider_template_id, template.template_name, template.locale,
         template.category, template.variable_count, template.content_sha256,
         template.state, template.created_at, template.submitted_at,
         template.decided_at, template.activated_at, template.retired_at,
         creator.account_ref as created_by_account_ref,
         approver.account_ref as approved_by_account_ref
  from outbound_template_versions as template
  join admin_accounts as creator on creator.id = template.created_by_account_id
  left join admin_accounts as approver on approver.id = template.approved_by_account_id`;

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function requireAdministrator(principalValue: unknown): ReviewerPrincipal {
  const principal = principalSchema.parse(principalValue);
  if (!principal.roles.includes('administrator')) {
    throw new PolicyAuthorizationError('Outbound template administrator role required');
  }
  return principal;
}

function createMatches(
  row: TemplateRow,
  input: FixedTemplateVersionInput,
  creatorReference: string,
): boolean {
  return (
    row.template_ref === input.templateRef &&
    row.request_key === input.requestKey &&
    row.channel_account_id === input.channelAccountId &&
    row.provider_template_id === input.providerTemplateId &&
    row.template_name === input.templateName &&
    row.locale === input.locale &&
    row.category === input.category &&
    row.variable_count === 0 &&
    row.content_sha256 === input.contentSha256 &&
    row.created_by_account_ref === creatorReference &&
    sameDate(row.created_at, input.createdAt)
  );
}

export class PostgresOutboundTemplate {
  public constructor(private readonly pool: TransactionSource) {}

  public async createVersion(
    inputValue: unknown,
    principalValue: unknown,
  ): Promise<OutboundTemplateMutationResult> {
    const input = parseFixedTemplateVersionInput(inputValue);
    const principal = requireAdministrator(principalValue);
    return withBoundedTransaction(this.pool, async (client) => {
      const accountId = await this.requireDatabaseAdministrator(
        client,
        principal.reviewerRef,
        input.createdAt,
      );
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 7100513::bigint))`,
        [input.templateRef],
      );
      const existing = await client.query<TemplateRow>(
        `${templateSelect} where template.request_key = $1`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (!createMatches(row, input, principal.reviewerRef)) {
          throw new PolicyIdempotencyConflictError();
        }
        return {
          status: 'duplicate',
          templateRef: row.template_ref,
          versionNumber: row.version_number,
        };
      }
      const version = await client.query<{ readonly value: number }>(
        `select coalesce(max(version_number), 0)::int + 1 as value
         from outbound_template_versions where template_ref = $1`,
        [input.templateRef],
      );
      const versionNumber = version.rows[0]?.value;
      if (versionNumber === undefined) {
        throw new Error('Outbound template version was not resolved');
      }
      await client.query(
        `insert into outbound_template_versions
           (template_ref, version_number, request_key, channel,
            channel_account_id, provider_template_id, template_name, locale,
            category, variable_count, content_sha256, state,
            created_by_account_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,'draft',$11,$12)`,
        [
          input.templateRef,
          versionNumber,
          input.requestKey,
          input.channel,
          input.channelAccountId,
          input.providerTemplateId,
          input.templateName,
          input.locale,
          input.category,
          input.contentSha256,
          accountId,
          input.createdAt,
        ],
      );
      return { status: 'applied', templateRef: input.templateRef, versionNumber };
    });
  }

  public submitVersion(
    input: unknown,
    principal: unknown,
  ): Promise<OutboundTemplateMutationResult> {
    return this.transition('submit', input, principal);
  }

  public approveVersion(
    input: unknown,
    principal: unknown,
  ): Promise<OutboundTemplateMutationResult> {
    return this.transition('approve', input, principal);
  }

  public activateVersion(
    input: unknown,
    principal: unknown,
  ): Promise<OutboundTemplateMutationResult> {
    return this.transition('activate', input, principal);
  }

  public retireVersion(
    input: unknown,
    principal: unknown,
  ): Promise<OutboundTemplateMutationResult> {
    return this.transition('retire', input, principal);
  }

  public async resolveEffectiveTemplate(inputValue: unknown): Promise<EffectiveFixedTemplate> {
    const parsed = resolveSchema.safeParse(inputValue);
    if (!parsed.success) throw new TypeError('Outbound template lookup is invalid');
    const input = parsed.data;
    return withBoundedTransaction(
      this.pool,
      async (client) => {
        const selected = await client.query<TemplateRow>(
          `${templateSelect}
           join lateral (
             select event.action
             from outbound_template_review_events as event
             where event.template_version_id = template.id
               and event.effective_at <= $1
             order by event.effective_at desc, event.id desc
             limit 1
           ) as effective on effective.action = 'activate'
           where template.template_ref = $2
             and template.channel = $3
             and template.channel_account_id = $4
             and template.category = $5
             and template.locale = $6
           order by template.version_number desc`,
          [
            input.evaluatedAt,
            input.templateRef,
            input.channel,
            input.channelAccountId,
            input.category,
            input.locale,
          ],
        );
        if (selected.rows.length === 0) {
          return Object.freeze({
            reasonCode: 'no_active_template' as const,
            status: 'disabled' as const,
          });
        }
        if (selected.rows.length !== 1) {
          throw new Error('Multiple outbound templates are effective');
        }
        const row = selected.rows[0];
        if (row === undefined) throw new Error('Effective outbound template was not resolved');
        return Object.freeze({
          category: row.category,
          channel: row.channel,
          channelAccountId: row.channel_account_id,
          contentSha256: row.content_sha256,
          locale: row.locale,
          providerTemplateId: row.provider_template_id,
          status: 'enabled' as const,
          templateName: row.template_name,
          templateRef: row.template_ref,
          templateVersionId: row.id,
          variableCount: 0 as const,
          versionNumber: row.version_number,
        });
      },
      { isolationLevel: 'repeatable_read' },
    );
  }

  private async transition(
    action: TransitionRow['action'],
    inputValue: unknown,
    principalValue: unknown,
  ): Promise<OutboundTemplateMutationResult> {
    const parsed = transitionSchema.safeParse(inputValue);
    if (!parsed.success) throw new TypeError('Outbound template review input is invalid');
    const input: TransitionInput = parsed.data;
    const principal = requireAdministrator(principalValue);
    if (principal.reviewerRef !== input.reviewerAccountRef) {
      throw new PolicyAuthorizationError('Outbound template actor identity mismatch');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      const reviewerId = await this.requireDatabaseAdministrator(
        client,
        input.reviewerAccountRef,
        input.effectiveAt,
      );
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<TransitionRow>(
        `select event.action, event.effective_at, event.reason_code,
                template.template_ref, template.version_number,
                reviewer.account_ref as reviewer_account_ref
         from outbound_template_review_events as event
         join outbound_template_versions as template
           on template.id = event.template_version_id
         join admin_accounts as reviewer on reviewer.id = event.reviewer_account_id
         where event.request_key = $1`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (
          row.action !== action ||
          row.template_ref !== input.templateRef ||
          row.version_number !== input.versionNumber ||
          row.reason_code !== input.reasonCode ||
          row.reviewer_account_ref !== input.reviewerAccountRef ||
          !sameDate(row.effective_at, input.effectiveAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return {
          status: 'duplicate',
          templateRef: row.template_ref,
          versionNumber: row.version_number,
        };
      }
      const selected = await client.query<{ readonly id: string }>(
        `select id from outbound_template_versions
         where template_ref = $1 and version_number = $2`,
        [input.templateRef, input.versionNumber],
      );
      const templateId = selected.rows[0]?.id;
      if (templateId === undefined) throw new PolicyRecordNotFoundError();
      await client.query(
        `insert into outbound_template_review_events
           (template_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [templateId, action, reviewerId, input.reasonCode, input.requestKey, input.effectiveAt],
      );
      return {
        status: 'applied',
        templateRef: input.templateRef,
        versionNumber: input.versionNumber,
      };
    });
  }

  private async requireDatabaseAdministrator(
    client: pg.PoolClient,
    accountRef: string,
    evaluatedAt: Date,
  ): Promise<string> {
    const selected = await client.query<{ readonly id: string }>(
      `select account.id
       from admin_accounts as account
       where account.account_ref = $1 and account.state = 'active'
         and exists (
           select 1 from lateral (
             select assignment.action
             from admin_role_assignments as assignment
             where assignment.account_id = account.id
               and assignment.role = 'administrator'
               and assignment.effective_at <= $2
             order by assignment.effective_at desc, assignment.id desc
             limit 1
           ) as current where current.action = 'assign'
         )
       for update of account`,
      [accountRef, evaluatedAt],
    );
    const id = selected.rows[0]?.id;
    if (id === undefined) {
      throw new PolicyAuthorizationError(
        'Outbound template administrator identity is not authorized',
      );
    }
    return id;
  }
}
