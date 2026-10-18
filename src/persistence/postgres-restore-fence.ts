import { z } from 'zod';
import { reconcileOutboundPrivacy } from './postgres-outbound-privacy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const commandSchema = z.strictObject({
  restoreRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  evaluatedAt: z.date(),
});
const sources = [
  ['webhook_event', 'webhook_events'],
  ['processing_work', 'runtime_processing_work'],
  ['model_lease', 'model_call_leases'],
  ['reply_draft', 'support_reply_drafts'],
  ['outbound_intent', 'outbound_intents'],
  ['notification_work', 'notification_delivery_work'],
  ['privacy_notification', 'privacy_notification_intents'],
  ['support_escalation', 'support_escalation_outcomes'],
  ['outbound_escalation', 'outbound_escalation_outcomes'],
] as const;
export class PostgresRestoreFence {
  public constructor(private readonly pool: TransactionSource) {}
  public async quarantine(input: {
    restoreRef: string;
    evaluatedAt: Date;
  }): Promise<{ quarantined: number }> {
    try {
      const command = commandSchema.parse(input);
      return await withBoundedTransaction(this.pool, async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended('fcd-support:restore-fence',0))",
        );
        const existing = await client.query<{ created_at: Date; quarantined_count: number }>(
          'select created_at,quarantined_count from runtime_recovery_holds where restore_ref=$1',
          [command.restoreRef],
        );
        const prior = existing.rows[0];
        if (prior !== undefined) {
          if (prior.created_at.getTime() !== command.evaluatedAt.getTime())
            throw new Error('invalid');
          return { quarantined: prior.quarantined_count };
        }
        // The target is isolated. Table locks make the inherited snapshot and
        // terminal transitions atomic even if an unexpected private writer exists.
        await client.query(
          `lock table ${sources.map(([, table]) => table).join(',')}, conversations in exclusive mode`,
        );
        let quarantined = 0;
        for (const [, table] of sources) {
          const count = await client.query<{ count: number }>(
            `select count(*)::int as count from ${table}`,
          );
          quarantined += count.rows[0]?.count ?? 0;
        }
        await client.query(
          'insert into runtime_recovery_holds(restore_ref,created_at,quarantined_count) values($1,$2,$3)',
          [command.restoreRef, command.evaluatedAt, quarantined],
        );
        for (const [kind, table] of sources) {
          await client.query(
            `insert into runtime_restore_quarantine(source_kind,source_id,restore_ref,reason,recorded_at)
            select $1,id,$2,'restore_quarantined',$3 from ${table} on conflict(source_kind,source_id) do nothing`,
            [kind, command.restoreRef, command.evaluatedAt],
          );
        }
        const conversations = await client.query<{ id: string }>(
          'select id from conversations order by id for update',
        );
        await reconcileOutboundPrivacy(client, {
          conversationIds: conversations.rows.map((row) => row.id),
          effectiveAt: command.evaluatedAt,
          reason: 'restore_quarantined',
        });
        await client.query(
          `update runtime_processing_work set state='quarantined',lease_ref=null,worker_ref=null,lease_expires_at=null,updated_at=$1
          where state in ('pending','leased')`,
          [command.evaluatedAt],
        );
        await client.query(
          `update model_call_leases set state='failed',outcome_code='guard_blocked',finished_at=$1,updated_at=$1
          where state in ('queued','active')`,
          [command.evaluatedAt],
        );
        await client.query(
          `update notification_delivery_work set state='quarantined',lease_ref=null,worker_ref=null,lease_expires_at=null,
          next_attempt_at=null,updated_at=$1 where state in ('pending','leased')`,
          [command.evaluatedAt],
        );
        return { quarantined };
      });
    } catch {
      throw new Error('restore_fence_invalid');
    }
  }
}
