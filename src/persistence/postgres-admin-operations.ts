import type pg from 'pg';
import type { AdminActor } from '../admin/admin-app.js';
import {
  parseOperationsView,
  type AdminOperationsPort,
  type OperationsView,
} from '../admin/operations-types.js';
import {
  boundedHealthCall,
  parseHostHealthSnapshot,
  type HealthDatabaseSnapshot,
  type HealthQueueAggregate,
} from '../operations/health-collector.js';
import type { PostgresAdminIdentity } from './postgres-admin-identity.js';
import { PostgresOperationsStore } from './postgres-operations-store.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

interface Metadata {
  readonly last_collected_at: Date | null;
  readonly schema_revision: string | null;
  readonly git_revision: string | null;
  readonly deployment_state: OperationsView['deploymentState'];
  readonly backup_created_at: Date | null;
  readonly backup_state: OperationsView['backup']['state'] | 'pruned' | null;
  readonly backup_verified_at: Date | null;
  readonly restore_state: OperationsView['restore']['state'] | null;
  readonly restore_recorded_at: Date | null;
  readonly checkpoint_at: Date | null;
}
interface Aggregate {
  readonly component: HealthQueueAggregate['component'];
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
  readonly completed: number;
  readonly oldest_age_seconds: number | null;
}
const metadataSql = `select
  (select max(checked_at) from operations_health_checks where component='postgres') as last_collected_at,
  (select split_part(name,'_',1) from pgmigrations order by id desc limit 1) as schema_revision,
  (select git_revision from operations_deployments order by recorded_at desc,id desc limit 1) as git_revision,
  (select status from operations_deployments order by recorded_at desc,id desc limit 1) as deployment_state,
  (select created_at from operations_backups where state <> 'pruned' order by created_at desc,id desc limit 1) as backup_created_at,
  (select state from operations_backups where state <> 'pruned' order by created_at desc,id desc limit 1) as backup_state,
  (select max(recorded_at) from operations_backup_events where state in ('verified','restore_verified')) as backup_verified_at,
  (select state from operations_restore_runs order by recorded_at desc,id desc limit 1) as restore_state,
  (select recorded_at from operations_restore_runs order by recorded_at desc,id desc limit 1) as restore_recorded_at,
  (select max(snapshot_at) from deletion_checkpoints) as checkpoint_at`;
const aggregateSql = `with work as (
  select 'reply' as component,state,created_at from runtime_processing_work
  union all select 'outbound',state,created_at from outbound_intents
  union all select 'notification',state,created_at from notification_delivery_work
), components(component) as (values ('reply'),('outbound'),('notification'))
select components.component,
  count(*) filter(where state='pending')::int as pending,
  count(*) filter(where state='leased')::int as leased,
  count(*) filter(where state in ('failed','terminal_failed','delivery_unknown'))::int as failed,
  count(*) filter(where state in ('completed','delivered','read'))::int as completed,
  extract(epoch from ($1::timestamptz-min(created_at) filter(where state in ('pending','leased'))))::float8 as oldest_age_seconds
from components left join work using(component) group by components.component order by components.component`;
function ageBucket(seconds: number | null): HealthQueueAggregate['oldestAgeBucket'] {
  if (seconds === null) return 'empty';
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('operations_aggregate_invalid');
  return seconds < 60
    ? 'under_minute'
    : seconds < 3600
      ? 'under_hour'
      : seconds < 86400
        ? 'under_day'
        : 'over_day';
}
async function readDatabase(client: Pick<pg.PoolClient, 'query'>, at: Date) {
  const metadata = (await client.query<Metadata>(metadataSql)).rows[0];
  if (metadata === undefined) throw new Error('operations_read_failed');
  const queue = (await client.query<Aggregate>(aggregateSql, [at])).rows;
  const queues: HealthQueueAggregate[] = queue.map((row) => ({
    component: row.component,
    pending: row.pending,
    leased: row.leased,
    failed: row.failed,
    completed: row.completed,
    oldestAgeBucket: ageBucket(row.oldest_age_seconds),
  }));
  return { metadata, queues };
}
/** SELECTs enumerate only closed metadata and aggregates; no domain content is selected. */
export function postgresHealthDatabase(
  pool: TransactionSource,
  now: () => Date,
): { readonly read: () => Promise<HealthDatabaseSnapshot> } {
  return {
    read: () =>
      withBoundedTransaction(
        pool,
        async (client) => {
          const { metadata, queues } = await readDatabase(client, now());
          return {
            lastCollectedAt: metadata.last_collected_at,
            schemaRevision: metadata.schema_revision ?? '',
            gitRevision: metadata.git_revision,
            backupCreatedAt: metadata.backup_created_at,
            backupVerified:
              metadata.backup_state === 'verified' || metadata.backup_state === 'restore_verified',
            deletionCheckpointAt: metadata.checkpoint_at,
            queues,
          };
        },
        { isolationLevel: 'repeatable_read' },
      ),
  };
}
export interface AdminOperationsOptions {
  readonly now?: () => Date;
  readonly staleMilliseconds?: number;
  readonly backupStaleMilliseconds?: number;
  readonly modelEnabled?: boolean;
  readonly notificationsEnabled?: boolean;
  readonly outboundEnabled?: boolean;
  readonly hostSnapshot?: () => Promise<unknown>;
}
export class PostgresAdminOperations implements AdminOperationsPort {
  private readonly store: PostgresOperationsStore;
  public constructor(
    private readonly pool: pg.Pool,
    private readonly identity: Pick<PostgresAdminIdentity, 'authorizeSession'>,
    private readonly options: AdminOperationsOptions = {},
  ) {
    for (const limit of [
      options.staleMilliseconds ?? 60_000,
      options.backupStaleMilliseconds ?? 129_600_000,
    ])
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 604_800_000)
        throw new TypeError('health_configuration_invalid');
    this.store = new PostgresOperationsStore(pool, {
      identity,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  public acknowledgeIncident(
    input: {
      readonly incidentRef: string;
      readonly requestKey: string;
      readonly acknowledgedAt: Date;
    },
    actor: AdminActor,
  ): Promise<void> {
    return this.store.acknowledgeIncident(input, actor);
  }
  public async read(actor: AdminActor): Promise<OperationsView> {
    const evaluatedAt = this.options.now?.() ?? new Date();
    return withBoundedTransaction(this.pool, async (client) => {
      const session = await this.identity.authorizeSession(client, actor.sessionToken, [
        'administrator',
      ]);
      if (session.accountRef !== actor.accountRef) throw new Error('operations_unauthorized');
      const { metadata, queues } = await readDatabase(client, evaluatedAt);
      const store = new PostgresOperationsStore({ transactionClient: client });
      const health = await store.listHealth(evaluatedAt, this.options.staleMilliseconds ?? 60_000);
      const incidents = await client.query<{
        incident_ref: string;
        component: OperationsView['incidents'][number]['component'];
        opened_at: Date;
        last_observed_at: Date;
        acknowledged_at: Date | null;
        resolved_at: Date | null;
        consecutive_failures: number;
      }>(`select incident_ref,component,opened_at,last_observed_at,acknowledged_at,resolved_at,consecutive_failures
          from operations_incidents order by (resolved_at is null) desc,opened_at desc,id desc limit 100`);
      let host = null;
      try {
        const parsed = parseHostHealthSnapshot(
          await boundedHealthCall(
            () => this.options.hostSnapshot?.() ?? Promise.resolve(undefined),
            750,
          ),
        );
        const age =
          parsed === undefined ? -1 : evaluatedAt.getTime() - Date.parse(parsed.checkedAt);
        if (parsed !== undefined && age >= 0 && age <= (this.options.staleMilliseconds ?? 60_000)) {
          const routeAge =
            parsed.publicRouteCheck.checkedAt === undefined
              ? -1
              : evaluatedAt.getTime() - Date.parse(parsed.publicRouteCheck.checkedAt);
          host =
            routeAge >= 0 && routeAge <= (this.options.staleMilliseconds ?? 60_000)
              ? parsed
              : { ...parsed, publicRouteCheck: { state: 'not_verified' } };
        }
      } catch {
        /* Absent host evidence is not_verified. */
      }
      const backupAge =
        metadata.backup_created_at === null
          ? -1
          : evaluatedAt.getTime() - metadata.backup_created_at.getTime();
      const backupState =
        metadata.backup_state === null || metadata.backup_state === 'pruned'
          ? 'not_verified'
          : backupAge < 0 || backupAge > (this.options.backupStaleMilliseconds ?? 129_600_000)
            ? 'stale'
            : metadata.backup_state;
      const modelEnabled = this.options.modelEnabled ?? false;
      const notificationsEnabled = this.options.notificationsEnabled ?? false;
      const outboundEnabled = this.options.outboundEnabled ?? false;
      return parseOperationsView({
        evaluatedAt,
        schemaRevision: metadata.schema_revision,
        deployedRevision: metadata.git_revision,
        deploymentState: metadata.deployment_state,
        health: health.map((value) =>
          (!modelEnabled && value.component === 'manifest') ||
          (!notificationsEnabled &&
            (value.component === 'n8n' || value.component === 'notification')) ||
          (!outboundEnabled && value.component === 'outbound')
            ? { ...value, state: 'disabled', reasonCode: 'disabled' }
            : value,
        ),
        queues,
        incidents: incidents.rows.map((row) => ({
          incidentRef: row.incident_ref,
          component: row.component,
          openedAt: row.opened_at,
          lastObservedAt: row.last_observed_at,
          acknowledgedAt: row.acknowledged_at,
          resolvedAt: row.resolved_at,
          consecutiveFailures: row.consecutive_failures,
        })),
        backup: {
          state: backupState,
          createdAt: metadata.backup_created_at,
          verifiedAt: metadata.backup_verified_at,
        },
        restore: {
          state: metadata.restore_state ?? 'not_verified',
          recordedAt: metadata.restore_recorded_at,
        },
        host,
        modelEnabled,
        notificationsEnabled,
        outboundEnabled,
      });
    });
  }
}
