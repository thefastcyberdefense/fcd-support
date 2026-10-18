import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import {
  consentCategoryForOutboundPurpose,
  evaluateOutboundEligibility,
  type FixedTemplateEligibilitySource,
  type OutboundEligibility,
  type OutboundEligibilityReason,
  type SupportTextEligibilitySource,
} from '../outbound/outbound-eligibility.js';
import { resolveOutboundBounds } from '../outbound/outbound-policy-input.js';
import {
  MESSENGER_TEXT_MAX_CODE_POINTS,
  WHATSAPP_TEXT_MAX_CODE_POINTS,
} from '../outbound/outbound-request.js';
import type {
  OutboundChannel,
  OutboundDeploymentBounds,
  OutboundMessageKind,
  OutboundPolicyValues,
  OutboundProviderResult,
  OutboundPurpose,
} from '../outbound/outbound-types.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import { resolvePendingMessengerEchoes } from './postgres-outbound-echo-correlation.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';
import { recoveryHeld } from './postgres-runtime-work-common.js';

const opaqueReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));
const claimSchema = z.strictObject({ claimedAt: validDate, workerRef: opaqueReference });
const authorizeSchema = z.strictObject({
  evaluatedAt: validDate,
  intentRef: opaqueReference,
  leaseRef: opaqueReference,
});
const dispatchSchema = z.strictObject({
  attemptRef: opaqueReference,
  leaseRef: opaqueReference,
  startedAt: validDate,
});
const expireSchema = z.strictObject({
  expiredAt: validDate,
  limit: z.number().int().min(1).max(1000),
});
const providerResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    providerMessageId: z.string().trim().min(1).max(512),
    status: z.literal('accepted'),
  }),
  z.strictObject({
    reasonCode: z.enum(['rate_limited', 'provider_rejected']),
    retryAfter: validDate.optional(),
    status: z.literal('definitely_rejected'),
  }),
  z.strictObject({
    reasonCode: z.enum([
      'timeout',
      'network_failure',
      'invalid_response',
      'oversized_response',
      'redirect',
    ]),
    status: z.literal('delivery_unknown'),
  }),
  z.strictObject({ status: z.literal('aborted_before_dispatch') }),
]);
const resultSchema = z.strictObject({
  attemptRef: opaqueReference,
  completedAt: validDate,
  leaseRef: opaqueReference,
  result: providerResultSchema,
});

export interface ClaimedOutboundIntent {
  readonly channel: OutboundChannel;
  readonly intentRef: string;
  readonly leaseExpiresAt: Date;
  readonly leaseRef: string;
  readonly messageKind: OutboundMessageKind;
  readonly purpose: OutboundPurpose;
}

interface OutboundDispatchMaterialBase {
  readonly channelAccountId: string;
  readonly providerTimeoutMs: number;
  readonly recipient: string;
}

export type AuthorizedOutboundDispatchMaterial =
  | (OutboundDispatchMaterialBase & {
      readonly channel: 'messenger' | 'whatsapp';
      readonly messageKind: 'support_text';
      readonly text: string;
    })
  | (OutboundDispatchMaterialBase & {
      readonly channel: 'whatsapp';
      readonly locale: 'bn_BD' | 'en_US';
      readonly messageKind: 'fixed_template';
      readonly templateName: string;
    });

export type AuthorizeAttemptResult =
  | {
      readonly attemptNumber: number;
      readonly attemptRef: string;
      readonly dispatch: AuthorizedOutboundDispatchMaterial;
      readonly status: 'authorized';
    }
  | { readonly attemptNumber: number; readonly attemptRef: string; readonly status: 'duplicate' }
  | {
      readonly reason:
        Exclude<OutboundEligibilityReason, 'allowed'> | 'lease_invalid' | 'limit_exhausted';
      readonly status: 'denied';
    };

export interface DispatchStartResult {
  readonly status: 'duplicate' | 'started';
}

export type RecordProviderResultResult =
  | {
      readonly intentState: 'delivery_unknown' | 'provider_accepted' | 'terminal_failed';
      readonly status: 'duplicate' | 'recorded';
    }
  | {
      readonly intentState: 'pending';
      readonly nextAttemptAt: Date;
      readonly status: 'duplicate' | 'recorded';
    };

export interface ExpireOutboundResult {
  readonly deliveryUnknown: number;
  readonly returnedToPending: number;
}

interface PolicyRow {
  readonly global_1_minute: number;
  readonly global_utc_day: number;
  readonly id: string;
  readonly lease_ms: number;
  readonly maximum_definite_retries: number;
  readonly messenger_account_1_minute: number;
  readonly per_contact_15_minute: number;
  readonly per_contact_24_hour: number;
  readonly provider_timeout_ms: number;
  readonly retry_base_ms: number;
  readonly retry_maximum_ms: number;
  readonly whatsapp_account_1_minute: number;
  readonly worker_batch_size: number;
}

interface EffectivePolicy {
  readonly id: string;
  readonly values: OutboundPolicyValues;
}

interface IntentRow {
  readonly attempt_count: number;
  readonly channel: OutboundChannel;
  readonly channel_account_id: string;
  readonly channel_identity_id: string;
  readonly conversation_id: string;
  readonly id: string;
  readonly intent_ref: string;
  readonly lease_expires_at: Date | null;
  readonly lease_ref: string | null;
  readonly message_kind: OutboundMessageKind;
  readonly next_attempt_at: Date | null;
  readonly purpose: OutboundPurpose;
  readonly reply_draft_id: string | null;
  readonly retention_deadline: Date;
  readonly state: string;
  readonly template_version_id: string | null;
}

interface AuthorityRow {
  readonly ai_paused_until: Date | null;
  readonly channel: OutboundChannel;
  readonly channel_account_id: string;
  readonly contact_id: string;
  readonly conversation_id: string;
  readonly external_contact_id: string;
  readonly identity_id: string;
}

interface RetentionRow {
  readonly expires_at: Date | null;
  readonly lifecycle_class: 'active_client' | 'casual_chat' | 'unconverted_lead';
  readonly next_active_review_at: Date | null;
  readonly relationship_status: 'closed' | 'open' | null;
}

interface SourceRow {
  readonly answer_text: string | null;
  readonly category: OutboundPurpose | null;
  readonly channel: 'whatsapp' | null;
  readonly channel_account_id: string | null;
  readonly erased_at: Date | null;
  readonly locale: 'bn_BD' | 'en_US' | null;
  readonly source_state: string;
  readonly variable_count: number | null;
}

interface AttemptRow {
  readonly attempt_number: number;
  readonly attempt_ref: string;
  readonly dispatch_started_at: Date | null;
  readonly finished_at: Date | null;
  readonly id: string;
  readonly intent_id: string;
  readonly outcome_code: string | null;
  readonly policy_version_id: string;
  readonly provider_message_id: string | null;
  readonly retry_after: Date | null;
  readonly state: string;
}

interface AttemptIntentRow extends AttemptRow, IntentRow {
  readonly intent_state: string;
}

interface RateScope {
  readonly kind:
    | 'contact_15_minute'
    | 'contact_24_hour'
    | 'global_1_minute'
    | 'global_utc_day'
    | 'messenger_account_1_minute'
    | 'whatsapp_account_1_minute';
  readonly limit: number;
  readonly lockKey: string;
  readonly scopeKey: string | null;
  readonly windowEndedAt: Date;
  readonly windowStartedAt: Date;
}

const escalationReasons = new Set([
  'active_review_overdue',
  'consent_missing',
  'content_erased',
  'delivery_unknown',
  'identity_deleted',
  'limit_exhausted',
  'pause_active',
  'policy_unavailable',
  'privacy_hold',
  'retention_expired',
  'retry_exhausted',
  'suppressed',
  'template_invalid',
  'template_required',
  'window_closed',
]);

function policyValues(row: PolicyRow): OutboundPolicyValues {
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

function sameDate(left: Date | null, right: Date | undefined): boolean {
  if (left === null || right === undefined) return left === null && right === undefined;
  return left.getTime() === right.getTime();
}

function minimumDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export class PostgresOutboundWorkStore {
  private readonly deploymentBounds: OutboundDeploymentBounds;
  private readonly privacyKeyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    privacyKeyring: PrivacyHmacKeyring,
    deploymentBounds: OutboundDeploymentBounds,
  ) {
    this.privacyKeyring = requirePrivacyHmacKeyring(privacyKeyring);
    this.deploymentBounds = resolveOutboundBounds(deploymentBounds, deploymentBounds);
  }

  public async claimBatch(inputValue: unknown): Promise<readonly ClaimedOutboundIntent[]> {
    const input = claimSchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      if (await recoveryHeld(client)) return [];
      const policy = await this.loadEffectivePolicy(client, input.claimedAt, true);
      if (policy === null) return [];
      const candidates = await client.query<IntentRow>(
        `select id, intent_ref, conversation_id, channel_identity_id,
                reply_draft_id, template_version_id, channel,
                channel_account_id, purpose, message_kind, state, attempt_count,
                next_attempt_at, lease_ref, lease_expires_at, retention_deadline
         from outbound_intents
         where state = 'pending' and next_attempt_at <= $1
         order by next_attempt_at, id
         for update skip locked
         limit $2`,
        [input.claimedAt, policy.values.workerBatchSize],
      );
      const claimed: ClaimedOutboundIntent[] = [];
      for (const row of candidates.rows) {
        const leaseRef = `LEASE_${randomUUID()}`;
        const leaseExpiresAt = addMilliseconds(input.claimedAt, policy.values.leaseMs);
        await client.query(
          `update outbound_intents
           set state = 'leased', next_attempt_at = null, lease_ref = $2,
               lease_expires_at = $3, updated_at = $4
           where id = $1`,
          [row.id, leaseRef, leaseExpiresAt, input.claimedAt],
        );
        claimed.push(
          Object.freeze({
            channel: row.channel,
            intentRef: row.intent_ref,
            leaseExpiresAt,
            leaseRef,
            messageKind: row.message_kind,
            purpose: row.purpose,
          }),
        );
      }
      return Object.freeze(claimed);
    });
  }

  public async authorizeAttempt(inputValue: unknown): Promise<AuthorizeAttemptResult> {
    const input = authorizeSchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      const intent = await this.lockIntent(client, input.intentRef);
      if (
        intent?.state !== 'leased' ||
        intent.lease_ref !== input.leaseRef ||
        intent.lease_expires_at === null ||
        intent.lease_expires_at.getTime() <= input.evaluatedAt.getTime()
      ) {
        return { reason: 'lease_invalid', status: 'denied' };
      }
      const existing = await client.query<AttemptRow>(
        `select id, intent_id, attempt_number, attempt_ref, policy_version_id,
                state, provider_message_id, outcome_code, retry_after,
                dispatch_started_at, finished_at
         from outbound_attempts
         where intent_id = $1 and state in ('authorized', 'dispatch_started')
         order by attempt_number desc limit 1 for update`,
        [intent.id],
      );
      const existingAttempt = existing.rows[0];
      if (existingAttempt !== undefined) {
        return {
          attemptNumber: existingAttempt.attempt_number,
          attemptRef: existingAttempt.attempt_ref,
          status: 'duplicate',
        };
      }

      const policy = await this.loadEffectivePolicy(client, input.evaluatedAt, true);
      if (policy === null) {
        await this.cancelForEligibility(client, intent, input.evaluatedAt, 'policy_unavailable');
        return { reason: 'policy_unavailable', status: 'denied' };
      }
      const authority = await this.lockAuthority(client, intent);
      const eligibility = await this.evaluateIntent(client, intent, authority, input.evaluatedAt);
      if (!eligibility.eligible) {
        await this.cancelForEligibility(client, intent, input.evaluatedAt, eligibility.reason);
        return { reason: eligibility.reason, status: 'denied' };
      }

      const scopes = this.rateScopes(
        intent,
        authority.contact_id,
        policy.values,
        input.evaluatedAt,
      );
      for (const scope of [...scopes].sort((left, right) =>
        left.lockKey.localeCompare(right.lockKey),
      )) {
        await client.query(
          `select pg_advisory_xact_lock(hashtextextended($1::text, 7100516::bigint))`,
          [scope.lockKey],
        );
      }
      for (const scope of scopes) {
        const used = await this.rateCount(client, scope, input.evaluatedAt);
        if (used >= scope.limit) {
          await this.failForLimit(client, intent, input.evaluatedAt);
          return { reason: 'limit_exhausted', status: 'denied' };
        }
      }
      for (const scope of scopes) {
        await client.query(
          `insert into outbound_rate_windows
             (policy_version_id, window_kind, scope_key, window_started_at,
              window_ended_at, reservation_count, expires_at, created_at, updated_at)
           values ($1,$2,$3,$4,$5,1,$5,$6,$6)
           on conflict (window_kind, scope_key, window_started_at)
           do update set reservation_count = outbound_rate_windows.reservation_count + 1,
                         updated_at = excluded.updated_at`,
          [
            policy.id,
            scope.kind,
            scope.scopeKey,
            scope.windowStartedAt,
            scope.windowEndedAt,
            input.evaluatedAt,
          ],
        );
      }

      const attemptNumberRow = await client.query<{ readonly value: number }>(
        `select coalesce(max(attempt_number), 0)::int + 1 as value
         from outbound_attempts where intent_id = $1`,
        [intent.id],
      );
      const attemptNumber = attemptNumberRow.rows[0]?.value;
      if (attemptNumber === undefined) throw new Error('Outbound attempt number was not resolved');
      const attemptRef = `ATTEMPT_${randomUUID()}`;
      await client.query(
        `insert into outbound_attempts
           (intent_id, attempt_number, attempt_ref, policy_version_id,
            rate_reservation_ref, channel, channel_account_id, state,
            authorized_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,'authorized',$8,$8)`,
        [
          intent.id,
          attemptNumber,
          attemptRef,
          policy.id,
          `RESERVATION_${randomUUID()}`,
          intent.channel,
          intent.channel_account_id,
          input.evaluatedAt,
        ],
      );
      await client.query(
        `update outbound_intents set attempt_count = attempt_count + 1, updated_at = $2
         where id = $1`,
        [intent.id, input.evaluatedAt],
      );
      const dispatch = await this.loadDispatchMaterial(
        client,
        intent,
        authority,
        policy.values.providerTimeoutMs,
      );
      return { attemptNumber, attemptRef, dispatch, status: 'authorized' };
    });
  }

  public async markDispatchStarted(inputValue: unknown): Promise<DispatchStartResult> {
    const input = dispatchSchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      const scope = await client.query<{ readonly conversation_id: string }>(
        `select intent.conversation_id
         from outbound_attempts as attempt
         join outbound_intents as intent on intent.id = attempt.intent_id
         where attempt.attempt_ref = $1`,
        [input.attemptRef],
      );
      const conversationId = scope.rows[0]?.conversation_id;
      if (conversationId === undefined) {
        throw new PolicyRecordNotFoundError('Outbound attempt not found');
      }
      const conversation = await client.query<{ readonly ai_paused_until: Date | null }>(
        `select ai_paused_until from conversations where id = $1 for update`,
        [conversationId],
      );
      const row = await this.lockAttemptAndIntent(client, input.attemptRef);
      if (row === undefined) throw new PolicyRecordNotFoundError('Outbound attempt not found');
      if (row.state === 'dispatch_started') {
        if (
          row.lease_ref !== input.leaseRef ||
          !sameDate(row.dispatch_started_at, input.startedAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { status: 'duplicate' };
      }
      if (
        row.state !== 'authorized' ||
        row.intent_state !== 'leased' ||
        row.lease_ref !== input.leaseRef ||
        row.lease_expires_at === null ||
        row.lease_expires_at.getTime() <= input.startedAt.getTime()
      ) {
        throw new PolicyIdempotencyConflictError();
      }
      if (
        conversation.rows[0]?.ai_paused_until !== null &&
        conversation.rows[0]?.ai_paused_until !== undefined &&
        conversation.rows[0].ai_paused_until.getTime() > input.startedAt.getTime()
      ) {
        throw new PolicyIdempotencyConflictError();
      }
      const openHold = await client.query(
        `select 1 from outbound_echo_correlation_holds
         where conversation_id = $1 and state = 'open'`,
        [row.conversation_id],
      );
      if (openHold.rowCount !== 0) throw new PolicyIdempotencyConflictError();
      const intent = await this.lockIntent(client, row.intent_ref);
      if (intent === undefined) throw new PolicyIdempotencyConflictError();
      const policy = await this.loadEffectivePolicy(client, input.startedAt, true);
      if (policy?.id !== row.policy_version_id) throw new PolicyIdempotencyConflictError();
      const authority = await this.lockAuthority(client, intent);
      if (!(await this.evaluateIntent(client, intent, authority, input.startedAt)).eligible)
        throw new PolicyIdempotencyConflictError();
      await client.query(
        `update outbound_attempts set state = 'dispatch_started', dispatch_started_at = $2
         where id = $1`,
        [row.id, input.startedAt],
      );
      await client.query(`update outbound_intents set updated_at = $2 where id = $1`, [
        row.intent_id,
        input.startedAt,
      ]);
      if (row.channel === 'messenger') {
        await client.query(
          `insert into outbound_echo_correlation_holds
             (hold_ref, conversation_id, attempt_id, state, created_at, expires_at)
           select $1, $2, $3, 'open', $4::timestamptz,
                  $4::timestamptz + policy.provider_timeout_ms * interval '1 millisecond'
           from outbound_policy_versions as policy
           where policy.id = $5`,
          [
            `HOLD_${randomUUID()}`,
            row.conversation_id,
            row.id,
            input.startedAt,
            row.policy_version_id,
          ],
        );
      }
      return { status: 'started' };
    });
  }

  public async recordProviderResult(inputValue: unknown): Promise<RecordProviderResultResult> {
    const input = resultSchema.parse(inputValue) as {
      readonly attemptRef: string;
      readonly completedAt: Date;
      readonly leaseRef: string;
      readonly result: OutboundProviderResult;
    };
    let messengerConversationId: string | undefined;
    const persist = async (client: pg.PoolClient): Promise<RecordProviderResultResult> => {
      const row = await this.lockAttemptAndIntent(client, input.attemptRef);
      if (row === undefined) throw new PolicyRecordNotFoundError('Outbound attempt not found');
      const replay = this.providerReplay(row, input.result, input.completedAt);
      if (replay !== null) {
        if (row.channel === 'messenger' && replay.intentState === 'provider_accepted') {
          messengerConversationId = row.conversation_id;
        }
        return replay;
      }

      if (input.result.status === 'aborted_before_dispatch') {
        if (
          row.state !== 'authorized' ||
          row.intent_state !== 'leased' ||
          row.lease_ref !== input.leaseRef
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        await client.query(
          `update outbound_attempts
           set state = 'abandoned_before_dispatch',
               outcome_code = 'aborted_before_dispatch', finished_at = $2
           where id = $1`,
          [row.id, input.completedAt],
        );
        await this.returnIntentToPending(client, row, input.completedAt, true);
        return {
          intentState: 'pending',
          nextAttemptAt: input.completedAt,
          status: 'recorded',
        };
      }
      if (
        row.state !== 'dispatch_started' ||
        row.intent_state !== 'leased' ||
        row.lease_ref !== input.leaseRef
      ) {
        throw new PolicyIdempotencyConflictError();
      }

      if (input.result.status === 'accepted') {
        await client.query(
          `update outbound_attempts
           set state = 'provider_accepted', provider_message_id = $2,
               outcome_code = 'provider_accepted', provider_accepted_at = $3,
               finished_at = $3 where id = $1`,
          [row.id, input.result.providerMessageId, input.completedAt],
        );
        await client.query(
          `update outbound_intents
           set state = 'provider_accepted', lease_ref = null,
               lease_expires_at = null, updated_at = $2 where id = $1`,
          [row.intent_id, input.completedAt],
        );
        if (row.channel === 'messenger') {
          messengerConversationId = row.conversation_id;
        }
        return { intentState: 'provider_accepted', status: 'recorded' };
      }
      if (input.result.status === 'delivery_unknown') {
        await client.query(
          `update outbound_attempts
           set state = 'delivery_unknown', outcome_code = $2, finished_at = $3
           where id = $1`,
          [row.id, input.result.reasonCode, input.completedAt],
        );
        await this.makeDeliveryUnknown(client, row, input.completedAt);
        return { intentState: 'delivery_unknown', status: 'recorded' };
      }

      const policy = await this.loadPolicyById(client, row.policy_version_id);
      const rejected = await client.query<{ readonly count: number }>(
        `select count(*)::int as count from outbound_attempts
         where intent_id = $1 and state = 'definitely_rejected'`,
        [row.intent_id],
      );
      const rejectionNumber = (rejected.rows[0]?.count ?? 0) + 1;
      if (rejectionNumber <= policy.values.maximumDefiniteRetries) {
        const exponential = Math.min(
          policy.values.retryMaximumMs,
          policy.values.retryBaseMs * 2 ** (rejectionNumber - 1),
        );
        const boundedProviderDelay =
          input.result.retryAfter === undefined
            ? 0
            : Math.max(0, input.result.retryAfter.getTime() - input.completedAt.getTime());
        const delay = Math.min(
          policy.values.retryMaximumMs,
          Math.max(exponential, boundedProviderDelay),
        );
        const retryAt = addMilliseconds(input.completedAt, delay);
        await client.query(
          `update outbound_attempts
           set state = 'definitely_rejected', outcome_code = $2,
               retry_after = $3, finished_at = $4 where id = $1`,
          [row.id, input.result.reasonCode, input.result.retryAfter ?? null, input.completedAt],
        );
        await this.returnIntentToPending(client, row, retryAt, false, input.completedAt);
        return { intentState: 'pending', nextAttemptAt: retryAt, status: 'recorded' };
      }
      await client.query(
        `update outbound_attempts
         set state = 'definitely_rejected', outcome_code = $2,
             retry_after = $3, finished_at = $4 where id = $1`,
        [row.id, input.result.reasonCode, input.result.retryAfter ?? null, input.completedAt],
      );
      await client.query(
        `update outbound_intents
         set state = 'terminal_failed', next_attempt_at = null,
             lease_ref = null, lease_expires_at = null,
             terminal_reason = 'retry_exhausted', updated_at = $2, finished_at = $2
         where id = $1`,
        [row.intent_id, input.completedAt],
      );
      await this.recordEscalation(
        client,
        row.intent_id,
        row.conversation_id,
        'retry_exhausted',
        input.completedAt,
      );
      return { intentState: 'terminal_failed', status: 'recorded' };
    };
    const recorded = await withBoundedTransaction(this.pool, persist);
    if (messengerConversationId !== undefined) {
      const conversationId = messengerConversationId;
      await withBoundedTransaction(this.pool, (client) =>
        resolvePendingMessengerEchoes(client, conversationId),
      );
    }
    return recorded;
  }

  public async expireLeases(inputValue: unknown): Promise<ExpireOutboundResult> {
    const input = expireSchema.parse(inputValue);
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<IntentRow>(
        `select id, intent_ref, conversation_id, channel_identity_id,
                reply_draft_id, template_version_id, channel,
                channel_account_id, purpose, message_kind, state, attempt_count,
                next_attempt_at, lease_ref, lease_expires_at, retention_deadline
         from outbound_intents
         where state = 'leased' and lease_expires_at <= $1
         order by lease_expires_at, id for update skip locked limit $2`,
        [input.expiredAt, input.limit],
      );
      let deliveryUnknown = 0;
      let returnedToPending = 0;
      for (const intent of selected.rows) {
        const attemptQuery = await client.query<AttemptRow>(
          `select id, intent_id, attempt_number, attempt_ref, policy_version_id,
                  state, provider_message_id, outcome_code, retry_after,
                  dispatch_started_at, finished_at
           from outbound_attempts where intent_id = $1
           order by attempt_number desc limit 1 for update`,
          [intent.id],
        );
        const attempt = attemptQuery.rows[0];
        if (attempt?.state === 'dispatch_started') {
          await client.query(
            `update outbound_attempts
             set state = 'delivery_unknown', outcome_code = 'crash_after_dispatch',
                 finished_at = $2 where id = $1`,
            [attempt.id, input.expiredAt],
          );
          await this.makeDeliveryUnknown(
            client,
            { conversation_id: intent.conversation_id, intent_id: intent.id },
            input.expiredAt,
          );
          deliveryUnknown += 1;
          continue;
        }
        if (attempt?.state === 'authorized') {
          await client.query(
            `update outbound_attempts
             set state = 'abandoned_before_dispatch',
                 outcome_code = 'aborted_before_dispatch', finished_at = $2
             where id = $1`,
            [attempt.id, input.expiredAt],
          );
        }
        await this.returnIntentToPending(
          client,
          { attempt_count: intent.attempt_count, intent_id: intent.id },
          input.expiredAt,
          attempt?.state === 'authorized',
        );
        returnedToPending += 1;
      }
      return { deliveryUnknown, returnedToPending };
    });
  }

  private async loadEffectivePolicy(
    client: pg.PoolClient,
    evaluatedAt: Date,
    lock: boolean,
  ): Promise<EffectivePolicy | null> {
    const selected = await client.query<PolicyRow>(
      `select policy.id, policy.per_contact_15_minute, policy.per_contact_24_hour,
              policy.whatsapp_account_1_minute, policy.messenger_account_1_minute,
              policy.global_1_minute, policy.global_utc_day,
              policy.worker_batch_size, policy.lease_ms, policy.provider_timeout_ms,
              policy.maximum_definite_retries, policy.retry_base_ms,
              policy.retry_maximum_ms
       from outbound_policy_versions as policy
       join lateral (
         select event.action from outbound_policy_review_events as event
         where event.policy_version_id = policy.id and event.effective_at <= $1
         order by event.effective_at desc, event.id desc limit 1
       ) as effective on effective.action = 'activate'
       order by policy.version_number desc
       ${lock ? 'for update of policy' : ''}`,
      [evaluatedAt],
    );
    if (selected.rows.length > 1) throw new Error('Multiple outbound policies are effective');
    const row = selected.rows[0];
    return row === undefined
      ? null
      : { id: row.id, values: resolveOutboundBounds(policyValues(row), this.deploymentBounds) };
  }

  private async loadPolicyById(client: pg.PoolClient, policyId: string): Promise<EffectivePolicy> {
    const selected = await client.query<PolicyRow>(
      `select id, per_contact_15_minute, per_contact_24_hour,
              whatsapp_account_1_minute, messenger_account_1_minute,
              global_1_minute, global_utc_day, worker_batch_size, lease_ms,
              provider_timeout_ms, maximum_definite_retries,
              retry_base_ms, retry_maximum_ms
       from outbound_policy_versions where id = $1 for update`,
      [policyId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new PolicyRecordNotFoundError('Outbound policy not found');
    return { id: row.id, values: resolveOutboundBounds(policyValues(row), this.deploymentBounds) };
  }

  private async lockIntent(
    client: pg.PoolClient,
    intentRef: string,
  ): Promise<IntentRow | undefined> {
    const selected = await client.query<IntentRow>(
      `select id, intent_ref, conversation_id, channel_identity_id,
              reply_draft_id, template_version_id, channel,
              channel_account_id, purpose, message_kind, state, attempt_count,
              next_attempt_at, lease_ref, lease_expires_at, retention_deadline
       from outbound_intents where intent_ref = $1 for update`,
      [intentRef],
    );
    return selected.rows[0];
  }

  private async lockAuthority(client: pg.PoolClient, intent: IntentRow): Promise<AuthorityRow> {
    const selected = await client.query<AuthorityRow>(
      `select conversation.id as conversation_id, conversation.ai_paused_until,
              identity.id as identity_id, identity.contact_id,
              identity.channel, identity.channel_account_id,
              identity.external_contact_id
       from conversations as conversation
       join channel_identities as identity on identity.id = conversation.channel_identity_id
       where conversation.id = $1 and identity.id = $2
       for update of conversation, identity`,
      [intent.conversation_id, intent.channel_identity_id],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new PolicyRecordNotFoundError('Outbound authority not found');
    return row;
  }

  private async evaluateIntent(
    client: pg.PoolClient,
    intent: IntentRow,
    authority: AuthorityRow,
    evaluatedAt: Date,
  ): Promise<OutboundEligibility> {
    if (await recoveryHeld(client)) return { eligible: false, reason: 'restore_quarantined' };
    const retention = await client.query<RetentionRow>(
      `select lifecycle_class, relationship_status, expires_at, next_active_review_at
       from conversation_retention_states where conversation_id = $1 for update`,
      [intent.conversation_id],
    );
    const retentionRow = retention.rows[0];
    const activeClientReviewAt =
      retentionRow?.lifecycle_class === 'active_client' &&
      retentionRow.relationship_status === 'open'
        ? retentionRow.next_active_review_at
        : null;
    const currentRetentionDeadline =
      retentionRow?.lifecycle_class === 'active_client' &&
      retentionRow.relationship_status === 'open'
        ? (retentionRow.next_active_review_at ?? evaluatedAt)
        : (retentionRow?.expires_at ?? evaluatedAt);
    const sourceQuery = await client.query<SourceRow>(
      intent.message_kind === 'support_text'
        ? `select draft.state as source_state, draft.erased_at, draft.answer_text,
                  null::text as channel, null::text as channel_account_id,
                  null::text as category, null::text as locale,
                  null::integer as variable_count
           from support_reply_drafts as draft where draft.id = $1 for update`
        : `select template.state as source_state, null::timestamptz as erased_at,
                  null::text as answer_text,
                  template.channel, template.channel_account_id,
                  template.category, template.locale, template.variable_count
           from outbound_template_versions as template where template.id = $1 for update`,
      [intent.reply_draft_id ?? intent.template_version_id],
    );
    const source = sourceQuery.rows[0];
    const latestCustomer = await client.query<{ readonly occurred_at: Date }>(
      `select event.occurred_at
       from webhook_event_applications as application
       join webhook_events as event on event.id = application.webhook_event_id
       where application.conversation_id = $1
         and application.outcome = 'customer_message_applied'
         and event.event_kind = 'customer_message'
         and event.admission_outcome = 'pending' and event.occurred_at <= $2
       order by event.occurred_at desc, event.id desc limit 1
       for share of application, event`,
      [intent.conversation_id, evaluatedAt],
    );
    const hold = await client.query<{ readonly expires_at: Date }>(
      `select expires_at from outbound_echo_correlation_holds
       where conversation_id = $1 and state = 'open' and expires_at > $2
       order by expires_at desc, id desc limit 1 for update`,
      [intent.conversation_id, evaluatedAt],
    );
    const privacy = await client.query<{ readonly open: boolean }>(
      `select exists (
         select 1 from privacy_requests where contact_id = $1
           and request_type in ('access','correction','deletion')
           and state in ('received','awaiting_confirmation','human_review','in_progress')
       ) as open`,
      [authority.contact_id],
    );
    await client.query(
      `select id from privacy_requests where contact_id = $1
         and state in ('received','awaiting_confirmation','human_review','in_progress')
       order by id for update`,
      [authority.contact_id],
    );
    const consentCategory = consentCategoryForOutboundPurpose(intent.purpose);
    const suppression = await this.loadSuppressions(
      client,
      authority,
      evaluatedAt,
      consentCategory,
    );
    const consent =
      consentCategory === null
        ? null
        : await client.query<{ readonly action: 'grant' | 'revoke' }>(
            `select action from consent_events
             where channel_identity_id = $1 and category = $2 and source_at <= $3
             order by source_at desc, id desc limit 1 for share`,
            [authority.identity_id, consentCategory, evaluatedAt],
          );

    const common = {
      activeClientReviewAt,
      channel: intent.channel,
      channelAccountId: intent.channel_account_id,
      echoHoldUntil: hold.rows[0]?.expires_at ?? null,
      evaluatedAt,
      globalSuppressed: suppression.globalSuppressed,
      identityDeleted: suppression.identityDeleted,
      latestConsentAction: consent === null ? null : (consent.rows[0]?.action ?? null),
      lastCustomerMessageAt: latestCustomer.rows[0]?.occurred_at ?? null,
      pauseUntil: authority.ai_paused_until,
      policyAvailable: true,
      privacyHoldOpen: privacy.rows[0]?.open ?? false,
      purpose: intent.purpose,
      retentionDeadline: minimumDate(intent.retention_deadline, currentRetentionDeadline),
      scopedSuppressed: suppression.scopedSuppressed,
    } as const;
    if (intent.message_kind === 'support_text') {
      const supportSource: SupportTextEligibilitySource = {
        contentErased:
          source === undefined || source.source_state === 'erased' || source.erased_at !== null,
        kind: 'support_text',
        ready: source !== undefined,
      };
      const eligibility = evaluateOutboundEligibility({
        ...common,
        requestedLocale: 'en_US',
        source: supportSource,
      });
      if (!eligibility.eligible) return eligibility;
      const maximumCodePoints =
        intent.channel === 'messenger'
          ? MESSENGER_TEXT_MAX_CODE_POINTS
          : WHATSAPP_TEXT_MAX_CODE_POINTS;
      return source?.answer_text !== null &&
        source?.answer_text !== undefined &&
        Array.from(source.answer_text).length <= maximumCodePoints
        ? eligibility
        : { eligible: false, reason: 'template_required' };
    }
    const templateSource: FixedTemplateEligibilitySource = {
      active: source?.source_state === 'active',
      channel: 'whatsapp',
      channelAccountId: source?.channel_account_id ?? '',
      contentErased: false,
      kind: 'fixed_template',
      locale: source?.locale ?? 'en_US',
      purpose: source?.category ?? intent.purpose,
      ready: source !== undefined,
      variableCount: source?.variable_count ?? -1,
    };
    return evaluateOutboundEligibility({
      ...common,
      requestedLocale: templateSource.locale,
      source: templateSource,
    });
  }

  private async loadDispatchMaterial(
    client: pg.PoolClient,
    intent: IntentRow,
    authority: AuthorityRow,
    providerTimeoutMs: number,
  ): Promise<AuthorizedOutboundDispatchMaterial> {
    const common = {
      channelAccountId: intent.channel_account_id,
      providerTimeoutMs,
      recipient: authority.external_contact_id,
    } as const;
    if (intent.message_kind === 'support_text') {
      const selected = await client.query<{ readonly answer_text: string | null }>(
        `select answer_text from support_reply_drafts where id = $1 for update`,
        [intent.reply_draft_id],
      );
      const text = selected.rows[0]?.answer_text;
      if (text === null || text === undefined) {
        throw new Error('Authorized outbound support content is unavailable');
      }
      return Object.freeze({
        ...common,
        channel: intent.channel,
        messageKind: 'support_text',
        text,
      });
    }
    const selected = await client.query<{
      readonly locale: 'bn_BD' | 'en_US';
      readonly template_name: string;
    }>(`select locale, template_name from outbound_template_versions where id = $1 for update`, [
      intent.template_version_id,
    ]);
    const template = selected.rows[0];
    if (template === undefined) throw new Error('Authorized outbound template is unavailable');
    return Object.freeze({
      ...common,
      channel: 'whatsapp',
      locale: template.locale,
      messageKind: 'fixed_template',
      templateName: template.template_name,
    });
  }

  private async loadSuppressions(
    client: pg.PoolClient,
    authority: AuthorityRow,
    evaluatedAt: Date,
    consentCategory: string | null,
  ): Promise<{
    readonly globalSuppressed: boolean;
    readonly identityDeleted: boolean;
    readonly scopedSuppressed: boolean;
  }> {
    const versions: string[] = [];
    const hmacs: string[] = [];
    for (const [version, key] of this.privacyKeyring.keys) {
      versions.push(version);
      hmacs.push(
        createIdentityHmac(
          {
            channel: authority.channel,
            channelAccountId: authority.channel_account_id,
            externalContactId: authority.external_contact_id,
          },
          { key, version },
        ),
      );
    }
    const selected = await client.query<{
      readonly global_suppressed: boolean | null;
      readonly identity_deleted: boolean | null;
      readonly scoped_suppressed: boolean | null;
    }>(
      `select bool_or(category = 'deletion_tombstone') as identity_deleted,
              bool_or(category = 'marketing_opt_out') as global_suppressed,
              bool_or(category = 'marketing_opt_out:' || $5) as scoped_suppressed
       from privacy_suppressions
       where channel = $1 and effective_at <= $2
         and (expires_at is null or expires_at > $2)
         and (key_version, identity_hmac) in (
           select * from unnest($3::text[], $4::text[])
         )`,
      [authority.channel, evaluatedAt, versions, hmacs, consentCategory ?? ''],
    );
    const row = selected.rows[0];
    return {
      globalSuppressed: row?.global_suppressed ?? false,
      identityDeleted: row?.identity_deleted ?? false,
      scopedSuppressed: row?.scoped_suppressed ?? false,
    };
  }

  private rateScopes(
    intent: IntentRow,
    contactId: string,
    policy: OutboundPolicyValues,
    evaluatedAt: Date,
  ): readonly RateScope[] {
    const minuteEnd = addMilliseconds(evaluatedAt, 60_000);
    const utcStart = utcDayStart(evaluatedAt);
    return [
      {
        kind: 'contact_15_minute',
        limit: policy.perContact15Minute,
        lockKey: `contact_15_minute:${contactId}`,
        scopeKey: contactId,
        windowEndedAt: addMilliseconds(evaluatedAt, 15 * 60_000),
        windowStartedAt: evaluatedAt,
      },
      {
        kind: 'contact_24_hour',
        limit: policy.perContact24Hour,
        lockKey: `contact_24_hour:${contactId}`,
        scopeKey: contactId,
        windowEndedAt: addMilliseconds(evaluatedAt, 24 * 60 * 60_000),
        windowStartedAt: evaluatedAt,
      },
      {
        kind:
          intent.channel === 'whatsapp'
            ? 'whatsapp_account_1_minute'
            : 'messenger_account_1_minute',
        limit:
          intent.channel === 'whatsapp'
            ? policy.whatsappAccount1Minute
            : policy.messengerAccount1Minute,
        lockKey: `${intent.channel}_account_1_minute:${intent.channel_account_id}`,
        scopeKey: intent.channel_account_id,
        windowEndedAt: minuteEnd,
        windowStartedAt: evaluatedAt,
      },
      {
        kind: 'global_1_minute',
        limit: policy.global1Minute,
        lockKey: 'global_1_minute:global',
        scopeKey: null,
        windowEndedAt: minuteEnd,
        windowStartedAt: evaluatedAt,
      },
      {
        kind: 'global_utc_day',
        limit: policy.globalUtcDay,
        lockKey: 'global_utc_day:global',
        scopeKey: null,
        windowEndedAt: addMilliseconds(utcStart, 24 * 60 * 60_000),
        windowStartedAt: utcStart,
      },
    ];
  }

  private async rateCount(
    client: pg.PoolClient,
    scope: RateScope,
    evaluatedAt: Date,
  ): Promise<number> {
    const duration = scope.windowEndedAt.getTime() - scope.windowStartedAt.getTime();
    const lowerBound = addMilliseconds(evaluatedAt, -duration);
    const selected = await client.query<{ readonly count: number }>(
      scope.kind === 'global_utc_day'
        ? `select coalesce(sum(reservation_count),0)::int as count
           from outbound_rate_windows
           where window_kind = $1 and scope_key is null and window_started_at = $2`
        : `select coalesce(sum(reservation_count),0)::int as count
           from outbound_rate_windows
           where window_kind = $1 and scope_key is not distinct from $2
             and window_started_at > $3 and window_started_at <= $4`,
      scope.kind === 'global_utc_day'
        ? [scope.kind, scope.windowStartedAt]
        : [scope.kind, scope.scopeKey, lowerBound, evaluatedAt],
    );
    return selected.rows[0]?.count ?? 0;
  }

  private async failForLimit(
    client: pg.PoolClient,
    intent: IntentRow,
    evaluatedAt: Date,
  ): Promise<void> {
    await client.query(
      `update outbound_intents
       set state = 'terminal_failed', next_attempt_at = null,
           lease_ref = null, lease_expires_at = null,
           terminal_reason = 'limit_exhausted', updated_at = $2, finished_at = $2
       where id = $1`,
      [intent.id, evaluatedAt],
    );
    await this.recordEscalation(
      client,
      intent.id,
      intent.conversation_id,
      'limit_exhausted',
      evaluatedAt,
    );
  }

  private async cancelForEligibility(
    client: pg.PoolClient,
    intent: IntentRow,
    evaluatedAt: Date,
    reason: Exclude<OutboundEligibilityReason, 'allowed'>,
  ): Promise<void> {
    const terminalReason = reason === 'source_not_ready' ? 'content_erased' : reason;
    await client.query(
      `update outbound_intents
       set state = 'canceled', next_attempt_at = null,
           lease_ref = null, lease_expires_at = null,
           terminal_reason = $2, updated_at = $3, finished_at = $3
       where id = $1`,
      [intent.id, terminalReason, evaluatedAt],
    );
    await this.recordEscalation(
      client,
      intent.id,
      intent.conversation_id,
      terminalReason,
      evaluatedAt,
    );
  }

  private async lockAttemptAndIntent(
    client: pg.PoolClient,
    attemptRef: string,
  ): Promise<AttemptIntentRow | undefined> {
    const selected = await client.query<AttemptIntentRow>(
      `select attempt.id, attempt.intent_id, attempt.attempt_number,
              attempt.attempt_ref, attempt.policy_version_id,
              attempt.state, attempt.provider_message_id, attempt.outcome_code,
              attempt.retry_after, attempt.dispatch_started_at, attempt.finished_at,
              intent.intent_ref, intent.conversation_id, intent.channel_identity_id,
              intent.reply_draft_id, intent.template_version_id, intent.channel,
              intent.channel_account_id, intent.purpose, intent.message_kind,
              intent.attempt_count, intent.next_attempt_at, intent.lease_ref,
              intent.lease_expires_at, intent.retention_deadline,
              intent.state as intent_state
       from outbound_attempts as attempt
       join outbound_intents as intent on intent.id = attempt.intent_id
       where attempt.attempt_ref = $1 for update of attempt, intent`,
      [attemptRef],
    );
    return selected.rows[0];
  }

  private providerReplay(
    row: AttemptIntentRow,
    result: OutboundProviderResult,
    completedAt: Date,
  ): RecordProviderResultResult | null {
    if (
      ![
        'provider_accepted',
        'definitely_rejected',
        'delivery_unknown',
        'abandoned_before_dispatch',
      ].includes(row.state)
    ) {
      return null;
    }
    const materialMatches =
      sameDate(row.finished_at, completedAt) &&
      ((result.status === 'accepted' &&
        row.state === 'provider_accepted' &&
        row.provider_message_id === result.providerMessageId) ||
        (result.status === 'definitely_rejected' &&
          row.state === 'definitely_rejected' &&
          row.outcome_code === result.reasonCode &&
          (result.retryAfter === undefined || sameDate(row.retry_after, result.retryAfter))) ||
        (result.status === 'delivery_unknown' &&
          row.state === 'delivery_unknown' &&
          row.outcome_code === result.reasonCode) ||
        (result.status === 'aborted_before_dispatch' && row.state === 'abandoned_before_dispatch'));
    if (!materialMatches) throw new PolicyIdempotencyConflictError();
    if (row.intent_state === 'pending') {
      const nextAttemptAt = row.next_attempt_at;
      if (nextAttemptAt === null) throw new Error('Pending outbound intent lacks retry time');
      return { intentState: 'pending', nextAttemptAt, status: 'duplicate' };
    }
    if (
      row.intent_state !== 'provider_accepted' &&
      row.intent_state !== 'delivery_unknown' &&
      row.intent_state !== 'terminal_failed'
    ) {
      throw new PolicyIdempotencyConflictError();
    }
    return { intentState: row.intent_state, status: 'duplicate' };
  }

  private async returnIntentToPending(
    client: pg.PoolClient,
    row: { readonly attempt_count: number; readonly intent_id: string },
    nextAttemptAt: Date,
    decrementAttempt: boolean,
    updatedAt: Date = nextAttemptAt,
  ): Promise<void> {
    await client.query(
      `update outbound_intents
       set state = 'pending', attempt_count = $2, next_attempt_at = $3,
           lease_ref = null, lease_expires_at = null, updated_at = $4
       where id = $1`,
      [
        row.intent_id,
        decrementAttempt ? Math.max(0, row.attempt_count - 1) : row.attempt_count,
        nextAttemptAt,
        updatedAt,
      ],
    );
  }

  private async makeDeliveryUnknown(
    client: pg.PoolClient,
    row: { readonly conversation_id: string; readonly intent_id: string },
    completedAt: Date,
  ): Promise<void> {
    await client.query(
      `update outbound_intents
       set state = 'delivery_unknown', next_attempt_at = null,
           lease_ref = null, lease_expires_at = null,
           terminal_reason = 'delivery_unknown', updated_at = $2, finished_at = $2
       where id = $1`,
      [row.intent_id, completedAt],
    );
    await this.recordEscalation(
      client,
      row.intent_id,
      row.conversation_id,
      'delivery_unknown',
      completedAt,
    );
  }

  private async recordEscalation(
    client: pg.PoolClient,
    intentId: string,
    conversationId: string,
    reason: string,
    createdAt: Date,
  ): Promise<void> {
    if (!escalationReasons.has(reason)) return;
    const digest = createHash('sha256').update(`${intentId}:${reason}`).digest('hex');
    await client.query(
      `insert into outbound_escalation_outcomes
         (escalation_ref, intent_id, conversation_id, reason_code, state,
          request_key, created_at, updated_at)
       values ($1,$2,$3,$4,'open',$5,$6,$6)
       on conflict (request_key) do nothing`,
      [
        `ESCALATION_${digest}`,
        intentId,
        conversationId,
        reason,
        `OUTBOUND_WORK_${digest}`,
        createdAt,
      ],
    );
  }
}
