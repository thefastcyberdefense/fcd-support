import type pg from 'pg';
import { z } from 'zod';

const nonNegativeInt = z.number().int().nonnegative();
const safeEnumKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const countMapSchema = z.record(safeEnumKey, nonNegativeInt);

export const dbCountsReportSchema = z.strictObject({
  webhookReceipts: z.strictObject({ total: nonNegativeInt }),
  webhookEvents: z.strictObject({ total: nonNegativeInt, byAdmissionOutcome: countMapSchema }),
  webhookEventAttachments: z.strictObject({
    total: nonNegativeInt,
    byStatus: countMapSchema,
    byKind: countMapSchema,
  }),
  webhookEventApplications: z.strictObject({ total: nonNegativeInt, byOutcome: countMapSchema }),
  runtimeProcessingWork: z.strictObject({
    total: nonNegativeInt,
    byState: countMapSchema,
    byStage: countMapSchema,
  }),
  supportReplyDrafts: z.strictObject({
    total: nonNegativeInt,
    byDecisionType: countMapSchema,
    byLanguage: countMapSchema,
    byState: countMapSchema,
  }),
  supportEscalationOutcomes: z.strictObject({
    total: nonNegativeInt,
    byState: countMapSchema,
    byReasonCode: countMapSchema,
  }),
  knowledgeGapObservations: z.strictObject({ total: nonNegativeInt }),
  modelCallLeases: z.strictObject({ total: nonNegativeInt, byState: countMapSchema }),
  outboundIntents: z.strictObject({ total: nonNegativeInt, byState: countMapSchema }),
  outboundAttempts: z.strictObject({ total: nonNegativeInt, byState: countMapSchema }),
  privacyRequests: z.strictObject({
    total: nonNegativeInt,
    byType: countMapSchema,
    byState: countMapSchema,
  }),
  privacySuppressions: z.strictObject({ total: nonNegativeInt, byCategory: countMapSchema }),
  humanPauseEvents: z.strictObject({
    total: nonNegativeInt,
    byAction: countMapSchema,
    byActorKind: countMapSchema,
  }),
  knowledgeVersions: z.strictObject({ total: nonNegativeInt, byState: countMapSchema }),
  knowledgePublicationEvents: z.strictObject({ total: nonNegativeInt, byAction: countMapSchema }),
  modelPolicyVersions: z.strictObject({ total: nonNegativeInt, byState: countMapSchema }),
  outboundPolicyVersions: z.strictObject({ total: nonNegativeInt, byState: countMapSchema }),
  operationsDeployments: z.strictObject({ total: nonNegativeInt, byStatus: countMapSchema }),
});

export type DbCountsReport = z.infer<typeof dbCountsReportSchema>;

export const dbCountsOutputSchema = z.strictObject({
  status: z.literal('completed'),
  dbCounts: dbCountsReportSchema,
});

export type DbCountsOutput = z.infer<typeof dbCountsOutputSchema>;

export interface CollectDbCountsOptions {
  readonly maximumCallMilliseconds?: number | undefined;
}

type CountTableName =
  | 'webhook_receipts'
  | 'webhook_events'
  | 'webhook_event_attachments'
  | 'webhook_event_applications'
  | 'runtime_processing_work'
  | 'support_reply_drafts'
  | 'support_escalation_outcomes'
  | 'knowledge_gap_observations'
  | 'model_call_leases'
  | 'outbound_intents'
  | 'outbound_attempts'
  | 'privacy_requests'
  | 'privacy_suppressions'
  | 'human_pause_events'
  | 'knowledge_versions'
  | 'knowledge_publication_events'
  | 'model_policy_versions'
  | 'outbound_policy_versions'
  | 'operations_deployments';

type CountColumnName =
  | 'admission_outcome'
  | 'extraction_status'
  | 'attachment_kind'
  | 'outcome'
  | 'state'
  | 'stage'
  | 'decision_type'
  | 'language'
  | 'reason_code'
  | 'request_type'
  | 'category'
  | 'action'
  | 'actor_kind'
  | 'status';

async function queryTotal(client: pg.PoolClient, table: CountTableName): Promise<number> {
  const result = await client.query<{ readonly total: number | string }>(
    `select count(*)::int as total from ${table}`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function queryGroupedCounts(
  client: pg.PoolClient,
  table: CountTableName,
  column: CountColumnName,
): Promise<Readonly<Record<string, number>>> {
  const result = await client.query<{ readonly k1: unknown; readonly c: number | string }>(
    `select ${column} as k1, count(*)::int as c from ${table} group by ${column} order by ${column}`,
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) {
    const key = safeEnumKey.parse(row.k1);
    const count = nonNegativeInt.parse(Number(row.c));
    out[key] = count;
  }
  return out;
}

/**
 * Queries strictly content-free integer totals and closed enum counts inside a read-only transaction.
 */
export async function collectDbCounts(
  pool: pg.Pool,
  options: CollectDbCountsOptions = {},
): Promise<DbCountsReport> {
  const client = await pool.connect();
  const state = { failed: false };
  const onError = () => {
    state.failed = true;
  };
  if (typeof client.on === 'function') client.on('error', onError);
  if (typeof client.once === 'function') {
    client.once('end', () => {
      if (typeof client.off === 'function') client.off('error', onError);
    });
  }

  let finished = false;
  try {
    await client.query('begin read only');
    if (options.maximumCallMilliseconds !== undefined) {
      const bound = `${String(z.number().int().min(1).max(300_000).parse(options.maximumCallMilliseconds))}ms`;
      await client.query(
        "select pg_catalog.set_config('statement_timeout',$1,true),pg_catalog.set_config('transaction_timeout',$1,true)",
        [bound],
      );
    }

    const report: DbCountsReport = {
      webhookReceipts: { total: await queryTotal(client, 'webhook_receipts') },
      webhookEvents: {
        total: await queryTotal(client, 'webhook_events'),
        byAdmissionOutcome: await queryGroupedCounts(client, 'webhook_events', 'admission_outcome'),
      },
      webhookEventAttachments: {
        total: await queryTotal(client, 'webhook_event_attachments'),
        byStatus: await queryGroupedCounts(
          client,
          'webhook_event_attachments',
          'extraction_status',
        ),
        byKind: await queryGroupedCounts(client, 'webhook_event_attachments', 'attachment_kind'),
      },
      webhookEventApplications: {
        total: await queryTotal(client, 'webhook_event_applications'),
        byOutcome: await queryGroupedCounts(client, 'webhook_event_applications', 'outcome'),
      },
      runtimeProcessingWork: {
        total: await queryTotal(client, 'runtime_processing_work'),
        byState: await queryGroupedCounts(client, 'runtime_processing_work', 'state'),
        byStage: await queryGroupedCounts(client, 'runtime_processing_work', 'stage'),
      },
      supportReplyDrafts: {
        total: await queryTotal(client, 'support_reply_drafts'),
        byDecisionType: await queryGroupedCounts(client, 'support_reply_drafts', 'decision_type'),
        byLanguage: await queryGroupedCounts(client, 'support_reply_drafts', 'language'),
        byState: await queryGroupedCounts(client, 'support_reply_drafts', 'state'),
      },
      supportEscalationOutcomes: {
        total: await queryTotal(client, 'support_escalation_outcomes'),
        byState: await queryGroupedCounts(client, 'support_escalation_outcomes', 'state'),
        byReasonCode: await queryGroupedCounts(
          client,
          'support_escalation_outcomes',
          'reason_code',
        ),
      },
      knowledgeGapObservations: {
        total: await queryTotal(client, 'knowledge_gap_observations'),
      },
      modelCallLeases: {
        total: await queryTotal(client, 'model_call_leases'),
        byState: await queryGroupedCounts(client, 'model_call_leases', 'state'),
      },
      outboundIntents: {
        total: await queryTotal(client, 'outbound_intents'),
        byState: await queryGroupedCounts(client, 'outbound_intents', 'state'),
      },
      outboundAttempts: {
        total: await queryTotal(client, 'outbound_attempts'),
        byState: await queryGroupedCounts(client, 'outbound_attempts', 'state'),
      },
      privacyRequests: {
        total: await queryTotal(client, 'privacy_requests'),
        byType: await queryGroupedCounts(client, 'privacy_requests', 'request_type'),
        byState: await queryGroupedCounts(client, 'privacy_requests', 'state'),
      },
      privacySuppressions: {
        total: await queryTotal(client, 'privacy_suppressions'),
        byCategory: await queryGroupedCounts(client, 'privacy_suppressions', 'category'),
      },
      humanPauseEvents: {
        total: await queryTotal(client, 'human_pause_events'),
        byAction: await queryGroupedCounts(client, 'human_pause_events', 'action'),
        byActorKind: await queryGroupedCounts(client, 'human_pause_events', 'actor_kind'),
      },
      knowledgeVersions: {
        total: await queryTotal(client, 'knowledge_versions'),
        byState: await queryGroupedCounts(client, 'knowledge_versions', 'state'),
      },
      knowledgePublicationEvents: {
        total: await queryTotal(client, 'knowledge_publication_events'),
        byAction: await queryGroupedCounts(client, 'knowledge_publication_events', 'action'),
      },
      modelPolicyVersions: {
        total: await queryTotal(client, 'model_policy_versions'),
        byState: await queryGroupedCounts(client, 'model_policy_versions', 'state'),
      },
      outboundPolicyVersions: {
        total: await queryTotal(client, 'outbound_policy_versions'),
        byState: await queryGroupedCounts(client, 'outbound_policy_versions', 'state'),
      },
      operationsDeployments: {
        total: await queryTotal(client, 'operations_deployments'),
        byStatus: await queryGroupedCounts(client, 'operations_deployments', 'status'),
      },
    };

    const validated = dbCountsReportSchema.parse(report);
    await client.query('commit');
    finished = true;
    if (state.failed) throw new Error('db_counts_connection_failed');
    return validated;
  } finally {
    if (!finished) {
      await client.query('rollback').catch(() => undefined);
    }
    client.release(true);
  }
}
