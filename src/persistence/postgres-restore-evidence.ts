import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const restoreRefSchema = z.string().regex(/^restore_[a-f0-9]{32}$/u);
const systemIdentifierSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/u)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n);
const keyVersionsSchema = z
  .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u))
  .min(1)
  .max(1000)
  .refine((values) =>
    values.every((value, index) => index === 0 || value > (values[index - 1] ?? value)),
  );
export const restoreTargetIdentitySchema = z.strictObject({
  projectName: z.string().regex(/^fcd-support-restore-[a-z0-9][a-z0-9-]{0,63}$/u),
  volumeName: z.string().regex(/^fcd-support-restore-[a-z0-9][a-z0-9_-]{0,127}$/u),
  volumeCreatedAt: z.iso.datetime(),
  networkId: z.string().regex(/^[a-f0-9]{64}$/u),
  postgresImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  systemIdentifier: systemIdentifierSchema,
  databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
  schema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
});
export type RestoreTargetIdentity = z.infer<typeof restoreTargetIdentitySchema>;
const sealSchema = z.strictObject({
  restoreRef: restoreRefSchema,
  backupRef: z.string().regex(/^backup_[a-f0-9]{32}$/u),
  checkpointRef: z.string().regex(/^checkpoint_[a-f0-9]{32}$/u),
  gitRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  schemaRevision: z.string().regex(/^[0-9]{6}$/u),
  target: restoreTargetIdentitySchema,
  sourceSystemIdentifier: systemIdentifierSchema,
  gateRef: z.string().regex(/^gate_[a-f0-9]{32}$/u),
  requiredKeyVersions: keyVersionsSchema,
  evaluatedAt: z.date(),
});
export type SealRestoreEvidence = z.infer<typeof sealSchema>;
export interface RestoreBinding {
  readonly restoreRef: string;
  readonly backupRef: string;
  readonly checkpointRef: string;
  readonly gitRevision: string;
  readonly schemaRevision: string;
  readonly target: RestoreTargetIdentity;
  readonly sourceSystemIdentifier: string;
  readonly sourceWatermark: { readonly sourceEpoch: string; readonly sequence: string };
  readonly requiredKeyVersions: readonly string[];
  readonly gateRef: string;
  readonly recordedAt: Date;
  readonly recoveryHeldAtSeal: true;
}
interface BindingRow {
  restore_ref: string;
  backup_ref: string;
  checkpoint_ref: string;
  git_revision: string;
  schema_revision: string;
  target_identity: unknown;
  target_identity_sha256: string;
  source_system_identifier: string;
  source_epoch: string;
  source_sequence: string;
  required_key_versions: string[];
  gate_ref: string;
  recorded_at: Date;
}
const digest = (target: RestoreTargetIdentity) =>
  createHash('sha256').update(JSON.stringify(target)).digest('hex');

/** Historical evidence only. Loading a sealed pass never authorizes attachment or promotion. */
export class PostgresRestoreEvidence {
  public constructor(private readonly pool: TransactionSource) {}

  public async seal(input: SealRestoreEvidence): Promise<RestoreBinding> {
    try {
      const command = sealSchema.parse(input);
      return await withBoundedTransaction(this.pool, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `fcd-support:restore-binding:${command.restoreRef}`,
        ]);
        await this.requireTarget(client, command.target, command.schemaRevision);
        if (command.sourceSystemIdentifier === command.target.systemIdentifier)
          throw new Error('invalid');
        // Freeze the evidence inputs through the atomic pass + binding insert.
        await client.query(
          'lock table operations_restore_runs, restore_checkpoint_imports, runtime_recovery_holds, runtime_recovery_reviews, restore_deletion_gates in share row exclusive mode',
        );
        const evidence = await client.query<{
          source_epoch: string;
          sequence: string;
          ciphertext_sha256: string;
          signature: string;
          final_gate_id: string;
        }>(
          `select imported.source_epoch,imported.sequence::text,imported.ciphertext_sha256,imported.signature,gate.id::text as final_gate_id
          from operations_restore_runs run
          join restore_checkpoint_imports imported on imported.restore_ref=run.restore_ref and imported.checkpoint_ref=run.checkpoint_ref
          join runtime_recovery_holds hold on hold.restore_ref=run.restore_ref
          join restore_deletion_gates gate on gate.gate_ref=$7 and gate.action='finalize' and gate.status='passed'
          where run.restore_ref=$1 and run.backup_ref=$2 and run.checkpoint_ref=$3
            and run.git_revision=$4 and run.schema_revision=$5 and run.state='isolated' and run.recorded_at <= $6
            and imported.imported_at <= $6 and hold.created_at <= $6
            and gate.git_revision=$4 and gate.evaluated_at=$6 and gate.completed_at >= $6
            and gate.required_key_versions=$8 and gate.remaining_matches=0
            and imported.required_key_versions <@ $8::text[]
            and not exists(select 1 from runtime_recovery_reviews where restore_ref=run.restore_ref)
            and not exists(select 1 from operations_restore_runs where restore_ref=run.restore_ref and state<>'isolated')
            and not exists(select 1 from operations_restore_bindings where restore_ref=run.restore_ref)
            and not exists(select 1 from restore_deletion_gates where gate_ref=$7 and status='failed')
            and exists(select 1 from restore_deletion_gates batch
              where batch.id=(select max(id) from restore_deletion_gates where gate_ref=$7 and action='reapply_batch')
              and batch.status='applied' and batch.remaining_matches=0 and batch.git_revision=$4
              and batch.required_key_versions=$8 and batch.evaluated_at=$6 and batch.id<gate.id)`,
          [
            command.restoreRef,
            command.backupRef,
            command.checkpointRef,
            command.gitRevision,
            command.schemaRevision,
            command.evaluatedAt,
            command.gateRef,
            command.requiredKeyVersions,
          ],
        );
        const row = evidence.rows[0];
        if (row === undefined || evidence.rows.length !== 1) throw new Error('invalid');
        await client.query(
          `insert into operations_restore_runs(restore_ref,backup_ref,checkpoint_ref,git_revision,schema_revision,state,recorded_at)
          values($1,$2,$3,$4,$5,'reconciled',$6)`,
          [
            command.restoreRef,
            command.backupRef,
            command.checkpointRef,
            command.gitRevision,
            command.schemaRevision,
            command.evaluatedAt,
          ],
        );
        const pass = await client.query<{ id: string }>(
          `insert into operations_restore_runs(restore_ref,backup_ref,checkpoint_ref,git_revision,schema_revision,state,recorded_at)
          values($1,$2,$3,$4,$5,'passed',$6) returning id::text`,
          [
            command.restoreRef,
            command.backupRef,
            command.checkpointRef,
            command.gitRevision,
            command.schemaRevision,
            command.evaluatedAt,
          ],
        );
        await client.query(
          `insert into operations_restore_bindings(restore_ref,restore_run_id,backup_ref,checkpoint_ref,git_revision,schema_revision,
          target_identity,target_identity_sha256,source_system_identifier,source_epoch,source_sequence,checkpoint_ciphertext_sha256,checkpoint_signature,required_key_versions,final_gate_id,recorded_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            command.restoreRef,
            pass.rows[0]?.id,
            command.backupRef,
            command.checkpointRef,
            command.gitRevision,
            command.schemaRevision,
            JSON.stringify(command.target),
            digest(command.target),
            command.sourceSystemIdentifier,
            row.source_epoch,
            row.sequence,
            row.ciphertext_sha256,
            row.signature,
            command.requiredKeyVersions,
            row.final_gate_id,
            command.evaluatedAt,
          ],
        );
        return this.read(client, command.restoreRef);
      });
    } catch {
      throw new Error('restore_binding_invalid');
    }
  }

  public async load(restoreRef: string): Promise<RestoreBinding> {
    try {
      return await withBoundedTransaction(this.pool, (client) =>
        this.read(client, restoreRefSchema.parse(restoreRef)),
      );
    } catch {
      throw new Error('restore_binding_invalid');
    }
  }

  private async requireTarget(
    client: pg.PoolClient,
    target: RestoreTargetIdentity,
    schemaRevision: string,
  ): Promise<void> {
    const actual = (
      await client.query<{
        id: string;
        database: string;
        schema: string;
        revision: string | null;
      }>(`select system_identifier::text as id,current_database() as database,current_schema() as schema,
      (select max(substring(name,1,6)) from pgmigrations) as revision from pg_control_system()`)
    ).rows[0];
    if (
      actual?.id !== target.systemIdentifier ||
      actual.database !== target.databaseName ||
      actual.schema !== target.schema ||
      actual.revision !== schemaRevision
    )
      throw new Error('invalid');
  }

  private async read(client: pg.PoolClient, restoreRef: string): Promise<RestoreBinding> {
    const row = (
      await client.query<BindingRow>(
        `select binding.*,gate.gate_ref from operations_restore_bindings binding
      join restore_deletion_gates gate on gate.id=binding.final_gate_id where binding.restore_ref=$1`,
        [restoreRef],
      )
    ).rows[0];
    if (row === undefined) throw new Error('invalid');
    const target = restoreTargetIdentitySchema.parse(row.target_identity);
    if (digest(target) !== row.target_identity_sha256) throw new Error('invalid');
    return {
      restoreRef: row.restore_ref,
      backupRef: row.backup_ref,
      checkpointRef: row.checkpoint_ref,
      gitRevision: row.git_revision,
      schemaRevision: row.schema_revision,
      target,
      sourceSystemIdentifier: row.source_system_identifier,
      sourceWatermark: { sourceEpoch: row.source_epoch, sequence: row.source_sequence },
      requiredKeyVersions: keyVersionsSchema.parse(row.required_key_versions),
      gateRef: row.gate_ref,
      recordedAt: row.recorded_at,
      recoveryHeldAtSeal: true,
    };
  }
}
