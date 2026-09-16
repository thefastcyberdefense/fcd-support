import type pg from 'pg';
import { z } from 'zod';

import {
  parseOutboundPolicyInput,
  resolveOutboundBounds,
} from '../outbound/outbound-policy-input.js';
import type {
  EffectiveOutboundPolicy,
  OutboundDeploymentBounds,
  OutboundPolicyMutationResult,
  OutboundPolicyValues,
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
const createSchema = z.strictObject({
  createdAt: validDate,
  createdByAccountRef: opaqueReference,
  policyRef: opaqueReference,
  requestKey: opaqueReference,
  values: z.unknown(),
});
const transitionSchema = z.strictObject({
  effectiveAt: validDate,
  policyRef: opaqueReference,
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  requestKey: opaqueReference,
  reviewerAccountRef: opaqueReference,
});

interface CreateInput {
  readonly createdAt: Date;
  readonly createdByAccountRef: string;
  readonly policyRef: string;
  readonly requestKey: string;
  readonly values: OutboundPolicyValues;
}

interface TransitionInput {
  readonly effectiveAt: Date;
  readonly policyRef: string;
  readonly reasonCode: string;
  readonly requestKey: string;
  readonly reviewerAccountRef: string;
}

interface PolicyRow {
  readonly activated_at: Date | null;
  readonly approved_by_account_ref: string | null;
  readonly created_at: Date;
  readonly created_by_account_ref: string;
  readonly decided_at: Date | null;
  readonly global_1_minute: number;
  readonly global_utc_day: number;
  readonly id: string;
  readonly lease_ms: number;
  readonly maximum_definite_retries: number;
  readonly messenger_account_1_minute: number;
  readonly per_contact_15_minute: number;
  readonly per_contact_24_hour: number;
  readonly policy_ref: string;
  readonly provider_timeout_ms: number;
  readonly request_key: string;
  readonly retired_at: Date | null;
  readonly retry_base_ms: number;
  readonly retry_maximum_ms: number;
  readonly state: 'active' | 'approved' | 'draft' | 'retired' | 'submitted';
  readonly submitted_at: Date | null;
  readonly version_number: number;
  readonly whatsapp_account_1_minute: number;
  readonly worker_batch_size: number;
}

interface TransitionRow {
  readonly action: 'activate' | 'approve' | 'retire' | 'submit';
  readonly effective_at: Date;
  readonly policy_ref: string;
  readonly reason_code: string;
  readonly reviewer_account_ref: string;
}

const policySelect = `
  select policy.id, policy.policy_ref, policy.version_number, policy.request_key,
         policy.per_contact_15_minute, policy.per_contact_24_hour,
         policy.whatsapp_account_1_minute, policy.messenger_account_1_minute,
         policy.global_1_minute, policy.global_utc_day, policy.worker_batch_size,
         policy.lease_ms, policy.provider_timeout_ms,
         policy.maximum_definite_retries, policy.retry_base_ms,
         policy.retry_maximum_ms, policy.state, policy.created_at,
         policy.submitted_at, policy.decided_at, policy.activated_at,
         policy.retired_at, creator.account_ref as created_by_account_ref,
         approver.account_ref as approved_by_account_ref
  from outbound_policy_versions as policy
  join admin_accounts as creator on creator.id = policy.created_by_account_id
  left join admin_accounts as approver on approver.id = policy.approved_by_account_id`;

const issuedEffectivePolicies = new WeakSet<object>();

export function isIssuedEffectiveOutboundPolicy(
  value: unknown,
): value is Extract<EffectiveOutboundPolicy, { readonly status: 'enabled' }> {
  return typeof value === 'object' && value !== null && issuedEffectivePolicies.has(value);
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function valuesFromRow(row: PolicyRow): OutboundPolicyValues {
  return {
    global1Minute: row.global_1_minute,
    globalUtcDay: row.global_utc_day,
    leaseMs: row.lease_ms,
    maximumDefiniteRetries: row.maximum_definite_retries,
    messengerAccount1Minute: row.messenger_account_1_minute,
    perContact15Minute: row.per_contact_15_minute,
    perContact24Hour: row.per_contact_24_hour,
    providerTimeoutMs: row.provider_timeout_ms,
    retryBaseMs: row.retry_base_ms,
    retryMaximumMs: row.retry_maximum_ms,
    whatsappAccount1Minute: row.whatsapp_account_1_minute,
    workerBatchSize: row.worker_batch_size,
  };
}

function parseCreate(value: unknown): CreateInput {
  const parsed = createSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Outbound policy version input is invalid');
  return { ...parsed.data, values: parseOutboundPolicyInput(parsed.data.values) };
}

function parseTransition(value: unknown): TransitionInput {
  const parsed = transitionSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Outbound policy review input is invalid');
  return parsed.data;
}

function requireAdministrator(principalValue: unknown, actorReference: string): ReviewerPrincipal {
  const principal = principalSchema.parse(principalValue);
  if (!principal.roles.includes('administrator')) {
    throw new PolicyAuthorizationError('Outbound policy administrator role required');
  }
  if (principal.reviewerRef !== actorReference) {
    throw new PolicyAuthorizationError('Outbound policy actor identity mismatch');
  }
  return principal;
}

function createMatches(row: PolicyRow, input: CreateInput): boolean {
  return (
    row.policy_ref === input.policyRef &&
    row.request_key === input.requestKey &&
    row.created_by_account_ref === input.createdByAccountRef &&
    sameDate(row.created_at, input.createdAt) &&
    JSON.stringify(valuesFromRow(row)) === JSON.stringify(input.values)
  );
}

export class PostgresOutboundPolicy {
  public constructor(private readonly pool: TransactionSource) {}

  public async createVersion(
    inputValue: unknown,
    principalValue: unknown,
  ): Promise<OutboundPolicyMutationResult> {
    const input = parseCreate(inputValue);
    requireAdministrator(principalValue, input.createdByAccountRef);
    return withBoundedTransaction(this.pool, async (client) => {
      const accountId = await this.requireDatabaseAdministrator(
        client,
        input.createdByAccountRef,
        input.createdAt,
      );
      await client.query(`select pg_advisory_xact_lock(7100512)`);
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
         from outbound_policy_versions`,
      );
      const versionNumber = version.rows[0]?.value;
      if (versionNumber === undefined) throw new Error('Outbound policy version was not resolved');
      const value = input.values;
      await client.query(
        `insert into outbound_policy_versions
           (policy_ref, version_number, request_key,
            per_contact_15_minute, per_contact_24_hour,
            whatsapp_account_1_minute, messenger_account_1_minute,
            global_1_minute, global_utc_day, worker_batch_size, lease_ms,
            provider_timeout_ms, maximum_definite_retries,
            retry_base_ms, retry_maximum_ms, state,
            created_by_account_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 'draft',$16,$17)`,
        [
          input.policyRef,
          versionNumber,
          input.requestKey,
          value.perContact15Minute,
          value.perContact24Hour,
          value.whatsappAccount1Minute,
          value.messengerAccount1Minute,
          value.global1Minute,
          value.globalUtcDay,
          value.workerBatchSize,
          value.leaseMs,
          value.providerTimeoutMs,
          value.maximumDefiniteRetries,
          value.retryBaseMs,
          value.retryMaximumMs,
          accountId,
          input.createdAt,
        ],
      );
      return { policyRef: input.policyRef, status: 'applied' };
    });
  }

  public submitVersion(input: unknown, principal: unknown): Promise<OutboundPolicyMutationResult> {
    return this.transition('submit', input, principal);
  }

  public approveVersion(input: unknown, principal: unknown): Promise<OutboundPolicyMutationResult> {
    return this.transition('approve', input, principal);
  }

  public activateVersion(
    input: unknown,
    principal: unknown,
  ): Promise<OutboundPolicyMutationResult> {
    return this.transition('activate', input, principal);
  }

  public retireVersion(input: unknown, principal: unknown): Promise<OutboundPolicyMutationResult> {
    return this.transition('retire', input, principal);
  }

  public async resolveEffectivePolicy(
    evaluatedAt: Date,
    deployment: OutboundDeploymentBounds,
  ): Promise<EffectiveOutboundPolicy> {
    if (!(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.getTime())) {
      throw new TypeError('Outbound policy evaluation time is invalid');
    }
    return withBoundedTransaction(
      this.pool,
      async (client) => {
        const selected = await client.query<PolicyRow>(
          `${policySelect}
           join lateral (
             select event.action
             from outbound_policy_review_events as event
             where event.policy_version_id = policy.id
               and event.effective_at <= $1
             order by event.effective_at desc, event.id desc
             limit 1
           ) as effective on effective.action = 'activate'
           order by policy.version_number desc`,
          [evaluatedAt],
        );
        if (selected.rows.length === 0) {
          return Object.freeze({
            reasonCode: 'no_active_policy' as const,
            status: 'disabled' as const,
          });
        }
        if (selected.rows.length !== 1) throw new Error('Multiple outbound policies are effective');
        const row = selected.rows[0];
        if (row === undefined) throw new Error('Effective outbound policy was not resolved');
        const result = Object.freeze({
          policyRef: row.policy_ref,
          policyVersionId: row.id,
          status: 'enabled' as const,
          values: resolveOutboundBounds(valuesFromRow(row), deployment),
        });
        issuedEffectivePolicies.add(result);
        return result;
      },
      { isolationLevel: 'repeatable_read' },
    );
  }

  private async transition(
    action: TransitionRow['action'],
    inputValue: unknown,
    principalValue: unknown,
  ): Promise<OutboundPolicyMutationResult> {
    const input = parseTransition(inputValue);
    requireAdministrator(principalValue, input.reviewerAccountRef);
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
                policy.policy_ref, reviewer.account_ref as reviewer_account_ref
         from outbound_policy_review_events as event
         join outbound_policy_versions as policy on policy.id = event.policy_version_id
         join admin_accounts as reviewer on reviewer.id = event.reviewer_account_id
         where event.request_key = $1`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (
          row.action !== action ||
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
        `select id from outbound_policy_versions where policy_ref = $1`,
        [input.policyRef],
      );
      const policyId = policy.rows[0]?.id;
      if (policyId === undefined) throw new PolicyRecordNotFoundError();
      await client.query(
        `insert into outbound_policy_review_events
           (policy_version_id, action, reviewer_account_id, reason_code,
            request_key, effective_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [policyId, action, reviewerId, input.reasonCode, input.requestKey, input.effectiveAt],
      );
      return { policyRef: input.policyRef, status: 'applied' };
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
        'Outbound policy administrator identity is not authorized',
      );
    }
    return id;
  }
}
