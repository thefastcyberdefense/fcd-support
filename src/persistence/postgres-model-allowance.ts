import { createHash } from 'node:crypto';

import type pg from 'pg';

import { MAX_BUDGET_MICRO_USD, budgetWindowBounds } from '../model/gateway-budget.js';
import type { ModelBudgetWindowKind } from '../model/gateway-types.js';
import type { EffectiveModelPolicy } from '../model/model-policy-types.js';
import { isIssuedEffectiveModelPolicy } from './postgres-model-policy.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

type EnabledModelPolicy = Extract<EffectiveModelPolicy, { readonly status: 'enabled' }>;
type LeaseState = 'active' | 'completed' | 'expired' | 'failed' | 'queued';
type LeaseOutcome =
  | 'aborted'
  | 'completed'
  | 'database_failure'
  | 'guard_blocked'
  | 'invalid_envelope'
  | 'invalid_request'
  | 'lease_expired'
  | 'malformed_body'
  | 'network_failure'
  | 'non_2xx'
  | 'oversized_body'
  | 'provider_exhausted'
  | 'timeout';
type AllowanceDenial =
  | 'budget_exceeded'
  | 'cooldown'
  | 'global_limit'
  | 'policy_disabled'
  | 'queue_full'
  | 'rate_limited';

export interface AcquireModelBudgetInput {
  readonly budgetMicroUsd: number;
  readonly budgetWindowKind: ModelBudgetWindowKind;
  readonly estimatedMaxCostMicroUsd: number;
  readonly gatewayProfileId?: string;
}

export interface CompleteModelLeaseUsageInput {
  readonly actualCostMicroUsd?: number;
  readonly completionTokens: number;
  readonly promptTokens: number;
}

export interface AcquireModelAllowanceInput {
  readonly budget?: AcquireModelBudgetInput;
  readonly conversationId: string;
  readonly effectivePolicy: EnabledModelPolicy;
  readonly evaluatedAt: Date;
  readonly logicalCallKey: string;
  readonly webhookEventId: string;
}

export type ModelAllowanceResult =
  | { readonly leaseState: LeaseState; readonly status: 'duplicate' }
  | { readonly leaseState: 'active' | 'queued'; readonly status: 'acquired' }
  | { readonly reasonCode: AllowanceDenial; readonly status: 'denied' };

interface LeaseRow {
  readonly budget_window_kind: ModelBudgetWindowKind | null;
  readonly budget_window_started_at: Date | null;
  readonly conversation_id: string;
  readonly created_at: Date;
  readonly gateway_profile_id: string | null;
  readonly logical_call_key: string;
  readonly outcome_code: AllowanceDenial | LeaseOutcome | null;
  readonly policy_version_id: string;
  readonly reserved_micro_usd: string;
  readonly source_webhook_event_id: string;
  readonly state: LeaseState;
}

interface ExpiredLeaseDeltaRow {
  readonly budget_window_kind: ModelBudgetWindowKind | null;
  readonly budget_window_started_at: Date | null;
  readonly gateway_profile_id: string | null;
  readonly prior_state: LeaseState;
  readonly reserved_micro_usd: string;
}

interface SourceRow {
  readonly contact_id: string;
}

const logicalKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const decimalIdentifierPattern = /^\d+$/u;
const completeOutcomes = new Set<LeaseOutcome>([
  'aborted',
  'completed',
  'database_failure',
  'guard_blocked',
  'invalid_envelope',
  'invalid_request',
  'lease_expired',
  'malformed_body',
  'network_failure',
  'non_2xx',
  'oversized_body',
  'provider_exhausted',
  'timeout',
]);

function requireDate(value: unknown, label: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid`);
  }
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !decimalIdentifierPattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function requireLogicalKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !logicalKeyPattern.test(value)) {
    throw new TypeError('Model logical call key is invalid');
  }
}

function contactScopeKey(contactId: string): string {
  return createHash('sha256')
    .update('fcd-support\u0000model-usage\u0000', 'utf8')
    .update(contactId, 'utf8')
    .digest('hex');
}

function utcDayWindow(at: Date): readonly [Date, Date] {
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return [new Date(start), new Date(start + 24 * 60 * 60 * 1000)];
}

function existingResult(row: LeaseRow): ModelAllowanceResult {
  if (
    row.state === 'failed' &&
    (row.outcome_code === 'budget_exceeded' ||
      row.outcome_code === 'cooldown' ||
      row.outcome_code === 'global_limit' ||
      row.outcome_code === 'policy_disabled' ||
      row.outcome_code === 'queue_full' ||
      row.outcome_code === 'rate_limited')
  ) {
    return { status: 'denied', reasonCode: row.outcome_code };
  }
  return { status: 'duplicate', leaseState: row.state };
}

function validateBudgetInput(
  budget: AcquireModelBudgetInput | undefined,
): AcquireModelBudgetInput | undefined {
  if (budget === undefined) return undefined;
  const windowKind: unknown = budget.budgetWindowKind;
  if (
    !Number.isSafeInteger(budget.budgetMicroUsd) ||
    budget.budgetMicroUsd < 0 ||
    budget.budgetMicroUsd > MAX_BUDGET_MICRO_USD ||
    (windowKind !== 'utc_day' && windowKind !== 'utc_month') ||
    !Number.isSafeInteger(budget.estimatedMaxCostMicroUsd) ||
    budget.estimatedMaxCostMicroUsd < 0 ||
    budget.estimatedMaxCostMicroUsd > MAX_BUDGET_MICRO_USD
  ) {
    throw new TypeError('Model budget allowance input is invalid');
  }
  if (budget.gatewayProfileId !== undefined) {
    requireIdentifier(budget.gatewayProfileId, 'Model gateway profile identifier');
  } else if (budget.budgetMicroUsd > 0) {
    throw new TypeError('Positive monetary budget requires an active gateway profile');
  }
  return budget;
}

export class PostgresModelAllowance {
  public constructor(private readonly pool: TransactionSource) {}

  public async acquireModelAllowance(
    input: AcquireModelAllowanceInput,
  ): Promise<ModelAllowanceResult> {
    requireIdentifier(input.conversationId, 'Model conversation identifier');
    requireIdentifier(input.webhookEventId, 'Model source event identifier');
    requireLogicalKey(input.logicalCallKey);
    requireDate(input.evaluatedAt, 'Model allowance evaluation time');
    const budget = validateBudgetInput(input.budget);
    if (!isIssuedEffectiveModelPolicy(input.effectivePolicy)) {
      throw new TypeError('Model effective policy provenance is invalid');
    }

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      await this.expireInTransaction(client, input.evaluatedAt);

      const existing = await client.query<LeaseRow>(
        `select logical_call_key, source_webhook_event_id, conversation_id,
                policy_version_id, state, outcome_code, created_at,
                gateway_profile_id::text as gateway_profile_id,
                budget_window_kind, budget_window_started_at,
                reserved_micro_usd::text as reserved_micro_usd
         from model_call_leases
         where logical_call_key = $1 or source_webhook_event_id = $2
         order by id`,
        [input.logicalCallKey, input.webhookEventId],
      );
      if (existing.rows.length > 1) throw new PolicyIdempotencyConflictError();
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (
          prior.logical_call_key !== input.logicalCallKey ||
          prior.source_webhook_event_id !== input.webhookEventId ||
          prior.conversation_id !== input.conversationId
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return existingResult(prior);
      }

      const source = await this.requireAppliedCustomerSource(client, input);
      const policyIsEffective = await this.isOnlyEffectivePolicy(
        client,
        input.effectivePolicy,
        input.evaluatedAt,
      );
      if (!policyIsEffective) {
        await this.insertDeniedLease(client, input, 'policy_disabled');
        return { status: 'denied', reasonCode: 'policy_disabled' };
      }

      const scopeKey = contactScopeKey(source.contact_id);
      const [dayStart] = utcDayWindow(input.evaluatedAt);
      const counts = await client.query<{
        readonly contact_15_minute: number;
        readonly contact_24_hour: number;
        readonly global_utc_day: number;
        readonly last_contact_call_at: Date | null;
      }>(
        `select
           coalesce(sum(call_count) filter (
             where window_kind = 'contact_15_minute' and contact_scope_key = $1
               and window_started_at > $2::timestamptz - interval '15 minutes'
               and window_started_at <= $2::timestamptz
           ), 0)::int as contact_15_minute,
           coalesce(sum(call_count) filter (
             where window_kind = 'contact_24_hour' and contact_scope_key = $1
               and window_started_at > $2::timestamptz - interval '24 hours'
               and window_started_at <= $2::timestamptz
           ), 0)::int as contact_24_hour,
           coalesce(max(call_count) filter (
             where window_kind = 'global_utc_day' and contact_scope_key is null
               and window_started_at = $3
           ), 0)::int as global_utc_day,
           max(updated_at) filter (where contact_scope_key = $1) as last_contact_call_at
         from model_usage_windows`,
        [scopeKey, input.evaluatedAt, dayStart],
      );
      const usage = counts.rows[0];
      if (usage === undefined) throw new Error('Model usage counters were not resolved');
      const limits = input.effectivePolicy.limits;
      let denial: AllowanceDenial | undefined;
      if (
        usage.contact_15_minute >= limits.perContact15MinuteCalls ||
        usage.contact_24_hour >= limits.perContact24HourCalls
      ) {
        denial = 'rate_limited';
      } else if (usage.global_utc_day >= limits.globalUtcDayCalls) {
        denial = 'global_limit';
      } else if (
        limits.cooldownMs > 0 &&
        usage.last_contact_call_at !== null &&
        usage.last_contact_call_at.getTime() + limits.cooldownMs > input.evaluatedAt.getTime()
      ) {
        denial = 'cooldown';
      }

      const capacity = await client.query<{
        readonly active_count: number;
        readonly queued_count: number;
      }>(
        `select
           count(*) filter (where state = 'active')::int as active_count,
           count(*) filter (where state = 'queued')::int as queued_count
         from model_call_leases`,
      );
      const current = capacity.rows[0];
      if (current === undefined) throw new Error('Model lease capacity was not resolved');
      let leaseState: 'active' | 'queued' = 'active';
      if (denial === undefined && current.active_count >= limits.concurrentCalls) {
        if (current.queued_count >= limits.queueCapacity) denial = 'queue_full';
        else leaseState = 'queued';
      }

      const budgetWindow =
        budget?.gatewayProfileId !== undefined
          ? budgetWindowBounds(budget.budgetWindowKind, input.evaluatedAt)
          : undefined;
      if (
        denial === undefined &&
        budget !== undefined &&
        budget.budgetMicroUsd > 0 &&
        budgetWindow !== undefined
      ) {
        const existingWindow = await client.query<{
          readonly reserved_micro_usd: string;
          readonly spent_micro_usd: string;
        }>(
          `select reserved_micro_usd::text as reserved_micro_usd,
                  spent_micro_usd::text as spent_micro_usd
           from model_budget_windows
           where gateway_profile_id = $1 and window_kind = $2 and window_started_at = $3
           for update`,
          [budget.gatewayProfileId, budget.budgetWindowKind, budgetWindow.windowStartedAt],
        );
        const row = existingWindow.rows[0];
        const committed =
          row === undefined ? 0n : BigInt(row.reserved_micro_usd) + BigInt(row.spent_micro_usd);
        if (committed + BigInt(budget.estimatedMaxCostMicroUsd) > BigInt(budget.budgetMicroUsd)) {
          denial = 'budget_exceeded';
        }
      }

      if (denial !== undefined) {
        await this.insertDeniedLease(client, input, denial, budget?.gatewayProfileId);
        return { status: 'denied', reasonCode: denial };
      }

      const shortStart = input.evaluatedAt;
      const shortEnd = new Date(input.evaluatedAt.getTime() + 15 * 60 * 1000);
      const contactDayStart = input.evaluatedAt;
      const contactDayEnd = new Date(input.evaluatedAt.getTime() + 24 * 60 * 60 * 1000);
      const [, dayEnd] = utcDayWindow(input.evaluatedAt);
      await this.incrementWindow(
        client,
        input.effectivePolicy.policyVersionId,
        'contact_15_minute',
        scopeKey,
        shortStart,
        shortEnd,
        input.evaluatedAt,
      );
      await this.incrementWindow(
        client,
        input.effectivePolicy.policyVersionId,
        'contact_24_hour',
        scopeKey,
        contactDayStart,
        contactDayEnd,
        input.evaluatedAt,
      );
      await this.incrementWindow(
        client,
        input.effectivePolicy.policyVersionId,
        'global_utc_day',
        null,
        dayStart,
        dayEnd,
        input.evaluatedAt,
      );
      const reservedMicroUsd =
        budget?.gatewayProfileId !== undefined ? budget.estimatedMaxCostMicroUsd : 0;
      if (budget?.gatewayProfileId !== undefined && budgetWindow !== undefined) {
        await client.query(
          `insert into model_budget_windows
             (gateway_profile_id, window_kind, window_started_at, window_ended_at,
              reserved_micro_usd, spent_micro_usd, created_at, updated_at)
           values ($1,$2,$3,$4,$5,0,$6,$6)
           on conflict (gateway_profile_id, window_kind, window_started_at)
           do update set reserved_micro_usd = model_budget_windows.reserved_micro_usd + excluded.reserved_micro_usd,
                         updated_at = greatest(model_budget_windows.updated_at, excluded.updated_at)`,
          [
            budget.gatewayProfileId,
            budget.budgetWindowKind,
            budgetWindow.windowStartedAt,
            budgetWindow.windowEndedAt,
            reservedMicroUsd,
            input.evaluatedAt,
          ],
        );
      }
      await client.query(
        `insert into model_call_leases
           (logical_call_key, source_webhook_event_id, conversation_id,
            policy_version_id, gateway_profile_id, budget_window_kind,
            budget_window_started_at, reserved_micro_usd,
            state, lease_expires_at, created_at, updated_at, activated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`,
        [
          input.logicalCallKey,
          input.webhookEventId,
          input.conversationId,
          input.effectivePolicy.policyVersionId,
          budget?.gatewayProfileId ?? null,
          budget?.gatewayProfileId !== undefined ? budget.budgetWindowKind : null,
          budgetWindow?.windowStartedAt ?? null,
          reservedMicroUsd,
          leaseState,
          new Date(input.evaluatedAt.getTime() + limits.totalTimeoutMs),
          input.evaluatedAt,
          leaseState === 'active' ? input.evaluatedAt : null,
        ],
      );
      return { status: 'acquired', leaseState };
    });
  }

  public async activateLease(input: {
    readonly activatedAt: Date;
    readonly effectivePolicy: EnabledModelPolicy;
    readonly logicalCallKey: string;
  }): Promise<{ readonly status: 'activated' | 'duplicate' | 'policy_disabled' | 'queued' }> {
    requireDate(input.activatedAt, 'Model lease activation time');
    requireLogicalKey(input.logicalCallKey);
    if (!isIssuedEffectiveModelPolicy(input.effectivePolicy)) {
      throw new TypeError('Model effective policy provenance is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      await this.expireInTransaction(client, input.activatedAt);
      const selected = await client.query<LeaseRow>(
        `select logical_call_key, source_webhook_event_id, conversation_id,
                policy_version_id, state, outcome_code, created_at,
                gateway_profile_id::text as gateway_profile_id,
                budget_window_kind, budget_window_started_at,
                reserved_micro_usd::text as reserved_micro_usd
         from model_call_leases where logical_call_key = $1 for update`,
        [input.logicalCallKey],
      );
      const lease = selected.rows[0];
      if (lease === undefined) throw new PolicyRecordNotFoundError();
      if (lease.policy_version_id !== input.effectivePolicy.policyVersionId) {
        throw new PolicyIdempotencyConflictError();
      }
      if (lease.state === 'active') return { status: 'duplicate' };
      if (lease.state !== 'queued') throw new PolicyIdempotencyConflictError();
      if (!(await this.isOnlyEffectivePolicy(client, input.effectivePolicy, input.activatedAt))) {
        await client.query(
          `update model_call_leases
           set state = 'failed', outcome_code = 'policy_disabled',
               settled_micro_usd = 0, finished_at = $2, updated_at = $2
           where logical_call_key = $1`,
          [input.logicalCallKey, input.activatedAt],
        );
        await this.settleBudgetWindow(client, lease, 0, 0, 0, input.activatedAt);
        return { status: 'policy_disabled' };
      }
      const active = await client.query<{ readonly count: number }>(
        `select count(*)::int as count from model_call_leases where state = 'active'`,
      );
      if ((active.rows[0]?.count ?? 0) >= input.effectivePolicy.limits.concurrentCalls) {
        return { status: 'queued' };
      }
      await client.query(
        `update model_call_leases
         set state = 'active', activated_at = $2, updated_at = $2,
             lease_expires_at = $3
         where logical_call_key = $1`,
        [
          input.logicalCallKey,
          input.activatedAt,
          new Date(input.activatedAt.getTime() + input.effectivePolicy.limits.totalTimeoutMs),
        ],
      );
      return { status: 'activated' };
    });
  }

  public async completeLease(input: {
    readonly completedAt: Date;
    readonly logicalCallKey: string;
    readonly outcomeCode: LeaseOutcome;
    readonly usage?: CompleteModelLeaseUsageInput;
  }): Promise<{ readonly status: 'applied' | 'duplicate' }> {
    requireDate(input.completedAt, 'Model lease completion time');
    requireLogicalKey(input.logicalCallKey);
    if (!completeOutcomes.has(input.outcomeCode) || input.outcomeCode === 'lease_expired') {
      throw new TypeError('Model lease outcome is invalid');
    }
    if (
      input.usage !== undefined &&
      (!Number.isSafeInteger(input.usage.promptTokens) ||
        input.usage.promptTokens < 0 ||
        !Number.isSafeInteger(input.usage.completionTokens) ||
        input.usage.completionTokens < 0 ||
        (input.usage.actualCostMicroUsd !== undefined &&
          (!Number.isSafeInteger(input.usage.actualCostMicroUsd) ||
            input.usage.actualCostMicroUsd < 0 ||
            input.usage.actualCostMicroUsd > MAX_BUDGET_MICRO_USD)))
    ) {
      throw new TypeError('Model lease usage telemetry is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      const selected = await client.query<LeaseRow>(
        `select logical_call_key, source_webhook_event_id, conversation_id,
                policy_version_id, state, outcome_code, created_at,
                gateway_profile_id::text as gateway_profile_id,
                budget_window_kind, budget_window_started_at,
                reserved_micro_usd::text as reserved_micro_usd
         from model_call_leases where logical_call_key = $1 for update`,
        [input.logicalCallKey],
      );
      const lease = selected.rows[0];
      if (lease === undefined) throw new PolicyRecordNotFoundError();
      const targetState = input.outcomeCode === 'completed' ? 'completed' : 'failed';
      if (lease.state === targetState && lease.outcome_code === input.outcomeCode) {
        return { status: 'duplicate' };
      }
      if (lease.state !== 'active') throw new PolicyIdempotencyConflictError();

      const reservedMicroUsd = Number(lease.reserved_micro_usd);
      const preSendRelease =
        input.outcomeCode === 'invalid_request' ||
        input.outcomeCode === 'aborted' ||
        input.outcomeCode === 'network_failure' ||
        input.outcomeCode === 'non_2xx' ||
        input.outcomeCode === 'provider_exhausted';
      const settledMicroUsd =
        lease.gateway_profile_id === null
          ? 0
          : preSendRelease
            ? 0
            : input.usage !== undefined
              ? (input.usage.actualCostMicroUsd ?? reservedMicroUsd)
              : reservedMicroUsd;
      const promptTokens = input.usage?.promptTokens ?? 0;
      const completionTokens = input.usage?.completionTokens ?? 0;

      await client.query(
        `update model_call_leases
         set state = $2, outcome_code = $3, finished_at = $4, updated_at = $4,
             settled_micro_usd = $5, prompt_tokens = $6, completion_tokens = $7
         where logical_call_key = $1`,
        [
          input.logicalCallKey,
          targetState,
          input.outcomeCode,
          input.completedAt,
          settledMicroUsd,
          promptTokens,
          completionTokens,
        ],
      );
      await this.settleBudgetWindow(
        client,
        lease,
        settledMicroUsd,
        promptTokens,
        completionTokens,
        input.completedAt,
      );
      return { status: 'applied' };
    });
  }

  public async expireLeases(
    expiredAt: Date,
    limit?: number,
  ): Promise<{ readonly expiredCount: number }> {
    requireDate(expiredAt, 'Model lease expiry time');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000))
      throw new TypeError('Model lease expiry limit is invalid');
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      if (limit !== undefined) {
        const expired = await client.query<ExpiredLeaseDeltaRow>(
          `with due as (
            select id, state as prior_state, gateway_profile_id, budget_window_kind,
                   budget_window_started_at, reserved_micro_usd
            from model_call_leases
            where state in ('active','queued') and lease_expires_at <= $1
            order by lease_expires_at, logical_call_key limit $2
            for update skip locked
          ),
          updated as (
            update model_call_leases lease
            set state = 'expired', outcome_code = 'lease_expired', finished_at = $1, updated_at = $1,
                settled_micro_usd = case when due.prior_state = 'active' then due.reserved_micro_usd else 0 end
            from due where lease.id = due.id
            returning due.prior_state, due.gateway_profile_id::text as gateway_profile_id,
                      due.budget_window_kind, due.budget_window_started_at,
                      due.reserved_micro_usd::text as reserved_micro_usd
          )
          select prior_state, gateway_profile_id, budget_window_kind,
                 budget_window_started_at, reserved_micro_usd
          from updated`,
          [expiredAt, limit],
        );
        await this.applyExpiredBudgetSettlements(client, expired.rows, expiredAt);
        return { expiredCount: expired.rowCount ?? 0 };
      }
      return { expiredCount: await this.expireInTransaction(client, expiredAt) };
    });
  }

  private async expireInTransaction(client: pg.PoolClient, expiredAt: Date): Promise<number> {
    const expired = await client.query<ExpiredLeaseDeltaRow>(
      `with due as (
        select id, state as prior_state, gateway_profile_id, budget_window_kind,
               budget_window_started_at, reserved_micro_usd
        from model_call_leases
        where state in ('active','queued') and lease_expires_at <= $1
        for update
      ),
      updated as (
        update model_call_leases lease
        set state = 'expired', outcome_code = 'lease_expired', finished_at = $1, updated_at = $1,
            settled_micro_usd = case when due.prior_state = 'active' then due.reserved_micro_usd else 0 end
        from due where lease.id = due.id
        returning due.prior_state, due.gateway_profile_id::text as gateway_profile_id,
                  due.budget_window_kind, due.budget_window_started_at,
                  due.reserved_micro_usd::text as reserved_micro_usd
      )
      select prior_state, gateway_profile_id, budget_window_kind,
             budget_window_started_at, reserved_micro_usd
      from updated`,
      [expiredAt],
    );
    await this.applyExpiredBudgetSettlements(client, expired.rows, expiredAt);
    return expired.rowCount ?? 0;
  }

  private async applyExpiredBudgetSettlements(
    client: pg.PoolClient,
    rows: readonly ExpiredLeaseDeltaRow[],
    expiredAt: Date,
  ): Promise<void> {
    for (const row of rows) {
      const reserved = Number(row.reserved_micro_usd);
      if (
        row.gateway_profile_id === null ||
        row.budget_window_kind === null ||
        row.budget_window_started_at === null ||
        reserved <= 0
      ) {
        continue;
      }
      const spent = row.prior_state === 'active' ? reserved : 0;
      await client.query(
        `update model_budget_windows
         set reserved_micro_usd = greatest(0, reserved_micro_usd - $1),
             spent_micro_usd = spent_micro_usd + $2,
             updated_at = greatest(updated_at, $3)
         where gateway_profile_id = $4 and window_kind = $5 and window_started_at = $6`,
        [
          reserved,
          spent,
          expiredAt,
          row.gateway_profile_id,
          row.budget_window_kind,
          row.budget_window_started_at,
        ],
      );
    }
  }

  private async settleBudgetWindow(
    client: pg.PoolClient,
    lease: LeaseRow,
    settledMicroUsd: number,
    promptTokens: number,
    completionTokens: number,
    updatedAt: Date,
  ): Promise<void> {
    if (
      lease.gateway_profile_id === null ||
      lease.budget_window_kind === null ||
      lease.budget_window_started_at === null
    ) {
      return;
    }
    const bounds = budgetWindowBounds(lease.budget_window_kind, lease.budget_window_started_at);
    await client.query(
      `insert into model_budget_windows
         (gateway_profile_id, window_kind, window_started_at, window_ended_at,
          reserved_micro_usd, spent_micro_usd, input_tokens_total, output_tokens_total,
          created_at, updated_at)
       values ($1,$2,$3,$4,0,$5,$6,$7,$8,$8)
       on conflict (gateway_profile_id, window_kind, window_started_at)
       do update set
         reserved_micro_usd = greatest(0, model_budget_windows.reserved_micro_usd - $9),
         spent_micro_usd = model_budget_windows.spent_micro_usd + excluded.spent_micro_usd,
         input_tokens_total = model_budget_windows.input_tokens_total + excluded.input_tokens_total,
         output_tokens_total = model_budget_windows.output_tokens_total + excluded.output_tokens_total,
         updated_at = greatest(model_budget_windows.updated_at, excluded.updated_at)`,
      [
        lease.gateway_profile_id,
        lease.budget_window_kind,
        lease.budget_window_started_at,
        bounds.windowEndedAt,
        settledMicroUsd,
        promptTokens,
        completionTokens,
        updatedAt,
        Number(lease.reserved_micro_usd),
      ],
    );
  }

  private async requireAppliedCustomerSource(
    client: pg.PoolClient,
    input: AcquireModelAllowanceInput,
  ): Promise<SourceRow> {
    const selected = await client.query<SourceRow>(
      `select identity.contact_id::text as contact_id
       from webhook_events as source
       join webhook_event_applications as application
         on application.webhook_event_id = source.id
       join conversations as conversation on conversation.id = application.conversation_id
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where source.id = $1 and application.conversation_id = $2
         and source.admission_outcome = 'pending'
         and source.event_kind = 'customer_message'
         and application.outcome = 'customer_message_applied'
         and source.occurred_at is not null and source.occurred_at <= $3
       for update of conversation`,
      [input.webhookEventId, input.conversationId, input.evaluatedAt],
    );
    const source = selected.rows[0];
    if (source === undefined) throw new PolicyRecordNotFoundError();
    return source;
  }

  private async isOnlyEffectivePolicy(
    client: pg.PoolClient,
    policy: EnabledModelPolicy,
    evaluatedAt: Date,
  ): Promise<boolean> {
    const selected = await client.query<{ readonly id: string; readonly policy_ref: string }>(
      `select policy.id, policy.policy_ref
       from model_policy_versions as policy
       join lateral (
         select event.action
         from model_policy_review_events as event
         where event.policy_version_id = policy.id and event.effective_at <= $1
         order by event.effective_at desc, event.id desc limit 1
       ) as effective on effective.action = 'activate'
       order by policy.version_number desc`,
      [evaluatedAt],
    );
    if (selected.rows.length !== 1) return false;
    const effective = selected.rows[0];
    return effective?.id === policy.policyVersionId && effective.policy_ref === policy.policyRef;
  }

  private async insertDeniedLease(
    client: pg.PoolClient,
    input: AcquireModelAllowanceInput,
    reasonCode: AllowanceDenial,
    gatewayProfileId?: string,
  ): Promise<void> {
    await client.query(
      `insert into model_call_leases
         (logical_call_key, source_webhook_event_id, conversation_id,
          policy_version_id, gateway_profile_id, state, outcome_code,
          lease_expires_at, created_at, updated_at, finished_at)
       values ($1,$2,$3,$4,$5,'failed',$6,$7,$8,$8,$8)`,
      [
        input.logicalCallKey,
        input.webhookEventId,
        input.conversationId,
        input.effectivePolicy.policyVersionId,
        gatewayProfileId ?? null,
        reasonCode,
        new Date(input.evaluatedAt.getTime() + input.effectivePolicy.limits.totalTimeoutMs),
        input.evaluatedAt,
      ],
    );
  }

  private async incrementWindow(
    client: pg.PoolClient,
    policyVersionId: string,
    kind: 'contact_15_minute' | 'contact_24_hour' | 'global_utc_day',
    scopeKey: string | null,
    startedAt: Date,
    endedAt: Date,
    updatedAt: Date,
  ): Promise<void> {
    await client.query(
      `insert into model_usage_windows
         (policy_version_id, window_kind, contact_scope_key, window_started_at,
          window_ended_at, call_count, expires_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,1,$5,$6,$6)
       on conflict (window_kind, contact_scope_key, window_started_at)
       do update set call_count = model_usage_windows.call_count + 1,
                     updated_at = excluded.updated_at`,
      [policyVersionId, kind, scopeKey, startedAt, endedAt, updatedAt],
    );
  }
}
