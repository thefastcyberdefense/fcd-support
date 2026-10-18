import { randomUUID } from 'node:crypto';

import { z } from 'zod';

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

const stageSchema = z.enum(['apply', 'decide', 'model', 'enqueue']);
const commandSchema = z.strictObject({
  workRef: workReference,
  leaseRef: workReference,
  evaluatedAt: workDate,
});
const advanceSchema = commandSchema.extend({ stage: stageSchema });
const finishSchema = commandSchema.extend({ outcome: z.enum(['completed', 'blocked', 'failed']) });
export interface ProcessingClaim {
  readonly workRef: string;
  readonly webhookEventId: string;
  readonly leaseRef: string;
  readonly stage: z.infer<typeof stageSchema>;
}
interface WorkRow {
  readonly id: string;
  readonly work_ref: string;
  readonly webhook_event_id: string;
  readonly stage: ProcessingClaim['stage'];
  readonly state: 'pending' | 'leased' | 'completed' | 'blocked' | 'failed' | 'quarantined';
  readonly lease_ref: string | null;
  readonly lease_expires_at: Date | null;
  readonly finished_lease_ref: string | null;
  readonly finished_at: Date | null;
}
export class PostgresProcessingWork {
  public constructor(private readonly pool: TransactionSource) {}

  public async reconcile(limit: number, evaluatedAt: Date): Promise<{ readonly created: number }> {
    parseWork(z.number().int().min(1).max(1000), limit);
    parseWork(workDate, evaluatedAt);
    return withBoundedTransaction(this.pool, async (client) => {
      if (await recoveryHeld(client)) return { created: 0 };
      const quarantine = await quarantinePresent(client);
      const candidates = await client.query<{ id: string; stage: ProcessingClaim['stage'] }>(
        `
        select event.id, case when application.outcome='customer_message_applied' then 'decide' else 'apply' end as stage
        from webhook_events event
        left join webhook_event_applications application on application.webhook_event_id=event.id
        where event.admission_outcome='pending' and event.created_at <= $1
          and (application.webhook_event_id is null or application.outcome='customer_message_applied')
          and not exists(select 1 from runtime_processing_work work where work.webhook_event_id=event.id)
          ${quarantine ? "and not exists(select 1 from runtime_restore_quarantine where source_kind='webhook_event' and source_id=event.id)" : ''}
        order by event.created_at,event.id limit $2 for update of event skip locked`,
        [evaluatedAt, limit],
      );
      let created = 0;
      for (const candidate of candidates.rows) {
        const inserted = await client.query(
          `insert into runtime_processing_work
          (work_ref,webhook_event_id,stage,state,created_at,updated_at) values ($1,$2,$3,'pending',$4,$4)
          on conflict(webhook_event_id) do nothing`,
          [`WORK_${randomUUID()}`, candidate.id, candidate.stage, evaluatedAt],
        );
        created += inserted.rowCount ?? 0;
      }
      return { created };
    });
  }

  public async claim(input: z.infer<typeof workClaimSchema>): Promise<readonly ProcessingClaim[]> {
    const command = parseWork(workClaimSchema, input);
    return withBoundedTransaction(this.pool, async (client) => {
      if (await recoveryHeld(client)) return [];
      const quarantine = await quarantinePresent(client);
      const selected = await client.query<WorkRow>(
        `select work.* from runtime_processing_work work
        where (state='pending' or (state='leased' and lease_expires_at <= $1))
          ${quarantine ? "and not exists(select 1 from runtime_restore_quarantine where source_kind='webhook_event' and source_id=work.webhook_event_id)" : ''}
        order by created_at,id limit $2 for update skip locked`,
        [command.evaluatedAt, command.limit],
      );
      const claims: ProcessingClaim[] = [];
      for (const row of selected.rows) {
        const leaseRef = `LEASE_${randomUUID()}`;
        await client.query(
          `update runtime_processing_work set state='leased', lease_ref=$2,
          worker_ref=$3, lease_expires_at=$4, updated_at=$5 where id=$1`,
          [
            row.id,
            leaseRef,
            command.workerRef,
            new Date(command.evaluatedAt.getTime() + command.leaseMilliseconds),
            command.evaluatedAt,
          ],
        );
        claims.push(
          Object.freeze({
            workRef: row.work_ref,
            webhookEventId: row.webhook_event_id,
            leaseRef,
            stage: row.stage,
          }),
        );
      }
      return claims;
    });
  }

  public async advance(input: z.infer<typeof advanceSchema>): Promise<void> {
    const command = parseWork(advanceSchema, input);
    await withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<WorkRow>(
        `select * from runtime_processing_work where work_ref=$1 for update`,
        [command.workRef],
      );
      const row = selected.rows[0];
      if (
        row?.state !== 'leased' ||
        row.lease_ref !== command.leaseRef ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= command.evaluatedAt
      )
        workConflict();
      if (row.stage === command.stage) return;
      const edges: Readonly<Record<ProcessingClaim['stage'], readonly ProcessingClaim['stage'][]>> =
        {
          apply: ['decide'],
          decide: ['model', 'enqueue'],
          model: ['enqueue'],
          enqueue: [],
        };
      if (!edges[row.stage].includes(command.stage)) workConflict();
      await client.query(`update runtime_processing_work set stage=$2,updated_at=$3 where id=$1`, [
        row.id,
        command.stage,
        command.evaluatedAt,
      ]);
    });
  }

  public async finish(input: z.infer<typeof finishSchema>): Promise<void> {
    const command = parseWork(finishSchema, input);
    await withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<WorkRow>(
        `select * from runtime_processing_work where work_ref=$1 for update`,
        [command.workRef],
      );
      const row = selected.rows[0];
      if (
        row?.state === command.outcome &&
        row.finished_lease_ref === command.leaseRef &&
        row.finished_at?.getTime() === command.evaluatedAt.getTime()
      )
        return;
      if (
        row?.state !== 'leased' ||
        row.lease_ref !== command.leaseRef ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= command.evaluatedAt
      )
        workConflict();
      if (command.outcome === 'completed' && row.stage !== 'enqueue') {
        const application = await client.query<{ outcome: string }>(
          `select outcome from webhook_event_applications where webhook_event_id=$1`,
          [row.webhook_event_id],
        );
        if (
          application.rows[0] === undefined ||
          application.rows[0].outcome === 'customer_message_applied'
        ) {
          workConflict();
        }
      }
      await client.query(
        `update runtime_processing_work set state=$2,finished_lease_ref=$3,finished_at=$4,
        updated_at=$4,lease_ref=null,worker_ref=null,lease_expires_at=null where id=$1`,
        [row.id, command.outcome, command.leaseRef, command.evaluatedAt],
      );
    });
  }
}
