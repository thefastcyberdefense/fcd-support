import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';

import { parseLearningPolicy } from '../learning/learning-input.js';
import type { LearningPolicy } from '../learning/learning-types.js';
import { parseOutboundPolicyInput } from '../outbound/outbound-policy-input.js';
import type { OutboundDeploymentBounds } from '../outbound/outbound-types.js';
import { PostgresDeletionPolicy } from '../persistence/postgres-deletion-policy.js';
import { PostgresLearningService } from '../persistence/postgres-learning-service.js';
import { PostgresModelAllowance } from '../persistence/postgres-model-allowance.js';
import { PostgresOutboundWorkStore } from '../persistence/postgres-outbound-work-store.js';
import { PostgresRetentionJob } from '../persistence/postgres-retention-job.js';
import { withBoundedTransaction } from '../persistence/postgres-transaction.js';
import { requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import type { JobSummary, MaintenanceJob } from './operations-types.js';

export const maintenanceJobs = ['retention', 'deletion', 'lease_recovery', 'learning'] as const;
export interface MaintenanceOptions {
  readonly pool: pg.Pool;
  readonly keyring: PrivacyHmacKeyring;
  readonly learningPolicy: LearningPolicy;
  readonly outboundBounds: OutboundDeploymentBounds;
  readonly now: () => Date;
  readonly limit: number;
  readonly runRef: string;
  readonly scheduledAt: Date;
  readonly learningWindowMilliseconds: number;
}
const schema = z.strictObject({
  job: z.enum(maintenanceJobs),
  limit: z.number().int().min(1).max(100),
  runRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  scheduledAt: z.date(),
  learningWindowMilliseconds: z.number().int().min(1).max(31536000000),
});

export async function runMaintenance(
  job: MaintenanceJob,
  options: MaintenanceOptions,
): Promise<JobSummary> {
  let command: z.infer<typeof schema>;
  try {
    command = schema.parse({
      job,
      limit: options.limit,
      runRef: options.runRef,
      scheduledAt: options.scheduledAt,
      learningWindowMilliseconds: options.learningWindowMilliseconds,
    });
    if (command.scheduledAt > options.now() || !Number.isFinite(options.now().getTime()))
      throw new Error('invalid');
    requirePrivacyHmacKeyring(options.keyring);
    parseLearningPolicy(options.learningPolicy);
    parseOutboundPolicyInput(options.outboundBounds);
  } catch {
    return { status: 'failed', processed: 0, reasonCode: 'configuration_invalid' };
  }
  const key = `MAINTENANCE_${createHash('sha256')
    .update(JSON.stringify([job, command.runRef]))
    .digest('hex')
    .slice(0, 48)}`;
  let processed = 0;
  try {
    switch (job) {
      case 'retention': {
        const result = await new PostgresRetentionJob(options.pool).runExpiredContentBatch({
          requestKey: key,
          evaluatedAt: command.scheduledAt,
          limit: command.limit,
        });
        processed = result.conversationsProcessed;
        break;
      }
      case 'deletion': {
        const requests = await withBoundedTransaction(options.pool, async (client) =>
          client.query<{ request_ref: string }>(
            `select request.request_ref from privacy_requests request
          where request.request_type='deletion' and request.state='human_review' and request.contact_id is not null
            and request.reason_code='customer_confirmed' and request.decision_code in ('explicit_confirmation','known_name')
            and request.decision_at <= $1 and request.reviewer_reference is not null
            and exists(select 1 from privacy_request_events event where event.request_id=request.id
              and event.action='reviewer_decision' and event.outcome='applied' and event.resulting_state='human_review'
              and event.actor_type='support_reviewer' and event.reason_code='customer_confirmed')
          order by request.decision_at,request.id limit $2`,
            [command.scheduledAt, command.limit],
          ),
        );
        for (const request of requests.rows) {
          const requestKey = `DELETE_${createHash('sha256').update(request.request_ref).digest('hex').slice(0, 48)}`;
          await new PostgresDeletionPolicy(options.pool, options.keyring).executeApprovedRequest({
            requestKey,
            requestRef: request.request_ref,
            executedAt: options.now(),
          });
          processed++;
        }
        break;
      }
      case 'lease_recovery': {
        const model = await new PostgresModelAllowance(options.pool).expireLeases(
          options.now(),
          command.limit,
        );
        processed = model.expiredCount;
        const outbound = await new PostgresOutboundWorkStore(
          options.pool,
          options.keyring,
          options.outboundBounds,
        ).expireLeases({ expiredAt: options.now(), limit: command.limit });
        processed += outbound.deliveryUnknown + outbound.returnedToPending;
        break;
      }
      case 'learning': {
        const learning = new PostgresLearningService(options.pool, {
          policy: options.learningPolicy,
          now: options.now,
        });
        const aggregate = await learning.aggregateInsights({
          runRef: key,
          requestKey: key,
          windowEndedAt: command.scheduledAt,
          windowStartedAt: new Date(
            command.scheduledAt.getTime() - command.learningWindowMilliseconds,
          ),
        });
        processed = aggregate.entryCount;
        const digest = await learning.openQuestionDigest({
          digestRef: `DIGEST_${key}`,
          requestKey: `DIGEST_${key}`,
        });
        processed += digest.questionRefs.length;
        break;
      }
    }
    return { status: 'completed', processed, reasonCode: 'ok' };
  } catch {
    return { status: 'failed', processed, reasonCode: 'dependency_unavailable' };
  }
}
