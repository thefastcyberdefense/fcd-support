import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AdminActor } from '../admin/admin-app.js';
import type { HealthObservation } from '../operations/operations-types.js';
import type { PostgresAdminIdentity } from './postgres-admin-identity.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const at = z.date().refine((value) => Number.isFinite(value.getTime()));
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const gitRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const schemaRevision = z.string().regex(/^[0-9]{6}$/u);
const healthSchema = z.strictObject({
  component: z.enum([
    'webhook',
    'postgres',
    'reply',
    'outbound',
    'notification',
    'manifest',
    'n8n',
    'tunnel',
    'backup',
    'migration',
    'deletion_checkpoint',
  ]),
  state: z.enum(['healthy', 'degraded', 'unavailable', 'disabled', 'unknown']),
  reasonCode: z.enum([
    'ok',
    'timeout',
    'dependency_unavailable',
    'not_verified',
    'disabled',
    'stale',
    'configuration_invalid',
    'collection_failed',
  ]),
  checkedAt: at,
  durationMilliseconds: z.number().int().min(0).max(300000),
});
const acknowledgementSchema = z.strictObject({
  incidentRef: reference,
  requestKey: reference,
  acknowledgedAt: at,
});
const backupSchema = z.strictObject({
  backupRef: reference,
  class: z.enum(['daily', 'monthly', 'pre_migration']),
  createdAt: at,
  gitRevision,
  schemaRevision,
  ciphertextBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['created', 'verified', 'restore_verified', 'pruned', 'failed']),
});
const deploymentSchema = z.strictObject({
  gitRevision,
  schemaRevision,
  recordedAt: at,
  status: z.enum(['started', 'succeeded', 'failed', 'rolled_back']),
});
export type BackupCatalogInput = z.infer<typeof backupSchema>;
export type DeploymentEvidenceInput = z.infer<typeof deploymentSchema>;

interface HealthRow {
  readonly id: string;
  readonly component: HealthObservation['component'];
  readonly state: HealthObservation['state'];
  readonly reason_code: HealthObservation['reasonCode'];
  readonly checked_at: Date;
  readonly duration_milliseconds: number;
}
interface IncidentRow {
  readonly id: string;
  readonly opened_at: Date;
  readonly acknowledged_at: Date | null;
}
interface BackupRow {
  readonly id: string;
  readonly class: BackupCatalogInput['class'];
  readonly created_at: Date;
  readonly git_revision: string;
  readonly schema_revision: string;
  readonly ciphertext_bytes: string;
  readonly ciphertext_sha256: string;
  readonly state: BackupCatalogInput['state'];
}
export interface OperationsStoreOptions {
  readonly identity?: Pick<PostgresAdminIdentity, 'authorizeSession'>;
  readonly now?: () => Date;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError('operations_input_invalid');
  return parsed.data;
}
function conflict(): never {
  throw new Error('operations_conflict');
}

export class PostgresOperationsStore {
  public constructor(
    private readonly pool: TransactionSource,
    private readonly options: OperationsStoreOptions = {},
  ) {}

  public async recordHealth(observation: HealthObservation): Promise<void> {
    const command = parse(healthSchema, observation);
    await withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `fcd-support:health:${command.component}`,
      ]);
      const latest = await client.query<HealthRow>(
        `select * from operations_health_checks
        where component = $1 order by checked_at desc limit 1`,
        [command.component],
      );
      const prior = await client.query<HealthRow>(
        `select * from operations_health_checks
        where component = $1 and checked_at = $2`,
        [command.component, command.checkedAt],
      );
      if (prior.rows[0] !== undefined) {
        const row = prior.rows[0];
        if (
          row.state !== command.state ||
          row.reason_code !== command.reasonCode ||
          row.duration_milliseconds !== command.durationMilliseconds
        )
          conflict();
        return;
      }
      const inserted = await client.query<{ id: string }>(
        `insert into operations_health_checks
        (component,state,reason_code,checked_at,duration_milliseconds) values ($1,$2,$3,$4,$5) returning id`,
        [
          command.component,
          command.state,
          command.reasonCode,
          command.checkedAt,
          command.durationMilliseconds,
        ],
      );
      if (latest.rows[0] !== undefined && latest.rows[0].checked_at > command.checkedAt) return;
      const incident = await client.query<IncidentRow>(
        `select id, opened_at, acknowledged_at
        from operations_incidents where component = $1 and resolved_at is null for update`,
        [command.component],
      );
      const open = incident.rows[0];
      const failing = command.state === 'unavailable' || command.state === 'degraded';
      if (!failing && (command.state !== 'healthy' || open === undefined)) return;
      let incidentId = open?.id;
      let action: 'opened' | 'observed' | 'resolved';
      if (failing && open === undefined) {
        const created = await client.query<{ id: string }>(
          `insert into operations_incidents
          (incident_ref,component,opened_at,last_observed_at,consecutive_failures)
          values ($1,$2,$3,$3,1) returning id`,
          [`INCIDENT_${randomUUID()}`, command.component, command.checkedAt],
        );
        incidentId = created.rows[0]?.id;
        action = 'opened';
      } else if (failing) {
        await client.query(
          `update operations_incidents set last_observed_at = $2,
          consecutive_failures = least(consecutive_failures::bigint + 1, 2147483647)::int where id = $1`,
          [incidentId, command.checkedAt],
        );
        action = 'observed';
      } else {
        await client.query(`update operations_incidents set resolved_at = $2 where id = $1`, [
          incidentId,
          command.checkedAt,
        ]);
        action = 'resolved';
      }
      if (incidentId === undefined) throw new Error('operations_write_failed');
      await client.query(
        `insert into operations_incident_events
        (incident_id,action,health_check_id,effective_at) values ($1,$2,$3,$4)`,
        [incidentId, action, inserted.rows[0]?.id, command.checkedAt],
      );
    });
  }

  public async listHealth(
    evaluatedAt: Date,
    staleMilliseconds: number,
  ): Promise<readonly HealthObservation[]> {
    parse(at, evaluatedAt);
    parse(z.number().int().min(1).max(86400000), staleMilliseconds);
    return withBoundedTransaction(this.pool, async (client) => {
      const rows = await client.query<HealthRow>(`select distinct on (component)
        component,state,reason_code,checked_at,duration_milliseconds
        from operations_health_checks order by component,checked_at desc`);
      return rows.rows.map((row) => {
        const age = evaluatedAt.getTime() - row.checked_at.getTime();
        const stale = age < 0 || age > staleMilliseconds;
        return Object.freeze({
          component: row.component,
          state: stale ? ('unknown' as const) : row.state,
          reasonCode: stale ? ('stale' as const) : row.reason_code,
          checkedAt: row.checked_at,
          durationMilliseconds: row.duration_milliseconds,
        });
      });
    });
  }

  public async acknowledgeIncident(
    input: {
      readonly incidentRef: string;
      readonly requestKey: string;
      readonly acknowledgedAt: Date;
    },
    actor: AdminActor,
  ): Promise<void> {
    const command = parse(acknowledgementSchema, input);
    const identity = this.options.identity;
    if (identity === undefined) throw new Error('operations_unauthorized');
    await withBoundedTransaction(this.pool, async (client) => {
      let accountRef: string;
      try {
        const session = await identity.authorizeSession(client, actor.sessionToken, [
          'administrator',
        ]);
        accountRef = session.accountRef;
        if (accountRef !== actor.accountRef) throw new Error('invalid');
      } catch {
        throw new Error('operations_unauthorized');
      }
      const account = await client.query<{ id: string }>(
        `select id from admin_accounts where account_ref = $1`,
        [accountRef],
      );
      const selected = await client.query<IncidentRow>(
        `select id, opened_at, acknowledged_at
        from operations_incidents where incident_ref = $1 for update`,
        [command.incidentRef],
      );
      const incident = selected.rows[0];
      const prior = await client.query<{
        incident_id: string;
        actor_account_id: string;
        effective_at: Date;
      }>(
        `select incident_id,actor_account_id,effective_at from operations_incident_events where request_key = $1`,
        [command.requestKey],
      );
      if (prior.rows[0] !== undefined) {
        const row = prior.rows[0];
        if (
          row.incident_id !== incident?.id ||
          row.actor_account_id !== account.rows[0]?.id ||
          row.effective_at.getTime() !== command.acknowledgedAt.getTime()
        )
          conflict();
        return;
      }
      const now = this.options.now?.() ?? new Date();
      if (
        incident === undefined ||
        command.acknowledgedAt < incident.opened_at ||
        command.acknowledgedAt > now
      )
        conflict();
      if (incident.acknowledged_at === null) {
        await client.query(
          `update operations_incidents set acknowledged_at=$2,
          acknowledged_by_account_id=$3 where id=$1`,
          [incident.id, command.acknowledgedAt, account.rows[0]?.id],
        );
      }
      await client.query(
        `insert into operations_incident_events
        (incident_id,action,actor_account_id,request_key,effective_at)
        values ($1,'acknowledged',$2,$3,$4)`,
        [incident.id, account.rows[0]?.id, command.requestKey, command.acknowledgedAt],
      );
    });
  }

  public async recordBackup(input: BackupCatalogInput): Promise<void> {
    const command = parse(backupSchema, input);
    await withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `fcd-support:backup:${command.backupRef}`,
      ]);
      const prior = await client.query<BackupRow>(
        `select * from operations_backups where backup_ref=$1 for update`,
        [command.backupRef],
      );
      const row = prior.rows[0];
      let backupId: string | undefined;
      if (row === undefined) {
        if (command.state !== 'created') conflict();
        const inserted = await client.query<{ id: string }>(
          `insert into operations_backups
          (backup_ref,class,created_at,git_revision,schema_revision,ciphertext_bytes,ciphertext_sha256,state)
          values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [
            command.backupRef,
            command.class,
            command.createdAt,
            command.gitRevision,
            command.schemaRevision,
            command.ciphertextBytes,
            command.ciphertextSha256,
            command.state,
          ],
        );
        backupId = inserted.rows[0]?.id;
      } else {
        backupId = row.id;
        if (
          row.class !== command.class ||
          row.created_at.getTime() !== command.createdAt.getTime() ||
          row.git_revision !== command.gitRevision ||
          row.schema_revision !== command.schemaRevision ||
          Number(row.ciphertext_bytes) !== command.ciphertextBytes ||
          row.ciphertext_sha256 !== command.ciphertextSha256
        )
          conflict();
        if (row.state === command.state) return;
        const allowed: Readonly<
          Record<BackupCatalogInput['state'], readonly BackupCatalogInput['state'][]>
        > = {
          created: ['verified', 'failed'],
          verified: ['restore_verified', 'pruned', 'failed'],
          restore_verified: ['pruned'],
          failed: ['pruned'],
          pruned: [],
        };
        if (!allowed[row.state].includes(command.state)) conflict();
        await client.query(`update operations_backups set state=$2 where id=$1`, [
          row.id,
          command.state,
        ]);
      }
      if (backupId === undefined) throw new Error('operations_write_failed');
      await client.query(
        `insert into operations_backup_events(backup_id,state,recorded_at) values ($1,$2,$3)`,
        [backupId, command.state, this.options.now?.() ?? new Date()],
      );
    });
  }

  public async recordDeployment(input: DeploymentEvidenceInput): Promise<void> {
    const command = parse(deploymentSchema, input);
    await withBoundedTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `insert into operations_deployments
        (git_revision,schema_revision,recorded_at,status) values ($1,$2,$3,$4)
        on conflict(git_revision,recorded_at) do nothing returning id`,
        [command.gitRevision, command.schemaRevision, command.recordedAt, command.status],
      );
      if (inserted.rowCount === 0) {
        const prior = await client.query<{
          schema_revision: string;
          status: DeploymentEvidenceInput['status'];
        }>(
          `select schema_revision,status from operations_deployments where git_revision=$1 and recorded_at=$2`,
          [command.gitRevision, command.recordedAt],
        );
        if (
          prior.rows[0]?.schema_revision !== command.schemaRevision ||
          prior.rows[0].status !== command.status
        )
          conflict();
      }
    });
  }
}
