import { z } from 'zod';
import { parseHostHealthSnapshot } from '../operations/health-collector.js';
import type { HostHealthSnapshot } from '../operations/health-collector.js';
import type { AdminActor } from './admin-app.js';

const date = z.date().refine((value) => Number.isFinite(value.getTime()));
const component = z.enum([
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
]);
const health = z.strictObject({
  component,
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
  checkedAt: date,
  durationMilliseconds: z.number().int().min(0).max(300_000),
});
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const schema = z.strictObject({
  evaluatedAt: date,
  health: z.array(health).max(11),
  queues: z
    .array(
      z.strictObject({
        component: z.enum(['reply', 'outbound', 'notification']),
        pending: count,
        leased: count,
        failed: count,
        completed: count,
        oldestAgeBucket: z.enum(['empty', 'under_minute', 'under_hour', 'under_day', 'over_day']),
      }),
    )
    .max(3),
  schemaRevision: z
    .string()
    .regex(/^\d{6}$/u)
    .nullable(),
  deployedRevision: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .nullable(),
  deploymentState: z.enum(['started', 'succeeded', 'failed', 'rolled_back']).nullable(),
  backup: z.strictObject({
    state: z.enum(['created', 'verified', 'restore_verified', 'failed', 'stale', 'not_verified']),
    createdAt: date.nullable(),
    verifiedAt: date.nullable(),
  }),
  restore: z.strictObject({
    state: z.enum(['isolated', 'reconciled', 'passed', 'failed', 'not_verified']),
    recordedAt: date.nullable(),
  }),
  incidents: z
    .array(
      z.strictObject({
        incidentRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
        component,
        openedAt: date,
        lastObservedAt: date,
        acknowledgedAt: date.nullable(),
        resolvedAt: date.nullable(),
        consecutiveFailures: count,
      }),
    )
    .max(100),
  host: z
    .custom<HostHealthSnapshot>(
      (value) => value === null || parseHostHealthSnapshot(value) !== undefined,
    )
    .nullable(),
  modelEnabled: z.boolean(),
  notificationsEnabled: z.boolean(),
  outboundEnabled: z.boolean(),
});
export type OperationsView = z.infer<typeof schema>;
export function parseOperationsView(value: unknown): OperationsView {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('operations_display_invalid');
  return parsed.data;
}
export interface AdminOperationsPort {
  readonly read: (actor: AdminActor) => Promise<OperationsView>;
  readonly acknowledgeIncident: (
    input: {
      readonly incidentRef: string;
      readonly requestKey: string;
      readonly acknowledgedAt: Date;
    },
    actor: AdminActor,
  ) => Promise<void>;
}
