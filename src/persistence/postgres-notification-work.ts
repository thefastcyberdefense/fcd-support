import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type {
  N8nResult,
  NotificationClaim,
  NotificationRetryPolicy,
  NotificationType,
} from '../notifications/notification-types.js';
import {
  parseWork,
  quarantinePresent,
  recoveryHeld,
  workClaimSchema,
  workConflict,
  workDate,
  workReference,
} from './postgres-runtime-work-common.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const policySchema = z
  .strictObject({
    maximumAttempts: z.number().int().min(1).max(100),
    retryBaseMilliseconds: z.number().int().min(100).max(86400000),
    retryMaximumMilliseconds: z.number().int().min(100).max(604800000),
  })
  .refine((value) => value.retryBaseMilliseconds <= value.retryMaximumMilliseconds);
const failureReason = z.enum([
  'timeout',
  'transport_failure',
  'invalid_response',
  'authentication_failed',
  'destination_rejected',
  'retry_exhausted',
]);
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), reasonCode: z.literal('ok') }),
  z.strictObject({ status: z.literal('retryable'), reasonCode: failureReason }),
  z.strictObject({ status: z.literal('terminal_failed'), reasonCode: failureReason }),
]);
const finishSchema = z.strictObject({
  workRef: workReference,
  leaseRef: workReference,
  evaluatedAt: workDate,
  result: resultSchema,
});
interface SourceRow {
  readonly source_kind: 'privacy' | 'support' | 'outbound';
  readonly source_id: string;
  readonly notification_type: NotificationType;
  readonly occurred_at: Date;
  readonly retention_deadline: Date;
}
interface WorkRow {
  readonly id: string;
  readonly work_ref: string;
  readonly notification_type: NotificationType;
  readonly occurred_at: Date;
  readonly idempotency_key: string;
  readonly retention_deadline: Date;
  readonly attempt_count: number;
  readonly state: 'pending' | 'leased' | 'delivered' | 'failed' | 'quarantined';
  readonly lease_ref: string | null;
  readonly lease_expires_at: Date | null;
  readonly privacy_notification_intent_id: string | null;
}

export class PostgresNotificationWork {
  private readonly policy: NotificationRetryPolicy;
  public constructor(
    private readonly pool: TransactionSource,
    policy: NotificationRetryPolicy,
  ) {
    this.policy = Object.freeze(parseWork(policySchema, policy));
  }

  public async reconcile(limit: number, evaluatedAt: Date): Promise<{ readonly created: number }> {
    parseWork(z.number().int().min(1).max(1000), limit);
    parseWork(workDate, evaluatedAt);
    return withBoundedTransaction(this.pool, async (client) => {
      if (await recoveryHeld(client)) return { created: 0 };
      const quarantine = await quarantinePresent(client);
      const sources = await client.query<SourceRow>(
        `select source.* from notification_delivery_sources source
        where source.retention_deadline > $1 and source.occurred_at <= $1
          and not exists(select 1 from notification_delivery_work work where
            (source.source_kind='privacy' and work.privacy_notification_intent_id=source.source_id)
            or (source.source_kind='support' and work.support_escalation_id=source.source_id)
            or (source.source_kind='outbound' and work.outbound_escalation_id=source.source_id))
          ${
            quarantine
              ? `and not exists(select 1 from runtime_restore_quarantine q
            where q.source_id=source.source_id and q.source_kind=case source.source_kind
              when 'privacy' then 'privacy_notification' when 'support' then 'support_escalation'
              else 'outbound_escalation' end)`
              : ''
          }
        order by occurred_at,source_kind,source_id limit $2`,
        [evaluatedAt, limit],
      );
      let created = 0;
      for (const source of sources.rows) {
        const workRef = `NOTIFICATION_${randomUUID()}`;
        const inserted = await client.query(
          `insert into notification_delivery_work
          (work_ref,source_kind,privacy_notification_intent_id,support_escalation_id,outbound_escalation_id,
           notification_type,idempotency_key,state,occurred_at,retention_deadline,next_attempt_at,
           attempt_count,created_at,updated_at)
          values ($1,$2,$3,$4,$5,$6,$1,'pending',$7,$8,$9,0,$9,$9) on conflict do nothing`,
          [
            workRef,
            source.source_kind,
            source.source_kind === 'privacy' ? source.source_id : null,
            source.source_kind === 'support' ? source.source_id : null,
            source.source_kind === 'outbound' ? source.source_id : null,
            source.notification_type,
            source.occurred_at,
            source.retention_deadline,
            evaluatedAt,
          ],
        );
        created += inserted.rowCount ?? 0;
      }
      return { created };
    });
  }

  public async claim(
    input: z.infer<typeof workClaimSchema>,
  ): Promise<readonly NotificationClaim[]> {
    const command = parseWork(workClaimSchema, input);
    return withBoundedTransaction(this.pool, async (client) => {
      if (await recoveryHeld(client)) return [];
      const quarantine = await quarantinePresent(client);
      const selected = await client.query<WorkRow>(
        `select work.* from notification_delivery_work work
        join notification_delivery_sources source on source.source_kind=work.source_kind
          and source.source_id=coalesce(work.privacy_notification_intent_id,work.support_escalation_id,work.outbound_escalation_id)
        where work.state='pending' and work.next_attempt_at <= $1
          and work.retention_deadline > $1 and source.retention_deadline > $1
          and work.attempt_count < $3
          ${
            quarantine
              ? `and not exists(select 1 from runtime_restore_quarantine q where
            (q.source_kind='notification_work' and q.source_id=work.id)
            or (q.source_id=source.source_id and q.source_kind=case source.source_kind
              when 'privacy' then 'privacy_notification' when 'support' then 'support_escalation'
              else 'outbound_escalation' end))`
              : ''
          }
        order by work.next_attempt_at,work.id limit $2 for update of work skip locked`,
        [command.evaluatedAt, command.limit, this.policy.maximumAttempts],
      );
      const claims: NotificationClaim[] = [];
      for (const row of selected.rows) {
        const leaseRef = `LEASE_${randomUUID()}`;
        await client.query(
          `update notification_delivery_work set state='leased',lease_ref=$2,
          lease_expires_at=$3,worker_ref=$4,attempt_count=attempt_count+1,next_attempt_at=null,updated_at=$5 where id=$1`,
          [
            row.id,
            leaseRef,
            new Date(command.evaluatedAt.getTime() + command.leaseMilliseconds),
            command.workerRef,
            command.evaluatedAt,
          ],
        );
        claims.push(
          Object.freeze({
            workRef: row.work_ref,
            leaseRef,
            attemptNumber: row.attempt_count + 1,
            notification: Object.freeze({
              schemaVersion: 1 as const,
              type: row.notification_type,
              reference: row.work_ref,
              occurredAt: row.occurred_at,
              idempotencyKey: row.idempotency_key,
            }),
          }),
        );
      }
      return claims;
    });
  }

  public async finish(input: {
    readonly workRef: string;
    readonly leaseRef: string;
    readonly evaluatedAt: Date;
    readonly result: N8nResult;
  }): Promise<void> {
    const command = parseWork(finishSchema, input);
    await withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<WorkRow>(
        `select * from notification_delivery_work where work_ref=$1 for update`,
        [command.workRef],
      );
      const row = selected.rows[0];
      if (row === undefined) workConflict();
      const prior = await client.query<{
        status: N8nResult['status'];
        reason_code: N8nResult['reasonCode'];
        completed_at: Date;
      }>(
        `select status,reason_code,completed_at from notification_delivery_attempts where work_id=$1 and lease_ref=$2`,
        [row.id, command.leaseRef],
      );
      if (prior.rows[0] !== undefined) {
        const attempt = prior.rows[0];
        if (
          attempt.status !== command.result.status ||
          attempt.reason_code !== command.result.reasonCode ||
          attempt.completed_at.getTime() !== command.evaluatedAt.getTime()
        )
          workConflict();
        return;
      }
      if (
        row.state !== 'leased' ||
        row.lease_ref !== command.leaseRef ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= command.evaluatedAt
      )
        workConflict();
      await this.recordResult(client, row, command.leaseRef, command.evaluatedAt, command.result);
    });
  }

  /** Recheck authoritative eligibility after claiming, immediately before a bounded send. */
  public async authorize(input: {
    readonly workRef: string;
    readonly leaseRef: string;
    readonly evaluatedAt: Date;
    readonly requiredLeaseMilliseconds: number;
  }): Promise<boolean> {
    const command = parseWork(
      z.strictObject({
        workRef: workReference,
        leaseRef: workReference,
        evaluatedAt: workDate,
        requiredLeaseMilliseconds: z.number().int().min(1).max(300000),
      }),
      input,
    );
    const through = new Date(command.evaluatedAt.getTime() + command.requiredLeaseMilliseconds);
    return withBoundedTransaction(this.pool, async (client) => {
      if (await recoveryHeld(client)) return false;
      const quarantine = await quarantinePresent(client);
      const result = await client.query<{ authorized: boolean }>(
        `select true as authorized from notification_delivery_work work
        join notification_delivery_sources source on source.source_kind=work.source_kind
          and source.source_id=coalesce(work.privacy_notification_intent_id,work.support_escalation_id,work.outbound_escalation_id)
        where work.work_ref=$1 and work.lease_ref=$2 and work.state='leased'
          and work.lease_expires_at > $4 and work.retention_deadline > $4
          and source.retention_deadline > $4 and source.occurred_at <= $3
          and source.notification_type=work.notification_type
          and source.occurred_at=work.occurred_at and work.attempt_count <= $5
          ${
            quarantine
              ? `and not exists(select 1 from runtime_restore_quarantine q where
            (q.source_kind='notification_work' and q.source_id=work.id)
            or (q.source_id=source.source_id and q.source_kind=case source.source_kind
              when 'privacy' then 'privacy_notification' when 'support' then 'support_escalation'
              else 'outbound_escalation' end))`
              : ''
          }
        for update of work`,
        [
          command.workRef,
          command.leaseRef,
          command.evaluatedAt,
          through,
          this.policy.maximumAttempts,
        ],
      );
      return result.rows[0]?.authorized === true;
    });
  }

  public async expire(input: {
    readonly evaluatedAt: Date;
    readonly limit: number;
  }): Promise<{ readonly expired: number }> {
    const command = parseWork(
      z.strictObject({ evaluatedAt: workDate, limit: z.number().int().min(1).max(1000) }),
      input,
    );
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<WorkRow & { source_eligible: boolean }>(
        `select work.*, exists(select 1 from notification_delivery_sources source
          where source.source_kind=work.source_kind
            and source.source_id=coalesce(work.privacy_notification_intent_id,work.support_escalation_id,work.outbound_escalation_id)
            and source.retention_deadline > $1) as source_eligible
        from notification_delivery_work work
        where (state='leased' and lease_expires_at <= $1)
          or (state='pending' and (work.retention_deadline <= $1 or attempt_count >= $3
            or not exists(select 1 from notification_delivery_sources source
              where source.source_kind=work.source_kind
                and source.source_id=coalesce(work.privacy_notification_intent_id,work.support_escalation_id,work.outbound_escalation_id)
                and source.retention_deadline > $1)))
        order by work.id limit $2 for update of work skip locked`,
        [command.evaluatedAt, command.limit, this.policy.maximumAttempts],
      );
      for (const row of selected.rows) {
        if (row.state === 'pending') {
          await client.query(
            `update notification_delivery_work set state='failed',reason_code=$2,
            next_attempt_at=null,updated_at=$3 where id=$1`,
            [
              row.id,
              row.retention_deadline <= command.evaluatedAt
                ? 'retention_expired'
                : row.source_eligible
                  ? 'retry_exhausted'
                  : 'source_unavailable',
              command.evaluatedAt,
            ],
          );
          continue;
        }
        if (row.lease_ref === null) workConflict();
        await this.recordResult(client, row, row.lease_ref, command.evaluatedAt, {
          status: row.source_eligible ? 'retryable' : 'terminal_failed',
          reasonCode: row.source_eligible ? 'timeout' : 'destination_rejected',
        });
      }
      return { expired: selected.rows.length };
    });
  }

  private async recordResult(
    client: import('pg').PoolClient,
    row: WorkRow,
    leaseRef: string,
    evaluatedAt: Date,
    result: N8nResult,
  ): Promise<void> {
    await client.query(
      `insert into notification_delivery_attempts
      (work_id,attempt_number,lease_ref,completed_at,status,reason_code) values ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.attempt_count, leaseRef, evaluatedAt, result.status, result.reasonCode],
    );
    const retentionExpired = row.retention_deadline <= evaluatedAt;
    const retry =
      result.status === 'retryable' &&
      !retentionExpired &&
      row.attempt_count < this.policy.maximumAttempts;
    const delay = Math.min(
      this.policy.retryMaximumMilliseconds,
      this.policy.retryBaseMilliseconds * 2 ** Math.min(row.attempt_count - 1, 53),
    );
    const state = result.status === 'accepted' ? 'delivered' : retry ? 'pending' : 'failed';
    const reason =
      result.status !== 'accepted' && retentionExpired
        ? 'retention_expired'
        : result.status === 'retryable' && !retry
          ? 'retry_exhausted'
          : result.reasonCode;
    await client.query(
      `update notification_delivery_work set state=$2,reason_code=$3,next_attempt_at=$4,
      lease_ref=null,worker_ref=null,lease_expires_at=null,updated_at=$5 where id=$1`,
      [row.id, state, reason, retry ? new Date(evaluatedAt.getTime() + delay) : null, evaluatedAt],
    );
    if (row.privacy_notification_intent_id !== null) {
      await client.query(
        `update privacy_notification_intents set state=$2,attempt_count=attempt_count+1,
        updated_at=greatest(updated_at,$3) where id=$1`,
        [
          row.privacy_notification_intent_id,
          result.status === 'accepted' ? 'delivered' : 'failed',
          evaluatedAt,
        ],
      );
    }
  }
}
