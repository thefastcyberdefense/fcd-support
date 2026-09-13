import type pg from 'pg';

import { restrictModelOperationalLimits } from '../model/model-config.js';
import {
  parseModelPolicyCreateInput,
  parseModelPolicyTransitionInput,
} from '../model/model-policy-input.js';
import type {
  EffectiveModelPolicy,
  ManifestLimitAttestation,
  ModelPolicyCreateInput,
  ModelPolicyTransitionInput,
  ModelPolicyValues,
  ModelPolicyVersionView,
  ModelPolicyWriteResult,
} from '../model/model-policy-types.js';
import type { ModelDeploymentCeilings } from '../model/model-types.js';
import { PolicyAuthorizationError } from '../policy/reviewer-principal.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

interface PolicyRow {
  readonly activated_at: Date | null;
  readonly approved_at: Date | null;
  readonly approved_by_account_ref: string | null;
  readonly approved_provider_attempts: number;
  readonly architecture_provider_ceiling: number;
  readonly concurrent_calls: number;
  readonly cooldown_ms: number;
  readonly created_at: Date;
  readonly created_by_account_ref: string;
  readonly faq_ambiguity_margin: string;
  readonly faq_minimum_similarity: string;
  readonly global_utc_day_calls: number;
  readonly id: string;
  readonly maximum_faq_candidates: number;
  readonly output_tokens: number;
  readonly per_contact_15_minute_calls: number;
  readonly per_contact_24_hour_calls: number;
  readonly policy_ref: string;
  readonly queue_capacity: number;
  readonly request_key: string;
  readonly retired_at: Date | null;
  readonly state: ModelPolicyVersionView['state'];
  readonly submitted_at: Date | null;
  readonly total_timeout_ms: number;
  readonly version_number: number;
}

interface TransitionRow {
  readonly action: ModelPolicyTransitionInput['action'];
  readonly effective_at: Date;
  readonly policy_ref: string;
  readonly reason_code: string;
  readonly request_key: string;
  readonly reviewer_account_ref: string;
}

const issuedEffectivePolicies = new WeakSet<object>();

export function isIssuedEffectiveModelPolicy(
  input: unknown,
): input is Extract<EffectiveModelPolicy, { readonly status: 'enabled' }> {
  return typeof input === 'object' && input !== null && issuedEffectivePolicies.has(input);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function valuesFromRow(row: PolicyRow): ModelPolicyValues {
  return {
    approvedProviderAttempts: row.approved_provider_attempts,
    architectureProviderCeiling: row.architecture_provider_ceiling,
    concurrentCalls: row.concurrent_calls,
    cooldownMs: row.cooldown_ms,
    faqAmbiguityMargin: Number(row.faq_ambiguity_margin),
    faqMinimumSimilarity: Number(row.faq_minimum_similarity),
    globalUtcDayCalls: row.global_utc_day_calls,
    maximumFaqCandidates: row.maximum_faq_candidates,
    outputTokens: row.output_tokens,
    perContact15MinuteCalls: row.per_contact_15_minute_calls,
    perContact24HourCalls: row.per_contact_24_hour_calls,
    queueCapacity: row.queue_capacity,
    totalTimeoutMs: row.total_timeout_ms,
  };
}

function viewFromRow(row: PolicyRow): ModelPolicyVersionView {
  return {
    createdAt: row.created_at,
    createdByAccountRef: row.created_by_account_ref,
    policyRef: row.policy_ref,
    requestKey: row.request_key,
    state: row.state,
    values: valuesFromRow(row),
    versionNumber: row.version_number,
    ...(row.submitted_at === null ? {} : { submittedAt: row.submitted_at }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.approved_by_account_ref === null
      ? {}
      : { approvedByAccountRef: row.approved_by_account_ref }),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  };
}

function createMatches(row: PolicyRow, input: ModelPolicyCreateInput): boolean {
  return (
    row.policy_ref === input.policyRef &&
    row.request_key === input.requestKey &&
    row.created_by_account_ref === input.createdByAccountRef &&
    sameDate(row.created_at, input.createdAt) &&
    JSON.stringify(valuesFromRow(row)) === JSON.stringify(input.values)
  );
}

function requireAdministrator(principal: ReviewerPrincipal, actorReference: string): void {
  if (!principal.roles.includes('administrator')) {
    throw new PolicyAuthorizationError('Model policy administrator role required');
  }
  if (principal.reviewerRef !== actorReference) {
    throw new PolicyAuthorizationError('Model policy actor identity mismatch');
  }
}

const policySelect = `
  select policy.id, policy.policy_ref, policy.version_number, policy.request_key,
         policy.state, policy.per_contact_15_minute_calls,
         policy.per_contact_24_hour_calls, policy.global_utc_day_calls,
         policy.concurrent_calls, policy.queue_capacity, policy.total_timeout_ms,
         policy.output_tokens, policy.cooldown_ms, policy.faq_minimum_similarity,
         policy.faq_ambiguity_margin, policy.maximum_faq_candidates,
         policy.approved_provider_attempts, policy.architecture_provider_ceiling,
         creator.account_ref as created_by_account_ref,
         approver.account_ref as approved_by_account_ref,
         policy.created_at, policy.submitted_at, policy.approved_at,
         policy.activated_at, policy.retired_at
  from model_policy_versions as policy
  join admin_accounts as creator on creator.id = policy.created_by_account_id
  left join admin_accounts as approver on approver.id = policy.approved_by_account_id`;

export class PostgresModelPolicy {
  public constructor(private readonly pool: TransactionSource) {}

  public async createPolicy(
    inputValue: unknown,
    principal: ReviewerPrincipal,
  ): Promise<ModelPolicyWriteResult> {
    const input = parseModelPolicyCreateInput(inputValue);
    requireAdministrator(principal, input.createdByAccountRef);
    return withBoundedTransaction(this.pool, async (client) => {
      const accountId = await this.requireDatabaseAdministrator(
        client,
        input.createdByAccountRef,
        input.createdAt,
      );
      await client.query(`select pg_advisory_xact_lock(7100415)`);
      const existing = await client.query<PolicyRow>(
        `${policySelect} where policy.request_key = $1`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (!createMatches(row, input)) throw new PolicyIdempotencyConflictError();
        return { policyRef: row.policy_ref, status: 'duplicate' };
      }
      const version = await client.query<{ readonly value: number }>(
        `select coalesce(max(version_number), 0)::int + 1 as value
         from model_policy_versions`,
      );
      const versionNumber = version.rows[0]?.value;
      if (versionNumber === undefined) throw new Error('Model policy version was not resolved');
      const value = input.values;
      await client.query(
        `insert into model_policy_versions
           (policy_ref, version_number, request_key, state,
            per_contact_15_minute_calls, per_contact_24_hour_calls,
            global_utc_day_calls, concurrent_calls, queue_capacity,
            total_timeout_ms, output_tokens, cooldown_ms,
            faq_minimum_similarity, faq_ambiguity_margin,
            maximum_faq_candidates, approved_provider_attempts,
            architecture_provider_ceiling, created_by_account_id, created_at)
         values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          input.policyRef,
          versionNumber,
          input.requestKey,
          value.perContact15MinuteCalls,
          value.perContact24HourCalls,
          value.globalUtcDayCalls,
          value.concurrentCalls,
          value.queueCapacity,
          value.totalTimeoutMs,
          value.outputTokens,
          value.cooldownMs,
          value.faqMinimumSimilarity,
          value.faqAmbiguityMargin,
          value.maximumFaqCandidates,
          value.approvedProviderAttempts,
          value.architectureProviderCeiling,
          accountId,
          input.createdAt,
        ],
      );
      return { policyRef: input.policyRef, status: 'applied' };
    });
  }

  public async transitionPolicy(
    inputValue: unknown,
    principal: ReviewerPrincipal,
  ): Promise<ModelPolicyWriteResult> {
    const input = parseModelPolicyTransitionInput(inputValue);
    requireAdministrator(principal, input.reviewerAccountRef);
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
                event.request_key, policy.policy_ref,
                reviewer.account_ref as reviewer_account_ref
         from model_policy_review_events as event
         join model_policy_versions as policy on policy.id = event.policy_version_id
         join admin_accounts as reviewer on reviewer.id = event.reviewer_account_id
         where event.request_key = $1`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (
          row.action !== input.action ||
          row.policy_ref !== input.policyRef ||
          row.reason_code !== input.reasonCode ||
          row.reviewer_account_ref !== input.reviewerAccountRef ||
          !sameDate(row.effective_at, input.effectiveAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { policyRef: row.policy_ref, status: 'duplicate' };
      }
      const policy = await client.query<{ readonly id: string }>(
        `select id from model_policy_versions where policy_ref = $1`,
        [input.policyRef],
      );
      const policyId = policy.rows[0]?.id;
      if (policyId === undefined) throw new PolicyRecordNotFoundError();
      await client.query(
        `insert into model_policy_review_events
           (policy_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [policyId, input.action, reviewerId, input.reasonCode, input.requestKey, input.effectiveAt],
      );
      return { policyRef: input.policyRef, status: 'applied' };
    });
  }

  public async getPolicy(policyRef: string): Promise<ModelPolicyVersionView> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(policyRef)) {
      throw new TypeError('Model policy reference is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<PolicyRow>(
        `${policySelect} where policy.policy_ref = $1`,
        [policyRef],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new PolicyRecordNotFoundError();
      return viewFromRow(row);
    });
  }

  public async listPolicies(limit = 100): Promise<readonly ModelPolicyVersionView[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('Model policy list limit is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<PolicyRow>(
        `${policySelect} order by policy.version_number desc limit $1`,
        [limit],
      );
      return selected.rows.map(viewFromRow);
    });
  }

  public async resolveEffectivePolicy(
    evaluatedAt: Date,
    deployment: ModelDeploymentCeilings,
    manifest: ManifestLimitAttestation | undefined,
  ): Promise<EffectiveModelPolicy> {
    if (!validDate(evaluatedAt)) throw new TypeError('Model policy evaluation time is invalid');
    if (!manifest?.verified) {
      return Object.freeze({ status: 'disabled', reasonCode: 'manifest_limits_unverified' });
    }
    return withBoundedTransaction(
      this.pool,
      async (client) => {
        const selected = await client.query<PolicyRow>(
          `${policySelect}
           join lateral (
             select event.action
             from model_policy_review_events as event
             where event.policy_version_id = policy.id
               and event.effective_at <= $1
             order by event.effective_at desc, event.id desc
             limit 1
           ) as effective on effective.action = 'activate'
           order by policy.version_number desc`,
          [evaluatedAt],
        );
        if (selected.rows.length === 0) {
          return Object.freeze({ status: 'disabled', reasonCode: 'no_active_policy' });
        }
        if (selected.rows.length !== 1) {
          throw new Error('Multiple model policies are effective');
        }
        const row = selected.rows[0];
        if (row === undefined) throw new Error('Effective model policy was not resolved');
        const values = valuesFromRow(row);
        const policyLimits = {
          concurrentCalls: values.concurrentCalls,
          cooldownMs: values.cooldownMs,
          globalUtcDayCalls: values.globalUtcDayCalls,
          outputTokens: values.outputTokens,
          perContact15MinuteCalls: values.perContact15MinuteCalls,
          perContact24HourCalls: values.perContact24HourCalls,
          providerAttempts: values.approvedProviderAttempts,
          queueCapacity: values.queueCapacity,
          totalTimeoutMs: values.totalTimeoutMs,
        };
        const result = Object.freeze({
          status: 'enabled' as const,
          faq: Object.freeze({
            ambiguityMargin: values.faqAmbiguityMargin,
            maximumCandidates: values.maximumFaqCandidates,
            minimumSimilarity: values.faqMinimumSimilarity,
          }),
          limits: restrictModelOperationalLimits(
            policyLimits,
            deployment,
            manifest.operationalLimits,
          ),
          policyRef: row.policy_ref,
          policyVersionId: row.id,
        });
        issuedEffectivePolicies.add(result);
        return result;
      },
      { isolationLevel: 'repeatable_read' },
    );
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
      throw new PolicyAuthorizationError('Model policy administrator identity is not authorized');
    }
    return id;
  }
}
