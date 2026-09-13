import { createHash } from 'node:crypto';

import type pg from 'pg';

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
  'cooldown' | 'global_limit' | 'policy_disabled' | 'queue_full' | 'rate_limited';

export interface AcquireModelAllowanceInput {
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
  readonly conversation_id: string;
  readonly created_at: Date;
  readonly logical_call_key: string;
  readonly outcome_code: AllowanceDenial | LeaseOutcome | null;
  readonly policy_version_id: string;
  readonly source_webhook_event_id: string;
  readonly state: LeaseState;
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
    (row.outcome_code === 'cooldown' ||
      row.outcome_code === 'global_limit' ||
      row.outcome_code === 'policy_disabled' ||
      row.outcome_code === 'queue_full' ||
      row.outcome_code === 'rate_limited')
  ) {
    return { status: 'denied', reasonCode: row.outcome_code };
  }
  return { status: 'duplicate', leaseState: row.state };
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
    if (!isIssuedEffectiveModelPolicy(input.effectivePolicy)) {
      throw new TypeError('Model effective policy provenance is invalid');
    }

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      await this.expireInTransaction(client, input.evaluatedAt);

      const existing = await client.query<LeaseRow>(
        `select logical_call_key, source_webhook_event_id, conversation_id,
                policy_version_id, state, outcome_code, created_at
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
          prior.conversation_id !== input.conversationId ||
          prior.policy_version_id !== input.effectivePolicy.policyVersionId ||
          prior.created_at.getTime() !== input.evaluatedAt.getTime()
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
      if (denial !== undefined) {
        await this.insertDeniedLease(client, input, denial);
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
      await client.query(
        `insert into model_call_leases
           (logical_call_key, source_webhook_event_id, conversation_id,
            policy_version_id, state, lease_expires_at, created_at, updated_at,
            activated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
        [
          input.logicalCallKey,
          input.webhookEventId,
          input.conversationId,
          input.effectivePolicy.policyVersionId,
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
                policy_version_id, state, outcome_code, created_at
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
               finished_at = $2, updated_at = $2
           where logical_call_key = $1`,
          [input.logicalCallKey, input.activatedAt],
        );
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
  }): Promise<{ readonly status: 'applied' | 'duplicate' }> {
    requireDate(input.completedAt, 'Model lease completion time');
    requireLogicalKey(input.logicalCallKey);
    if (!completeOutcomes.has(input.outcomeCode) || input.outcomeCode === 'lease_expired') {
      throw new TypeError('Model lease outcome is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      const selected = await client.query<LeaseRow>(
        `select logical_call_key, source_webhook_event_id, conversation_id,
                policy_version_id, state, outcome_code, created_at
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
      await client.query(
        `update model_call_leases
         set state = $2, outcome_code = $3, finished_at = $4, updated_at = $4
         where logical_call_key = $1`,
        [input.logicalCallKey, targetState, input.outcomeCode, input.completedAt],
      );
      return { status: 'applied' };
    });
  }

  public async expireLeases(expiredAt: Date): Promise<{ readonly expiredCount: number }> {
    requireDate(expiredAt, 'Model lease expiry time');
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(7100416)`);
      return { expiredCount: await this.expireInTransaction(client, expiredAt) };
    });
  }

  private async expireInTransaction(client: pg.PoolClient, expiredAt: Date): Promise<number> {
    const expired = await client.query(
      `update model_call_leases
       set state = 'expired', outcome_code = 'lease_expired',
           finished_at = $1, updated_at = $1
       where state in ('active','queued') and lease_expires_at <= $1`,
      [expiredAt],
    );
    return expired.rowCount ?? 0;
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
  ): Promise<void> {
    await client.query(
      `insert into model_call_leases
         (logical_call_key, source_webhook_event_id, conversation_id,
          policy_version_id, state, outcome_code, lease_expires_at,
          created_at, updated_at, finished_at)
       values ($1,$2,$3,$4,'failed',$5,$6,$7,$7,$7)`,
      [
        input.logicalCallKey,
        input.webhookEventId,
        input.conversationId,
        input.effectivePolicy.policyVersionId,
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
